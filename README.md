# SlopProx

**SlopProx** is a Windows desktop app that filters AI-generated content from the web in real time — across every browser, every site, without extensions or manual configuration.

> 🌐 [slopprox.com](https://slopprox.com)

---

## What it does

SlopProx intercepts your web traffic through a local HTTPS proxy and automatically detects and hides:

- **AI-generated text** — paragraphs and articles written by LLMs, identified by a local ML model and heuristic phrase detection
- **AI-generated images** — images created by Stable Diffusion, DALL-E, Flux, Midjourney, and similar tools *(opt-in)*
- **AI-disclosed YouTube videos** — videos where the creator has declared "Altered or synthetic content" using YouTube's mandatory AI disclosure label
- **Ads** — requests to known ad networks and tracking domains are blocked outright

When content is flagged, it's replaced with a compact placeholder showing the detection confidence. You can reveal it with one click.

---

## How it works

```
Browser → Local HTTPS proxy (port 8081) → Internet
               │
               ├─ Injects detection script into every HTML page
               ├─ Blocks ad/tracker domains
               └─ Serves classify / status / YouTube endpoints
```

SlopProx runs a local MITM proxy using a generated CA certificate that it installs into Windows and Chrome's trust stores. It configures the system PAC (Proxy Auto-Config) file so the proxy only intercepts HTML page navigations — API calls, media streams, and WebSocket traffic go direct.

A second local HTTP service (port 8083) serves the ML classifier to the companion Chrome extension, which handles sites that use strict CSP headers or bypass the PAC routing.

---

## Features

| Feature | Default |
|---|---|
| AI text detection | ✅ On |
| AI image detection | Off (opt-in) |
| YouTube AI-disclosure filter | ✅ On |
| Ad & tracker blocking | ✅ On |

### AI text detection
Uses a local ONNX transformer model combined with heuristic phrase matching. Text is classified on-device — nothing is sent to any external API. Flagged text is hidden and replaced with a "Suspected AI Text" bar showing the confidence score and detection method.

### AI image detection
Uses two local ONNX vision models (a Swin Transformer fine-tuned on AI-generated image datasets). Activated only when images enter the viewport. Opt-in due to higher resource usage. When enabled, images are briefly blurred while scanning and then either cleared or replaced with a placeholder.

### YouTube AI-disclosure filter
Detects YouTube's mandatory "Altered or synthetic content" label on watch pages and Shorts. Blocks the video from auto-playing and overlays a warning. The user can choose to play anyway or skip to the next video. Feed cards for AI-disclosed videos are dimmed with a badge.

### Ad blocking
Blocks requests to a curated list of ad networks, DSPs, and tracking domains (DoubleClick, Taboola, Criteo, etc.) at the proxy level before they reach the browser. A whitelist protects YouTube, Netflix, GitHub, Wikipedia, and Microsoft services.

---

## Installation

1. Download the installer from the [Releases](../../releases) page
2. Run `AI Slop Filter Setup.exe` — it requires administrator rights to install the CA certificate and configure the system proxy
3. The app starts in the system tray. The proxy activates automatically on launch

### Chrome extension (optional)

The companion Chrome extension handles YouTube and other sites that use strict CSP policies. To install it:

1. Open the app and click **Install Extension** in the dashboard, or navigate to the extension folder manually
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the extension folder

The extension communicates with the local service on `127.0.0.1:8083` and does not require the proxy.

---

## Development

**Prerequisites:** Node.js 18+, Windows (proxy configuration is Windows-only)

```bash
# Install dependencies
npm install

# Run in development
npm start

# Build installer
npm run build
```

The ONNX text classification model is tracked with Git LFS (`models/`). Run `git lfs pull` after cloning to download it.

---

## Tech stack

- **[Electron](https://www.electronjs.org/)** — desktop shell and system tray
- **[mockttp](https://github.com/httptoolkit/mockttp)** — HTTPS MITM proxy
- **[@huggingface/transformers](https://huggingface.co/docs/transformers.js)** — local ONNX model inference
- Chrome Extension MV3 — content script for CSP-restricted sites

---

## Privacy

All detection runs **entirely on-device**. No page content, text, or images are sent to any external server. The only network traffic SlopProx generates is the proxied requests to the sites you visit normally.

---

## License

MIT
