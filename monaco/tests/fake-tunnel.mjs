#!/usr/bin/env node
// Stands in for cloudflared: announces a public URL on stderr, then stays up like a real tunnel.
const target = process.argv[2] ?? "";
process.stderr.write(`+---------------------+\n`);
process.stderr.write(`|  https://fake-tunnel.example.com  (-> ${target})\n`);
process.stderr.write(`+---------------------+\n`);
setInterval(() => {}, 1 << 30);
