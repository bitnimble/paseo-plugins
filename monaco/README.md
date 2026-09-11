# VS Code editor for Paseo

Opens a workspace in a full VS Code (`openvscode-server`) as a workspace tab, with its real
extension host: install extensions from the marketplace, use themes, keymaps and vim, and keep
settings across sessions exactly as you would in desktop VS Code.

One server serves every workspace, each opened as its own `?folder=`. It starts with the first
editor tab and stops when the last one closes.

## Install

Requires Paseo 0.8 or later on the daemon and in the app, and `openvscode-server` on the daemon
machine.

```bash
# On the daemon machine, if you do not already have it:
curl -fL https://github.com/gitpod-io/openvscode-server/releases/latest/download/openvscode-server-v1.109.5-linux-x64.tar.gz \
  | tar -xz -C /opt
ln -s /opt/openvscode-server-v1.109.5-linux-x64/bin/openvscode-server /usr/local/bin/openvscode-server

npm install
npm run check
paseo plugin install /absolute/path/to/monaco
```

Open a workspace and pick **Open editor** from the Command Center. Point **Command** at an absolute
path in settings if the binary is not on the daemon's `PATH`.

## Settings

**Settings → Plugins → Editor.** Host-scoped: stored by the daemon, shared by every client
connected to it, surviving restarts and reloads. Changes apply the next time the server starts,
which is after the last editor tab closes.

| Setting          | Effect                                                                          |
| ---------------- | ------------------------------------------------------------------------------- |
| Command          | The `openvscode-server` executable. A bare name is resolved on the daemon's `PATH`. |
| Extra arguments  | Appended after `--host`, `--port` and `--connection-token`, e.g. `--extensions-dir`. |
| Bind address     | `127.0.0.1` by default, keeping the server off the network.                     |
| Public URL       | Origin the app should load instead of `127.0.0.1:<port>`.                       |

Extensions, settings and keybindings live in the server's own data directory, not in this plugin.
They persist because `openvscode-server` keeps them under `~/.openvscode-server` unless you point
`--server-data-dir` or `--extensions-dir` somewhere else through **Extra arguments**.

## How the app reaches the server

The daemon starts the server on a free loopback port with a random connection token, and hands the
client a URL carrying that token. The browser trades the token for a `vscode-tkn` cookie on the
first request and is redirected to the workbench; a request without it gets a 403.

**This requires the app to reach that port.** It does when the app and the daemon are on one
machine, which covers the desktop app against a local daemon. When the daemon is remote, loopback is
not reachable from the app: expose the server yourself (a reverse proxy, an SSH tunnel, a VPN) and
put that origin in **Public URL**. Paseo offers plugins no way to tunnel a port over its own
connection, so there is no way to do this from inside the plugin.

Widening **Bind address** beyond `127.0.0.1` puts a full editor, with terminal and filesystem
access, on the network behind nothing but the connection token. Only do it on a trusted network,
and prefer a tunnel.

## Limits

- Web and desktop only, and not because VS Code cannot run on a phone. A Paseo plugin has no way to
  reach a web view: React Native dropped `WebView` from core in 0.60, `react-native-webview` is not
  on the plugin client allowlist, and the SDK exports no replacement. The panel shows a message on
  iOS and Android. A WebView primitive in `@getpaseo/plugin/client/react-native` would change that.
- The app's content security policy must allow framing the server's origin.
- Extensions are shared across workspaces, since one server serves all of them.

## Tests

`npm run check` runs the typecheck and the tests. The tests that drive a real server are skipped
unless one is available:

```bash
OPENVSCODE_SERVER=/opt/openvscode-server-v1.109.5-linux-x64/bin/openvscode-server npm run check
```
