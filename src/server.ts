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

  const server = http.createServer(async (req, res) => {
    // Remember the address the browser reaches us at, so tool links use it.
    noteHost(req.headers.host);

    // Plugin-mounted routes (e.g. the music player UI + streaming) take precedence.
    const pathname = (req.url ?? '/').split('?')[0];
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
        // request finishes ('done').
        let lastMetrics: any = null;
        let globalApplied = false;
        const applyGlobalOnce = () => {
          if (globalApplied || !lastMetrics) return;
          updateGlobalMetrics(lastMetrics);
          globalApplied = true;
        };
        const safeEmit = (ev: object) => {
          const e = ev as any;
          if (e.t === 'metrics') {
            lastMetrics = e;
          } else if (e.t === 'done') {
            applyGlobalOnce();
          }
          // Only write if the response is still writable (client hasn't disconnected)
          if (!res.writableEnded && res.writable) {
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          }
        };
        try {
          await resolveRequest(json, config, safeEmit);
        } catch (e: any) {
          console.error('❌ resolveRequest error:', e);
          // Only emit error/done if response is still open
          if (!res.writableEnded && res.writable) {
            safeEmit({ t: 'error', message: e.message });
            safeEmit({ t: 'done', usage: {} });
            safeEmit('data: [DONE]\n\n');
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
      const uptimeHours = (uptime / 3600000).toFixed(1);
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
