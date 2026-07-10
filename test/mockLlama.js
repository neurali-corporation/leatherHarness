// test/mockLlama.js
import http from "node:http";
import { resolve as resolvePath } from "node:path";

// Turn a non-streamed {choices:[{message}]} response into an OpenAI-style SSE
// stream. Content and tool-call arguments are deliberately split across chunks
// so the harness's stream reassembly (by index, across frames) is exercised.
function writeSSE(res, resp, includeUsage) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const msg = resp?.choices?.[0]?.message ?? {};
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const halves = (s) => {
    const mid = Math.ceil(s.length / 2);
    return [s.slice(0, mid), s.slice(mid)].filter((p) => p.length);
  };
  // Split content into small fixed-size chunks so multi-char tokens (e.g.
  // `<think>` tags) reliably straddle chunk boundaries, exercising reassembly.
  const chunks = (s, n) => {
    const out = [];
    for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
    return out;
  };

  if (typeof msg.content === "string" && msg.content.length) {
    for (const part of chunks(msg.content, 3)) {
      send({ choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
    }
  }

  const calls = msg.tool_calls || [];
  calls.forEach((tc, i) => {
    // First fragment carries id + name; arguments trickle in afterwards.
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }, finish_reason: null }] });
    for (const part of halves(tc.function.arguments || "")) {
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: part } }] }, finish_reason: null }] });
    }
  });

  send({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] });
  if (includeUsage) send({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  res.write("data: [DONE]\n\n");
  res.end();
}

export function startMockLlama(port, responseGenerator) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const reqJson = JSON.parse(body);
      const resp = responseGenerator(reqJson);
      // A generator may override the HTTP status (e.g. simulate a 400) by
      // returning { __status, __body }; otherwise the value is the 200 JSON body.
      const status = resp && resp.__status ? resp.__status : 200;
      const bodyObj = resp && resp.__body !== undefined ? resp.__body : resp;
      // Upstream errors are returned as JSON regardless of stream; only a
      // successful 200 is streamed when the caller asked for stream:true.
      if (status === 200 && reqJson.stream) {
        writeSSE(res, bodyObj, !!reqJson.stream_options?.include_usage);
        return;
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(bodyObj));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise(resolve => {
    server.listen(port, () => resolve(server));
  });
}
