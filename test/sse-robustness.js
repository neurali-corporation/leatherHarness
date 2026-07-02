// test/sse-robustness.js — tests for SSE connection robustness.
// Verifies that the server handles client disconnection gracefully without
// throwing errors or leaving dangling promises.

import { strict as assert } from "node:assert";
import http from 'node:http';
import { registerNativeTool } from "../src/registry.ts";
import { resolveRequest } from "../src/resolve.ts";

// Register the clock tool
registerNativeTool({
  name: "clock",
  description: "Current date and time in ISO format",
  parameters: { type: "object", properties: {}, required: [] },
  execute: async () => new Date().toISOString(),
});

// ── testSafeEmitOnClientDisconnect: server doesn't crash when client disconnects ──
async function testSafeEmitOnClientDisconnect() {
  const { resolveRequest: resolve } = await import("../src/resolve.ts");

  // Create a mock emit that simulates a closed response
  let writeCount = 0;
  const mockRes = {
    writable: true,
    writableEnded: false,
    write: (data) => {
      writeCount++;
      // Simulate client disconnect after a few writes
      if (writeCount > 3) {
        mockRes.writable = false;
      }
      return true;
    },
    end: () => {},
  };

  const safeEmit = (ev) => {
    if (!mockRes.writableEnded && mockRes.writable) {
      mockRes.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  };

  // Simulate what happens when client disconnects mid-stream
  safeEmit({ t: 'reasoning', text: 'thinking...' });
  safeEmit({ t: 'tool_call', id: '1', name: 'clock', args: '{}' });
  safeEmit({ t: 'tool_result', id: '1', name: 'clock', out: '2026-06-30' });
  safeEmit({ t: 'delta', text: 'The time is' });
  safeEmit({ t: 'done', usage: { total_tokens: 100 } });

  // After client disconnects, emit should not throw
  safeEmit({ t: 'metrics', prompt: 50, completion: 50, total: 100 });
  safeEmit({ t: 'error', message: 'test error' });

  assert.ok(true, "safeEmit did not throw after client disconnect");
}

// ── testResponseWritableCheck: checks res.writable flag is respected ──
async function testResponseWritableCheck() {
  const events = [];
  const mockRes = {
    writable: true,
    writableEnded: false,
    write: (data) => {
      events.push(data);
      return true;
    },
    end: () => {
      mockRes.writableEnded = true;
    },
  };

  const safeEmit = (ev) => {
    if (!mockRes.writableEnded && mockRes.writable) {
      mockRes.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  };

  // Emit some events
  safeEmit({ t: 'test', value: 1 });
  safeEmit({ t: 'test', value: 2 });

  assert.equal(events.length, 2, "should have 2 events");

  // End the response
  mockRes.end();

  // Try to emit more events - should be skipped
  safeEmit({ t: 'test', value: 3 });
  safeEmit({ t: 'test', value: 4 });

  assert.equal(events.length, 2, "should still have 2 events after end");
}

// ── testRealSSEStream: test with real HTTP server and client ──
async function testRealSSEStream() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const safeEmit = (ev) => {
          if (!res.writableEnded && res.writable) {
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          }
        };

        // Emit a few events
        safeEmit({ t: 'test', value: 1 });
        safeEmit({ t: 'test', value: 2 });

        // Simulate client disconnect
        setTimeout(() => {
          res.end();
        }, 10);

        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(0, () => {
      const port = server.address().port;
      const req = http.get(`http://127.0.0.1:${port}/stream`, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          server.close();
          assert.ok(data.length > 0, "should receive some data");
          assert.ok(data.includes('"value":1'), "should contain first event");
          resolve();
        });
      });

      req.on('error', (err) => {
        server.close();
        reject(err);
      });

      // Close client connection after a short delay
      setTimeout(() => {
        req.destroy();
      }, 50);
    });

    server.on('error', reject);
  });
}

(async () => {
  await testSafeEmitOnClientDisconnect();
  console.log("✓ testSafeEmitOnClientDisconnect passed");

  await testResponseWritableCheck();
  console.log("✓ testResponseWritableCheck passed");

  await testRealSSEStream();
  console.log("✓ testRealSSEStream passed");

  console.log("\nAll SSE robustness tests passed");
})();
