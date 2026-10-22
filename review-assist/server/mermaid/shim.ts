import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SvgElement, config, createHTMLWindow } from "svgdom";
import font from "../../node_modules/svgdom/fonts/OpenSans-Regular.ttf";

export const FONT_FAMILY = "Open Sans";
export const FONT_SIZE = 16;
const FONT_FILE = "OpenSans-Regular.ttf";
const WINDOW_GLOBALS = ["Error", "Math", "Date", "Array", "Object", "JSON", "Promise", "setTimeout", "clearTimeout"];
const POSITIONS = new Set(["x", "y", "dx", "dy"]);
const ELEMENT_NODE = 1;
const ANCHOR_SHIFTS: Readonly<Record<string, number>> = { start: 0, middle: 0.5, end: 1 };

// svgdom only measures text with fonts it reads from disk.
const fontDir = join(tmpdir(), "review-assist-fonts");
mkdirSync(fontDir, { recursive: true });
writeFileSync(join(fontDir, FONT_FILE), font);
config.setFontDir(fontDir).setFontFamilyMappings({ "sans-serif": FONT_FILE, [FONT_FAMILY]: FONT_FILE }).preloadFonts();

const window = createHTMLWindow();
for (const key of WINDOW_GLOBALS) window[key] ??= Reflect.get(globalThis, key);
// DOMPurify parses through svgdom's strict XML `innerHTML`, which throws on `<br>`, and returns "" for
// every label with markup in it. Without this it finds no HTML support and passes labels through;
// they're drawn as SVG text, so nothing in them runs.
Object.defineProperty(window.document, "implementation", { value: {} });
const { setAttribute } = window.Element.prototype;
window.Element.prototype.setAttribute = function (name: string, value: string) {
  // svgdom reads `1.1em` as 1.1px, which offsets every label from the box measured for it.
  const em = POSITIONS.has(name) ? /^(-?[\d.]+)em$/.exec(String(value)) : null;
  setAttribute.call(this, name, em == null ? value : String(Number(em[1]) * FONT_SIZE));
};
// svgdom anchors only a text's first word, as mermaid writes a tspan per word: measure every text
// from its start, then anchor the whole line, also where a group's box takes in its texts.
let measuring = false;
const { getAttribute } = window.Element.prototype;
window.Element.prototype.getAttribute = function (name: string) {
  if (!measuring) return getAttribute.call(this, name);
  if (name === "text-anchor") return null;
  if (name === "transform" && this.nodeName === "text") {
    const own = getAttribute.call(this, name);
    const shift = anchorShift(this);
    return shift === 0 ? own : `${own ?? ""} translate(${-shift}, 0)`;
  }
  return getAttribute.call(this, name);
};
const { getBBox } = window.SVGGraphicsElement.prototype;
window.SVGGraphicsElement.prototype.getBBox = function () {
  if (measuring) return getBBox.call(this);
  measuring = true;
  try {
    // A browser's SVGRect has no `left` or `top`, which mermaid reads as 0; svgdom's box has them.
    const { x, y, width, height } = getBBox.call(this);
    return { x: this.nodeName === "text" ? x - anchorShift(this) : x, y, width, height };
  } finally {
    measuring = false;
  }
};
Object.assign(globalThis, {
  window,
  document: window.document,
  CSSStyleSheet: class {
    readonly cssRules: { cssText: string }[] = [];
    insertRule(rule: string, index = this.cssRules.length): number {
      this.cssRules.splice(index, 0, { cssText: rule });
      return index;
    }
  },
});

/** How far the text's anchor moves it left of where it starts; call while measuring. */
function anchorShift(text: SvgElement): number {
  const shift = ANCHOR_SHIFTS[anchorOf(text)] ?? 0;
  return shift === 0 ? 0 : getBBox.call(text).width * shift;
}

function anchorOf(text: SvgElement): string {
  const line = text.querySelector("tspan");
  const set = getAttribute.call(text, "text-anchor") ?? (line == null ? null : getAttribute.call(line, "text-anchor"));
  // Mermaid's flowchart stylesheet centres node labels (`.node .label text`), and svgdom has no CSS.
  return set ?? (inFlowchartNodeLabel(text) ? "middle" : "start");
}

function inFlowchartNodeLabel(text: SvgElement): boolean {
  let label = false;
  for (let parent = text.parentNode; parent != null && parent.nodeType === ELEMENT_NODE; parent = parent.parentNode) {
    const classes = (getAttribute.call(parent, "class") ?? "").split(/\s+/);
    if (classes.includes("label")) label = true;
    else if (label && (classes.includes("node") || classes.includes("rough-node"))) {
      return !(getAttribute.call(parent, "id") ?? "").includes("-classId-");
    }
  }
  return false;
}

export { font };
export const { document } = window;
