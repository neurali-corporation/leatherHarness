import { spawn, execSync } from 'child_process';
import fetch from 'node-fetch';
import assert from 'assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

// Mock LLM: when the request carries client tools, return a tool call to one of
// them (a "foreign" call the harness must forward). Otherwise reply with text.
async function startMockLlama(port) {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const json = JSON.parse(body);
      const clientToolNames = (json.tools || [])
        .map(t => t.function?.name)
        .filter(n => n && !n.startsWith('hx__'));
      // Once the client has fed a tool result back (role:'tool'), answer with text
      // instead of calling the tool again — otherwise the agent loop never ends.
      const hasToolResult = (json.messages || []).some(m => m.role === 'tool');
      const message = (!hasToolResult && clientToolNames.includes('glob'))
        ? { role: 'assistant', content: '', tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*.ts"}' } },
          ] }
        : { role: 'assistant', content: 'done', tool_calls: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

// Parse an SSE body into the array of JSON `data:` payloads.
function parseSse(text) {
  return text.split('\n')
    .filter(l => l.startsWith('data: '))
    .map(l => l.slice(6).trim())
    .filter(l => l && l !== '[DONE]')
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

const globTool = { type: 'function', name: 'glob', description: 'find files', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } };

(async () => {
  console.log('Building UI...');
  execSync('npm run build-ui', { stdio: 'inherit' });

  const mockPort = 12351;
  const mockServer = await startMockLlama(mockPort);

  // Isolate config in a temp HOME: no secret (skip auth), no model launcher
  // (don't spawn a real llama-server), upstream pointed at the mock.
  const home = await mkdtemp(join(tmpdir(), 'lh-responses-'));
  await mkdir(join(home, '.config', 'leatherHarness'), { recursive: true });
  await writeFile(
    join(home, '.config', 'leatherHarness', 'config.json'),
    JSON.stringify({
      secret: '',
      enableModelLauncher: false,
      upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
    }, null, 2),
    'utf8',
  );

  const harnessPort = 9014;
  const serverEnv = { ...process.env, HOME: home, PORT: harnessPort.toString() };
  const serverProc = spawn('node', ['-r', 'ts-node/register', 'src/server.ts'], { stdio: 'inherit', env: serverEnv });
  await delay(2000);

  try {
    // ── Streaming: client tool call must come back as a function_call item ──
    const streamResp = await fetch(`http://127.0.0.1:${harnessPort}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'any', stream: true, input: [{ role: 'user', content: 'list the files' }], tools: [globTool] }),
    });
    const events = parseSse(await streamResp.text());

    const added = events.find(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
    assert.ok(added, 'streaming: no function_call output_item.added emitted');
    assert.strictEqual(added.item.name, 'glob', 'streaming: wrong function name');
    assert.strictEqual(added.item.call_id, 'call_1', 'streaming: call_id not preserved');

    const argsDone = events.find(e => e.type === 'response.function_call_arguments.done');
    assert.ok(argsDone && argsDone.arguments.includes('*.ts'), 'streaming: function_call arguments not forwarded');

    const completed = events.find(e => e.type === 'response.completed');
    assert.ok(completed, 'streaming: no response.completed');
    const fnItems = (completed.response.output || []).filter(o => o.type === 'function_call');
    assert.strictEqual(fnItems.length, 1, 'streaming: function_call missing from completed output');
    assert.strictEqual(fnItems[0].arguments, '{"pattern":"*.ts"}', 'streaming: completed args wrong');
    console.log('✅ Streaming /responses forwards client tool calls');

    // ── Non-streaming: same forwarding through the JSON body ──
    const jsonResp = await fetch(`http://127.0.0.1:${harnessPort}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'any', stream: false, input: [{ role: 'user', content: 'list the files' }], tools: [globTool] }),
    });
    const jsonData = await jsonResp.json();
    const fnCalls = (jsonData.output || []).filter(o => o.type === 'function_call');
    assert.strictEqual(fnCalls.length, 1, 'non-streaming: function_call missing from output');
    assert.strictEqual(fnCalls[0].name, 'glob', 'non-streaming: wrong function name');
    assert.strictEqual(fnCalls[0].call_id, 'call_1', 'non-streaming: call_id not preserved');
    console.log('✅ Non-streaming /responses forwards client tool calls');

    // ── Round-trip: feeding the tool result back yields a normal text answer ──
    const followup = await fetch(`http://127.0.0.1:${harnessPort}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'any', stream: false, tools: [globTool], input: [
        { role: 'user', content: 'list the files' },
        { type: 'function_call', call_id: 'call_1', name: 'glob', arguments: '{"pattern":"*.ts"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'a.ts\nb.ts' },
      ] }),
    });
    const followData = await followup.json();
    const textItem = (followData.output || []).find(o => o.type === 'message');
    assert.ok(textItem && textItem.content?.[0]?.text === 'done', 'round-trip: expected text answer after tool result');
    console.log('✅ /responses tool-result round-trip completes');

    console.log('✅ All /responses tests passed');
  } finally {
    serverProc.kill();
    await new Promise(res => serverProc.on('close', res));
    mockServer.close();
    await rm(home, { recursive: true, force: true });
  }
})();
