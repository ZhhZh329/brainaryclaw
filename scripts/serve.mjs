import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("../public", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

http.createServer((request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const full = path.join(root, file);
  if (!full.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  fs.readFile(full, (error, body) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": types[path.extname(full)] || "application/octet-stream" });
    response.end(body);
  });
}).listen(port, () => {
  console.log(`Serving http://localhost:${port}`);
});
