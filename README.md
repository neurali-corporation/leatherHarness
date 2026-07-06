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

## the loop, in detail

The whole engine is one function — `resolveRequest(body, config, emit?)` in
`src/resolve.ts`. Everything below happens there unless noted.

### Two modes: streaming vs blocking

The presence of the `emit` callback decides how results come back:

- **Streaming mode** (`emit` provided). `resolveRequest` returns `null` and pushes
  typed `{ t, … }` events through `emit` as it goes. `src/server.ts` wraps `emit`
  to either pass those events straight through (web UI, `X-Leather-UI: 1`) or
  translate them into OpenAI `chat.completion.chunk`s (every other client).
- **Blocking mode** (no `emit`). `resolveRequest` returns the upstream JSON
  response object for the final round, or `{ error: { message } }` on failure.

Either way, **the harness always calls the upstream model non-streaming**
(`stream: false`) — one discrete request per round. Client-side streaming is
synthesized in `server.ts` from those round results; it is never a passthrough of
the upstream token stream.

### Per-request setup (runs once, before the loop)

1. **Limits.** `maxRounds = maxToolRounds || 5`, `maxMessages = maxMessages || 50`.
2. **Working transcript.** `body.messages` is copied into a mutable `messages`
   array that grows as the loop appends assistant/tool turns.
3. **Metrics accumulator.** Start time plus cumulative `prompt/completion/total`
   tokens, `rounds`, `toolCalls`, `compactions`.
4. **Memo injection.** `readMemoContent()` loads the main memo markdown. If present
   it's wrapped as `[Persistent Session Memory]` and either appended to the first
   existing `system` message or unshifted as a new one. Sub-memo file names are
   appended as a one-liner so the model can pull them on demand via `read_memo`.
   This is best-effort — any failure is swallowed.
5. **Tool sources captured.** `clientTools = body.tools ?? []` and the upstream URL.

### The round loop (`for round in 0 … maxRounds-1`)

Each iteration does the following, in order:

**A. Compaction check (before calling the model).** If `messages.length > maxMessages`,
run `compactMessages()` (below), replace the transcript in place, bump the
`compactions` metric, and emit a metrics snapshot.

**B. Assemble tools.** `tools = [...clientTools, ...toolSchemas()]` — the caller's
own tools plus every `hx__`-prefixed native/MCP tool in the registry.

**C. Build payload.** `{ ...body, messages, tools, stream: false }`.

**D. Call upstream.** `callUpstream()` (below). On failure, emit `error` + `done`
and return `null` (streaming), or return `{ error }` (blocking) — the loop stops.

**E. Parse the reply.** `msg = choices[0].message`; `calls = msg.tool_calls || []`;
`splitReasoning(msg)` separates thinking from the answer. If there's reasoning and
we're streaming, emit a `reasoning` event. The round's `usage` token counts are
folded into the cumulative metrics.

**F. Decide how the round ends — three outcomes:**

1. **No tool calls → final answer.** Streaming: emit `delta(content)`, a final
   metrics snapshot, then `done`; return `null`. Blocking: return the raw upstream
   `data`.
2. **Foreign tool calls → relay to client.** A call is "foreign" if its name is
   **not** a registered harness tool (`hasTool()` is false — i.e. it's one of the
   client's own tools). If *any* call in the batch is foreign, the harness executes
   **none** of them and forwards the whole `tool_calls` batch to the client
   (streaming sets `finish_reason: tool_calls`). The web UI never sends tools, so it
   never hits this branch.
3. **All harness tools → execute and loop.** The assistant message (carrying the
   `tool_calls`) is pushed to the transcript, then for each call:
   - `arguments` is `JSON.parse`d (invalid JSON silently becomes `{}`).
   - emit `tool_call(id, name, args)`.
   - execute via `getTool(name).execute(args)`; the result is stringified
     (`JSON.stringify` if it isn't already a string).
   - **Tool errors are isolated** — a throw is caught and turned into
     `ERROR: <tool> failed: …`, which is fed back as the tool result. A failing
     tool never breaks the loop; the model gets the error and can recover.
   - emit `tool_result(id, name, out)`, then push
     `{ role: 'tool', tool_call_id, content: out }` to the transcript.

   A metrics snapshot is emitted and the loop continues to the next round with the
   enlarged transcript.

**G. Termination.** If the loop completes all `maxRounds` iterations without ever
reaching a final answer, that's the loop guard: emit `error` (`Tool round limit …`)
+ `done` (streaming) or return `{ error }` (blocking).

```
round N:
  messages.length > maxMessages ? ─yes→ compactMessages() ─┐
                     │                                       │
                     ▼                                       ▼
  payload = { ...body, messages, tools: client+native, stream:false }
                     │
                     ▼
             callUpstream() ──fail──► emit error+done / return {error}
                     │ ok
                     ▼
        split reasoning / content, add usage to metrics
                     │
        ┌────────────┼─────────────────────────────┐
        ▼            ▼                              ▼
   no tool_calls   foreign calls             all native calls
   → final answer  → relay to client         → run tools, append
     (delta+done)    (tool_calls+done)          results, loop → round N+1
```

### `callUpstream()` — resilient single call

`POST {upstreamUrl}/chat/completions`, up to **10 attempts**:

- **Thrown/connection errors** (`ECONNREFUSED`/`ENOTFOUND`/`ETIMEDOUT`) back off
  exponentially (1s → 30s cap); other thrown errors back off `500ms × attempt`.
- **HTTP `429` or `≥500`** are retried (`500ms × attempt`); other `4xx` return
  immediately as an error — **except** the tools-less `400` fallback: a `400` whose
  body matches `/parser|No user query|raise_exception/i` **and** whose payload
  carried `tools` triggers exactly one recursive retry with `tools` stripped, so a
  template that can't have a tool-parser generated degrades to a plain completion.
- A `200` with **no** `choices[0].message` is treated as transient and retried.
- Returns a discriminated union: `{ ok: true, data }` or `{ ok: false, error }`.

### `compactMessages()` — keeping the context window bounded

Triggered at the top of a round when the transcript exceeds `maxMessages`:

- `keepFromEnd = ceil(maxMessages / 2)` splits the transcript into an older
  **head** (`messagesToCompact`) and a recent **tail** (`messagesToKeep`).
- A **separate, tool-less** upstream call asks the model to summarize the head into
  plain factual text.
- **Success:** returns `[ { role:'system', '[Compacted Conversation Summary] …' },
  …preserveUserTurn(tail) ]` and emits a `compact` event.
- **Failure** (the call failed or threw): falls back to plain truncation —
  `preserveUserTurn(tail)` only, no summary.
- **`preserveUserTurn`**: if the kept tail has no `user`-role message, it prepends
  the earliest `user` message from the whole transcript. This guarantees every
  request the loop sends still contains a user turn — without it, Qwen3-style
  templates raise `No user query found in messages.` during llama.cpp's `--jinja`
  tool-parser generation and 400 the request.

### `splitReasoning()` — separating thinking from the answer

Reasoning is pulled from a dedicated field (`reasoning_content` DeepSeek-style, or
`reasoning` o1-style) **and** from inline `<think>…</think>` blocks embedded in
`content` (including an unclosed trailing `<think>`). The think-tags are stripped
from `content` so they never leak into the user-visible answer, and the combined
reasoning is emitted as a `reasoning` event.

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

## walkthrough: writing a plugin

Two complete, copy-pasteable examples. The first is a plain tool-only plugin (an
"MCP-style" tool the model can call). The second adds a UI component that shows up
as an icon in the sidebar's **Plugins** row and opens its own window.

### 1. A simple tool plugin

This is the whole plugin — one file, no UI. It exposes a `dice` tool and reads a
configurable default from `config.json`.

Create `plugins/dice/index.ts`:

```ts
import { registerNativeTool } from '../../src/registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';

// Seeded into config.json (under pluginConfig.dice) on first run.
interface DiceConfig { sides: number; }
export const defaultConfig: DiceConfig = { sides: 6 };

export function setup(cfg: PluginConfig<DiceConfig>) {
  registerNativeTool({
    name: 'dice',
    // The description is what the model sees — make it clear and specific.
    description: 'Roll one or more dice and return the results and their sum.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'How many dice to roll (default 1).' },
        sides: { type: 'number', description: 'Faces per die (default from config).' },
      },
      required: [],
    },
    execute: async ({ count = 1, sides }: { count?: number; sides?: number }) => {
      const faces = sides ?? (await cfg.get()).sides;      // fall back to config
      const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * faces));
      return JSON.stringify({ rolls, sum: rolls.reduce((a, b) => a + b, 0) });
    },
  });
}
```

That's it. Restart the harness — `loadPlugins()` discovers the folder, calls
`setup(cfg)`, and the tool is registered as `hx__dice` in the schema sent to the
model. Anything a `execute` returns (always a string) is looped back to the model
as the tool result.

Notes:
- **`name` must be unique across all plugins** — it's registered globally and a
  collision throws on startup.
- Keep `execute` returning a `string`; serialize objects with `JSON.stringify`.
- Read config lazily inside `execute` (via `await cfg.get()`) so edits to
  `config.json` take effect without a restart.

### 2. A plugin with a UI component

A UI plugin has **two** files in its folder:

```
plugins/scratchpad/
  index.ts     ← server side: tool(s), an HTTP route for data, and a UI icon
  ui.tsx       ← client side: a React component, discovered by Vite at build time
```

The client (`src/ui/plugin-registry.tsx`) globs every `plugins/*/ui.tsx` at build
time, so there's no import list to maintain — just drop the file in. The component
is always mounted and told via an `open` prop whether its window should be visible
(so it can keep state — e.g. audio playback — alive while closed). The sidebar
shows each plugin's `icon`; clicking it opens the matching component (matched by
`id`).

**`plugins/scratchpad/index.ts`** — a shared server-side note, an HTTP route to
read/write it, a tool so the model can use it too, and the sidebar icon:

```ts
import { registerNativeTool } from '../../src/registry.ts';
import { registerHttpRoute } from '../../src/http-registry.ts';
import { registerUiIcon } from '../../src/ui-registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';

const MOUNT = '/scratchpad';          // where this plugin's routes live
let note = '';                        // one shared value (swap for real storage)

export function setup(_cfg: PluginConfig) {
  // HTTP route: GET returns the note, POST replaces it. registerHttpRoute matches
  // MOUNT and anything below it, so strip the prefix to get the sub-route.
  registerHttpRoute(MOUNT, async (req, res) => {
    const sub = new URL(req.url ?? '/', 'http://x').pathname.slice(MOUNT.length) || '/';
    if (sub === '/api/note' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      note = JSON.parse(body).note ?? '';
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ note }));
  });

  // Sidebar icon. `id` MUST equal the UiPlugin id in ui.tsx so the SPA opens the
  // React component. `run` is the fallback for non-SPA clients (open a URL etc.).
  registerUiIcon({
    id: 'scratchpad',
    title: 'Scratchpad',
    icon: '📝',
    run: () => ({ message: 'Open the scratchpad from the Plugins row.' }),
  });

  // Optional: let the model read/write the same note.
  registerNativeTool({
    name: 'scratchpad_set',
    description: 'Replace the shared scratchpad note.',
    parameters: {
      type: 'object',
      properties: { note: { type: 'string' } },
      required: ['note'],
    },
    execute: async ({ note: n }: { note: string }) => { note = n; return 'Saved.'; },
  });
}
```

**`plugins/scratchpad/ui.tsx`** — the React window. It default-exports a
`UiPlugin` descriptor; `id` matches the icon above:

```tsx
import React, { useEffect, useState } from 'react';
import type { UiPlugin, UiPluginProps } from '../../src/ui/plugin-registry';

const BASE = '/scratchpad';   // same origin the SPA is served from

function Scratchpad({ open, onClose }: UiPluginProps) {
  const [note, setNote] = useState('');

  // Load the note whenever the window opens.
  useEffect(() => {
    if (!open) return;
    fetch(`${BASE}/api/note`).then(r => r.json()).then(d => setNote(d.note ?? ''));
  }, [open]);

  const save = async (text: string) => {
    setNote(text);
    await fetch(`${BASE}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: text }),
    });
  };

  // The component is always mounted; render nothing while closed.
  if (!open) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#0a0a0a',
                  color: '#e0e0e0', display: 'flex', flexDirection: 'column', padding: 20 }}>
      <button onClick={onClose} style={{ alignSelf: 'flex-start', marginBottom: 12 }}>← Close</button>
      <textarea
        value={note}
        onChange={e => save(e.target.value)}
        style={{ flex: 1, background: '#141414', color: '#e0e0e0',
                 border: '1px solid #252525', borderRadius: 8, padding: 12 }}
      />
    </div>
  );
}

const plugin: UiPlugin = {
  id: 'scratchpad',       // must match registerUiIcon({ id }) in index.ts
  title: 'Scratchpad',
  icon: '📝',             // the sidebar shows this single emoji
  Component: Scratchpad,
};

export default plugin;
```

Restart the harness and rebuild the UI. The 📝 icon appears in the **Plugins** row
in the sidebar; clicking it opens the window, which reads and writes the shared
note through the plugin's own HTTP route. The `music` plugin is the full-featured
reference for this pattern.

Key points:
- The `id` in `ui.tsx` and in `registerUiIcon` **must be identical** — that's how a
  click is routed to the component.
- Serve data from your own `registerHttpRoute(MOUNT, …)` and fetch it with
  relative URLs (`/scratchpad/...`) so it works on any host without extra config.
- Because the component stays mounted, put anything that must survive close/reopen
  (timers, `<audio>`, websockets) at the top level and gate only the visible UI on
  `open`.

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
| `src/model-launcher.ts` | Optional local model launcher: parses launcher scripts, starts/stops/switches the upstream model process, frees stale ports, auto-restarts on crash, and kills the model process when the harness shuts down. |
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
  truncated to the most recent `maxMessages/2`. Compaction always carries the
  earliest `user` turn forward, so the outgoing request never ends up with no
  user message — some chat templates (Qwen3-style) raise during llama.cpp's
  `--jinja` tool-parser generation when there is no user turn.
- **Tools-less 400 fallback** — if the upstream returns a `400` from tool-call
  parser generation (e.g. a template `raise_exception`), `callUpstream()` retries
  the call once **without** tools rather than failing the round — degrading to a
  plain completion instead of an error.
- **Backend auto-restart** — when the launcher owns the model process and it exits
  unexpectedly (backend crash, OOM, template abort), it is respawned with
  exponential backoff (1s→30s, reset after the process stays healthy >30s). A
  deliberate stop/switch/shutdown is never auto-restarted.
- **Shuts down with the harness** — the model runs in the harness's process group,
  and `SIGINT`/`SIGTERM`/`SIGHUP` all perform a clean shutdown that kills the model
  process. A controlling-terminal / SSH disconnect (`SIGHUP`) takes the model down
  along with the harness.

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
| `test/compaction.js` | Conversation compaction logic (incl. always keeping a `user` turn) |
| `test/tool-fallback.js` | Retry without tools on a tool-parser `400` |
| `test/auto-restart.js` | Backend crash → auto-restart; intentional stop stays down |
| `test/model-launcher.js` | Launcher script parsing, start/stop/switch, model HTTP routes |
| `test/sse-robustness.js` | SSE stream resilience |
| `test/upstream-metrics.js` | Upstream metrics proxy |
| `test/metrics.js` | Global metrics tracking |
| `test/mockLlama.js` | Mock LLM server utility for tests |
