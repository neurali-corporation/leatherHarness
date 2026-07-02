import { spawn, execSync } from 'child_process';
import fetch from 'node-fetch';
import assert from 'assert';

async function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

// Simple mock LLM server
async function startMockLlama(port) {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const json = JSON.parse(body);
      const userMsg = json.messages?.[json.messages.length - 1]?.content || '';
      const reply = { choices: [{ message: { role: 'assistant', content: `Echo: ${userMsg}`, tool_calls: [] } }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise(resolve => {
    server.listen(port, () => resolve(server));
  });
}

(async () => {
  // Build UI (needed for static serving)
  console.log('Building UI...');
  execSync('npm run build-ui', { stdio: 'inherit' });

  // Start mock LLM
  const mockPort = 12346;
  const mockServer = await startMockLlama(mockPort);

  // Start harness with env pointing to mock LLM
  const harnessPort = 9010;
  const serverEnv = { ...process.env, PORT: harnessPort.toString(), OPENCODE_ENDPOINT: `http://127.0.0.1:${mockPort}/v1` };
  const serverProc = spawn('node', ['-r', 'ts-node/register', 'src/server.ts'], { stdio: 'inherit', env: serverEnv });

  // Wait for harness to start
  await delay(2000);

  // Send chat request directly via HTTP (no UI)
  const testMsg = 'Hello from test';
  const resp = await fetch(`http://127.0.0.1:${harnessPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'any', messages: [{ role: 'user', content: testMsg }], tools: [] })
  });
  const data = await resp.json();
  const reply = data.choices[0].message.content;
  assert.ok(reply.includes(`Echo: ${testMsg}`), 'Assistant reply not found');
  console.log('✅ Chat interaction succeeded via HTTP');

  // Cleanup
  serverProc.kill();
  await new Promise(res => serverProc.on('close', res));
  mockServer.close();
})();
