import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface FrameElement {
  src: string;
  title: string;
  allow: string;
  style: { border: string; width: string; height: string; display: string };
}

/** The DOM node React Native Web renders for the panel's container `View`. */
export interface EditorContainer {
  readonly nodeType: number;
  appendChild(child: FrameElement): void;
  removeChild(child: FrameElement): void;
}

declare const document: {
  createElement(tagName: "iframe"): FrameElement;
};

export function isEditorSupported(): boolean {
  return Platform.OS === "web";
}

export function asEditorContainer(node: object): EditorContainer {
  return node as unknown as EditorContainer;
}

/** Returns a remover; the caller owns it for the life of the mounted frame. */
export function mountEditorFrame(container: EditorContainer, url: string): () => void {
  const frame = document.createElement("iframe");
  frame.src = url;
  frame.title = "Editor";
  // The editor needs the clipboard to serve copy and paste inside the frame.
  frame.allow = "clipboard-read; clipboard-write";
  frame.style.border = "none";
  frame.style.width = "100%";
  frame.style.height = "100%";
  frame.style.display = "block";
  container.appendChild(frame);

  let mounted = true;
  return () => {
    if (!mounted) {
      return;
    }
    mounted = false;
    container.removeChild(frame);
  };
}
