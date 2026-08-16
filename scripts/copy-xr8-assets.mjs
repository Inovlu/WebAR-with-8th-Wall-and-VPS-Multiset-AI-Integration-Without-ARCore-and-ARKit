// Copies artifacts from the 8th Wall packages (engine, xrextras) and
// A-Frame from node_modules to public/, so Vite can serve them as
// static files. The 8th Wall packages follow the same pattern: a
// classic script (not ESM) that sets a global (window.XR8 /
// window.XRExtras). A-Frame is different: it's a normal package, but
// here we only need its UMD build (sets window.AFRAME) via <script>,
// not an ESM import — xrweb auto-registers by looking at
// window.AFRAME when xr.js loads.
// (@8thwall/landing-page is no longer used — see comment next to
// <a-scene> in index.html — so it's not in the packages list.)
//
// Vite doesn't bundle node_modules as large binary assets (the
// .tflite/.js files from these packages are not ES modules), so
// instead of the CopyWebpackPlugin the official README uses, we copy
// to public/ — Vite serves that folder as-is in dev and build. Runs
// automatically (postinstall) or manually if you already had
// node_modules installed before this change:
// node scripts/copy-xr8-assets.mjs
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const packages = [
  { pkg: '@8thwall/engine-binary', dest: 'xr8' },
  { pkg: '@8thwall/xrextras', dest: 'xrextras' },
];

for (const { pkg, dest } of packages) {
  const src = path.join(projectRoot, 'node_modules', ...pkg.split('/'), 'dist');
  const destPath = path.join(projectRoot, 'public', dest);

  if (!existsSync(src)) {
    console.error(`[copy-xr8-assets] Could not find ${src}. Did you run "npm install"?`);
    process.exit(1);
  }

  await cp(src, destPath, { recursive: true });
  console.log(`[copy-xr8-assets] Copied ${src} -> ${destPath}`);
}

// A-Frame: a single file, not the entire dist folder (that brings
// several builds — module, source maps, "master" version — that we
// don't use). The UMD build name includes the exact installed version
// (aframe-v1.8.0.min.js), so we read it from the package.json itself
// instead of hardcoding it, to not break on a version bump.
const aframeDir = path.join(projectRoot, 'node_modules', 'aframe');
const aframePkgJson = JSON.parse(await readFile(path.join(aframeDir, 'package.json'), 'utf-8'));
const aframeSrc = path.join(aframeDir, 'dist', `aframe-v${aframePkgJson.version}.min.js`);
const aframeDestDir = path.join(projectRoot, 'public', 'aframe');

if (!existsSync(aframeSrc)) {
  console.error(`[copy-xr8-assets] Could not find ${aframeSrc}. Did you run "npm install"?`);
  process.exit(1);
}

await mkdir(aframeDestDir, { recursive: true });
await cp(aframeSrc, path.join(aframeDestDir, 'aframe.min.js'));
console.log(`[copy-xr8-assets] Copied ${aframeSrc} -> ${path.join(aframeDestDir, 'aframe.min.js')}`);
