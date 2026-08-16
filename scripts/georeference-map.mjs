// ADMIN setup, not part of the AR app: georeferences the map once
// against the MultiSet Georeference API (POST /vps/map/{mapCode}/
// georeference), tying the map's local coordinate system to real
// lat/lon/alt (WGS84).
//
// Why this script exists separately: currently src/main.js uses a
// manual fallback (VITE_MAP_LATITUDE/VITE_MAP_LONGITUDE in .env)
// because the map was never georeferenced from the MultiSet dashboard
// — see the getMapLocation() comment in src/multiset-client.js.
// Running this script once with the real control points from the
// location, the map gets georeferenced server-side:
// GET /vps/map/{mapCode} starts returning "location" on its own,
// and the .env fallback is no longer needed (you can delete those
// two lines).
//
// Usage: node scripts/georeference-map.mjs
// (reads client id/secret/mapCode from .env — same credentials the app uses)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Minimal .env parser (KEY=VALUE, ignores comments/empty lines) — we
// don't add a dependency (dotenv) just for this; the rest of the
// project also avoids unnecessary dependencies (see
// copy-xr8-assets.mjs).
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

const API_BASE = 'https://api.multiset.ai/v1';
const CLIENT_ID = env.VITE_MULTISET_CLIENT_ID;
const CLIENT_SECRET = env.VITE_MULTISET_CLIENT_SECRET;
const MAP_CODE = env.VITE_MAP_CODE;

if (!CLIENT_ID || !CLIENT_SECRET || !MAP_CODE) {
  console.error('[georeference-map] Missing VITE_MULTISET_CLIENT_ID / VITE_MULTISET_CLIENT_SECRET / VITE_MAP_CODE in .env');
  process.exit(1);
}

// We tested this at one point and the API returned 403 "Insufficient
// scope permissions for this endpoint" — the clientId didn't have
// the georeference scope enabled (not a problem with the control
// points or the code).
// CONFIRMED 2026-07-22: no longer happens — real run against the API,
// responded 200 ("Map geo-referenced successfully",
// horizontalRmseMeters: 0.006), meaning the current credentials
// already have the scope enabled. This flag is left as a manual
// kill-switch in case the 403 reappears in the future (e.g., rotated
// credentials) — no need to touch it for normal use.
const GEOREFERENCE_SCOPE_ENABLED = true;
if (!GEOREFERENCE_SCOPE_ENABLED) {
  console.error(
    '[georeference-map] Script disabled: current credentials lack scope for /vps/map/{mapCode}/georeference (403 insufficient_scope).\n'
    + 'The app still works with the manual fallback VITE_MAP_LATITUDE/VITE_MAP_LONGITUDE in .env — nothing is blocked.\n'
    + 'When you get credentials with the scope enabled, set GEOREFERENCE_SCOPE_ENABLED = true in this file and run again.'
  );
  process.exit(0);
}

// ─── EDIT THIS with the real control points from the location ──────────────
// Each point: "local" are the scanned map coordinates (same LHS/Unity
// system the localization returns — see RHS→LHS conversion in main.js
// if you measure your points in RHS), "geo" is the real position
// measured at that same physical point (lat/lon from GPS/map, altitude
// if you have it). Minimum 3 points, not vertically collinear (you need
// real variation in the plane, not three points in a straight line).
// Computed from the world origin (lat -34.585517, lon -58.567709,
// alt 27.6, heading 137.31°) by projecting each local point (x,z) to
// East/North with the heading and converting to degrees (111320 m/°
// lat, 111320·cos(lat) m/° lon). Not measured in the field — if you
// later re-measure any with real GPS/satellite, replace that specific
// row.
//
// ⚠️ NOTE: since these 11 points derive from the same origin/heading
// we were already using (not from an independent GPS/satellite
// measurement), the fit can only mathematically confirm that
// origin/heading — it won't correct a real error they already had. If
// horizontalRmseMeters/tiltCheck come out bad anyway, it's not a
// problem with the fit: you need to re-measure 3-4 points with an
// independent source (satellite or fixed station + offsets, see
// previous discussion) and run this again replacing those "geo" values
// with the real ones.
// IMPORTANT: CURRENTLY THE LOCAL SPACE COORDINATES ARE CORRECT BUT THE
// LAT/LONG/ALT VALUES ARE INACCURATE. These need to be recalculated
// from a phone with satellite GPS access.
const CONTROL_POINTS = [
  { name: 'closet-intersection', geo: { latitude: -34.5855072, longitude: -58.5677103, altitude: 26.178 }, local: { x: 0.281, y: 1.306, z: 2.893 } },
  { name: 'floor-center', geo: { latitude: -34.5855375, longitude: -58.5676923, altitude: 26.168 }, local: { x: -0.641, y: -1.223, z: 1.216 } },
  { name: 'LT-calendar', geo: { latitude: -34.5855420, longitude: -58.5677016, altitude: 26.811 }, local: { x: 0.248, y: 0.396, z: -0.969 } },
  { name: 'triangle-wall-center', geo: { latitude: -34.5855655, longitude: -58.5677222, altitude: 26.158 }, local: { x: 2.036, y: -0.206, z: 1.194 } },
  { name: 'brown-shelf-corner', geo: { latitude: -34.5855549, longitude: -58.5677345, altitude: 27.173 }, local: { x: 2.430, y: 0.400, z: 0.053 } },
  { name: 'world-origin', geo: { latitude: -34.5855250, longitude: -58.5677178, altitude: 26.752 }, local: { x: -0.131, y: -1.218, z: -0.033 } },
  { name: 'floor-dy', geo: { latitude: -34.5855266, longitude: -58.5677357, altitude: 26.121 }, local: { x: 0.974, y: -1.231, z: 1.848 } },
  { name: 'light-switch-center', geo: { latitude: -34.5855421, longitude: -58.5677478, altitude: 26.168 }, local: { x: -1.582, y: 0.010, z: 1.436 } },
];

if (CONTROL_POINTS.length < 3) {
  console.error(
    '[georeference-map] CONTROL_POINTS is empty or has fewer than 3 points.\n'
    + 'Edit scripts/georeference-map.mjs with the real control points from the location before running this.'
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
    throw new Error(`Auth failed: ${response.status} ${await response.text()}`);
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
    throw new Error(`Georeference failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

const token = await getToken();
const result = await georeferenceMap(token);

console.log(`[georeference-map] ${result.message}`);
console.log(`  origin: lat ${result.origin.latitude}, lon ${result.origin.longitude}, alt ${result.origin.altitude}`);
console.log(`  heading: ${result.heading}°, horizontalRmseMeters: ${result.horizontalRmseMeters}`);
if (result.rejected?.length) {
  console.warn(`  ⚠️ points rejected as outliers: ${result.rejected.join(', ')}`);
}
console.log('\nIf horizontalRmseMeters is reasonable (< ~1-2m), you can now delete VITE_MAP_LATITUDE/VITE_MAP_LONGITUDE from .env.');
