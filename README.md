# SlopProx — AI Slop Filter

A Windows desktop app that filters AI-generated content from the web in real time — across every browser, every site, without configuration.

**Website:** [slopprox.com](https://slopprox.com) &nbsp;·&nbsp; **Pro extension:** [pro.slopprox.com](https://pro.slopprox.com)

---

## What it does

Runs a local HTTPS proxy that intercepts browser traffic and automatically detects and hides:

- **AI-generated text** — hybrid heuristic + on-device ML transformer, blended confidence score
- **AI-generated images** — 3-model on-device ONNX ensemble with metadata forensics *(opt-in, extension required)*
- **AI-disclosed YouTube videos** — videos where the creator declared "Altered or synthetic content" via YouTube's mandatory AI label
- **Ads and trackers** — blocked at the network level before they reach the browser

Flagged content is replaced with a compact placeholder showing confidence and detection method. One click reveals the original.

---

## Architecture

```
┌──────────────────────────────────────────┐
│                  Browser                 │
└───────────────────┬──────────────────────┘
                    │
          ┌─────────▼──────────┐
          │   PAC File Routing  │  127.0.0.1:8081/filter.pac
          └────────┬────────────┘
                   │
       ┌───────────┴────────────┐
       │                        │
┌──────▼───────────┐    ┌───────▼─────────┐
│   HTTPS Proxy    │    │     DIRECT       │
│   port 8081      │    │   (no proxy)     │
│                  │    │                  │
│ • Ad blocking    │    │ • HuggingFace    │
│ • HTML injection │    │   (model DL)     │
│ • Text filter    │    │ • API paths      │
│ • YouTube filter │    │ • Asset files    │
└──────────────────┘    └─────────────────┘

┌──────────────────────────────────────────┐
│         Browser Extension (MV3)          │
│  content.js → background.js → :8083      │
│                                          │
│ • Social media card detection            │
│ • AI image classification                │
│ • YouTube feed badges                    │
└──────────────────────────────────────────┘
```

**Proxy pipeline** — An HTTPS MITM proxy (mockttp) intercepts HTML navigations and injects a detection script into every page. The script calls back via relative URLs (`/__slop_filter_classify`, `/__slop_filter_youtube`) handled internally — bypassing CSP `connect-src` restrictions entirely.

**Extension pipeline** — A Chrome MV3 extension runs alongside the proxy for sites where structural card access is needed: social media feeds, image detection, and YouTube feed badges. A background service worker bridges to the local service on port 8083 (required by Chrome's Private Network Access policy).

**PAC routing** — Routes only real browser navigations to the proxy. HuggingFace CDN (model downloads), API paths, asset files (JS/CSS/images/video/fonts), and WebSocket connections go DIRECT. Browser-only detection (`Sec-Fetch-*` / `sec-ch-ua` headers) ensures VS Code, Discord, Steam, and other desktop apps are never intercepted.

---

## Features

### AI text detection

Two-stage hybrid classification:

**Stage 1 — Heuristic (always available, zero latency)**
Scores text against 74 hand-curated LLM-characteristic phrases with word-boundary matching, plus structural signals: sentence length variance, average sentence length, emoji density, list frequency, lexical diversity, and structural openers. Raw score is normalised to a 0–1 confidence value.

**Stage 2 — ML model (after first load)**
Local ONNX transformer (`onnx-community/tmr-ai-text-detector-ONNX`). Blended with heuristic at 55% model / 45% heuristic. A cross-signal penalty applies when the two signals strongly disagree.

Detection threshold: 38% blended confidence. Text is classified with section context (nearest heading prepended) so identical text under "References" and the article body scores differently.

### AI image detection

Multi-layer pipeline. Each layer feeds into the next; early exit on high-confidence metadata signals.

**Layer 0 — URL matching (zero latency)**
28 known AI CDN/service URL patterns (DALL-E, Midjourney, Runway, Pika, Kling, Hailuo, Grok/Aurora, Stable Diffusion CDNs, etc.). Returns score 0.90–1.0 immediately if matched — no fetch required.

**Layer 1 — Metadata forensics**
Runs on the fetched image bytes before any ML inference:

- *HTTP headers* — `x-generator`, `x-ai-generator`, `x-generated-by`, `x-model`, plus AWS/GCP AI metadata headers
- *EXIF tags* — 30+ known AI generator strings (Stable Diffusion, DALL-E, Midjourney, Firefly, Flux, RunwayML, Pika, Kling, SynthID, and more)
- *C2PA manifest* — scans raw bytes for `c2pa.ai.generativeActions` and known AI tool references (Adobe Firefly, OpenAI, Imagen, etc.)
- *PNG tEXt/iTXt chunks* — detects generation parameters embedded by AUTOMATIC1111, ComfyUI (KSampler/CheckpointLoaderSimple/FluxGuidance nodes), NovelAI, InvokeAI, and Fooocus
- *HTML meta tags* — 30+ AI generator `<meta name="generator">` values plus IPTC `trainedAlgorithmicMedia`, `aigc`, and Google SynthID declarations

**Layer 2 — 3-model ONNX ensemble**

| | Model | Size | Role |
|---|---|---|---|
| A | `yaya36095/ai-source-detector` | ~84 MB | Multi-label ViT: SD / MJ / DALL-E / real / other |
| B | `onnx-community/SMOGY-Ai-images-detector-ONNX` | ~52 MB | Binary diffusion vs. real — veto/confirm role |
| C | `onnx-community/Deep-Fake-Detector-v2-Model-ONNX` | ~87 MB | Face manipulation / deepfake detector |

All three models run concurrently. Confidence is a weighted average (A: 1.0×, B: 1.2×, C: 0.8×). Model B acts as a veto (suppresses ensemble when it scores <5% AI) and a booster (amplifies when it scores ≥90%). Model C adds an independent third opinion, particularly valuable when A and B disagree.

Images <300px, GIFs, SVGs, data URIs, and extreme aspect ratios are skipped automatically.

### YouTube AI-disclosure filter

Checks `window.ytInitialPlayerResponse.containsSyntheticMedia` (synchronous, before first paint) and falls back to a DOM text search for YouTube's disclosure string.

- **Watch / Shorts:** Full-screen overlay pauses the player. Buttons: *Play anyway* or *Next video*.
- **Feed / search:** Card dimmed and badged *🤖 AI-disclosed*.

### Ad and tracker blocking

Matched at the proxy level before responses reach the browser. Blocklist of 29 ad networks (DoubleClick, Taboola, Criteo, AppNexus, Rubicon, Outbrain…) plus a URL pattern catch-all for ad/pixel/beacon/tracking segments. Returns HTTP 204. A whitelist protects YouTube, Netflix, Google, GitHub, Wikipedia, and Microsoft infrastructure.

---

## SlopProx Pro

**SlopProx Pro** is a standalone Chrome extension for professional AI detection — no desktop app, no proxy, no certificate installation. Designed for newsrooms, universities, and research teams.

Key differences from the open-source app:

| | SlopProx (this repo) | SlopProx Pro |
|---|---|---|
| Deployment | Windows desktop app + MITM proxy | Chrome extension only |
| Text detection | ✓ Proxy-level, all sites | ✓ Right-click any selection |
| Image detection | ✓ Extension + 3-model ensemble | ✓ Right-click any image |
| Signal breakdown | Basic | Full forensic breakdown with confidence per signal |
| Licence | GPL-3.0, free forever | Commercial — [pro.slopprox.com](https://pro.slopprox.com) |

---

## Installation

1. Download the installer from the [Releases](../../releases) page
2. Run `SlopProx Setup.exe`
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

Counters at the top show **all-time totals** for blocked text, ads, images, and YouTube videos — persisted across restarts. An estimated time-saved figure is shown beneath.

---

## Settings

Accessible via the cog icon in the title bar:

- **Launch at Windows startup** — registers with Windows login items
- **Minimize to tray** — close button hides the window instead of quitting
- **Default states** — set which features are on/off at launch

---

## Development

**Requirements:** Node.js 18+, Windows

```bash
git clone https://github.com/ross-walpole/SlopProx.git
cd SlopProx
git lfs pull          # downloads the ONNX text model (~84 MB)
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
| `classifier.js` | All detection logic — text heuristics, ML blending, image forensics, ONNX ensemble |
| `pac.js` | PAC file generator — routing rules |
| `state.js` | Shared mutable state (feature flags) |
| `counts.js` | Persistent all-time counter storage (`counts.json`) |
| `logger.js` | File + console logger (no Electron dependency) |
| `preload.js` | IPC context bridge (renderer ↔ main) |
| `injected.js` | Script injected into every page by the proxy |
| `index.html` | Dashboard UI |
| `extension/` | Chrome MV3 extension — content script, background worker, popup |
| `models/` | Local ONNX text model (Git LFS) |
| `landing-page/` | Marketing site source (React + Vite) — deployed to slopprox.com |

---

## Privacy

All detection runs entirely on-device. No browsing data, page content, or images are sent anywhere. The only external traffic is the proxied requests to sites you visit normally, plus one-time model downloads from HuggingFace on first enable.

---

## Tech stack

- **[Electron](https://www.electronjs.org/)** — desktop shell and system tray
- **[mockttp](https://github.com/httptoolkit/mockttp)** — HTTPS MITM proxy with certificate generation
- **[@huggingface/transformers](https://huggingface.co/docs/transformers.js)** — ONNX inference for text classification
- **[onnxruntime-node](https://onnxruntime.ai/)** — direct ONNX inference for image ensemble models
- **[sharp](https://sharp.pixelplumbing.com/)** — image pre-processing before ML inference
- **Chrome Extension MV3** — content script for card detection and image filtering

---

## Licence

**GPL-3.0-only** — see [LICENSE](./LICENSE) for terms.

This software is free and open source. You are free to use, modify, and distribute it under the same licence. Any derivative work distributed publicly must also be released under GPL-3.0.

The three ONNX image detection models bundled or downloaded by this app are sourced from HuggingFace and are subject to their own upstream licences.

Copyright (C) 2026 Ross Walpole.
