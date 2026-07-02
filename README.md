<p align="center" style="margin:0;">
  <img src="public/neurali.png" width="100%" alt="neurali" style="display:block;"/>
</p>

<div style="display:flex;align-items:center;gap:16px;justify-content:center;">
  <div>
    <h1 style="margin:0;">leatherHarness</h1>
    <p style="text-align:center;"><em>Your model, properly equipped.</em></p>
    <p style="text-align:center;">
      An OpenAI-compatible proxy that intercepts LLM requests, runs its own tools, and passes everything else through untouched. No framework tax. No cloud dependency. Just a tight loop between your client and your model, with real tools bolted on.
    </p>
  </div>
</div>

---

## the deal

You point your AI client at leatherHarness instead of the model directly.
It speaks the same API. The model gets extra tools. You stay in control.

```
your client  →  leatherHarness :9001  →  upstream LLM
                      ↕
               plugins/*.ts (tools)
               mcp-servers.json (MCP)
```

When the model calls a tool leatherHarness owns, it runs it locally and loops back.
Anything else passes through to the client, including tool calls from the upstream model itself.

---

## get going

```bash
npm install && npx playwright install
npm start   # creates default config.json if missing
```

After the first run you'll see a message like "Default config.json written. Edit it then restart." Edit `config.json` (e.g., set `upstream.baseUrl` to your LLM endpoint) and restart the server.

Point your client at `http://localhost:9001`. Done.

---

## plugins

Drop a folder in `plugins/`. If it exports `setup(cfg)`, it loads on start — no registration needed.

```
plugins/
  your-thing/
    index.ts        ← export function setup(cfg) { ... }
```

Inside `setup` you register tools and get scoped config access:

```ts
import { registerNativeTool } from '../../src/registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';

interface MyConfig {
  apiKey: string;
  endpoint?: string;
}

export function setup(cfg: PluginConfig<MyConfig>) {
  registerNativeTool({
    name: 'my_tool',
    description: 'Does the thing.',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    },
    execute: async ({ input }) => {
      const { apiKey, endpoint = 'https://default.example.com' } = await cfg.get();
      await cfg.set({ endpoint: 'https://updated.example.com' }); // patches + writes config.json
      return `result for ${input}`;
    },
  });
}
```

`cfg.get()` reads your plugin's section from `config.json` (with env var substitution).
`cfg.set(patch)` shallow-merges and writes back, preserving all `${...}` tokens.

Config lives at `pluginConfig.<folder-name>` in `config.json`.

### Extension Points

Plugins can register three kinds of extensions:

**1. Native Tools** — `registerNativeTool()` in `src/registry.ts`

Tools are prefixed with `hx__` and appear in the tool schema sent to the upstream model. The model calls them and leatherHarness executes them locally, looping the result back.

**2. HTTP Routes** — `registerHttpRoute(prefix, handler)` in `src/http-registry.ts`

Mounts a handler on the main server. The prefix matches the exact path or anything below it.

**3. UI Icons** — `registerUiIcon(icon)` in `src/ui-registry.ts`

Adds a clickable toolbar icon. The `run` function executes server-side and returns an action (`open`, `overlay`, `navigate`, or `message`).

---

## ships with

| plugin | what it does |
|---|---|
| `hue` | Philips Hue — lights, rooms, scenes, pairing |
| `chromecast` | Cast local media files to any Chromecast on the network |
| `fileOps` | Browse and read files, sandboxed to configured directories |
| `memo` | Persistent memory injected into every system prompt |
| `playwright_scraper` | Headless Chromium — renders JS, returns visible text |
| `wiki_search` | Wikipedia full-article fetch |
| `scraper` | Headless Chromium — renders page, returns full visible text (no size limit) |
| `clock` | Current ISO timestamp |
| `music` | Browser-based music player with shared queue and streaming |

---

## config

```json
{
  "listen": { "host": "127.0.0.1", "port": 9001 },
  "upstream": {
    "baseUrl": "${OPENCODE_ENDPOINT:-http://127.0.0.1:8080/v1}"
  },
  "maxToolRounds": 25,
  "maxMessages": 50,
  "pluginsDir": "./plugins",
  "mcpServers": {},
  "pluginConfig": {
    "hue": {
      "bridgeIp": "192.168.x.x",
      "username": ""
    },
    "fileOps": {
      "allowedDirs": ["/path/to/your/files"],
      "writeDirs": ["/path/to/your/writable/files"],
      "deleteEnabled": false
    },
    "chromecast": {
      "allowedDirs": ["/path/to/your/media"]
    },
    "memo": {
      "path": "~/.config/leatherHarness/memo"
    },
    "music": {
      "allowedDirs": ["/path/to/your/music"]
    }
  }
}
```

Env var syntax `${VAR:-default}` is substituted at read time, never written back.

---

## mcp

Add MCP servers directly in `config.json` under `mcpServers`.
The model sees all tools from both sources in the same request.

```json
{
  "mcpServers": {
    "my-server": { "command": "npx", "args": ["-y", "my-mcp-server"] }
  }
}
```

---

## tool rounds

leatherHarness loops up to `maxToolRounds` times per request — enough for the model
to chain tools without hitting a dead end. Adjust in config if your workflows run deep.

---

## streaming protocol

When `stream: true`, leatherHarness emits typed SSE events:

| Event | Description |
|---|---|
| `reasoning` | Model's thinking/reasoning content |
| `tool_call` | Tool call about to be executed |
| `tool_result` | Result of a tool execution |
| `delta` | Text content from the model |
| `metrics` | Cumulative metrics snapshot |
| `done` | Final token usage |
| `error` | Error message |
| `compact` | Conversation compaction event |

---

## resilience

- **Upstream retries**: `callUpstream()` retries up to 10 times with exponential backoff on connection errors and 5xx/429 responses.
- **Tool error isolation**: Tool execution errors never kill the loop — they are formatted as error messages and fed back to the model for recovery.
- **Loop guard**: Tool round limit (default 25) prevents infinite loops.
- **Conversation compaction**: When messages exceed `maxMessages` (default 50), older messages are summarized by the upstream LLM to free context window space.

---

## architecture

| Module | Purpose |
|---|---|
| `src/server.ts` | HTTP server entry point. Routes requests, manages global metrics, loads plugins and MCP servers. |
| `src/resolve.ts` | The tool loop. Handles upstream calls, compaction, reasoning extraction, tool execution, metrics. |
| `src/registry.ts` | Native tool registry. Produces OpenAI-compatible tool schemas, resolves tool names at execution. |
| `src/plugin-loader.ts` | Discovers plugins, calls `setup(cfg)`, generates `config.json` defaults on first run. |
| `src/mcp.ts` | Loads MCP server specs, registers a dummy tool per server. |
| `src/http-registry.ts` | HTTP route registry for plugin-mounted endpoints. |
| `src/ui-registry.ts` | UI icon registry for plugin-contributed toolbar icons. |
| `src/runtime.ts` | Shared harness listen address. Plugins build absolute URLs using the observed Host header. |
| `src/ui/App.tsx` | React chat UI — multi-session, SSE streaming, expandable tool calls, reasoning display, metrics panels. |

Full architecture details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## testing

Tests are end-to-end, driven in-code (no test servers started).

```bash
npm test
```
