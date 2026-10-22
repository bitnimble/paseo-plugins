import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [join(root, "server", "mermaid", "worker.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  minify: true,
  loader: { ".ttf": "binary", ".wasm": "binary" },
  // svgdom finds its bundled fonts from its own URL; the worker runs from a string and has none.
  define: { "import.meta.url": JSON.stringify("file:///review-assist/mermaid-worker.js") },
  write: false,
  logLevel: "warning",
});
const out = join(root, "server", "mermaid", "worker.js.txt");
writeFileSync(out, result.outputFiles[0].text);
console.log(`worker.js.txt: ${(result.outputFiles[0].text.length / 1024 / 1024).toFixed(1)} MiB`);
