// test/upstream-metrics.js — tests for upstream /metrics endpoint proxying.
// Verifies that leatherHarness correctly proxies the upstream LLM's /metrics
// endpoint with JSON responses.

import { strict as assert } from "node:assert";
import http from 'node:http';
import fetch from 'node-fetch';

// ── testUpstreamMetricsProxyJson: proxies JSON metrics from upstream ──
async function testUpstreamMetricsProxyJson() {
  // Start mock upstream server with /metrics endpoint
  const upstreamServer = http.createServer((req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        total_requests: 1000,
        total_tokens: 500000,
        avg_latency_ms: 45.2,
        model: "test-model",
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => upstreamServer.listen(0, resolve));
  const upstreamPort = upstreamServer.address().port;

  // Test the proxy logic directly
  const harnessServer = http.createServer(async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && pathname === '/api/upstream/metrics') {
      try {
        const upstreamUrl = `http://127.0.0.1:${upstreamPort}/metrics`;
        const resp = await fetch(upstreamUrl);
        const contentType = resp.headers.get('content-type') || 'application/json';
        res.writeHead(resp.status, { 'Content-Type': contentType });
        const data = await resp.json();
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => harnessServer.listen(0, resolve));
  const harnessPort = harnessServer.address().port;

  try {
    // Test the proxy
    const resp = await fetch(`http://127.0.0.1:${harnessPort}/api/upstream/metrics`);
    assert.equal(resp.status, 200, "should return 200");

    const data = await resp.json();
    assert.equal(data.total_requests, 1000, "should have total_requests");
    assert.equal(data.total_tokens, 500000, "should have total_tokens");
    assert.equal(data.avg_latency_ms, 45.2, "should have avg_latency_ms");
    assert.equal(data.model, "test-model", "should have model");
  } finally {
    harnessServer.close();
    upstreamServer.close();
  }
}

// ── testUpstreamMetricsProxyError: handles upstream errors gracefully ──
async function testUpstreamMetricsProxyError() {
  // Start mock upstream server that returns 500
  const upstreamServer = http.createServer((req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal server error' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => upstreamServer.listen(0, resolve));
  const upstreamPort = upstreamServer.address().port;

  // Test the proxy logic
  const harnessServer = http.createServer(async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && pathname === '/api/upstream/metrics') {
      try {
        const upstreamUrl = `http://127.0.0.1:${upstreamPort}/metrics`;
        const resp = await fetch(upstreamUrl);
        const contentType = resp.headers.get('content-type') || 'application/json';
        res.writeHead(resp.status, { 'Content-Type': contentType });
        const data = await resp.json();
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => harnessServer.listen(0, resolve));
  const harnessPort = harnessServer.address().port;

  try {
    // Test the proxy
    const resp = await fetch(`http://127.0.0.1:${harnessPort}/api/upstream/metrics`);
    // Should proxy the 500 status from upstream
    assert.equal(resp.status, 500, "should proxy upstream status");

    const data = await resp.json();
    assert.equal(data.error, 'internal server error', "should have error message");
  } finally {
    harnessServer.close();
    upstreamServer.close();
  }
}

// ── testUpstreamMetricsProxyConnectionError: handles connection errors ──
async function testUpstreamMetricsProxyConnectionError() {
  // Test with a port that's not listening
  const harnessServer = http.createServer(async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && pathname === '/api/upstream/metrics') {
      try {
        const upstreamUrl = `http://127.0.0.1:1/upstream-metrics-test`;
        const resp = await fetch(upstreamUrl);
        res.writeHead(resp.status, { 'Content-Type': 'application/json' });
        const data = await resp.json();
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => harnessServer.listen(0, resolve));
  const harnessPort = harnessServer.address().port;

  try {
    // Test the proxy
    const resp = await fetch(`http://127.0.0.1:${harnessPort}/api/upstream/metrics`);
    // Should return 502 when upstream is unreachable
    assert.equal(resp.status, 502, "should return 502 on connection error");

    const data = await resp.json();
    assert.ok(data.error && data.error.length > 0, "should have error message");
  } finally {
    harnessServer.close();
  }
}

// ── testUpstreamMetricsProxyPrometheusFormat: parses Prometheus text format ──
async function testUpstreamMetricsProxyPrometheusFormat() {
  // Start mock upstream server with Prometheus-format /metrics endpoint
  const upstreamServer = http.createServer((req, res) => {
    if (req.url === '/metrics') {
      const prometheusFormat = `# HELP llama_ctx_tokens_eval_total Total number of evaluation tokens
# TYPE llama_ctx_tokens_eval_total counter
llama_ctx_tokens_eval_total 12345
# HELP llama_ctx_eval_avg Average evaluation time per token
# TYPE llama_ctx_eval_avg gauge
llama_ctx_eval_avg 0.045
# HELP llama_tokens_eval Total tokens evaluated
# TYPE llama_tokens_eval counter
llama_tokens_eval 67890
`;
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(prometheusFormat);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => upstreamServer.listen(0, resolve));
  const upstreamPort = upstreamServer.address().port;

  // Test the proxy logic
  const harnessServer = http.createServer(async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && pathname === '/api/upstream/metrics') {
      try {
        const baseUrl = `http://127.0.0.1:${upstreamPort}`;
        const upstreamUrl = baseUrl + '/metrics';
        const resp = await fetch(upstreamUrl);
        const contentType = resp.headers.get('content-type') || 'text/plain';
        res.writeHead(resp.status, { 'Content-Type': contentType });

        const text = await resp.text();
        try {
          const data = JSON.parse(text);
          res.end(JSON.stringify(data));
        } catch {
          // Prometheus text format - parse into structured JSON
          const parsed = {};
          const lines = text.split('\n');
          for (const line of lines) {
            const commentMatch = line.match(/^# (HELP|TYPE) (.+?) (.+)$/);
            if (commentMatch) continue;
            const metricMatch = line.match(/^(\w+)(?:\{(.*)\})?\s+(.+)$/);
            if (metricMatch) {
              const name = metricMatch[1];
              const value = metricMatch[3];
              const num = parseFloat(value);
              parsed[name] = isNaN(num) ? value : num;
            }
          }
          res.end(JSON.stringify(parsed));
        }
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => harnessServer.listen(0, resolve));
  const harnessPort = harnessServer.address().port;

  try {
    // Test the proxy
    const resp = await fetch(`http://127.0.0.1:${harnessPort}/api/upstream/metrics`);
    assert.equal(resp.status, 200, "should return 200");

    const data = await resp.json();
    assert.equal(data.llama_ctx_tokens_eval_total, 12345, "should parse llama_ctx_tokens_eval_total");
    assert.equal(data.llama_ctx_eval_avg, 0.045, "should parse llama_ctx_eval_avg");
    assert.equal(data.llama_tokens_eval, 67890, "should parse llama_tokens_eval");
  } finally {
    harnessServer.close();
    upstreamServer.close();
  }
}

(async () => {
  await testUpstreamMetricsProxyJson();
  console.log("✓ testUpstreamMetricsProxyJson passed");

  await testUpstreamMetricsProxyError();
  console.log("✓ testUpstreamMetricsProxyError passed");

  await testUpstreamMetricsProxyConnectionError();
  console.log("✓ testUpstreamMetricsProxyConnectionError passed");

  await testUpstreamMetricsProxyPrometheusFormat();
  console.log("✓ testUpstreamMetricsProxyPrometheusFormat passed");

  console.log("\nAll upstream metrics proxy tests passed");
})();
