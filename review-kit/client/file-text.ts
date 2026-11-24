export type FileText =
  | { readonly status: "loading" }
  /** `previous` while the file's last text stands in for its new one. */
  | { readonly status: "ready"; readonly text: string; readonly previous: boolean }
  | { readonly status: "failed"; readonly error: string };
