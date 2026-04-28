# SlopProx — AI Slop Filter

A Windows desktop app that filters AI-generated content from the web in real time — across every browser, without configuration.

**[slopprox.com](https://slopprox.com)** &nbsp;·&nbsp; **[SlopProx Pro](https://pro.slopprox.com)**

---

## What it does

- **AI text detection** — flags AI-generated paragraphs as you browse, using a hybrid heuristic + on-device ML model
- **AI image detection** — 3-model ONNX ensemble with metadata forensics (opt-in, extension required)
- **YouTube AI filter** — intercepts videos where the creator declared synthetic/AI content
- **Ad blocking** — blocked at the network level, before responses reach the browser

Detected content is replaced with a placeholder. One click to reveal the original.

---

## How it works

SlopProx runs a local HTTPS proxy that intercepts browser traffic. A PAC file routes only real page navigations through it — assets, API calls, and WebSocket connections go direct. A self-signed CA certificate is installed once to enable HTTPS inspection.

A companion Chrome extension handles social media card-level detection and image classification, communicating with the app via a local service on port 8083.

---

## Installation

1. Download the installer from the [Releases](../../releases) page
2. Run `SlopProx Setup.exe`
3. The app starts in the system tray and is active immediately

On first run, a CA certificate is installed into the Windows certificate store via PowerShell. If it fails, use **Reinstall Cert** in the dashboard.

### Browser extension (recommended)

Required for image detection, social media filtering, and YouTube feed badges.

1. Open the dashboard → **Install Extension**
2. Follow the wizard — it copies the extension and opens your browser's extensions page

---

## Development

**Requirements:** Node.js 18+, Windows

```bash
git clone https://github.com/ross-walpole/SlopProx.git
cd SlopProx
git lfs pull      # downloads the ONNX text model (~84 MB)
npm install
npm start         # Electron dev mode
npm run build     # builds NSIS installer → dist/
```

The ONNX text model (~84 MB) is bundled via Git LFS. Two of the three image models (~140 MB total) download from HuggingFace on first enable and are cached locally.

### Project structure

| File | Role |
|---|---|
| `main.js` | Electron main process — window, tray, IPC |
| `proxy.js` | HTTPS MITM proxy — HTML injection, ad blocking |
| `service.js` | Local HTTP API (`:8083`) for the extension |
| `classifier.js` | All detection logic — text heuristics, ML, image ensemble |
| `pac.js` | PAC file — routing rules |
| `state.js` | Shared feature flags |
| `extension/` | Chrome MV3 extension |
| `models/` | ONNX text model (Git LFS) |

---

## SlopProx Pro

[SlopProx Pro](https://pro.slopprox.com) is a standalone Chrome extension for professional use — no desktop app, no proxy, no certificate. Designed for newsrooms, universities, and research teams. Right-click any text or image for a full forensic breakdown.

---

## Licence

**GPL-3.0-only** — see [LICENSE](./LICENSE).

Free and open source. Forks must remain open source under the same terms.

Copyright (C) 2026 Ross Walpole.
