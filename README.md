# WebAR with 8th Wall Engine + MultiSet AI VPS

Integration of [8th Wall](https://www.8thwall.com/)'s proprietary AR engine (XR8) with [MultiSet AI](https://multiset.ai/)'s Visual Positioning System (VPS), running entirely in the browser — **no ARCore or ARKit required**.

## What this does

- Uses **XR8** for real-time SLAM (world tracking) via the device camera
- Sends camera frames to **MultiSet's REST API** for server-side visual localization against a pre-scanned 3D map
- Anchors AR content (a test cube) to the physical world using the VPS correction, with outlier-filtering and pose smoothing (ported from Immersal's PoseFilter)
- Supports both **single-image** (`/vps/map/query-form`) and **multi-image** (`/vps/map/multi-image-query`) localization modes
- Includes **automatic background relocalization** (periodic re-anchoring, same pattern as the official MultiSet SDK)
- GPS proximity check before localization to avoid wasting API quota
- Fallback 3D viewer for incompatible devices

## Installation

1. Install [Node.js](https://nodejs.org/) (v18+)
2. Run `npm install`
3. Duplicate `.env.example` → `.env` and fill in your MultiSet AI credentials
4. Run `npm run dev` to start the dev server
5. Use [ngrok](https://ngrok.com/) to expose the local server (HTTPS required for camera access on mobile):
   ```bash
   ngrok http 3001
   ```
6. Open the ngrok URL on your phone. Add `?debug=1` to the URL for an on-screen console (eruda)

## Building for production

```bash
npm run build
```

Output goes to `dist/`. Upload to any static hosting.

## Environment variables

See [`.env.example`](.env.example) for all available options and their descriptions.

## Project structure

```
src/
  main.js              — App entry point: XR8 pipeline, frame capture, localization flow, UI
  multiset-client.js   — REST client for MultiSet API (auth, localization, map location)
  pose-filter.js       — Outlier-trimmed pose averaging (port of Immersal's PoseFilter)
scripts/
  copy-xr8-assets.mjs  — Copies 8th Wall binaries from node_modules to public/ (postinstall)
  georeference-map.mjs — One-time admin script to georeference a map via MultiSet API
index.html             — Single-page app shell with AR/fallback UI
vite.config.js         — Vite config (dev server, ngrok hosts, env prefix)
```

## Architecture notes

- **No WebXR dependency**: XR8 handles tracking natively — works on browsers/devices that don't support WebXR
- **No @multisetai/vps SDK**: Direct REST integration because the SDK's `XRSessionManager`/`ThreeAdapter` are tied to WebXR's `navigator.xr`, incompatible with XR8
- **A-Frame for rendering**: Used as a Three.js wrapper for declarative 3D; XR8 handles the tracking underneath. The project reuses A-Frame's bundled Three.js to avoid duplicate instances
- **CameraPixelArray** (not CanvasScreenshot): Raw camera pixels at up to 1280px, color JPEG encoding — same approach as the reference MultiSet WebXR SDK for best recognition
