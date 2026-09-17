# Multi-Protocol VPN Systems: Open-Source Landscape, Server Architecture & Custom-Protocol Design

**A research report for building an all-in-one VPN client + combo server + reseller panel, and eventually a custom protocol.**

- Date: 2026-09-16
- Scope: open-source Android clients & cores, injector/payload free-net mechanics, every major transport (OpenVPN, Xray/V2Ray, QUIC/Hysteria2/TUIC, DNS & UDP tunnels, SSH family), multi-protocol combo servers, speed/stability tuning, reseller panels & subscription APIs, the Vollam-style app-generator ecosystem, auth & traffic accounting, and a blueprint for your own client+server protocol.
- Method: 13 parallel deep-research agents (web search + repository fetch) plus an editor synthesis pass. Only repositories/URLs the agents actually retrieved are cited; where little open source exists, the report says so.

> **One-line orientation:** almost the entire ecosystem reduces to three Go cores (**sing-box**, **Xray-core**, **mihomo/Clash.Meta**) wrapped in an Android `VpnService`, with a **payload/SNI free-net layer** bolted on top and a **reseller panel + JSON/subscription API** behind it. Build on those, don't reinvent them.

---

## 1. Executive summary

You are not building a VPN. You are assembling a **camouflage-and-billing business** on top of a handful of mature open-source cores, and the single most important finding of this report is that **roughly 80% of what you need already exists and is battle-tested** — the durable engineering value, and the only defensible part of your product, lives in two thin layers you must own yourself: a **carrier-specific payload/bug-host front** and a **per-user auth + metering control plane**. Everything between those two layers is a solved problem you should reuse, not rewrite.

Three Go cores dominate the entire landscape and every credible client, server, and panel is a shell over one of them: **Xray-core** (XTLS: VLESS, XTLS-Vision, REALITY, XHTTP — the strongest anti-DPI stack), **sing-box** (SagerNet: the best universal client+server, native Hysteria2/TUIC/REALITY, cleanest white-label template via Hiddify), and **mihomo/Clash.Meta** (rule-based routing). On the transport side the decisive shift is **away from TCP-in-TCP tunnels toward UDP/QUIC**: Hysteria2 and TUIC eliminate the TCP-over-TCP meltdown that silently caps every SSH/OpenVPN-TCP/stunnel stack on lossy mobile towers, and Hysteria2 additionally ships exactly the HTTP auth backend (`POST {addr,auth,tx}→{ok,id}`) and traffic-stats API (`/traffic`, `/online`, `/kick`) that make it panel-ready out of the box.

**The concrete recommendation:** standardize your own branded protocol on **VLESS + XTLS-Vision + REALITY** for fast direct links, add a **VLESS + XHTTP-over-Cloudflare** profile for IP-hiding and payload/free-net delivery, add **Hysteria2** as the primary transport for lossy/throttled carrier networks, and keep **OpenVPN-UDP + SSH/Dropbear + SlowDNS(dnstt)** as compatibility/last-resort fallbacks in the same combo box. Ship a **sing-box or Xray-core engine inside a Flutter/Kotlin client** (Hiddify-App is your closest legal white-label template; v2rayNG/NekoBox are the Android-only references), and drive it from a **hot-updatable JSON config** the app pulls at runtime — this is precisely the closed-source "Vollam Gen" pattern, and it is trivial to reproduce openly.

For the money and management layer, **no maintained Xray panel ships a native reseller credit wallet.** Your fastest path is to adopt **3x-ui** (single-box) or **Marzban/Marzneshin/PasarGuard + node** (multi-node scale-out), meter traffic through **Xray's gRPC StatsService** (keyed by client email) and **Hysteria2's stats API**, and bolt a **thin credit/reseller wallet + subscription-token API** on top — the one component with no turnkey OSS equivalent, and therefore the second thing (after the payload layer) worth your own engineering. Hiddify Manager's Super-admin/Admin/Agent tiers come closest to the reseller shape natively and are the best starting point if you want to build less.

**Bottom line for your stated end-goal — a branded client+server protocol:** do not greenfield a QUIC or TLS stack. Fork/bridge Xray-core and sing-box, which already give you REALITY, XHTTP up/down splitting, sing-mux, AnyTLS, and TCP-Brutal for free. Spend your scarce engineering exclusively on (a) **bug-host rotation tooling** for the perishable payload front and (b) a **light HMAC per-user auth layer** for reseller billing. The strategic risk to internalize now is that **SNI/Host-based zero-rating tricks are carrier-dependent and perishable** — they get patched in days and will erode further as ECH and SNI-mismatch detection spread — so your architecture must treat the payload layer as a swappable, rapidly-rotated module (borrow the SIP003 plugin contract and obfs4's anti-probing ideas), never as a fixed protocol feature.

---

## 2. Landscape map & how to read this report

This report anatomizes a single, coherent ecosystem — the multi-protocol "free-net"/anti-DPI VPN reseller stack popular across South Asia and the Gulf — and it is best read through a **four-layer mental model**. Every product, script, and protocol in sections 3–15 slots into exactly one of these layers, and most of the confusion in this space comes from vendors (and search-engine hallucinations) blurring them together.

**The four layers:**

- **Client layer** — the phone/desktop app the customer installs. In OSS this is always a thin Kotlin/Java/Flutter shell around one of three Go cores (sing-box, Xray-core, mihomo) bridged to the OS via a userspace TUN + tun2socks. Sections 3 and 13 cover this.
- **Transport / camouflage layer** — the wire protocol and its disguise: what the carrier's DPI and billing engine actually see. This is where the real diversity lives — payload injection, OpenVPN wrappers, VLESS/REALITY/XHTTP, QUIC (Hysteria2/TUIC), DNS tunnels, SSH-over-everything. Sections 4–9 cover this, and section 11 covers making it fast.
- **Server layer** — the multi-inbound "combo box" on the VPS that terminates all those transports on one IP, usually sharing port 443 via SNI/ALPN fallbacks. Section 10 covers this.
- **Control-plane / panel layer** — auth, per-user traffic metering, quota/expiry enforcement, subscription delivery, and the reseller credit wallet. This is the least-solved layer in OSS and the one you must partly build. Sections 12, 14, and 15 cover this.

A useful rule while reading: **the transport layer is a swappable disguise around an unchanged core.** OpenVPN doesn't change when you wrap it in stunnel, a WebSocket, or SSH; SSH-over-WS, SSH-SSL, SlowDNS, and HTTP-Custom are all the same `ssh -D` SOCKS core behind different camouflage; VLESS delegates all its crypto to the TLS/REALITY layer beneath it. Once you see that the "many protocols" a reseller advertises are mostly **one backend behind many front doors on 127.0.0.1**, the whole ecosystem simplifies.

**How the sections map (table of contents, sections 3–15):**

| # | Section | Layer | Read it for |
|---|---------|-------|-------------|
| 3 | Android all-in-one VPN clients | Client | The three Go cores, VpnService/TUN mechanics, white-label templates (Hiddify, NekoBox, v2rayNG) |
| 4 | Injector payload mechanics | Transport | CRLF/Host-spoofing + SNI "bug host" zero-rating exploit; the `[crlf]/[host]/[split]` token language |
| 5 | OpenVPN — all modes | Transport | UDP-default rationale, the six wrapper modes (stunnel/WS/SSH), tuning knobs |
| 6 | V2Ray/Xray protocols | Transport | VLESS vs VMess/Trojan; REALITY, XTLS-Vision, XHTTP; the recommended core protocol |
| 7 | QUIC fast protocols | Transport | Hysteria2 (Brutal CC, masquerade, port-hopping, panel APIs) vs TUIC v5 |
| 8 | DNS + custom UDP transports | Transport | iodine/dnstt(=SlowDNS), ZIVPN/udp-custom, BadVPN-udpgw for UDP-over-SSH |
| 9 | SSH tunneling family | Transport | The `ssh -D` SOCKS core and its WS/SSL/DNS camouflage; Dropbear multiport |
| 10 | Combo server / multiport | Server | Autoscript installers, 443 sharing (Xray fallbacks / nginx / HAProxy SNI), scaling sysctls |
| 11 | Speed & stability engineering | Transport | BBR+fq, MTU/MSS, BDP buffers, Brutal, migration, port-hopping; the "mux ≠ throughput" trap |
| 12 | Reseller panels & subscriptions | Panel | 3x-ui/Marzban/Hiddify/PasarGuard; the missing credit-wallet; the "Vollam" panel decoded |
| 13 | Vollam & app-generator ecosystem | Client/Panel | The white-label "VPN business in a box" model and hot-updatable JSON config sync |
| 14 | Auth, subscription API, traffic accounting | Panel | Per-protocol auth+metering (OpenVPN mgmt, Xray gRPC, Hysteria2 HTTP, SSH/PAM, RADIUS); token design |
| 15 | Designing your own protocol | All | The four-layer custom-tunnel blueprint and the reuse-don't-greenfield build plan |

Read sections 6, 7, and 15 first if your priority is your own protocol; read 10, 12, and 14 first if your priority is standing up a billable reseller service this quarter. Sections 16 and 17 that follow synthesize across all of the above into a concrete adoption stack and the operational/legal boundaries you need to set before you scale.

---

## 3. Android all-in-one VPN client apps (open source cores)

Almost every "all-in-one" Android proxy app that matters in the HTTP-injector / free-net world is really a thin Kotlin/Java (or Flutter) shell wrapped around one of **three Go proxy cores**: SagerNet's **sing-box**, XTLS's **Xray-core** (V2Ray lineage), or MetaCubeX's **mihomo** (formerly Clash.Meta). Understanding those three engines and how they get bridged into Android's `VpnService` explains basically the entire category — including which apps are realistic white-label templates.

### 3.1 The three core/engine families

| Engine | Origin / repo | Protocols it speaks natively | Config style | Role in this ecosystem |
|---|---|---|---|---|
| **sing-box** | `SagerNet/sing-box` (GPL-3.0) | Shadowsocks, VMess, VLESS, Trojan, TUIC, Hysteria/Hysteria2, ShadowTLS, AnyTLS, WireGuard, SOCKS/HTTP, plus REALITY/uTLS on TLS | JSON | The modern universal core; powers SFA, NekoBox, Hiddify |
| **Xray-core** | XTLS Xray-core, wrapped for Android by `2dust/AndroidLibXrayLite` (GPL-3.0) | VMess, VLESS (+XTLS-Vision, REALITY), Trojan, Shadowsocks, SOCKS/HTTP | JSON | The V2Ray/VLESS-REALITY workhorse; powers v2rayNG |
| **mihomo** (Clash.Meta) | `MetaCubeX/mihomo` (GPL-3.0) | VMess, VLESS, Shadowsocks, Trojan, Snell, TUIC, Hysteria; rule-based routing, built-in DNS (DoH/DoT), GEOIP/GEOSITE | YAML ("Clash" format) | The rule-engine core; powers Clash Meta for Android, FlClash, Clash Verge Rev |

All three are **GPL-3.0**, which is exactly why a rebrand/fork ecosystem exists — but GPL also means a white-label app built on them must ship source.

### 3.2 How these apps actually work internally

The mechanism is nearly identical across all of them:

1. **`VpnService` + TUN.** The app requests Android's `VpnService` permission and calls `Builder.establish()`, which returns a **TUN file descriptor**. Routes (`0.0.0.0/0`, `::/0`), DNS, and MTU are set here. No root and no `/dev/net/tun` ioctls are available to an unprivileged app — those return `EACCES` — so the app can only read/write raw IP packets on that fd.
2. **The Go core runs in-process.** The core is compiled with **gomobile** into an Android Archive (`.aar`) — `libcore.aar` / `libbox` (sing-box), `libv2ray`/AndroidLibXrayLite (Xray), or a mihomo AAR — and called over JNI. So there is no separate binary or `ProcessBuilder`; the proxy stack is a library inside the app's own PID.
3. **`protect()` to avoid the routing loop.** Every socket the core opens to the *real* VPN server must be `protect()`-ed so it bypasses the TUN it created, otherwise packets loop forever.
4. **tun2socks — bridging IP packets to the proxy.** Something has to turn the raw IP/TCP/UDP packets on the TUN fd into proxied connections. Two dominant approaches:
   - **Userspace tun2socks:** a lightweight stack reassembles TCP/UDP and hands each flow to a local SOCKS/mixed inbound the core exposes. The two common libraries are **`heiher/hev-socks5-tunnel`** (C, very fast, used by v2rayNG and NekoBox as a submodule) and Go-based `tun2socks`.
   - **Native TUN inside the core:** newer cores take the TUN fd *directly*. **`SagerNet/sing-tun`** (GPL-3.0) implements a full userspace network stack with a choice of **gVisor netstack** or a system stack, TCP congestion control (BBR/CUBIC), and an Android `VpnService` route path — so sing-box/NekoBox/Hiddify need no external tun2socks. Recent AndroidLibXrayLite likewise can receive the TUN fd directly.
5. **Per-app routing** is done two ways: at the Android layer via `addAllowedApplication()` / `addDisallowedApplication()` (split-tunnel by package), and/or inside the core's routing rules (by process name, GEOIP, GEOSITE, domain).

The practical takeaways for a reseller: **speed** is dominated by the tun2socks path (gVisor netstack and hev-socks5-tunnel are the fast ones) and the transport/congestion control of the chosen protocol (Hysteria2/TUIC use QUIC + Brutal/BBR-style congestion control and win on lossy mobile links; WebSocket-over-TLS is slower but the most firewall-transparent). **Stability** on Ethiopian/Nigerian/Bangladeshi mobile networks tracks how well the transport survives DPI and NAT timeouts.

### 3.3 The apps, one by one

- **sing-box for Android (SFA)** — `SagerNet/sing-box-for-android`, GPL-3.0. The reference client: runs sing-box via `ForegroundService` or `VpnService`, unprivileged TUN, per-app proxy/bypass selection, imports sing-box JSON and Clash subscriptions (node info only). Cleanest, most current, but a bare "power user" UI.
- **v2rayNG** — `2dust/v2rayNG`, GPL-3.0. The single most widely deployed Android client in this space. Uses Xray-core (or v2fly core) via `2dust/AndroidLibXrayLite`, bundles `hev-socks5-tunnel` as a submodule, ships GEOIP/GEOSITE files. Best-in-class for VLESS + REALITY / XTLS-Vision, which are the current DPI-resistant favorites.
- **Hiddify (Hiddify-Next → Hiddify-App)** — `hiddify/hiddify-app` (the repo formerly known as `hiddify-next`), open source, built on a **sing-box fork** `hiddify/hiddify-sing-box` (aka hiddify-core). Written in **Flutter + Go**, so one codebase ships Android/iOS/Windows/macOS/Linux. Supports VLESS/VMess/Shadowsocks/Trojan/Reality/TUIC/Hysteria/Hysteria2/SSH/WireGuard and ingests sing-box, V2Ray, Clash and Clash-Meta subscriptions. This is the project explicitly designed to be forked and rebranded, and it is the most realistic white-label template (see 3.6).
- **NekoBox for Android** — `MatsuriDayo/NekoBoxForAndroid`, GPL-3.0. sing-box-based "universal proxy toolchain." Built-in: SOCKS/HTTP/SSH, Shadowsocks, VMess, VLESS, Trojan, AnyTLS, ShadowTLS, TUIC, Hysteria 1/2, WireGuard; **plugin-based**: Trojan-Go, NaïveProxy, Mieru (downloadable plugin APKs that supply external binaries). Kotlin GUI (descended from shadowsocks-android/SagerNet) over a Go `libcore` bridge. Actively the strongest OSS "many protocols in one" Android app.
- **nekoray / NekoBox for PC** — `MatsuriDayo/nekoray`, a Qt desktop GUI (sing-box backend). **No longer maintained** (repo itself says to find a replacement) — do not build a product on it.
- **Matsuri (茉莉)** — `MatsuriDayo/Matsuri`, GPL-3.0, an older SagerNet fork; effectively superseded by NekoBox. **AnXray** was another SagerNet/Xray-based fork from the same era; it is discontinued/archived. Both are historical — mentioned because configs and tutorials in the markets still reference them, but neither is a current template.
- **SagerNet** — `SagerNet/SagerNet`, the original "universal proxy toolchain for Android" that the whole Matsuri/NekoBox/AnXray line forked from; now largely eclipsed by sing-box + SFA.
- **Clash Meta for Android (CMFA)** — `MetaCubeX/ClashMetaForAndroid`, GPL-3.0. Wraps the mihomo core (`android-real` branch). Strength is **rule-based routing** (GEOIP/GEOSITE, per-domain, per-process) and Clash YAML subscriptions, which is why resellers who sell "smart routing" configs like it. Android 5.0+.
- **FlClash** — `chen08209/FlClash`, open source, **Flutter + Go** over the mihomo core, cross-platform (Android/Windows/macOS/Linux), Material-You UI, WebDAV sync. A modern, good-looking Clash client and a plausible template if you want a Clash/mihomo (YAML) product rather than sing-box.
- **Clash Verge Rev** — `clash-verge-rev/clash-verge-rev`, a **Tauri (Rust) desktop** GUI on the mihomo core for Windows/macOS/Linux. Listed for completeness, but **desktop-only — not an Android template.**

### 3.4 The "payload / tweak" free-net layer

None of the OSS cores above natively ship the **HTTP-Injector-style payload trick**; that layer is what closed apps add on top, and it is the actual product in the Ethiopia/Nigeria/Saudi/Bangladesh free-net markets. Mechanically it exploits **carrier zero-rating**, where the operator bills by inspecting the destination hostname rather than the payload:

- **SNI / "bug host":** the carrier meters (or zero-rates) traffic by the **SNI** in the TLS ClientHello or the **Host** header. A "bug host" is a hostname the carrier forgot to meter (a free-mode portal, an operator's own domain, a zero-rated partner). The app performs the TLS handshake / HTTP `CONNECT` advertising the **bug host as SNI/Host**, while the TCP connection actually terminates on the reseller's SSH/V2Ray server. Carrier sees the whitelisted name → bills $0; the tunnel underneath carries real traffic.
- **HTTP payload injection:** a hand-crafted request (`CONNECT [real:port] HTTP/1.1\r\nHost: [bughost]\r\nX-Online-Host: [bughost]\r\n...`) with split/duplicated headers to slip past the operator's DPI proxy, then an SSH or SSL/TLS tunnel is negotiated inside.
- **DNS tunneling (SlowDNS/DNStt):** when only DNS (port 53) is free, traffic is encapsulated in DNS queries — slow but survives the strictest gateways.

To reproduce this with the OSS cores you either (a) run an **SSH tunnel + a custom CONNECT/SNI front** and feed its local SOCKS to sing-box/Xray, or (b) use V2Ray/Xray **WebSocket-over-TLS** and set the TLS **SNI to the bug host** while the WS `Host` header carries the real routing — sing-box, Xray and mihomo all let you override SNI/Host independently of the dial address, which is the seam the free-net trick lives in. QUIC-based protocols (Hysteria2/TUIC) generally **cannot** carry the classic SNI bug because there is no TLS-over-TCP SNI to spoof, so payload sellers stay on TCP+TLS/WS transports.

### 3.5 Closed-source injector apps (and their OSS analogues)

| App | Open source? | Notes |
|---|---|---|
| **HTTP Injector** (Evozi) | No | Market leader for payloads; SSH/Proxy/SSL/DNS + V2Ray/Xray/Hysteria/WireGuard. The template everyone copies, but you cannot fork it. |
| **HTTP Custom** | No | Payload + SSL/TLS-handshake-over-SNI, SSH. Closed. |
| **NapsternetV / Npv Tunnel** | No | V2Ray/SSH + OSSH/Psiphon over WebSocket, SlowDNS/DNStt, split-payload SSH. Closed; client-only (no servers). |

Open-source building blocks that replicate pieces of the payload layer (all small, community projects — verify freshness before shipping): `abdoxfox/HTTP-CUSTOM-HEADERS-VPN`, `JeelsBoobz/http-injector`, `noobconner21/http-ssl-ssh-injector` (HTTP/SSL/SSH tunneling for Android+Linux), `comp500/SSLSocks` (stunnel-over-TLS GUI), and `kirula0626/SNI_Injector` (Python SNI/TLS injector). These are honest to call out as **thin and lightly maintained** — there is no mature, full-featured OSS clone of HTTP Injector's payload engine. That gap is the reason the market runs on closed apps plus config resellers.

### 3.6 Realistic white-label templates

Ranked by how buildable a branded product is:

1. **Hiddify-App** (`hiddify/hiddify-app`) — **best overall.** One Flutter codebase → Android+iOS+desktop, sing-box core with the widest protocol set, subscription import for every format, and a matching server panel (HiddifyManager) so a reseller gets client + provisioning in one stack. Explicitly built to be forked; you change branding/flavors and rebuild via its Makefile/CI. GPL-3.0 obligations apply.
2. **NekoBox for Android** (`MatsuriDayo/NekoBoxForAndroid`) — best **Android-only, sing-box** base if you want native Kotlin and plugin protocols. Mature, most protocols out of the box.
3. **v2rayNG** (`2dust/v2rayNG`) — best if your servers are **VLESS/REALITY/Xray**; huge install base and config compatibility in these exact markets.
4. **FlClash** (`chen08209/FlClash`) — pick this only if your product is **Clash/mihomo (YAML rule-based)** rather than sing-box.

Caveats for all four: they are **GPL-3.0**, so a rebranded binary must offer corresponding source; and **none ship the SNI/HTTP payload free-net layer** — you would bolt that on (SSH/CONNECT front + SNI/Host override on a TLS/WS transport), which is the real engineering work in this niche. Clash Verge Rev, nekoray, Matsuri and AnXray are **not** viable templates (desktop-only or unmaintained).

---

## 4. HTTP-injector / HA Tunnel / KPN / TLS Tunnel — payload injection mechanics

The "payload" family of apps exists to exploit one fact: **carrier billing and DPI decide whether to charge you by looking at the *first* readable bytes of a connection** — the HTTP request line, the `Host`/`X-Online-Host` header, or the TLS ClientHello `SNI` — and not at where the packets actually go. A payload injector manufactures those first bytes so they name a **zero-rated / whitelisted host** (a "bug host," "realm," or "spoof host"), while the socket underneath is a plain SSH/SSL/WebSocket tunnel to your own server. The carrier meters the connection as free traffic to `m.youtube.com` or `0.facebook.com`; you actually get a general-purpose tunnel. This is a billing-loophole attack, discussed candidly in §4.10.

Two mechanically distinct techniques sit under the same UI:

- **HTTP-layer injection** — a hand-crafted `CONNECT`/`GET` request (the "payload") sent to a proxy or inline DPI, carrying a spoofed `Host`. Used by HTTP Injector, HTTP Custom, KPN "payload" modes, HA Tunnel "custom payload."
- **TLS-layer SNI spoofing** — no HTTP payload at all; a stunnel/SSL connection whose ClientHello `SNI` is set to the bug host. Used by KPN "Direct SSL," TLS Tunnel "Custom SNI," HA Tunnel "Custom SNI."

Most real configs combine both (SSL **+** payload).

### 4.1 HTTP request injection: CONNECT / GET to a proxy

The base primitive is the standard HTTP `CONNECT` verb used to drive a forward proxy (a carrier APN proxy, or a Squid/`3proxy` box on 80/8080/3128):

```
CONNECT 198.51.100.10:22 HTTP/1.1\r\n
Host: <target>\r\n
\r\n
```

A compliant proxy opens a raw TCP tunnel to `198.51.100.10:22` and replies `HTTP/1.1 200 Connection established`. Everything after that is opaque bytes — perfect for wrapping SSH. The injector's job is to **rewrite the request line and headers** so the metering path sees the bug host, while the proxy (or an inline transparent proxy the carrier runs) still routes to the real target. Two deployment shapes:

- **Remote proxy present** — a real forward proxy actually parses and honors the `CONNECT`; the spoofed `Host`/`X-Online-Host` is what the billing engine keys on.
- **"Direct" (no real proxy)** — there is only the carrier's inline transparent proxy/DPI. The trick relies on that cheap parser reading only the first request/segment and classifying the whole flow by the bug host; the injector then talks straight to an SSH/SSL front on your server.

### 4.2 The token / payload language

Injector apps expose a tiny templating language so one payload works across servers. Tokens verified from the HTTP Injector glossary and generator sources:

| Token | Expands to | Notes |
|---|---|---|
| `[host]` | destination host | target server IP/domain |
| `[port]` | destination port | e.g. `22`, `443` |
| `[host_port]` | `host:port` | e.g. `198.51.100.10:22` |
| `[ssh]` | SSH server `host:port` from settings | |
| `[protocol]` | `HTTP/1.0` or `HTTP/1.1` | request-line version |
| `[netData]` | `CONNECT [host_port] [protocol]` | shorthand for the whole request line |
| `[cr]` | `\r` (U+000D) | carriage return |
| `[lf]` | `\n` (U+000A) | line feed |
| `[crlf]` | `\r\n` | header/line terminator; **double `[crlf]` ends the header block** |
| `[lfcr]` | `\n\r` | reversed, used to confuse strict parsers |
| `[split]` | flush point → forces the bytes before it into their **own TCP segment** | see §4.4 |
| `[delay_split]` | like `[split]` but with a timing gap between segments | evades reassembly |
| `[ua]` | User-Agent string | |

Be candid with the reader: tokens like `[ip]` (sometimes an alias for `[host]`) and `[rlb]` appear in community payload dumps but are **not documented in any canonical source I could verify** — treat them as app-/fork-specific and confirm against the exact app build rather than trusting a forum list.

### 4.3 CRLF injection is the whole mechanism

There is nothing exotic in the framing — the payload is literally raw HTTP typed by hand, and `[crlf]` is deliberate **CRLF injection**: the same primitive behind HTTP response-splitting and request-smuggling. By emitting a first, well-formed request terminated with `[crlf][crlf]` and then a *second* request in the same stream, the injector desynchronizes what the billing parser thinks the connection is (request #1, bug host) from what actually gets tunneled (request #2, your server). "Front/back inject" is just choosing which request comes first.

### 4.4 Front/back inject, front/back query, and `[split]`

Verified template forms (from `hndko/payload-injector-generator` source and FastSSH docs). `{bug}` is the zero-rated host, `[host_port]` your real target:

| Method | Template | Idea |
|---|---|---|
| Normal | `CONNECT [host_port] [protocol][crlf]Host: {bug}[crlf][crlf]` | spoofed `Host` on the real CONNECT |
| Front Inject | `GET http://{bug}/ [protocol][crlf]Host: {bug}[crlf][crlf]CONNECT [host_port] [protocol][crlf][crlf]` | bug request **before** CONNECT |
| Back Inject | `CONNECT [host_port] [protocol][crlf][crlf]GET http://{bug}/ [protocol][crlf]Host: {bug}[crlf][crlf]` | bug request **after** CONNECT |
| Front Query | `CONNECT {bug}@[host_port] [protocol][crlf][crlf]` | bug host as `userinfo@` prefix |
| Back Query | `CONNECT [host_port]@{bug} [protocol][crlf][crlf]` | bug host as `@`-suffix |
| WebSocket | `GET [host_port] [protocol][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf]Host: {bug}[crlf][crlf]` | WS upgrade carrying spoofed `Host` |

`[split]` is the sharpest tool: `...Host: {bug}[crlf][crlf][split]CONNECT [host_port]...` tells the client to **send the bug-host request in one TCP segment, then the real request in the next**. An inline classifier that samples only the first segment (or the first packet of the flow) files the whole connection under `{bug}`. `[delay_split]` adds a millisecond gap so segment-reassembling DPI still commits to the wrong verdict. The `userinfo@` "query" tricks target lenient transparent-proxy URL parsers that read the token after `@` as the host.

### 4.5 SNI manipulation, "preserve SNI," and SSL/TLS SNI spoofing

Because most modern carriers meter on **TLS**, not plaintext HTTP, the higher-value trick moved down a layer. The TLS ClientHello carries `server_name` (SNI) **in cleartext**; that is what the billing box reads. The injector opens a genuine TLS/stunnel session to *your* server but writes the **bug host into the SNI field**:

- **Custom SNI / "SSL bug"** — ClientHello SNI = `m.youtube.com`; your server (or the stunnel/`nginx stream` front on 443) ignores SNI or terminates any name, so the handshake completes to your box while the carrier books it as YouTube quota.
- **"Preserve SNI"** — a toggle that keeps the *original* SNI value through any front/relay hop instead of rewriting it to the real backend name, so the spoofed name survives end-to-end and is never "corrected."
- This is **SNI spoofing**, not domain fronting: only one name is involved (the SNI), and there is no HTTP `Host` mismatch. It is robust because a carrier cannot block the bug SNI without also blocking the real popular domain it impersonates.

### 4.6 Domain fronting (CloudFront / Cloudflare) — mostly historical

Domain fronting is the *two-name* variant: TLS SNI = an allowed CDN edge domain, and the encrypted HTTP `Host:` inside = your actual backend, **both on the same CDN**. The censor/biller sees only the SNI (the innocuous CDN name); the CDN routes by the inner `Host`. Where a carrier zero-rates a large CDN-hosted property, this yielded free general traffic and was documented as a zero-rating fraud vector (Sandvine measured frontled users averaging ~300% higher monthly usage). **Be honest with the reader that this is largely closed off**: AWS CloudFront, Google, and Cloudflare disabled cross-domain/cross-account fronting around 2018, so today it only works *within a single account/CDN tenant* you control — a niche, not a general bypass. SNI-only spoofing (§4.5) has replaced it in this ecosystem.

### 4.7 Bug host / realm / zero-rated-host exploitation

The "bug host" is any name the carrier forgot to meter: captive-portal and self-care domains, operator CDN/help hosts, and bundled zero-rated services (`0.facebook.com`, `free.facebook.com`, `m.youtube.com`, whitelisted `*.wikipedia.org`, education/health portals, MNO payment hosts). "Realm" is the same idea named per-carrier. Sourcing these is a whole sub-industry — see the bug-host scrapers in §4.9. For the reader's markets this is highly carrier-specific: Ethiopia (Ethiotelecom/telebirr portals), Nigeria (MTN/Glo/Airtel/9mobile "cheat" hosts), Saudi (STC/Mobily/Zain captive hosts), Bangladesh (GP/Robi/Banglalink zero-rated bundles). Crucially, **the value of a config is the live bug host, not the app** — which is why sellers encrypt configs (§4.9) to protect the host, and why configs rot within days of a carrier patching the loophole.

### 4.8 KPN Tunnel "SSL Payload" method

KPN Tunnel Revolution (local listener default **2323**) exposes four relevant modes; the distinctive one is combining both layers:

| KPN mode | What it sends | Server side |
|---|---|---|
| Direct Payload | HTTP payload (`CONNECT`/`Host` spoof) straight to target/inline proxy | SSH Dropbear/OpenSSH |
| Proxy + Payload | payload **through** a remote Squid/HTTP proxy | SSH via proxy |
| Direct SSL/TLS (SNI) | no payload; TLS to server with **Spoof Server = SNI bug** | SSH-over-SSL / stunnel |
| **SSL + Payload ("SSL Payload")** | sends the **HTTP injection payload first, then negotiates TLS** to the server | stunnel + SSH |

The "SSL Payload" method stacks the tricks: the plaintext HTTP payload gets the flow classified by the DPI's HTTP parser as the bug host, and the subsequent TLS handshake (with its own bug SNI in the "Spoof Server" field) satisfies any TLS-level metering — covering carriers that inspect both layers. The `.ktr` config locks the payload + spoof server while leaving SSH creds user-editable.

### 4.9 App survey — and their (non-)openness

| App | Vendor | Config | Core method | Source |
|---|---|---|---|---|
| **HTTP Injector** | EvoZi | `.ehi` (encrypted) | SSH/Proxy/SSL/DNSTT/V2Ray-Xray/Hysteria/WireGuard + custom payload, websocket, SNI | **Closed** |
| **HA Tunnel Plus** | Art Of Tunnel | `.hat` | SSH2.0 with custom SNI, custom payload, "custom host reader" | **Closed** |
| **KPN Tunnel Revolution** | KPN Soft Dev | `.ktr` | payload / SSL-SNI / SSL+payload (§4.8) | **Closed** |
| **TLS Tunnel** | — | `.ltn` | proprietary **TLSVPN** over TLS 1.3 (fallback 1.2); Custom SNI / Payload / both | **Closed** |
| **HTTP Custom** | — | `.hc` | SSH + custom payload/SNI (HTTP-Injector-like) | **Closed** |
| **Dark Tunnel** | — | own | SSH/SSL/V2Ray + payload/SNI | **Closed** |
| **NetMod Syna** | — | own | SSH/DNS/proxy + payload/SNI | **Closed** |
| **SocksHTTP** | — | `.sks` | SSH-over-HTTP-proxy payload | **Closed** |

Every name-brand injector is **closed source**; their configs are deliberately encrypted to hide the bug host and SSH credentials. The open-source footprint (below) is entirely third-party reimplementations, generators, scrapers, and **decryptors**.

### 4.10 Open-source implementations on GitHub

Verified repos (star counts observed at research time and will drift):

**Working injectors / tunnels**
- **`miyurudassanayake/sni-injector`** (Python, ~270★) — the reference OSS SNI injector: local proxy on 9092 accepting a rewritten SNI, SSH to an stunnel-wrapped 443 listener, dynamic SOCKS5 on 1080. Config in `settings.ini`.
- **`tavgar/Custom-Internet`** (Python, ~21★) — cleanest teaching example: `ws_tunnel.py` sends a `PAYLOAD_TEMPLATE` with `[host]`/`[crlf]`, waits for `101 Switching Protocols`, hands the raw socket to Paramiko `Transport`, exposes SOCKS on 1080. Three strategies: **direct / HTTP-payload / SNI-fronting** (`FRONT_DOMAIN`).
- **`kirula0626/SNI_Injector`** (Python, ~29★) — TCP-over-SSL SNI tunnel (stunnel 443 → SSH 22 → SOCKS5 1080/9092), Windows/Linux.
- **`AlizerUncaged/HTTP-Injector`** (Java, ~50★) — modifies HTTP proxy `CONNECT` requests/responses to bypass ISP filtering; MIT.
- **`wijayamin/python-http-injector`** (Python, ~20★) — injector for OpenWRT/LEDE routers.
- **`JeelsBoobz/http-injector`** (Python, ~9★) and **`Monster-ZeroX/http-ssl-ssh-injector`** (Python, ~4★) — Android(root)/Linux SSH+SSL+payload injectors with `badvpn-tun2socks`.
- **`akilaid/HTTP-CUSTOM-HEADERS-VPN`** (Python, ~19★) — custom-header SSH tunnel.

**Payload generators**
- **`hndko/payload-injector-generator`** (Python, ~20★) — emits the exact templates in §4.4 (Normal/Front-Back Inject/Query/WebSocket/SNI) from a bug-host input.
- **`Gabrieltec123/Payload_generator`** (JS, ~11★) and `muhammad-salem/injector-tools` (Java, ~8★).

**Bug-host sourcing**
- **`hndko/bughttpinjector`** (Python, ~14★) — auto-scrapes fresh bug hosts/IPs.

**Config decryptors (recover payload/SNI/SSH from locked configs)**
- **`tools-inet/hctools`** (Node) — decrypts `.hc`/`.ehi`/eProxy/NapsternetV/**SocksHTTP** configs.
- **`noobconner21/Http-Injector-Decrypt-Script`** (`.ehi`), **`HCTools/hcdecryptor`** (WIP, HTTP Custom), **`kralonur/multi-vpn-decryptor-rs`** (Rust/WASM, `.ehi`/`.hc`/`.ssc`).

**Adjacent generic tunnels (legitimate, not injectors, but drop-in transports)** — `mhzed/wstunnel` and `antoniomika/sish` (SSH/WS/SNI tunnels), `comp500/SSLSocks` (stunnel-for-Android GUI). Useful server-side building blocks; they carry no bug-host tricks themselves.

**Honest gap:** there is **no** high-quality, canonical open-source clone of a full name-brand injector (no OSS `.ehi`/`.hat` engine with the whole payload UI). The OSS you can actually build on is Python/shell SNI/SSH plumbing (`sni-injector`, `Custom-Internet`), generators, scrapers, and decryptors — everything else is closed APKs.

### 4.11 Worked example: assembling a payload → SSH → SOCKS

Goal: reach SSH server `198.51.100.10:22` on a carrier that zero-rates `m.youtube.com`, exposing a local SOCKS5 for apps.

**1 — Author the payload** (Back-Inject with a spoofed `Host`, one-line template):

```
CONNECT [host_port] [protocol][crlf]Host: [bug][crlf]X-Online-Host: [bug][crlf][crlf][split]GET http://[bug]/ [protocol][crlf]Host: [bug][crlf][crlf]
```

**2 — Token substitution** (`[host_port]=198.51.100.10:22`, `[protocol]=HTTP/1.1`, `[bug]=m.youtube.com`) produces these literal wire bytes to the proxy/inline DPI:

```
CONNECT 198.51.100.10:22 HTTP/1.1\r\n
Host: m.youtube.com\r\n
X-Online-Host: m.youtube.com\r\n
\r\n
        <-- [split]: everything above flushed in its own TCP segment
GET http://m.youtube.com/ HTTP/1.1\r\n
Host: m.youtube.com\r\n
\r\n
```

**3 — What each party sees.** The carrier's billing/DPI reads segment 1, sees `Host: m.youtube.com`, and files the flow as free YouTube quota. The proxy honors `CONNECT 198.51.100.10:22` and returns `HTTP/1.1 200 Connection established\r\n\r\n`, opening a raw tunnel to your SSH port.

**4 — SSH + SOCKS.** The client now speaks SSH inside that tunnel (`SSH-2.0-...` banner exchange → key exchange → password/key auth) and requests a **dynamic port forward**, equivalent to `ssh -D 1080 -o ProxyCommand='injector emits the payload above' user@198.51.100.10`. Apps point at `127.0.0.1:1080`; every stream is multiplexed over the one SSH connection the carrier thinks is YouTube.

**WebSocket variant** (Custom-Internet style, for HTTP-aware proxies/CDNs): send `GET / HTTP/1.1[crlf]Host: [bug][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]`, expect `101 Switching Protocols`, then run SSH over the upgraded socket — same SOCKS-1080 endpoint.

### 4.12 Speed, stability, and where this is heading

- **Plain HTTP payload/CONNECT** — lowest overhead, highest fragility: bug hosts die when the carrier patches metering, and public Squid proxies are slow/unreliable. Throughput is one TCP stream inside another (**TCP-over-TCP meltdown**): on a lossy mobile link the inner and outer retransmit timers fight, so goodput collapses under loss even when "connected." None of these apps do real congestion-control tuning.
- **SSL/SNI (stunnel)** — most durable, since the bug SNI impersonates a domain the carrier won't block; costs a TLS handshake + record overhead. Best stability/robustness tradeoff today.
- **WebSocket-over-payload** — survives HTTP-aware proxies and rides CDNs; adds WS framing overhead. Common for CDN-fronted setups.
- **Ecosystem shift** — as carriers deploy smarter DPI, the injector apps have bolted on **V2Ray/VLESS/VMess+Reality, Shadowsocks, DNSTT (DNS tunneling), and Hysteria (QUIC/UDP)**. Hysteria's UDP + Brutal congestion control specifically counters the TCP-over-TCP problem and DPI throttling, which is why new "free-net" configs increasingly ship Hysteria/Reality rather than a raw `.ehi` payload.

### 4.13 Candor / legal framing

State it plainly to the reader: **the name-brand injectors are closed source**, and this entire technique targets **carrier billing loopholes** — spoofing metering to obtain data the carrier would otherwise charge for. That is a Terms-of-Service violation everywhere and, depending on jurisdiction (and on how "computer misuse"/telecom-fraud statutes are read in Ethiopia, Nigeria, Saudi Arabia, and Bangladesh), can be an actionable offense, not merely a gray area. The same client stack (SSH/SSL/WS/V2Ray + SNI) is perfectly legitimate for censorship circumvention against a paid plan; it is the **zero-rated bug-host abuse** that crosses the line. A reseller business built on specific bug hosts is also commercially fragile: the asset decays the moment a carrier fixes its metering.

---

## 5. OpenVPN — every transport mode and performance tuning

OpenVPN is the workhorse of the injector/free-net stack because it separates a **TLS control channel** (key exchange, config push) from a **data channel** (the actual encrypted tunnel), and because that whole thing can be shoved inside almost any outer wrapper — raw UDP, raw TCP, SSL, WebSocket, an HTTP CONNECT proxy, or an SSH tunnel — without OpenVPN itself changing. For a reseller in Ethiopia/Nigeria/KSA/Bangladesh, that wrappability is the entire product: the ISP's DPI and its zero-rated billing engine look at the *outer* layer, and OpenVPN rides inside it.

### 5.1 The two native transports

OpenVPN speaks exactly one of two socket types at a time, chosen with `proto udp` / `proto tcp` (client side `proto tcp-client`, server side `proto tcp-server`).

- **UDP (default, port 1194):** OpenVPN's data channel is designed for a datagram, lossy transport. Each tunneled packet is one UDP datagram; loss recovery is left to the *inner* protocol (the TCP inside the tunnel). This is the fast, low-latency, correct mode. `fast-io`, `mssfix`, and `fragment` only work here.
- **TCP (typically 1194, or 443/80/110 to look like something else):** Adds a reliable, ordered, retransmitting outer stream. This survives ugly NAT and proxies and blends into HTTPS, but it introduces the meltdown below.

**The TCP-over-TCP meltdown (why UDP is mandatory when possible).** When you tunnel a TCP flow (which is ~95% of user traffic) inside a TCP OpenVPN link, you stack two reliability layers. If the underlying network drops a packet, the *outer* TCP (OpenVPN's socket) starts its own retransmission and holds the whole stream (head-of-line blocking) while the *inner* TCP — which cannot see the outer recovery happening — independently decides its packet is lost and *also* retransmits. The two retransmission timers and congestion windows fight and amplify each other; under any real loss the throughput collapses instead of degrading gracefully. UDP avoids this entirely: there is no outer retransmission to collide with, so the inner TCP manages reliability exactly as designed. **Rule: default to UDP; use TCP only when UDP is blocked, throttled, or not billable under the payload.** In the free-net world TCP is still used constantly — not for speed, but because port 443/80 TCP is what firewalls and captive portals let through and what SNI/HTTP payloads can be attached to.

### 5.2 The six combo-server OpenVPN modes

This maps directly onto the port list from a typical combo server. "Config that makes it work" is the delta from a normal `.ovpn`.

| # | Mode / port | Outer transport seen by ISP | Server-side plumbing | Key `.ovpn` / client directives | Notes for free-net use |
|---|---|---|---|---|---|
| 1 | **OpenVPN UDP 1194** (often UDP 110/53/8000) | Raw UDP | `openvpn` listens UDP | `proto udp` · `remote <ip> 1194` · `explicit-exit-notify` | Fastest, lowest latency. Port 110/53/25000 chosen because some carriers zero-rate or leave UDP DNS/POP3 ports open. No SNI possible (no TLS SNI in raw OpenVPN), so DPI-fragile. |
| 2 | **OpenVPN TCP 1194** | Raw TCP | `openvpn` listens TCP | `proto tcp-client` · `remote <ip> 1194` | Survives proxies/NAT; suffers meltdown. Baseline "just works" fallback. |
| 3 | **OpenVPN over SSL/TLS 443** (stunnel) | TLS/HTTPS to :443 | `stunnel` accepts :443 → forwards to local `openvpn tcp 1194` | `.ovpn` sets `remote 127.0.0.1 <localport>` and connects through the local stunnel client; injector app supplies **SNI** on the stunnel `ClientHello` | Looks like normal HTTPS. SNI = the bug/zero-rated host. Most common "premium" mode. |
| 4 | **OpenVPN over SSL/TLS 444** (stunnel, 2nd instance) | TLS to :444 | second `stunnel` accept block on :444 → :1194 | same as #3 but `443`→`444` | Just a second SSL port so one bug host on 443 and another on 444 can be sold separately, or to dodge a 443 block. |
| 5 | **OpenVPN over WebSocket 80** (+HTTP payload) | HTTP `Upgrade: websocket` on :80 | `wstunnel`/`websocat`/python WS proxy on :80 → :1194 | `.ovpn` targets local WS client; injector prepends an **HTTP payload** (custom `GET`/`CONNECT` + `Host:`/`X-Online-Host:` headers) | Rides cleartext HTTP:80 that is very often zero-rated. Payload spoofs a free host so the carrier bills 0 MB. |
| 6 | **OpenVPN over WS/HTTP 8088** (alt HTTP port) | HTTP/WS on :8088 (or 8080/8888) | second WS/HTTP-proxy instance → :1194 | same as #5, different port | Alternate HTTP port when :80 is filtered or a specific bug only works on 8088. |

### 5.3 The four wrappers, mechanically

**stunnel (SSL/TLS on 443/444).** stunnel is a generic TLS shim (from stunnel.org). Server: an `[openvpn]` service section with `accept = 443`, `connect = 127.0.0.1:1194`, and `cert=`/`key=` (a real Let's Encrypt cert or self-signed). Client: `accept = 127.0.0.1:11940`, `connect = <server>:443`, `client = yes`. OpenVPN's `.ovpn` then does `proto tcp` + `remote 127.0.0.1 11940`, so OpenVPN never touches the wire — stunnel does, wrapping the OpenVPN-TCP stream in a genuine TLS record layer. To DPI it is a TLS 1.2/1.3 session to port 443; the **SNI** field in the `ClientHello` is what injector apps set to the bug host. Because stunnel carries OpenVPN-**TCP**, you now have TCP-over-TCP-over-TLS — stable but slow under loss; this is the classic speed/stability tradeoff of the "SSL" mode.

**OpenVPN-over-WebSocket (80/8088).** A WebSocket proxy terminates an HTTP `Upgrade: websocket` handshake and then relays the raw bytes to local OpenVPN. Two mainstream OSS tools:
- **erebe/wstunnel** (Rust, static binary): `wstunnel server ws://[::]:80` on the VPS and `wstunnel client -L tcp://1194:127.0.0.1:1194 ws://server:80` on the client tunnels TCP (and UDP) inside WebSocket frames; supports `wss://` TLS, `--http-upgrade-path-prefix` for a shared-secret path, SNI override, and even HTTP/2 / WebTransport(HTTP-3) transports for when plain WS is throttled.
- **vi/websocat** (Rust, netcat-for-ws): used as a lighter relay/bridge between a TCP socket and a `ws://` endpoint.
Combo scripts often instead ship a small **Python WebSocket proxy** ("OpenVPN-WS", "WS-ePro") that reads the injector's HTTP payload, answers `101 Switching Protocols`, and pipes to `127.0.0.1:1194`. WebSocket is attractive because it is *HTTP that stays open*, so it passes HTTP-aware proxies and can be prefixed with a spoofed `Host:` for zero-rating.

**OpenVPN-over-HTTP-proxy with payload (80/8088).** OpenVPN has this natively via `http-proxy <server> <port>` plus `http-proxy-option`:
- `http-proxy-option VERSION 1.1`
- `http-proxy-option AGENT <user-agent>`
- `http-proxy-option CUSTOM-HEADER <name> <value>` (repeatable)

OpenVPN issues an HTTP `CONNECT` to the proxy and only then starts its tunnel. The "payload" that injector apps generate is exactly this request line + header block (e.g. a fake `GET http://<zero-rated-host>/ HTTP/1.1` with `Host:`, `X-Online-Host:`, `X-Forward-Host:` split by `[crlf]`/`[split]`/`[lf]` tokens) crafted so the carrier's HTTP inspection charges it against a free/whitelisted destination while it actually reaches your VPS's proxy port. Ports 80 and 8088 are used because that is where transparent HTTP proxies and zero-rating live.

**OpenVPN chained behind SSH.** Start an SSH local forward — `ssh -L 1194:127.0.0.1:1194 user@server` (or via Dropbear + an HTTP/WS payload to reach the SSH port) — then point `.ovpn` at `remote 127.0.0.1 1194` with `proto tcp`. Everything, including OpenVPN's TLS handshake, is inside SSH's encrypted channel, so DPI sees only SSH. Alternatively `ProxyCommand`/`nc` chains OpenVPN through an SSH-provided SOCKS. Downside: SSH is TCP, so this is again TCP-over-TCP; it is chosen for stealth and account-multiplexing, not throughput. This is the backbone of most "SSH + payload" reseller panels; OpenVPN is the optional upgrade layered on top of the same SSH account.

### 5.4 Performance tuning knobs (what each actually does)

| Directive | Typical value | Transport | Effect |
|---|---|---|---|
| `sndbuf` / `rcvbuf` | `524288`–`67108864` (512 KB–64 MB) | UDP & TCP | Socket send/receive buffer. OS default (~64 KB) throttles high-BDP links (WiFi/long-haul); raising it is often the single biggest throughput win (e.g. 25→80 Mbit reports). 64 MB is aggressive and mostly matters on fat, high-latency paths. Can be pushed to clients. |
| `tcp-nodelay` | flag | TCP only | Disables Nagle's algorithm (TCP_NODELAY), stops small packets from being held/coalesced → lower latency for the SSL/443 mode. Server can push it. |
| `fast-io` | flag | **UDP only** | Skips a `poll/epoll/select` before writes; ~5–10% less CPU, meaningful on cheap ARM/low-clock VPS. Non-Windows, no shaping. |
| `mssfix` | `1450` (default) / `1360`–`1400` on payload links | UDP | Tells inner TCP to cap its MSS so the *post-encryption* datagram never exceeds the value → avoids IP fragmentation and PMTUD black-holes. Lower it when carriers inject smaller MTU or when payload headers eat space. |
| `tun-mtu` / `link-mtu` | `tun-mtu 1500`; `link-mtu` derived | both | `tun-mtu` sets the virtual NIC MTU and OpenVPN derives link MTU; must match on both ends. `link-mtu` bounds the on-wire packet. Mismatch = stalls, so most setups fix `tun-mtu` and let `mssfix` do the work. |
| `fragment` | `1300`–`1400` | UDP only | OpenVPN's *own* internal fragmentation so no datagram exceeds `max`; +4 bytes overhead. Use with `mssfix` on hostile MTU paths; hurts throughput, so drop it once stable. |
| `compress` / `comp-lzo` | usually **off** | both | `comp-lzo` is deprecated; modern `compress` (empty = framing only, no compression). Compression burns CPU and is a security risk (VORACLE); leave disabled — most traffic is already encrypted/compressed. Both ends must agree. |
| `data-ciphers` / (`ncp-ciphers`) | `AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305` | data channel | NCP list. 2.5 default `AES-256-GCM:AES-128-GCM`; 2.6 adds `CHACHA20-POLY1305`. Client advertises via `IV_CIPHERS`; **server picks the first entry that both share**. Put `CHACHA20-POLY1305` first for phones/ARM without AES-NI (2–3× faster there); `AES-256-GCM` first for AES-NI VPS. `ncp-disable`/single `cipher` removes negotiation overhead but breaks 2.6 clients. |
| `auth` | `SHA256` / `SHA512` | control + non-GCM data | HMAC for packet auth. Irrelevant to data integrity when a GCM/AEAD cipher is used (GCM authenticates itself), but still governs `tls-auth`/HMAC firewall. |
| `keepalive` / `ping`+`ping-restart` | `keepalive 10 120` | both | Expands to `ping 10` + `ping-restart 120`: send a ping every 10 s, restart the tunnel if silent for 120 s. Essential on flaky mobile links to auto-heal dead tunnels. |
| `explicit-exit-notify` | `1`/`2` | **UDP only** | On disconnect, actively tells the server so it frees the session instead of waiting for timeout — faster reconnects, fewer "address in use" hangs. No effect on TCP (FIN already signals it). |
| `txqueuelen` | `2000` | both | tun/tap interface queue depth; deeper queue smooths bursts on fast links. |

Kernel side, raise `net.core.rmem_max` / `wmem_max` (and `net.ipv4.tcp` buffers) to match large `sndbuf`/`rcvbuf`, or the socket request is silently clamped. Single-threaded per-tunnel OpenVPN is CPU-bound on crypto, so cipher choice + AES-NI usually dominates raw buffer tuning.

### 5.5 Open-source install scripts and wrappers

- **Nyr/openvpn-install** (`github.com/Nyr/openvpn-install`) — the minimal, near-universal road-warrior installer (Ubuntu/Debian/AlmaLinux/Rocky/CentOS/Fedora). Prompts for **UDP or TCP** and a **custom port** (default 1194); generates a self-contained `.ovpn` with `client / dev tun / proto <> / remote <ip> <port> / resolv-retry infinite / nobind / persist-key / persist-tun / remote-cert-tls server / auth SHA512 / tls-crypt` + inline certs. It deliberately omits an explicit `cipher` line and rides 2.5/2.6 NCP defaults. This is the base most resellers build on.
- **angristan's OpenVPN installer** — more knob-heavy fork lineage (choose cipher, DH/ECDSA curve, DNS, `tls-crypt` vs `tls-auth`, compression). The current project lives at `angristan/openvpn-install`; an archived mirror I verified is `github.com/angristan/OpenVPN-install-fork-old`. Good when you want AES-256-GCM/CHACHA and modern PKI chosen explicitly.
- **stunnel** (stunnel.org) — the SSL/443/444 wrapper; pair with Let's Encrypt for a real cert + valid SNI.
- **erebe/wstunnel** (`github.com/erebe/wstunnel`) and **vi/websocat** (`github.com/vi/websocat`) — the WebSocket/HTTP(2) relays for modes 5–6; wstunnel is the more capable (UDP-in-WS, reverse tunnels, TLS/SNI, path-prefix auth).
- **Combo/"autoscript" panels** that bundle OpenVPN-UDP/TCP + stunnel + Dropbear-WS + BadVPN + OpenVPN-WS on one VPS, aimed squarely at this ecosystem: `GegeDevs/sshvpn-script`, `jubairbro/AUTO-SCRIPT`, `syapik96/aws`, `scvps/scriptvps`, `NevermoreSSH/hop`, `daybreakersx/premscript`. Quality varies wildly and many carry hard-coded creds/backdoors — audit before selling on them.
- **Injector-side tooling** (how the client consumes it): apps like **HTTP Injector (.ehi)** and **HTTP Custom** take your `.ovpn` + a **payload** (HTTP request/header template with `[crlf]`/`[split]` tokens) + an **SNI/bug host**, then open the outer socket (TCP/SSL/WS), send the payload/do the TLS handshake with your SNI, and hand the resulting stream to the embedded OpenVPN engine. OSS equivalents worth naming: `kirula0626/SNI_Injector` (Python TCP-over-SSL SNI injector), `Monster-ZeroX/http-ssl-ssh-injector`, and the `tharushaudana/ssh-over-tls-stunnel` guide (SSH/OpenVPN-over-TLS with HTTP Injector notes).

### 5.6 Bottom line for the operator

- **Ship UDP as the fast tier**, SSL/443 (stunnel) as the stealth/premium tier, and WS/HTTP:80 as the zero-rated/"free" tier. They are the same OpenVPN backend on `127.0.0.1:1194` behind three different front doors.
- **Never sell TCP as "fast."** TCP-over-TCP meltdown is real; it is a compatibility mode.
- The **bug host lives in the SNI (stunnel/WS-TLS) or in the HTTP payload `Host`/`X-Online-Host` (HTTP/WS:80)** — OpenVPN itself is payload-agnostic, which is exactly why it is the layer you keep constant while you rotate outer wrappers as carriers patch their zero-rating.

---

## 6. V2Ray / Xray-core — protocols, transports, and anti-DPI

The "V2Ray" family is not one program but a lineage of interoperable cores that share a wire-protocol vocabulary (VMess/VLESS/Trojan/Shadowsocks) and a pluggable transport/security stack. For a censorship-bypass reseller this is the single most important ecosystem to master: it is modular, actively developed, and — through **XTLS-Vision + REALITY** and the newer **XHTTP** transport — currently the strongest general-purpose anti-DPI stack in open source. Everything below is built from these cores; your own branded protocol is almost certainly best implemented as a thin config/UX layer over **Xray-core**.

### 6.1 The core projects (all open source, all verified)

| Project | Repo | Role |
|---|---|---|
| **Xray-core** | `github.com/XTLS/Xray-core` (MPL-2.0) | The reference implementation. Forked from v2fly-core at v1.0.0; home of VLESS, XTLS-Vision, REALITY, XHTTP. This is where new anti-DPI tech lands first. |
| **Xray-examples** | `github.com/XTLS/Xray-examples` | Official, copy-pasteable inbound/outbound configs (REALITY, Vision, all-in-one fallbacks + Nginx). |
| **Project X docs** | `xtls.github.io` | Canonical protocol/transport reference. |
| **v2ray-core (v2fly)** | `github.com/v2fly/v2ray-core` | The community continuation of the original V2Ray. Home of VMess/VMess-AEAD. More conservative; lacks XTLS/REALITY/XHTTP. |
| **sing-box** | `github.com/SagerNet/sing-box` (GPL-3.0) | "Universal proxy platform." Client + server for VLESS/VMess/Trojan/SS/Hysteria2/TUIC/WireGuard/ShadowTLS, with REALITY and V2Ray transports (ws/grpc/http/quic). Much lighter than v2ray-core; the best modern client core. |
| **SagerNet/v2ray-core** | `github.com/SagerNet/v2ray-core` | SagerNet's V2Ray fork feeding its Android clients. |
| **Popular GUI clients** | `2dust/v2rayN` (Win), `2dust/v2rayNG` (Android) | The clients your customers actually run; both consume Xray-core and speak all of the above. |

For your markets (Ethiopia, Nigeria, Saudi Arabia, Bangladesh) the practical shape is: **Xray-core on the VPS, v2rayNG / NekoBox / sing-box on the handset, config delivered as a `vless://` link or subscription.**

### 6.2 Protocols (the proxy/authentication layer)

These define how the client is authenticated and how the destination request is framed *inside* the tunnel. They are orthogonal to transport and TLS.

| Protocol | Auth / crypto | Notes for your use |
|---|---|---|
| **VMess** | UUID + time-based AEAD header (`alterId:0` = VMess-AEAD, now mandatory). Encrypts payload itself (AES-GCM/ChaCha20-Poly1305). | Legacy. Self-encrypting, time-synced, higher overhead, and its header has a detectable pattern under active probing. Keep only for backward compatibility. |
| **VLESS** | UUID only, **stateless, no built-in encryption** (`encryption:"none"`). Tiny header: version, 16-byte UUID, addons length, addons, command, port, addr. | The modern default. Because VLESS carries *no* crypto of its own, it delegates confidentiality to TLS/REALITY and adds **flow control (`flow`)** for XTLS. Lowest CPU, no time-sync problems. This is what your product should ship. |
| **Trojan** | Password (SHA-224) sent inside a real TLS session; on wrong password the server serves a decoy site. | Designed to look exactly like HTTPS to a webserver. Solid, simple, well-supported by CDNs, but has no equivalent of Vision/REALITY on its own — it *needs* a real cert. |
| **Shadowsocks (SS)** | Pre-shared key, AEAD (2022 edition: `2022-blake3-aes-128/256-gcm`, `chacha20-poly1305`). | Not a V2Ray-native protocol but first-class in every core. A featureless stream — fast and simple, but a bare SS stream is the *easiest* thing for a modern DPI to flag, so it is usually wrapped (v2ray-plugin ws/tls, ShadowTLS, or run behind a CDN). |

### 6.3 Transports (how the bytes are framed on the wire)

Transport decides what the tunnel *looks like* to the network. In current Xray, `streamSettings` selects one (the newest docs rename `tcp`→`raw` and `network`→`method`; older `"network"` keys still work everywhere).

| Transport (`network`) | Wire appearance | Port/CDN | Speed | Anti-DPI value |
|---|---|---|---|---|
| **raw / tcp** | Raw stream (usually under TLS/REALITY). | 443 direct | Highest (enables XTLS splice) | Best *direct* stealth with Vision+REALITY; **not CDN-able**. |
| **WebSocket (ws)** | HTTP `Upgrade: websocket` + `Host`/`path`. | 443, **CDN-friendly** | Good | The classic CDN/free-net carrier. Arbitrary `Host` header = the "payload" trick (§6.7). |
| **gRPC** | HTTP/2 `POST` with `application/grpc` framing, `serviceName` = path. | 443, CDN-friendly (needs H2 end-to-end) | Good, multiplexed | Blends with legitimate gRPC/API traffic; survives some CDNs that mangle ws. |
| **HTTP/2 (h2)** | Real HTTP/2 streams. | 443, CDN-ish | Good | Requires TLS; less used since XHTTP. |
| **HTTPUpgrade** | Like ws but a plain one-shot HTTP `Upgrade` (no ws framing overhead). | 443, CDN-friendly | Good | Lighter ws replacement for CDNs. |
| **mKCP** | **UDP**-based reliable transport (KCP) with optional obfuscation `headers` (fake `wireguard`/`srtp`/`utp`/`dtls`/`wechat-video`). | UDP, non-CDN | High throughput on lossy/high-latency links, **wastes bandwidth** (ARQ) | Useful on bad mobile links; the fake header disguises the UDP as game/VoIP traffic. |
| **QUIC** | UDP + QUIC. | UDP, non-CDN (native) | High | Largely superseded — QUIC's own fingerprint is now well-known; XHTTP-over-H3 through a CDN is preferred. |
| **XHTTP (a.k.a. SplitHTTP)** | Ordinary-looking HTTP `GET`/`POST` request-response(s). | 443, **best CDN carrier**, can even ride H3→H2 conversion | Very high with stream modes | The newest and most flexible. Detailed in §6.4. |

### 6.4 XHTTP / SplitHTTP — "Beyond REALITY"

REALITY hides *server identity*; XHTTP attacks a different tell — the fact that every classic proxy is **one long, featureless encrypted tunnel**, which correlation/TLS-in-TLS heuristics can flag. XHTTP instead disguises traffic as **normal, discrete HTTP request/response behaviour** (a page load, a form POST, an SSE stream), and it is the transport that makes CDN carriage clean.

**Modes** (`mode` in `xhttpSettings`):
- **`packet-up`** — maximum compatibility. Uploads become a series of `POST /path/<uuid>/<seq>` requests (incrementing sequence, server reassembles out-of-order, `scMaxBufferedPosts` deep); download is a single streamed `GET /path/<uuid>`. Best for stubborn CDNs/reverse proxies. Tradeoff: many small POSTs hurt low-upstream (ADSL/1 Mbps) links.
- **`stream-up`** — the uplink is one long streamed `POST` (masqueraded with `Content-Type: application/grpc`), removing per-packet overhead. Ideal for REALITY/direct where you don't need CDN packet-splitting.
- **`stream-one`** — a single request carries both directions (request body up, response body down); the default under REALITY.
- **`auto`** — TLS+H2 → stream/one behaviour, REALITY → stream-one, otherwise packet-up.

**Why it beats DPI and rides CDNs:**
- **Up/down stream splitting.** Uplink and downlink are only linked by the `<uuid>` in the path, not at the connection level. Via `downloadSettings` you can send the *upload* over one path (e.g. IPv4/TCP/TLS/H2 direct) and pull the *download* over a completely different one (e.g. IPv6/QUIC/H3 through a CDN). A DPI box that analyses a single flow sees only half a conversation — TLS-in-TLS length correlation breaks.
- **CDN absorption + H3→H2 conversion.** CDNs/Nginx downgrade client H3(QUIC) to H1/H2 toward origin, so the client can enjoy "QUIC over CDN" while your server only listens on TCP. Traffic is indistinguishable from ordinary CDN-fronted web apps.
- **Header padding & cache-buster headers.** Random `X-Padding` / `Referer?x_padding=…` (`xPaddingBytes`, default `100-1000`) kills fixed-length fingerprints; responses carry `X-Accel-Buffering: no`, `Cache-Control: no-store`, `Content-Type: text/event-stream` to look like Server-Sent Events and to stop CDN buffering.
- **XMUX** multiplexes many proxied requests over each H2/H3 connection (`maxConcurrency`, `maxConnections`, `cMaxReuseTimes`, `hMaxReusableSecs`) so connection churn also mimics a browser.

Key fields: `path`, `host`, `mode`, `xPaddingBytes`, `scMaxEachPostBytes` (keep < CDN body limit, default ~1 MB), `scMinPostsIntervalMs`, `scMaxBufferedPosts`, plus `downloadSettings` for true split routing. Good community write-up: `github.com/net4people/bbs` issue #440.

### 6.5 Security layers — plain TLS → uTLS → XTLS-Vision → REALITY

This is where the anti-DPI power lives. `security` in `streamSettings` is one of `none`, `tls`, `reality`.

**Plain TLS.** A genuine TLS 1.3 session with a real cert (Let's Encrypt) for a domain you own. Confidential and normal-looking, but it has two tells a serious censor exploits: (1) your *server's* TLS fingerprint/cert is yours, and the SNI is a domain that can be blocklisted; (2) tunnelled traffic is **TLS-in-TLS**, whose record-length rhythm differs from real browsing.

**uTLS (fingerprint mimicry).** Bare Go/OpenSSL TLS has a distinctive **ClientHello** (JA3/JA4 = hash of TLS version + cipher list + extension order + curves). uTLS (`refraction-networking/utls`) lets the client emit a byte-exact copy of a real browser's ClientHello. In Xray it's the `fingerprint` field (`"chrome"`, `"firefox"`, `"safari"`, `"randomized"`, 50+ presets). REALITY uses uTLS internally so the outbound handshake is a real Chrome hello. This defeats JA3/JA4 classifiers that flag "this is a proxy client, not a browser."

**XTLS-Vision (`flow: "xtls-rprx-vision"`).** Vision solves the **TLS-in-TLS** problem for direct (non-CDN) connections:
- It pads the *inner* handshake records so the tell-tale length signature of a nested TLS 1.3 handshake is smeared out.
- After the handshake it stops re-encrypting and uses **`splice()`** — a Linux kernel zero-copy path that forwards the already-encrypted TCP stream directly between sockets, never copying through userspace. Result: near-line-rate throughput and low CPU (important when you're reselling one VPS to many users).
- `xtls-rprx-vision-udp443` is the variant that lets browser QUIC through; plain `xtls-rprx-vision` blocks UDP/443 to force browsers onto TCP-443 (so more traffic can be spliced and the flow looks more uniform).

**REALITY — the headline feature.** REALITY removes the last two tells that plain TLS leaves (your cert, and a blockable SNI) **without you owning any domain**:

- **`dest`** points at a real, high-reputation site that *the censor already allows* and that supports TLS 1.3 + X25519 (e.g. `www.microsoft.com:443`, an Apple/Bing domain). **`serverNames`** lists the SNI(s) clients must send — these are that *real* site's names.
- On connect, the client sends a normal ClientHello (via uTLS) with the allowed SNI, but embeds a **stealth authenticator** derived from a shared **X25519 key** (`privateKey` on server, `publicKey` on client) plus a **`shortId`**, hidden inside the ClientHello's key material.
- The REALITY server checks that authenticator:
  - **Legitimate client →** the server itself completes the TLS handshake, mints an on-the-fly temporary cert chained/borrowed from the target, and switches the session into your proxy. The client trusts it because it authenticated out-of-band; no CA, no purchased domain, no forged public cert on the wire.
  - **Anyone else (an active prober, or a censor's browser) →** the server **transparently reverse-proxies the entire TLS session to the real `dest`**. The prober receives the genuine certificate of `www.microsoft.com`, a real handshake, and a real webpage. There is nothing to distinguish your server from a legitimate reverse proxy / the real site.

Net effect: **no fake certificate exists** (so cert anomaly detection finds nothing), **the SNI is a genuinely allowed domain** (so SNI blocklisting can't touch it without collateral-blocking Microsoft/Apple), and **active probing yields a real website** (so probe-and-block fails). REALITY works only with `raw`, `xhttp`, and `grpc` — not ws/httpupgrade/mKCP.

### 6.6 Multiplexing — mux.cool, XUDP, XMUX

- **mux.cool** (`v1.mux.cool`) pools many logical sub-connections onto one TCP session (frame-per-substream, per-sub ID + status; `concurrency` = max substreams). Enable on the **client only**; the server adapts. It cuts connection setup for many-small-request workloads **but** it *reduces* per-stream throughput and, critically, **breaks XTLS splice** (Vision wants one real connection to splice), so for a Vision+REALITY product you generally **leave mux off**.
- **XUDP** carries UDP (incl. full-cone NAT for gaming/VoIP) over the same mux, with a stable per-source-2-tuple ID so a reconnect keeps the same outbound port.
- **XMUX** is the XHTTP-native multiplexer (§6.4) that lets many requests share H2/H3 connections while mimicking browser connection reuse.

### 6.7 CDN fronting through Cloudflare — and the free-net / "payload" angle

CDN-carriage is what makes both censorship-bypass *and* zero-rated "free-net" work, and it needs a **CDN-compatible transport: ws, gRPC, HTTPUpgrade, or XHTTP** (never raw/Vision/REALITY, which are direct-only).

- **How it works:** your domain is proxied ("orange cloud") through Cloudflare. Clients connect to `443` on a Cloudflare edge IP; the edge terminates TLS and forwards by `Host` + `path` to your origin Xray inbound. You get Cloudflare's IPs and TLS as cover, the origin IP is hidden, and the traffic is indistinguishable from any Cloudflare-hosted site. Community edge helpers exist too, e.g. a Cloudflare **Worker** reverse proxy `github.com/PdYrust/cf-xray-proxy` (VLESS/VMess/Trojan over ws/xhttp/httpupgrade).
- **Caveats:** Cloudflare's free plan proxies only certain ports and has idle-stream timeouts (~10–125 s) that can drop long download streams — XHTTP's keepalive/resume and packet-up modes exist partly to survive this; heavy tunneling can also trigger Cloudflare abuse flags.
- **The free-net / zero-rated "payload" connection to your market.** In the HTTP-Injector ecosystem the classic bypass is a **`Host`/SNI "payload"**: carriers zero-rate (don't bill) traffic to certain whitelisted domains, and they classify by the **SNI in the TLS ClientHello or the HTTP `Host` header**, not by destination IP. Because ws/gRPC/HTTPUpgrade/XHTTP let you set an **arbitrary `Host`/SNI** that is decoupled from where the bytes actually go (the CDN routes by your secret `path`), you can front the tunnel with a zero-rated Host and have the carrier bill it as free. This is a **transport-layer trick, and it is transport-agnostic** — it is *not* what REALITY/Vision are for (those target censorship/DPI, and REALITY deliberately uses a *real* SNI you don't control). Be honest with yourself operationally: zero-rating holes are carrier-specific, fragile, and get patched; REALITY/Vision stealth is durable. A serious product ships **both paths**: REALITY+Vision (direct, fast, censorship-proof) *and* a CDN ws/XHTTP profile with a settable Host (for free-net/SNI-payload and for when direct IPs are blocked).

### 6.8 Fallbacks and port-sharing on 443

Xray can host **many protocols/transports on a single `443`** and hand off by TLS SNI, ALPN, and `path`, with a decoy website as the final fallback — this is what makes a server look like an ordinary HTTPS host:

- A VLESS/Trojan TLS inbound terminates TLS, then `fallbacks[]` route by `path`/`alpn`/`name(SNI)`: e.g. `path:/vlws → VLESS-ws`, `path:/vmtc → VMess-tcp`, `alpn:h2 → gRPC/Trojan-h2`, and **anything unmatched or with a wrong password/short first packet → Nginx serving a real site**. Official example: `XTLS/Xray-examples` → `All-in-One-fallbacks-Nginx`.
- REALITY has its own built-in fallback (the `dest` reverse-proxy), so a REALITY inbound needs no Nginx to pass active probing.

### 6.9 Why VLESS+Vision+REALITY and XHTTP actually defeat DPI/SNI-blocking/probing

| Attack by censor | Plain TLS proxy | VLESS + Vision + REALITY | VLESS + XHTTP (+CDN) |
|---|---|---|---|
| **SNI blocklist** | Blockable (your domain) | SNI is a real allowed domain (Microsoft/Apple) — collateral damage to block | SNI is the CDN/fronted domain |
| **Cert/server fingerprint** | Your cert = flaggable | No cert of yours on the wire; uTLS = real Chrome hello | CDN's real cert |
| **Active probing** | Probe may reveal proxy | Probe gets the *real* target website | Probe gets normal HTTP/CDN response |
| **TLS-in-TLS length correlation** | Detectable | Vision inner-padding + kernel splice | Up/down split + HTTP request framing breaks the single-tunnel pattern |
| **IP blocklist** | Origin exposed | Origin exposed (direct) → rotate IPs | Origin hidden behind CDN |

Speed: **Vision+REALITY (direct)** is the throughput king because of `splice()` zero-copy — best for video/large downloads on a good path. **XHTTP** trades a little overhead for CDN-grade blend-in and IP hiding, and its stream modes keep it fast; **mKCP** wins only on lossy/high-latency mobile links at the cost of wasted bandwidth.

### 6.10 Essential inbound config skeletons (Xray-core)

**A) VLESS + Vision + REALITY on raw/TCP 443 (direct — your fastest, most censorship-proof profile):**
```json
{
  "inbounds": [{
    "listen": "0.0.0.0", "port": 443, "protocol": "vless",
    "settings": {
      "clients": [{ "id": "<UUID>", "flow": "xtls-rprx-vision" }],
      "decryption": "none"
    },
    "streamSettings": {
      "network": "raw",              // newest docs: "raw"; older: "tcp"
      "security": "reality",
      "realitySettings": {
        "show": false,
        "dest": "www.microsoft.com:443",
        "serverNames": ["www.microsoft.com"],
        "privateKey": "<x25519-private>",   // `xray x25519` generates the pair
        "shortIds": ["", "0123abcd"]
      }
    }
  }]
}
```

**B) VLESS + XHTTP + REALITY (direct, single-port, CDN-shaped behaviour):**
```json
{
  "inbounds": [{
    "port": 443, "protocol": "vless",
    "settings": { "clients": [{ "id": "<UUID>" }], "decryption": "none" },
    "streamSettings": {
      "network": "xhttp",
      "security": "reality",
      "realitySettings": {
        "dest": "www.microsoft.com:443",
        "serverNames": ["www.microsoft.com"],
        "privateKey": "<x25519-private>", "shortIds": [""]
      },
      "xhttpSettings": { "path": "/<secret>", "mode": "auto" }
    }
  }]
}
```
(Note: under REALITY, `flow` is left empty for XHTTP — Vision's `flow` is for the raw/TCP profile.)

**C) VLESS + XHTTP + TLS behind Cloudflare (CDN / free-net Host profile):**
```json
{
  "inbounds": [{
    "port": 8443, "protocol": "vless",
    "settings": { "clients": [{ "id": "<UUID>" }], "decryption": "none" },
    "streamSettings": {
      "network": "xhttp",
      "security": "tls",
      "tlsSettings": { "certificates": [{ "certificateFile": "...", "keyFile": "..." }] },
      "xhttpSettings": { "path": "/<secret>", "host": "cdn.yourdomain.com", "mode": "packet-up" }
    }
  }]
}
```
Client sets its own `host`/SNI here — this is the field you expose as the "payload/Host" in a free-net profile. Swap `network` to `ws`/`httpupgrade`/`grpc` for CDNs that mishandle XHTTP.

### 6.11 Bottom line for your business

For your own protocol, **standardise on VLESS over Xray-core** and ship two profiles from one server on `443`:
1. **VLESS + XTLS-Vision + REALITY (raw)** — the durable, high-speed, censorship-proof default (Ethiopia/Saudi DPI, SNI-blocking, active probing all fail).
2. **VLESS + XHTTP/ws + TLS over Cloudflare** — origin-hiding, IP-block-resistant, and the vehicle for zero-rated `Host`/SNI "payloads" in the free-net markets.

Use **sing-box** (or `v2rayNG`/`v2rayN`/NekoBox) as the client core, deliver configs as `vless://` subscription links, and keep VMess/SS only for legacy compatibility. This stack is the current open-source state of the art for exactly the ecosystem you operate in — and every piece of it is auditable in the repos listed in §6.1.

---

## 7. QUIC-based fast protocols — Hysteria2, TUIC, and why UDP wins

For lossy last-mile carrier networks — congested 3G/4G in Addis Ababa, throttled MTN/Glo APNs in Lagos, packet-shaped Zain/STC links in Riyadh, GP/Robi in Dhaka — the single biggest performance lever is **getting off TCP-over-TCP**. QUIC-based protocols (Hysteria2, TUIC) run the tunnel over UDP, sidestep the "TCP meltdown" doom loop, and add a fixed-rate congestion controller that refuses to back off under loss. This is why free-net operators are migrating payload/SNI OpenVPN + SSH stacks toward QUIC cores.

### 7.1 Why UDP wins on carrier networks (the core thesis)

When you tunnel a TCP proxy inside a TCP transport, you stack two reliability layers that fight each other:

- **TCP meltdown / retransmission storm.** The outer TCP guarantees in-order, reliable delivery. On a lossy link its retransmit timer is slow; the *inner* TCP times out first and retransmits the *same* segment, so the tunnel now carries the packet twice. Buffers fill with redundant copies, minor loss compounds into collapse, and throughput falls off a cliff. This is the classic reason OpenVPN-over-TCP and SSH tunnels "die" on bad mobile signal.
- **Head-of-line (HOL) blocking.** A single TCP tunnel is one ordered byte-stream. One lost segment stalls *everything* multiplexed behind it — even packets that already arrived cannot be delivered to the app until the gap is filled.

QUIC (RFC 9000) fixes both structurally:

| Property | TCP tunnel (OpenVPN/TCP, SSH) | QUIC tunnel (Hysteria2 / TUIC) |
|---|---|---|
| Transport | TCP (kernel, reliable, ordered) | UDP + QUIC in user space |
| Reliability layers | Two (meltdown risk) | One — QUIC does its own loss recovery once |
| Multiplexing | One ordered stream → HOL blocking | Independent streams; loss on stream A doesn't stall stream B |
| Unreliable path | Retransmit-or-stall | **Datagram extension (RFC 9221)** carries UDP payload with no retransmit |
| IP change (Wi-Fi↔LTE, CGNAT rebind) | Connection dies, full reconnect | **Connection migration** via Connection ID — tunnel survives |
| Handshake | TCP + TLS round trips | TLS 1.3 inside QUIC; **0-RTT/1-RTT** resume |
| Congestion control | Kernel CUBIC (backs off on loss) | User-space, swappable (BBR / **Brutal** fixed-rate) |

The practical payoff on carrier links: because streams are independent, a browser tab losing a packet doesn't freeze the VoIP call in another stream; because of connection migration, a subscriber walking from Wi-Fi to mobile data keeps the same tunnel; and because congestion control lives in user space, the operator — not the kernel — decides how aggressively to push bytes.

### 7.2 Hysteria2 (apernet/hysteria) — in depth

**Repo:** `apernet/hysteria` (the org now shows as **HyNetworks/hysteria**; the apernet path redirects) — MIT, ~22k★. Tagline: *"a powerful, lightning-fast, and censorship-resistant proxy,"* built on *"a customized QUIC protocol… designed for unreliable and lossy networks."* Protocol spec: `apernet/hysteria/blob/master/PROTOCOL.md`.

**Transport & masquerade.** Hysteria2 is a TCP+UDP proxy over QUIC (RFC 9000 + datagram extension RFC 9221). It deliberately **looks like HTTP/3**: the client authenticates by sending an HTTP/3 `POST /auth` request carrying headers `Hysteria-Auth` (credential), `Hysteria-CC-RX` (client's declared receive rate, bytes/s), and `Hysteria-Padding`. On success the server returns HTTP **status 233** with `Hysteria-UDP`, `Hysteria-CC-RX` (`auto` or a value), and padding. Crucially, if the request is *not* a valid Hysteria auth — i.e. a censor or curious scanner probes the port — the server falls through to its **masquerade** behavior and behaves like a real web server. That "decoy site" is configurable:

```yaml
masquerade:
  type: proxy            # or 'file' (static dir) or 'string'
  proxy:
    url: https://news.ycombinator.com/   # reverse-proxy a real site
    rewriteHost: true
  listenHTTP: :80        # optional plain-HTTP decoy
  listenHTTPS: :443      # optional TLS decoy on the same host
  forceHTTPS: true
```

To an active prober the box is just a QUIC/HTTP3 web server serving a legit page — no proxy fingerprint.

**Framing.** Each proxied TCP connection gets its own QUIC bidirectional stream (`TCPRequest`, ID `0x401`: varint-length + target address + padding; server replies status byte `0x00` OK / `0x01` error). UDP is relayed as `UDPMessage` over QUIC **datagrams**: 32-bit session ID, 16-bit packet ID, fragment metadata, address, payload — sessions are implicit and IDs are reused after idle. Because UDP rides datagrams, lost UDP packets are simply lost (correct behavior) instead of triggering tunnel-wide stalls.

**Salamander obfuscation.** QUIC has a recognizable handshake shape; some carriers/DPI (and the Great-Firewall-style stacks copied into other markets) block or throttle QUIC outright. Salamander is an optional XOR scrambler applied per QUIC packet: generate a random 8-byte salt, compute `BLAKE2b-256(salt ‖ pre-shared-key)`, then XOR the packet bytes against the hash stream. Result: every packet looks like uniform random noise with no QUIC/TLS fingerprint. Config is symmetric:

```yaml
obfs:
  type: salamander
  salamander:
    password: <psk shared with clients>
```

(Newer builds add **"Gecko"**, which wraps Salamander and additionally *fragments* the QUIC handshake datagrams into randomly-sized, randomly-padded pieces to defeat first-packet/datagram-size classifiers.)

**Ports, port hopping & port range.** Hysteria2 has no mandated port — operators pick UDP ports that survive their carrier (commonly **443/UDP** to blend with HTTP/3, plus **80/UDP** and custom ports like **5666/UDP**). The censorship-resistance trick is **port hopping**: the client is pointed at a *range* and rotates continuously so no single UDP flow lives long enough to be rate-limited or blocked.

- **Client:** address syntax accepts lists and ranges — `example.com:443`, `example.com:20000-50000`, or mixed `example.com:443,5666,20000-50000`. Rotation is set under `transport.udp`: `hopInterval: 30s` (fixed, min 5s) **or** `minHopInterval`/`maxHopInterval` for randomized, harder-to-profile hops.
- **Server (Linux built-in):** `listen: :20000-50000` — Hysteria binds the first port and auto-installs nft/iptables NAT rules redirecting the whole range to it, cleaning up on exit.
- **Server (manual):** e.g. `iptables -t nat -A PREROUTING -i eth0 -p udp --dport 20000:50000 -j REDIRECT --to-ports 443` (nftables equivalent uses a `dstnat` prerouting chain redirecting `udp dport 20000-50000` to `:443`).

So one real listener on 443 absorbs thousands of ephemeral client ports.

**Bandwidth override & the Brutal congestion controller.** This is Hysteria's headline (and most controversial) feature. Instead of probing for available bandwidth like CUBIC or BBR, **Brutal sends at a fixed, user-declared rate**. The client tells the server "my downlink is X Mbps" and the server paces packets at exactly that rate — and on packet loss it *speeds up* ("loss compensation") to keep the *delivered* rate at the target rather than backing off.

```yaml
bandwidth:
  up: 100 mbps
  down: 200 mbps
  disableLossCompensation: false   # turn off the "send faster on loss" behavior
ignoreClientBandwidth: false       # true → server ignores the hint & uses BBR-style CC
```

- `ignoreClientBandwidth: true` disables Brutal and reverts to standard (BBR-like) congestion control — the polite mode.
- `disableLossCompensation: true` keeps Brutal's fixed rate but stops the extra loss-driven acceleration (more stable on some links).

**BBR vs Brutal — the honest tradeoff:**

| | BBR / CUBIC | Brutal (Hysteria) |
|---|---|---|
| Behavior on loss | Interprets loss as congestion → **slows down** | **Ignores loss** signal; even sends *faster* to hit target |
| Rate discovery | Probes/estimates the path | None — takes a fixed number from the user |
| On lossy 4G | Throughput collapses with loss | Holds target rate through 3–10% loss |
| Fairness to neighbors | Shares the bottleneck | **Unfair** — steals bandwidth from co-existing flows |
| Risk | Slow but well-behaved | Fast but abusive; if X is set too high it just floods loss |

Research (Censored Planet, *"Is Custom Congestion Control a Bad Idea for Circumvention Tools?"*) and even the author's own commentary acknowledge Brutal breaks congestion-control fairness — it works precisely *because* it refuses to cooperate. For a reseller this is a double edge: it delivers the "fast even on bad signal" experience customers pay for, but on a shared VPS it can starve your *own* other tunnels, and an over-declared bandwidth just converts the link into a loss machine. Set `down`/`up` to a realistic per-user cap, not the server's line rate. (The same algorithm is available standalone as a Linux kernel module, **`HyNetworks/tcp-brutal`**, for TCP-based stacks.)

**Built-in auth backend + traffic-stats API — the operator hooks.** Hysteria2 ships exactly what a reseller panel needs, no patching required:

- **HTTP auth backend.** With `auth.type: http`, on every new connection the server does a live `POST` to your `auth.http.url` with `{"addr": "<client ip:port>", "auth": "<credential>", "tx": <declared rate>}` and expects `{"ok": true, "id": "<username>"}`. That single call lets an external daemon check quotas/expiry/device caps in real time and map the connection to a billing identity. (Simpler `password`, `userpass`, and `command` backends also exist.)
- **Traffic Stats API.** Enable with `trafficStats: { listen: :9999, secret: <token> }`; all calls carry `Authorization: <secret>`:
  - `GET /traffic` → `{"user":{"tx":…,"rx":…}}` (add `?clear=1` to reset counters after reading — ideal for billing intervals).
  - `GET /online` → `{"user": <device_count>}` for concurrent-device enforcement.
  - `POST /kick` with body `["user1","user2"]` disconnects users instantly (note: clients auto-reconnect, so also block them in the auth backend).
  - `GET /dump/streams` for per-stream `ss`-style debugging.

### 7.3 TUIC v5 (tuic-protocol/tuic) — in depth

**Repo:** `tuic-protocol/tuic` (formerly `EAimTY/tuic`) — GPL-3.0, ~3.3k★, *"Delicately-TUICed 0-RTT proxy protocol."* Spec: `SPEC.md`, protocol version `0x05`. The Rust reference server/client is comparatively minimal today; most deployments run TUIC via sing-box or mihomo (below).

TUIC is the leaner cousin: a straightforward QUIC proxy focused on **0-RTT** and **Full-Cone NAT** UDP. Five commands: `Authenticate 0x00`, `Connect 0x01` (TCP), `Packet 0x02` (UDP), `Dissociate 0x03`, `Heartbeat 0x04`.

- **Auth.** UUID + password, but the token isn't sent in cleartext: the client derives a 256-bit token via the **TLS Keying Material Exporter** on the live TLS session (label = UUID, context = password), binding auth to the exact TLS handshake.
- **0-RTT everything.** TCP: client opens a bi-di stream, sends `Connect`, and starts piping data *without waiting* for the server's reply. UDP: a 16-bit **association ID** identifies a session; the server lazily creates a UDP socket per ID on first packet — giving 0-RTT **Full-Cone** UDP, which matters for gaming, VoIP and P2P that carrier NAT otherwise mangles.
- **UDP-over-stream vs native.** TUIC's signature flexibility: UDP can ride **QUIC unidirectional streams** (mode `quic` — reliable, lossless, for VoIP/DNS reliability) or **QUIC datagrams** (mode `native` — lossy, low-latency, for real-time). `Packet` carries `PKT_ID/FRAG_TOTAL/FRAG_ID` so large datagrams fragment across QUIC frames; the server answers on whichever mode it received.
- **Congestion control.** User-space and swappable per the QUIC library — **`cubic`, `new_reno`, `bbr`** (BBR is the usual pick for lossy mobile). TUIC does *not* ship a Brutal-style fixed-rate mode; it stays within cooperative CC, so it's "well-behaved but not magic" compared to Hysteria2.

**Hysteria2 vs TUIC — quick contrast:**

| | Hysteria2 | TUIC v5 |
|---|---|---|
| Camouflage | HTTP/3 masquerade + decoy site + Salamander/Gecko obfs | Plain QUIC/TLS-SNI (no built-in obfs or decoy) |
| Congestion control | **Brutal** fixed-rate (+ BBR fallback) | cubic / new_reno / **bbr** (cooperative only) |
| Port hopping | Built-in (client range + server NAT) | Not built-in |
| Operator tooling | HTTP auth backend + traffic/online/kick API | None native — comes from sing-box/mihomo panel layer |
| Best for | Max speed on hostile/DPI'd carrier links | Clean low-latency UDP, gaming/VoIP, Full-Cone NAT |
| Reference maturity | Large, feature-rich core | Lean core; usually run via sing-box/mihomo |

### 7.4 Ecosystem support (what actually exists in OSS)

- **`SagerNet/sing-box`** — supports **Hysteria2 as both inbound (server) and outbound (client)** with `up_mbps`/`down_mbps`, `obfs` (salamander/gecko + password), password `users`, masquerade, `ignore_client_bandwidth` and `brutal_debug`; and **TUIC** as a separate inbound/outbound. This is the single most useful "one binary, all protocols" core for a combo box.
- **mihomo (MetaCubeX)** — clash-compatible core; documents both Hysteria2 and TUIC client/server support (per the MetaCubeX wiki).
- **`HyNetworks/tcp-brutal`** — Brutal ported to a Linux kernel module for TCP stacks.
- **Honest gap:** the *panel/reseller* layer — the daemon that answers Hysteria's HTTP auth, meters `/traffic`, enforces quotas, and cross-manages OpenVPN — is generally **custom or closed-source**. There is no dominant, canonical open-source "Hysteria2 + OpenVPN unified billing panel"; operators build the bridge themselves against the documented APIs. Say so plainly to anyone claiming a turnkey OSS panel.

### 7.5 Putting it together — a "combo server" (Hysteria2 + OpenVPN + bridge daemon)

Your `5666/443/80 UDP + Salamander` example is a textbook combo layout. The key insight: **Hysteria2 is UDP, OpenVPN's payload/SNI tricks are usually TCP** — so they can share the same IP and even the same port number (443/UDP for Hysteria vs 443/TCP for the OpenVPN/stunnel front) without colliding, because the OS keys sockets on transport+port.

- **Hysteria2 listener(s):** UDP on **443** (blends with HTTP/3), with **80/UDP** and **5666/UDP** as alternates, or a hop range like `:20000-50000` NAT-redirected to 443. `obfs: salamander` defeats QUIC-blocking carriers. `masquerade.proxy` serves a real decoy site so probes to 443 see a plausible web server. `bandwidth.down` set per plan tier so Brutal delivers the "fast on bad signal" feel without over-flooding.
- **OpenVPN (the free-net / payload side):** separate TCP/UDP listeners (e.g. TCP 110/143/443 behind the SNI or HTTP-injector payload) for the zero-rated APN tricks the market relies on. This is where the "free-net" host-header/SNI abuse lives; Hysteria2 is the *paid, fast* tier alongside it.
- **The bridge daemon (live HTTP auth + traffic monitoring):** one service is the glue:
  1. **Auth:** Hysteria's `auth.type: http` calls the daemon's endpoint per connection with `{addr, auth, tx}`; the daemon checks the *same* user DB that gates OpenVPN (expiry, plan, device cap) and returns `{ok, id}`. Unified accounts across both protocols.
  2. **Metering:** the daemon polls Hysteria's `GET /traffic?clear=1` and `GET /online` on the stats port every interval, adds it to the user's OpenVPN byte counts (pulled from OpenVPN's management/status interface), and enforces quotas centrally.
  3. **Enforcement:** over-quota or expired → daemon `POST /kick`s the Hysteria session *and* kills the OpenVPN session via its management socket, and flips the account so the next HTTP auth returns `{ok:false}` (otherwise Hysteria clients auto-reconnect).

That is the whole architecture: QUIC/Brutal for speed and DPI-resistance, Salamander/masquerade for stealth, port hopping for blocking-resistance, and Hysteria2's built-in auth + stats APIs as the seam where a single bridge daemon fuses the fast QUIC tier and the legacy OpenVPN payload tier into one billed, monitored product.

---

## 8. DNS-tunnel and custom-UDP transports (free-net, gaming, VoIP)

These two transport families sit at the "last resort" end of the free-net stack. DNS tunnels trade almost all throughput for reach: they punch through captive portals and zero-rated packages where *only* DNS (or DNS-looking traffic) is billed at zero. Custom-UDP tunnels do the opposite: they give up nothing on speed and add real UDP + low latency, which is what gaming, VoIP and torrents actually need, but they only work on carriers whose zero-rating leaks UDP. In both cases the tunnel is a *transport* underneath the same SSH/OpenVPN account layer covered earlier — the DNS or UDP pipe carries an SSH (or SOCKS/OpenVPN-UDP) session that does the real proxying.

### 8.1 DNS tunneling — SSH/TCP inside DNS queries

**Why it works as a bypass.** A recursive resolver will forward a query for `<data>.tunnel.example.com` all the way to whatever authoritative nameserver is delegated for `tunnel.example.com` — even if the client has no general internet access. If you *own* that authoritative server, you own a bidirectional channel that rides on the one protocol almost every captive portal and "social/DNS" zero-rated bundle must leave open. Operators exploit this two ways:

- **Zero-rated / free DNS**: some bundles (or the pre-auth captive state) meter UDP/53 or DNS-over-HTTPS to a whitelisted resolver at zero cost; the tunnel hides an SSH session inside that "free" DNS.
- **Captive portals / hotspot walled gardens**: DNS resolves before you log in, so a DNS tunnel gives connectivity through the paywall.

**Mechanism (all three tools share this shape).** Upstream data (client → server) is packed into the **query name** itself: the payload is chunked, encoded to a DNS-label-safe alphabet (**Base32**, or Base64/Base128 where the path allows), and split into `≤63`-byte labels forming a hostname `≤253` bytes. Downstream data (server → client) is stuffed into the **answer**, using whichever record type carries the most bytes: **NULL/PRIVATE** (biggest), then **TXT**, **SRV**, **MX**, **CNAME**, **A** (smallest). The result is a request/response ping-pong with tiny frames and a hard round-trip dependency — the reason DNS tunnels are slow and jittery no matter how fast the underlying link is.

| Tool | Repo (verified) | Transport / records | Crypto & auth | Reliability layer | Practical throughput |
|---|---|---|---|---|---|
| **iodine** | `github.com/yarrick/iodine` | Plain UDP/53; NULL/PRIVATE, TXT, SRV, MX, CNAME, A; Base32/64/64u/128 auto-probed; EDNS0; **raw-UDP fallback** if 53 is open end-to-end | Password login (shared secret); **no payload encryption** | TUN device, per-fragment ACK, "lazy mode" to cut ping | ~tens–few-hundred kbit/s down; can spike higher on raw-UDP fallback |
| **dnstt** (David Fifield) | `bamsoftware.com/software/dnstt/`, mirror `github.com/getlantern/dnstt` | **DoH + DoT + plain UDP** DNS; data in QNAME up / response down; Base32 upstream | **Noise `Noise_NK_25519_ChaChaPoly_BLAKE2s`** (server authenticated by pinned public key, encrypted E2E) | **KCP** (ARQ/retransmit) + **smux** (stream mux) so client streams without waiting per query | Low, but usable for SSH; DoH/DoT hide the tunnel from the local network |
| **SlowDNS** (`sldns`) | injector autoscripts, e.g. `github.com/powermx/dnstt` ("SlowDNS (dnstt)"), `github.com/fisabiliyusri/SLDNS`, `github.com/leitura/slowdns` | UDP/53 + local 5300, plus DoT/DoH client modes | Public-key (dnstt-style) | KCP/smux (inherited) | Community figures ~≤3 Mbps down cap; realistically far less |
| **dns2tcp** (older "SlowDNS" base) | `github.com/alex-sector/dns2tcp` (+ fork `github.com/cxytz01/dns2tcp`) | UDP/53; TXT/KEY; Base64 | Simple key ID, **no encryption** | Plain TCP relay, no ARQ mux | Low; legacy |

**dnstt — the important one.** dnstt is the technically strongest of the three and the actual engine behind most modern "SlowDNS" builds. Its design cleanly separates three layers: (1) a **DNS carrier** that can be plaintext UDP/53 *or* DoH/DoT to a normal public resolver (so the local network sees only encrypted DNS to, say, Cloudflare/Google, not a suspicious raw tunnel); (2) a **Noise NK** channel that encrypts everything and pins the server's Curve25519 public key, so the recursive resolver in the middle can't read or MITM the tunnel; and (3) **KCP + smux**, which turn the lossy, half-duplex query/response channel into a reliable multiplexed stream — the client keeps sending without blocking on each answer, and lost "packets" (dropped queries) are retransmitted. Setup requires **NS delegation**: you point `NS`/glue for a subdomain at your VPS, run the dnstt server bound to the tunnel, and clients hit it through any resolver.

**SlowDNS lineage (important for this market).** In the HTTP-Injector / autoscript ecosystem, "**SlowDNS**" almost always means the `sldns` server binary bundled by installers — and that binary is a **rebranded/rebuilt dnstt** (public-key auth, DoH/DoT client modes, KCP). This is explicit in repos like `powermx/dnstt` titling itself "SlowDNS (dnstt)" and multi-service autoscripts (`osproject-vpn/Autoscript`, `NevermoreSSH/VVV`) listing "DNSTT/SLOWDNS" as one item. The *name* SlowDNS historically also attached to older **dns2tcp**-based tools, but the current injector `slowdns` you'll deploy is dnstt-derived. Typical installers: `hidessh99/autoscript-ssh-slowdns`, `Amirhossein227/autoscript-ssh-slowdns`, `devseckobz/SSH-SLOWDNS-INSTALLER`. Autoscripts usually expose it on UDP/53 (+ a local 5300), iptables-redirect 53→tunnel, and stitch it to an SSH/Dropbear account so the phone's injector dials SSH-over-DNS.

**iodine** is the classic full-IP DNS VPN (it builds a TUN and routes IPv4), auto-negotiates the best record type and encoding, and — critically — **falls back to raw UDP** if it detects port 53 flows freely, which is much faster than pure DNS framing. It has **no encryption**, so operators layer SSH/OpenVPN on top. It's less common in the Android-injector world (which prefers the SSH-over-DNS `sldns` model) but is the reference implementation for the technique.

**Throughput reality — say it plainly.** Every DNS tunnel is bottlenecked by (a) the round-trip per query, (b) the ~few-hundred-byte payload ceiling per exchange, and (c) recursive-resolver caching/rate-limits. Expect **tens of kbit/s to low single-digit Mbit/s at best**, high latency, and instability under load. It is fine for SSH shell, light browsing, chat and keeping a session alive on an otherwise-dead SIM; it is unusable for video, gaming or VoIP. Sell it as a *reachability* product, not a *speed* product.

### 8.2 Custom-UDP transports — ZIVPN, udp-custom, BadVPN udpgw

**Why UDP + low latency matters here.** SSH and OpenVPN-TCP tunnels suffer TCP-over-TCP meltdown and add latency; for the three workloads customers actually pay for on "free-net" — **online gaming (PUBG/CoD/FreeFire), VoIP/video calls, and torrents** — you need genuine **UDP with low, stable latency and no head-of-line blocking**. These tools exist to (a) provide a fast UDP carrier that some carriers zero-rate or fail to throttle, and (b) restore *real UDP* to SSH stacks that otherwise only proxy TCP.

| Tool | Repo (verified) | What it is / based on | Ports & framing | Auth | Role |
|---|---|---|---|---|---|
| **ZIVPN UDP** (`udp zivpn`) | installer `github.com/zahidbd2/udp-zivpn`; also `github.com/powermx/zivpn`, `github.com/potatonc/zivpn-udp`, `github.com/diegoallies/udp-encrypto-vpn-source`; app at `zivpn.com` | **QUIC/UDP tunnel, Hysteria-v1-style** (self-signed TLS cert + `obfs` XOR scramble) | Listens **UDP :5667**; iptables DNAT of a wide range **6000–19999 → 5667** (hop/spread); TLS1.3-over-QUIC datagrams | `config.json`: `auth.mode:"passwords"`, `config:["zi",…]`; `obfs:"zivpn"` | Fast UDP overlay for gaming/streaming on zero-rated UDP |
| **udp-custom** | `github.com/feely666/udp-custom`, `github.com/Haris131/UDP-Custom`, `github.com/http-custom/udp-custom`, `github.com/NNdroid/udp_custom`; installer `github.com/rudi9999/SocksIP-udpServer` | Compiled (C/Go) UDP forwarder for injector "UDP Custom / SocksIP" clients | `config.json` at `/root/udp/config.json`; can bind wide UDP ranges with a port-exclude list (e.g. exclude 53,5300) | Ties to **system/SSH accounts** (`useradd -M -s /bin/false -e <expiry>`) | Gives injector apps a UDP entrypoint mapped to SSH accounts |
| **BadVPN udpgw** | `github.com/ambrop72/badvpn` | UDP-gateway daemon for **tun2socks** | **`badvpn-udpgw --listen-addr 127.0.0.1:7300`**; tun2socks adds `--udpgw-remote-server-addr 127.0.0.1:7300` | None itself (rides the SSH/SOCKS tunnel) | Restores real UDP forwarding through a SOCKS/SSH tunnel |

**ZIVPN UDP (`udp-custom`/`udp zivpn`).** The community `zahidbd2/udp-zivpn` installer pulls a prebuilt `udp-zivpn-linux-amd64` (arm build too), drops `/etc/zivpn/config.json` + a self-signed `zivpn.crt`/`zivpn.key`, and runs the server as a systemd unit with `CAP_NET_ADMIN`/`CAP_NET_RAW`. The **config schema — `listen`, `cert`, `key`, `obfs` (a string), `auth:{mode:"passwords", config:[…]}` — is exactly Hysteria v1's server format**, which matches ZIVPN's own description of being "customized based on Hysteria." So mechanically it is a **QUIC tunnel** (QUIC = UDP + TLS1.3 + built-in streams/datagrams and modern congestion control) with Hysteria's simple **`obfs` XOR packet scramble** so the UDP payload doesn't look like TLS/QUIC to a DPI box, and **password auth** (default `zi`). The signature trick is the **iptables DNAT of UDP 6000–19999 down to :5667** — a huge listen range so the app can "port-hop"/pick any port the carrier zero-rates, all landing on one server process. This is why it's the dominant *fast* free-net UDP in Africa: near-line-rate, low latency, good for gaming/VoIP where the carrier leaks UDP. Note the "encryption" here is weak (shared static password + XOR obfs, self-signed cert with no real verification) — it's censorship/DPI evasion, not strong privacy.

**udp-custom (the C/"SocksIP" family).** These are the servers behind the "UDP Custom" and "SocksIP" injector clients. They're a compiled UDP forwarder configured by `config.json` (commonly `/root/udp/config.json`) that can grab a broad UDP port range (with an exclude list so you don't clobber 53/5300 used by SlowDNS), and — crucially — they **authenticate against the box's SSH/system users** (`useradd` with an expiry date), so the *same account* a reseller sells for SSH/SSL also works for UDP-Custom. That tight coupling to SSH accounts is what makes them fit the reseller model. Documentation is thin and several repos ship binaries rather than source (`rudi9999/SocksIP-udpServer` even pulls its binary from a third-party Bitbucket), so audit before trusting.

**BadVPN udpgw — real UDP for the SSH stack.** This is the piece that makes gaming/VoIP work *through an SSH tunnel* at all. `tun2socks` (also in `ambrop72/badvpn`) turns a SOCKS proxy into a TUN device so a whole phone can route through SSH — but SOCKS5 only cleanly proxies **TCP**. To carry UDP (DNS, game traffic, RTP voice, WebRTC, torrent), tun2socks offloads UDP to a small daemon, **`badvpn-udpgw`, listening on `127.0.0.1:7300`** on the SSH server; tun2socks is pointed at it with `--udpgw-remote-server-addr 127.0.0.1:7300`, and UDP datagrams are framed over the existing SSH channel to that gateway, which sends them out as real UDP and relays replies. Almost every Android SSH/VPN injector (HTTP Injector, HTTP Custom, etc.) bundles udpgw on **7300** for exactly this reason — without it, "SSH VPN" games and calls fail. It's mature, permissively licensed C, and the de-facto standard; there is little competing OSS because it simply works.

### How these combine with the SSH/OpenVPN stack

- **DNS tunnel + SSH**: `sldns`/dnstt on UDP/53 carries an **SSH** session (Dropbear/OpenSSH account) → SOCCKS/HTTP proxy on the phone. Reachability product for dead SIMs / captive portals; very slow.
- **ZIVPN QUIC-UDP**: standalone fast UDP overlay (its own password auth), often sold beside the SSH/SSL accounts; best when the carrier zero-rates or ignores UDP. Great for gaming/VoIP, weak crypto.
- **udp-custom + SSH accounts**: UDP entrypoint bound to the same system users as SSH, so one credential set spans TCP and UDP.
- **udpgw + tun2socks over SSH/OpenVPN**: the glue that gives an SSH tunnel *actual* UDP for games/calls/torrents on port **7300**.

### Honest OSS assessment

- **Strong, canonical OSS exists** for: DNS tunneling (`yarrick/iodine`, David Fifield's **dnstt**) and UDP-for-tun2socks (`ambrop72/badvpn` udpgw). These are well-understood, auditable, and the reference for the mechanism.
- **The injector-specific tools are thin, fork-heavy, and often binary-only.** "SlowDNS" is mostly repackaged dnstt inside installer scripts; "ZIVPN"/"udp-custom" servers are Hysteria-v1-derived or closed prebuilt binaries wrapped in `config.json`+auth glue, frequently mirrored across many near-identical repos with no real documentation. Treat the ZIVPN/udp-custom binaries as **DPI-evasion transports with weak/shared-secret crypto**, verify checksums/build from source where you can, and layer real crypto (SSH/OpenVPN/WireGuard) on top for anything sensitive.

---

## 9. SSH tunneling family (SSH-WS, SSH-SSL, SlowDNS, HCR, SOCKS engine)

Every "free-net" injector config, no matter how exotic the outer wrapper, almost always terminates in the same place: an **SSH session that exposes a local SOCKS proxy**. SSH is the workhorse because it does three things a reseller needs at once — it authenticates a *per-user account* (so accounts can be sold, dated, and revoked), it *multiplexes* many TCP streams over one connection, and its dynamic forwarding turns the client into a **local SOCKS5 server** the phone's OS can be routed through. Everything else in this family — WebSocket, TLS/stunnel, DNS, HTTP header injection — is just a **camouflage transport** wrapped around the same SSH byte-stream so it survives DPI, SNI filtering, or a zero-rated (`0.0.0.0`-billed) "payload" host. This section walks the whole chain from the innermost SSH handshake outward.

### 9.1 The core: plain SSH dynamic SOCKS (`ssh -D`) and the "SOCKS engine"

The primitive underneath the entire family is **SSH dynamic port forwarding**:

```
ssh -D 1080 user@server        # OpenSSH client becomes a SOCKS5 server on 127.0.0.1:1080
```

- `ssh -D` makes the client **listen locally and speak the SOCKS4/SOCKS5 protocol**. Any app that hands it a `CONNECT host:port` request gets a new channel opened *inside* the encrypted SSH connection; the **server** dials `host:port` on the client's behalf and relays bytes. `-L` is a fixed single-target tunnel; `-D` is the dynamic, "any destination" variant that makes SSH a general proxy.
- Transport is **TCP only** and framed as SSH channels; congestion control is whatever the OS TCP stack does on the single carrier connection. Crypto is the SSH transport layer (modern ciphers: `chacha20-poly1305`, `aes-*-gcm`; key exchange `curve25519`). There is **no UDP** inside a stock SSH tunnel — this matters below.

Inside an injector app, this is repackaged as the **"SOCKS engine"**: the app runs (or embeds) an SSH client, exposes a **local SOCKS listener** (typically `127.0.0.1:1080`), then uses a **VpnService `tun` interface + a tun2socks/redsocks shim** to capture *all* device traffic and feed it into that SOCKS port. The open-source [`JeelsBoobz/http-injector`](https://github.com/JeelsBoobz/http-injector) (and the near-identical [`noobconner21/http-ssl-ssh-injector`](https://github.com/noobconner21/http-ssl-ssh-injector)) shows the anatomy plainly — Python `ssh.py`/`tunnel.py`/`inject.py` plus compiled **`redsocks`/`redsocks64`** binaries and an `iptables`/`redsocks.conf` redirect so the OS is transparently NAT'd into the local SOCKS proxy. Because SSH carries no UDP, these stacks pair the SOCKS engine with **`badvpn-udpgw`** (a UDP-gateway helper) so DNS and game/UDP traffic can be relayed as framed datagrams over the TCP tunnel — that is why nearly every autoscript below installs `badvpn-udpgw` on port `7300`.

**Speed/stability tradeoff:** one SSH connection = one TCP flow, so all your streams share a single congestion window → **head-of-line blocking** and poor throughput on lossy mobile links. It is rock-solid for chat/browsing, mediocre for HD video, and this single-flow limitation is the reason resellers layer KCP (SlowDNS) or move heavy users to V2Ray/Xray.

### 9.2 Dropbear vs OpenSSH — why Dropbear dominates the reseller VPS

Autoscripts almost universally run **both** `sshd` (OpenSSH) and **Dropbear**, but expose Dropbear on the "customer" ports. Reasons:

| Factor | OpenSSH `sshd` | Dropbear |
|---|---|---|
| Footprint | Multi-MB suite | Single multi-call binary (~110 kB); tiny RAM per process |
| Per-connection cost | Heavier | Very light → **hundreds of thin injector sessions** on a cheap VPS |
| Multi-port | One daemon, `Port` lines | Trivially launched on **several ports** (e.g. 143, 109, 442, 990) so a payload can pick whatever port the ISP leaves open |
| Auth style | Keys-first culture | Comfortable with **password-only** accounts (what resellers sell) |
| Features | Full (SFTP subsystem, agent, etc.) | Minimal; no SSHv1 — smaller attack surface |

The practical pattern: **OpenSSH on 22** for admin, **Dropbear on many alternate ports** for customers, and the WS/stunnel front-ends (below) forward to **Dropbear's** local port. Dropbear's low per-session memory is exactly what makes "one $5 VPS, 300 accounts" economics work.

### 9.3 SSH-over-WebSocket (SSH-WS)

The most popular transport today, because a WebSocket **Upgrade** looks like ordinary HTTP(S) and rides through HTTP proxies, CDNs, and captive portals.

**Mechanism (step by step):**
1. Client opens TCP (port 80) or TLS (port 443) to a **WS front-end**.
2. Client sends an HTTP/1.1 request with a **payload** in the headers — e.g. `GET / HTTP/1.1`, `Host: <zero-rated-host>`, `Upgrade: websocket`, `Connection: Upgrade`. In injector apps the payload is a template with tokens like `[host]`, `[crlf]`, `[cr][lf]`.
3. The front-end answers **`101 Switching Protocols`** and from then on the socket is a **raw bidirectional pipe** — in the free-net variant the proxy usually **does not do real RFC-6455 framing/masking**; after the 101 it just splices bytes to the backend `dropbear:22`/`:109`.
4. SSH handshake now runs *inside* that pipe; the SOCKS engine comes up on top.

**Open-source WS front-ends / patterns:**
- **`ws-proxy` / "ws-epro" (Go):** the small Go WebSocket-to-TCP relay bundled by the autoscripts (e.g. it is the "High-Performance Go WebSocket Proxy" installed by [`FreeNetLabs/AutoScriptX`](https://github.com/FreeNetLabs/AutoScriptX)). It reads a config of listener ports → target `127.0.0.1:<dropbear>`. *(I saw it referenced as `ws-proxy`/`ws-epro` inside these scripts but could not verify a single canonical upstream repo, so I name it without a link rather than guess one.)*
- **Pure-Python bridges** embedded in scripts such as `lib/sshws.py` in [`superbad1/sshwsxray`](https://github.com/superbad1/sshwsxray) — no dependencies, does the 101 handshake then raw-forwards to local sshd.
- **General-purpose, well-maintained tunnels** (heavier but robust, real framing): [`erebe/wstunnel`](https://github.com/erebe/wstunnel) (Rust, static binary, WS **and HTTP/2**, explicitly DPI-bypass), [`mhzed/wstunnel`](https://github.com/mhzed/wstunnel) and [`sammck-go/wstunnel`](https://github.com/sammck-go/wstunnel) (Go), [`google/huproxy`](https://github.com/google/huproxy) (HTTP-Upgrade proxy meant to carry SSH via `ProxyCommand`), [`mishas/wstunnel`](https://github.com/mishas/wstunnel) (SOCKS5-over-WS), and [`ukoloff/wssh`](https://github.com/ukoloff/wssh).
- **Client-side reference:** [`tavgar/Custom-Internet`](https://github.com/tavgar/Custom-Internet) is a clean Python read of the whole client chain — local SOCKS on `127.0.0.1:1080`, three modes (direct / HTTP-payload / SNI-front), Paramiko for the SSH transport, `ws_tunnel.py` for the upgrade payload.
- **CDN/edge fronting (the reader's own pattern):** the repo's `websocket-proxy.js` is a **Netlify Edge Function** that accepts only `Upgrade: websocket` requests and re-`fetch()`es them to a fixed backend host, i.e. a **CDN-fronted WS relay**. Same idea as running the WS listener behind Cloudflare/Fastly: the TLS SNI shows the CDN's domain (often zero-rated or un-blockable), while the tunnel rides the WS body to your origin. This is transport camouflage + free-billing exploitation in one hop; its weakness is that the CDN sees (and can terminate) plaintext WS to your origin and can bill/close abusive edge functions.

### 9.4 SSH-over-SSL/TLS — "SSH-SSL" on 443 via stunnel

Here SSH is wrapped in a **real TLS record layer** so on the wire it is indistinguishable from HTTPS, defeating port-22 blocks and plaintext DPI.

- **Server:** `stunnel` listens on **443**, terminates TLS with a cert, and `connect = 127.0.0.1:<dropbear/openssh>`. Config is literally `accept = 443` / `connect = 127.0.0.1:222`.
- **Client:** the injector opens TLS to `:443` (often with a **custom SNI** = a zero-rated/whitelisted domain, since SNI is sent in cleartext and is what many DPI systems key on), then speaks SSH inside. Injectors call this **"SSH-SSL"** or **"SNI"** mode.
- Frequently combined with `sslh` (a protocol demux on 443 that can serve HTTPS *and* SSH on the same port). Reference configs: [`FosterG4/stunnel`](https://github.com/FosterG4/stunnel) and the "SSH over 443 with stunnel/sslh" [gist](https://gist.github.com/Raymo111/55bc3b830abadf2da1f5eebc980e62e8).
- **Tradeoff:** strong against SNI-blind DPI and port blocks; **beaten by SNI whitelisting** unless you front a permitted SNI, and it adds a TLS handshake RTT. TLS-in-TLS (if the backend is itself TLS) is also increasingly fingerprintable.

### 9.5 SSH-over-DNS — "SlowDNS" (dnstt)

The last-resort transport for captive portals that let **only DNS** (UDP/53) leak before you log in/pay. "SlowDNS" as shipped by the autoscripts is **David Fifield's `dnstt`**, usually renamed to `sldns-server`/`sldns-client`.

- **Canonical upstream:** the bamsoftware project — [dnstt homepage](https://www.bamsoftware.com/software/dnstt/), with a written [protocol spec](https://www.bamsoftware.com/software/dnstt/protocol.html) and [security notes](https://www.bamsoftware.com/software/dnstt/security.html); git at `www.bamsoftware.com/git/dnstt.git` ([repo.or.cz mirror](https://repo.or.cz/dnstt.git)). GitHub mirrors/forks: [`Mygod/dnstt`](https://github.com/Mygod/dnstt), [`tladesignz/dnstt`](https://github.com/tladesignz/dnstt), [`powermx/dnstt`](https://github.com/powermx/dnstt).
- **How it works:** you delegate an **NS record** (`t.example.com`) to your VPS. The client encodes upstream bytes into **DNS query names** (subdomain labels) and the server answers with data in **TXT/CNAME/etc. responses** — so it works through *any* recursive resolver, including **DoH/DoT** (encrypting the fact that DNS carries a tunnel). Because DNS is request/response and lossy, dnstt stacks **KCP (reliable ARQ over unreliable) + smux (stream multiplexing) + Noise protocol** for end-to-end encryption and **server public-key auth** (`server.pub`/`server.key`). The **"tt" = Turbo Tunnel**: the client need not wait for each response before sending more.
- **Deployment detail:** the daemon binds a high port (commonly **5300**) and `iptables` redirects public **UDP 53** to it. It only wires a **local TCP port to a remote TCP port** (like `ssh -L`); the autoscript points that remote port at Dropbear, so you get **SSH-inside-SlowDNS**.
- **Tradeoff:** extremely censorship-resistant (survives portals that block everything but DNS) but **very low throughput and high latency** by construction — fine for keeping a session alive / light browsing, painful for video. Autoscripts: [`khtechlife/SlowDNS-AGN`](https://github.com/khtechlife/SlowDNS-AGN), [`tcatvpn/DNSTT3`](https://github.com/tcatvpn/DNSTT3), [`hidessh99/autoscript-ssh-slowdns`](https://github.com/hidessh99/autoscript-ssh-slowdns), [`stellawills/slowdns`](https://github.com/stellawills/slowdns), [`wegare123/slowdns`](https://github.com/wegare123/slowdns).

### 9.6 SSH "HCR" / HTTP-Custom-Request (CONNECT + injected header)

**HCR = the raw HTTP payload method** used to reach the SSH port *through* an intermediate HTTP proxy or a zero-rated host, without WS or TLS. Two flavours:

- **Proxy `CONNECT` (tunnel through an explicit/transparent HTTP proxy):** the client sends `CONNECT <ssh-host>:<port> HTTP/1.1` (often with injected `Host:`, `X-Online-Host:`, `X-Forward-Host:` headers pointed at a **free/zero-rated domain**). A permissive or misconfigured operator proxy replies `200 Connection established` and blindly pipes bytes → SSH handshake proceeds inside. Equivalent to `ssh -o ProxyCommand="nc -X connect -x proxy:port %h %p"`.
- **"Front/back query" header splitting (the classic `.ehi`/HTTP-Custom payload):** the client emits a crafted request (`GET`/`POST`/`CONNECT`) whose **Host/SNI/URL is a zero-rated domain the ISP bills at 0**, using `[crlf]`/`[split]`/`[delay_split]` tokens to break the request so the **billing engine sees the free host** while the **routing/proxy still forwards to your SSH server**. This is deliberate **HTTP Host-header vs. real-destination mismatch** (the domain-fronting idea applied to plaintext + carrier billing). Injector references and SNI-front variants: [`kirula0626/SNI_Injector`](https://github.com/kirula0626/SNI_Injector), [`miyurudassanayake/sni-injector`](https://github.com/miyurudassanayake/sni-injector), and the client modes in [`tavgar/Custom-Internet`](https://github.com/tavgar/Custom-Internet).
- **Tradeoff:** cheapest and lightest (no TLS/WS overhead), but the **payload is the whole product** — it breaks the moment the carrier fixes the billing loophole or the DPI starts validating that `Host` matches the real TCP destination. This is the most fragile transport and the reason resellers churn payloads constantly.

### 9.7 Putting it together: proxy + payload + SSH handshake + SOCKS chain

For a typical **SSH-WS with payload** config, the ordered chain is:

1. **App captures OS traffic** via VpnService `tun`; routes it to the internal **SOCKS engine** at `127.0.0.1:1080` (UDP siphoned to `badvpn-udpgw`).
2. **Outer dial:** open TCP to the *proxy/front host* — a bug/zero-rated IP, a real HTTP proxy, or a CDN edge (:80/:443).
3. **Payload / handshake:** send the HTTP **Upgrade/CONNECT payload** with the injected `Host`/SNI camouflage. Receive **`101`** (WS) or **`200`** (CONNECT), or complete the **TLS** handshake (SSL/SNI mode). The socket is now a raw pipe to the backend.
4. **SSH handshake** runs inside the pipe: version exchange → KEX (curve25519) → **password auth** with the sold account → channel setup.
5. **Dynamic SOCKS up:** SSH now serves the SOCKS engine; each app `CONNECT` becomes an SSH channel; the **server egresses to the real internet**. DNS/UDP go via udpgw.

Swap step 2–3's wrapper and you get the other family members (TLS→SSH-SSL, DNS/KCP→SlowDNS, bare CONNECT→HCR) while steps 1, 4, 5 stay identical — which is exactly why one server can sell "one account, many modes."

### 9.8 Server-side autoscripts: provisioning, expiry, limits, lock-multi-login

These are the "one-command VPS" installers resellers actually run. They wire **OpenSSH + Dropbear + stunnel + a Go ws-proxy + SlowDNS + badvpn-udpgw** and add a **menu** to mint accounts.

| Autoscript | SSH-WS | SSH-SSL (stunnel) | SlowDNS | Acct expiry | Login/device limit | Notes |
|---|---|---|---|---|---|---|
| [`FreeNetLabs/AutoScriptX`](https://github.com/FreeNetLabs/AutoScriptX) | Go ws-proxy | ✔ | ✔ | ✔ (create/renew/lock/unlock) | menu-managed | Also Nginx, SSHGuard, badvpn-udpgw; cleanest modern OSS example |
| [`NevermoreSSH/hop`](https://github.com/NevermoreSSH/hop), [`Blueblue`](https://github.com/NevermoreSSH/Blueblue), [`VVV`](https://github.com/NevermoreSSH/VVV), [`SkyNode`](https://github.com/NevermoreSSH/SkyNode) | ✔ (80/8880/443) | ✔ | ✔ (DNSTT) | ✔ | ✔ | Also bundle Xray (VMess/VLESS/Trojan) |
| [`superbad1/sshwsxray`](https://github.com/superbad1/sshwsxray) | pure-Python `sshws.py` | ✔ | — | ✔ | ✔ | Good to read the raw 101 bridge |
| [`sanzking/sshvps`](https://github.com/sanzking/sshvps), [`scvps/scriptvps`](https://github.com/scvps/scriptvps) | ✔ | ✔ | varies | ✔ | ✔ | Older Indonesian-lineage scripts |

**How "expiry / limit / lock-multi-login" is actually implemented (it is plumbing, not magic):**
- **Expiry** = the standard Linux account expiry field: `useradd -e YYYY-MM-DD` / `chage -E`, plus a **cron job** that sweeps expired users and deletes/locks them.
- **Password/lock** = `passwd -l` / `usermod -L` and Dropbear reading the same `/etc/shadow`.
- **Lock-multi-login / max devices** = a **watchdog script** (bash or a small daemon) that counts a user's live sessions by parsing `ps aux`/`who` for `sshd`/`dropbear` children (or grepping auth logs) and **kills the excess** when the count exceeds the sold limit (`N` devices). Reference implementations of exactly this pattern: [`misteralipour/shellscripts`](https://github.com/misteralipour/shellscripts) (per-user concurrent-session limiter that parses `ps` and terminates the oldest) and kick helpers like `tavinus/kick.sh`. The autoscripts run their own copy on a cron/systemd timer — that is the entire "1-device lock" feature resellers advertise.

### 9.9 Honest gaps in the OSS

- The **client-side injectors** people actually sell (HTTP Injector, HTTP Custom, TLSVPN, Dark Tunnel) are **closed-source freemium apps**; the open ones ([`JeelsBoobz/http-injector`](https://github.com/JeelsBoobz/http-injector), [`AlizerUncaged/HTTP-Injector`](https://github.com/AlizerUncaged/HTTP-Injector), [`tavgar/Custom-Internet`](https://github.com/tavgar/Custom-Internet)) are useful *references* but not the polished apps end-users run.
- **`ws-epro`/`ws-proxy`** is widely embedded but I could not confirm one canonical, actively-maintained upstream repo — treat the copies vendored inside autoscripts as the de-facto source and audit them before running.
- The **"SOCKS engine + payload"** logic is mostly reimplemented per-app with no shared library; expect subtle differences in payload token syntax (`[crlf]`, `[split]`, `[lf]`) between apps.
- For anything beyond light browsing, this whole family is **throughput-limited by single-flow SSH**; teams that need speed move the same accounts onto **V2Ray/Xray (VMess/VLESS) or Hysteria/QUIC** transports (covered elsewhere in this report), keeping SSH only as the censorship-resistant fallback tier.

---

## 10. Server side — multi-protocol combo servers, multiport, and high traffic

The economics of the HTTP-injector / free-net reseller business push every operator toward the same thing: **one VPS that answers on dozens of ports with a dozen protocols at once**, so a single account can be sold as "works on any network" and any given carrier's zero-rated loophole (a whitelisted SNI, a free `Host:` header, a free UDP port, a free DNS resolver) has a matching service to ride on. This section covers the open-source "combo server" scripts that build these boxes, the architecture patterns that make many services coexist on the same ports (especially 443), the local auth-bridge pattern you are already running, and what actually breaks when you put thousands of clients on one box.

### 10.1 The "combo server" / autoscript ecosystem

The dominant pattern in this market is the **all-in-one bash autoscript**: a single `bash <(curl ...)` installer that compiles/installs OpenSSH, Dropbear, stunnel, OpenVPN, BadVPN-udpgw, SlowDNS, nginx/HAProxy, Xray/sing-box and (increasingly) Hysteria2, wires each into `systemd`, opens the firewall, and drops a numbered TUI menu (`menu`) for creating/trashing/renewing accounts. These are overwhelmingly Indonesian/SEA-origin projects, MIT-ish licensed, and forked endlessly. Quality is uneven and many bundle pinned old binaries — treat them as **reference implementations and parts bins**, not as things to run unread on a production reseller box.

| Project (GitHub, as seen) | What it bundles | Notes |
|---|---|---|
| `shopeevpn/Hysteria-auto-script` | Hysteria core, Xray, v2ray, TrojanGFW, ShadowsocksR, Shadowsocks, WireGuard, OpenVPN, SSH ("9 protocols, one click") | Closest single script to your exact menu; per-protocol `add-*/del-*` scripts |
| `jubairbro/AUTO-SCRIPT` | OpenSSH, Dropbear, stunnel, SSH-WS, SSH-SSL-WS, BadVPN, nginx, Xray (vmess/vless/trojan/ss over WS-TLS / WS / gRPC) | Publishes an explicit port map (see 10.2) |
| `osproject-vpn/Autoscript` | OpenSSH, UDP-SSH, SlowDNS, Dropbear, WS-SSH, OpenVPN SSL/TCP/UDP, **nginx + HAProxy loadbalancer**, Xray vmess/vless/trojan/ss (TLS/gRPC/none) | One of the few that ships HAProxy front-door by default |
| `syapik96/aws`, `helmiau/autoscript-syapik96` | SSH, OpenVPN, Xray, SSR, Trojan, WireGuard (Debian/Ubuntu) | Long-lived, widely forked base |
| `GegeDevs/sshvpn-script` | SSH/VPN combo autoscript (2025-maintained) | Actively updated |
| `deathline94/Hysteria2-Installer` | Standalone Hysteria2 + systemd + client config generator | Clean single-protocol reference for the Hysteria2 piece |
| `hidessh99/autoscript-ssh-slowdns` | SSH + SlowDNS focus | Reference for the DNS-tunnel piece |
| `FANDIAMALA12345/Autoscript` (Gitea) | AIO CLI manager: SSH/WS/OpenVPN/NoobzVPN/SS/V2Ray/Xray, multiport, quotas, backup | Full account-lifecycle TUI |

Others seen in the wild: `hertafga/AUTOSCRIPT`, `potatonc/ScriptAutoInstallPotato`, `scvps/scriptvps`. Honest caveat: none of these is a "canonical" project with a security team — the value is that they encode the *exact port and systemd layout* this ecosystem expects clients (HTTP Injector, HTTP Custom, NapsternetV, SocksIP) to find.

### 10.2 Two architecture philosophies

**(A) Many processes, many ports (the classic autoscript box).** Each protocol is its own `systemd` unit (or Dropbear/OpenVPN instance) bound to its own port(s). A representative real map (`jubairbro/AUTO-SCRIPT`):

| Service | Port(s) |
|---|---|
| OpenSSH | 22 (and 53 for a "no-payload" carrier trick) |
| Dropbear | 109, 143 |
| stunnel4 (TLS wrap over Dropbear/OpenVPN) | 222, 777 |
| SSH-WS (HTTP proxy / WebSocket) | 80 |
| SSH-SSL-WS | 443 |
| BadVPN-udpgw | **7100–7900** (range; single-instance default is **7300**) |
| nginx | 81 |
| Xray vmess/vless/trojan/ss (WS-TLS, gRPC) | 443 |
| Xray vmess/vless/trojan/ss (WS, no TLS) | 80 |

OpenVPN in these builds is typically TCP **1194**, UDP **1194** (or **25000/2200**), plus an "OpenVPN SSL" instance whose TCP socket is fed *through* stunnel on 443/990. This model is simple and matches injector app expectations, but it wastes RAM/PIDs and makes 443 contention the central problem.

**(B) One multi-inbound engine (the modern approach).** A single `Xray-core` (`XTLS/Xray-core`) or `sing-box` (`SagerNet/sing-box`) process exposes **many inbounds** in one config/one PID — Shadowsocks on 8080, Trojan on 443, VLESS-Reality on 443, Hysteria2, TUIC, etc. — sharing one TLS stack, one set of firewall rules, and one gRPC stats API. `sing-box` explicitly folds SS/VMess/VLESS/Trojan/Hysteria2/TUIC/WireGuard into one binary; wrappers like `fscarmen/sing-box` generate multi-protocol configs one-shot. This is what the panels in 10.7 drive. Tradeoff: one crash/segfault takes down everything, and you lose per-protocol `systemd` isolation — but you gain a single control plane and far lower per-connection overhead at scale.

Most serious reseller boxes end up **hybrid**: SSH/Dropbear/OpenVPN/BadVPN/SlowDNS as their own units (they *are* separate daemons), and one Xray-or-sing-box process for all the V2Ray-family + Hysteria2 inbounds behind a shared 443.

### 10.3 Making port 443 serve everything (port-sharing / SNI fan-out)

Three interoperable techniques, in increasing order of flexibility:

- **Xray/Trojan fallbacks (in-process).** A single VLESS/Trojan-over-TCP+TLS inbound on 443 terminates TLS, reads the first bytes, and *falls back* by `(SNI, ALPN, path)` to secondary inbounds or to nginx. `XTLS/Xray-examples` → **All-in-One-fallbacks-Nginx** multiplexes ~18 protocol/transport combos on one 443: `Path=/vlws` → VLESS-WS, `Path=/vmtc` → VMess-TCP, `ALPN=h2 + SNI=trh2o.…` → Trojan-h2, unmatched/invalid creds → nginx serving a real decoy site (defeats active probing). Backends sit on `127.0.0.1:3001/3002/3003` or Unix sockets (`/dev/shm/h1.sock`, `/dev/shm/h2c.sock`) so nothing but 443 is exposed. `fallbacks` requires the TLS ALPN to include `http/1.1` and only works with TCP+TLS. Ref: `xtls.github.io/en/config/features/fallback.html`.
- **nginx as the fallback web layer.** nginx behind Xray does double duty: serves the camouflage website *and* `grpc_pass`-es gRPC streams to the right Xray gRPC listener. This is how vmess-gRPC and a normal HTTPS site live on the same hostname:port.
- **HAProxy/sniproxy SNI routing (in front, TLS passthrough).** For services that each need their *own* TLS (e.g. an OpenVPN-over-TLS backend + an Xray backend + a real site), put HAProxy in `mode tcp` on 443, `tcp-request inspect-delay`, match on `req_ssl_sni`, and `use_backend` per hostname — **no decryption**, each backend does its own handshake. `osproject-vpn/Autoscript` ships this HAProxy loadbalancer pattern by default; `meyskens/sniproxy` is a minimal standalone alternative. This is the cleanest way to let `hysteria.yourdomain`, `trojan.yourdomain` and `www.yourdomain` all answer on one IP:443.

For the injector/free-net angle: whichever front you use, the **SNI value and the WebSocket `Host:`/path are the payload knobs** — resellers pick the exact whitelisted domain the carrier zero-rates as the SNI (TLS) or as the injected `Host:` header (WS/HTTP), and the fallback/SNI router makes sure that hostname lands on the right backend.

### 10.4 The local HTTP "auth bridge" at 127.0.0.1:9998

Your bridge is a specific, correct instance of a general pattern: **gate the fast data-plane protocol with a tiny local HTTP control-plane daemon.** Hysteria2 is designed for exactly this.

- **How Hysteria2 hooks it.** In the server config, `auth: { type: http, http: { url: http://127.0.0.1:9998/... } }`. On every new connection Hysteria2 POSTs JSON `{ addr, auth, tx }` (client IP:port, the client's auth string, requested tx rate) to your bridge; your bridge replies `200` with `{ "ok": true, "id": "<user-id>" }` to admit, anything else to reject. The returned `id` is what all stats are then keyed on. (`type: command` and local `type: userpass` are the non-HTTP alternatives.) Ref: `v2.hysteria.network` External-Auth / Full-Server-Config.
- **How it also does live monitoring.** Hysteria2's `trafficStats: { listen: "127.0.0.1:9998", secret: "..." }` exposes an HTTP API you (or your bridge) poll with an `Authorization: <secret>` header:
  - `GET /traffic` → `{id: {tx, rx}}` byte counters (`?clear=1` resets),
  - `GET /online` → `{id: connection-count}` (device/instance count — how you enforce max-devices),
  - `POST /kick` → JSON array of ids to disconnect (note: clients auto-reconnect, so kicking must be paired with disabling the user in auth),
  - `GET /dump/streams` → per-QUIC-stream detail for deep debugging.

So a bridge on `127.0.0.1:9998` typically **is** both the `auth.http` backend *and* the thing consuming `trafficStats` (or it fronts Hysteria's own trafficStats and adds its own DB): it validates the user against your accounts DB on connect, meters `tx/rx` per `id` for quota enforcement, and reads `/online` to cap simultaneous devices. Binding it to loopback is the right call — it must never be reachable off-box. **OSS gap, stated plainly:** there is *no* well-known turnkey open-source "Hysteria auth+billing bridge" — panels like Marzban/Marzneshin implement this internally, and standalone operators (you) write a small Flask/Go/Node daemon against the documented `auth.http` + `trafficStats` contract. That is expected, not a deficiency.

The equivalent control-plane hooks for the rest of the stack: **Xray/sing-box** expose a gRPC **StatsService** (per-inbound/per-user tx/rx) + **HandlerService** (add/remove users at runtime with no restart) — that is how panels meter and provision without bouncing the process. **OpenVPN** uses its `management` interface / `client-connect`/`auth-user-pass-verify` scripts. **SSH/Dropbear** are gated by real PAM/system users (which is why the autoscripts create Linux users and cron-expire them).

### 10.5 The rest of your menu, mechanically

- **OpenVPN TCP / UDP.** UDP (1194/25000) = lowest latency, best for the free-UDP-port carrier tricks and games; TCP (1194/110/993) = survives bad networks and TCP-only captive proxies, at the cost of TCP-over-TCP meltdown under loss. Both are trivially DPI-fingerprinted, hence:
- **OpenVPN SSL / stunnel / WS.** OpenVPN-TCP is fed through **stunnel** (plain TLS wrapper, looks like HTTPS on 443/990) or through a **WebSocket** wrapper so it reads as a browser hitting a web server. `erebe/wstunnel` (Rust rewrite, single static ~5 MB binary, WS + HTTP/2 transport) is the canonical OSS for "tunnel arbitrary TCP/UDP over WebSocket," and is exactly the kind of thing an injector's `Host:`/upgrade payload targets. The WS+HTTP-proxy inbound on 80 is what HTTP Injector's raw `CONNECT`/`Host:` payloads ride.
- **BadVPN-udpgw (`ambrop72/badvpn`) on 7300.** This is *not* a tunnel — it is a **UDP-over-the-SSH-tunnel gateway**. The phone runs tun2socks and forwards UDP to `badvpn-udpgw --listen-addr 127.0.0.1:7300` on your server; udpgw performs the real UDP sends on the client's behalf so that UDP apps (DNS, games, VoIP, QUIC) work over an otherwise TCP-only SSH/SSL tunnel. It listens on loopback and is reached *through* the SSH session, which is why it's `127.0.0.1:7300` and why injector configs always list "UDPGW 7300." It is CPU-cheap but connection-stateful.
- **SlowDNS / DNS tunneling.** A `dnstt`/`dns2tcp`-derived server that encodes the SSH byte-stream into DNS queries/answers (subdomains up, `TXT`/`CNAME` down) against an NS record you delegate (`ns.yourdomain`). It exploits carriers that leave DNS (port 53 / the captive resolver) unmetered — the "free internet" case. It is **slow and high-overhead** by nature (MTU is a DNS label), fine for chat/keepalive, painful for streaming. OSS here is fragmented forks bundled inside the autoscripts (e.g. `hidessh99/autoscript-ssh-slowdns`) rather than one canonical repo.
- **SSH / Dropbear / stunnel.** The bread-and-butter free-net transport: SSH provides the tunnel + auth (system users), Dropbear adds lightweight extra ports, stunnel TLS-wraps them for 443. Payload/SNI injection happens at the WS/HTTP or stunnel-SNI layer in front.

### 10.6 Surviving high traffic on one box

Concurrency, not bandwidth, is what kills these servers first — thousands of injector clients open many long-lived, often half-broken connections. Baseline hardening:

- **File descriptors.** Every connection ≈ ≥1 fd; the default 1024 is fatal. Set `nofile` to 512k–1M in `/etc/security/limits.conf` **and** `LimitNOFILE=1048576` in each `systemd` unit (systemd ignores limits.conf). Raise `fs.file-max`.
- **Accept/backlog queues.** `net.core.somaxconn` (raise to 8192–65535), `net.ipv4.tcp_max_syn_backlog` (half-open SYN queue), `net.core.netdev_max_backlog` (per-NIC ingress queue) — undersized backlogs show up as clients that "connect then hang" under load. Also `net.ipv4.ip_local_port_range` widened for outbound (proxy egress) fan-out, and `tcp_tw_reuse=1`.
- **conntrack (the classic silent failure).** UDP-heavy stacks (OpenVPN-UDP, BadVPN, Hysteria/QUIC, WireGuard) explode `nf_conntrack`. Raise `net.netfilter.nf_conntrack_max` (e.g. 1,048,576), size the hashtable (`nf_conntrack_hashsize`), lower `nf_conntrack_tcp_timeout_established`. When the table fills you get `nf_conntrack: table full, dropping packet` and total mystery outages — or `NOTRACK` the pure-UDP data ports to bypass conntrack entirely.
- **Congestion control: BBR.** `net.core.default_qdisc=fq` + `net.ipv4.tcp_congestion_control=bbr`. Huge win on the lossy last-miles in your target markets (ET/NG/SA/BD) for all the TCP/TLS/WS transports. Note Hysteria2 runs its *own* congestion control (Brutal/BBR-like) inside QUIC over UDP, independent of the kernel setting, and can be tuned per-profile (`app/v2.8.0`+ exposes BBR profiles + UDP port-hopping ranges).
- **CPU / crypto.** TLS/AEAD throughput is bounded by **AES-NI**; pick VPS SKUs that expose it, and prefer AES-GCM/ChaCha20-Poly1305. Xray/sing-box are Go and scale across cores; OpenVPN's classic data channel is largely **single-threaded per tunnel** (DCO/`ovpn-dco` helps) — a common real bottleneck. Pin IRQ/RSS across cores on multi-queue NICs for QUIC/UDP-heavy nodes.

Rule of thumb the tuning guides converge on: an untuned kernel gracefully handles ~1k concurrent connections; the same hardware handles 100k+ once fds/backlog/conntrack are sized.

### 10.7 Horizontal scaling: panels + node/agent architecture

One box eventually caps out; the way this ecosystem scales is a **central panel + thin node agents**, where the panel holds users/quotas/subscriptions and pushes config + collects stats over a secure channel to many edge nodes running the actual Xray/sing-box/Hysteria.

| Panel / agent (GitHub) | Model | Notes |
|---|---|---|
| `gozargah/marzban` + **Marzban-node** | Panel ↔ node over TLS (REST/gRPC), Xray-core data plane | The de-facto standard; one node container per edge, cert-paired to panel; `XRAY_API_PORT`/`SERVICE_PORT` configurable |
| `marzneshin/marzneshin` + **marznode** | Successor design, multi-node first-class, **Xray + Hysteria2** backends | marznode manages the local vpn backends; panel monitors/enables users across nodes |
| `PasarGuard/panel` | Marzban-lineage rewrite (Python/React), unified multi-node | Active (v3.x) |
| `hiddify/Hiddify-Manager` (org `hiddify`) | 20+ protocols, opinionated all-in-one panel | Client `hiddify/hiddify-app`; heavier, batteries-included |
| `MHSanaei/3x-ui` | Single-box Xray panel with per-client quota/expiry/IP-limit, **multi-node**, REST+Swagger API | Easiest on-ramp; less of a fleet controller than Marzban |
| `ZagrosGM/Zagros-Node` | Standalone multi-core node agent (xray, sing-box, OpenVPN, WireGuard, SSH, SoftEther, PPTP) | Broadest backend coverage in a node agent; Marzban-node hard fork |
| `mikeesierrah/ez-node` | Installer for Marzban/Marzneshin nodes | Ops convenience |
| `wmm-x/marz-x` | Web GUI + server-optimization + one-click Docker for Marzban | Adds visual Xray mgmt + tuning |

Pattern to copy: **panel in one region holds the accounts DB and the subscription generator; nodes are cattle** — cheap regional VPS, each running the multi-inbound engine, provisioned and metered over the panel↔node channel, fronted per-region by HAProxy/nginx (10.3). Your `127.0.0.1:9998` bridge is the single-box version of the same control-plane; the migration path is to move that auth+metering logic into a panel that speaks the Xray gRPC stats/handler API and the Hysteria2 `auth.http`/`trafficStats` API to N nodes.

### 10.8 Mapping to your posted combo-server menu

| Your menu item | What it is / OSS to mirror | Port(s) | Key mechanism |
|---|---|---|---|
| **Hysteria2** | `apernet/hysteria` behind your bridge | UDP 443 (+ port-hopping range) | QUuIC/UDP, masquerades as HTTP/3; own congestion control; `auth.http` → your 9998 |
| **OpenVPN TCP** | OpenVPN + stunnel/wstunnel | 1194/tcp (+ SSL via 443/990) | TCP tunnel; TLS-wrap for DPI evasion |
| **OpenVPN UDP** | OpenVPN | 1194/udp (or 25000) | Low latency; free-UDP-port carrier tricks; watch conntrack |
| **OpenVPN SSL** | OpenVPN-TCP through stunnel | 443/990 | Looks like HTTPS; SNI = zero-rated host |
| **WS + HTTP proxy** | SSH/OpenVPN over WebSocket (`erebe/wstunnel`) + nginx/Xray WS inbound | 80 (WS), 443 (WS-TLS) | Injector `Host:`/`CONNECT` payload rides the WS upgrade |
| **BadVPN 7300** | `ambrop72/badvpn` udpgw | 127.0.0.1:7300 | UDP-over-SSH gateway (tun2socks), loopback-only |
| **Bridge 9998** | your Hysteria auth+monitor daemon | 127.0.0.1:9998 | `auth.http` gate + `trafficStats` (`/traffic`,`/online`,`/kick`) |

**Where OSS is thin (say it plainly):** the glue you already built — the loopback auth/metering bridge tying accounts → Hysteria2 (and ideally → Xray gRPC stats) → quota/device enforcement — has no canonical open-source equivalent for standalone operators; the panels solve it only by absorbing you into their whole stack. SlowDNS is likewise a pile of forks, not a maintained project. Everything else in your menu maps cleanly onto well-maintained upstreams (Xray-core, sing-box, apernet/hysteria, erebe/wstunnel, ambrop72/badvpn) plus the autoscript projects above as wiring references.

---

## 11. Speed & stability engineering — real throughput and stable links

Most "speed boosters" sold in the free-net scene are cargo-cult. Real throughput on a tunnel is governed by three things and nothing else: **the bandwidth-delay product (BDP) you can keep in flight**, **how the transport reacts to loss**, and **where packets queue**. Everything below is a lever on one of those three. Two rules frame the whole section:

- **Throughput ≈ window ÷ RTT**, where window = `min(cwnd, receiver_window, socket buffer)`. If any of those is too small for the path's BDP, you leave bandwidth on the table no matter how fast the link is.
- **A loss-based congestion control (CUBIC, Reno) treats every dropped packet as "the network is full, halve my rate."** On a fiber backbone that is correct. On a 4G/Wi-Fi link in Lagos, Addis or Dhaka where loss is *radio noise*, it is catastrophically wrong — the algorithm throttles itself for a problem that isn't congestion.

### 11.1 TCP congestion control: BBR / BBRv3

BBR ("Bottleneck Bandwidth and RTT") is model-based, not loss-based: it continuously estimates the bottleneck bandwidth and minimum RTT and paces to fill the pipe without overfilling the buffer. Because it does **not** collapse `cwnd` on isolated loss, it holds throughput on lossy mobile links where CUBIC falls off a cliff. Real-world reports put OpenVPN throughput jumping from ~30–40 Mbit/s to near 100 Mbit/s just by switching the server to BBR ([eduVPN](https://docs.eduvpn.org/server/v2/bbr.html), [nixCraft](https://www.cyberciti.biz/cloud-computing/increase-your-linux-server-internet-speed-with-tcp-bbr-congestion-control/)).

The exact server-side enablement (kernel ≥ 4.9):

```
# /etc/sysctl.d/99-net.conf
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
```

Then `sysctl --system`; verify with `sysctl net.ipv4.tcp_congestion_control` and `lsmod | grep bbr`.

- `fq` (fair queue) is BBR's native pacing partner. On modern kernels BBR can pace internally and also works with `fq_codel`, so `fq` is no longer a hard requirement — but pairing BBR with `fq` is still the recommended, best-tested combination ([eduVPN](https://docs.eduvpn.org/server/v2/bbr.html)).
- **BBRv3** (2023→, deployed at Google, specified in an IETF draft) fixes BBRv1's worst trait — aggressive bandwidth-grabbing that starves competing flows — and improves loss/ECN response, convergence and latency for short requests. It is not in mainline Linux; you get it via Google's `google/bbr` tree or patched kernels (e.g. XanMod). BBRv1 remains the pragmatic default because it ships in every stock kernel ([BBRv3 evaluation, arXiv](https://arxiv.org/html/2509.06245v1); [IFIP 2025](https://networking.ifip.org/2025/images/Net25_papers/1571125683.pdf)).

**Honesty caveat:** BBRv1 is *unfair* to CUBIC neighbors and can inflate latency in shallow buffers — that's a feature when you're grabbing bandwidth on a congested tower, a liability if you also host latency-sensitive services on the same box.

### 11.2 Host tuning BBR needs — buffers, notsent_lowat, qdisc

BBR only helps if the socket buffers are large enough to hold a full BDP. **BDP = bandwidth × RTT**; size the max buffer at roughly **2× BDP** (e.g. 100 Mbit/s × 200 ms ≈ 2.5 MB → ~5 MB max). Canonical values from the naiveproxy tuning guide ([klzgrad/naiveproxy wiki](https://github.com/klzgrad/naiveproxy/wiki/Performance-Tuning)):

```
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
net.ipv4.tcp_rmem = 4096 131072 67108864      # min default max (receiver / download side)
net.ipv4.tcp_wmem = 4096 131072 67108864      # min default max (sender / server upload side)
net.ipv4.tcp_slow_start_after_idle = 0        # don't reset cwnd after an idle gap — big win for bursty mobile
net.ipv4.tcp_notsent_lowat = 131072           # cap unsent bytes in the socket → lower app-level latency under load
net.ipv4.tcp_mtu_probing = 1                   # survive MTU black holes (see 11.3)
```

- **Leave TCP auto-tuning on** — the kernel grows the buffer between `min` and `max` per connection; you're only raising the ceiling.
- `tcp_notsent_lowat` keeps the kernel from stuffing megabytes of not-yet-sent data into the socket, which is what makes a mux'd or bulk connection feel laggy for interactive traffic.
- **`tcp_fastopen` (TFO):** saves one RTT on connection setup, but the naiveproxy authors explicitly advise against relying on it — "its Linux implementation is too conservative to be useful," and middleboxes on cellular networks frequently strip the TFO option anyway. Enable (`net.ipv4.tcp_fastopen=3`) only if you measure a gain.

**qdisc choice (fq vs cake vs fq_codel):**

| qdisc | Best role | Notes |
|---|---|---|
| **fq** | VPN/proxy **server** (end-system) with BBR | Pure pacing + flow isolation; BBR's intended partner. No shaping. |
| **cake** | The **egress shaper** on a router/gateway you control | fq_codel + per-host fairness + built-in bandwidth shaping + overhead compensation. Best latency-under-load if you set the rate slightly below line rate. |
| **fq_codel** | Routers/forwarders, *not* end-hosts | Great AQM, but at a **sending end-system it can drop your own packets**, hurting a server. Prefer `fq` or `cake` on the VPN box itself. |

([CAKE/fq_codel, dev.to](https://dev.to/lyraalishaikh/taming-bufferbloat-on-linux-practical-fqcodel-and-cake-with-systemd-networkd-39kb); [systemd #9725](https://github.com/systemd/systemd/issues/9725))

### 11.3 MTU / MSS — the silent throughput killer on tunnels

Every tunnel adds header overhead, so the inner MTU must shrink or every full-size packet fragments. Fragmentation forces CPU reassembly and — critically — **many firewalls drop fragmented UDP outright**, so a tunnel with a too-large MTU doesn't just slow down, it silently blackholes large flows ([ngelinux](https://ngelinux.com/optimizing-wireguard-mesh-throughput-with-mtu-auto-discovery-and-nftables-mss-clamping/); [harryvasanth](https://harryvasanth.com/posts/networking-wireguard-mtu-tuning/)).

- **WireGuard overhead is 60 B (IPv4) / 80 B (IPv6).** On a 1500-byte path, set the wg interface MTU to **1420**. If the underlay is already a lower-MTU carrier (common on mobile/PPPoE), probe the real base with `ping -M do -s <size>` and subtract 80.
- **PMTUD is unreliable** because operators block ICMP "fragmentation needed," creating MTU black holes. Two defenses: `tcp_mtu_probing=1` (packetization-layer PMTUD, works without ICMP), and **MSS clamping** so TCP never negotiates a segment that won't fit.
- **MSS clamp value:** for a 1420 tunnel MTU, MSS = 1420 − 40 = **1380**. Clamp on the gateway so downstream clients are protected even if they never learn the tunnel MTU:

```
# iptables
iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
# nftables
tcp flags syn / syn,rst tcp option maxseg size set rt mtu
```

([Pro Custodibus](https://www.procustodibus.com/blog/2022/12/wireguard-performance-tuning/))

For userspace WireGuard (**wireproxy**, `pufferffish/wireproxy`, formerly `octeep/wireproxy`), MTU still matters and syscall overhead caps UDP throughput; the kernel wg module is 20–40% faster at 10G+. Batched-syscall proxies (`recvmmsg`/`sendmmsg`, as in swgp-go) recover ~50% of that gap ([net4people/bbs #117](https://github.com/net4people/bbs/issues/117)).

### 11.4 The TCP-over-TCP meltdown — and why UDP/QUIC avoids it

**Never run a TCP congestion-controlled transport inside another TCP congestion-controlled transport.** When the outer TCP retransmits after loss, the inner TCP still sees only delay, times out, and *also* queues a retransmission. The inner RTO is often shorter than the outer's, so the inner layer piles retransmissions on faster than the outer can drain them; the two nested control loops fight and the connection stalls into a "meltdown." A second failure mode: the inner layer never sees the loss (the outer hid it), so its `cwnd` keeps growing until it exceeds what the outer window can ever carry ([SPIE study](https://www.spiedigitallibrary.org/conference-proceedings-of-spie/6011/60110H/Understanding-TCP-over-TCP--effects-of-TCP-tunneling-on/10.1117/12.630496.full); [UNLV](https://oasis.library.unlv.edu/compsci_fac_articles/212/)).

Practical consequences for a reseller stack:
- OpenVPN/TCP, Shadowsocks-over-TLS-over-TCP, or any "VLESS-WS-TLS" carrying a user's TCP download **stacks two loss-recovery loops**. It works, but throughput and stability degrade sharply the moment the underlay gets lossy — exactly the mobile condition your markets live in.
- **UDP- and QUIC-based transports have a single loss-recovery layer.** QUIC does its own reliability/ordering, so there is no nested TCP inside; Hysteria, TUIC and WireGuard all ride UDP for this reason. This — not the crypto — is the biggest structural reason QUIC-based tunnels feel faster on bad networks.

### 11.5 Multiplexing (mux.cool / smux / yamux / h2mux) — a latency tool, not a speed tool

Mux carries many logical streams over one physical connection. Its real benefits are **fewer TLS handshakes**, **fewer connections for DPI/CDN to count**, and lower per-request setup latency. It does **not** raise bulk throughput, and often lowers it:

- **Head-of-line blocking:** all streams share one TCP connection, so one lost segment stalls *every* stream behind it. Under load this shows up as speedtests reporting absurd RTT and bufferbloat ([v2fly #3332](https://github.com/v2fly/v2ray-core/issues/3332)).
- The V2Ray/Project-X docs say it plainly: mux "is designed to reduce TCP handshake latency, NOT for high throughput," and is "usually slower than a normal TCP connection" for large downloads or speed tests ([v2fly guide](https://guide.v2fly.org/en_US/advanced/mux.html)).

sing-box exposes three protocols and the knobs that matter ([sing-box multiplex](https://sing-box.sagernet.org/configuration/shared/multiplex/)):

| Protocol | Upstream repo | Character |
|---|---|---|
| `h2mux` | `golang.org/x/net/http2` | sing-box default; HTTP/2 framing |
| `smux` | `xtaci/smux` | Lightweight, widely used (KCP heritage) |
| `yamux` | `hashicorp/yamux` | Robust, heavier framing |

Key fields: `max_connections`, `min_streams`, `max_streams` (mutually exclusive with the first two — cap streams per connection then open another), and `padding` (when enabled server-side, **non-padded connections are rejected** — an anti-DPI feature, not a speed one). Note the known footgun: **`h2mux` + TCP Brutal can keep an unusable session alive and return closed-pipe errors** ([sing-box #4452](https://github.com/SagerNet/sing-box/issues/4452); issue on Brutal+h2mux session eviction).

**Rule of thumb for resellers:** enable mux for many-small-request browsing/streaming profiles; **disable it (or raise `max_streams` so downloads get their own connection) for bulk/speedtest profiles.** Xray's **XMUX** under XHTTP formalizes this — `maxConcurrency` caps sessions per connection and spins up a new connection past the limit ([Xray #6040](https://github.com/XTLS/Xray-core/discussions/6040)).

### 11.6 QUIC: 0-RTT and connection migration

- **0-RTT:** on reconnect, the client sends application data in the first flight using a cached ticket, saving a full round trip — very noticeable on 200 ms+ mobile RTTs. Caveat: 0-RTT data is **replayable**, so it should carry only idempotent/early bytes.
- **Connection migration:** QUIC identifies a connection by a **Connection ID**, not the IP/port 4-tuple. When the phone flips Wi-Fi↔4G or the NAT rebinds, the client keeps sending under a pre-issued CID; the endpoints revalidate the new path with `PATH_CHALLENGE`/`PATH_RESPONSE` and the session survives without a re-handshake ([RFC 9000](https://datatracker.ietf.org/doc/html/rfc9000)). For a mobile-first market this is the single biggest *stability* win QUIC offers — TCP-based tunnels drop and must reconnect on every network change.

### 11.7 Hysteria "Brutal" — a fixed-rate CC for lossy mobile

Brutal inverts normal congestion control: **userspace declares the link's real bandwidth, and the sender paces to that fixed rate regardless of loss or RTT.** It never interprets loss as congestion; instead it has **loss compensation** — on loss it sends *slightly faster* to still hit the target rate. This is why it "seizes" bandwidth on throttled/best-effort towers where CUBIC/BBR back off ([Hysteria2 docs](https://v2.hysteria.network/docs/advanced/Full-Server-Config/); [RAGE guide](https://rage.ac/support/guides/hysteria2/)).

- **It only works if you specify the true max bandwidth.** Over-declare and you inject loss and hurt everyone (including yourself); under-declare and you cap your own speed. In Hysteria2 this is the client `bandwidth: up/down` setting.
- **Fairness cost:** Brutal is deliberately unfair — it trades TCP-friendliness for steady speed. Fine for a single subscriber's tunnel, antisocial if many Brutal flows share one bottleneck.
- **OSS:** the algorithm is real and portable — **`apernet/tcp-brutal`** ports it to TCP as a Linux kernel congestion-control module (`/proc/net/tcp_brutal/rules`, per-connection rate-pinned; default 1 Mbps until set). It's usable from sing-box's `multiplex.brutal` (`up_mbps`/`down_mbps`) and there's an OpenWrt package (`sbwml/package_kernel_tcp-brutal`). ([apernet/tcp-brutal](https://github.com/apernet/tcp-brutal))

### 11.8 Multipath and multi-connection load-spreading

Two different ideas, often confused:

- **MPTCP (RFC 8684, Linux ≥ 5.6):** one logical TCP connection striped across multiple interfaces (e.g. Wi-Fi + 4G) for **bandwidth aggregation** or **seamless failover** — if one path dies, in-flight data is reinjected on the other with near-zero drops. Apps opt in via `GODEBUG=multipathtcp=1` (Go), `LD_PRELOAD` (`mptcpize run …`), or eBPF. Powerful for a bonding gateway, but requires MPTCP support on *both* ends and path managers configured ([kernel docs](https://docs.kernel.org/networking/mptcp.html); [Red Hat](https://www.redhat.com/en/blog/using-multipath-tcp-better-survive-outages-and-increase-bandwidth)).
- **Application-level multi-connection load-spreading:** open N transport connections and stripe requests/streams. **Xray XHTTP/SplitHTTP** does a *bidirectional split* — upload and download can use **separate connections and even separate transports** (e.g. send over QUIC, receive over HTTPS), which sidesteps HOL blocking and plays nicely with CDNs. This raises effective throughput and resilience without kernel MPTCP, at the cost of more connections for DPI to see ([SplitHTTP, Project X](https://xtls.github.io/en/config/transports/splithttp.html); [Xray #4113](https://github.com/XTLS/Xray-core/discussions/4113)).

### 11.9 UDP port hopping

Because UDP has **no transport-layer connection state**, a client can rotate source/destination ports mid-session without any handshake. Hysteria2 uses this to defeat **per-port QoS throttling/blocking**: the server listens on one port, but firewall rules redirect a whole range to it, and the client hops across the range every few seconds ([Hysteria Port Hopping](https://v2.hysteria.network/docs/advanced/Port-Hopping/)).

```
# server: redirect a UDP range to the real listen port (443)
iptables -t nat -A PREROUTING -i eth0 -p udp --dport 20000:50000 -j REDIRECT --to-ports 443
# nftables equivalent
iifname "eth0" udp dport 20000-50000 counter redirect to :443
```
Client URI accepts ranges/lists: `example.com:20000-50000` or `example.com:1234,5000-6000,8000-9000`, with `hopInterval` (min 5 s) or `minHopInterval`/`maxHopInterval`. This is a **censorship/QoS-evasion** win (and mild resilience against single-port drops), **not** a raw-speed feature — its value is keeping the link *usable and un-throttled* on carriers that rate-limit steady single-port UDP.

### The "stacking protocols for speed" myth

Layering VLESS-in-WS-in-TLS-in-CDN, or adding an XOR/obfs scrambler, or double-tunneling, **does not add speed.** Every layer adds framing overhead, and each measured wrap costs roughly **5–20% throughput**; a second loss-recovery layer (see 11.4) can cost far more ([obfuscation overhead](https://b.vpn.how/en/pages/vpn-obfuscation-in-2026-disguising-as-https-pluggable-transports-and-real-world-circumvention-cases.html)). Layering buys exactly one thing: **obfuscation** — hiding the tunnel from DPI, riding a zero-rated SNI/Host, or fronting through a CDN. That is legitimate and often necessary for a payload/free-net business, but it is a *survival* tax, not an accelerator. Keep the obfuscation layer as thin as the DPI environment allows, and never stack it on top of a TCP-in-TCP base. **"Stable 80 Mbps beats a 200 Mbps burst that dies in a minute"** is the correct engineering target.

### Prioritized checklist (highest-impact first)

| # | Action | Why it's high-impact |
|---|---|---|
| 1 | **Use a UDP/QUIC-based transport for the loss-bearing hop** (Hysteria2, TUIC, WireGuard) | Eliminates TCP-over-TCP meltdown — the biggest structural killer on mobile |
| 2 | **Enable BBR + fq on the server** (2 sysctls) | Stops self-throttling on radio loss; near-zero effort, huge gain on lossy links |
| 3 | **Fix MTU/MSS** — wg MTU 1420, clamp MSS to PMTU, `tcp_mtu_probing=1` | Kills silent fragmentation blackholes; often the difference between "works" and "stalls on big files" |
| 4 | **Size socket buffers to ~2× BDP** (`rmem/wmem`, `slow_start_after_idle=0`) | Lets BBR actually fill high-RTT pipes; without it, BBR is capped |
| 5 | **Set Brutal/Hysteria bandwidth to the link's *true* max** | Turns loss-noise into full-rate delivery on throttled towers — but only if honest |
| 6 | **Right-size mux:** off/large-`max_streams` for bulk, on for many-small-request browsing | Removes HOL-blocking bufferbloat from downloads while keeping handshake savings for browsing |
| 7 | **Port hopping** where a carrier QoS-throttles single UDP ports | Keeps the link un-throttled (stability), not raw speed |
| 8 | **Pick the qdisc for the role** — `fq`/`cake` on the box, never `fq_codel` at the sender | Avoids self-inflicted packet loss at the server |
| 9 | **Prefer kernel WireGuard over userspace**; if userspace, use batched syscalls | 20–40% throughput on high-rate paths |
| 10 | **Consider MPTCP / XHTTP bidirectional split** for bonding or CDN-fronted resilience | Aggregation + failover, at the cost of complexity/more visible connections |
| 11 | **Keep obfuscation layers minimal** — layer for DPI survival, never "for speed" | Every layer costs 5–20%; stacking is a tax, not a boost |

---

## 12. Reseller & management panels, subscription systems

This section maps the open-source (OSS) panels that turn a single Xray/sing-box server into a multi-user, multi-seller business: who can create accounts, how usage is metered and billed, how the client apps pull their configs, and how the whole thing scales to more servers. It closes by placing the closed "Vollam"-style panel against these projects.

### 12.1 The two families you are actually choosing between

There are two distinct lineages in this ecosystem, and they rarely overlap:

- **The Xray/sing-box panel family** (3x-ui, x-ui, Marzban, Marzneshin, Hiddify, S-UI, PasarGuard). Modern, Git-native, protocol-rich (VLESS/Reality, VMess, Trojan, Hysteria2, TUIC, WireGuard). Metering is done by reading Xray's own stats counters. Distribution is via **subscription links** consumed by v2rayNG / Hiddify / sing-box / Clash-Meta. This is where almost all active OSS development lives.
- **The SSH / HTTP-Injector "free-net" family** (OpenVPN/SSH autoscripts, OCS-style reseller panels). Older PHP/Bash stacks built to sell SSH-Tunnel/SSL/SlowDNS/OpenVPN accounts with **credits/deposit** and **max-login (session) caps**. Native credit hierarchies exist here, but the code is mostly dormant or closed. **This is the family the Vollam panel belongs to** (see 12.7).

The friction for a reseller business is that the family with the best *credit/reseller* semantics (SSH panels) has the weakest maintenance, and the family with the best *maintenance and protocols* (Xray panels) mostly lacks a native credit wallet — you bolt that on with a Telegram sales bot.

### 12.2 Feature matrix

Legend: ✅ native · ⚠️ partial / delegated-admin only, no money layer · 🔌 via 3rd-party bot/add-on · ❌ none.

| Panel (repo) | Reseller / credits | Traffic accounting | Subscription + API | Multi-protocol | Node / scale-out |
|---|---|---|---|---|---|
| **3x-ui** — `MHSanaei/3x-ui` | ❌ single admin (no seller tiers/credits) | ✅ per-inbound/per-client/per-outbound via Xray stats; quota + expiry + IP-limit + HWID | ✅ built-in sub server (raw base64 / JSON / Clash, UA-selected); REST API + in-panel reference | ✅ VLESS, VMess, Trojan, SS, WireGuard, Hysteria2, TUIC, MTProto, HTTP/SOCKS | ⚠️ newer builds can push/clone inbounds to other servers; not a true control-plane |
| **x-ui** — `vaxilu/x-ui` (orig) / `alireza0/x-ui` (fork) | ❌ single admin | ✅ per-client quota/expiry/IP-limit (Xray stats) | ✅ share links, QR, sub; Telegram bot (fork) | ✅ VMess, VLESS, Trojan, SS, Hysteria (fork adds WireGuard/WARP, Reality) | ❌ single-node |
| **Marzban** — `Gozargah/Marzban` (+ `Marzban-node`) | ⚠️ sudo/non-sudo **admins** + per-admin usage log (v0.8); no credit wallet → 🔌 bots | ✅ per-user data-limit, expiry, **periodic reset** (daily/weekly), on-hold; Xray gRPC stats | ✅ v2ray base64 / Clash / ClashMeta / sing-box / Outline sub; **full REST API** (Swagger/ReDoc) | ✅ VMess, VLESS, Trojan, Shadowsocks (multi-proto per user) | ✅ **Marzban-node** for distribution/HA (svc 3000, Xray API 3001) |
| **Marzneshin** — `marzneshin/marzneshin` (+ `marznode`) | ⚠️ multi-admin (WIP); **services** gate inbound access per user | ✅ data-limit, expiry, periodic reset; stats collected from marznode | ✅ v2ray / Clash / ClashMeta sub; REST API | ✅ via marznode backends: Xray, **Hysteria2, sing-box, WireGuard** | ✅ **marznode** control-plane (gRPC), multi-backend, built "for scalability" |
| **Hiddify Manager** — `hiddify/Hiddify-Manager` | ⚠️ **Super-admin / Admin / Agent** tiers with **per-admin caps on total & active users** — closest native reseller-ish model; no money wallet | ✅ time + traffic limit per user; user consumption pages | ✅ auto sub for Hiddify app / Clash / sing-box; multi-domain, CDN/Cloudflare auto-IP; Telegram bot | ✅ **20+** — Reality, VLESS/VMess, Trojan, SS, Hysteria2, TUIC, WireGuard, SSH, Telegram proxy | ⚠️ single-box centric (multi-domain, not a multi-node control-plane) |
| **S-UI** — `alireza0/s-ui` | ❌ single admin | ✅ per-client traffic cap + expiry; online clients/inbounds/outbounds stats | ✅ sub in **link / JSON / Clash** (+info) formats; token REST API at `/apiv2` | ✅ sing-box stack: VLESS, VMess, Trojan, SS, ShadowTLS, Hysteria2, Naive, TUIC | ❌ single-node (panel `:2095/app/`, sub `:2096/sub/`) |
| **PasarGuard** — `PasarGuard/panel` (+ `node`, `scripts`) | ⚠️ **multi-admin with RBAC** (scoped permissions); no credit wallet | ✅ data-limit, expiry, periodic reset; stats via node | ✅ v2ray / Clash sub; **full REST API** | ✅ VMess, VLESS, Trojan, SS, **WireGuard, Hysteria2** | ✅ **PasarGuard/node** over gRPC (default `:62050`) |
| **Xray-checker** — `kutovoys/xray-checker` | n/a (monitoring, not management) | reads *your* sub and **actively probes** each node | consumes sub (base64/JSON/share links); **Prometheus + REST API + status page** | tests VLESS/VMess/Trojan/SS through Xray-core | n/a |
| **SSH/OpenVPN autoscripts** — e.g. `osproject-vpn/Autoscript`, `NevermoreSSH/hop`, `kangismet/ocspanel` | ✅ *credit/deposit* in OCS-style panels; ❌ in bare autoscripts | ⚠️ quota/expiry via OS + scripts; **max-login (session) caps** native to SSH | ⚠️ mostly per-account creds; some ship Xray sub too | ✅ SSH/Dropbear, SSL/TLS-tunnel, WS, OpenVPN, SlowDNS/DNSTT, plus Xray | ⚠️ per-VPS; OCS panel claims 1-panel/many-VPS |

Star counts observed at time of writing (they move): 3x-ui ~46k, S-UI ~9.9k, Hiddify ~9.3k, Marzban ~7.4k, alireza0/x-ui ~4.4k, PasarGuard ~2.6k, xray-checker ~0.9k, Marzneshin ~0.7k. Treat as rough scale, not exact.

### 12.3 How subscription links actually work

A "subscription" is just an HTTP(S) endpoint that returns the user's current node list. The panel owns a `/sub/<token>` route; the token is an opaque per-user secret (or a signed JWT), so the URL both identifies the user and doubles as their credential. The client app fetches that URL on a schedule and rebuilds its profile, which is why an admin can rotate a server or disable an account and every device updates without the user touching anything.

The clever part is **content negotiation by `User-Agent`**. The same URL returns different bodies depending on which app asks:

- **V2Ray base64 (v2rayNG, v2rayN, NekoBox, HTTP Injector Lite):** the body is a plain-text list of share URIs — one per line — then the whole blob is Base64-encoded. Each line is a self-contained URI:
  - `vless://<uuid>@host:port?type=ws&security=reality&pbk=...&sni=...&fp=chrome#label`
  - `vmess://<base64 of a JSON object {v,ps,add,port,id,aid,net,tls,host,path,sni}>`
  - `trojan://<password>@host:port?...#label`, `ss://<base64(method:password)>@host:port#label`
  The transport/TLS knobs (`type=ws|grpc|xhttp`, `host`/`path`, `sni`, Reality `pbk`/`sid`, `fp` fingerprint) are exactly the fields a free-net operator edits to ride a zero-rated **payload** (SNI/Host fronting).
- **Clash / Clash-Meta / Mihomo:** a YAML document — a `proxies:` array plus `proxy-groups:` and `rules:`. This is what carries routing logic, so it is the format that supports domestic-bypass rules and a "select" group across servers.
- **sing-box (and Hiddify):** a JSON document (`outbounds` + `route`), served to sing-box/Hiddify user-agents. Marzban literally has a dedicated generator for this (`app/subscription/singbox.py`); the same file structure appears across Marzneshin/PasarGuard.
- **Shadowrocket (iOS):** consumes the Base64 URI list like v2rayNG but expects a `Shadowrocket` UA; some panels also emit a small `#!` header.

Panels also return sub metadata in **HTTP response headers** — `subscription-userinfo: upload=…; download=…; total=…; expire=…` (a de-facto Clash/OpenClash convention) and `profile-update-interval` — which is how the client app shows the user their remaining GB and days without an API call. 3x-ui, S-UI, Marzban, Marzneshin, Hiddify and PasarGuard all speak this header.

Practical implication for a reseller: your "product" is the sub link, not the app. You never ship a binary; you ship a URL, and the panel's UA-switching means one link works in v2rayNG, Hiddify, Clash-Meta and Shadowrocket simultaneously.

### 12.4 How traffic accounting is collected (the Xray stats API)

Every panel in the Xray family meters the same way — they do **not** parse logs or run `iptables` counters, they ask Xray. Xray-core exposes a gRPC `StatsService` (by convention on `127.0.0.1:10085`, or a Unix socket) once you enable, in the Xray config:

- a top-level `"stats": {}` object,
- `"api": { "services": ["HandlerService","StatsService"] }`,
- and policy `"levels": { "0": { "statsUserUplink": true, "statsUserDownlink": true } }`.

The critical binding is that **each user must have an `email` field** on the inbound client — that email is the counter key. Xray then maintains monotonically increasing counters named:

- `user>>>alice@panel>>>traffic>>>uplink` and `...>>>downlink`
- `inbound>>>vless-ws>>>traffic>>>downlink`, `outbound>>>...`

The panel polls `StatsService.QueryStats` (usually with `reset=true`, so each poll returns the delta since last poll), adds the delta to the user's stored total in SQLite/MySQL/Postgres, and compares against the data-limit to auto-disable or move the account to "limited". Newer Xray builds (24.11.5+) added an **online-IP counter** (`statsUserOnline`) — this is how panels show "Online Now" and enforce **IP/device limits** (an account seen from more than N source IPs gets throttled or disabled; 3x-ui pairs this with Fail2ban). Marzban/Marzneshin/PasarGuard run this same query loop from the panel to each node over gRPC; the node returns counters, the panel is the source of truth for balances.

Because accounting lives in the counter, "reset traffic periodically (daily/weekly/monthly)" is just the panel zeroing its stored total on a cron and letting the counter keep climbing — cheap, and why every panel offers it.

### 12.5 Node / scale-out models compared

- **3x-ui / x-ui / S-UI:** fundamentally one Xray process on one box. 3x-ui's newer "manage multiple servers / clone inbounds" is convenience replication, not a control-plane; you still have N independent panels.
- **Marzban → Marzban-node:** a central Python panel drives one or more `Marzban-node` agents; the panel holds users/limits, nodes just run Xray and expose its API (node svc `:3000`, Xray API `:3001`) back to the panel. One user, many nodes, one balance.
- **Marzneshin → marznode:** the most explicitly "for scalability" design. `marznode` is a thin controller that can front **Xray, Hysteria2, sing-box, or WireGuard** backends behind one gRPC interface, and users are granted inbounds through **services** — good when your Ethiopia/Nigeria/KSA/BD servers run different protocols but you want one account model.
- **PasarGuard → node:** same shape as Marzban (it is the community continuation people reach for as Marzban's cadence slowed), gRPC to `PasarGuard/node` on `:62050`, adds WireGuard/Hysteria2 and RBAC multi-admin.

### 12.6 Xray-checker — the monitoring piece, not a panel

`kutovoys/xray-checker` is worth calling out because resellers conflate it with a panel; it is the opposite end. You feed it *your own subscription* (base64/JSON) or raw `vless://`/`vmess://`/`trojan://`/`ss://` links, and it **spins up Xray-core and routes a real HTTP request through each node** to an IP-echo endpoint to prove the node actually egresses. It exports **Prometheus metrics** (+ Pushgateway), a **REST/OpenAPI** surface, Uptime-Kuma-compatible healthcheck endpoints, and an unauthenticated **public status page**. For a multi-market reseller this is the honest way to publish "which servers are up right now" and to alert before customers do — but it manages nothing and bills nobody.

### 12.7 Where "Vollam" fits — and the closest OSS you can actually adopt

The panel you were shown (Dashboard with **Create Premium / Reseller / Bulk**, **Available Credits**, **Online Now**, **Top Resellers / Bandwidth / Sessions**, **Server / JSON / DNS** tabs, a **PREMIUM VPN** mode, and **per-user session caps**) reads unmistakably as an **SSH / HTTP-Injector free-net reseller panel**, not an Xray-family panel. The tells are specific:

- **"Credits", "Reseller", "Top Resellers"** = a native deposit/credit wallet with a seller hierarchy. No mainstream Xray OSS panel ships this; it is the defining feature of the OCS/`sshpanel`-lineage.
- **"Sessions" and per-user session caps** = SSH/Dropbear **max-login** limits (count concurrent logins), which is the SSH world's native limiter. Xray panels limit by *IP/device*, and they say "IP limit", not "sessions".
- **"Server / JSON / DNS" tabs + "PREMIUM VPN"** = an HTTP-Injector config workshop: **JSON** = the injector/`.ehi`-style config carrying the payload (SNI/Host front for zero-rated bypass), **DNS** = a SlowDNS/DNSTT tunnel config, **Server** = the host/port list. That triad is the free-net (Ethiopia/Nigeria/KSA/BD) toolkit, not the v2rayNG subscription toolkit.
- **"Bulk"** create = trial/bulk account generation, again an SSH-selling workflow.

I could not find any public OSS repository named "Vollam," and I won't assert an origin I can't verify. Given the exact feature set, tab naming, and the credit+session vocabulary, **Vollam is best treated as a custom/closed panel** (typical of this niche: bespoke PHP/Laravel over an SSH/OpenVPN/DNSTT + Xray autoscript, sold privately or on marketplaces/nulled forums). It is almost certainly **not** a reskin of 3x-ui/Marzban — those have neither a credit wallet nor SSH session semantics.

**Closest adoptable OSS equivalents, by what you're optimizing for:**

- **If the credit/reseller SSH-selling model is the point** (matches Vollam most literally): the OCS-panel lineage (`kangismet/ocspanel` — PHP/MySQL, deposit-to-create-SSH, one panel/many VPS) plus an autoscript backend like `osproject-vpn/Autoscript` or `NevermoreSSH/hop` (SSH/WS/SSL/SlowDNS/Xray). Honest caveat: **OCS panel is effectively abandoned** (last real activity ~2015) and the autoscripts are community-maintained Bash — you'd own the maintenance and security burden.
- **If you want a modern, maintained multiprotocol panel with delegated sellers and are willing to drop the SSH/session model:** **Hiddify Manager** is the closest turnkey — it has **Super-admin / Admin / Agent** tiers with **per-admin caps on total and active users**, per-user time+traffic limits, user consumption pages, CDN/multi-domain, and a Telegram bot. It is delegated administration, not a money wallet, but it's the nearest native reseller-shaped OSS.
- **If you want the strongest protocols + real multi-node and will add the money layer yourself:** **Marzban** (or its successor **PasarGuard**, or **Marzneshin** for mixed backends) as the engine, plus a **Telegram sales/billing bot** for the credit wallet and reseller ledger — e.g. `mahdiMGF2/botmirzapanel` or `lovehrom/marzbot` (internal wallet, per-service inbound config, multi-panel). This is how most serious operators reproduce a Vollam-like "Available Credits / Create Reseller" experience on maintained code.

**Bottom line for a multi-market HTTP-injector/free-net reseller:** no single mainstream OSS project is a drop-in Vollam clone — the native credit-reseller-with-sessions model only exists in the dormant SSH-panel family. The pragmatic path is **Marzban/PasarGuard (or Hiddify) for the multiprotocol + subscription + node fabric, an SSH/DNSTT autoscript for the free-net payload side, and a Telegram bot for credits/resellers/billing**, with **Xray-checker** wired to Prometheus for an honest per-market uptime page.

---

## 13. Vollam VPN and the branded app-generator ecosystem

This section covers the "white-label VPN app generator + panel" category that dominates the HTTP-Injector / free-net reseller economy: a hosted control panel (users, resellers, credits) + a runtime JSON/subscription config endpoint + a rebrandable Android client that pulls that JSON on launch. Vollam is one concrete, currently-live example of this category. Because much of this market is sold privately (direct sites and Telegram) rather than on GitHub, the section is explicit about what is **first-party verifiable**, what is **independently documented**, and what is **marketing-only / unverified**.

### 13.1 Vollam / Vollam Gen — what is actually verifiable

Everything below was pulled directly from `vollam.com`'s own page metadata and its shipped JavaScript app bundle (`/assets/index-*.js`), not from third-party summaries.

- **Product framing (verified from site `<meta>`):** "Centralized VPN Management Panel **rental ($15/mo, $120/yr)**, Custom Android VPN App Development, and White-Label VPN business solutions." Keywords it self-tags with: *VPN Panel rental, Custom VPN App, VPN Server Script, White Label VPN, V2Ray Panel, Xray, OpenVPN, VLESS, VMess, Hysteria, SlowDNS.*
- **What they sell (three SKUs):** (1) hosted multi-tenant **panel rental**; (2) **custom-branded Android client development** — "full Google Play compliant **AAB & APK**, SDK 24–35, your brand logo/colors, 2–4 business-day delivery"; (3) a **turnkey bundle** ("Launch your independent VPN business in 24 hours" — Panel license + 2 custom apps + 3 server gateways + Vollam Gen APK + billing), advertised around a $99–$199 entry price.
- **Localization = target market fit:** the bundle ships English, **Arabic**, and **Bengali** copy and accepts **bKash / Nagad** (Bangladesh mobile money) alongside Stripe/PayPal/USDT. Testimonials explicitly reference "Gulf cellular networks" and scaling "across Gulf countries." This maps directly onto the reader's Saudi Arabia and Bangladesh markets; the same payload/SlowDNS toolkit is what powers Ethiopia/Nigeria free-net, though the site does not name those two.
- **Honesty flags:** Vollam is **closed-source commercial software sold direct from its own website. It has no GitHub presence, and essentially no independent review, forum, or community footprint** (no Reddit/Trustpilot/press coverage surfaced). Its "**v5 panel**," "**Trusted by 500+ resellers**," "50,000+ sessions," and named testimonials are **self-reported marketing** and should be treated as unverified. The site is a React SPA, so casual scrapes see only the title; the substance lives in the JS bundle.
- **Correction:** search-engine AI summaries claimed Vollam supports "**Salamander obfuscation**." That string does **not** appear anywhere in Vollam's own bundle — treat it as a hallucination, not a feature.

**Vollam Gen** is the app-generator half. Per Vollam's own text, it is a **companion Android admin APK** that lets an operator "generate, test, **AES-encrypt**, and upload server configurations and custom payloads directly to the Vollam Panel cloud in seconds." The branded consumer client embeds a native **C++ NDK "Vollam Gen Engine"** and does **Dynamic Config Sync from the panel (`/api/app`)** at runtime. This is exactly the mechanism behind the **Server / JSON / DNS tabs** and the "**Update: JSON applied v1.9.3**" toast the reader has seen: the app fetches a config document, applies it, and shows a version string.

### 13.2 The config contract (the "JSON applied vX.Y.Z" mechanism), verified

Vollam's bundle ships a live example of its runtime config document and its update API:

```json
{
  "app_name": "Vollam VPN",
  "version": "4.2.0",
  "servers": [
    { "name": "Singapore VIP 01", "server": "sg1.example.com",
      "port": 443, "protocol": "vless", "tls": true }
  ]
}
```

- **Pull:** `GET /api/app` returns the JSON above (app name, a **`version`** field the UI surfaces as "JSON applied vX.Y.Z", and a `servers[]` array).
- **Push (admin):** `POST` config update with a `application/x-www-form-urlencoded` body of `hash` (config identifier) + `code` (new JSON string); success returns `{ "success": true, "code": 200, "message": "…" }`. The client-side toast literal is `Applied {code} successfully!`.
- **Payload engine (verified feature strings):** injection modes **Front/Back Inject, Split, SplitNoDelay, Real Request, Dual Connect**; macro replacements **`[host_port]`, `[crlf]`, `[split]`, `[netData]`, `[rotation]`, `[ua]`**; **User-Agent spoofing** (Firefox, Chrome, Opera Mini, Puffin, Safari, UCBrowser).
- **Protocols Vollam claims natively:** VLESS Reality, VLESS **XHTTP**, **Hysteria v2**, **SlowDNS** (UDP/53 via `pdnsd`, `libpdnsd.so`/`libdns.so`), **OpenVPN** (TCP/UDP, SSL **Stunnel**, WebSocket proxy at `/ws-openvpn`), **Trojan**, **VMess**, **SSH/Dropbear**.
- **Server-side stack it advertises:** per-node **Bun/TypeScript agent daemon** (`agent.ts`) under systemd (`sysd-networkd.service`), **Redis** for live sync, **multi-tenant PostgreSQL**, **Nginx** reverse proxy + **Cloudflare DNS automation** (wildcard A-records, CDN **SNI** masking), and a **multi-tier reseller credit ledger** with upline/downline tracking.

### 13.3 The generalized architecture (this whole product category)

Every product in this niche — Vollam, and the Telegram-sold "Nest VPN panel," "NetvPro," "V2Ray Net"-style clones — is the same three-part shape:

| Layer | Job | Typical implementation |
|---|---|---|
| **Web/Telegram panel** | Accounts, resellers, **credit** deduction, expiry, IP-limit, server inventory | PHP or Node/Bun + MySQL/PostgreSQL; often a **Telegram bot** as the reseller UI |
| **Config endpoint** | Hands the app a **server/payload/DNS list** at runtime; supports remote hot-update & "locked"/encrypted (AES) configs | `GET /api/app` or a subscription URL returning JSON/base64; POST to push updates |
| **Branded template app** | One reusable Android client **recompiled per customer** with logo/colors + hard-coded panel API base; parses payload macros; drives the tunnel core | Native NDK tunnel engine (SSH/Dropbear, DNSTT, Xray/sing-box embedded) |

The reseller never touches tunnel code. They rebrand a template, point it at their panel, and sell credits; the panel pushes new bug-hosts/servers as JSON when carriers patch a hole. This is why "Update: JSON applied" is the single most important UX event in the whole category — it is how a fleet of phones gets re-pointed at a working zero-rated host within minutes of the old one dying.

### 13.4 How the tunnels/payloads work (mechanism, concretely)

- **HTTP payload injection / "bug host" zero-rating.** The client opens a raw TCP socket to an SSH/proxy backend but **prepends a hand-crafted HTTP request** whose `Host:`/`X-Online-Host:` (or the TLS **SNI**) is a **zero-rated domain** the carrier does not meter (a telco portal, a "free Facebook/WhatsApp" host, a DNS-front). Modes like **Split / SplitNoDelay** chop that request across packets so DPI can't reassemble the real `CONNECT`; **Front/Back Inject** decides whether the spoof header leads or trails the real payload; **Real Request + Dual Connect** open a decoy request to a whitelisted host and smuggle the tunnel alongside. The `[crlf]`, `[host_port]`, `[ua]` macros just template these headers. Fast and cheap when it works; extremely brittle — one carrier config change kills every config, which is the entire reason for the remote-JSON update loop.
- **SlowDNS / DNSTT (UDP/53).** Tunnels TCP inside DNS queries/responses to a delegated authoritative NS, exploiting networks that resolve DNS **before** the captive portal/paywall. Survives the harshest blocks but is **high-latency, low-throughput** — a fallback lane, not a streaming lane. (Vollam links this to `pdnsd`; the open reference implementation is **dnstt**.)
- **Hysteria v2.** A **QUIC/UDP** proxy that **masquerades as HTTP/3** and uses the **Brutal** congestion-control algorithm — a fixed-bandwidth target with ACK-rate feedback and loss compensation, so it holds throughput on lossy mobile links where TCP/BBR collapses. Best speed/stability on 4G, but pure UDP is easy to rate-limit or drop where UDP is throttled.
- **VLESS-Reality / XHTTP + CDN fronting.** VLESS strips TLS-in-TLS overhead; **Reality** forges a real TLS 1.3 handshake to a legit domain without owning its cert (defeats active-probe/SNI blocking). **XHTTP/gRPC/WebSocket** wraps traffic so it can ride **Cloudflare** (origin IP hidden, arbitrary SNI) — durable against IP blocklists, but pays CDN latency and can be throttled by the CDN.
- **OpenVPN over stunnel / WebSocket.** Legacy but rock-stable: OpenVPN wrapped in TLS (`stunnel`) or upgraded to a `/ws-openvpn` WebSocket so it looks like HTTPS. Slower, higher overhead, but the most "boring" and reliable lane for non-technical users.

### 13.5 The broader, better-documented ecosystem (use these for context/accuracy)

**Closed-source apps with proprietary "locked" config containers** (the formats resellers actually ship). These are the products Vollam-style apps imitate:

| App | Package / vendor | Config format | Notes |
|---|---|---|---|
| **HTTP Injector** | `com.evozi.injector` (Evozi) | **`.ehi`** (proprietary, encrypted) | Bundles payload + remote proxy + SSH creds + SNI/bug-host; SSH, SSL/stunnel, DNSTT/SlowDNS, Shadowsocks, V2Ray/Xray, Hysteria, WireGuard. The de-facto standard the whole scene copies. |
| **NapsternetV / Npv Tunnel** | `com.napsternetlabs.napsternetv` | **`.npv` → `.npv2/.npv3/.npv4`** ("locked" encrypted) | V2Ray/VMess/SSH/Psiphon; newer builds moved to plain JSON import. |
| **DarkTunnel** | `net.darktunnel.app` | app-specific | SSH, **SSH-over-DNSTT (SlowDNS)**, VMess/VLESS/Trojan/Shadowsocks over TCP/WS/gRPC. |
| **SocksIP Tunnel** | `com.newtoolsworks.sockstunnel` | app-specific | SSH/WS/UDP payload injector; very large install base. |
| **Nest VPN** | `n24.nest.project` (Google Play) | app-specific | A V2Ray-based **consumer** app; I found **no** evidence it ships a public app-generator/panel SDK — treat "Nest VPN panel" as a Telegram-market claim, not verified. |

**"NetvPro" / "V2Ray Net"**: I could **not** verify a specific canonical product, repo, or vendor page for these names. They appear to be Telegram-distributed rebrands of the template pattern above; report them as **unverified / closed** rather than citing a link.

**Open-source cores people actually rebrand** (canonical repos, verified):

| Project | Repo | Role in this ecosystem |
|---|---|---|
| **v2rayNG** | `github.com/2dust/v2rayNG` | The most-rebranded Android V2Ray/Xray client; MPL — legal to fork, and widely reskinned into "branded" VPNs. |
| **sing-box** | `github.com/SagerNet/sing-box` | Universal proxy platform (VLESS/Trojan/Hysteria2/TUIC/SS); embedded as the engine in many custom apps. |
| **mihomo (Clash.Meta)** | `github.com/MetaCubeX/mihomo` | Clash-compatible core; the "Clash fork" resellers embed for rule-based routing. |
| **Xray-core** | `github.com/XTLS/Xray-core` | Reference VLESS-Reality/XHTTP/gRPC core (what Vollam's server side wraps). |
| **Hysteria** | `github.com/apernet/hysteria` (+ `apernet/tcp-brutal`) | The Hysteria v2 protocol + Brutal CC algorithm. |
| **dnstt (SlowDNS)** | David Fifield's `dnstt`; maintained forks incl. `github.com/getlantern/dnstt` | The DNS-tunnel primitive behind every "SlowDNS" feature. |

**Documented commercial panel scripts** (the legitimate-market analogues to Vollam's closed panel): CodeCanyon/Codester listings such as *Muzi VPN*, *Boom VPN*, and "Advance VPN Panel," plus hosted panels like **V2RayTor** and **v2raybox** — all sold as V2Ray/Xray reseller panels with credit systems and Telegram-bot provisioning.

### 13.6 Bottom line on verifiability

- **Verifiable (first-party):** Vollam is a real, live, closed-source commercial white-label operation (panel rental + Vollam Gen app generator + turnkey bundle) with the config-sync architecture described above, priced and localized for exactly the reader's markets.
- **Not verifiable:** its scale/reputation claims, and any GitHub or third-party audit — there is none.
- **Category truth:** the durable, auditable technology is **not** the branded wrappers — it is the open cores (Xray/Reality, sing-box, Hysteria, dnstt) and the proprietary-but-well-known config formats (`.ehi`, `.npv*`). The Vollams and Nest/NetvPro-style products are thin, Telegram-sold commercial skins over that stack, and their entire value proposition is the **panel + hot-updatable JSON payload list**, not novel protocol engineering.

---

## 14. Authentication, subscription API, and traffic accounting

Every multi-user VPN business reduces to the same three questions asked millions of times a day: *is this account valid and unexpired*, *how many bytes has it moved*, and *how many devices are on it right now*. Each protocol answers these differently — some hand you a clean gRPC/HTTP control plane, others force you to scrape a management socket or a log file. This section covers the per-protocol mechanisms, the RADIUS option for unifying them, how a panel computes the numbers a reseller sees, and how to design the token/subscription API on top.

### 14.1 The two-plane model (read this first)

The single most important design decision — and the one the reader explicitly asked about — is to **separate the credential the client dials from the credential the human operates**:

- **VPN-access credential** (data plane): the UUID (Xray), the `username:password` or auth string (Hysteria2/OpenVPN), or the SSH login. It is embedded in a config/subscription and lives on the end-user's phone. It should be *unguessable but not privileged* — possessing it lets you send traffic, nothing else.
- **Panel/reseller credential** (control plane): the login a reseller or admin uses to *create, top-up, suspend, and meter* accounts. This is a human/machine identity and must be authenticated separately (password + JWT, or an API key for automation) with role scoping (sudo-admin vs reseller vs read-only).

Collapsing these two is the classic mistake: if the subscription token can also hit the admin API, a leaked config compromises the panel. Marzban is a good reference implementation of the split — human/reseller logins go through `POST /api/admin/token` (JWT), while each user's subscription is fetched with a **per-user HMAC token** that is unguessable and grants only "read my own config," never account management.

### 14.2 Per-protocol mechanisms

#### OpenVPN

OpenVPN has no built-in user database — you bolt one on via scripts, plugins, or the management interface.

- **Authentication — `auth-user-pass-verify`:** the server invokes your script on every connect, passing the client's username/password by `via-env` or `via-file`; exit `0` accepts, `1` rejects. This is where you check "account exists, not expired, not over quota."
- **Deferred / async auth (OpenVPN ≥ 2.5):** `--auth-user-pass-verify` and `--client-connect` scripts (and plugins) can run asynchronously so the daemon doesn't stall while your backend does a DB/HTTP round-trip. The script forks, and later writes `1`/`0` into the file named by the `auth_control_file` environment variable. This is essential at scale — a synchronous script that blocks stalls the whole `openvpn` process.
- **Management-interface auth (`--management-client-auth`):** instead of a script, the server emits a `>CLIENT:CONNECT`/`>CLIENT:REAUTH` notification on the management socket and waits for your controller to reply `client-auth {CID} {KID}` … `END` (with per-client push directives), `client-auth-nt {CID} {KID}` (no config), or `client-deny {CID} {KID} "reason" "client-reason"`. This lets one external process authorize connections across many `openvpn` instances.
- **Byte accounting:** two paths. (1) Real-time: issue `bytecount n` on the management socket and every connected client emits `>BYTECOUNT_CLI:{CID},{BYTES_IN},{BYTES_OUT}` every *n* seconds (client-mode is `>BYTECOUNT:{IN},{OUT}`). (2) Session-final: the `client-disconnect` script and the `>CLIENT:DISCONNECT` notification expose `bytes_received` / `bytes_sent` environment variables — the definitive per-session totals to add to a running counter. The `status` command dumps the current client table; `kill <CN>` / `kill <CID>` / `kill tcp:ip:port` forcibly disconnects.
- **OSS to lift from:** `Fadi-hamwi/OpenVPN-Metrics-Exporter` (Prometheus exporter that parses the management interface for per-client traffic/session data) shows the byte-scraping pattern end to end.

#### Xray / V2Ray (VMess, VLESS, Trojan, Shadowsocks)

Xray-core exposes a **local gRPC API** (a `dokodemo-door` inbound tagged `api`, commonly `127.0.0.1:10085` by convention — the docs example uses `8080`) with these services: **HandlerService, StatsService, LoggerService, RoutingService**, and gRPC **Reflection**.

- **Live user add/remove — HandlerService:** you never restart the core or edit `config.json`. `AlterInbound` carries an `AddUserOperation` (or the remove counterpart) to hot-add/remove a user on an inbound, keyed by the user's **`email` field**. VLESS/VMess use a per-user **UUID**; the `email` is the accounting handle. (Panels like 3x-ui wrap these as `AddUser` / `RemoveInboundUser`.)
- **Per-user traffic — StatsService:** enable `"stats": {}` and set `"statsUserUplink": true` / `"statsUserDownlink": true` under the user's `policy.levels` entry. The core then maintains counters named exactly:
  - `user>>>{email}>>>traffic>>>uplink`
  - `user>>>{email}>>>traffic>>>downlink`
  - and system counters `inbound>>>{tag}>>>traffic>>>uplink|downlink`.
  You read them with `QueryStats` (pattern match, optional `reset`) or `GetStats` (single name, optional `reset`). The `reset: true` flag zeroes the counter on read — the standard way to get a delta each polling interval and compute a rate. **A user with no `email` is invisible to stats** — always set it.
- **"Online now" / device counting:** newer Xray-core (from ~24.11.x) added an online-IP counter so you can query the set of source IPs seen per user. Where that isn't available, panels derive it by tailing the Xray **access log** and grouping recent lines by email → distinct source IP. Enforcement of an IP/device cap is then done outside the core: **3x-ui** ships a fail2ban jail (`3x-ipl`) that reads the access log and bans excess IPs via iptables. Note the well-known limitation: behind a CDN (Cloudflare) the network-layer source is always the edge IP, so IP-limit-by-iptables breaks unless you enforce on the real client IP.
- **OSS to lift from:** `Gozargah/Marzban` (full panel + per-user HMAC subscription + REST API), `MHSanaei/3x-ui` (single-server panel, expiry + quota + IP-limit), and API clients `mewhrzad/marzpy` and `Ilmar7786/marzban-sdk`.

#### Hysteria2 (QUIC)

Hysteria2 is the cleanest of the bunch for a reseller backend because auth and stats are both plain HTTP.

- **Auth backend (`auth: type: http`):** on each connect the server POSTs `{"addr": "<client-ip:port>", "auth": "<client's auth string>", "tx": <bytes/sec>}` to your `url`. Your backend must reply **HTTP 200** with `{"ok": true, "id": "john_doe"}` to accept (`"ok": false` to reject — still 200). The returned **`id` is the accounting key** used in logs and the stats API, so map it to your account ID. Other auth types are `password`, `userpass` (inline map), and `command` (exec a program).
- **Traffic Stats API (`trafficStats: { listen: :9999, secret: <secret> }`):** a small HTTP server with:
  - `GET /traffic` → `{ "<id>": {"tx": <bytes>, "rx": <bytes>} }`; add `?clear=1` to reset (delta polling, same idea as Xray's `reset`).
  - `GET /online` → `{ "<id>": <device_count> }` where the count is the number of Hysteria **client instances (devices)**, not proxy streams — this is your "sessions per account."
  - `POST /kick` → array of IDs to disconnect.
  - `GET /dump/streams` → per-QUIC-stream detail.
  All require an `Authorization: <secret>` header when `secret` is set — **set it**, or anyone reachable can read stats and kick users. Because clients auto-reconnect, a kick must be **paired with blocking the ID in your auth backend**, otherwise it comes right back.
- **Bandwidth:** `bandwidth: { up, down }` are per-client speed caps; `ignoreClientBandwidth` forces the server's numbers over the client's Brutal-congestion hints. Bandwidth is *not* set per-user through the auth backend, so per-tier speed shaping is done by running separate listeners/ports or by an external policy layer.
- **ACL:** `acl.inline` (or a file) with rules like `reject(suffix:example.com)` / `reject(all, udp/443)`, now supporting port ranges — useful to block torrents or force zero-rated-only egress.
- **OSS to lift from:** `jonssonyan/h-ui`, `ReturnFI/Hysteria2-API` (Python client over the stats API), and multi-protocol panels like `ClickDevTech/CELERITY-panel`.

#### SSH (the free-net workhorse: SSH-over-WebSocket / SlowDNS / stunnel)

SSH is enormously popular in the HTTP-injector ecosystem because a plain OpenSSH account tunnels fine over an HTTP "payload" / SNI trick, but its multi-user primitives are the crudest.

- **Auth & accounts:** OpenSSH delegates to **PAM**. Accounts are real Unix users; you gate them with PAM modules (`pam_access`, `pam_faillock` for lockout) and shell/`nologin` tricks so they can only tunnel.
- **Expiry:** there is no VPN-native expiry — you use the account-expiration field in `/etc/shadow`, set with `useradd -e YYYY-MM-DD` or `chage -E`. After that date sshd refuses login. Panels also run a cron that deletes/locks expired users.
- **Multi-login limit ("lock max login"):** SSH has no byte metering and no built-in concurrent-session cap that resellers can trust, so panels **count sessions and kill excess**: either `MaxSessions`/`limits.conf maxlogins`, or (more commonly) a daemon that counts `sshd:` processes / `who` entries per user and `pkill`s the newest when the count exceeds the account's device limit. Byte accounting, if done at all, is per-interface or via `iptables` per-user `owner` match — coarse and rarely used; SSH resellers typically sell by *time + device count*, not bytes.
- **OSS to lift from (ecosystem-honest note):** the SSH free-net panels are mostly community auto-scripts rather than clean libraries — e.g. `AAAAAEXQOSyIpN2JZ0ehUQ/SSHPLUS-MANAGER-FREE` (reseller manager), `eylandoo/openvpn_webpanel_manager` (multi-protocol panel with resellers/sub-admins), and numerous "VPS auto-script" bundles (SSH + Dropbear + stunnel + SlowDNS + V2Ray). Quality varies wildly; treat them as reference for *the account/expiry/kill loop*, not as production code.

#### RADIUS as the unifying backend

If you run OpenVPN **and** SSH **and** L2TP, RADIUS lets one user store answer all of them.

- **Auth:** Access-Request/Access-Accept, checked against FreeRADIUS (`FreeRADIUS/freeradius-server`) with a web UI like **daloRADIUS** for CRUD/billing.
- **Accounting:** the NAS (VPN server) sends Accounting-Start / Interim-Update / Accounting-Stop packets carrying **`Acct-Input-Octets` / `Acct-Output-Octets`** (RFC 2866) — that is your byte meter, populated centrally without scraping each daemon.
- **Multi-login:** the **`Simultaneous-Use`** check attribute caps concurrent sessions per account — RADIUS's native "device limit."
- **Integration reality:** OpenVPN plugs in cleanly — the classic `radiusplugin` (`radiusplugin.cnf`) or the Go plugin `rakasatria/ovpn-radius` do both auth *and* accounting. **SoftEther** supports RADIUS *authentication* but historically has **no accounting** path, and **Xray/Hysteria2 have no RADIUS support at all** — so RADIUS unifies the "legacy tunnel" protocols (OpenVPN/L2TP/SSH-via-PAM-RADIUS) but not the modern QUIC/TLS proxies, which you meter via their own gRPC/HTTP APIs and then *write into* the same billing DB.

### 14.3 How the panel numbers are actually computed

| Panel figure | OpenVPN | Xray/V2Ray | Hysteria2 | SSH | RADIUS |
|---|---|---|---|---|---|
| **Bytes up/down/total** | `bytecount` live + `bytes_received`/`bytes_sent` on disconnect | `QueryStats` on `user>>>email>>>traffic>>>up/downlink` (poll + reset for deltas) | `GET /traffic` → `tx`/`rx` (opt `?clear=1`) | rarely metered (iptables owner match) | `Acct-Input/Output-Octets` in accounting DB |
| **Online now** | `status` client table / `>CLIENT` events | online-IP counter or access-log grouped by email→IP | `GET /online` → devices per id | count `sshd`/`who` per user | open sessions in `radacct` |
| **Sessions/devices per account** | count CIDs per CN | distinct source IPs per email | device count from `/online`; enforce by kick + block | session-count daemon, `pkill` excess | `Simultaneous-Use` |
| **Expiry** | script checks date, denies | panel disables user (HandlerService remove) at date | auth backend returns `ok:false` after date | `/etc/shadow` expiry (`chage -E`) | `Expiration` attribute |
| **Quota enforcement** | script denies over-quota | remove user when total ≥ limit | auth backend `ok:false` + `/kick` | n/a | disconnect on quota |

The universal pattern: **poll each core's stats API on an interval with reset/clear to get a byte delta, add it to a persistent per-account counter, and when the counter crosses the quota (or the clock crosses expiry), flip the account off** — remove the user via HandlerService (Xray), return `ok:false` and `/kick` (Hysteria2), `client-deny`/`kill` (OpenVPN), or lock the Unix user (SSH). "Online now" and "device count" are derived, not stored, so they must be recomputed each poll; enforcement of a device cap is always a *count-then-kick* loop because none of these cores hard-limit devices except SSH (crudely) and RADIUS (`Simultaneous-Use`).

### 14.4 Designing the reader's subscription / token API

**Subscription endpoint.** Expose `GET /sub/{token}` returning the user's config in whatever the client expects — a base64 blob of `vless://`/`vmess://`/`hysteria2://` URIs, or a Clash/sing-box YAML profile (content-negotiate on `User-Agent`). Properties:

- The `token` is a **per-user, opaque, unguessable HMAC** (`HMAC(server_secret, user_id)`), not the user's UUID and not a JWT. It is safe to serve without a login prompt (the client app fetches it unattended) precisely because it is high-entropy and grants only "read my own config."
- Rotate by changing the user's HMAC salt; that instantly invalidates leaked links without touching the dial credential.
- Put usage/expiry into response headers many clients read: `Subscription-Userinfo: upload=…; download=…; total=…; expire=…` so the client app can show the user their own quota.

**Credential separation (again, because it matters).** Three token classes, three lifetimes:

| Token | Who holds it | Auth style | Lifetime | Scope |
|---|---|---|---|---|
| Subscription token | end-user app | opaque HMAC in URL | long, rotatable | read own config only |
| Panel session | human admin/reseller | **JWT** (from `POST /token`) | short (e.g. minutes–hours) | role-scoped CRUD |
| Automation key | node agents, billing bots | **API key** (header) | long, revocable | server-scoped, no UI |

- **JWT vs API key:** use **JWT** for interactive/reseller sessions — stateless, carries `role`/`sub`/`exp`, short-lived so a stolen token expires fast; refresh via re-login. Use a **static API key** for machine-to-machine (a node reporting stats, a Telegram bot provisioning accounts) — long-lived, stored server-side, revocable per key, and *never* embedded in a client-side subscription. Do **not** hand resellers a non-expiring JWT; do **not** authenticate the subscription fetch with the admin JWT.
- **Reseller model:** a reseller is a control-plane identity with a credit balance and a `parent_admin` scope; it can create/renew VPN-access credentials but only within its own quota, and it can never read another reseller's users. This is exactly Marzban's sudo-admin → admin split.

**Rate limits.** Protect three surfaces distinctly: (1) the login `POST /token` — tight per-IP limit + lockout (`pam_faillock`-style) to stop credential stuffing; (2) the subscription `GET /sub/{token}` — per-token limit (clients re-poll every few hours; anything faster is a scraper or a shared link) plus a hard cap that itself can signal device abuse; (3) the admin/reseller API — per-key quotas. Log the source IP correctly behind a CDN (trust `X-Forwarded-For` only from your own proxy — a real Marzban CVE came from unvalidated `X-Forwarded-For` letting an attacker spoof the login source IP).

### 14.5 Honest gaps

- **Xray and Hysteria2 have no RADIUS or standardized accounting** — you must poll their native APIs and write to your own DB; there is no drop-in "OpenVPN-style" accounting packet.
- **SSH byte metering is effectively absent** in the free-net stack; sell SSH on time + device count, not gigabytes.
- **Device limits are never truly enforced by the core** (except SSH crudely and RADIUS `Simultaneous-Use`) — every panel implements count-then-kick, which is inherently racy and easily defeated by NAT (many users behind one IP look like one device) and CDNs (all users share the edge IP). Budget for this being approximate, not exact.
- The **SSH/free-net panel OSS is largely community auto-scripts**, not audited libraries — mine them for the account/expiry/kill loop, but write your own control plane rather than shipping them.

---

## 15. Designing your OWN client+server protocol (proxy » payload » SSL » XHTTP)

You do **not** need to invent cryptography or a new transport from scratch. The honest engineering win here is to *assemble* an onion out of primitives that already ship in Xray-core and sing-box, and add only the two layers nobody else bundles: your **payload/injection front** (for zero-rated "free-net" hosts) and a **light per-tenant auth** layer (for reseller billing). Everything in the middle — TLS/REALITY, XHTTP, mux, Brutal/BBR — is battle-tested and should be reused, not rewritten.

### 15.1 The layered stack (outermost → innermost)

```
[ client app / SOCKS ]
        │  inner SOCKS/IP frames + light auth (per-user token)   ← Layer D
   ┌────┴─────────────────────────────────────────────┐
   │  yamux / smux / QUIC-streams multiplexer          │        ← Layer D (mux)
   ├───────────────────────────────────────────────────┤
   │  XHTTP / SplitHTTP app framing (POST up · GET down)│        ← Layer C
   ├───────────────────────────────────────────────────┤
   │  TLS 1.3 (uTLS fingerprint) or REALITY outer       │        ← Layer B
   ├───────────────────────────────────────────────────┤
   │  payload/injection front: CONNECT + fake Host +    │        ← Layer A
   │  CRLF/split, SNI = "bug host"                       │
   └───────────────────────────────────────────────────┘
        │  raw TCP/UDP to carrier
   [ mobile carrier / DPI / billing box ]
```

| Layer | Job | Reuse this | You build |
|---|---|---|---|
| **A. Payload front** | Look like traffic to a *zero-rated / whitelisted* host so the carrier bills 0 MB or a DPI box lets it pass | HTTP Injector `.ehi`-style payload logic | Yes — thin, config-driven |
| **B. TLS / REALITY** | Look like *real HTTPS* to a well-known site; defeat active probing | Xray REALITY, uTLS | No — configure it |
| **C. XHTTP framing** | Look like *ordinary CDN web traffic*; ride Cloudflare; split up/down | Xray XHTTP / sing-box | No — configure it |
| **D. Mux + auth** | One connection carrying many streams + per-user identity | sing-mux / smux / yamux / QUIC | Auth only (light) |

### 15.2 Layer A — the payload / injection front (the "free-net" part)

This is the layer specific to the Ethiopia / Nigeria / Saudi / Bangladesh HTTP-injector market, and the layer with the **least reusable OSS** — most of it lives in closed Android apps (HTTP Injector, HA Tunnel, TLS Tunnel). Open references exist mainly as payload *generators* (e.g. `hndko/payload-injector-generator`) rather than full stacks.

**How the abuse actually works.** Carriers implement zero-rating (free WhatsApp, free Facebook, on-net portals) by inspecting the **cleartext selector** in each new connection and matching it against a whitelist. On plaintext HTTP that selector is the `Host:` header; on HTTPS it is the **TLS SNI** in the ClientHello, which is sent in the clear even in TLS 1.3. Billing/whitelist boxes overwhelmingly key on *SNI or HTTP Host*, not on the real destination IP, because cloud IPs churn. That mismatch is the entire exploit surface:

- **HTTP `CONNECT` + fake Host / split** — the client opens `CONNECT realserver:443` but rewrites/injects a request line and a `Host:` header pointing at a whitelisted domain, then relies on CRLF placement so the DPI parser reads the *fake* host while the proxy/SSH server reads the real tunnel. Injector "keywords" like `[host]`, `[crlf]`, `[split]`, `[real_raw]` are exactly templated CRLF surgery. **Split** mode fragments the request so the Host header lands in a *second* TCP segment, defeating single-segment DPI that only reads the first packet.
- **SNI "bug host"** — for the TLS/HTTPS path (Layers B/C), you set the outer ClientHello **SNI to a zero-rated domain** (the "bug"), while the actual server is somewhere else. This is classic **domain fronting**: SNI (visible, billed) ≠ inner Host (encrypted, real). Front-hostable CDNs are shrinking, but SNI-only billing boxes remain common in these markets.

**Be a realist about this layer:** it is inherently **fragile and carrier-specific**. A given bug host works until the operator (a) moves to IP+SNI correlation, (b) deploys SNI/Host-mismatch detection (a known domain-fronting red flag), or (c) enforces ESNI/ECH. Engineer it as **hot-swappable config** (a payload template string + SNI per market/carrier), never as hardcoded protocol. Your competitive moat is the *catalog of working bugs and fast rotation*, not the transport.

### 15.3 Layer B — TLS / uTLS / REALITY outer

Once past the billing box, you still face DPI that flags "TLS-in-TLS" and unknown handshakes. Two options, both already in Xray-core:

- **uTLS fingerprint mimicry** — uTLS is a fork of Go `crypto/tls` that lets you emit a byte-identical ClientHello of Chrome/Firefox/Safari (cipher order, extensions, GREASE), so a JA3/JA4 classifier can't single you out. Use this whenever you terminate on a **real cert behind a CDN**.
- **REALITY** — no domain, no cert, no CDN needed, and it beats **active probing**. Mechanism (worth understanding precisely):
  - Client generates an X25519 keypair, does ECDH with the server's public key → `preMasterKey`; it packs `{version, timestamp, ShortId}` into the 32-byte **Session ID** and AEAD-encrypts it, so the mark is invisible to passive observers.
  - Server derives the same key. **Legit client** → server serves the tunnel with a temporary ed25519 cert whose signature is replaced by an HMAC keyed on `preMasterKey` (only a real client can verify it). **Censor/prober** → server *transparently reverse-proxies the ClientHello to a real "dest" site* (e.g. a big CDN/property) and relays its genuine ServerHello. The prober sees a perfect handshake to a real site and a valid cert → nothing to block.
  - This is why REALITY is the default recommendation for the **direct (non-CDN)** entry: it removes cert management and survives GFW-style probing.

Rule of thumb: **REALITY for direct VPS entry; uTLS + real cert for the CDN/Cloudflare entry** (REALITY can't ride a CDN because the CDN terminates TLS).

### 15.4 Layer C — XHTTP / SplitHTTP application framing

XHTTP (formerly SplitHTTP) is the piece that makes your tunnel look like **plain HTTP web requests to a CDN**, and it's the closest existing thing to what you're describing ("separate up/down streams over HTTP so it rides Cloudflare"). Its principle is *"packetized upload, streaming download,"* with independent up/down paths. Three modes, in increasing CDN-friendliness/efficiency:

| XHTTP mode | Upload | Download | CDN behavior | Use when |
|---|---|---|---|---|
| **packet-up** | many sequential `POST /path/UUID/<seq>` | streaming `GET` | Highest compat; server reorders by seq; `Referer` padding 100–1000 B, `X-Padding` on responses | Hostile/proxying CDNs, HTTP/1.1 |
| **stream-up** | one continuous `POST /path/UUID` (default `Content-Type: application/grpc`) | streaming response | Needs H2/gRPC-capable CDN | Cloudflare with gRPC on |
| **stream-one** | single `POST /path/` bidirectional | same request/response | Simplest; **Cloudflare supports this cleanly** | Default for CF |

Key properties to exploit:
- **CDN version laundering** — CDNs convert client **H3/QUIC → H2/H1** before the origin. So your **client can speak QUIC/H3 to Cloudflare** (fast, UDP) while your **origin only needs TCP H1/H2**. Free QUIC benefits, no QUIC origin.
- **Up/down decoupling** — `downloadSettings` can put the *download* on an entirely different IP / CDN / protocol than upload (e.g. upload over IPv4 TCP to CDN, download over IPv6 QUIC direct). Great for asymmetric mobile links and for splitting billing exposure.
- **XMUX churn** — `maxConcurrency` (16–32), `hMaxRequestTimes` (600–900, to stay under nginx defaults), `hMaxReusableSecs` (1800–3000) create *natural connection turnover* that resists flow-count fingerprinting. Reuse these defaults; don't reinvent them.

### 15.5 Layer D — the muxed inner tunnel + light auth

Inside the HTTP body you carry a **multiplexer** so one expensive outer connection (one handshake, one billed flow) fans out into many logical streams:

- **sing-mux** supports **h2mux > smux > yamux** (that's the quality order). smux/yamux are simple stream muxers; h2mux reuses HTTP/2 framing. Mux also lets you carry **UDP-over-stream** and get full-cone NAT for protocols that otherwise can't.
- Over a **QUIC core** you skip a userland muxer entirely — QUIC gives you native, **head-of-line-blocking-free streams**; open one QUIC stream per SOCKS connection.
- **AnyTLS** (sing-box team) is the reference for doing this *well over TLS*: it keeps a **pool of ≥5 pre-established idle TLS sessions** for instant reuse, and applies a **configurable padding scheme** specifically to defeat the TLS-in-TLS length/timing fingerprint. If your inner is TLS-shaped, copy AnyTLS's padding + session-pool design rather than raw yamux.

**Auth (the one thing you must build):** keep it light and inside the mux, not in the handshake, so it doesn't add round-trips or a fingerprint. A practical scheme: the first inner stream carries `HMAC-SHA256(user_secret, client_random ‖ timestamp)` + a `user_id`; server validates, rate-limits, and maps to a plan. This gives you per-reseller keys, instant revocation, and quota accounting without touching the crypto of Layers B/C. Treat it like VLESS's UUID but keyed for HMAC so you can rotate without redeploying certs.

### 15.6 Handshake, 0-RTT and resumption

Minimize round-trips because mobile RTTs in these markets are brutal:

- **TCP+TLS core:** handshake = TCP (1) + TLS 1.3 (1) = 2 RTT cold. Use **TLS 1.3 session tickets / PSK resumption** for **1-RTT** reconnects, and mux so you pay it *once* per device, not per app connection. REALITY piggybacks on the TLS 1.3 handshake — no extra round-trip.
- **QUIC core:** **1-RTT** cold (TLS 1.3 is folded into QUIC), and **0-RTT** on resumption — the client sends application data in the *first* flight using a cached PSK. quinn/quic-go both expose this via the TLS `ClientSessionCache`; a rejected 0-RTT silently degrades to 1-RTT, so it's safe to always attempt. Caveat: 0-RTT early data is **replayable** — only send idempotent inner setup (auth + stream-open), never let it trigger a non-idempotent action server-side.

### 15.7 Choosing the core: QUIC+Brutal vs TCP+BBR

This is the single biggest performance lever, and it's genuinely per-market:

| | **QUIC + Brutal** | **TCP + BBR** |
|---|---|---|
| Best for | Lossy/throttled **mobile** (Ethiopia/Nigeria/BD cellular), high jitter | **Stable** fixed-line/good LTE, where you want to *blend in* |
| Loss model | Brutal is **fixed-rate**: ignores loss/RTT as congestion signals, and on loss **sends slightly faster** to hit the target — treats mobile loss as noise, not congestion | BBR models bottleneck bandwidth+RTT, drains queues (kills **bufferbloat**), ~up to 30% over CUBIC on shallow-buffer/high-BDP paths |
| Requirement | You must **set Up/Down Mbps** honestly; over-claiming = self-inflicted loss and unfairness | No per-flow tuning; it's a kernel/QUIC CC choice |
| Coupling | In sing-box, **TCP-Brutal is force-coupled with mux** (rate is per-connection, so mux guarantees exactly one connection) | Works anywhere; enable `bbr` at the OS or in the QUIC lib |
| Fairness | Aggressive/unfair by design — a **feature** on a contended tower, a liability on a shared uplink | Fairer; RTT-fairness favors high-RTT flows |
| DPI shape | UDP/443; some carriers throttle or block QUIC — keep a TCP fallback | Looks like normal TCP HTTPS |

**Recommendation:** ship **both** and auto-select. Default new mobile sessions to **QUIC+Brutal with conservative Up/Down caps**; fall back to **TCP+BBR+XHTTP-over-Cloudflare** when UDP/443 is blocked or when the user is on stable Wi-Fi. Brutal is where the "feels faster than everyone else" reputation on bad networks comes from — but only if you measure real capacity and set the rate, otherwise it just self-congests.

### 15.8 Keepalive, obfuscation, and where the real speed wins are

- **Keepalive:** carrier NATs on mobile drop idle UDP mappings fast (often 30–60 s). Send QUIC PING / mux keepalive every ~15–25 s; on TCP use small XHTTP heartbeat POSTs. Too aggressive = battery + a timing fingerprint; tune per network.
- **Obfuscation / padding:** borrow obfs4's ideas — length **and inter-arrival-timing (IAT)** shaping — but only enough to kill fixed-length tells; XHTTP's `Referer`/`X-Padding` and AnyTLS's padding scheme already cover most of it. Don't add a bespoke obfuscator on top of TLS; it *adds* a fingerprint more often than it removes one.
- **Actual speed wins, in priority order:** (1) **0-RTT resumption + mux** so you almost never pay a cold handshake; (2) **UDP/QUIC core** to dodge TCP-over-TCP meltdown (never run your TCP tunnel inside another reliable TCP layer if you can help it); (3) **Brutal** on lossy links; (4) **minimal framing overhead** — one mux, not two, and stream-one XHTTP over CDN; (5) **optional multipath** — QUIC multipath (see Rust `gm-quic`/`dquic`, which handshakes IPv4+IPv6 simultaneously and survives if any path lives) to bond Wi-Fi+cellular or IPv4+IPv6. Multipath is the highest-effort, lowest-maturity item — treat it as a v3 experiment, not v1.

### 15.9 Borrow from the pluggable-transport standards

Don't reinvent the plugin boundary — adopt these so your payload/obfs layer is swappable per market:

- **SIP003** (Shadowsocks) — the pragmatic contract: the transport plugin runs as a **child process** of the proxy, is handed `SS_LOCAL_HOST/PORT` and `SS_REMOTE_HOST/PORT` + a plugin-opts string, and dies with the parent (SIGCHLD). TCP-only, tunnel-shaped, no per-connection args. This is exactly the shape your **Layer-A payload front** should take: a standalone binary the core execs, so you can rotate bug/obfs logic without touching the core. Reference implementations: `shadowsocks/v2ray-plugin`.
- **Tor Pluggable Transports / obfs4** — obfs4 is the gold standard for the *anti-probing* property you want on direct entries: an **ntor handshake with Elligator2-mapped keys** (the wire looks like uniform random bytes) plus a **per-bridge shared secret the client must prove**, which is precisely what defeats the "scan the IP to see if it's a proxy" attack. REALITY gives you an equivalent guarantee for TLS-shaped traffic; obfs4 is the model if you ever want a *random-looking* (non-TLS) fallback transport. IAT-mode is its length/timing obfuscation knob.

Design your interfaces so a transport is a **module with `Dial()/Listen()` + `obfsWrap()`**, PT/SIP003-style. That single decision lets you A/B new bug payloads and obfuscators per carrier without shipping a new core.

### 15.10 Build recommendation: extend, don't greenfield

**Strong recommendation: build your protocol as a fork/plugin of Xray-core (or sing-box), reusing REALITY + XHTTP + mux, and add only Layer A (payload) and Layer D (auth).** Rationale:

- Xray-core already ships **VLESS + REALITY + XHTTP (all three modes) + XMUX** and is natively packaged (e.g. OpenWrt feeds). You get the hard, security-critical 90% for free and only write the two layers that are actually your product.
- **sing-box** is the better *client* engine (one binary, Android/iOS/desktop, sing-mux + TCP-Brutal + AnyTLS), which matters for a reseller app. **But note:** sing-box has **no runtime plugin mechanism** for transports — adding one means **forking and recompiling** the Go engine (it's a compile-time switch). Xray is comparably closed to runtime plugins, but its transport list is broader.
- **Pragmatic hybrid that ships this quarter:** run **Xray-core as a local SOCKS bridge** (`your-app → SOCKS → Xray VLESS+XHTTP+REALITY outbound`) and put your **payload front + auth in a thin SIP003-style wrapper** in front of it. Zero core changes, full reuse. This is the fastest path to revenue.
- **Greenfield only as fallback**, if you truly need a novel wire format the cores can't express: **Go with `quic-go`** (fastest to a working QUIC tunnel, same language as the cores you'd borrow from) or **Rust with `quinn`** (better memory safety/perf, `gm-quic`/`dquic` for multipath). Expect **6–12+ months** to reach the *security and evasion* maturity REALITY/XHTTP already have — most greenfield tunnels get fingerprinted precisely because they got a subtle TLS/timing detail wrong. Greenfield buys you differentiation and loses you a year; choose it deliberately.

### 15.11 Phased build plan

1. **Phase 0 — Bridge PoC (2–4 wks):** Xray VLESS + REALITY (direct) and VLESS + XHTTP stream-one + uTLS (Cloudflare). Wrap with a SOCKS bridge. Prove both entries work end-to-end in one target market. No custom code yet.
2. **Phase 1 — Payload front (Layer A) (3–6 wks):** SIP003-style child-process wrapper doing CONNECT/Host/CRLF-split + configurable SNI bug. Config-driven per carrier. This is where free-net value appears. Build a **bug-rotation/test harness** (probe hosts, measure "billed vs used").
3. **Phase 2 — Light auth (Layer D) (2–4 wks):** HMAC per-user token on the first inner stream + quota/rate-limit + revocation. Wire to your reseller billing.
4. **Phase 3 — Core selection + Brutal/BBR (3–6 wks):** add QUIC+Brutal path with measured Up/Down caps; TCP+BBR+XHTTP fallback; automatic UDP-blocked detection and failover. Add keepalive tuning per network.
5. **Phase 4 — Resumption & padding polish (2–4 wks):** 0-RTT on QUIC, TLS ticket resumption on TCP, AnyTLS-style padding on the inner if TLS-shaped. Fingerprint self-audit (JA3/JA4, flow counts, timing).
6. **Phase 5 (optional, experimental) — Multipath & greenfield spike:** QUIC multipath bonding (Rust `gm-quic`) and/or a greenfield core if a differentiator justifies the year.

### 15.12 Honest effort/where-the-wins-are summary

- **~80% of the effort you'd fear is already done** in Xray/sing-box. Spend your engineering on **Layer A (payloads + rotation tooling)** and **Layer D (auth/billing)** — that's your actual product and moat.
- **Biggest reliability win:** QUIC/UDP core + 0-RTT + mux (avoids TCP-in-TCP and cold handshakes). **Biggest "free-net" win:** disciplined, fast bug-host rotation, not a cleverer protocol.
- **Biggest risk:** the payload layer is **carrier-policy-dependent and perishable**; SNI/Host-mismatch is a documented detection signal and ECH/ESNI will eventually close SNI bugs. Architect it as swappable config, keep a portfolio of transports (REALITY, XHTTP-CDN, obfs4-style random fallback), and instrument everything so you find out a bug died before your resellers do.

---

## 16. Recommended adoption stack & phased build roadmap

The decision this report exists to make is **what to reuse versus what to build**, and the answer is sharp: reuse all four cores and one panel, build only the payload-rotation tooling and the reseller credit/auth layer. Below is the specific stack, then a phased plan that starts you billing quickly and ends at your own branded protocol.

### The recommended stack (concrete choices)

- **Client engine:** **sing-box** as the embedded core (native Hysteria2 + TUIC + REALITY + all V2Ray transports in one binary), with **Xray-core** as the alternative where you need XHTTP/XMUX exactly. Wrap it in a **Flutter** shell using **Hiddify-App** as your white-label template — it is the cleanest multi-platform sing-box+panel template and the least legal-risk starting point. Keep **v2rayNG** (Xray) and **NekoBox** (sing-box) as Android-only references. Respect the **GPL-3.0 source obligations** these carry.
- **Fast/direct transport (your flagship profile):** **VLESS + XTLS-Vision + REALITY** — no fake cert, genuine allowed-domain SNI, active-probe-resistant. This is your default on stable links and the protocol you brand as your own.
- **CDN / IP-hiding / payload profile:** **VLESS + XHTTP (or ws) over Cloudflare** — carries the zero-rated Host/SNI payload trick and hides your origin IP.
- **Lossy-mobile transport:** **Hysteria2** (apernet/hysteria) — Brutal CC, Salamander obfs, HTTP/3 masquerade, client port-hopping with server-side NAT redirect. This is the highest-impact single choice for the throttled carrier towers in your markets. Pair with **TUIC v5** only if you want a cooperative-CC, lighter alternative.
- **Compatibility/last-resort fallbacks:** **OpenVPN-UDP** (via Nyr/angristan installer) wrapped in stunnel/WS for stealth; **SSH/Dropbear** multiport with **BadVPN-udpgw** on 127.0.0.1:7300 for UDP; **SlowDNS = dnstt** (bamsoftware) as the DNS-only last resort. Keep these because they still win where UDP is blocked and they are what your existing injector-app customers expect.
- **Combo server:** one VPS running **Xray-core or sing-box** as the multi-inbound engine, sharing **port 443 via Xray SNI/ALPN/path fallbacks** (see XTLS/Xray-examples All-in-One-fallbacks-Nginx), with **HAProxy TCP-mode SNI passthrough** or **nginx** in front when you mix non-Xray backends. Tune the box with **BBR + fq**, raised `nofile`/`somaxconn`/`nf_conntrack`, and correct MTU/MSS clamping (section 11's checklist) before you take load.
- **Panel:** start with **3x-ui** for a single box (per-client quota/expiry/IP+HWID limits, built-in subscription server, REST API). Move to **Marzban + Marzban-node** or **PasarGuard/Marzneshin + node** the moment you need multi-node scale-out over gRPC. If native reseller tiers matter more than protocol breadth, use **Hiddify Manager** (Super-admin/Admin/Agent) as the base instead.
- **Traffic accounting:** poll **Xray gRPC StatsService** (`user>>>{email}>>>traffic>>>up/downlink`, reset for deltas) and **Hysteria2's `/traffic` + `/online`** on an interval; cross-check quota/expiry; disable via each core's own kill/remove path (HandlerService.AlterInbound, Hysteria `/kick`, OpenVPN management `client-kill`, SSH count-then-kill). This poll-with-reset loop is the universal pattern.
- **Auth / subscription / API:** issue a **per-user opaque HMAC subscription token** (read-own-config only), short-lived **JWT** panel/reseller sessions from `POST /token`, and long-lived revocable **API keys** for node agents — never collapse the client's dial credential into the panel login. Deliver configs as **User-Agent-negotiated subscription links** (base64 URI list / Clash YAML / sing-box JSON) with `subscription-userinfo` quota headers.
- **The two things you actually build:** (1) a **bug-host rotation service** — scraper + validator + hot-push into the JSON config the client pulls at runtime (this is the openly-reproducible "Vollam Gen" pattern); (2) a **reseller credit wallet + token API** — the one component with no turnkey OSS equivalent, layered on top of the adopted panel, optionally fronted by a Telegram sales bot (botmirzapanel/marzbot) for the money flow.

### Phased build roadmap

- **Phase 0 — PoC (1–2 weeks):** Stand up one Xray-core/sing-box VPS with a single VLESS+Vision+REALITY inbound. Prove an Xray SOCKS-bridge end-to-end on your own phone. No panel, no billing. Goal: confirm the core and REALITY work against your target carriers.
- **Phase 1 — Billable single box (2–4 weeks):** Add Hysteria2 and an OpenVPN-UDP/SSH fallback on the same IP behind 443 fallbacks. Install **3x-ui**. Ship a rebranded **Hiddify-App/v2rayNG** client that pulls a runtime JSON config. You can now sell manually-provisioned accounts.
- **Phase 2 — Metering & self-serve (3–6 weeks):** Wire the **poll-with-reset accounting loop** (Xray StatsService + Hysteria2 stats). Build the **HMAC subscription-token API** and User-Agent-negotiated subscription delivery. Add quota/expiry auto-disable. Add the **credit wallet + reseller tiers** on top of the panel (or adopt Hiddify's tiers). This is where you become a real reseller platform.
- **Phase 3 — Payload front & bug rotation (ongoing):** Build the carrier-specific **CONNECT + fake-Host + CRLF/split + SNI bug-host** layer as a *swappable module* (model it on the SIP003 plugin contract), plus the scraper/validator that rotates bug hosts hot into the client JSON. Treat this as perishable, continuously-maintained infrastructure, not a one-time feature.
- **Phase 4 — Multi-node scale-out (when load demands):** Migrate the panel to **Marzban/Marzneshin/PasarGuard + node agents** over gRPC. Add HAProxy/nginx front, BBR+fq, and the section-11 concurrency sysctls on every node.
- **Phase 5 — Your branded protocol:** Fork/bridge **Xray-core** (REALITY/XHTTP) and **sing-box** (sing-mux/AnyTLS/TCP-Brutal). Ship **QUIC+Brutal for lossy links and TCP+BBR for stable links with auto-failover**, your **light HMAC per-user auth** woven in, and your payload front as Layer A. You are not writing a QUIC or TLS stack — you are composing existing, audited primitives and owning the two layers that are genuinely your product.

The discipline that makes this plan work: **resist greenfielding at every phase.** Roughly 80% of this is prebuilt; your durable moat is bug-rotation velocity and a clean billing/reseller experience, not a novel wire format.

---

## 17. Legal, ethical & operational notes

This ecosystem spans a legitimacy spectrum, and it is worth being precise about where each layer of your stack sits, because the layers carry very different legal and operational risk.

**Legitimate, well-established uses.** Self-hosting a VPN, and using REALITY/XHTTP/QUIC anti-DPI transports to obtain private, uncensored, or unthrottled access to the open internet, is a mainstream and defensible activity — the same techniques underpin widely-respected circumvention tooling for users under censorship. Offering that as a paid, self-serve service with honest metering is an ordinary business.

**The carrier zero-rating / "payload / free-net" exploit is materially different.** The bug-host/SNI-spoofing trick in sections 4, 9, and 15 works by forging the first readable bytes of a connection so a mobile carrier's **billing** engine mis-classifies paid data as a zero-rated hostname. That is not censorship circumvention — it is **exploitation of telecom billing**, which in most jurisdictions violates the carrier's terms of service and, depending on local law, can constitute a form of fraud or theft of service. Build and market this layer knowing that: it is the black-to-gray part of the business, it is why the closed-source injector apps stay closed, and it is legally distinct from the rest of your stack even though it shares the same wire.

**Perishability is also a legal and operational fact, not just a technical one.** Bug hosts are patched within days; the exploit erodes structurally as ECH and SNI-mismatch detection deploy. A business whose revenue depends on it is building on sand and inviting carrier countermeasures. Architect the payload layer as a swappable, quickly-disabled module so that a carrier patch — or a decision to exit that gray activity — degrades gracefully to your legitimate paid transports rather than taking the whole product down.

**Abuse handling you must implement regardless.** A multi-tenant tunnel service will be used, by some customers, for DoS, mass torrenting, spam, and fraud. You need, from Phase 1: enforceable per-user quotas and device caps (already in your metering loop), an abuse/AUP with a real takedown path, rate limits on login / subscription-fetch / admin API as separate buckets (section 14), and the ability to disable an account instantly via each core's kill path. Your upstream VPS providers will forward complaints; have a process before you have the complaints.

**Licensing.** Every core in the recommended stack — sing-box, Xray-core, mihomo, Hiddify — is **GPL-3.0** (Hysteria2 and OpenVPN installers are more permissive; TUIC is GPL-3.0). A branded client that embeds these cores inherits **source-availability obligations**; plan to publish your client source (or restructure around the plugin boundary) rather than assume a closed white-label app is compliant. This is a real constraint on the "closed branded APK" model that vendors like Vollam gloss over.

**Scaling and reputation.** As you grow, IP reputation, carrier ASN blocking, and node churn become the dominant operational costs — budget for multi-domain/CDN fronting, rotating origin IPs, and the multi-node panel architecture early, and keep the legitimate-transport core clean and separable so the business survives the inevitable loss of any single gray-area trick.

---

## 18. Your existing repo asset: `websocket-proxy.js`

This repository already ships a working example of the **CDN-fronting** pattern described in sections 6, 10 and 15. `websocket-proxy.js` is a Netlify **Edge Function** (wired up by `netlify.toml` on path `/*`) that:

1. Accepts only HTTP requests carrying an `Upgrade: websocket` header (rejects everything else with `400`).
2. Rewrites the request's hostname to a backend V2Ray server (`v2ray.dopekidanime.tech`) and re-issues it, **preserving the WebSocket headers**, so the client's VMess/VLESS-over-WebSocket stream is relayed through Netlify's edge to your origin.

In ecosystem terms this is a **domain-fronting / CDN reverse-proxy front** for a `vless+ws` or `vmess+ws` inbound. Its value: the TLS SNI the carrier/DPI sees is Netlify's (a large, hard-to-block CDN), while the real origin is hidden behind it — the same principle as fronting Xray WebSocket through Cloudflare Workers.

**How it fits the roadmap:**

- Keep it as one of several **front options** (Netlify Edge, Cloudflare Workers/`pages`, and a self-hosted nginx/HAProxy SNI router — see section 10). Fronts get blocked or rate-limited, so you want more than one.
- **Harden before production:** the current version hard-codes a single backend and blindly forwards any WebSocket request. Add (a) an allow-list or signed token on the `backend`/path so it can't be used as an open relay, (b) a health/fallback origin, and (c) alignment of the `path` with your Xray inbound `wsSettings.path` so only your own clients traverse it.
- **Limitation:** Netlify Edge Functions are request/response relays, not raw TCP tunnels — they work for `ws`/`xhttp`-style transports that ride HTTP, but not for OpenVPN-UDP, Hysteria2-QUIC, or SSH-direct, which need a real VPS (section 10). Treat this file as the *HTTP-transport front*, and the combo server as everything else.


---

## 19. Appendix — consolidated open-source project & repo index

Grouped by the section that covers it. Entries are as reported by the research agents; verify a repo before adopting it (forks and rebrands are common in this space).


### Android all-in-one VPN clients

- sing-box (core) — universal Go proxy core behind SFA/NekoBox/Hiddify — https://github.com/SagerNet/sing-box
- sing-box for Android (SFA) — reference sing-box client, unprivileged TUN — https://github.com/SagerNet/sing-box-for-android
- v2rayNG — most-deployed Android client, Xray/v2fly core — https://github.com/2dust/v2rayNG
- AndroidLibXrayLite — gomobile AAR wrapping Xray-core for v2rayNG — https://github.com/2dust/AndroidLibXrayLite
- Hiddify-App — Flutter+sing-box multi-platform, best white-label template — https://github.com/hiddify/hiddify-app
- hiddify-sing-box (hiddify-core) — Hiddify's sing-box fork — https://github.com/hiddify/hiddify-sing-box
- NekoBox for Android — sing-box toolchain with plugin protocols — https://github.com/MatsuriDayo/NekoBoxForAndroid
- nekoray — Qt desktop sing-box GUI, NO LONGER MAINTAINED — https://github.com/MatsuriDayo/nekoray
- Matsuri — older SagerNet/V2Ray fork, superseded — https://github.com/MatsuriDayo/Matsuri
- Clash Meta for Android (CMFA) — mihomo core, rule-based routing — https://github.com/MetaCubeX/ClashMetaForAndroid
- mihomo (Clash.Meta) — rule-based Go core (YAML) — https://github.com/MetaCubeX/mihomo
- FlClash — Flutter+mihomo cross-platform Clash client — https://github.com/chen08209/FlClash
- Clash Verge Rev — Tauri/Rust DESKTOP-only mihomo GUI (not Android) — https://github.com/clash-verge-rev/clash-verge-rev
- sing-tun — TUN + gVisor/system netstack used by sing-box on Android — https://github.com/SagerNet/sing-tun
- hev-socks5-tunnel — fast C tun2socks used by v2rayNG/NekoBox — https://github.com/heiher/hev-socks5-tunnel

### Injector payload mechanics

- miyurudassanayake/sni-injector — Python SNI injector (stunnel 443 + SSH + SOCKS5 1080), the reference OSS implementation — https://github.com/miyurudassanayake/sni-injector
- tavgar/Custom-Internet — SSH-over-WebSocket with payload + SNI-fronting; PAYLOAD_TEMPLATE using [host]/[crlf], SOCKS on 1080 — https://github.com/tavgar/Custom-Internet
- hndko/payload-injector-generator — Python generator emitting Front/Back Inject, Front/Back Query, WebSocket and SNI payload templates — https://github.com/hndko/payload-injector-generator
- kirula0626/SNI_Injector — Python TCP-over-SSL SNI tunnel (stunnel→SSH→SOCKS5), Windows/Linux — https://github.com/kirula0626/SNI_Injector
- AlizerUncaged/HTTP-Injector — Java tool that modifies HTTP proxy CONNECT requests/responses to bypass ISP filtering (MIT) — https://github.com/AlizerUncaged/HTTP-Injector
- wijayamin/python-http-injector — HTTP payload injector packaged for OpenWRT/LEDE routers — https://github.com/wijayamin/python-http-injector
- JeelsBoobz/http-injector — Python http/ssl/ssh injector for rooted Android and Linux — https://github.com/JeelsBoobz/http-injector
- hndko/bughttpinjector — Python scraper that auto-collects fresh bug hosts/IPs for injector configs — https://github.com/hndko/bughttpinjector
- tools-inet/hctools — Node decryptor for .hc/.ehi/eProxy/NapsternetV/SocksHTTP config files — https://github.com/tools-inet/hctools
- kralonur/multi-vpn-decryptor-rs — Rust/WASM decryptor for HTTP Injector (.ehi), HTTP Custom (.hc), SSH Custom (.ssc) — https://github.com/kralonur/multi-vpn-decryptor-rs
- noobconner21/Http-Injector-Decrypt-Script — simple .ehi config decrypt script — https://github.com/noobconner21/Http-Injector-Decrypt-Script
- akilaid/HTTP-CUSTOM-HEADERS-VPN — Python custom-header SSH tunnel for censorship bypass — https://github.com/akilaid/HTTP-CUSTOM-HEADERS-VPN

### OpenVPN all modes

- Nyr/openvpn-install — minimal universal OpenVPN road-warrior installer (UDP/TCP, custom port, tls-crypt) — https://github.com/Nyr/openvpn-install
- angristan OpenVPN installer — knob-heavy fork (cipher/DH/DNS/tls-crypt choices); archived mirror verified — https://github.com/angristan/OpenVPN-install-fork-old
- erebe/wstunnel — Rust WebSocket/HTTP2 tunnel wrapping TCP+UDP with TLS/SNI, reverse tunnels, path-prefix auth (WS modes 80/8088) — https://github.com/erebe/wstunnel
- vi/websocat — netcat-for-WebSockets relay used to bridge TCP sockets to ws:// for OpenVPN-over-WS — https://github.com/vi/websocat
- stunnel — generic SSL/TLS shim wrapping OpenVPN-TCP on 443/444 with real cert + SNI — https://stunnel.org
- GegeDevs/sshvpn-script — combo autoscript bundling OpenVPN + stunnel + Dropbear-WS + Softether — https://github.com/GegeDevs/sshvpn-script
- jubairbro/AUTO-SCRIPT — combo VPS script (OpenVPN, stunnel4, Dropbear, BadVPN, Xray) — https://github.com/jubairbro/AUTO-SCRIPT
- syapik96/aws — autoscript with OpenVPN-WS, Stunnel4 SSL/TLS, WebSocket-Python, Dropbear — https://github.com/syapik96/aws
- scvps/scriptvps — combo installer (OpenVPN, SSH-WS, Stunnel4, Dropbear, V2Ray/Xray) — https://github.com/scvps/scriptvps
- NevermoreSSH/hop — SlowDNS/SSH/Dropbear/Stunnel5/OpenVPN/WS combo autoscript — https://github.com/NevermoreSSH/hop
- kirula0626/SNI_Injector — Python TCP-over-SSL SNI injector (HTTP-Injector alternative for desktop) — https://github.com/kirula0626/SNI_Injector
- tharushaudana/ssh-over-tls-stunnel — guide: OpenVPN/SSH over TLS via stunnel + HTTP Injector config — https://github.com/tharushaudana/ssh-over-tls-stunnel

### V2Ray/Xray protocols

- XTLS/Xray-core — reference core for VLESS, XTLS-Vision, REALITY, XHTTP — https://github.com/XTLS/Xray-core
- XTLS/Xray-examples — official copy-pasteable REALITY/Vision/fallback configs — https://github.com/XTLS/Xray-examples
- Project X docs — canonical protocol & transport reference — https://xtls.github.io
- SagerNet/sing-box — lightweight universal proxy platform (client+server), REALITY + V2Ray transports — https://github.com/SagerNet/sing-box
- v2fly/v2ray-core — original V2Ray continuation, VMess/VMess-AEAD — https://github.com/v2fly/v2ray-core
- SagerNet/v2ray-core — SagerNet's V2Ray fork feeding Android clients — https://github.com/SagerNet/v2ray-core
- 2dust/v2rayN — Windows GUI client over Xray-core — https://github.com/2dust/v2rayN
- 2dust/v2rayNG — Android GUI client over Xray-core — https://github.com/2dust/v2rayNG
- refraction-networking/utls — Go uTLS library for browser ClientHello fingerprint mimicry (used by REALITY)
- PdYrust/cf-xray-proxy — Cloudflare Worker reverse proxy for VLESS/VMess/Trojan over ws/xhttp/httpupgrade — https://github.com/PdYrust/cf-xray-proxy
- net4people/bbs — community anti-censorship discussion incl. the XHTTP transmission guide (issue #440) — https://github.com/net4people/bbs

### QUIC fast protocols

- apernet/hysteria (a.k.a. HyNetworks/hysteria) — Hysteria2 QUIC proxy core: Brutal CC, Salamander obfs, HTTP/3 masquerade, port hopping, HTTP auth + traffic API — https://github.com/apernet/hysteria
- tuic-protocol/tuic (formerly EAimTY/tuic) — TUIC v5 0-RTT QUIC proxy, Full-Cone UDP, UDP-over-stream vs native — https://github.com/tuic-protocol/tuic
- SagerNet/sing-box — universal core with Hysteria2 and TUIC as inbound+outbound (up/down mbps, obfs, brutal, masquerade) — https://github.com/SagerNet/sing-box
- HyNetworks/tcp-brutal — Hysteria's Brutal congestion control as a Linux TCP kernel module — https://github.com/HyNetworks/tcp-brutal
- mihomo (MetaCubeX) — clash-compatible core documenting Hysteria2 + TUIC client/server support — https://wiki.metacubex.one/en/config/proxies/hysteria2/
- Hysteria2 docs — Port Hopping, Full Server Config, Traffic Stats API — https://v2.hysteria.network/docs/advanced/Port-Hopping/
- Censored Planet — 'Is Custom Congestion Control a Bad Idea for Circumvention Tools?' (Brutal fairness critique) — https://censoredplanet.org/papers/congestion.pdf

### DNS + custom UDP transports

- dnstt — DNS-over-HTTPS/DoT tunnel with Noise encryption + KCP/smux (the real engine behind most "SlowDNS") — https://github.com/getlantern/dnstt (official: https://www.bamsoftware.com/software/dnstt/)
- iodine — classic full-IP DNS tunnel (TUN, multi-record, raw-UDP fallback, no crypto) — https://github.com/yarrick/iodine
- BadVPN (udpgw + tun2socks) — UDP gateway on 127.0.0.1:7300 that gives SSH tunnels real UDP for gaming/VoIP — https://github.com/ambrop72/badvpn
- udp-zivpn — community installer for ZIVPN UDP (Hysteria-v1-style QUIC tunnel, :5667, DNAT 6000-19999) — https://github.com/zahidbd2/udp-zivpn
- powermx/dnstt — injector 'SlowDNS (dnstt)' server + SSH installer — https://github.com/powermx/dnstt
- fisabiliyusri/SLDNS — SSH-over-DNS (SlowDNS) autoscript with UDP/DoT/DoH client ports — https://github.com/fisabiliyusri/SLDNS
- dns2tcp — legacy TCP-over-DNS relay (older 'SlowDNS' base, no encryption) — https://github.com/alex-sector/dns2tcp
- feely666/udp-custom — udp-custom server (config.json + system/SSH-account auth) for injector UDP clients — https://github.com/feely666/udp-custom
- rudi9999/SocksIP-udpServer — udp-custom/SocksIP UDP server installer bound to SSH accounts — https://github.com/rudi9999/SocksIP-udpServer
- osproject-vpn/Autoscript — multi-service injector autoscript bundling SSH/UDP/DNSTT/SLOWDNS/XRAY — https://github.com/osproject-vpn/Autoscript
- Hysteria — upstream QUIC proxy (Salamander obfs, Brutal CC) that ZIVPN's UDP server is derived from — https://github.com/apernet/hysteria
- Mygod/dnstt — dnstt mirror + SIP003 plugin (deprecated, now slipstream-rust) — https://github.com/Mygod/dnstt

### SSH tunneling family

- dnstt (SlowDNS) — canonical SSH-over-DNS tunnel, KCP+smux+Noise — https://www.bamsoftware.com/software/dnstt/
- Mygod/dnstt — maintained GitHub mirror of dnstt with SIP003 plugin — https://github.com/Mygod/dnstt
- FreeNetLabs/AutoScriptX — full SSH/WS/SSL/SlowDNS VPS installer with account mgmt — https://github.com/FreeNetLabs/AutoScriptX
- tavgar/Custom-Internet — Python SSH-over-WS client with local SOCKS + payload/SNI modes — https://github.com/tavgar/Custom-Internet
- JeelsBoobz/http-injector — open-source HTTP/SSL/SSH injector (redsocks + payload) for Android/Linux — https://github.com/JeelsBoobz/http-injector
- superbad1/sshwsxray — autoscript with pure-Python sshws.py 101-upgrade WS bridge — https://github.com/superbad1/sshwsxray
- NevermoreSSH/hop — AutoScript XRAY/SSH/DNSTT WebSocket (Dropbear multi-port) — https://github.com/NevermoreSSH/hop
- erebe/wstunnel — robust Rust WS/HTTP2 tunnel, static binary, DPI bypass — https://github.com/erebe/wstunnel
- google/huproxy — HTTP-Upgrade proxy designed to carry SSH via ProxyCommand — https://github.com/google/huproxy
- FosterG4/stunnel — reference stunnel config for SSH-SSL on 443 — https://github.com/FosterG4/stunnel
- misteralipour/shellscripts — concurrent-SSH-session limiter (the 'lock multi-login' pattern) — https://github.com/misteralipour/shellscripts
- kirula0626/SNI_Injector — Python SNI/TLS injector alternative to HTTP Injector — https://github.com/kirula0626/SNI_Injector

### Combo server / multiport

- shopeevpn/Hysteria-auto-script — one-click 9-protocol combo autoscript (Hysteria/Xray/OpenVPN/SSH) — https://github.com/shopeevpn/Hysteria-auto-script
- jubairbro/AUTO-SCRIPT — SSH/Dropbear/stunnel/BadVPN/Xray multiport autoscript with explicit port map — https://github.com/jubairbro/AUTO-SCRIPT
- osproject-vpn/Autoscript — combo autoscript that ships nginx + HAProxy SNI loadbalancer by default — https://github.com/osproject-vpn/Autoscript
- XTLS/Xray-core (+ XTLS/Xray-examples All-in-One-fallbacks-Nginx) — one process, many inbounds, 443 fallbacks by SNI/ALPN/path — https://github.com/XTLS/Xray-examples
- SagerNet/sing-box — single binary running SS/VMess/VLESS/Trojan/Hysteria2/TUIC/WireGuard inbounds — https://sing-box.sagernet.org
- apernet/hysteria — Hysteria2 QUIC/UDP core with auth.http + trafficStats API (maps to the 9998 bridge) — https://github.com/apernet/hysteria
- erebe/wstunnel — tunnel arbitrary TCP/UDP over WebSocket/HTTP2, the OSS WS+HTTP-proxy piece — https://github.com/erebe/wstunnel
- ambrop72/badvpn — badvpn-udpgw, UDP-over-SSH gateway on 127.0.0.1:7300 — https://github.com/ambrop72/badvpn
- Gozargah/Marzban (+ Marzban-node) — de-facto panel + node agent for horizontal scaling — https://github.com/gozargah/marzban
- marzneshin/marzneshin (+ marznode) — multi-node-first panel with Xray + Hysteria2 backends — https://github.com/marzneshin/marzneshin
- MHSanaei/3x-ui — single-box Xray panel with per-client quota/expiry/IP-limit + multi-node + REST API — https://github.com/MHSanaei/3x-ui
- ZagrosGM/Zagros-Node — standalone multi-core node agent (xray, sing-box, OpenVPN, WireGuard, SSH) — https://github.com/ZagrosGM/Zagros-Node

### Speed & stability engineering

- apernet/tcp-brutal — Hysteria's fixed-rate congestion control ported to TCP as a Linux kernel module — https://github.com/apernet/tcp-brutal
- apernet/hysteria (Hysteria2) — QUIC transport with Brutal CC and UDP port hopping for lossy/throttled links — https://v2.hysteria.network/docs/advanced/Port-Hopping/
- SagerNet/sing-box — multi-protocol core exposing smux/yamux/h2mux mux + brutal (up/down_mbps) — https://sing-box.sagernet.org/configuration/shared/multiplex/
- XTLS/Xray-core — XHTTP/SplitHTTP + XMUX bidirectional up/down connection splitting — https://xtls.github.io/en/config/transports/splithttp.html
- klzgrad/naiveproxy — canonical BBR/buffer/notsent_lowat host-tuning reference — https://github.com/klzgrad/naiveproxy/wiki/Performance-Tuning
- go-gost/gost (v3) — GO Simple Tunnel with mux-TLS/WS, KCP and QUIC transports (v2: ginuerzh/gost) — https://github.com/ginuerzh/gost
- pufferffish/wireproxy (formerly octeep/wireproxy) — userspace WireGuard exposing SOCKS5/HTTP — https://github.com/pufferffish/wireproxy
- xtaci/smux — lightweight stream multiplexer used by sing-box/KCP stacks — https://github.com/xtaci/smux
- hashicorp/yamux — robust Go stream multiplexer offered as a sing-box mux option — https://github.com/hashicorp/yamux
- sbwml/package_kernel_tcp-brutal — TCP Brutal packaged as an OpenWrt kernel module — https://github.com/sbwml/package_kernel_tcp-brutal
- google/bbr — BBRv3 development tree (not in mainline Linux; via patched kernels e.g. XanMod)
- Linux MPTCP (RFC 8684, kernel ≥5.6) + mptcpize/mptcpd userspace tooling — https://www.mptcp.dev/

### Reseller panels & subscriptions

- 3x-ui — most-starred single-server Xray panel: per-client quota/expiry/IP+HWID limits, built-in base64/JSON/Clash sub server, REST API; single admin (no reseller) — https://github.com/MHSanaei/3x-ui
- x-ui (alireza0 fork) — maintained successor to the original vaxilu/x-ui; adds WireGuard/WARP, Reality, Telegram bot; single-admin — https://github.com/alireza0/x-ui
- Marzban — Python/React control-plane panel with sudo/non-sudo admins, periodic-reset quotas, full REST API, v2ray/Clash/sing-box/Outline subs — https://github.com/Gozargah/Marzban
- Marzban-node — remote Xray node agent for Marzban multi-node scale-out/HA (svc :3000, Xray API :3001) — https://github.com/Gozargah/Marzban-node
- Marzneshin — Marzban fork built for scalability; users gated by 'services', multi-admin (WIP) — https://github.com/marzneshin/marzneshin
- marznode — Marzneshin's gRPC node controller fronting Xray, Hysteria2, sing-box, WireGuard backends — https://github.com/marzneshin/marznode
- Hiddify Manager — 20+ protocols; Super-admin/Admin/Agent tiers with per-admin user & active-user caps (closest native reseller-shaped OSS), CDN/multi-domain, Telegram bot — https://github.com/hiddify/Hiddify-Manager
- S-UI — sing-box web panel: per-client cap/expiry, link/JSON/Clash subs, /apiv2 REST; single-node (panel :2095, sub :2096) — https://github.com/alireza0/s-ui
- PasarGuard/panel — Marzban-lineage successor: multi-admin RBAC, WireGuard+Hysteria2, full REST API — https://github.com/PasarGuard/panel
- PasarGuard/node — gRPC node backend for PasarGuard scale-out (default :62050) — https://github.com/PasarGuard/node
- Xray-checker — Prometheus prober that spins up Xray-core to actively test each sub node; REST API + public status page (monitoring, not management) — https://github.com/kutovoys/xray-checker
- OCS-style SSH reseller panel + autoscripts — native credit/deposit + SSH session caps (closest to Vollam's model) but dormant/community-maintained — https://github.com/kangismet/ocspanel and https://github.com/osproject-vpn/Autoscript

### Vollam & app-generator ecosystem

- Vollam / Vollam Gen — closed-source white-label VPN panel + branded-APK generator with runtime JSON config sync — https://vollam.com
- HTTP Injector (Evozi) — proprietary .ehi payload/SSH/SNI injector client; the format the whole scene clones — https://play.google.com/store/apps/details?id=com.evozi.injector
- NapsternetV / Npv Tunnel — .npv/.npv2-4 'locked' V2Ray/SSH/Psiphon config client — https://play.google.com/store/apps/details?id=com.napsternetlabs.napsternetv
- DarkTunnel — SSH + SSH-over-DNSTT(SlowDNS) + V2Ray client — https://play.google.com/store/apps/details?id=net.darktunnel.app
- SocksIP Tunnel — SSH/WS/UDP payload-injector tunnel app — com.newtoolsworks.sockstunnel (AppBrain listing)
- Nest VPN — V2Ray-based branded consumer app (no verified public generator/panel) — https://play.google.com/store/apps/details?id=n24.nest.project
- v2rayNG — most-rebranded open-source Android Xray/V2Ray client — https://github.com/2dust/v2rayNG
- sing-box — universal proxy platform embedded as an engine in custom apps — https://github.com/SagerNet/sing-box
- mihomo (Clash.Meta) — Clash-compatible routing core resellers embed — https://github.com/MetaCubeX/mihomo
- Xray-core (XTLS) — reference VLESS-Reality/XHTTP/gRPC core — https://github.com/XTLS/Xray-core
- Hysteria — QUIC/HTTP-3-masquerade proxy + Brutal congestion control — https://github.com/apernet/hysteria
- dnstt / SlowDNS — DNS-tunnel primitive behind every 'SlowDNS' feature (maintained fork) — https://github.com/getlantern/dnstt

### Auth, subscription API, traffic accounting

- Marzban — Xray panel with per-user HMAC subscription tokens, REST API, admin/reseller split — https://github.com/Gozargah/Marzban
- 3x-ui — single-server Xray panel with expiry/quota/IP-limit (fail2ban 3x-ipl jail) — https://github.com/MHSanaei/3x-ui
- marzpy — Python client for the Marzban API — https://github.com/mewhrzad/marzpy
- marzban-sdk — fully typed Marzban API SDK — https://github.com/Ilmar7786/marzban-sdk
- h-ui — Hysteria2 management panel — https://github.com/jonssonyan/h-ui
- Hysteria2-API — Python client over the Hysteria2 Traffic Stats API — https://github.com/ReturnFI/Hysteria2-API
- CELERITY-panel — multi-protocol (Hysteria2 + Xray VLESS) panel with ACL/scoped API/subscriptions — https://github.com/ClickDevTech/CELERITY-panel
- OpenVPN-Metrics-Exporter — scrapes the OpenVPN management interface for per-client byte/session stats — https://github.com/Fadi-hamwi/OpenVPN-Metrics-Exporter
- ovpn-radius — Go OpenVPN plugin doing RADIUS auth + accounting (wraps radclient) — https://github.com/rakasatria/ovpn-radius
- openvpn_webpanel_manager — multi-protocol panel with resellers/sub-admins and API — https://github.com/eylandoo/openvpn_webpanel_manager
- SSHPLUS-MANAGER-FREE — SSH/free-net reseller account manager script — https://github.com/AAAAAEXQOSyIpN2JZ0ehUQ/SSHPLUS-MANAGER-FREE
- Xray-core — the core exposing HandlerService/StatsService gRPC used for live user + traffic management — https://github.com/XTLS/Xray-core

### Designing your own protocol

- Xray-core — REALITY/XHTTP/VLESS reference core to fork or bridge — https://github.com/XTLS/Xray-core
- sing-box — universal client with sing-mux, TCP-Brutal, AnyTLS — https://github.com/SagerNet/sing-box
- Hysteria 2 — QUIC + Brutal congestion-control reference for lossy mobile — https://v2.hysteria.network
- quinn — Rust QUIC library for a greenfield core (0-RTT, pluggable crypto) — https://github.com/quinn-rs/quinn
- quic-go — Go QUIC library, fastest path to a custom QUIC tunnel — https://quic-go.net
- gm-quic / dquic — Rust multipath QUIC (IPv4+IPv6 simultaneous handshake) — https://github.com/genmeta/dquic
- obfs4 (Yawning) — PT anti-active-probing + Elligator2/ntor + IAT model — https://github.com/Yawning/obfs4
- v2ray-plugin — SIP003 child-process transport-plugin reference — https://github.com/shadowsocks/v2ray-plugin
- SIP003 spec — plugin process/opts contract to model Layer A on — https://shadowsocks.org/doc/sip003.html
- AnyTLS (sing-box) — TLS-in-TLS padding scheme + idle session pool — https://sing-box.sagernet.org/configuration/inbound/anytls/
- XHTTP: Beyond REALITY — design writeup of the three XHTTP modes/XMUX — https://github.com/XTLS/Xray-core/discussions/4113
- payload-injector-generator — open reference for .ehi-style CONNECT/Host/CRLF payloads — https://github.com/hndko/payload-injector-generator


## 20. Shortlist — the best complete, good-looking, well-maintained open-source VPN apps (verified 2026-09-17)

Direct answer to "which open-source VPN apps have everything / look good / function well." Every star count, license, core and last-release date below was fetched from the actual GitHub repo/releases pages on 2026-09-17; where a datum could not be confirmed it is marked *not verified* rather than guessed. Three clusters (rebrandable clients, polished self-hostable suites, business/reseller suites), then one cross-cluster ranking.

### Overall ranking & which to pick

These three clusters answer different jobs, so the single best answer depends on what you're actually building. Below is one cross-cluster shortlist, best-first, with the decision guide underneath.

1. **Hiddify Manager** (github.com/hiddify/Hiddify-Manager, GPL-3.0) — pick this if you want a reseller/hosting business live this week with the least assembly: engine (Xray+sing-box), admin-tiered panel, subscription API, and its own polished cross-platform client all in one box, 20+ protocols, actively maintained (v12.3.3). The only turnkey "business-in-a-box" on the list.
2. **Amnezia VPN** (github.com/amnezia-vpn/amnezia-client, GPL-3.0) — pick this if you're a single operator who wants "has everything, looks good, self-hostable" for your own use: widest protocol set (AmneziaWG/WG/OpenVPN/Cloak/Shadowsocks/XRay-REALITY/IKEv2) behind a polished desktop+mobile GUI that auto-installs the Docker server over SSH, shipping ~weekly.
3. **3x-ui** (github.com/MHSanaei/3x-ui, GPL-3.0) — pick this if panel quality and protocol breadth matter more than turnkey reselling: strongest and best-maintained panel (46.5k stars, release Sep 2026, multi-node), GPL means no network-use source disclosure. It's single-admin with no bundled client, so you supply the billing/reseller layer and client yourself.
4. **Karing** (github.com/KaringX/karing, MIT) — pick this if you need a client to rebrand and ship under your own name: MIT license makes it the cleanest white-label base, Flutter across six platforms (adds tvOS), sing-box core, active (v1.2.25.2802).
5. **Hiddify (app)** (github.com/hiddify/hiddify-app, GPL-3.0) — pick this if you want the single best-looking, most-complete all-in-one client and don't need to quietly rebrand: full sing-box protocol set, 5 platforms, very active (v4.1.1). Rebrand is allowed but GPL §7 riders forbid doing it silently.
6. **PasarGuard** (github.com/PasarGuard/panel, AGPL-3.0) — pick this if you specifically need true multi-tenant reseller RBAC in the Marzban lineage: the actively-developed successor with multi-admin + gRPC multi-node. AGPL means you must offer source to hosted users, and there's no bundled client.
7. **NetBird** (github.com/netbirdio/netbird) — pick this if your "VPN" is actually private team/mesh access rather than censorship-evasion egress: best-looking self-hostable zero-trust dashboard, 5-minute Docker install, WireGuard-only.
8. **Outline** (github.com/OutlineFoundation/outline-apps, Apache-2.0) — pick this if permissive licensing for a rebrand outweighs protocol range: extremely polished, trivial Manager-driven self-host, most rebrand-friendly license on the list — but single-protocol (Shadowsocks).

Runners-up worth knowing: **FlClash** (best-looking client, but mihomo-only, no iOS), **v2rayNG** and **Clash Meta for Android** (excellent but Android-only), **Clash Verge Rev** (most polished desktop client, no mobile), **wg-easy** (cleanest simple WG self-host GUI), **S-UI** (polished sing-box panel, single-admin). Avoid as fresh bases: **NekoBox** (semi-abandoned), **Marzban/Marzneshin** (frozen/stalling), **x-ui** (abandoned), **Streisand** and **wireguard-ui** (dead/stale).

### Decision guide

- **Rebrandable client (ship a VPN app under your own name):** **Karing** — MIT is the only license here that permits a clean, quiet white-label. If you can live with GPL §7 attribution riders and want the prettier/fuller product, take Hiddify instead.
- **Self-host a polished suite for your own use:** **Amnezia VPN** — the literal "everything, good-looking, self-hostable" pick. Choose NetBird instead only if your real need is mesh/zero-trust team access, or Outline if you want the most permissive license and single-protocol simplicity is fine.
- **Reseller / VPN business:** **Hiddify Manager** — the only end-to-end bundle (engine + panel + subscriptions + its own client) with GPL's no-network-disclosure freedom. Go **3x-ui** if you'd rather bolt your own billing onto the strongest panel, or **PasarGuard** if native multi-admin reseller RBAC is non-negotiable (accepting AGPL's source-offer obligation).


### Multiplatform / mobile all-in-one proxy clients — vetted for 2026

All stars, licenses, cores and last-release dates below were fetched directly from each GitHub repo and its releases page (today = 2026-09-17). Where a repo page didn't expose a datum I say "not verified" rather than guess.

| App (repo) | Platforms | Core / protocols & features | Open source & license | Maintained (last release seen) | Self-host / rebrand fit | Verdict |
|---|---|---|---|---|---|---|
| **Hiddify** (`hiddify/hiddify-app`) | Android, iOS, Windows, macOS, Linux — **Flutter** | **sing-box** core → VLESS, VMess, Reality, Trojan, SS, TUIC, Hysteria(1/2), WireGuard, SSH; imports sing-box/v2ray/Clash/Clash-Meta subs; TUN, auto-select, per-app, remote profiles | GPL-3.0 **+ Section-7 riders** (fork must stay a public GitHub fork, kept in sync, built via Actions, credit Hiddify, no original name/design on stores) | Very active — v4.1.1, **2026-03-05** (32.7k★) | Cross-platform template, but license makes a clean white-label the hardest of the top tier | **Best "has everything + looks good"** all-in-one; rebrand is legally encumbered |
| **Karing** (`KaringX/karing`) | Windows, Android, iOS, macOS, Linux, **tvOS** — **Flutter** | Modified **sing-box** core → Clash / v2ray / sing-box / SS subs; geo rulesets, routing groups, iCloud/LAN/WebDAV sync, beginner mode | **MIT** | Active — v1.2.25.2802, **2026-09-11** (14.9k★) | **Best rebrand/white-label fit**: MIT + Flutter + widest platform set incl. tvOS | Cleanest legal base to rebrand; UI is tidy but a notch below Hiddify/FlClash |
| **FlClash** (`chen08209/FlClash`) | Android, Windows, macOS, Linux (**no iOS**) — **Flutter** | **mihomo (Clash.Meta)** core → VMess/VLESS/Trojan/SS/Hysteria/TUIC/WireGuard via mihomo; Material You, themes, WebDAV sync | GPL-3.0 | Very active, weekly cadence — v0.8.98, **2026-09-14** (52.4k★) | Great-looking Flutter template, but plain GPL copyleft and **no iOS** limits "all-platform" | **Best-looking** of the Flutter clients; mihomo-only protocol set and missing iOS |
| **v2rayNG** (`2dust/v2rayNG`) | **Android only** — native Kotlin | **Xray/v2fly** core → VMess, VLESS, Trojan, SS, SOCKS | GPL-3.0 | Very active — v2.3.8, **2026-09-10** (62.7k★); migrating UI to Jetpack Compose | Android-only ⇒ not a cross-platform template | Huge install base and rock-solid, but single-platform and UI only now modernizing |
| **Clash Meta for Android** (`MetaCubeX/ClashMetaForAndroid`) | **Android only** — native Kotlin | **mihomo** core → full Clash.Meta protocol/rule set | GPL-3.0 | Active — v2.11.34, **2026-09-14** (46.3k★) | Android-only; utilitarian UI | Reference mihomo GUI on Android; functional, not pretty; single-platform |
| **sing-box SFA/SFI** (`SagerNet/sing-box`) | Android, iOS, macOS, tvOS (official apps) | The **sing-box** core itself — broadest protocol support of any core | GPL-3.0 **+ no-name/association clause** | Core extremely active — v1.14.1, **2026-09-15** (38.1k★) | Reusing the name/brand is explicitly disallowed; GUIs are config-driven/spartan | Gold-standard engine, deliberately bare front-end; a base to build on, not to ship as-is |
| **NekoBox for Android** (`MatsuriDayo/NekoBoxForAndroid`) | **Android only** — native | **sing-box** core → SS/VMess/VLESS/Trojan/AnyTLS/ShadowTLS/TUIC/Hysteria 1-2/WireGuard/SSH (+plugins) | GPL-3.0 | **Semi-abandoned** — v1.4.2, **2025-02-09**; devs state "minimal maintenance," Play build is 3rd-party non-OSS (22.8k★) | Android-only and fading | Broad protocols but **stale**; avoid as a fresh base |
| *Clash Verge Rev* (`clash-verge-rev/clash-verge-rev`) | **Desktop only** — Win/Linux/macOS (Tauri 2 + React) | **mihomo** core; visual node/rule editor, TUN, WebDAV, CSS injection | GPL-3.0 | Active, slower cadence — v2.5.2, **2026-07-19** (145k★) | Desktop-only; out of the mobile cluster | **Most polished desktop** Clash client; no mobile |
| *v2rayN* (`2dust/v2rayN`) | **Desktop only** — Win/Linux/macOS | Xray + sing-box + others | GPL-3.0 | Active — 7.25.1, **2026-09-10** (116.3k★); UI framework not verified on page | Desktop companion to v2rayNG | Powerful desktop hub; not a mobile/all-in-one client |
| *Furious* (`LorenEteval/Furious`) | Desktop (PySide6/Qt) | Xray + Hysteria → VLESS/VMess/SOCKS/Reality | GPL-3.0 | Active but niche — 0.8.1, **2026-09-09** (1.5k★) | Small project, desktop-only, narrow core set | New Fluent UI is nicer, but limited reach and protocols |

#### Picks

**If you want one app that genuinely "has everything," looks modern, and runs everywhere: Hiddify.** It is the fullest realization of the brief — Flutter across all five platforms, the whole sing-box protocol matrix, imports every common subscription format, and a genuinely polished 2026 UI on a fast release cadence. The catch is the license: its GPL-3.0 *Section 7* riders force any fork to remain a public, in-sync GitHub fork built via Actions, with credit, and forbid shipping under the original name/design. You can rebrand, but not quietly.

**If rebranding/white-labeling is the priority: Karing.** It is the only top-tier client under a permissive **MIT** license, is Flutter, covers the widest platform set (adds tvOS), and rides the same sing-box engine — so a clean, legally-unencumbered white-label starts here. UI is clean and functional, a step behind Hiddify/FlClash in visual flourish, but nothing you can't restyle.

**If you care most about looks and are Android+desktop only: FlClash.** The Material-You interface is the best-looking of the bunch and it ships weekly, but it's mihomo-only (Clash protocol set) and has **no iOS**, so it's not truly "every platform."

**Solid but single-platform:** v2rayNG (Xray, Android, massive base, UI finally moving to Compose) and Clash Meta for Android (mihomo, Android, workmanlike UI) are dependable Android clients — great to *offer*, poor as cross-platform rebrand bases.

**Engine, not a shippable skin:** sing-box's own SFA/SFI give you the best protocol coverage but a deliberately bare, config-driven UI, and the license bars reusing the name.

**Avoid as a fresh base:** NekoBox — broad protocols but the maintainers explicitly say it's on minimal maintenance (last stable Feb 2025) and the Play build is a third-party closed fork.

**Out of the mobile cluster but worth knowing:** Clash Verge Rev is the most beautiful desktop Clash client (Tauri/React) and v2rayN the most capable desktop hub — pair either with a mobile pick if you also need desktop, but neither is a mobile/all-in-one.


### Polished, self-hostable open-source VPN suites — verified assessment (Sept 2026)

Star counts are rounded as GitHub displays them and reflect what I saw when fetching each repo. "Last release seen" is the newest release/tag I could actually verify; where I couldn't confirm an exact current version I mark it **not verified**.

| App | Platforms | Protocols / features | Open source & license | Maintained (last release seen) | Self-host / rebrand fit | Verdict |
|---|---|---|---|---|---|---|
| **Amnezia VPN** (`amnezia-vpn/amnezia-client`) | Win, macOS, Linux, Android, iOS | **Broadest here:** AmneziaWG, WireGuard, OpenVPN, OpenVPN-over-Cloak, Shadowsocks, XRay/REALITY, IKEv2 | GPL-3.0 (~15k★) | **Very active** — v5.0.2.1, **Sep 3 2026** (weekly cadence) | Client SSHes into your VPS and auto-installs Docker containers — GUI *is* the server installer. Server stack (amneziawg-go, kernel module, tools, xray-core) all in-org. GPL = rebrand allowed but copyleft (must publish source) | **#1 for "has everything + looks good + self-host."** Censorship-circumvention focus |
| **NetBird** (`netbirdio/netbird`) | ~everything (Linux/mac/Win/mobile/BSD/routers/NAS) | WireGuard **mesh** overlay; SSO/MFA, posture checks, policies, ACLs, activity log, API | BSD-3-Clause core + AGPLv3 (mgmt/signal/relay) (~29k★) | **Very active** — v0.78.2, **Sep 14 2026** | ~5-min Docker quickstart, needs domain + ports. Permissive core aids rebrand; mgmt plane is AGPL | Best **mesh/zero-trust** self-host with a polished dashboard — but single-protocol (WG) |
| **Outline** (`OutlineFoundation/outline-apps`) | Manager: Win/mac/Linux · Client: +iOS/Android | **Shadowsocks only** | Apache-2.0 (~9k★) | **Active** — v1.21.x, **2026** (Jigsaw/Google) | Manager GUI provisions a cloud server or one-line Docker. Apache-2.0 = **easiest to legally rebrand** | Gorgeous UX, trivial self-host, but *one* protocol — not "everything" |
| **wg-easy** (`wg-easy/wg-easy`) | Linux via Docker (web UI is cross-platform) | WireGuard only; client CRUD, QR, Tx/Rx charts, 2FA, dark mode, i18n | AGPL-3.0 (~27k★) | **Active** — v15 rewrite, betas through **2026** (last *stable* tag v15.4.0 Aug 2024; dev ongoing) | Single Docker container — the easiest WG GUI to stand up | Cleanest simple WG manager; WG-only, v15 UI is a real step up |
| **Pritunl** (`pritunl/pritunl`) | Server: Linux (+MongoDB) · Clients: cross-platform | OpenVPN **+** WireGuard clients, IPsec for site-to-site | Open-source core, some features paid (permissive; exact SPLIT **not fully verified**) (~5k★) | **Active** — v1.34.x, **Jul 2026** | Self-hostable but heavier (needs MongoDB); graphical admin, no SSH needed | Multi-protocol + GUI, but enterprise-flavored and dated; more moving parts |
| **Firezone** (`firezone/firezone`) | Win/mac/Linux/iOS/Android + headless | WireGuard-based **zero-trust** | Elastic License 2.0 (control plane, **not OSI-open**) + Apache-2.0 (rest) (~9k★) | **Very active** — clients **Sep 2026** | ⚠️ "Production self-hosting **not officially supported**"; published clients bind to the managed service. Elastic License restricts commercial rebrand | Polished + active, but the 1.x pivot demoted self-host — weak fit for a self-host operator |
| **Headscale** (`juanfont/headscale`) | Control server: Linux/NixOS · uses **Tailscale** clients | Self-hosted Tailscale coordination (WireGuard mesh) | BSD-3-Clause (~44k★) | **Active** in 2026; exact latest tag **not verified** (v0.26/0.29 line reported inconsistently) | Headless — **no first-party GUI** (third-party headscale-ui/headplane). Permissive server, but clients are Tailscale's | Excellent self-hosted mesh control plane; you don't own/rebrand the client |
| **Algo** (`trailofbits/algo`) | Deploys for iOS/mac/Android/Win/Linux/OpenWrt | WireGuard + IPsec/IKEv2 only | AGPL-3.0 (~30k★) | **Active** — v2.0.0, **2026** | Ansible/CLI only — **no GUI**; spits out configs/QR | Rock-solid & secure, but zero UI and narrow protocol set |
| **wireguard-ui** (`ngoduykhanh/wireguard-ui`) | Linux / Docker | WireGuard only | MIT (~5k★) | ⚠️ **Stale** — v0.6.2, **Jan 2024** (~2.7 yrs) | Easy Docker, but dated UI and dormant | Superseded by wg-easy — avoid for new deployments |
| **Streisand** (`StreisandEffect/streisand`) | Ansible against cloud VPS | Many (WG, OpenVPN, Shadowsocks, OpenConnect, Tor, sslh…) | ~24k★ | ❌ **Archived Jun 4 2021 — dead** | CLI/Ansible, no GUI | Historical only; do not deploy |

#### Picks by use case

**If the goal is the brief literally — "looks good, functions well, has everything, self-hostable": Amnezia VPN is the clear winner.** Nothing else here pairs a genuinely broad protocol set (AmneziaWG/WG/OpenVPN/Cloak/Shadowsocks/XRay-REALITY/IKEv2) with a polished desktop+mobile GUI that *installs the server for you* over SSH, and it ships releases roughly weekly (v5.0.2.1 on Sep 3 2026). Its niche is censorship circumvention, and GPL-3.0 permits rebranding provided you publish your modified source (copyleft).

**If the real need is a private overlay network for a team/fleet (mesh/zero-trust), not censorship evasion: NetBird.** Best-looking self-hostable dashboard in this set, ferociously maintained, ~5-minute Docker install. It's WireGuard-only by design. **Headscale** is the alternative if you specifically want the Tailscale ecosystem self-hosted — but it has no first-party GUI and you deploy Tailscale's clients. **Firezone** looks great and is very active, but its 1.x line effectively deprecated production self-hosting and ties clients to its managed cloud, plus the Elastic-licensed control plane blocks commercial rebrand — I'd steer a self-host operator away from it.

**If you want the simplest possible polished self-host and one protocol is fine: Outline** (Shadowsocks, Apache-2.0 — the most rebrand-friendly license here, dead-easy Manager) or **wg-easy** (WireGuard, cleanest one-container GUI, v15 rewrite active in 2026).

**Multi-protocol with a classic admin console: Pritunl** (OpenVPN + WireGuard + IPsec, active) — but it's heavier (MongoDB) and more enterprise/dated than Amnezia.

**Avoid: Streisand** (archived 2021), **wireguard-ui** (last release Jan 2024, superseded by wg-easy). **Algo** is excellent and maintained but is CLI/Ansible with no GUI, so it fails the "looks good" bar.


### Reseller/Business VPN Suites — "everything for running a VPN business" (verified 2026-09-17)

All of these are Linux-server panels installed via Docker/one-line script; "Platforms" below refers to where the *client* config is consumed, since the panel itself is server-side. Star counts and dates were fetched live from GitHub; where GitHub omitted a year the value is the current year (2026) unless noted.

| App | Platforms (client reach) | Protocols / suite features | Open source & license | Maintained (last release/commit seen) | Self-host / rebrand fit | Verdict |
|---|---|---|---|---|---|---|
| **Hiddify Manager** (hiddify/Hiddify-Manager) | Own cross-platform **Hiddify-App** (Win/mac/Linux/iOS/Android) + any sub-client | 20+ protocols (Reality, Hysteria2, TUIC, SS, WireGuard, SSH, Trojan, VLESS/VMess, MTProto) over Direct/CDN/domain-fronting; multi-admin privileges, per-user time+traffic limits, user sub pages, Xray+sing-box cores | Yes — **GPL-3.0** (~9.3k★) | Active — v12.3.3, **29 May 2026** | Good self-host, one-line install; GPL (no AGPL network clause) so hosted SaaS is easy, but "Hiddify" branding is baked into panel + app-store client, so full rebrand is more work | **Closest to a full business-in-a-box**: engine + panel + subscription + matching polished client, admin tiers. Best least-assembly base. |
| **3x-ui** (MHSanaei/3x-ui) | Any sub-client (raw/JSON/Clash sub output) — pair with v2rayNG, NekoBox, Streisand, Hiddify-App, Clash Meta | **Broadest engine list**: VLESS, VMess, Trojan, SS, WireGuard, AmneziaWG, TUIC v5, Hysteria2, MTProto, SOCKS/HTTP, Dokodemo; per-client traffic/quota/expiry/IP-limit, built-in subscription server, Telegram bot, multi-node (clone inbounds across servers) | Yes — **GPL-3.0** (~46.5k★, by far the largest) | **Most active of all** — v3.8.5, **16 Sep 2026** (Xray v26.9.9, large-fleet node sync) | Excellent: one-command install, GPL-friendly for hosting, rebrand is common in the reseller scene | **Best-maintained, best-looking, most protocols.** Weakness: single-admin by design — **no native reseller/credit tiers**, no bundled client. Superb base if you add a reseller layer or run solo-admin. |
| **PasarGuard / panel** | Any sub-client; **PasarGuard Node** (gRPC :62050) for scale-out | VMess, VLESS, Trojan, SS, WireGuard, Hysteria2 (+sing-box/OpenVPN/MTProto via forks), TLS/REALITY; **multi-admin RBAC (real reseller tiers)**, periodic traffic limits, full REST API, multi-node | Yes — **AGPL-3.0** (~2.6k★) | Active — v5.4.1, commits **12 Sep 2026** | Self-hosts well; **AGPL network-copyleft** means you must offer source to your users → friction for a closed rebrand | **The living successor to the Marzban architecture.** Best pick if you specifically want proper multi-tenant reseller roles, actively developed. Younger, smaller community, no bundled client. |
| **Marzneshin** (marzneshin/marzneshin) | Any sub-client; **marznode** backends (Xray/sing-box) | VMess, VLESS, Trojan, SS via Xray; multi-node for distribution/fault-tolerance, periodic traffic reset, sub API; multi-admin **WIP** | Yes — **AGPL-3.0** (~700★) | Slowing — last commit **3 Oct 2025** (~11 mo) | Docker-compose install, AGPL caveat as above | Cleaner multi-node Marzban fork, but small community and stalling. Pick PasarGuard over it for the same lineage. |
| **Marzban** (Gozargah/Marzban) + **Marzban-node** | Any sub-client (V2ray/Clash/ClashMeta); Marzban-node for scale-out | VMess, VLESS, Trojan, SS; traffic+expiry limits, sub links, REST API, **multi-admin still "WIP"** | Yes — **AGPL-3.0** (~7.4k★) | **Frozen** — v0.8.4, last commit **~Jan 2025** (~20 mo); open "is this project dead?" issues | Self-hostable but stagnant; AGPL caveat | Historically the reference panel, now effectively abandoned. **Use PasarGuard/Marzneshin instead** — do not start a new business on frozen upstream. |
| **S-UI** (alireza0/s-ui) | Panel :2095, sub :2096 (sing-box/Clash sub); any sub-client | sing-box engine: VLESS/VMess/Trojan/SS + ShadowTLS, Hysteria/Hysteria2, Naive, TUIC; per-client cap/expiry, online stats, advanced routing UI | Yes — **GPL-3.0** (~9.9k★) | Active — v1.6.3, commits **16 Sep 2026** | One-command install, GPL-friendly | Polished sing-box panel from the alireza0 (x-ui fork) author, but **single-admin, no reseller tiers, no client** — a personal/small-fleet panel more than a reseller suite. |
| **x-ui** (vaxilu/x-ui) | n/a | Original multi-protocol Xray panel | GPL-3.0 (~19.1k★) | **Abandoned** — original discontinued ~2021, ~80 commits total | Legacy | **Dead. Superseded by 3x-ui.** Ignore for anything new. |

**Client pairings (to the other clusters):** Hiddify Manager pairs natively with **Hiddify-App** (its own multiplatform client — the tightest match). 3x-ui / S-UI / PasarGuard / Marzneshin / Marzban all emit standard subscription URLs (raw / Clash / sing-box), so hand customers **v2rayNG, NekoBox/sing-box, Streisand or FoXray (iOS), Clash Meta / Clash Verge**, or **Hiddify-App** as a universal sub consumer.

**License note for rebranding a hosted service:** the **GPL-3.0** projects (Hiddify, 3x-ui, S-UI) have no network-use clause, so running them as a paid SaaS does not force source disclosure to your users. The **AGPL-3.0** projects (Marzban, PasarGuard, Marzneshin) do — a rebranded hosted deployment must offer your modified source to end users. Either way, GPL/AGPL require you keep the license and cannot make it fully closed-source.

**Picks:**
- **Want the most complete, least-assembly, best-looking base with a client already included → Hiddify Manager.** It is the only one here that ships the whole chain (Xray+sing-box engine + admin-tiered panel + subscription + a genuinely polished cross-platform client), and it's actively maintained.
- **Want the most protocols, the largest community, the most active project and the slickest panel, and you'll handle the reseller/billing layer yourself → 3x-ui.** Technically the strongest and best-maintained, but it is single-admin, so it isn't a turnkey *multi-tenant reseller* system on its own.
- **Want proper multi-admin/reseller RBAC in the Marzban lineage, still actively developed → PasarGuard.** Choose it over Marzban (frozen) and Marzneshin (stalling). Mind the AGPL if you plan a closed rebrand.


