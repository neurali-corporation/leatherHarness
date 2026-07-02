// test/run.js
import { strict as assert } from "node:assert";
import { registerNativeTool, hasTool, toolSchemas, getTool } from "../src/registry.ts";
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

  assert.ok(hasTool("hx__clock"), "clock tool should be registered");
  assert.ok(hasTool("hx__discover_chromecasts"), "discover_chromecasts tool should be registered");
  const schema = toolSchemas().find(s => s.function.name === "hx__clock");
  assert.ok(schema, "clock schema present");
  const out = await getTool("hx__clock").execute();
  assert.ok(/\d{4}-\d{2}-\d{2}T/.test(out), "clock output ISO format");
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
  await testResolveLoop();
  console.log("All tests passed");
})();
