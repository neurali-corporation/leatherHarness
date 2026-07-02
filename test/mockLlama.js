// test/mockLlama.js
import http from "node:http";
import { resolve as resolvePath } from "node:path";

export function startMockLlama(port, responseGenerator) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const reqJson = JSON.parse(body);
      const resp = responseGenerator(reqJson);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resp));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise(resolve => {
    server.listen(port, () => resolve(server));
  });
}
