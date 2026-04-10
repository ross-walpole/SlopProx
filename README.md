# SlopProx — AI Slop Filter

A Windows desktop app that filters AI-generated content from the web in real time — across every browser, every site, without configuration.

---

## What it does

Runs a local HTTPS proxy that intercepts browser traffic and automatically detects and hides:

- **AI-generated text** — detected using a local transformer model blended with heuristic phrase analysis
- **AI-generated images** — classified by a 3-model on-device ensemble *(opt-in, extension required)*
- **AI-disclosed YouTube videos** — videos where the creator declared "Altered or synthetic content" via YouTube's mandatory AI label
- **Ads and trackers** — blocked at the network level before they reach the browser

Flagged content is replaced with a compact placeholder showing confidence and detection method. One click reveals the original.

---

## Architecture

```
┌─────────────────────────────────────────┐
│                 Browser                 │
└──────────────────┬──────────────────────┘
                   │
         ┌─────────▼──────────┐
         │   PAC File Routing  │  127.0.0.1:8081/filter.pac
         └────────┬───────────┘
                  │
      ┌───────────┴────────────┐
      │                        │
┌─────▼────────────┐    ┌──────▼──────────┐
│   HTTPS Proxy    │    │     DIRECT       │
│   port 8081      │    │   (no proxy)     │
│                  │    │                  │
│ • Ad blocking    │    │ • HuggingFace    │
│ • HTML injection │    │   (model DL)     │
│ • Text filter    │    │ • API paths      │
│ • YouTube filter │    │ • Asset files    │
└──────────────────┘    └─────────────────┘

┌─────────────────────────────────────────┐
│         Browser Extension (MV3)         │
│  content.js → background.js → :8083     │
│                                         │
│ • Social media card detection           │
│ • AI image classification               │
│ • YouTube feed badges                   │
└─────────────────────────────────────────┘
```

**Proxy pipeline** — An HTTPS MITM proxy (mockttp) intercepts HTML navigations and injects a detection script into every page. The script calls back via relative URLs (`/__slop_filter_classify`, `/__slop_filter_youtube`) handled internally — bypassing CSP `connect-src` restrictions entirely.

**Extension pipeline** — A Chrome MV3 extension runs alongside the proxy for sites where structural card access is needed: social media feeds, image detection, and YouTube feed badges. A background service worker bridges to the local service on port 8083 (required by Chrome's Private Network Access policy).

**PAC routing** — Routes only real browser navigation to the proxy. HuggingFace CDN (model downloads), API paths, asset files (JS/CSS/images/video/fonts), and WebSocket connections go DIRECT. Browser-only detection (`Sec-Fetch-*` / `sec-ch-ua` headers) ensures VS Code, Discord, Steam, and other desktop apps are never intercepted.

---

## Features

### AI text detection

Two-stage hybrid classification:

**Stage 1 — Heuristic (always available, zero latency)**
Scores text against 74 hand-curated LLM-characteristic phrases with word-boundary matching, plus structural signals: sentence length variance, average sentence length, emoji density, list frequency, lexical diversity, and structural openers.

**Stage 2 — ML model (after first load)**
Local ONNX transformer (`onnx-community/tmr-ai-text-detector-ONNX`). Blended with heuristic: model 55% / heuristic 45%. A cross-signal penalty reduces false positives when they disagree.

Threshold: 38% blended confidence. Text is classified with section context (nearest heading prepended) so identical text under "References" and the article body scores differently.

### AI image detection

Three ONNX vision models running as an ensemble (opt-in, extension required):

| | Model | Size | Role |
|---|---|---|---|
| A | `yaya36095/ai-source-detector` | ~84 MB | Multi-label ViT: SD / MJ / DALL-E / real / other |
| B | `onnx-community/SMOGY-Ai-images-detector-ONNX` | ~52 MB | Binary AI vs Real — veto/confirm role |
| C | `onnx-community/Deep-Fake-Detector-v2-Model-ONNX` | ~87 MB | Deepfake & synthetic detector — third vote |

Voting logic: majority of A+B+C votes wins. Model B acts as a veto (suppresses A when it scores <5% AI) and a booster (confirms A when it scores ≥90% AI). C adds an independent third opinion, particularly useful when A and B disagree.

A C2PA manifest check runs first — scans raw image bytes for generator metadata (Adobe Firefly, OpenAI, Imagen…). Zero false positives when present.

Images <300px, GIFs, SVGs, data URIs, and extreme aspect ratios are skipped automatically.

### YouTube AI-disclosure filter

Checks `window.ytInitialPlayerResponse.containsSyntheticMedia` (synchronous, before first paint) and falls back to a DOM text search for YouTube's disclosure string.

- **Watch / Shorts:** Full-screen overlay pauses the player. Buttons: *Play anyway* or *Next video*.
- **Feed / search:** Card dimmed and badged *🤖 AI-disclosed*.

### Ad and tracker blocking

Matched at the proxy level before responses reach the browser. Blocklist of 29 ad networks (DoubleClick, Taboola, Criteo, AppNexus, Rubicon, Outbrain…) plus a URL pattern catch-all for ad/pixel/beacon/tracking segments. Returns HTTP 204. A whitelist protects YouTube, Netflix, Google, GitHub, Wikipedia, and Microsoft infrastructure.

---

## Installation

1. Download the installer from the [Releases](../../releases) page
2. Run `AI Slop Filter Setup.exe`
3. The app launches in the system tray and activates automatically

On first run the app generates a self-signed CA certificate ("AI Slop Filter") and installs it into the Windows certificate store via PowerShell — this is what allows the proxy to read HTTPS traffic locally. If auto-install fails, use the *Reinstall Cert* button in the dashboard.

### Browser extension (recommended)

Enables card-level social media filtering, AI image detection, and YouTube feed badges. Without it, only proxy text filtering and ad blocking are active.

1. Open the dashboard and click **Install Extension**
2. Follow the 4-step wizard — it copies the unpacked extension path and walks through enabling Developer mode in Chrome/Brave/Edge

---

## Dashboard

| Control | What it does |
|---|---|
| AI Text Filter | Enables/disables text detection |
| Ad Blocker | Enables/disables ad and tracker blocking |
| Browser Extension | Install wizard and extension folder opener |
| AI Image Detection | Opt-in 3-model ensemble (loads ~220 MB on first enable) |
| YouTube AI Filter | Enables/disables disclosure overlay and feed badges |
| Reset Counters | Zeroes all lifetime stats |
| Reinstall Cert | Re-runs PowerShell cert install |
| Debug Log | Opens the log file in Explorer |

Counters at the top show **all-time totals** for blocked text, ads, images, and YouTube videos — persisted across restarts. An estimated time-saved figure is shown beneath (conservative, Brave-style methodology).

---

## Settings

Accessible via the cog icon in the title bar:

- **Launch at Windows startup** — registers with Windows login items
- **Minimize to tray** — close button hides the window instead of quitting
- **Default states** — set which features are on/off when the app launches (image detection requires the extension installed and models loaded at least once)

---

## Development

**Requirements:** Node.js 18+, Windows

```bash
git clone https://github.com/devR0ss/SlopProx.git
cd SlopProx
git lfs pull          # downloads the 84 MB ONNX text model
npm install
npm start             # run in development (Electron)
npm run build         # build NSIS installer → dist/
```

The text model is stored in `models/` and tracked with Git LFS. The three image models download automatically from HuggingFace on first enable and are cached locally.

### Project structure

| File | Role |
|---|---|
| `main.js` | Electron main process — window, tray, IPC, lifecycle |
| `proxy.js` | HTTPS MITM proxy — HTML injection, ad blocking, relay endpoints |
| `service.js` | HTTP service (`:8083`) — classification API for the extension |
| `classifier.js` | All ML inference — text heuristics, model blending, image ensemble |
| `pac.js` | PAC file generator |
| `state.js` | Shared mutable state (feature flags, counters) |
| `counts.js` | Persistent all-time counter storage (`counts.json`) |
| `preload.js` | IPC context bridge (renderer ↔ main) |
| `index.html` | Dashboard UI |
| `extension/` | Chrome MV3 extension — content script, background worker, popup |
| `models/` | Local ONNX text model (Git LFS) |

---

## Privacy

All detection runs entirely on-device. No browsing data, page content, or images are sent anywhere. The only external traffic is the proxied requests to sites you visit normally, plus one-time model downloads from HuggingFace.

---

## Tech stack

- **[Electron](https://www.electronjs.org/)** — desktop shell and system tray
- **[mockttp](https://github.com/httptoolkit/mockttp)** — HTTPS MITM proxy with certificate generation
- **[@huggingface/transformers](https://huggingface.co/docs/transformers.js)** — local ONNX inference (text + image)
- **Chrome Extension MV3** — content script for card detection and image filtering

---

## License

MIT
