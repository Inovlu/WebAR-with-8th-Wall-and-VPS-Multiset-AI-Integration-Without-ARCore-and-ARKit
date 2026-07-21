// Copia los artefactos de los paquetes de 8th Wall (engine, xrextras) y de
// A-Frame desde node_modules a public/, para que Vite los sirva como
// estáticos. Los paquetes de 8th Wall siguen el mismo patrón: un script
// clásico (no ESM) que setea un global (window.XR8 / window.XRExtras).
// A-Frame es distinto: es un paquete normal, pero acá solo necesitamos su
// build UMD (setea window.AFRAME) vía <script>, no un import ESM — xrweb se
// autoregistra mirando window.AFRAME al cargar xr.js.
// (@8thwall/landing-page ya no se usa — ver comentario junto a <a-scene> en
// index.html — así que no está en la lista de paquetes a copiar.)
//
// Vite no bundlea node_modules como assets binarios grandes (los .tflite/.js
// de estos paquetes no son módulos ES), así que en vez del CopyWebpackPlugin
// que usa el README oficial, copiamos a public/ — Vite sirve esa carpeta tal
// cual en dev y build. Se corre solo (postinstall) o a mano si ya tenías
// node_modules instalado antes de este cambio: node scripts/copy-xr8-assets.mjs
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
    console.error(`[copy-xr8-assets] No se encontró ${src}. ¿Corriste "npm install"?`);
    process.exit(1);
  }

  await cp(src, destPath, { recursive: true });
  console.log(`[copy-xr8-assets] Copiado ${src} -> ${destPath}`);
}

// A-Frame: un solo archivo, no la carpeta dist entera (esa trae varios
// builds — módulo, mapas de source, versión "master" — que no usamos).
// El nombre del build UMD incluye la versión exacta instalada
// (aframe-v1.8.0.min.js), así que lo leemos del propio package.json en vez
// de hardcodearlo, para no romper con un bump de versión.
const aframeDir = path.join(projectRoot, 'node_modules', 'aframe');
const aframePkgJson = JSON.parse(await readFile(path.join(aframeDir, 'package.json'), 'utf-8'));
const aframeSrc = path.join(aframeDir, 'dist', `aframe-v${aframePkgJson.version}.min.js`);
const aframeDestDir = path.join(projectRoot, 'public', 'aframe');

if (!existsSync(aframeSrc)) {
  console.error(`[copy-xr8-assets] No se encontró ${aframeSrc}. ¿Corriste "npm install"?`);
  process.exit(1);
}

await mkdir(aframeDestDir, { recursive: true });
await cp(aframeSrc, path.join(aframeDestDir, 'aframe.min.js'));
console.log(`[copy-xr8-assets] Copiado ${aframeSrc} -> ${path.join(aframeDestDir, 'aframe.min.js')}`);
