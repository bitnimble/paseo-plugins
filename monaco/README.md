# Monaco editor for Paseo

Opens workspace files in the VS Code editor (Monaco) as a workspace tab, backed by real language
servers running on the daemon.

- Syntax highlighting for every language Monaco ships a grammar for.
- Cmd/Ctrl+click to definition, find references (peek), hover, and completions through LSP.
- Cmd/Ctrl+S saves to disk and notifies the language server.
- One language server per language per workspace, shared by every editor tab in that workspace and
  stopped when the last one closes.

## Install

Requires Paseo 0.8 or later on the daemon and in the app.

```bash
npm install
npm run check
paseo plugin install /absolute/path/to/monaco
```

Open a workspace and pick **Open editor** from the Command Center, or run `/edit src/app.ts` in the
composer.

## Settings

**Settings → Plugins → Monaco → Editor.** Values are host-scoped: stored by the daemon, shared by
every client connected to it, and they survive restarts, reloads and updates. Removing the plugin
deletes them.

| Setting                  | Effect                                                                    |
| ------------------------ | ------------------------------------------------------------------------- |
| Font size, tab size      | Applied live to open editors.                                             |
| Word wrap, minimap, line numbers | Applied live to open editors.                                     |
| Language servers         | Full command line per server, overriding the table below.                 |
| Monaco base URL          | Point at a self-hosted copy when the CDN is unreachable.                  |

Paseo only exposes settings to client code, so the panel carries the language-server overrides to
the daemon on its lease. A changed command reaches the daemon within 30 seconds, and applies to the
next server it starts, not one already running for that workspace. The Monaco base URL applies when
the app next loads Monaco, since it installs itself on the page once.

## Language servers

The plugin spawns whichever of these is on the daemon's `PATH`; a file with no matching server still
gets syntax highlighting.

| Languages          | Command                              |
| ------------------ | ------------------------------------ |
| TypeScript, JavaScript | `typescript-language-server --stdio` |
| Python             | `pyright-langserver --stdio`         |
| Go                 | `gopls`                              |
| Rust               | `rust-analyzer`                      |
| C, C++             | `clangd`                             |

Add a language by extending `shared/languages.ts` and `server/servers.ts`.

## Lifecycle

Each open panel holds a lease on its workspace, refreshed every 30 seconds. Closing the panel
releases it; a client that disconnects without releasing loses its lease after 90 seconds. When a
workspace has no leases left, its language servers are shut down and its cached directory is
dropped.

## Limits

- Web and desktop only, and not because Monaco cannot run on a phone: it runs fine inside a web
  view. A Paseo plugin has no way to reach one. React Native dropped `WebView` from core in 0.60,
  `react-native-webview` is not on the plugin client allowlist, and the SDK exports no replacement,
  so DOM access stops at React Native Web. The panel shows a message on iOS and Android. A WebView
  primitive in `@getpaseo/plugin/client/react-native` is what would change that.
- Monaco loads from `cdn.jsdelivr.net` at first use; the panel reports a load failure if the app's
  network or CSP blocks it.
- No diagnostics. Plugin RPC is request/response, so nothing carries server-pushed publishes to the
  client.
- Document changes reach the server as whole-document replacements, debounced 250ms.
- Jumping to a definition outside the workspace (a dependency's `.d.ts`, a toolchain source) opens
  it read-only in practice: the daemon reads any absolute path the language server points at, but
  only writes back inside the workspace.
