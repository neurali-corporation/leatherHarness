// test/e2e_scrape.js — end-to-end test for the scrape plugin.
// The scrape tool should return full HTML content (tags, links, etc.)
// but strip <script> and <style> elements from the <head>.

import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fetch from 'node-fetch';

async function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

function makeHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Test Page</title>
  <script src="/some-script.js"></script>
  <style>body { color: red; }</style>
  <link rel="stylesheet" href="/style.css">
  <link rel="icon" href="/favicon.ico">
  <script>console.log("inline");</script>
  <style>.hidden { display: none; }</style>
</head>
<body>
  <h1>Hello World</h1>
  <p>This is a <a href="https://example.com">link</a> in the body.</p>
  <div class="content">Some content</div>
</body>
</html>`;
}

async function startMockServer() {
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(makeHtml());
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return { server, port: addr.port };
}

function parseToolCalls(data) {
  if (!data.choices || !data.choices[0] || !data.choices[0].message) return null;
  const msg = data.choices[0].message;
  if (msg.tool_calls && msg.tool_calls.length > 0) return msg.tool_calls[0];
  return null;
}

async function chat(harnessPort, messages, tools) {
  const resp = await fetch(`http://127.0.0.1:${harnessPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'any', messages, tools }),
  });
  return resp.json();
}

(async () => {
  const { server: mockServer, port: mockPort } = await startMockServer();
  const harnessPort = 9020;
  const proc = spawn('node', ['-r', 'ts-node/register', 'src/server.ts'], {
    stdio: 'pipe',
    env: { ...process.env, PORT: harnessPort.toString() },
  });
  await delay(2500);

  const scrapeTool = {
    name: 'hx__scrape',
    description: 'scrape',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  };

  try {
    // Round 1: model decides to call scrape
    const r1 = await chat(harnessPort,
      [{ role: 'user', content: `Scrape http://127.0.0.1:${mockPort}/ for me` }],
      [scrapeTool]
    );
    const toolCall = parseToolCalls(r1);
    assert.ok(toolCall, 'model should call hx__scrape');
    assert.equal(toolCall.function.name, 'hx__scrape', 'tool name is hx__scrape');
    const args = JSON.parse(toolCall.function.arguments);
    assert.ok(args.url, 'scrape called with a url');

    // Round 2: send tool result, get final answer with HTML content
    const r2 = await chat(harnessPort, [
      { role: 'user', content: `Scrape http://127.0.0.1:${mockPort}/ for me` },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: toolCall.id,
          type: 'function',
          function: { name: 'hx__scrape', arguments: JSON.stringify(args) },
        }],
      },
      { role: 'tool', tool_call_id: toolCall.id, content: 'done' },
    ], [scrapeTool]);

    const reply = r2.choices[0].message.content;

    // HTML tags should be present
    assert.ok(reply.includes('<html'), 'output contains <html> tag');
    assert.ok(reply.includes('<head>'), 'output contains <head> tag');
    assert.ok(reply.includes('<body>'), 'output contains <body> tag');
    assert.ok(reply.includes('<h1>'), 'output contains <h1> tag');
    assert.ok(reply.includes('<a '), 'output contains <a> tag');
    assert.ok(reply.includes('href="https://example.com"'), 'output contains link href');
    assert.ok(reply.includes('<link'), 'output contains <link> tag');
    assert.ok(reply.includes('<meta'), 'output contains <meta> tag');

    // Text content preserved
    assert.ok(reply.includes('Test Page'), 'title text preserved');
    assert.ok(reply.includes('Hello World'), 'h1 text preserved');
    assert.ok(reply.includes('Some content'), 'body text preserved');

    // <script> and <style> must NOT appear in the output
    assert.ok(!reply.includes('<script'), 'output must not contain <script> tags');
    assert.ok(!reply.includes('<style'), 'output must not contain <style> tags');

    console.log('All scrape tests passed');
  } finally {
    proc.kill();
    await new Promise(res => proc.on('close', res));
    mockServer.close();
  }
})();
