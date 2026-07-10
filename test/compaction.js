// test/compaction.js — end-to-end tests for conversation compaction.
// Compaction kicks in when messages grow past maxMessages: older messages get
// summarized into a single system-style block so the context window doesn't
// blow up on long sessions.

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

// ── testCompactionTriggers: compaction fires when message count exceeds maxMessages ──
async function testCompactionTriggers() {
  let compactEvents = 0;
  const mockPort = 12347;
  const server = await startMockLlama(mockPort, (req) => {
    // Always return tool calls to build up messages
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
    };
  });

  const cfg = {
    upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
    maxToolRounds: 20, // allow enough rounds for compaction to trigger
    maxMessages: 10, // trigger compaction early
  };

  const body = {
    messages: [{ role: "user", content: "What time is it?" }],
    tools: [],
  };

  const events = [];
  const emit = (ev) => {
    events.push(ev);
    if (ev.t === 'compact') compactEvents++;
  };

  // Should hit tool round limit, but compaction should have triggered
  try {
    await resolveRequest(body, cfg, emit);
  } catch (_) {}

  assert.ok(compactEvents > 0, `compaction should have been triggered, got ${compactEvents} events`);
  assert.ok(events.some(e => e.t === 'compact'), "compact event emitted during streaming");
  server.close();
}

// ── testNoCompactionWhenBelowThreshold: compaction doesn't fire if messages stay under maxMessages ──
async function testNoCompactionWhenBelowThreshold() {
  let compactEvents = 0;
  const mockPort = 12349;
  const server = await startMockLlama(mockPort, (req) => {
    // Return final answer immediately
    return {
      choices: [{ message: { role: "assistant", content: "Simple answer", tool_calls: [] } }],
    };
  });

  const cfg = {
    upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
    maxToolRounds: 2,
    maxMessages: 100, // very high, should never trigger
  };

  const body = {
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
  };

  const events = [];
  const emit = (ev) => {
    events.push(ev);
    if (ev.t === 'compact') compactEvents++;
  };

  const result = await resolveRequest(body, cfg, emit);
  assert.equal(compactEvents, 0, "compaction should not trigger when below threshold");
  // Check that we got a done event (streaming mode returns null but emits done)
  assert.ok(events.some(e => e.t === 'done'), "got done event");
  server.close();
}

// ── testCompactionWithStreaming: compaction events stream to client ──
async function testCompactionWithStreaming() {
  let compactEvents = 0;
  const mockPort = 12350;
  const server = await startMockLlama(mockPort, (req) => {
    // Always return tool calls to build up messages
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
    };
  });

  const cfg = {
    upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
    maxToolRounds: 20, // allow enough rounds for compaction to trigger
    maxMessages: 10,
  };

  const body = {
    messages: [{ role: "user", content: "What time is it?" }],
    tools: [],
  };

  const events = [];
  const emit = (ev) => {
    events.push(ev);
    if (ev.t === 'compact') compactEvents++;
  };

  // Should hit tool round limit, but compaction should have triggered
  try {
    await resolveRequest(body, cfg, emit);
  } catch (_) {}

  assert.ok(compactEvents > 0, "compaction was triggered");
  const compactEvent = events.find(e => e.t === 'compact');
  assert.ok(compactEvent, "compact event exists");
  assert.ok(compactEvent.oldCount > 0, "compact event has oldCount");
  server.close();
}

// ── testCompactionPreservesRecentMessages: compacted messages keep recent ones ──
async function testCompactionPreservesRecentMessages() {
  let callCount = 0;
  let hasSeenCompaction = false;
  const mockPort = 12352;
  const server = await startMockLlama(mockPort, (req) => {
    callCount++;

    // Check that the compacted system message exists
    const hasCompact = req.messages.some(m => m.role === 'system' && m.content.includes('Compacted Conversation Summary'));
    if (hasCompact) {
      hasSeenCompaction = true;
    }

    // First several calls: return tool calls to build up messages
    // After compaction is detected, return final answer
    if (hasCompact || callCount > 8) {
      return {
        choices: [{ message: { role: "assistant", content: "Done", tool_calls: [] } }],
      };
    }

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
  const emit = (ev) => {
    events.push(ev);
  };

  try {
    await resolveRequest(body, cfg, emit);
  } catch (_) {}

  assert.ok(hasSeenCompaction, "compaction should have been triggered");
  server.close();
}

// ── testCompactionKeepsUserTurn: post-compaction payloads always carry a user turn ──
// Regression guard: Qwen3-style templates (Ornith) raise "No user query found in
// messages." during llama.cpp --jinja tool-parser generation when a request has no
// user role. Compaction used to strip the original user request into the summarized
// half, leaving a user-less tail → upstream 400. Every upstream call must see a user.
async function testCompactionKeepsUserTurn() {
  let sawCompactedRequest = false;
  let userlessRequest = null;
  const mockPort = 12354;
  const server = await startMockLlama(mockPort, (req) => {
    const hasCompact = req.messages.some(
      m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('Compacted Conversation Summary')
    );
    if (hasCompact) sawCompactedRequest = true;
    if (!req.messages.some(m => m.role === 'user')) {
      userlessRequest = req.messages.map(m => m.role);
    }
    // Keep returning tool calls so compaction is forced to run.
    return {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "1", type: "function", function: { name: "hx__clock", arguments: "{}" } }],
        },
      }],
    };
  });

  const cfg = {
    upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
    maxToolRounds: 20,
    maxMessages: 10,
  };
  const body = { messages: [{ role: "user", content: "What time is it?" }], tools: [] };

  try {
    await resolveRequest(body, cfg, () => {});
  } catch (_) {}

  assert.ok(sawCompactedRequest, "compaction should have been triggered");
  assert.equal(userlessRequest, null, `every upstream payload must contain a user turn, saw roles: ${JSON.stringify(userlessRequest)}`);
  server.close();
}

// ── testCompactionPreservesSystemPrompt: the client's system prompt survives compaction verbatim ──
// Regression guard: compaction used to slice the system message into the summarized
// half, so standing instructions (tool payload formats, persona) were replaced by a
// lossy summary — clients like oh-my-pi then emitted malformed tool calls. The
// original system prompt must lead every post-compaction upstream payload, unchanged.
async function testCompactionPreservesSystemPrompt() {
  const systemPrompt = "You are TestBot. Edits MUST use `SWAP N.=M:` hunk headers.";
  let sawCompactedRequest = false;
  let badRequest = null;
  const mockPort = 12356;
  const server = await startMockLlama(mockPort, (req) => {
    // Skip the summarizer's own call — its system message is the compressor prompt.
    const isCompressor = req.messages.some(
      m => typeof m.content === 'string' && m.content.includes('conversation compressor')
    );
    if (!isCompressor) {
      const hasCompact = req.messages.some(
        m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('Compacted Conversation Summary')
      );
      if (hasCompact) sawCompactedRequest = true;
      if (!(req.messages[0]?.role === 'system' && req.messages[0]?.content === systemPrompt)) {
        badRequest = req.messages.map(m => ({ role: m.role, content: String(m.content).slice(0, 60) }));
      }
    }
    // Keep returning tool calls so compaction is forced to run.
    return {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "1", type: "function", function: { name: "hx__clock", arguments: "{}" } }],
        },
      }],
    };
  });

  const cfg = {
    upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
    maxToolRounds: 20,
    maxMessages: 10,
  };
  const body = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "What time is it?" },
    ],
    tools: [],
  };

  try {
    await resolveRequest(body, cfg, () => {});
  } catch (_) {}

  assert.ok(sawCompactedRequest, "compaction should have been triggered");
  assert.equal(badRequest, null, `system prompt must lead every upstream payload verbatim, saw: ${JSON.stringify(badRequest)}`);
  server.close();
}

// ── testCompactionKeepsToolPairsIntact: compaction never orphans a tool message ──
// A `tool` message is only valid right after the assistant message whose
// tool_calls it answers. The naive cut (fixed offset from the end) can land
// mid-group, summarizing the assistant away and leaving the kept tail starting
// with an orphaned tool message — llama.cpp (--jinja) 400s on that, failing the
// round and stopping long-running clients like opencode/oh-my-pi. Every tool
// message the harness forwards upstream must have a preceding assistant that
// declared its tool_call_id.
async function testCompactionKeepsToolPairsIntact() {
  const mockPort = 12362;
  let sentMessages = null;
  const server = await startMockLlama(mockPort, (req) => {
    const isCompressor = req.messages.some(
      m => typeof m.content === 'string' && m.content.includes('conversation compressor')
    );
    // Capture the main (non-summarizer) round that carries the compacted history.
    if (!isCompressor && req.messages.some(m => m.role === 'tool')) sentMessages = req.messages;
    return { choices: [{ message: { role: 'assistant', content: 'done', tool_calls: [] } }] };
  });

  // system + user + 6 [assistant(tool_calls), tool] pairs = 14 messages. With
  // maxMessages 10 the naive cut lands on a tool message (orphaning its parent).
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'start' },
  ];
  for (let i = 1; i <= 6; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'hx__clock', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, content: `res${i}` });
  }

  const cfg = { upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` }, maxToolRounds: 5, maxMessages: 10 };
  await resolveRequest({ messages, tools: [] }, cfg, () => {});

  assert.ok(sentMessages, "compaction should have run and forwarded the history upstream");
  const declared = new Set();
  let orphan = null;
  for (const m of sentMessages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) declared.add(tc.id);
    if (m.role === 'tool' && !declared.has(m.tool_call_id)) { orphan = m.tool_call_id; break; }
  }
  assert.equal(orphan, null, `compaction orphaned tool message ${orphan} from its assistant tool_calls`);
  server.close();
}

(async () => {
  await testCompactionTriggers();
  await testNoCompactionWhenBelowThreshold();
  await testCompactionWithStreaming();
  await testCompactionPreservesRecentMessages();
  await testCompactionKeepsUserTurn();
  await testCompactionPreservesSystemPrompt();
  await testCompactionKeepsToolPairsIntact();
  console.log("All compaction tests passed");
})();
