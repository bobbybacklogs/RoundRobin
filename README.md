# RoundRobin

[![npm version](https://img.shields.io/npm/v/roundrobin.svg)](https://www.npmjs.com/package/roundrobin)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-20%20passed-success.svg)](#)
[![OpenCode Zen](https://img.shields.io/badge/OpenCode%20Zen-verified%20models-blue.svg)](https://opencode.ai/docs/zen/)

RoundRobin is a model router and command-line interface that cycles through verified free models on OpenCode Zen. When model limits or quotas are reached, RoundRobin automatically advances to the next available free model. If all verified free models are exhausted, the router checks for a local Ollama instance and forwards requests to installed local models. If no functional models remain, RoundRobin halts cleanly and reports status to the user.

---

## Supported Free Models

RoundRobin exclusively routes through models verified as zero-cost on OpenCode Zen:

| Model Identifier | Model Name | Endpoint | Tier |
| :--- | :--- | :--- | :--- |
| `big-pickle` | Big Pickle | OpenCode Zen v1 | Free |
| `mimo-v2.5-free` | MiMo-V2.5 Free | OpenCode Zen v1 | Free |
| `ling-3.0-flash-fin-free` | Ling 3.0 Flash Fin Free | OpenCode Zen v1 | Free |
| `nemotron-3-ultra-free` | Nemotron 3 Ultra Free | OpenCode Zen v1 | Free |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | OpenCode Zen v1 | Free |
| `muse-spark-1.2-contributor-free` | Muse Spark 1.2 Contributor Free | OpenCode Zen v1 | Free |

Documentation reference: [OpenCode Zen Documentation](https://opencode.ai/docs/zen/)

---

## Installation

Install globally to use the CLI executable:

```bash
npm install -g roundrobin
```

Or execute directly via `npx`:

```bash
npx roundrobin
```

To use RoundRobin programmatically in a project:

```bash
npm install roundrobin
```

---

## Configuration

OpenCode Zen requires an API key for authenticated routing. Obtain an API key from the OpenCode platform and configure it using any of the following methods:

1. CLI configuration command:
   ```bash
   roundrobin config set-key YOUR_API_KEY
   ```
2. Environment variable:
   ```bash
   export OPENCODE_ZEN_API_KEY="YOUR_API_KEY"
   ```
3. Project `.env` or `.roundrobinrc` file:
   ```env
   OPENCODE_ZEN_API_KEY=YOUR_API_KEY
   ```

Ollama defaults to `http://localhost:11434`. You can configure a custom Ollama host using:
```bash
roundrobin config set-ollama http://localhost:11434
```

---

## Command-Line Usage

### Interactive Chat Session
Launch an interactive chat session that automatically rotates between free models:

```bash
roundrobin
# or
roundrobin chat
```

Available session commands:
- `/models` - Displays real-time model availability and cooldown timers.
- `/reset`  - Resets all model exhaustion cooldowns.
- `exit`    - Exits the chat session.

### Single-Shot Prompt
Send a prompt and stream the response to standard output:

```bash
roundrobin prompt "Provide a standard implementation of binary search in TypeScript."
```

### Local API Proxy Server
Start an OpenAI-compatible HTTP proxy server on port 8080:

```bash
roundrobin serve --port 8080
```

Configure tools such as Cursor, Aider, OpenCode, or Continue to use the local server:
- **Base URL**: `http://localhost:8080/v1`
- **API Key**: `roundrobin` (or any non-empty string)
- **Model**: `roundrobin` (or any model identifier)

Exposed endpoints:
- `POST /v1/chat/completions` (supports standard JSON and SSE streaming)
- `GET /v1/models`
- `GET /status`
- `GET /health`

### Inspect Model Availability
Display current availability and cooldown status for all verified models and local Ollama models:

```bash
roundrobin models
```

### Run Connectivity Diagnostics
Verify connectivity to OpenCode Zen endpoints and local Ollama services:

```bash
roundrobin test
```

---

## SDK Usage

Import RoundRobin into Node.js or TypeScript applications:

```typescript
import { RoundRobin } from 'roundrobin';

const client = new RoundRobin({
  openCodeZenApiKey: process.env.OPENCODE_ZEN_API_KEY,
  ollamaHost: 'http://localhost:11434',
});

// Non-streaming completion
const response = await client.chat('Explain quicksort briefly.');
console.log(response.choices[0].message.content);

// Real-time streaming completion
for await (const chunk of client.streamChat('List three deployment strategies.')) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

### Event Listeners

Subscribe to routing events:

```typescript
client.on('model-rotated', (fromModel, toModel, reason) => {
  console.log(`Model rotated: ${fromModel} -> ${toModel} (${reason.message})`);
});

client.on('ollama-fallback', (models) => {
  console.log(`Zen models exhausted. Fallback to local Ollama models:`, models);
});

client.on('all-exhausted', (summary) => {
  console.warn(`Routing stopped:`, summary.message);
});
```

---

## How Routing Operates

1. **Round-Robin Selection**: Requests are dispatched sequentially across verified OpenCode Zen free models.
2. **Exhaustion Handling**: When a model returns HTTP 429, 402, or a quota exhaustion message, it enters a temporary cooldown period. RoundRobin immediately retries the request with the next model.
3. **Local Ollama Fallback**: If all six cloud models are exhausted, RoundRobin queries the local Ollama daemon for capable generative models and forwards requests locally.
4. **Clean Exit**: If both cloud free models and local Ollama models are unavailable, RoundRobin stops execution and delivers an informative diagnostic message without hanging or throwing unhandled errors.

---

## License

MIT (c) RoundRobin Contributors. See [LICENSE](LICENSE) for details.
