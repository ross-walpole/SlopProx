# SlopProx

**SlopProx** is a Windows desktop app that filters AI-generated content from the web in real time — across every browser, every site, without configuration.

> 🌐 [slopprox.com](https://slopprox.com)

---

## What it does

SlopProx runs a local HTTPS proxy that intercepts web traffic and automatically detects and hides:

- **AI-generated text** — paragraphs and articles written by LLMs, detected using a local transformer model combined with heuristic phrase analysis
- **AI-generated images** — images produced by Stable Diffusion, DALL-E, Flux, Midjourney and similar tools *(opt-in)*
- **AI-disclosed YouTube videos** — videos where the creator has declared "Altered or synthetic content" using YouTube's mandatory AI label
- **Ads and trackers** — requests to known ad networks and tracking domains blocked before they reach the browser

When content is flagged it is replaced with a compact placeholder showing the confidence score and detection method. One click reveals it.

---

## Architecture

SlopProx operates two parallel detection pipelines that complement each other:

```
┌──────────────────────────────────────────────────────┐
│                      Browser                         │
└───────────────────┬──────────────────────────────────┘
                    │
          ┌─────────▼──────────┐
          │  PAC File Routing  │  http://127.0.0.1:8081/filter.pac
          └─────────┬──────────┘
                    │
        ┌───────────┴────────────┐
        │                        │
┌───────▼──────────┐    ┌────────▼───────┐
│   HTTPS Proxy    │    │    DIRECT       │
│   port 8081      │    │  (no proxy)     │
│                  │    │                 │
│ • Ad blocking    │    │ • X.com/Twitter │
│ • HTML injection │    │ • HuggingFace   │
│ • Text filter    │    │   (model DL)    │
│ • YouTube filter │    │ • Asset files   │
└──────────────────┘    │ • API calls     │
                        └─────────────────┘

┌──────────────────────────────────────────────────────┐
│             Chrome Extension (optional)               │
│                                                      │
│  content.js → background.js → Service API :8083      │
│                                                      │
│ • Social media card detection (X, LinkedIn, Reddit…) │
│ • AI image detection                                 │
│ • YouTube feed card badges                           │
│ • Session stats in popup                             │
└──────────────────────────────────────────────────────┘
```

### Proxy pipeline
An HTTPS MITM proxy (mockttp) intercepts HTML page navigations and injects a detection script and stylesheet into every page. The injected script communicates back to the proxy via relative URLs (`/__slop_filter_classify`, `/__slop_filter_status`) which are handled internally and never forwarded upstream — bypassing CSP `connect-src` restrictions entirely.

### Extension pipeline
A Chrome MV3 extension runs on every page alongside the proxy. It handles sites where the proxy alone isn't sufficient: social media feeds where cards need to be detected structurally, image classification, and Chrome-only signals. Because Chrome's Private Network Access policy blocks extension content scripts from reaching `localhost`, a background service worker acts as the bridge to the local service on port 8083.

### PAC routing
The PAC file routes traffic intelligently so the proxy only sees what it needs to:
- **DIRECT:** HuggingFace CDN (so model downloads complete before the proxy is ready), X.com and Twitter (TLS fingerprint-sensitive), asset files (`.js`, `.css`, images, video, fonts), API path segments (`/api/`, `/graphql/`, `/oauth/`…), WebSocket connections
- **Proxy:** YouTube watch/shorts pages, all other HTML page navigations

---

## Features

### AI text detection

Text is classified using a two-stage hybrid approach:

**Stage 1 — Heuristic scoring (always available, zero latency)**

Scores text against 74 hand-curated LLM-characteristic phrases with word-boundary matching — things like *"delve into"*, *"nuanced approach"*, *"without further ado"*, *"game-changer"*, *"actionable insights"*, *"let me know in the comments"* — plus structural signals:

- Sentence length variance (LLMs write unusually uniform sentences)
- Average sentence length (LLMs cluster in the 20–38 word range)
- Emoji density
- Bullet and numbered list frequency
- Lexical diversity (word repetition ratio)
- Structural openers: *"In this article"*, *"In conclusion"*, *"Hope you found this"*

**Stage 2 — ML model (when available, 2–6s)**

Local ONNX transformer model (`onnx-community/tmr-ai-text-detector-ONNX`) runs alongside the heuristic. Results are blended:
- Model carries 55% weight, heuristic 45%
- A cross-signal penalty applies when they disagree, reducing false positives from single-signal hits
- Falls back to heuristic-only (at reduced weight) on model timeout

**Threshold:** 38% blended confidence → flagged

Text is classified with **section context** — the nearest preceding heading is prepended to the request, so text under "References" or "About" scores differently than identical text in the article body. No site-specific rules needed.

### AI image detection

Two ONNX vision models run in parallel:

**Model A — ViT-Base (`yaya36095/ai-source-detector`, ~84 MB INT8)**
Classifies images as `stable_diffusion`, `midjourney`, `dalle`, `real`, `other_ai`. Score = `aiScore × (1 − realScore)`. Threshold: 95%.

**Model B — Swin Transformer (`onnx-community/SMOGY-Ai-images-detector-ONNX`, ~52 MB q4f16)**
Binary AI vs Real classifier (Flux 83%, DALL-E 91%, SD 88%, SDXL 98%).
- **Veto role:** If Model A ≥ 95% but Model B < 5% real — suppress (prevents false positives on sports photos, screenshots, polished illustrations)
- **Confirm role:** If Model A ≥ 50% and Model B ≥ 90% — return confident match (catches newer generators like Flux and Gemini that Model A alone underscores)

**C2PA manifest check** runs first: scans raw image bytes for the JUMBF `c2pa` namespace and known generator labels (`c2pa.ai.generated`, Adobe Firefly, OpenAI, Imagen 3…). Zero false positives when present, though social media re-encoding limits coverage in practice.

**Page-level prior:** After 4+ images are classified on a page, if ≥ 50% are AI, subsequent borderline images get a +8 confidence boost — AI-heavy pages (AI art galleries, prompt showcase sites) warrant more aggressive filtering.

Images smaller than 300px, GIFs, SVGs, data URIs, and extreme aspect ratios are skipped automatically.

### YouTube AI-disclosure filter

On watch pages and Shorts, SlopProx checks `window.ytInitialPlayerResponse.containsSyntheticMedia` (populated synchronously before first paint) and falls back to a DOM text search for YouTube's "Altered or synthetic content" disclosure string. When found:

- **Watch pages / Shorts:** A full-screen overlay blocks the player, pauses the video, and shows "AI-Disclosed Content". Buttons: *Play anyway* (unblocks the video permanently for that page visit) and *Next video* (Shorts only). Scrolling to the next Short clears the overlay immediately.
- **Feed and search pages:** The video card is dimmed (`opacity: 0.35`, `grayscale: 0.7`) and badged with *🤖 AI-disclosed*.

### Ad and tracker blocking

At the proxy level, before responses reach the browser. Matches against a blocklist of 29 ad networks and DSPs (DoubleClick, Taboola, Criteo, AppNexus, Rubicon, Outbrain…) plus a URL pattern catch-all for ad/pixel/beacon/tracking path segments. Returns HTTP 204 for matched requests. A whitelist protects YouTube, Netflix, Google, GitHub, Wikipedia, and Microsoft infrastructure.

---

## Installation

1. Download the installer from the [Releases](../../releases) page
2. Run `AI Slop Filter Setup.exe` — administrator rights are required to install the CA certificate and configure the system proxy
3. The app launches in the system tray and activates automatically

On first run the app generates a self-signed CA certificate and installs it into the Windows and Chrome certificate stores via PowerShell. This is what allows the proxy to intercept HTTPS traffic. If auto-installation fails a *Reinstall Cert* button is available in the dashboard.

### Chrome extension (recommended)

The companion extension enables card-level social media filtering, AI image detection, and session statistics. Without it, only proxy-injected text filtering and ad blocking are active.

1. Open the dashboard and click **Install Extension**
2. Follow the 4-step wizard — it copies the extension path to your clipboard and walks through enabling Developer mode in Chrome
3. The extension communicates with the local service on `127.0.0.1:8083` and does not require the proxy to be running

---

## Dashboard

| Control | What it does |
|---|---|
| AI Text Filter | Enables/disables text detection across all sites |
| Ad Blocker | Enables/disables ad and tracker blocking |
| Browser Extension | Install wizard and folder opener |
| AI Image Detection | Opt-in image classifier (loads ~84 MB model on first enable) |
| YouTube AI Filter | Enables/disables the AI-disclosure overlay and feed badges |
| Reset Counters | Zeroes all session stats |
| Reinstall Cert | Re-runs the PowerShell cert install if the proxy shows a cert error |
| Debug Log | Opens the log file in Explorer |

Live counters show total blocked counts for text, ads, images, and YouTube videos for the current session.

---

## Development

**Requirements:** Node.js 18+, Windows (proxy and system certificate configuration are Windows-only)

```bash
git clone https://github.com/devR0ss/SlopProx.git
cd SlopProx
git lfs pull          # downloads the 84 MB ONNX text model
npm install
npm start             # run in development (Electron)
npm run build         # build NSIS installer → dist/
```

The ONNX text classification model is stored in `models/` and tracked with Git LFS. The two image models download automatically from HuggingFace on first use and are cached locally.

### Project structure

| File/Dir | Role |
|---|---|
| `main.js` | Electron main process — window, tray, IPC, startup/shutdown |
| `proxy.js` | HTTPS MITM server — HTML injection, ad blocking, relay endpoints |
| `service.js` | HTTP service (`:8083`) — classification API for the extension |
| `classifier.js` | All ML inference — text heuristics, model blending, image ensemble |
| `pac.js` | PAC file generator — routing rules |
| `state.js` | Shared mutable state (feature flags, counters) |
| `preload.js` | IPC context bridge (renderer ↔ main) |
| `injected.js` | Script injected into pages via proxy — text filter, YouTube filter |
| `injected.css` | Styles for placeholders and overlays (proxy pipeline) |
| `index.html` | Dashboard UI |
| `extension/` | Chrome MV3 extension — content script, background worker, popup |
| `models/` | Local ONNX text model (Git LFS) |

---

## Privacy

All detection runs **entirely on-device**. No page content, images, or text are sent to any external server. The only network traffic SlopProx generates is the proxied requests to the sites you visit normally, plus one-time model downloads from HuggingFace.

---

## Tech stack

- **[Electron](https://www.electronjs.org/)** — desktop shell and system tray
- **[mockttp](https://github.com/httptoolkit/mockttp)** — HTTPS MITM proxy with certificate generation
- **[@huggingface/transformers](https://huggingface.co/docs/transformers.js)** — local ONNX model inference (text + image)
- **Chrome Extension MV3** — content script for card detection and image filtering

---

## License

MIT
