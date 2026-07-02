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
npm start   # builds the UI, then starts the server
```

On the first run leatherHarness writes a default config and prints:

```
No config.json found — generating default at ~/.config/leatherHarness/config.json
Default config.json written. Edit it then restart.
```

Edit that file (e.g. set `upstream.baseUrl` to your LLM endpoint), restart the
server, and point your client at `http://localhost:9001`. Done.

---

## where config is stored

leatherHarness keeps **all** of its configuration in a single file in your user
config directory — **not** in the project folder:

```
~/.config/leatherHarness/config.json
```

- **Auto-generated on first run.** `loadPlugins()` writes it if it's missing,
  collecting `defaultConfig` from every plugin so each one has a starting section
  (`src/plugin-loader.ts`). The path is resolved in `src/server.ts` as
  `~/.config/leatherHarness` + `config.json`.
- **Env vars are substituted at read time.** Any `${VAR:-default}` token is
  expanded when the config is read and **never written back**, so secrets and
  environment-specific endpoints stay out of the file on disk.
- **Plugins own a namespaced section.** Each plugin reads and writes only
  `pluginConfig.<folder-name>` through its scoped `cfg.get()` / `cfg.set()` API.
- **Related data lives alongside it.** By default the `memo` plugin stores its
  markdown under `~/.config/leatherHarness/memo`, keeping harness state in one
  place under your home directory.

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
    "hue": { "bridgeIp": "192.168.x.x", "username": "" },
    "fileOps": {
      "allowedDirs": ["/path/to/your/files"],
      "writeDirs": ["/path/to/your/writable/files"],
      "deleteEnabled": false
    },
    "chromecast": { "allowedDirs": ["/path/to/your/media"] },
    "memo": { "path": "~/.config/leatherHarness/memo" },
    "music": { "allowedDirs": ["/path/to/your/music"] }
  }
}
```

| Key | Meaning |
|---|---|
| `listen.host` / `listen.port` | Address the harness binds to. |
| `upstream.baseUrl` | URL of the OpenAI-compatible LLM endpoint. Supports `${ENV_VAR:-default}`. |
| `maxToolRounds` | Maximum tool execution iterations per request (default 25). |
| `maxMessages` | Conversation length threshold that triggers compaction (default 50). |
| `pluginsDir` | Directory scanned for plugins (default `./plugins`). |
| `mcpServers` | MCP server specs merged into the tool schema. |
| `pluginConfig.<name>` | Plugin-specific configuration, one section per plugin folder. |

---

## core flow

1. A client sends a chat completion request to `POST /v1/chat/completions`
   (same format as OpenAI's API).
2. leatherHarness resolves it through `resolveRequest()`, which runs a tool loop:
   - Injects memo content into the system prompt if available.
   - Calls the upstream LLM with the conversation + tool schemas (both native and
     client-provided).
   - If the model returns tool calls leatherHarness owns, it executes them locally
     and loops back.
   - Foreign tool calls (not registered by leatherHarness) are passed through to
     the client.
   - Stops after `maxToolRounds` iterations or when the model returns a final
     text answer.
3. Results stream back via SSE (when `stream: true`) or return as a single JSON
   response.

---

## plugins

Drop a folder in `plugins/`. If it exports `setup(cfg)`, it loads on start — no
registration needed.

```
plugins/
  your-thing/
    index.ts        ← export function setup(cfg) { ... }
```

### Plugin contract

A plugin is a directory under `plugins/` containing an `index.ts` that exports:

```ts
export function setup(cfg: PluginConfig<T>): void | Promise<void>
```

Optionally a `defaultConfig` to seed the config file on first run:

```ts
export const defaultConfig: T
```

On startup, `loadPlugins()`:
1. Scans `plugins/` for subdirectories.
2. If `config.json` doesn't exist, imports each plugin to collect `defaultConfig`
   and writes the default config to `~/.config/leatherHarness/config.json`.
3. Loads each plugin by importing `index.ts` and calling `setup(cfg)`.

### PluginConfig API

```ts
interface PluginConfig<T> {
  get(): Promise<T>;                      // Reads your section (with env var substitution)
  set(patch: Partial<T>): Promise<void>;  // Shallow-merges patch and writes back
}
```

`cfg.get()` reads your plugin's section from `config.json` (with env var
substitution). `cfg.set(patch)` shallow-merges and writes back, preserving all
`${...}` tokens. Config lives at `pluginConfig.<folder-name>`.

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

### Extension points

Plugins can register three kinds of extensions:

**1. Native Tools** — `registerNativeTool()` in `src/registry.ts`

Tools are prefixed with `hx__` and appear in the tool schema sent to the upstream
model. The model calls them and leatherHarness executes them locally, looping the
result back.

**2. HTTP Routes** — `registerHttpRoute(prefix, handler)` in `src/http-registry.ts`

Mounts a handler on the main server. The prefix matches the exact path or anything
below it.

```ts
registerHttpRoute('/music', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>Music Player</h1>');
});
```

**3. UI Icons** — `registerUiIcon(icon)` in `src/ui-registry.ts`

Adds a clickable toolbar icon. The `run` function executes server-side and returns
an action:

```ts
interface UiActionResult {
  open?: string;       // Open URL in new tab
  overlay?: string;    // Open URL in full-screen iframe overlay
  navigate?: string;   // Navigate current tab to URL
  message?: string;    // Show toast message
}
```

---

## ships with

| Plugin | Tools | What it does |
|---|---|---|
| `hue` | `hue_discover_bridge`, `hue_pair`, `hue_list_lights`, `hue_set_light`, `hue_list_rooms`, `hue_set_room`, `hue_list_scenes`, `hue_activate_scene`, `hue_create_scene`, `hue_update_scene`, `hue_set_scene_light`, `hue_delete_scene`, `hue_create_room`, `hue_update_room`, `hue_delete_room`, `hue_rename_light` | Philips Hue smart lighting — mDNS discovery, pairing, lights, rooms, scenes |
| `chromecast` | `discover_chromecasts`, `list_audio_tracks`, `play_on_chromecast`, `stop_chromecast` | Cast local media to Chromecast devices. HLS transcode, audio track selection, subtitles, range requests |
| `fileOps` | `ls`, `cat`, `list_allowed_dirs`, `suggest_start_dir`, `dir_tree`, `cp`, `mv`, `rename`, `list_write_dirs`, `delete_file` (opt-in) | File browsing and manipulation, sandboxed to configured directories |
| `memo` | `read_memo`, `write_memo`, `append_memo`, `list_memos` | Persistent markdown memory. Main memo injected into every system prompt; sub-memos on demand |
| `playwright_scraper` | (via playwright) | Headless Chromium for JS-rendered pages |
| `wiki_search` | (via fetch) | Wikipedia full-article fetch |
| `scraper` | `scrape` | Headless Chromium page scraper — renders JS, returns full visible text |
| `clock` | `clock` | Returns current ISO timestamp |
| `music` | `music_list_dirs`, `music_info`, `music_browse`, `music_search`, `music_play`, `music_queue_add`, `music_queue_show`, `music_queue_clear`, `music_player_ui` | Browser-based music player with shared queue, streaming, and playlist management |
| `fileSearch` | — | File search plugin |
| `http` | — | HTTP utility plugin |
| `lastfm` | — | Last.fm music integration |
| `search` | — | Search plugin |

---

## mcp

Add MCP servers directly in `config.json` under `mcpServers`. The model sees all
tools from both sources in the same request.

```json
{
  "mcpServers": {
    "my-server": { "command": "npx", "args": ["-y", "my-mcp-server"] }
  }
}
```

`src/mcp.ts` loads the specs and registers a dummy tool per server for
introspection.

---

## module map

| Module | Purpose |
|---|---|
| `src/server.ts` | HTTP server entry point. Resolves the config path, routes requests, manages global metrics, loads plugins and MCP servers at startup. |
| `src/resolve.ts` | The tool loop. Handles upstream calls, compaction, reasoning extraction, tool execution, and metrics emission. |
| `src/registry.ts` | Native tool registry. Produces OpenAI-compatible tool schemas and resolves tool names at execution time. |
| `src/plugin-loader.ts` | Discovers `plugins/` subdirectories, calls `setup(cfg)`, and generates `config.json` defaults on first run. |
| `src/mcp.ts` | Loads MCP server specs from config and registers a dummy tool per server. |
| `src/http-registry.ts` | HTTP route registry for plugin-mounted endpoints (e.g. `/music`). |
| `src/ui-registry.ts` | UI icon registry for plugin-contributed toolbar icons. |
| `src/runtime.ts` | Shared view of the harness listen address. Plugins build absolute URLs using the observed Host header. |
| `src/ui/App.tsx` | React chat UI — multi-session, SSE streaming, expandable tool calls/results, reasoning display, global + upstream metrics panels. |
| `vite.config.ts` | Vite build config targeting `dist-ui/`. Dev server proxies `/v1` to the harness. |

### HTTP server routes

| Route | Method | Handler |
|---|---|---|
| `/` | GET | Serves built UI (`dist-ui/index.html`) |
| `/dist-ui/*` | GET | Static file serving (JS, CSS, images) |
| `/v1/chat/completions` | POST | Main chat endpoint. SSE streaming or non-streaming passthrough. |
| `/v1/models` | GET | Proxies to upstream LLM's `/models` endpoint. |
| `/api/metrics` | GET | Returns global harness stats (requests, tokens, tool calls, uptime). |
| `/api/upstream/metrics` | GET | Fetches and parses upstream LLM metrics (JSON or Prometheus text). |
| `/api/ui/icons` | GET | Lists plugin-contributed UI icons. |
| `/api/ui/icons/:id` | POST | Runs a registered UI icon action. |
| Plugin routes | varies | Mounted via `registerHttpRoute()` (e.g. `/music/*`). |

---

## tool rounds

leatherHarness loops up to `maxToolRounds` times per request — enough for the model
to chain tools without hitting a dead end. Adjust in config if your workflows run
deep.

---

## streaming protocol

When `stream: true`, leatherHarness emits typed SSE events:

| Event `t` | Payload | Description |
|---|---|---|
| `reasoning` | `{ text }` | Model's thinking (from `reasoning_content`, `reasoning`, or inline `<think>` tags). |
| `tool_call` | `{ id, name, args }` | A tool call the harness is about to execute. |
| `tool_result` | `{ id, name, out }` | The result of executing a tool. |
| `delta` | `{ text }` | Text content from the model (accumulated into the assistant message). |
| `metrics` | `{ prompt, completion, total, round, toolCalls, compactions, elapsed }` | Cumulative metrics snapshot after each tool round. |
| `done` | `{ usage }` | Final token usage from the upstream model. |
| `error` | `{ message }` | Error message (upstream failure or tool round limit exceeded). |
| `compact` | `{ summary, oldCount, newCount }` | Conversation compaction event. |

---

## resilience

- **Upstream retries** — `callUpstream()` retries up to 10 times with exponential
  backoff on connection errors and 5xx/429 responses.
- **Tool error isolation** — tool execution errors never kill the loop; they are
  formatted as error messages and fed back to the model for recovery.
- **Loop guard** — the tool round limit (default 25) prevents infinite loops.
- **Conversation compaction** — when messages exceed `maxMessages` (default 50),
  the upstream LLM summarizes the older half into a single system message, then
  continues with the summary + recent messages. If compaction fails, messages are
  truncated to the most recent `maxMessages/2`.

---

## development

```bash
npm install && npx playwright install
npm run dev    # builds UI, watches for changes, auto-restarts server
npm start      # production: builds UI once, starts server
```

Dev mode uses `concurrently` + `nodemon` to watch both Vite (UI) and ts-node
(server) for changes.

**TypeScript** — target ES2022, module ESNext, JSX `react-jsx`, strict mode,
`noEmit: true` (Vite handles bundling). Sources in `src/**/*.ts`, `src/**/*.tsx`.

---

## testing

Tests are end-to-end, driven in-code (no test servers started).

```bash
npm test
```

| Test file | What it tests |
|---|---|
| `test/run.js` | Tool registration, schema generation, resolve loop with mock LLM |
| `test/e2e.js` | UI serving via HTTP |
| `test/e2e_chat.js` | Full chat request through harness to mock LLM |
| `test/e2e_ui.js` | UI icon registry (registration, action execution, guards) |
| `test/e2e_music.js` | Music plugin: library walking, playlists, browsing, searching, streaming, queue, route mounting, host header handling |
| `test/compaction.js` | Conversation compaction logic |
| `test/sse-robustness.js` | SSE stream resilience |
| `test/upstream-metrics.js` | Upstream metrics proxy |
| `test/metrics.js` | Global metrics tracking |
| `test/mockLlama.js` | Mock LLM server utility for tests |
