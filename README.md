# omp-jetkvm

An [oh-my-pi](https://github.com/oh-my-pi) extension that lets agents drive a **remote JetKVM** device the way the `browser` tool drives a browser: see the host screen, move the mouse, type, manage virtual media, and switch ATX power — all over the JetKVM local network API.

Pure TypeScript. No native addons, no vendored firmware code (Apache-2.0; see NOTICE).

```
agent ──omp tools──▶ omp-jetkvm (in-process, Bun)
                        ├── HTTP  ──▶ JetKVM (auth, upload, signaling)
                        └── WebRTC (werift) ──▶ JetKVM
                              ├── `rpc` data channel — JSON-RPC 2.0
                              │    input · storage · device · power
                              └── H.264 video track — screenshots
```

## Tools

| Tool | Approval | What it does |
|---|---|---|
| `jetkvm_screenshot` | read | Capture the host screen (model-sized inline image + full-res file). `state` for cheap liveness. |
| `jetkvm_mouse` | write | move / click / double_click / right_click / drag / scroll / down / up — screenshot pixel coordinates. `down` holds the button until `up` / `release_all` (like keyboard holds). |
| `jetkvm_keyboard` | write | type (US layout; validated before typing — unmappable chars fail without a partial prefix, `\r\n` types one enter) / press chords (`ctrl+alt+t`, `win+r`, `right-ctrl`) / hold_keys / release_all. |
| `jetkvm_storage` | write | list/delete device files, space, mount ISO by URL, serve a local file, upload+mount, unmount. |
| `jetkvm_device` | read* | status, video state, ATX power ops, Wake-on-LAN, USB emulation, keyboard layout. *power ops are policy-gated. |

Slash command: `/jetkvm` (status card), `/jetkvm reconnect`.

## Configuration

`~/.omp/agent/config.yml` (user) or `.omp/config.yml` (project):

```yaml
jetkvm:
  devices:
    default:
      host: 192.168.1.100        # IP, hostname, or jetkvm-<id>.local
      passwordFile: ~/.config/jetkvm/pwd
  screenshot:
    engine: auto                 # auto | browser | recorder
    recorderPath: ""             # explicit recorder-for-jetkvm binary
    chromiumPath: ""             # override Chromium resolution
    maxModelWidth: 1024
  policy:
    allowPowerActions: true
    allowUsbDisconnect: false
    forceUnmountOnMount: true
```

Full schema and design rationale: `DESIGN.md`.

## Screenshot engines

- **browser** (default): a bundled page in headless Chromium decodes the H.264 High-profile stream via libwebrtc. All device HTTP (login + SDP exchange) happens in the extension process; the page only renders and returns pixels. Requires a Chromium with proprietary codecs (`/usr/bin/chromium` works on Arch). Launched with `--disable-features=WebRtcHideLocalIpsWithMdns` — the device cannot resolve mDNS-obfuscated ICE candidates.
- **recorder**: shells out to [`recorder-for-jetkvm --screenshot`](https://github.com/ibodrov/jetkvm-recorder) when installed. One-shot PNG; the model copy is not downscaled (no decoder in this path).

## Concurrency & safety
- One input transaction at a time per device (in-process mutex, holder reported on contention).
- Manual holds (keyboard `down`/`hold_keys`, mouse `down`) park the input mutex until `up`/`release_all`; a dropped connection drains them so the lock never sticks.
- Cross-process claim (abstract-socket on Linux) so two omp sessions on one machine don't both drive HID; `force: true` overrides a stale claim, `concurrency.crossProcess: none` disables.
- Input never auto-retries across reconnects (replay danger). Any abort/error mid-transaction releases all held keys/buttons. Reconnect backoff happens before the input mutex is taken, so a down device never starves other callers into `InputBusy`.
- Connections (including the browser screenshot engine) share one auth session per device — the device rotates its single token on every login, so parallel logins would invalidate each other.
- The device has no input interlock: a human at the local UI (or another machine) can inject concurrently; the tools surface "foreign input suspected" warnings when detectable.

### serve_and_mount networking

The local HTTP server binds and advertises the kernel's source address for
the route to the device (the interface that actually faces it — correct on
multi-homed hosts, VPN-routed devices, and loopback test setups). It is not
device-authenticated: other hosts on that subnet can read the served image
while the mount is active. Use `upload_and_mount` for sensitive media, or
scope exposure with firewall rules.

A new `serve_and_mount` (and session shutdown) unmounts the previously
served media first while its server is still alive — stopping a server
under an active mount wedges the device's storage handler (see firmware
quirks below). Policy `forceUnmountOnMount: false` refuses instead and
leaves the old server running.

## Firmware quirks observed (0.5.8)

- `checkMountUrl` probes the URL but always answers `-32603`; treated as advisory, `mountWithHTTP` is the real gate.
- CDROM-mode mounts of images smaller than ~1 MiB fail with `-32603`; use ≥ 4 MiB images.
- If the `serve_and_mount` HTTP server dies while media is mounted, the device's storage handler wedges (RPC `ping` still answers; storage calls block). Recovery: restart a server on the same port and unmount, or reboot the device (`reboot` RPC). Keep the session alive for the whole install.
- The device answers without ICE candidates and dials the offerer's candidates; Chromium's mDNS candidates are unusable (see engine flag above).
- ATX/DC state sensing reads unwired hardware as "off" even while the host runs; power-control RPCs succeed but drive nothing on hosts without the harness wired (this deployment).

## Known issues in this environment

- omp sessions that mix `jetkvm_screenshot` with input tools occasionally die
  (interactive: exit 2 + "Operation aborted"; print: exit 1 + "[Uncaught
  Exception]") on a stackless `ECONNREFUSED: connection refused, recv` — a
  transient native-socket error from host-process IO pools, which omp's
  postmortem treats as fatal. The tool calls themselves succeed; `omp --resume`
  continues cleanly. Mitigation shipped: this repo's `bunfig.toml` preloads
  `scripts/filter-transient-socket.ts`, which swallows exactly that error
  shape (no stack) before omp's fatal handler — it applies to any omp run
  started from this directory. Fixing the overreaction belongs upstream.
- The browser engine rebuilds its video session when the last decoded frame
  is older than 5 s (the device encoder only emits on screen change and can
  stall long-lived sessions; fresh sessions get an immediate IDR).

## omp loader note (why src/index.ts looks odd)

omp's extension loader pre-walks every literal import specifier in the entry
source — static, dynamic, and type-only — and re-serves that graph through
Bun onLoad hooks that force ESM, which breaks node_modules CommonJS without
interop defaults (tslib, via werift's crypto deps). The entry therefore
imports its modules with runtime-built specifiers, keeping the walked graph
empty. Do not "simplify" them back to literals.

## Development

```sh
bun install
bunx tsc --noEmit     # typecheck
bun test              # unit + fake-device (werift) integration — no hardware needed
JETKVM_HOST=… JETKVM_PASSWORD_FILE=… bun scripts/smoke.ts all   # live device
```

- `test/helpers/fake-device.ts` — werift server-side peer implementing the `rpc` contract; the firmware-drift canary.
- `scripts/fake-pi.ts` — drive any tool directly from the CLI without an omp session.
- `scripts/check-control-plane.ts` — connection/auth/RPC sanity.

## Install (omp plugin)

```sh
omp plugin link ./omp-jetkvm          # dev: symlink into the session
# or release path:
omp plugin marketplace add <owner>/omp-jetkvm
omp plugin install jetkvm@omp-jetkvm
```

Then restart the omp session; tools appear when the `jetkvm:` config key exists.

## AI Note

This codebase is 100% AI-coded.

## License

Apache-2.0. This is an independent interoperability implementation of the JetKVM local API; it contains no JetKVM code (upstream firmware/UI are GPL-2.0) — see NOTICE.
