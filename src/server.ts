import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath, dirname } from 'node:path';
import { homedir } from 'node:os';
import { loadPlugins } from './plugin-loader.ts';
import { loadMcpServers } from './mcp.ts';
import { resolveRequest } from './resolve.ts';
import { matchRoute } from './http-registry.ts';
import { setListen, noteHost } from './runtime.ts';
import { uiIconList, runUiIcon } from './ui-registry.ts';
import { initModelLauncher, resetModelLauncher } from './model-launcher.ts';

// ── secret-based auth (global, with OpenAI-compatible Bearer header) ────────
const AUTH_COOKIE = 'lh-secret';

// Extensions that are static frontend assets — never gate these (login page needs them)
const STATIC_EXTS = new Set(['.css', '.js', '.mjs', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot']);

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key.trim()] = rest.join('=').trim();
  }
  return cookies;
}

function checkAuth(req: http.IncomingMessage, secret: string | undefined): boolean {
  if (!secret || secret === '') return true; // no secret configured → allow all

  // 1. Authorization: Bearer <secret> — OpenAI-compatible, works with opencode
  const auth = req.headers.authorization ?? '';
  if (auth === `Bearer ${secret}`) return true;

  // 2. Cookie — for browser sessions
  const cookies = parseCookies(req.headers.cookie);
  return cookies[AUTH_COOKIE] === secret;
}

function isStaticAsset(pathname: string): boolean {
  // No extension on the path → check if it's a known static path
  const ext = pathname.includes('.') ? pathname.slice(pathname.lastIndexOf('.')) : '';
  return STATIC_EXTS.has(ext);
}

function authFail(res: http.ServerResponse, redirectToLogin: boolean = false): void {
  if (redirectToLogin) {
    res.writeHead(302, { Location: '/auth/login' });
    res.end();
  } else {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'authentication required' }));
  }
}

// Global stats tracking
const globalStats = {
  totalRequests: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalTokens: 0,
  totalToolCalls: 0,
  totalCompactions: 0,
  startTime: Date.now(),
};

function updateGlobalMetrics(metrics: any) {
  globalStats.totalRequests++;
  globalStats.totalPromptTokens += metrics.prompt ?? 0;
  globalStats.totalCompletionTokens += metrics.completion ?? 0;
  globalStats.totalTokens += metrics.total ?? 0;
  globalStats.totalToolCalls += metrics.toolCalls ?? 0;
  globalStats.totalCompactions += metrics.compactions ?? 0;
}

async function main() {
  const configDir = resolvePath(homedir(), '.config', 'leatherHarness');
  const cfgPath = resolvePath(configDir, 'config.json');

  // loadPlugins writes a default config.json if one doesn't exist yet
  const defaultPluginsDir = './plugins';
  await loadPlugins(defaultPluginsDir, cfgPath);

  let cfgData = await readFile(cfgPath, 'utf8');
  cfgData = cfgData.replace(/\${([^}]+)}/g, (_, expr) => {
    const [varName, def] = expr.split(':-');
    return process.env[varName] || def || '';
  });
  const config = JSON.parse(cfgData);
  await loadMcpServers(config.mcpServers ?? {});

  // Initialize model launcher if enabled
  if (config.enableModelLauncher) {
    let models = config.models || [];
    
    // If no models configured, auto-discover from launchers directory
    if (models.length === 0) {
      const launchersDir = config.launchersDir || resolvePath(process.cwd(), '..', 'launchers');
      console.log(`Auto-discovering models from: ${launchersDir}`);
      const { autoDiscoverModels } = await import('./model-launcher.ts');
      models = await autoDiscoverModels(launchersDir);
      console.log(`Found ${models.length} models`);
    }
    
    initModelLauncher({
      enableModelLauncher: config.enableModelLauncher,
      models,
    });
    console.log('Model launcher initialized');

    // Start the default model at boot. startModel only spawns the process
    // (it doesn't wait for the model to finish loading), so this returns
    // promptly and doesn't delay the HTTP server coming up.
    const { getModelLauncher } = await import('./model-launcher.ts');
    await getModelLauncher()?.autoStart();
  }

  const server = http.createServer(async (req, res) => {
    // Remember the address the browser reaches us at, so tool links use it.
    noteHost(req.headers.host);

    // Plugin-mounted routes (e.g. the music player UI + streaming) take precedence.
    const pathname = (req.url ?? '/').split('?')[0];

    // ── secret auth: gate everything except static frontend assets ──
    if (config.secret && config.secret !== '' && !isStaticAsset(pathname)) {
      if (!checkAuth(req, config.secret)) {
        // Allow login endpoint to be accessible without auth
        if (req.method === 'GET' && pathname.startsWith('/auth/')) {
          // fall through to login handler
        } else if (req.method === 'POST' && pathname.startsWith('/auth/')) {
          // fall through to login handler
        } else {
          if (req.method === 'GET' && req.headers.accept?.includes('text/html')) {
            authFail(res, true);
          } else {
            authFail(res, false);
          }
          return;
        }
      }
    }

    const route = matchRoute(pathname);
    if (route) {
      try {
        await route(req, res);
      } catch (e) {
        console.error('❌ route handler error:', e);
        if (!res.headersSent) res.writeHead(500);
        res.end('error');
      }
      return;
    }

    // Serve built UI
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const builtPath = resolvePath(process.cwd(), 'dist-ui/index.html');
      try {
        const html = await readFile(builtPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      } catch {
        const placeholderPath = resolvePath(process.cwd(), 'public/fallback.html');
        try {
          const html = await readFile(placeholderPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
          return;
        } catch {
          res.writeHead(500);
          res.end('UI not available');
          return;
        }
      }
    }

    if (req.method === 'GET') {
      const staticPath = resolvePath(process.cwd(), 'dist-ui' + req.url);
      try {
        const data = await readFile(staticPath);
        const ext = staticPath.split('.').pop();
        const mime =
          ext === 'js'   ? 'application/javascript' :
          ext === 'css'  ? 'text/css' :
          ext === 'svg'  ? 'image/svg+xml' :
          ext === 'png'  ? 'image/png' :
          ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
          ext === 'ico'  ? 'image/x-icon' :
          'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
        return;
      } catch { /* fall through */ }
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const json = JSON.parse(body);
      console.log('🔹 Incoming request, stream:', json.stream ?? false);

      if (json.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        // `metrics` events stream CUMULATIVE counts and are emitted repeatedly
        // within a single request (after each tool round, compaction, and the
        // final answer). Folding every snapshot into the global stats double-,
        // triple-, … counts the same tokens and calls. Instead keep the latest
        // snapshot and apply it to the global stats exactly once, when the
        // request finishes ('done'). This bookkeeping runs for both wire formats.
        let lastMetrics: any = null;
        let globalApplied = false;
        const applyGlobalOnce = () => {
          if (globalApplied || !lastMetrics) return;
          updateGlobalMetrics(lastMetrics);
          globalApplied = true;
        };
        const trackMetrics = (e: any) => {
          if (e.t === 'metrics') lastMetrics = e;
          else if (e.t === 'done') applyGlobalOnce();
        };

        // The web UI (identified by the X-Leather-UI header) understands our rich
        // internal event stream. Every other caller is a standard OpenAI client
        // (e.g. opencode), which needs `chat.completion.chunk`s — so translate.
        const isUi = req.headers['x-leather-ui'] === '1';

        // UI format: pass the internal {t:...} events straight through.
        const uiEmit = (ev: object) => {
          trackMetrics(ev as any);
          if (!res.writableEnded && res.writable) {
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          }
        };

        // OpenAI format: translate internal events into chat.completion.chunks.
        const streamId = 'chatcmpl-' + Math.random().toString(36).slice(2);
        const created = Math.floor(Date.now() / 1000);
        const model = json.model ?? 'leatherharness';
        let finishReason = 'stop';
        const writeChunk = (delta: object, finish: string | null) => {
          if (res.writableEnded || !res.writable) return;
          const chunk = {
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        };
        const openaiEmit = (ev: object) => {
          const e = ev as any;
          trackMetrics(e);
          switch (e.t) {
            case 'delta':
              // resolveRequest emits the full assistant content once per answer.
              if (e.text) writeChunk({ content: e.text }, null);
              break;
            case 'tool_calls': {
              const calls = (e.calls ?? []).map((c: any, i: number) => ({
                index: i,
                id: c.id,
                type: 'function',
                function: { name: c.function?.name, arguments: c.function?.arguments ?? '' },
              }));
              if (calls.length) {
                writeChunk({ tool_calls: calls }, null);
                finishReason = 'tool_calls';
              }
              break;
            }
            case 'error':
              if (!res.writableEnded && res.writable) {
                res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
              }
              break;
            case 'done':
              writeChunk({}, finishReason);
              break;
            // reasoning / tool_call / tool_result / metrics / compact are
            // harness-internal observability — suppressed for external clients.
          }
        };

        const emitFn = isUi ? uiEmit : openaiEmit;
        try {
          await resolveRequest(json, config, emitFn);
        } catch (e: any) {
          console.error('❌ resolveRequest error:', e);
          // Only emit error/done if response is still open
          if (!res.writableEnded && res.writable) {
            emitFn({ t: 'error', message: e.message });
            emitFn({ t: 'done', usage: {} });
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        }
        // Only finalize if response is still open
        if (!res.writableEnded && res.writable) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }

      // Non-streaming (OpenAI-compatible passthrough)
      let result;
      try {
        result = await resolveRequest(json, config);
      } catch (e) {
        console.error('❌ resolveRequest error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Internal server error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Plugin-contributed UI icons: list them, and run one on click.
    if (req.method === 'GET' && pathname === '/api/ui/icons') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(uiIconList()));
      return;
    }
    if (req.method === 'POST' && pathname.startsWith('/api/ui/icons/')) {
      const id = decodeURIComponent(pathname.slice('/api/ui/icons/'.length));
      try {
        const result = await runUiIcon(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result ?? {}));
      } catch (e: any) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      const upstream = config.upstream.baseUrl + '/models';
      const resp = await fetch(upstream);
      const data = await resp.json();
      res.writeHead(resp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    // Metrics endpoint (local harness stats)
    if (req.method === 'GET' && pathname === '/api/metrics') {
      const uptime = Date.now() - globalStats.startTime;
      const uptimeHours = uptime / 3600000;
      const avgTokensPerRequest = globalStats.totalRequests > 0
        ? Math.round(globalStats.totalTokens / globalStats.totalRequests)
        : 0;
      const metrics = {
        ...globalStats,
        uptime,
        uptimeHours,
        avgTokensPerRequest,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics));
      return;
    }

    // Proxy upstream LLM /metrics endpoint
    if (req.method === 'GET' && pathname === '/api/upstream/metrics') {
      // If we manage the model and none is running, there's nothing to poll —
      // return quietly instead of hammering the port and logging ECONNREFUSED.
      if (config.enableModelLauncher) {
        const { getModelLauncher } = await import('./model-launcher.ts');
        const launcher = getModelLauncher();
        if (launcher && !launcher.getStatus().isRunning) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ running: false, error: 'No model running' }));
          return;
        }
      }
      try {
        // llama.cpp --metrics exposes metrics at /metrics on the same host/port
        // Strip /v1 suffix from baseUrl if present to get the base URL
        const baseUrl = config.upstream.baseUrl.replace(/\/v1\/?$/, '');
        const upstreamUrl = baseUrl + '/metrics';
        console.log('Fetching upstream metrics from:', upstreamUrl);
        
        // Fetch with retry in case upstream is slow to populate metrics
        let text = '';
        let resp;
        for (let attempt = 1; attempt <= 3; attempt++) {
          resp = await fetch(upstreamUrl);
          text = await resp.text();
          if (resp.status === 200 && text && text !== '{}' && text.length > 2) {
            break; // Got meaningful data
          }
          console.log(`Upstream metrics attempt ${attempt}: status=${resp.status}, len=${text.length}`);
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 100 * attempt));
          }
        }
        
        console.log('Upstream metrics final status:', resp.status, 'length:', text.length);
        const contentType = resp.headers.get('content-type') || 'text/plain';
        res.writeHead(resp.status, { 'Content-Type': contentType });
        
        if (contentType.includes('text/event-stream')) {
          // Stream SSE (shouldn't happen with text already read, but handle it)
          res.end(text);
        } else {
          // Parse metrics response (could be JSON, Prometheus text format, etc.)
          try {
            const data = JSON.parse(text);
            console.log('Parsed as JSON, sending', Object.keys(data).length, 'keys');
            res.end(JSON.stringify(data));
          } catch {
            // Prometheus text format - parse into structured JSON
            const parsed: Record<string, any> = {};
            const lines = text.split('\n');
            for (const line of lines) {
              const commentMatch = line.match(/^# (HELP|TYPE) (.+?) (.+)$/);
              if (commentMatch) continue; // Skip comments
              // Prometheus metric names are [a-zA-Z_:][a-zA-Z0-9_:]* — llama.cpp
              // uses a "llamacpp:" prefix, so the name regex must allow colons.
              const metricMatch = line.match(/^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(.+)$/);
              if (metricMatch) {
                const name = metricMatch[1];
                const value = metricMatch[3];
                // Try to parse as number
                const num = parseFloat(value);
                parsed[name] = isNaN(num) ? value : num;
              }
            }
            const jsonStr = JSON.stringify(parsed);
            console.log('Parsed upstream metrics (Prometheus), sending:', jsonStr.slice(0, 100));
            res.end(jsonStr);
          }
        }
      } catch (e: any) {
        console.error('❌ Upstream metrics fetch error:', e);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Failed to fetch upstream metrics: ${e.message}` }));
      }
      return;
    }

    // Model launcher routes
    if (req.method === 'GET' && pathname === '/api/models/status') {
      const { getModelLauncher } = await import('./model-launcher.ts');
      const launcher = getModelLauncher();
      if (!launcher) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enabled: false, isRunning: false, modelName: null, pid: null, models: [] }));
        return;
      }
      const status = launcher.getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/models/list') {
      const { getModelLauncher } = await import('./model-launcher.ts');
      const launcher = getModelLauncher();
      if (!launcher) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
      const models = launcher.listModels();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models }));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/models/start') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const json = JSON.parse(body);
      const { getModelLauncher } = await import('./model-launcher.ts');
      const launcher = getModelLauncher();
      if (!launcher) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Model launcher not enabled' }));
        return;
      }
      try {
        await launcher.startModel(json.modelName);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/models/stop') {
      const { getModelLauncher } = await import('./model-launcher.ts');
      const launcher = getModelLauncher();
      if (!launcher) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Model launcher not enabled' }));
        return;
      }
      try {
        await launcher.stopModel();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/models/switch') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const json = JSON.parse(body);
      const { getModelLauncher } = await import('./model-launcher.ts');
      const launcher = getModelLauncher();
      if (!launcher) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Model launcher not enabled' }));
        return;
      }
      try {
        await launcher.switchModel(json.modelName);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const port = process.env.PORT ? parseInt(process.env.PORT) : config.listen.port;
  setListen(config.listen.host, port);
  server.listen(port, config.listen.host, () => {
    console.log(`Harness listening on http://${config.listen.host}:${port}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
