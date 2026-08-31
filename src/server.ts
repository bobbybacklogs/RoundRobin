import http, { IncomingMessage, ServerResponse } from 'node:http';
import { AllModelsExhaustedError } from './errors.js';
import { RoundRobinRouter } from './router.js';
import { ChatCompletionOptions } from './types.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  router: RoundRobinRouter;
}

export class RoundRobinServer {
  private server: http.Server;
  private router: RoundRobinRouter;
  private port: number;
  private host: string;

  constructor(options: ServerOptions) {
    this.router = options.router;
    this.port = options.port || 8080;
    this.host = options.host || '0.0.0.0';

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  public listen(): Promise<{ port: number; host: string }> {
    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => {
        resolve({ port: this.port, host: this.host });
      });
    });
  }

  public close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Add CORS headers for all requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          service: 'RoundRobin Free-Model Router',
          timestamp: new Date().toISOString(),
        }));
        return;
      }

      if (req.method === 'GET' && pathname === '/status') {
        const statuses = this.router.getModelStatuses();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: statuses.map((s) => ({
            id: s.model.id,
            name: s.model.name,
            provider: s.model.provider,
            isExhausted: s.isExhausted,
            exhaustedUntil: s.exhaustedUntil ? new Date(s.exhaustedUntil).toISOString() : null,
            consecutiveFailures: s.consecutiveFailures,
            lastError: s.lastError,
          })),
        }, null, 2));
        return;
      }

      if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
        const statuses = this.router.getModelStatuses();
        const data = statuses.map((s) => ({
          id: s.model.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: s.model.provider,
          permission: [],
          root: s.model.id,
          parent: null,
          metadata: {
            name: s.model.name,
            isFree: s.model.isFree,
            isExhausted: s.isExhausted,
          },
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data }));
        return;
      }

      if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
        const bodyText = await this.readBody(req);
        let parsedBody: ChatCompletionOptions;
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON payload' } }));
          return;
        }

        if (!parsedBody.messages || !Array.isArray(parsedBody.messages)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'messages array is required' } }));
          return;
        }

        if (parsedBody.stream) {
          // SSE Streaming response
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
          });

          try {
            for await (const chunk of this.router.streamChat(parsedBody)) {
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
          } catch (err: unknown) {
            if (err instanceof AllModelsExhaustedError) {
              const errPayload = {
                error: {
                  message: err.message,
                  type: 'all_models_exhausted',
                  code: 'all_free_models_exhausted',
                },
              };
              res.write(`data: ${JSON.stringify(errPayload)}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            } else {
              const errPayload = {
                error: {
                  message: err instanceof Error ? err.message : String(err),
                  type: 'router_error',
                },
              };
              res.write(`data: ${JSON.stringify(errPayload)}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            }
          }
          return;
        }

        // Non-streaming response
        try {
          const completion = await this.router.chat(parsedBody);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(completion));
        } catch (err: unknown) {
          if (err instanceof AllModelsExhaustedError) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                message: err.message,
                type: 'all_models_exhausted',
                code: 'all_free_models_exhausted',
                gracefulNotice: err.gracefulNotice,
              },
            }));
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                message: err instanceof Error ? err.message : String(err),
                type: 'router_error',
              },
            }));
          }
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Route not found: ${req.method} ${pathname}` } }));
    } catch (globalErr: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: globalErr instanceof Error ? globalErr.message : String(globalErr) },
      }));
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }
}
