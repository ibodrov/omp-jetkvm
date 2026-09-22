# omp-jetkvm

An [oh-my-pi](https://github.com/oh-my-pi) extension that lets agents drive a **remote JetKVM** device the way the `browser` tool drives a browser: see the host screen, move the mouse, type, manage virtual media, and switch ATX power — all over the JetKVM local network API.

Pure TypeScript. No native addons, no vendored firmware code (Apache-2.0; see NOTICE).

```
agent ──omp tools──▶ omp-jetkvm (in-process, Bun)
                        ├── HTTP / WebSocket ──▶ JetKVM (auth, upload, signaling)
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
| `jetkvm_storage` | per action | reads are `read`, mount/upload mutations are `write`, and deletion is `exec`. |
| `jetkvm_device` | per action | status/state reads are `read`, configuration writes are `write`, and power/wake/USB changes are `exec` plus policy gates. |

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

- **browser** (default): a bundled page in headless Chromium decodes the H.264 High-profile stream via libwebrtc. Device login and HTTP/WebSocket signaling happen in the extension process; the page only renders and returns pixels. Chromium stays warm, but each capture resets the page and negotiates a fresh video peer so cached frames cannot hide recent input. Requires a Chromium with proprietary codecs (`/usr/bin/chromium` works on Arch). Launched with `--disable-features=WebRtcHideLocalIpsWithMdns` — the device cannot resolve mDNS-obfuscated ICE candidates.
- **recorder**: shells out to [`recorder-for-jetkvm --screenshot`](https://github.com/ibodrov/jetkvm-recorder) when installed. One-shot PNG; the model copy is not downscaled (no decoder in this path).

## Concurrency & safety
- One input transaction at a time per device (in-process mutex, holder reported on contention).
- Manual holds (keyboard `down`/`hold_keys`, mouse `down`) park the input mutex until `up`/`release_all`; a dropped connection drains them so the lock never sticks.
- Cross-process claim (abstract socket on Linux) so two omp sessions on one machine don't both drive HID; stale sidecars are reclaimed automatically, a live Linux kernel claim cannot be force-stolen, and `concurrency.crossProcess: none` disables claiming.
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

## Runtime resilience and known issues

- Firmware **0.5.8** uses HTTP signaling. When `/webrtc/session` returns 404 (observed on **0.5.9**), both control and screenshot connections use the authenticated `/webrtc/signaling/client` WebSocket, including remote ICE candidates. A protected HTTP probe refreshes expired authentication before the WebSocket upgrade; signaling waits are bounded.
- Captures negotiate a fresh peer in a warm Chromium process. Frame age alone is insufficient: firmware can leave a recently decoded but obsolete screen after another control session connects. The read-only input baseline may reconnect before taking the process claim; HID reports are never replayed.
- On an AMI Aptio host with firmware **0.5.9**, mounted recovery media was absent from the firmware boot menu despite USB mass storage being enabled. After disabling JetKVM's USB audio interface and rebooting, the same Alpine image booted. Treat this as a host compatibility workaround, not a reason to change USB interfaces automatically.
- Video state events and RPC replies are complete snapshots, not patches. A recovered signal omits `error`; replacing the cached state clears the previous `no_signal` instead of reporting a healthy stream with a stale fault.

- `werift@0.24.4` creates ICE `node:dgram` sockets without an `error`
  listener. When a JetKVM reboots, Linux/Bun can deliver the resulting ICMP
  port rejection as a stackless `ECONNREFUSED: connection refused, recv`;
  EventEmitter otherwise promotes it to an uncaught exception and omp exits.
  `patchedDependencies` applies `patches/werift@0.24.4.patch` to both werift
  entry builds. The socket error is now contained; the existing RPC keepalive
  tears down the dead session and a later idempotent call can reconnect.
  `test/connection-resilience.test.ts` reproduces the remote-port loss in a
  child process.
- This repo's `bunfig.toml` still preloads
  `scripts/filter-transient-socket.ts` as defense in depth for identical
  stackless errors from non-werift Bun sockets. It only affects omp started
  from this directory; the installed extension's fix does not depend on it.
- Connection teardown clears cached video dimensions, and reconnect/dispose invalidate in-flight peers so old coordinates or sessions cannot be republished.
- Input cleanup attempts keyboard and mouse releases independently. URL mounting propagates cancellation through preflight, slot clearing, and mounting; only the known `checkMountUrl` device error `-32603` is advisory.
- `allowPowerActions: false` blocks Wake-on-LAN as well as ATX writes. ATX status is reported as a sensor reading, not proof that an unwired host is off.

## omp loader note (omp ≥ 18: literal imports + dependency patches)

omp 18 embeds Bun 1.4.0 in its compiled binary, where bare `node_modules`
resolution from runtime-loaded extension modules is broken
(`Cannot find package 'yaml' …`; `createRequire().resolve` fails the same
way). The only supported path is omp's own pre-walk: the loader rewrites
every literal specifier in the entry's import graph to absolute paths and
bridges transitive CommonJS through its graph bridge. `src/index.ts` therefore
uses plain static imports — do NOT convert them to runtime-built specifiers
(the pre-omp-18 trick; native resolution that relied on is gone).

Four dependency patches make the walked graph bridge-safe; dropping any of
them resurfaces a load failure:

- `tslib@2.8.1` — its ESM shim `modules/index.js` default-imports the CJS
  `tslib.js`; served forced-ESM that import has no default. The patch
  re-exports the pure-ESM `tslib.es6.mjs` build instead.
- `tsyringe@4.10.0` — manifest `module`/`es2015` fields removed so omp
  resolves the CJS build through the bridge (its `tslib_1.__exportStar`
  re-exports are invisible to the bridge's static export analysis, which
  only matches a bare `__exportStar` callee).
- `@peculiar/x509@1.14.3` — manifest `module` field removed for the same
  reason (keeps the werift crypto stack on the CJS/bridge path).
- `@shinyoshiaki/binary-data@0.6.1` — the package ships its internals as a
  nested `src/node_modules/{lib,types,internal}` tree addressed by bare
  specifiers (`require('lib/binary-stream')`) that omp cannot pre-rewrite;
  at eval time those fall through to the native loader, which returns ESM
  wrappers for graph-owned modules (breaks `generate-function`). The patch
  relativizes every intra-package specifier. NOTE: `bun patch` strips the
  nested tree at checkout — the committed patch re-adds it; if you ever
  regenerate this patch, copy `src/node_modules/` back from the bun cache
  before `bun patch --commit`.

`package.json` also pins `"resolutions": { "tslib": "2.8.1" }` so tsyringe's
`tslib@^1` nested copy dedupes onto the patched top-level install.

## Development

```sh
bun install
bunx tsc --noEmit     # typecheck
bun test              # unit + fake-device (werift) integration — no hardware needed
JETKVM_HOST=… JETKVM_PASSWORD_FILE=… bun scripts/smoke.ts all   # live device
```

- `test/helpers/fake-device.ts` — werift server-side peer implementing the `rpc` contract; the firmware-drift canary.
- `scripts/fake-pi.ts` — drive any tool directly from the CLI without an omp session; tool errors exit nonzero.
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
