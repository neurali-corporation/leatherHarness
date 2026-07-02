import { spawn, execSync } from 'child_process';
import fetch from 'node-fetch';
import assert from 'assert';

async function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

// Simple mock LLM server (non-streaming upstream, like llama.cpp is called here)
async function startMockLlama(port) {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const json = JSON.parse(body);
      const userMsg = json.messages?.[json.messages.length - 1]?.content || '';
      const reply = {
        choices: [{ message: { role: 'assistant', content: `Echo: ${userMsg}`, tool_calls: [] } }],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

// Collect `data:` payloads from an SSE response body.
function parseSse(text) {
  const payloads = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    payloads.push(line.slice(6).trim());
  }
  return payloads;
}

(async () => {
  console.log('Building UI...');
  execSync('npm run build-ui', { stdio: 'inherit' });

  const mockPort = 12347;
  const mockServer = await startMockLlama(mockPort);

  const harnessPort = 9012;
  const serverEnv = { ...process.env, PORT: harnessPort.toString(), OPENCODE_ENDPOINT: `http://127.0.0.1:${mockPort}/v1` };
  const serverProc = spawn('node', ['-r', 'ts-node/register', 'src/server.ts'], { stdio: 'inherit', env: serverEnv });
  await delay(2000);

  const url = `http://127.0.0.1:${harnessPort}/v1/chat/completions`;
  const testMsg = 'Hello stream';

  try {
    // --- Default client (e.g. opencode): must get standard OpenAI chunks ---
    const openaiResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: testMsg }], stream: true }),
    });
    const openaiPayloads = parseSse(await openaiResp.text());
    assert.ok(openaiPayloads.includes('[DONE]'), 'OpenAI stream must terminate with [DONE]');

    let sawContent = false;
    for (const p of openaiPayloads) {
      if (p === '[DONE]') continue;
      const obj = JSON.parse(p);
      // No internal harness events may leak to a standard client.
      assert.ok(obj.t === undefined, `leaked internal event to OpenAI client: ${p}`);
      // Every non-[DONE] chunk must be a chat.completion.chunk with a choices array.
      assert.ok(Array.isArray(obj.choices), `chunk missing choices array: ${p}`);
      const content = obj.choices[0]?.delta?.content;
      if (typeof content === 'string' && content.includes(`Echo: ${testMsg}`)) sawContent = true;
    }
    assert.ok(sawContent, 'OpenAI stream never delivered the assistant content');
    console.log('✅ Default client receives standard OpenAI chunks');

    // --- Web UI (X-Leather-UI header): must keep the rich internal event stream ---
    const uiResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Leather-UI': '1' },
      body: JSON.stringify({ model: 'any', messages: [{ role: 'user', content: testMsg }], stream: true }),
    });
    const uiPayloads = parseSse(await uiResp.text());
    let sawDelta = false, sawDone = false;
    for (const p of uiPayloads) {
      if (p === '[DONE]') continue;
      const obj = JSON.parse(p);
      assert.ok(obj.choices === undefined, `UI client got an OpenAI-shaped chunk: ${p}`);
      if (obj.t === 'delta' && (obj.text || '').includes(`Echo: ${testMsg}`)) sawDelta = true;
      if (obj.t === 'done') sawDone = true;
    }
    assert.ok(sawDelta, 'UI stream missing its {t:delta} event');
    assert.ok(sawDone, 'UI stream missing its {t:done} event');
    console.log('✅ Web UI still receives rich internal events');

    console.log('\n🎉 All streaming compatibility tests passed!');
  } finally {
    serverProc.kill();
    await new Promise(res => serverProc.on('close', res));
    mockServer.close();
  }
})();
