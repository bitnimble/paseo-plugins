#!/usr/bin/env node
// Stands in for openvscode-server: accepts the same flags and holds the port open.
import { createServer } from "node:http";

const args = process.argv.slice(2);
const valueOf = (name) => args[args.indexOf(name) + 1];

createServer((_, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("fake editor server");
}).listen(Number(valueOf("--port")), valueOf("--host") ?? "127.0.0.1");
