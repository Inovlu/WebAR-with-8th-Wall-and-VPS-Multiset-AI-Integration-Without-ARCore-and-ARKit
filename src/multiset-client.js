// REST bridge with MultiSet — Phase 2.
//
// We deliberately do NOT use @multisetai/vps (nor MultisetClient/
// XRSessionManager/ThreeAdapter): XRSessionManager and ThreeAdapter are
// tied to navigator.xr (WebXR) and a Three.js render loop — incompatible
// with 8th Wall's own engine (XR8) that handles tracking here.
// MultisetClient itself doesn't have that dependency (it's a pure HTTP
// client), but we still prefer direct fetch(): total control over the
// exact payload the REST API expects and over the mock mode below.
//
// Isolated in its own module on purpose: the direct REST approach (as
// opposed to the WebXR SDK) may require MultiSet's team to manually
// approve the domain (CORS). While that's unresolved,
// VITE_MULTISET_MOCK=true makes this module return a fake pose without
// hitting the network, so it doesn't block the rest of the development
// (frame capture, map-anchor transformation, etc. — see src/main.js).

const API_BASE = 'https://api.multiset.ai/v1';

const CLIENT_ID     = import.meta.env.VITE_MULTISET_CLIENT_ID;
const CLIENT_SECRET = import.meta.env.VITE_MULTISET_CLIENT_SECRET;
const MAP_CODE      = import.meta.env.VITE_MAP_CODE;
const MOCK_ENABLED  = import.meta.env.VITE_MULTISET_MOCK === 'true';
const ENV_LATITUDE  = import.meta.env.VITE_MAP_LATITUDE;
const ENV_LONGITUDE = import.meta.env.VITE_MAP_LONGITUDE;
// "vps-1" (standard) or "vps-2" (deep search, slower/more expensive) —
// see /vps/map/query-form docs. Configurable so a specific map can use
// vps-2 for better relocalization without touching code.
const QUERY_MODE = import.meta.env.VITE_MULTISET_QUERY_MODE || 'vps-1';
// Alternative via .env instead of replacing the single-image flow: when
// set to "true", captureAndLocalize() in main.js calls
// queryMultiImageLocalization() (/vps/map/multi-image-query) instead of
// queryLocalization() (/vps/map/query-form) — the rest of the flow
// (confidence threshold, smoothing, background relocalization) doesn't
// care which one was used, because both return the same shape
// {position, rotation, confidence}.
const MULTI_IMAGE_ENABLED = import.meta.env.VITE_MULTISET_USE_MULTI_IMAGE === 'true';

// ─── M2M Authentication ─────────────────────────────────────────────────────
// POST /m2m/token with Basic auth (base64 clientId:clientSecret) → { token,
// expiresOn }. The token lasts 30 min; we cache and renew with margin.
let cachedToken = null;
let cachedTokenExpiresAt = 0; // epoch ms

async function getToken() {
  if (MOCK_ENABLED) return 'mock-token';

  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) return cachedToken;

  const authorization = 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);

  // Body with {clientId, clientSecret}: explicitly required by the
  // official docs (docs.multiset.ai/multiset/basics/rest-api-docs/
  // authentication). The SDK bundle (@multisetai/vps) sends an empty
  // body ("{}") and also works — we suspect the server ignores the body
  // if the credentials are already correct in the Basic header — but
  // we follow the written docs to the letter rather than an inference
  // drawn from a bundle.
  const response = await fetch(`${API_BASE}/m2m/token`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
  });

  if (!response.ok) {
    throw new Error(`MultiSet auth failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(`MultiSet auth error: ${data.error}`);

  // The official SDK accepts both "token" and "access_token" in the
  // response — we replicate that fallback in case the server responds
  // with one or the other depending on version.
  cachedToken = data.token ?? data.access_token;
  // 60s margin before actual expiration to avoid using a token that
  // expired while a request was in flight.
  cachedTokenExpiresAt = now + 30 * 60 * 1000 - 60 * 1000;

  return cachedToken;
}

// ─── Localization (Map Query) ──────────────────────────────────────────────
// History: this went through two wrong endpoints before landing here.
// First /vps/map/query (JSON) with loose width/height → 400 "resolution
// is required". Then, within that same endpoint family, we tried
// "fixing" it by sending a nested "resolution" object to the same JSON
// endpoint — but checking directly with MultiSet support (and their
// community) confirmed that the singular JSON endpoint (/vps/map/query)
// is NOT the recommended path for web: the real integration uses
// /vps/map/query-form (multipart/form-data, ONE single frame). There
// the fields DO go loose (width/height/px/py/fx/fy as form-data parts,
// not nested in anything) — meaning the first attempt had the payload
// shape right but was hitting the wrong endpoint.
//
// Returns null if there's no pose (poseFound: false), never throws for
// that — it DOES throw on network/auth failures, so the caller can
// distinguish "couldn't localize in this frame" (normal, will happen
// often) from "something is broken" (missing credentials, CORS, etc.).
//
// multipart/form-data: the Content-Type with boundary is set
// automatically by the browser from the FormData object — if we set it
// manually here, the server can't parse the body (missing boundary).
// That's why there's NO 'Content-Type' in headers, unlike
// getToken()/getMapLocation() which are JSON.
//
// "queryImage" is sent as binary JPEG (Blob), not base64: since we
// migrated frame capture to CameraPixelArray (see
// diagnosticsPipelineModule/captureImageFrame in main.js), what we have
// is a color JPEG ArrayBuffer, no longer a base64 data URL from
// XR8.CanvasScreenshot nor the grayscale PNG from a previous iteration
// (2026-07-24: switched back to color JPEG, downsampled to 1280px,
// quality 0.7 — copied 1:1 from the reference WebXR SDK,
// @multisetai/vps/dist/three/index.js function ne(), which has been
// the one with the best recognition against MultiSet). Field name
// CONFIRMED (no longer an assumption): verified line by line against
// the @multisetai/vps bundle (queryLocalization() in the official SDK
// builds the same FormData with "queryImage", "mapCode",
// "isRightHanded", "fx"/"fy"/"px"/"py", "width"/"height",
// "hintPosition" — identical to what we send here, including the same
// image format).
//
// "isRightHanded: true" is sent on purpose so the pose comes back in
// the same coordinate system that THREE.js/A-Frame uses (WebGL, RHS)
// for composing the cloudSpace matrix in main.js, instead of the
// left-handed system (Unity-style) the API returns by default.
//
// "hintPosition" is optional: if passed (last known pose), it speeds
// up and improves the next relocalization. Format confirmed against a
// real doc example: string "x,y,z" (no brackets), in LHS (Unity) —
// the same system the API returns when isRightHanded=false — so the
// caller (main.js) is responsible for converting before passing it
// here, since we request isRightHanded=true (RHS) for the rest of
// the pipeline. We deliberately do NOT send hintFloorHeight (explicit
// guidance: on this map it doesn't help and may over-constrain the
// search).
async function queryLocalization(jpegBuffer, cameraIntrinsics, resolution, hintPosition) {
  if (MOCK_ENABLED) return mockLocalization();

  let token = await getToken();

  const formData = new FormData();
  formData.append('queryImage', new Blob([jpegBuffer], { type: 'image/jpeg' }), 'frame.jpg');
  formData.append('mapCode', MAP_CODE);
  formData.append('isRightHanded', 'true');
  formData.append('width', String(resolution.width));
  formData.append('height', String(resolution.height));
  formData.append('fx', String(cameraIntrinsics.fx));
  formData.append('fy', String(cameraIntrinsics.fy));
  formData.append('px', String(cameraIntrinsics.px));
  formData.append('py', String(cameraIntrinsics.py));
  formData.append('queryMode', QUERY_MODE);
  if (hintPosition) formData.append('hintPosition', hintPosition);

  let response = await fetch(`${API_BASE}/vps/map/query-form`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (response.status === 401) {
    console.warn('MultiSet 401: Token expired or invalid. Retrying...');
    cachedToken = null;
    token = await getToken();
    response = await fetch(`${API_BASE}/vps/map/query-form`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
  }

  if (!response.ok) {
    throw new Error(`MultiSet map/query-form failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  if (!data.poseFound) return null;

  return {
    position: data.position,     // {x, y, z}
    rotation: data.rotation,     // {x, y, z, w}
    confidence: data.confidence,
  };
}

// ─── Localization (Multi Image Query) ──────────────────────────────────────
// POST /vps/map/multi-image-query — variant of localization that sends
// multiple photos in a single request instead of one. Confirmed against
// the real OpenAPI schema in the docs (the rendered section, not a
// summary): the text says "minimum 4, up to 6 images", but the actual
// schema only defines image1 (Required) + image2/image3/image4
// (Optional) — there is NO image5 or image6 in the specification.
// Implemented with up to 4 instead of 6 for that reason: it's what the
// server actually validates, regardless of what the text says.
//
// Fields per image: "imageN" (the file, binary) + "imageN_data"
// (optional JSON string with the LOCAL tracking pose — the device's own
// SLAM, not MultiSet's response — at the exact moment that particular
// image was captured). imageN_data format confirmed with the doc's text
// example: {"x","y","z","qx","qy","qz","qw"} — NOTE that the rotation
// here uses "q" prefix (qx/qy/qz/qw), unlike the localization response
// which uses x/y/z/w without prefix. Same fields width/height/px/py/
// fx/fy/mapCode/isRightHanded/queryMode/hintPosition as single-image.
//
// Return shape is INTENTIONALLY identical to queryLocalization()
// ({position, rotation, confidence}) — so the rest of main.js
// (confidence threshold, smoothing, background relocalization) doesn't
// need to know which one was used. The raw response from this endpoint
// comes nested differently (estimatedPose.position/estimatedPose.rotation,
// not loose position/rotation) — we flatten it here so the contract to
// the outside is the same.
//
// "images": array of up to 4 items { jpegBuffer, localPose } —
// localPose is {x,y,z,qx,qy,qz,qw} or null/undefined if there's no
// reliable local tracking at that moment (the field is optional; we
// omit it rather than sending invented zeros).
async function queryMultiImageLocalization(images, cameraIntrinsics, resolution, hintPosition) {
  if (MOCK_ENABLED) return mockLocalization();

  if (!images?.length) {
    throw new Error('queryMultiImageLocalization requires at least 1 image.');
  }
  const clamped = images.slice(0, 4); // the real schema only supports up to 4 (image1..image4)

  let token = await getToken();

  const formData = new FormData();
  formData.append('mapCode', MAP_CODE);
  formData.append('isRightHanded', 'true');
  formData.append('width', String(resolution.width));
  formData.append('height', String(resolution.height));
  formData.append('fx', String(cameraIntrinsics.fx));
  formData.append('fy', String(cameraIntrinsics.fy));
  formData.append('px', String(cameraIntrinsics.px));
  formData.append('py', String(cameraIntrinsics.py));
  formData.append('queryMode', QUERY_MODE);
  if (hintPosition) formData.append('hintPosition', hintPosition);

  clamped.forEach(({ jpegBuffer, localPose }, i) => {
    const n = i + 1;
    formData.append(`image${n}`, new Blob([jpegBuffer], { type: 'image/jpeg' }), `frame${n}.jpg`);
    if (localPose) formData.append(`image${n}_data`, JSON.stringify(localPose));
  });

  let response = await fetch(`${API_BASE}/vps/map/multi-image-query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (response.status === 401) {
    console.warn('MultiSet 401: Token expired or invalid. Retrying...');
    cachedToken = null;
    token = await getToken();
    response = await fetch(`${API_BASE}/vps/map/multi-image-query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
  }

  if (!response.ok) {
    throw new Error(`MultiSet multi-image-query failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  if (!data.poseFound) return null;

  // "estimatedPose" is the corrected pose to return (analogous to the
  // loose position/rotation from single-image); "trackingPose" is not
  // used — it's not 100% confirmed what it represents exactly (the
  // docs list it without describing its properties), but by name and
  // by parallel with trackingPipeline it sounds like an echo/adjustment
  // of the input tracking pose, not the final correction.
  return {
    position: data.estimatedPose?.position,
    rotation: data.estimatedPose?.rotation,
    confidence: data.confidence,
  };
}

// Fixed example pose — only to test the rest of the pipeline (frame
// capture → #map-anchor anchoring in main.js) without depending on
// MultiSet having the ngrok domain approved for CORS.
function mockLocalization() {
  console.log('🧪 [mock] MultiSet returning simulated pose');
  return Promise.resolve({
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    confidence: 0.9,
  });
}

// ─── Georeferenced map location ────────────────────────────────────────────
// GET /vps/map/{mapCode} returns map metadata, including the location
// where it was georeferenced (dashboard or POST /vps/map/{mapCode}/
// georeference, see scripts/georeference-map.mjs). This is the source
// of truth — there's no .env convention for this in the MultiSet docs.
//
// FIX (2026-07-22): we assumed (from the "Geo Reference panel" docs,
// which mention a GeoJSON Point) that this field came as
// "location.coordinates" = [longitude, latitude, altitude]. Confirmed
// against a real API response after running georeference-map.mjs
// successfully (horizontalRmseMeters: 0.006): the actual field is
// "coordinates", a flat object {latitude, longitude, altitude} — not
// location.coordinates. With the old name, the code never found the
// location even though the map was already georeferenced server-side,
// and always fell through to the fallback below without realizing the
// error.
//
// Fallback: if the map hasn't been georeferenced yet (coordinates
// absent), we use VITE_MAP_LATITUDE/VITE_MAP_LONGITUDE as a manual
// fallback instead of leaving the proximity check useless. This is a
// local workaround, not what the docs say — as soon as you
// georeference the map, this fallback stops being used on its own
// (the API starts returning coordinates).
//
// Cached: a map's location doesn't change between requests.
let cachedMapLocation = null;
const FORCE_ENV_LOCATION = import.meta.env.VITE_FORCE_ENV_LOCATION === 'true';

async function getMapLocation() {
  if (cachedMapLocation) return cachedMapLocation;

  if (FORCE_ENV_LOCATION && ENV_LATITUDE && ENV_LONGITUDE) {
    console.log('MultiSet: Forcing manual coordinates from .env (VITE_FORCE_ENV_LOCATION=true)');
    cachedMapLocation = { lat: Number(ENV_LATITUDE), lon: Number(ENV_LONGITUDE) };
    return cachedMapLocation;
  }

  const token = await getToken();

  const response = await fetch(`${API_BASE}/vps/map/${MAP_CODE}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`MultiSet map details failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const coords = data?.coordinates;

  if (coords && typeof coords.latitude === 'number' && typeof coords.longitude === 'number') {
    cachedMapLocation = { lat: coords.latitude, lon: coords.longitude };
    return cachedMapLocation;
  }

  if (ENV_LATITUDE && ENV_LONGITUDE) {
    console.warn('MultiSet: map is not georeferenced in the dashboard, using VITE_MAP_LATITUDE/VITE_MAP_LONGITUDE as fallback.');
    cachedMapLocation = { lat: Number(ENV_LATITUDE), lon: Number(ENV_LONGITUDE) };
    return cachedMapLocation;
  }

  throw new Error('Map has no georeferenced location (neither API coordinates nor VITE_MAP_LATITUDE/VITE_MAP_LONGITUDE in .env).');
}

export { getToken, queryLocalization, queryMultiImageLocalization, getMapLocation, MOCK_ENABLED, MULTI_IMAGE_ENABLED };
