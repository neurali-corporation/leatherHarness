// test/tool-fallback.js — end-to-end test for the tools-less 400 fallback.
// llama.cpp (--jinja) builds a tool-call parser from the model's chat template
// and can 400 during that generation for some templates/message shapes. Tools
// aren't required to get an answer, so callUpstream retries once without tools
// instead of failing the round.

import { strict as assert } from 'node:assert';
import { resolveRequest } from '../src/resolve.ts';
import { startMockLlama } from './mockLlama.js';

async function testRetriesWithoutToolsOn400() {
  let sawToolsRequest = false;
  let sawNoToolsRequest = false;
  const port = 12356;
  const server = await startMockLlama(port, (req) => {
    if (req.tools && req.tools.length) {
      sawToolsRequest = true;
      // Simulate llama.cpp's tool-parser generation failure.
      return {
        __status: 400,
        __body: { error: { message: 'Unable to generate parser for this template. Automatic parser generation failed: No user query found in messages.' } },
      };
    }
    sawNoToolsRequest = true;
    return { choices: [{ message: { role: 'assistant', content: 'fallback answer', tool_calls: [] } }] };
  });

  const cfg = {
    upstream: { baseUrl: `http://127.0.0.1:${port}/v1` },
    maxToolRounds: 3,
    maxMessages: 100,
  };
  const body = {
    messages: [{ role: 'user', content: 'hi' }],
    // A tool is present, so the harness sends `tools` and triggers the 400 path.
    tools: [{ type: 'function', function: { name: 'x', description: '', parameters: { type: 'object', properties: {} } } }],
  };

  const result = await resolveRequest(body, cfg); // non-streaming: returns data
  assert.ok(sawToolsRequest, 'first call was made with tools');
  assert.ok(sawNoToolsRequest, 'retried without tools after the 400');
  assert.equal(result?.choices?.[0]?.message?.content, 'fallback answer', 'got the tools-less answer back');

  server.close();
  console.log('✅ Tools-less 400 fallback works');
}

(async () => {
  try {
    await testRetriesWithoutToolsOn400();
    console.log('All tool-fallback tests passed');
  } catch (e) {
    console.error('❌ Test failed:', e);
    process.exit(1);
  }
})();
