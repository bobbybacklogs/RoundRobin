import readline from 'node:readline';
import { Command } from 'commander';
import pc from 'picocolors';
import {
  OPENCODE_ZEN_FREE_MODELS,
} from '../constants.js';
import {
  getConfigFilePath,
  loadUserConfig,
  resolveConfig,
  saveUserConfig,
} from '../config.js';
import { AllModelsExhaustedError } from '../errors.js';
import { OllamaClient } from '../ollama.js';
import { RoundRobin } from '../sdk.js';
import { formatDuration } from '../utils.js';

const program = new Command();

program
  .name('roundrobin')
  .description('Free-model router for OpenCode Zen verified free models with Ollama fallback')
  .version('1.0.0');

function setupRouterEvents(rr: RoundRobin): void {
  rr.on('request-start', (modelId) => {
    // optional verbose debug
  });

  rr.on('model-exhausted', (modelId, reason, cooldownMs) => {
    console.log(
      pc.yellow(`\n⚠️  Model '${pc.bold(modelId)}' exhausted: ${reason.message}`) +
      pc.dim(` (cooldown: ${formatDuration(cooldownMs)})`)
    );
  });

  rr.on('model-rotated', (fromModel, toModel, reason) => {
    console.log(
      pc.cyan(`🔀 Rotating: `) +
      pc.strikethrough(pc.red(fromModel)) +
      pc.cyan(` ➔ `) +
      pc.green(pc.bold(toModel)) +
      pc.dim(` [reason: ${reason.type}]`)
    );
  });

  rr.on('ollama-fallback', (models) => {
    console.log(
      pc.magenta(`\n🔄 All OpenCode Zen free models exhausted!`) +
      pc.cyan(` Routing back and checking local Ollama...`) +
      pc.green(`\n🦙 Found capable local models: [${models.join(', ')}]`)
    );
  });

  rr.on('all-exhausted', (summary) => {
    console.log(
      pc.red(`\n🛑 All OpenCode Zen free models exhausted and no capable Ollama models available.`) +
      pc.yellow(`\n${summary.message}\n`)
    );
  });
}

// 1. Interactive Chat (default)
program
  .command('chat', { isDefault: true })
  .description('Start interactive chat loop with automatic free-model rotation')
  .option('-k, --api-key <key>', 'OpenCode Zen API key')
  .option('--ollama <host>', 'Ollama host URL')
  .action(async (options) => {
    const config = resolveConfig({
      openCodeZenApiKey: options.apiKey,
      ollamaHost: options.ollama,
    });

    const rr = new RoundRobin(config);
    setupRouterEvents(rr);

    console.log(pc.bold(pc.cyan('\n┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓')));
    console.log(pc.bold(pc.cyan('┃       RoundRobin: Free-Model Router CLI                ┃')));
    console.log(pc.bold(pc.cyan('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛')));
    console.log(
      pc.dim('Cycles through OpenCode Zen verified free models.') +
      pc.dim('\nFalls back to local Ollama when all are exhausted.') +
      pc.dim('\nType /models to view status, /reset to clear cooldowns, exit to quit.\n')
    );

    if (!config.openCodeZenApiKey) {
      console.log(
        pc.yellow('Notice: ') +
        pc.dim('No OPENCODE_ZEN_API_KEY detected. OpenCode Zen free models require a key from https://opencode.ai/docs/zen/.') +
        pc.dim('\nRun `roundrobin config set-key <key>` or set OPENCODE_ZEN_API_KEY in your env.') +
        pc.dim('\nRouter will try Zen models, then fallback to local Ollama if available.\n')
      );
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: pc.bold(pc.blue('RoundRobin > ')),
    });

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: 'You are a helpful coding and general AI assistant routed through RoundRobin.',
      },
    ];

    rl.prompt();

    rl.on('line', async (line) => {
      const input = line.trim();
      if (!input) {
        rl.prompt();
        return;
      }

      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        console.log(pc.dim('Goodbye!'));
        process.exit(0);
      }

      if (input === '/models') {
        printModelsStatus(rr);
        rl.prompt();
        return;
      }

      if (input === '/reset') {
        rr.resetCooldowns();
        console.log(pc.green('✓ All model exhaustion cooldowns reset.'));
        rl.prompt();
        return;
      }

      messages.push({ role: 'user', content: input });
      process.stdout.write(pc.dim('Streaming response... \n'));

      try {
        let fullReply = '';
        let currentModel = '';

        for await (const chunk of rr.streamChat({ messages })) {
          const delta = chunk.choices[0]?.delta?.content || '';
          if (chunk._roundRobin?.routedModel && !currentModel) {
            currentModel = chunk._roundRobin.routedModel;
            process.stdout.write(pc.dim(`[via ${currentModel}] `));
          }
          process.stdout.write(delta);
          fullReply += delta;
        }

        process.stdout.write('\n\n');
        messages.push({ role: 'assistant', content: fullReply });
      } catch (err: unknown) {
        if (err instanceof AllModelsExhaustedError) {
          console.log(pc.red(`\n[RoundRobin Error] ${err.gracefulNotice}`));
        } else {
          console.log(pc.red(`\n[Error] ${err instanceof Error ? err.message : String(err)}`));
        }
      }

      rl.prompt();
    });
  });

// 2. Single-shot prompt
program
  .command('prompt <text>')
  .description('Send a single prompt through RoundRobin and stream the output')
  .option('-k, --api-key <key>', 'OpenCode Zen API key')
  .option('--ollama <host>', 'Ollama host URL')
  .action(async (text, options) => {
    const config = resolveConfig({
      openCodeZenApiKey: options.apiKey,
      ollamaHost: options.ollama,
    });

    const rr = new RoundRobin(config);
    setupRouterEvents(rr);

    try {
      for await (const chunk of rr.streamChat(text)) {
        const delta = chunk.choices[0]?.delta?.content || '';
        process.stdout.write(delta);
      }
      process.stdout.write('\n');
    } catch (err: unknown) {
      if (err instanceof AllModelsExhaustedError) {
        console.error(pc.red(`\n[RoundRobin Error] ${err.gracefulNotice}`));
      } else {
        console.error(pc.red(`\n[Error] ${err instanceof Error ? err.message : String(err)}`));
      }
      process.exit(1);
    }
  });

// 3. Serve as OpenAI-compatible API
program
  .command('serve')
  .description('Run local OpenAI-compatible HTTP proxy server')
  .option('-p, --port <port>', 'Port to listen on', '8080')
  .option('-h, --host <host>', 'Host to bind to', '0.0.0.0')
  .option('-k, --api-key <key>', 'OpenCode Zen API key')
  .option('--ollama <host>', 'Ollama host URL')
  .action(async (options) => {
    const port = parseInt(options.port, 10) || 8080;
    const config = resolveConfig({
      openCodeZenApiKey: options.apiKey,
      ollamaHost: options.ollama,
    });

    const rr = new RoundRobin(config);
    setupRouterEvents(rr);

    try {
      const serverInfo = await rr.serve(port, options.host);
      console.log(pc.bold(pc.green('\n🚀 RoundRobin Server is running!')));
      console.log(pc.cyan(`   URL:          http://localhost:${serverInfo.port}`));
      console.log(pc.cyan(`   Endpoint:     http://localhost:${serverInfo.port}/v1/chat/completions`));
      console.log(pc.cyan(`   Models:       http://localhost:${serverInfo.port}/v1/models`));
      console.log(pc.cyan(`   Health:       http://localhost:${serverInfo.port}/health`));
      console.log(pc.cyan(`   Status:       http://localhost:${serverInfo.port}/status\n`));
      console.log(pc.dim('Use this endpoint in Cursor, Aider, OpenCode, Continue, or any OpenAI-compatible client.'));
      console.log(pc.dim('Press Ctrl+C to stop the server.\n'));
    } catch (err: unknown) {
      console.error(pc.red(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

// 4. List Models
program
  .command('models')
  .description('List OpenCode Zen verified free models and detected Ollama models')
  .option('--ollama <host>', 'Ollama host URL')
  .action(async (options) => {
    const config = resolveConfig({ ollamaHost: options.ollama });
    const rr = new RoundRobin(config);
    await printModelsStatus(rr, config.ollamaHost);
  });

// 5. Test connections
program
  .command('test')
  .description('Diagnose connections to OpenCode Zen free models and Ollama')
  .option('-k, --api-key <key>', 'OpenCode Zen API key')
  .option('--ollama <host>', 'Ollama host URL')
  .action(async (options) => {
    const config = resolveConfig({
      openCodeZenApiKey: options.apiKey,
      ollamaHost: options.ollama,
    });

    console.log(pc.bold('\n🔍 Testing RoundRobin Router Connections...\n'));

    // Check Ollama
    const ollamaClient = new OllamaClient({ host: config.ollamaHost });
    const ollamaAvailable = await ollamaClient.isAvailable();
    if (ollamaAvailable) {
      const models = await ollamaClient.listCapableModels();
      console.log(pc.green(`✓ Local Ollama at ${config.ollamaHost}: ONLINE`));
      console.log(pc.dim(`  Discovered capable models (${models.length}): ${models.map(m => m.id).join(', ') || 'none'}`));
    } else {
      console.log(pc.yellow(`⚠ Local Ollama at ${config.ollamaHost}: OFFLINE / Unreachable`));
    }

    // Check Zen Free Models
    console.log(pc.bold('\nOpenCode Zen Verified Free Models:'));
    for (const m of OPENCODE_ZEN_FREE_MODELS) {
      console.log(`  • ${pc.bold(m.name)} (${pc.dim(m.id)}) - ${pc.green('Free tier')}`);
    }

    console.log(pc.dim(`\nOpenCode Zen API Key: ${config.openCodeZenApiKey ? pc.green('Configured') : pc.yellow('Not set (run `roundrobin config set-key <key>`)')}\n`));
  });

// 6. Config manager
const configCmd = program.command('config').description('Manage RoundRobin configuration');

configCmd
  .command('show')
  .description('Show current configuration')
  .action(() => {
    const config = resolveConfig();
    console.log(pc.bold('\nRoundRobin Configuration:'));
    console.log(`Config file:             ${getConfigFilePath()}`);
    console.log(`OpenCode Zen API Key:    ${config.openCodeZenApiKey ? pc.green('••••' + config.openCodeZenApiKey.slice(-4)) : pc.red('Not set')}`);
    console.log(`OpenCode Zen Base URL:   ${config.openCodeZenBaseUrl}`);
    console.log(`Ollama Host:             ${config.ollamaHost}`);
    console.log(`Cooldown duration:       ${formatDuration(config.cooldownMs)}`);
    console.log(`Default Port:            ${config.port}\n`);
  });

configCmd
  .command('set-key <key>')
  .description('Set OpenCode Zen API key')
  .action((key) => {
    const file = saveUserConfig({ openCodeZenApiKey: key });
    console.log(pc.green(`✓ Saved OpenCode Zen API key to ${file}`));
  });

configCmd
  .command('set-ollama <url>')
  .description('Set Ollama host URL')
  .action((url) => {
    const file = saveUserConfig({ ollamaHost: url });
    console.log(pc.green(`✓ Saved Ollama host URL to ${file}`));
  });

async function printModelsStatus(rr: RoundRobin, ollamaHost?: string): Promise<void> {
  const statuses = rr.getModels();
  console.log(pc.bold('\nOpenCode Zen Verified Free Models:'));
  console.log('────────────────────────────────────────────────────────────────────────────────');
  console.log(
    ` ${'Model ID'.padEnd(32)} ${'Name'.padEnd(30)} ${'Status'}`
  );
  console.log('────────────────────────────────────────────────────────────────────────────────');

  for (const s of statuses) {
    let statusStr = pc.green('● Available (Free)');
    if (s.isExhausted) {
      const remaining = s.exhaustedUntil ? Math.max(0, s.exhaustedUntil - Date.now()) : 0;
      statusStr = pc.red(`✖ Exhausted (${formatDuration(remaining)} remaining)`);
    }
    console.log(
      ` ${s.model.id.padEnd(32)} ${s.model.name.padEnd(30)} ${statusStr}`
    );
  }
  console.log('────────────────────────────────────────────────────────────────────────────────\n');

  // Check Ollama models
  const host = ollamaHost || 'http://localhost:11434';
  const ollama = new OllamaClient({ host });
  const capable = await ollama.listCapableModels();

  console.log(pc.bold(`Local Ollama Fallback Models (${host}):`));
  console.log('────────────────────────────────────────────────────────────────────────────────');
  if (capable.length === 0) {
    console.log(pc.yellow(' No local models found or Ollama is offline.'));
  } else {
    for (const m of capable) {
      console.log(` ${m.id.padEnd(32)} ${m.description || 'Local LLM'}`);
    }
  }
  console.log('────────────────────────────────────────────────────────────────────────────────\n');
}

program.parse(process.argv);
