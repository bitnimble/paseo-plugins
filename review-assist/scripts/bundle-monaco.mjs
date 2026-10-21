import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const vs = dirname(require.resolve("monaco-editor"));
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "monaco");

const read = (id) => readFileSync(join(vs, "..", `${id}.js`), "utf8");
const dependencies = (id) =>
  [...read(id).matchAll(/"(\.\.?\/[\w.-]+(?:\/[\w.-]+)*)"/g)]
    .map(([, relative]) => posix.join(posix.dirname(id), relative))
    .filter((dependency) => existsSync(join(vs, "..", `${dependency}.js`)));
// `vs/editor` is the bare API; hover, peek and find live in a chunk of the full entry, named by hash.
const features = dependencies("vs/index").find((id) => read(id).includes('"editor.contrib.contentHover"'));
if (features == null) throw new Error("No editor features chunk in the Monaco build");
const ENTRIES = ["vs/editor", features, "vs/basic-languages/monaco.contribution"];

// Dependencies first: the loader fetches any dependency not yet defined by URL, which 404s here.
const modules = new Map();
const visiting = new Set();
const add = (id) => {
  if (modules.has(id) || visiting.has(id)) return;
  visiting.add(id);
  const source = read(id);
  if (!source.startsWith(`define("${id}"`)) throw new Error(`${id} is not a named AMD module`);
  // Static dependencies, plus the lazy `require(["../x"])` that loads each Monarch grammar.
  for (const dependency of dependencies(id)) add(dependency);
  modules.set(id, source);
};
for (const entry of ENTRIES) add(entry);

const worker = readdirSync(join(vs, "assets")).find((name) => /^editor\.worker-.*\.js$/.test(name));
if (worker == null) throw new Error("No editor worker in the Monaco build");

const main = `define("review-assist/monaco", ${JSON.stringify(ENTRIES)}, (api) => api);`;
const outputs = {
  "editor.js.txt": [readFileSync(join(vs, "loader.js"), "utf8"), ...modules.values(), main].join("\n;\n"),
  "editor.css.txt": readFileSync(join(vs, "editor", "editor.main.css"), "utf8"),
  "worker.js.txt": readFileSync(join(vs, "assets", worker), "utf8"),
};
mkdirSync(out, { recursive: true });
for (const [name, text] of Object.entries(outputs)) {
  writeFileSync(join(out, name), text);
  console.log(`${name}: ${(text.length / 1024).toFixed(0)} KiB`);
}
console.log(`${modules.size} modules`);
