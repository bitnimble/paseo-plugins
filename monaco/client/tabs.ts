import { useSyncExternalStore } from "react";

export interface WorkspaceTabs {
  readonly paths: readonly string[];
  readonly activePath: string | null;
}

const EMPTY: WorkspaceTabs = { paths: [], activePath: null };

class EditorTabStore {
  private readonly byWorkspace = new Map<string, WorkspaceTabs>();
  private readonly listeners = new Set<() => void>();

  get = (workspaceId: string): WorkspaceTabs => this.byWorkspace.get(workspaceId) ?? EMPTY;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  open = (workspaceId: string, path: string): void => {
    const tabs = this.get(workspaceId);
    const paths = tabs.paths.includes(path) ? tabs.paths : [...tabs.paths, path];
    this.set(workspaceId, { paths, activePath: path });
  };

  activate = (workspaceId: string, path: string): void => {
    this.set(workspaceId, { ...this.get(workspaceId), activePath: path });
  };

  close = (workspaceId: string, path: string): void => {
    const tabs = this.get(workspaceId);
    const paths = tabs.paths.filter((open) => open !== path);
    const activePath = tabs.activePath === path ? (paths[paths.length - 1] ?? null) : tabs.activePath;
    this.set(workspaceId, { paths, activePath });
  };

  private set(workspaceId: string, tabs: WorkspaceTabs): void {
    this.byWorkspace.set(workspaceId, tabs);
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const editorTabs = new EditorTabStore();

export function useEditorTabs(workspaceId: string): WorkspaceTabs {
  return useSyncExternalStore(editorTabs.subscribe, () => editorTabs.get(workspaceId));
}
