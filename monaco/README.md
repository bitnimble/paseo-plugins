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
| Port             | `0` picks a free one. Pin it for a remote daemon.                               |
| Public URL       | Origin the app should load instead of `127.0.0.1:<port>`, used verbatim.        |
| Tunnel command   | Runs on the daemon; the first URL it prints becomes the origin. `{port}` is substituted. |

Extensions, settings and keybindings live in the server's own data directory, not in this plugin.
They persist because `openvscode-server` keeps them under `~/.openvscode-server` unless you point
`--server-data-dir` or `--extensions-dir` somewhere else through **Extra arguments**.

## How the app reaches the server

The daemon starts the server with a random connection token and hands the client a URL carrying it.
The browser trades the token for a `vscode-tkn` cookie on the first request and is redirected to the
workbench; a request without it gets a 403.

The app has to reach that port itself. Paseo gives plugins no way to tunnel one over its own
connection, so with a remote daemon you bridge it once, outside the plugin.

### Remote daemon, nothing exposed (recommended)

Pin the port, keep the default `127.0.0.1` bind, leave **Public URL** empty, then forward the same
port from the machine running the Paseo app:

```bash
ssh -N -L 3000:127.0.0.1:3000 you@daemon-host
```

With **Port** set to `3000`, the daemon hands the app `http://127.0.0.1:3000/?tkn=…`, which the
forward resolves. The editor is never on the network, and the token never leaves loopback or the SSH
channel. Make it permanent with a `LocalForward 3000 127.0.0.1:3000` line in `~/.ssh/config`.

This is why **Port** exists: a forward, a proxy rule or a firewall hole cannot target the free port
the daemon would otherwise pick fresh on every start.

### Remote daemon over a private network

On a VPN or tailnet, bind to the interface the app can reach and name that origin:

| Setting      | Value                                  |
| ------------ | -------------------------------------- |
| Port         | `3000`                                 |
| Bind address | the tailnet or VPN address, or `0.0.0.0` |
| Public URL   | `http://daemon.your-tailnet.ts.net:3000` |

### Remote daemon, no network setup

Paseo gives plugins no way to carry a port over its own connection, so the plugin runs a tunnel of
your own instead. Set **Tunnel command** to any program that prints its public URL; `{port}` is
substituted, and the first URL it prints becomes the origin handed to the app.

```text
cloudflared tunnel --url http://127.0.0.1:{port}
```

The tunnel starts with the server and is killed with it, so a fresh URL is minted each session. This
puts the editor, with its terminal and filesystem access, on the public internet behind one
unguessable token. Prefer the SSH forward unless you need reach from anywhere.

**Public URL** overrides a tunnel when both are set.

### Remote daemon behind a reverse proxy

Terminate TLS in front of the pinned port and set **Public URL** to that origin, such as
`https://editor.example.com`. Prefer this if anything but a private network can route to the port.

Anything beyond the loopback default puts a full editor, with terminal and filesystem access, on the
network behind nothing but the connection token, and the token travels in the URL so it reaches proxy
and browser logs. The SSH forward avoids both problems, which is why it is the recommendation.

If the Paseo app is served over HTTPS, framing an `http://` origin can trip mixed-content blocking.
Browsers treat loopback as trustworthy, so the SSH recipe is normally fine; a non-loopback origin
wants real TLS.

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
