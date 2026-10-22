// esbuild's binary loader, in `npm run build-mermaid`.
declare module "*.ttf" {
  const bytes: Uint8Array;
  export default bytes;
}

declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}

declare module "svgdom" {
  interface FontConfig {
    setFontDir(directory: string): FontConfig;
    setFontFamilyMappings(mappings: Record<string, string>): FontConfig;
    preloadFonts(): FontConfig;
  }

  export interface SvgBox {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }

  export interface SvgElement {
    readonly nodeName: string;
    readonly nodeType: number;
    readonly parentNode: SvgElement | null;
    readonly textContent: string | null;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    querySelector(selectors: string): SvgElement | null;
    querySelectorAll(selectors: string): Iterable<SvgElement>;
    cloneNode(deep: boolean): SvgElement;
    appendChild(child: SvgElement): void;
    removeChild(child: SvgElement): void;
    /** In the element's own coordinates, before its `transform`. */
    getBBox(): SvgBox;
  }

  export interface HostElement extends SvgElement {
    innerHTML: string;
    readonly firstChild: SvgElement | null;
  }

  export interface SvgDocument {
    createElement(name: string): HostElement;
    createElementNS(namespace: string, name: string): SvgElement;
  }

  export interface SvgWindow {
    [key: string]: unknown;
    readonly document: SvgDocument;
    readonly Element: {
      prototype: {
        setAttribute(this: SvgElement, name: string, value: string): void;
        getAttribute(this: SvgElement, name: string): string | null;
      };
    };
    readonly SVGGraphicsElement: { prototype: { getBBox(this: SvgElement): SvgBox } };
  }

  export const config: FontConfig;
  export function createHTMLWindow(): SvgWindow;
}
