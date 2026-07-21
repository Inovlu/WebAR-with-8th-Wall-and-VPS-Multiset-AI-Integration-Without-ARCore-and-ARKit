// Setup ADMIN, no parte de la app AR: georeferencia el mapa una sola vez
// contra el Georeference API de MultiSet (POST /vps/map/{mapCode}/georeference),
// atando el sistema de coordenadas local del mapa a lat/lon/alt reales (WGS84).
//
// Por qué existe este script aparte: hoy src/main.js usa un fallback manual
// (VITE_MAP_LATITUDE/VITE_MAP_LONGITUDE en .env) porque el mapa "Pieza agus"
// nunca fue georeferenciado desde el dashboard de MultiSet — ver el comentario
// de getMapLocation() en src/multiset-client.js. Corriendo este script una vez
// con los control points reales del lugar, el mapa queda georeferenciado del
// lado del server: GET /vps/map/{mapCode} empieza a devolver "location" solo,
// y el fallback de .env deja de hacer falta (podés borrar esas dos líneas).
//
// Uso: node scripts/georeference-map.mjs
// (lee client id/secret/mapCode de .env — mismas credenciales que usa la app)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Parser mínimo de .env (KEY=VALUE, ignora comentarios/líneas vacías) — no
// agregamos una dependencia (dotenv) solo para esto; el resto del proyecto ya
// evita dependencias que no hacen falta (ver copy-xr8-assets.mjs).
function loadEnv(filePath) {
  const env = {};
  const content = readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = loadEnv(path.join(projectRoot, '.env'));

const API_BASE      = 'https://api.multiset.ai/v1';
const CLIENT_ID     = env.VITE_MULTISET_CLIENT_ID;
const CLIENT_SECRET = env.VITE_MULTISET_CLIENT_SECRET;
const MAP_CODE      = env.VITE_MAP_CODE;

if (!CLIENT_ID || !CLIENT_SECRET || !MAP_CODE) {
  console.error('[georeference-map] Faltan VITE_MULTISET_CLIENT_ID / VITE_MULTISET_CLIENT_SECRET / VITE_MAP_CODE en .env');
  process.exit(1);
}

// DESHABILITADO: probamos esto y la API devuelve 403 "Insufficient scope
// permissions for this endpoint" con las credenciales actuales — el
// clientId no tiene habilitado el scope de georeferencia (no es un problema
// de los control points ni del código). Hay que conseguir credenciales con
// ese scope (rol Admin/Editor en developer.multiset.ai, o pedirlo a soporte
// de MultiSet) antes de volver a intentar. Poné esto en false cuando lo
// confirmes para volver a habilitar el script.
const GEOREFERENCE_SCOPE_ENABLED = false;
if (!GEOREFERENCE_SCOPE_ENABLED) {
  console.error(
    '[georeference-map] Script deshabilitado: las credenciales actuales no tienen scope para /vps/map/{mapCode}/georeference (403 insufficient_scope).\n'
    + 'La app sigue funcionando igual con el fallback manual VITE_MAP_LATITUDE/VITE_MAP_LONGITUDE en .env — esto no bloquea nada.\n'
    + 'Cuando consigas credenciales con el scope habilitado, poné GEOREFERENCE_SCOPE_ENABLED = true en este archivo y volvé a correrlo.'
  );
  process.exit(0);
}

// ─── EDITÁ ESTO con los puntos de control reales del lugar ─────────────────
// Cada punto: "local" son las coordenadas del mapa escaneado (mismo sistema
// LHS/Unity que devuelve la localización — ver conversión RHS→LHS en
// main.js si medís tus puntos en RHS), "geo" es la posición real medida en
// ese mismo punto físico (lat/lon con GPS/mapa, altitud si la tenés). Mínimo
// 3 puntos, no colineales verticalmente (necesitás variación real en el
// plano, no tres puntos en línea recta).
// Calculados a partir del origen del mundo (lat -34.585517, lon -58.567709,
// alt 27.6, heading 137.31°) proyectando cada punto local (x,z) a Este/Norte
// con el heading y convirtiendo a grados (111320 m/° lat, 111320·cos(lat) m/°
// lon). No están medidos en campo — si más adelante remedís alguno con GPS/
// satelital real, reemplazá esa fila puntual.
//
// ⚠️ OJO: como estos 11 puntos derivan del mismo origen/heading que ya
// veníamos usando (no de una medición GPS/satelital independiente), el fit
// solo puede confirmar matemáticamente ese origen/heading — no corrige un
// error real que ya tuvieran. Si horizontalRmseMeters/tiltCheck salen mal
// igual, no es un problema del fit: hay que remedir 3-4 puntos con una
// fuente independiente (satelital o estación fija + offsets, ver charla
// previa) y volver a correr esto reemplazando esos "geo" por los reales.
const CONTROL_POINTS = [
  { name: 'esquina-1',        geo: { latitude: -34.5855072, longitude: -58.5677103, altitude: 26.178 }, local: { x: -0.653, y: -1.422, z: -0.882 } },
  { name: 'esquina-2',        geo: { latitude: -34.5855375, longitude: -58.5676923, altitude: 26.168 }, local: { x: 0.419,  y: -1.432, z: 2.716 } },
  { name: 'sillon',           geo: { latitude: -34.5855420, longitude: -58.5677016, altitude: 26.811 }, local: { x: 1.388,  y: -0.789, z: 2.508 } },
  { name: 'esquina-4',        geo: { latitude: -34.5855655, longitude: -58.5677222, altitude: 26.158 }, local: { x: 4.548,  y: -1.442, z: 3.142 } },
  { name: 'esquina-5',        geo: { latitude: -34.5855549, longitude: -58.5677345, altitude: 27.173 }, local: { x: 4.581,  y: -0.427, z: 1.515 } },
  { name: 'cama',             geo: { latitude: -34.5855250, longitude: -58.5677178, altitude: 26.752 }, local: { x: 1.191,  y: -0.848, z: 0.108 } },
  { name: 'final-cama',       geo: { latitude: -34.5855266, longitude: -58.5677357, altitude: 26.121 }, local: { x: 2.523,  y: -1.479, z: -0.872 } },
  { name: 'esquina-8',        geo: { latitude: -34.5855421, longitude: -58.5677478, altitude: 26.168 }, local: { x: 4.508,  y: -1.432, z: -0.356 } },
  { name: 'esquina-9',        geo: { latitude: -34.5855570, longitude: -58.5677531, altitude: 26.192 }, local: { x: 5.990,  y: -1.408, z: 0.534 } },
  { name: 'centro-suelo-10',  geo: { latitude: -34.5855428, longitude: -58.5677236, altitude: 26.197 }, local: { x: 2.929,  y: -1.403, z: 1.203 } },
  { name: 'centro-suelo-11',  geo: { latitude: -34.5855244, longitude: -58.5677048, altitude: 26.140 }, local: { x: 0.277,  y: -1.460, z: 0.870 } },
];

if (CONTROL_POINTS.length < 3) {
  console.error(
    '[georeference-map] CONTROL_POINTS está vacío o tiene menos de 3 puntos.\n'
    + 'Editá scripts/georeference-map.mjs con los puntos de control reales del lugar antes de correr esto.'
  );
  process.exit(1);
}

async function getToken() {
  const authorization = 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const response = await fetch(`${API_BASE}/m2m/token`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
  });

  if (!response.ok) {
    throw new Error(`Auth falló: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(`Auth error: ${data.error}`);
  return data.token;
}

async function georeferenceMap(token) {
  const response = await fetch(`${API_BASE}/vps/map/${MAP_CODE}/georeference`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      controlPoints: CONTROL_POINTS,
      solveScale: false,
      rejectOutliers: true,
      outlierThresholdMeters: 2.5,
    }),
  });

  if (!response.ok) {
    throw new Error(`Georeference falló: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

const token = await getToken();
const result = await georeferenceMap(token);

console.log(`[georeference-map] ${result.message}`);
console.log(`  origin: lat ${result.origin.latitude}, lon ${result.origin.longitude}, alt ${result.origin.altitude}`);
console.log(`  heading: ${result.heading}°, horizontalRmseMeters: ${result.horizontalRmseMeters}`);
if (result.rejected?.length) {
  console.warn(`  ⚠️ puntos rechazados como outliers: ${result.rejected.join(', ')}`);
}
console.log('\nSi horizontalRmseMeters es razonable (< ~1-2m), ya podés borrar VITE_MAP_LATITUDE/VITE_MAP_LONGITUDE de .env.');
