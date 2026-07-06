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
      // A generator may override the HTTP status (e.g. simulate a 400) by
      // returning { __status, __body }; otherwise the value is the 200 JSON body.
      const status = resp && resp.__status ? resp.__status : 200;
      const bodyObj = resp && resp.__body !== undefined ? resp.__body : resp;
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
