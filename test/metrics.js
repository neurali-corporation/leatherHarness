// test/metrics.js — end-to-end tests for metrics proxying.
// Metrics events stream cumulative token counts, round numbers, tool call
// counts, and compaction counts as the tool loop progresses.

import { strict as assert } from "node:assert";
import { registerNativeTool } from "../src/registry.ts";
import { resolveRequest } from "../src/resolve.ts";
import { startMockLlama } from "./mockLlama.js";

// Register the clock tool so the mock can be asked to call it.
registerNativeTool({
  name: "clock",
  description: "Current date and time in ISO format",
  parameters: { type: "object", properties: {}, required: [] },
  execute: async () => new Date().toISOString(),
});

// ── testMetricsEmitCumulative: metrics events carry cumulative token counts ──
async function testMetricsEmitCumulative() {
  let callCount = 0;
  const mockPort = 12355;
  const server = await startMockLlama(mockPort, (req) => {
    callCount++;

    // First call: tool call with usage
    if (callCount <= 3) {
      return {
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "1",
              type: "function",
              function: { name: "hx__clock", arguments: "{}" }
            }]
          }
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };
    }

    // Final call: no tool calls
    return {
      choices: [{ message: { role: "assistant", content: "Done", tool_calls: [] } }],
      usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
    };
  });

  const cfg = {
    upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
    maxToolRounds: 5,
  };

  const body = {
    messages: [{ role: "user", content: "What time is it?" }],
    tools: [],
  };

  const events = [];
  const emit = (ev) => events.push(ev);

  try {
    await resolveRequest(body, cfg, emit);
  } catch (_) {}

  // Should have metrics events
  const metricsEvents = events.filter(e => e.t === 'metrics');
  assert.ok(metricsEvents.length > 0, "should have metrics events");

  // First metrics event should have the first round's usage
  const firstMetrics = metricsEvents[0];
  assert.equal(firstMetrics.prompt, 100, "first metrics prompt should be 100");
  assert.equal(firstMetrics.completion, 50, "first metrics completion should be 50");
  assert.equal(firstMetrics.total, 150, "first metrics total should be 150");

  // Last metrics event should have cumulative counts
  const lastMetrics = metricsEvents[metricsEvents.length - 1];
  assert.ok(lastMetrics.total >= 150, "last metrics total should be at least 150");

  server.close();
}

// ── testMetricsTrackRounds: metrics events track round numbers ──
async function testMetricsTrackRounds() {
  let callCount = 0;
  const mockPort = 12356;
  const server = await startMockLlama(mockPort, (req) => {
    callCount++;

    if (callCount <= 2) {
      return {
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "1",
              type: "function",
              function: { name: "hx__clock", arguments: "{}" }
            }]
          }
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };
    }

    return {
      choices: [{ message: { role: "assistant", content: "Done", tool_calls: [] } }],
      usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
    };
  });

  const cfg = {
    upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
    maxToolRounds: 5,
  };

  const body = {
    messages: [{ role: "user", content: "What time is it?" }],
    tools: [],
  };

  const events = [];
  const emit = (ev) => events.push(ev);

  try {
    await resolveRequest(body, cfg, emit);
  } catch (_) {}

  const metricsEvents = events.filter(e => e.t === 'metrics');
  assert.ok(metricsEvents.length > 0, "should have metrics events");

  // Check that round numbers are tracked
  const rounds = metricsEvents.map(e => e.round);
  assert.ok(rounds.some(r => r === 1), "should have round 1");
  assert.ok(rounds.some(r => r === 2), "should have round 2");

  server.close();
}

// ── testMetricsTrackToolCalls: metrics events track tool call counts ──
async function testMetricsTrackToolCalls() {
  let callCount = 0;
  const mockPort = 12357;
  const server = await startMockLlama(mockPort, (req) => {
    callCount++;

    if (callCount <= 2) {
      return {
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "1", type: "function", function: { name: "hx__clock", arguments: "{}" } },
              { id: "2", type: "function", function: { name: "hx__clock", arguments: "{}" } },
            ]
          }
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };
    }

    return {
      choices: [{ message: { role: "assistant", content: "Done", tool_calls: [] } }],
      usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
    };
  });

  const cfg = {
    upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
    maxToolRounds: 5,
  };

  const body = {
    messages: [{ role: "user", content: "What time is it?" }],
    tools: [],
  };

  const events = [];
  const emit = (ev) => events.push(ev);

  try {
    await resolveRequest(body, cfg, emit);
  } catch (_) {}

  const metricsEvents = events.filter(e => e.t === 'metrics');
  assert.ok(metricsEvents.length > 0, "should have metrics events");

  // Last metrics event should have toolCalls count
  const lastMetrics = metricsEvents[metricsEvents.length - 1];
  assert.ok(lastMetrics.toolCalls >= 2, `should have at least 2 tool calls, got ${lastMetrics.toolCalls}`);

  server.close();
}

// ── testMetricsTrackCompactions: metrics events track compaction counts ──
async function testMetricsTrackCompactions() {
  let compactCount = 0;
  const mockPort = 12358;
  const server = await startMockLlama(mockPort, (req) => {
    // Always return tool calls to build up messages and trigger compaction
    return {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "1",
            type: "function",
            function: { name: "hx__clock", arguments: "{}" }
          }]
        }
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
  });

  const cfg = {
    upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
    maxToolRounds: 20,
    maxMessages: 10,
  };

  const body = {
    messages: [{ role: "user", content: "What time is it?" }],
    tools: [],
  };

  const events = [];
  const emit = (ev) => events.push(ev);

  try {
    await resolveRequest(body, cfg, emit);
  } catch (_) {}

  const metricsEvents = events.filter(e => e.t === 'metrics');
  assert.ok(metricsEvents.length > 0, "should have metrics events");

  // Some metrics events should have compactions > 0
  const compactionEvents = metricsEvents.filter(e => e.compactions > 0);
  assert.ok(compactionEvents.length > 0, "should have metrics events with compactions");

  server.close();
}

// ── testMetricsIncludeElapsedTime: metrics events include elapsed time ──
async function testMetricsIncludeElapsedTime() {
  let callCount = 0;
  const mockPort = 12359;
  const server = await startMockLlama(mockPort, (req) => {
    callCount++;

    if (callCount <= 2) {
      return {
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "1",
              type: "function",
              function: { name: "hx__clock", arguments: "{}" }
            }]
          }
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };
    }

    return {
      choices: [{ message: { role: "assistant", content: "Done", tool_calls: [] } }],
      usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
    };
  });

  const cfg = {
    upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
    maxToolRounds: 5,
  };

  const body = {
    messages: [{ role: "user", content: "What time is it?" }],
    tools: [],
  };

  const events = [];
  const emit = (ev) => events.push(ev);

  try {
    await resolveRequest(body, cfg, emit);
  } catch (_) {}

  const metricsEvents = events.filter(e => e.t === 'metrics');
  assert.ok(metricsEvents.length > 0, "should have metrics events");

  // All metrics events should have elapsed time
  for (const m of metricsEvents) {
    assert.ok(typeof m.elapsed === 'number', "elapsed should be a number");
    assert.ok(m.elapsed >= 0, "elapsed should be non-negative");
  }

  server.close();
}

(async () => {
  await testMetricsEmitCumulative();
  await testMetricsTrackRounds();
  await testMetricsTrackToolCalls();
  await testMetricsTrackCompactions();
  await testMetricsIncludeElapsedTime();
  console.log("All metrics tests passed");
})();
