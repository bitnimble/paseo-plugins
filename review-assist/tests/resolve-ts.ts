import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Plugin sources import siblings without extensions, as the plugin bundler expects.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromDependency = context.parentURL?.includes("/node_modules/") === true;
    if (fromDependency || !specifier.startsWith(".") || /\.([cm]?[jt]sx?|txt)$/.test(specifier)) {
      return nextResolve(specifier, context);
    }
    return nextResolve(`${specifier}.ts`, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".txt")) return nextLoad(url, context);
    const text = readFileSync(fileURLToPath(url), "utf8");
    return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  },
});
