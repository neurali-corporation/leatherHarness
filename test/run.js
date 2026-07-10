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

// Multiple tool calls in one round must run concurrently (latency = slowest,
// not sum) and their `tool` results must be appended in call order so each
// pairs with its tool_call_id.
async function testParallelToolExecution() {
  let running = 0;
  let maxConcurrent = 0;
  const slow = (name) => ({
    name,
    description: name,
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 100));
      running--;
      return name;
    },
  });
  registerNativeTool(slow("slow_a"));
  registerNativeTool(slow("slow_b"));

  const mockPort = 12346;
  let toolMessages = null;
  const server = await startMockLlama(mockPort, (req) => {
    if (req.messages.length === 1) {
      return {
        choices: [{ message: {
          role: "assistant", content: null,
          tool_calls: [
            { id: "a", type: "function", function: { name: "hx__slow_a", arguments: "{}" } },
            { id: "b", type: "function", function: { name: "hx__slow_b", arguments: "{}" } },
          ],
        } }],
      };
    }
    // Second round: capture the tool results the loop fed back upstream.
    toolMessages = req.messages.filter((m) => m.role === "tool");
    return { choices: [{ message: { role: "assistant", content: "done", tool_calls: [] } }] };
  });

  const cfg = { upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` }, maxToolRounds: 5 };
  const start = Date.now();
  await resolveRequest({ messages: [{ role: "user", content: "go" }], tools: [] }, cfg);
  const elapsed = Date.now() - start;

  assert.equal(maxConcurrent, 2, "both tools should run at the same time");
  assert.ok(elapsed < 190, `two 100ms tools run in parallel should take ~100ms, took ${elapsed}ms`);
  assert.deepEqual(
    toolMessages.map((m) => m.tool_call_id),
    ["a", "b"],
    "tool results must be appended in call order",
  );
  server.close();
}

// The final answer must reach the caller as multiple incremental deltas (real
// token streaming), and tool-call arguments split across SSE frames must be
// reassembled into valid JSON before the tool runs.
async function testStreamingAnswer() {
  let echoedArgs = null;
  registerNativeTool({
    name: "echo",
    description: "echo",
    parameters: { type: "object", properties: { msg: { type: "string" } }, required: [] },
    execute: async (a) => { echoedArgs = a; return "ok"; },
  });

  const mockPort = 12360;
  const server = await startMockLlama(mockPort, (req) => {
    if (req.messages.length === 1) {
      return { choices: [{ message: {
        role: "assistant", content: null,
        tool_calls: [{ id: "e", type: "function", function: { name: "hx__echo", arguments: '{"msg":"hello world"}' } }],
      } }] };
    }
    return { choices: [{ message: { role: "assistant", content: "The answer is 42.", tool_calls: [] } }] };
  });

  const deltas = [];
  const cfg = { upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` }, maxToolRounds: 5 };
  await resolveRequest(
    { messages: [{ role: "user", content: "go" }], tools: [] },
    cfg,
    (ev) => { if (ev.t === "delta") deltas.push(ev.text); },
  );

  assert.ok(deltas.length > 1, `answer should stream as multiple deltas, got ${deltas.length}`);
  assert.equal(deltas.join(""), "The answer is 42.", "streamed deltas must reassemble to the full answer");
  assert.deepEqual(echoedArgs, { msg: "hello world" }, "tool args split across frames must reassemble to valid JSON");
  server.close();
}

// Inline <think>…</think> reasoning must never leak into the streamed answer —
// the non-streamed path strips it, so streaming must too. Tags straddle the
// mock's 3-char chunks, so this also exercises cross-chunk tag handling.
// Regression guard for oh-my-pi edits being corrupted by leaked chain-of-thought.
async function testStreamingStripsThink() {
  const mockPort = 12361;
  const answer = "SWAP 1.=1:\nreal edit body";
  const server = await startMockLlama(mockPort, () => ({
    choices: [{ message: {
      role: "assistant",
      content: `<think>secret plan the user must not see</think>${answer}`,
      tool_calls: [],
    } }],
  }));

  const deltas = [];
  const cfg = { upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` }, maxToolRounds: 5 };
  await resolveRequest(
    { messages: [{ role: "user", content: "edit it" }], tools: [] },
    cfg,
    (ev) => { if (ev.t === "delta") deltas.push(ev.text); },
  );

  const streamed = deltas.join("");
  assert.equal(streamed, answer, `streamed answer must exclude reasoning, got: ${JSON.stringify(streamed)}`);
  assert.ok(!streamed.includes("<think>") && !streamed.includes("secret plan"), "no chain-of-thought may leak into the stream");
  server.close();
}

(async () => {
  await testNativeRegistration();
  await testChromecastStatusTool();
  await testResolveLoop();
  await testParallelToolExecution();
  await testStreamingAnswer();
  await testStreamingStripsThink();
  console.log("All tests passed");
})();
