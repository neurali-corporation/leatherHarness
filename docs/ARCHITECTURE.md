# leatherHarness Technical Documentation

leatherHarness is an OpenAI-compatible proxy that intercepts LLM requests, runs its own tools locally, and passes everything else through to an upstream model. It acts as a thin harness between your AI client and your LLM, adding real tool capabilities without framework overhead or cloud dependency.

```
your client  →  leatherHarness :9001  →  upstream LLM
                      ↕
               plugins/*.ts (tools)
               mcp-servers.json (MCP)
```

## Architecture

### Core Flow

1. A client sends a chat completion request to `POST /v1/chat/completions` (same format as OpenAI's API).
2. leatherHarness resolves the request through `resolveRequest()`, which runs a tool loop:
   - Injects memo content into the system prompt if available.
   - Calls the upstream LLM with the conversation + tool schemas (both native and client-provided).
   - If the model returns tool calls, executes them locally and loops back.
   - Foreign tool calls (not registered by leatherHarness) are passed through to the client.
   - Stops after `maxToolRounds` iterations or when the model returns a final text answer.
3. Results stream back to the client via SSE (when `stream: true`) or return as a single JSON response.

### Module Map

| File | Purpose |
|---|---|
| `src/server.ts` | HTTP server entry point. Routes requests, manages global metrics, loads plugins and MCP servers at startup. |
| `src/resolve.ts` | The tool loop. Handles upstream calls, compaction, reasoning extraction, tool execution, and metrics emission. |
| `src/registry.ts` | Native tool registry. Plugins register tools here; the registry produces OpenAI-compatible tool schemas and resolves tool names at execution time. |
| `src/plugin-loader.ts` | Discovers `plugins/` subdirectories, loads each `index.ts`, calls `setup(cfg)`, and generates `config.json` defaults on first run. |
| `src/mcp.ts` | Loads MCP server specs from config and registers a dummy tool per server for introspection. |
| `src/http-registry.ts` | HTTP route registry. Plugins mount routes on the main server under a prefix (e.g. `/music`). |
| `src/ui-registry.ts` | UI icon registry. Plugins register clickable toolbar icons with server-side action functions. |
| `src/runtime.ts` | Shared view of the harness listen address. Plugins build absolute URLs back to the harness using the observed Host header. |
| `src/ui/App.tsx` | React chat UI. Multi-session, SSE streaming, expandable tool calls/results, reasoning display, global + upstream metrics panels. |
| `vite.config.ts` | Vite build config targeting `dist-ui/`. Dev server proxies `/v1` to the harness. |

### HTTP Server Routes

| Route | Method | Handler |
|---|---|---|
| `/` | GET | Serves built UI (`dist-ui/index.html`) |
| `/dist-ui/*` | GET | Static file serving (JS, CSS, images) |
| `/v1/chat/completions` | POST | Main chat endpoint. SSE streaming or non-streaming passthrough. |
| `/v1/models` | GET | Proxies to upstream LLM's `/models` endpoint. |
| `/api/metrics` | GET | Returns global harness stats (requests, tokens, tool calls, uptime). |
| `/api/upstream/metrics` | GET | Fetches and parses upstream LLM metrics (JSON or Prometheus text format). |
| `/api/ui/icons` | GET | Lists plugin-contributed UI icons. |
| `/api/ui/icons/:id` | POST | Runs a registered UI icon action. |
| Plugin routes | varies | Mounted via `registerHttpRoute()` (e.g. `/music/*`). |

### Request Lifecycle (Streaming)

The streaming response emitstyped events via SSE:

| Event `t` | Payload | Description |
|---|---|---|
| `reasoning` | `{ text }` | Model's thinking/reasoning content (extracted from `reasoning_content`, `reasoning`, or inline `<think>` tags). |
| `tool_call` | `{ id, name, args }` | A tool call the harness is about to execute. |
| `tool_result` | `{ id, name, out }` | The result of executing a tool. |
| `delta` | `{ text }` | Text content from the model (accumulated into the assistant message). |
| `metrics` | `{ prompt, completion, total, round, toolCalls, compactions, elapsed }` | Cumulative metrics snapshot after each tool round. |
| `done` | `{ usage }` | Final token usage from the upstream model. |
| `error` | `{ message }` | Error message (upstream failure or tool round limit exceeded). |
| `compact` | `{ summary, oldCount, newCount }` | Conversation compaction event. |

### Conversation Compaction

When the message history exceeds `maxMessages` (default 50), leatherHarness calls the upstream LLM to summarize the older half of messages into a single system message, then continues with the summary + recent messages. If compaction fails, messages are truncated to the most recent `maxMessages/2`.

### Upstream Resilience

- `callUpstream()` retries up to 10 times with exponential backoff on connection errors and 5xx/429 responses.
- Tool execution errors never kill the loop — they are formatted as error messages and fed back to the model for recovery.
- Tool round limit (default 25) prevents infinite loops.

## Plugin System

### Plugin Contract

A plugin is a directory under `plugins/` containing an `index.ts` that exports:

```ts
export function setup(cfg: PluginConfig<T>): void | Promise<void>
```

Optionally:

```ts
export const defaultConfig: T
```

On startup, `loadPlugins()`:
1. Scans `plugins/` for subdirectories.
2. If `config.json` doesn't exist, imports each plugin to collect `defaultConfig` and writes a default config.
3. Loads each plugin by importing `index.ts` and calling `setup(cfg)`.

### PluginConfig API

```ts
interface PluginConfig<T> {
  get(): Promise<T>;          // Reads plugin's section from config.json (with env var substitution)
  set(patch: Partial<T>): Promise<void>;  // Shallow-merges patch and writes back to config.json
}
```

Config lives at `pluginConfig.<folder-name>` in `config.json`. Environment variables are substituted at read time using `${VAR:-default}` syntax — never written back.

### Extension Points

Plugins can register three kinds of extensions:

**1. Native Tools** — `registerNativeTool()` in `src/registry.ts`

Tools are prefixed with `hx__` and appear in the tool schema sent to the upstream model. The model can call them and leatherHarness executes them locally, looping the result back.

```ts
registerNativeTool({
  name: 'my_tool',
  description: 'Does the thing.',
  parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
  execute: async ({ input }) => `result for ${input}`,
});
```

**2. HTTP Routes** — `registerHttpRoute(prefix, handler)` in `src/http-registry.ts`

Mounts a handler on the main server. The prefix matches the exact path or anything below it.

```ts
registerHttpRoute('/music', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>Music Player</h1>');
});
```

**3. UI Icons** — `registerUiIcon(icon)` in `src/ui-registry.ts`

Adds a clickable toolbar icon. The `run` function executes server-side and returns an action:

```ts
interface UiActionResult {
  open?: string;       // Open URL in new tab
  overlay?: string;    // Open URL in full-screen iframe overlay
  navigate?: string;   // Navigate current tab to URL
  message?: string;    // Show toast message
}
```

## Built-in Plugins

| Plugin | Tools | Description |
|---|---|---|
| `hue` | `hue_discover_bridge`, `hue_pair`, `hue_list_lights`, `hue_set_light`, `hue_list_rooms`, `hue_set_room`, `hue_list_scenes`, `hue_activate_scene`, `hue_create_scene`, `hue_update_scene`, `hue_set_scene_light`, `hue_delete_scene`, `hue_create_room`, `hue_update_room`, `hue_delete_room`, `hue_rename_light` | Philips Hue smart lighting — mDNS discovery, pairing, lights, rooms, scenes |
| `chromecast` | `discover_chromecasts`, `list_audio_tracks`, `play_on_chromecast`, `stop_chromecast` | Cast local media to Chromecast devices. Supports HLS transcode, audio track selection, subtitles, range requests |
| `fileOps` | `ls`, `cat`, `list_allowed_dirs`, `suggest_start_dir`, `dir_tree`, `cp`, `mv`, `rename`, `list_write_dirs`, `delete_file` (opt-in) | File browsing and manipulation, sandboxed to configured directories |
| `memo` | `read_memo`, `write_memo`, `append_memo`, `list_memos` | Persistent markdown memory. Main memo injected into every system prompt; sub-memos available on demand |
| `playwright_scraper` | (via playwright) | Headless Chromium for JS-rendered pages |
| `wiki_search` | (via fetch) | Wikipedia full-article fetch |
| `scraper` | `scrape` | Headless Chromium page scraper — renders JS, returns full visible text |
| `clock` | `clock` | Returns current ISO timestamp |
| `music` | `music_list_dirs`, `music_info`, `music_browse`, `music_search`, `music_play`, `music_queue_add`, `music_queue_show`, `music_queue_clear`, `music_player_ui` | Browser-based music player with shared queue, streaming, and playlist management |
| `fileSearch` | — | File search plugin |
| `http` | — | HTTP utility plugin |
| `lastfm` | — | Last.fm music integration |
| `search` | — | Search plugin |

## Configuration

`config.json` is auto-generated on first run at `~/.config/leatherHarness/config.json`:

```json
{
  "listen": { "host": "127.0.0.1", "port": 9001 },
  "upstream": { "baseUrl": "${OPENCODE_ENDPOINT:-http://127.0.0.1:8080/v1}" },
  "maxToolRounds": 25,
  "maxMessages": 50,
  "pluginsDir": "./plugins",
  "mcpServers": {},
  "pluginConfig": {
    "hue": { "bridgeIp": "", "username": "" },
    "fileOps": { "allowedDirs": [], "writeDirs": [], "deleteEnabled": false },
    "chromecast": { "allowedDirs": [] },
    "memo": { "path": "~/.config/leatherHarness/memo" },
    "music": { "allowedDirs": [] }
  }
}
```

- `listen.host` / `listen.port` — Address the harness binds to.
- `upstream.baseUrl` — URL of the OpenAI-compatible LLM endpoint. Supports `${ENV_VAR:-default}` substitution.
- `maxToolRounds` — Maximum tool execution iterations per request (default 25).
- `maxMessages` — Conversation length threshold that triggers compaction (default 50).
- `mcpServers` — MCP server specs merged into the tool schema.
- `pluginConfig.<name>` — Plugin-specific configuration.

## Testing

Tests are end-to-end, driven in-code (no test servers started). Run with:

```bash
npm test
```

| Test File | What It Tests |
|---|---|
| `test/run.js` | Tool registration, schema generation, resolve loop with mock LLM |
| `test/e2e.js` | UI serving via HTTP |
| `test/e2e_chat.js` | Full chat request through harness to mock LLM |
| `test/e2e_ui.js` | UI icon registry (registration, action execution, guards) |
| `test/e2e_music.js` | Music plugin: library walking, playlist building, browsing, searching, streaming, queue management, route mounting, host header handling |
| `test/compaction.js` | Conversation compaction logic |
| `test/sse-robustness.js` | SSE stream resilience |
| `test/upstream-metrics.js` | Upstream metrics proxy |
| `test/metrics.js` | Global metrics tracking |
| `test/mockLlama.js` | Mock LLM server utility for tests |

## Development

```bash
npm install && npx playwright install
npm run dev    # Builds UI, watches for changes, auto-restarts server
npm start      # Production: builds UI once, starts server
```

The dev mode uses `concurrently` + `nodemon` to watch both Vite (UI) and ts-node (server) for changes.

## TypeScript Configuration

- Target: ES2022, Module: ESNext
- JSX: `react-jsx` (automatic)
- Strict mode enabled
- `noEmit: true` — compilation only, Vite handles bundling
- Sources in `src/**/*.ts`, `src/**/*.tsx`
