// test/run.js
import { strict as assert } from "node:assert";
import registry, { registerNativeTool, hasTool, toolSchemas, getTool } from "../src/registry.ts";
import { resolveRequest } from "../src/resolve.ts";
import { startMockLlama } from "./mockLlama.js";

async function testNativeRegistration() {
  registerNativeTool({
    name: 'clock',
    description: 'Current date and time in ISO format',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => new Date().toISOString(),
  });

  registerNativeTool({
    name: 'discover_chromecasts',
    description: 'Discover Chromecast devices on the local network',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => JSON.stringify([]),
  });

  registerNativeTool({
    name: 'chromecast_status',
    description: 'List all currently active Chromecast streams',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => 'No active Chromecast streams.',
  });

  assert.ok(hasTool("hx__clock"), "clock tool should be registered");
  assert.ok(hasTool("hx__discover_chromecasts"), "discover_chromecasts tool should be registered");
  assert.ok(hasTool("hx__chromecast_status"), "chromecast_status tool should be registered");
  const schema = toolSchemas().find(s => s.function.name === "hx__clock");
  assert.ok(schema, "clock schema present");
  const out = await getTool("hx__clock").execute();
  assert.ok(/\d{4}-\d{2}-\d{2}T/.test(out), "clock output ISO format");
}

async function testChromecastStatusTool() {
  // Load the real chromecast plugin to test the actual chromecast_status tool
  const { setup } = await import("../plugins/chromecast/index.ts");
  const { activeSessions } = await import("../plugins/chromecast/index.ts");
  
  // Create a mock plugin config
  const mockConfig = {
    async get() { return { allowedDirs: ['/tmp'] }; },
    async set() {},
  };
  
  // testNativeRegistration registered mock chromecast tools on the shared
  // registry; drop the ones the real plugin also registers so setup() doesn't
  // collide on duplicate names.
  registry._registry.delete('hx__discover_chromecasts');
  registry._registry.delete('hx__chromecast_status');

  // Setup the plugin (registers the real tools)
  setup(mockConfig);
  
  // Verify the real tool is registered
  assert.ok(hasTool("hx__chromecast_status"), "real chromecast_status tool should be registered");
  
  // Test with empty sessions
  const result = await getTool("hx__chromecast_status").execute();
  assert.ok(result.includes("No active Chromecast streams"), 
    "should report no active streams when sessions map is empty");
  
  // Add a mock session. Use a loopback address with nothing listening so the
  // live-status query fails fast (ECONNREFUSED) instead of hanging on a LAN IP.
  activeSessions.set('/tmp/test.mp4', {
    ip: '127.0.0.1',
    sessionId: 'abc123',
    closeServer: () => {},
  });

  const result2 = await getTool("hx__chromecast_status").execute();
  const parsed = JSON.parse(result2);
  assert.ok(Array.isArray(parsed), "should return JSON array");
  assert.strictEqual(parsed.length, 1, "should have 1 session");
  assert.strictEqual(parsed[0].path, '/tmp/test.mp4', "should include correct path");
  assert.strictEqual(parsed[0].ip, '127.0.0.1', "should include correct IP");
  assert.strictEqual(parsed[0].sessionId, 'abc123', "should include correct sessionId");
  // The device is unreachable, so live status should surface as an error string.
  assert.ok(typeof parsed[0].error === 'string', "unreachable device should report an error");

  // Add another session
  activeSessions.set('/tmp/test2.mkv', {
    ip: '127.0.0.1',
    sessionId: 'def456',
    closeServer: () => {},
  });

  const result3 = await getTool("hx__chromecast_status").execute();
  const parsed3 = JSON.parse(result3);
  assert.strictEqual(parsed3.length, 2, "should have 2 sessions");

  // Clean up
  activeSessions.clear();
}

async function testResolveLoop() {
  const mockPort = 12345;
  const server = await startMockLlama(mockPort, (req) => {
    const round = req.messages.length;
    if (round === 1) {
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "1",
                  type: "function",
                  function: { name: "hx__clock", arguments: "{}" }
                }
              ]
            }
          }
        ]
      };
    }
    return {
      choices: [{ message: { role: "assistant", content: "The time is provided.", tool_calls: [] } }]
    };
  });

  const cfg = { upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` }, maxToolRounds: 5 };
  const body = { messages: [{ role: "user", content: "What time is it?" }], tools: [] };
  const result = await resolveRequest(body, cfg);
  assert.ok(result.choices[0].message.content.includes("The time is provided"), "final answer returned");
  server.close();
}

(async () => {
  await testNativeRegistration();
  await testChromecastStatusTool();
  await testResolveLoop();
  console.log("All tests passed");
})();
