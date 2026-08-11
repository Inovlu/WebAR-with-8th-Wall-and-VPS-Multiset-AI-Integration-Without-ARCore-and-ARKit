// Puente REST con MultiSet — Fase 2.
//
// A propósito NO usamos @multisetai/vps (ni MultisetClient/XRSessionManager/
// ThreeAdapter): XRSessionManager y ThreeAdapter están atados a navigator.xr
// (WebXR) y a un render loop de Three.js — incompatibles con el motor propio
// de 8th Wall (XR8) que maneja el tracking acá. MultisetClient en sí no tiene
// esa dependencia (es un cliente HTTP puro), pero igual preferimos fetch()
// directo: control total sobre el payload exacto que espera el REST y sobre
// el modo mock de abajo.
//
// Aislado en su propio módulo a propósito: el REST directo (a diferencia del
// SDK de WebXR) puede necesitar que el equipo de MultiSet apruebe el dominio
// manualmente (CORS). Mientras eso no esté resuelto, VITE_MULTISET_MOCK=true
// hace que este módulo devuelva una pose falsa sin tocar la red, para no
// bloquear el resto del desarrollo (captura de frame, transformación del
// map-anchor, etc — ver src/main.js).

const API_BASE = 'https://api.multiset.ai/v1';

const CLIENT_ID     = import.meta.env.VITE_MULTISET_CLIENT_ID;
const CLIENT_SECRET = import.meta.env.VITE_MULTISET_CLIENT_SECRET;
const MAP_CODE      = import.meta.env.VITE_MAP_CODE;
const MOCK_ENABLED  = import.meta.env.VITE_MULTISET_MOCK === 'true';
const ENV_LATITUDE  = import.meta.env.VITE_MAP_LATITUDE;
const ENV_LONGITUDE = import.meta.env.VITE_MAP_LONGITUDE;
// "vps-1" (estándar) o "vps-2" (búsqueda profunda, más lenta/costosa) — ver
// doc de /vps/map/query-form. Configurable por si un mapa necesita vps-2
// para relocalizar bien, sin tener que tocar código.
const QUERY_MODE = import.meta.env.VITE_MULTISET_QUERY_MODE || 'vps-1';
// Alternativa vía .env en vez de reemplazar el flujo de single-image: cuando
// está en "true", captureAndLocalize() en main.js llama a
// queryMultiImageLocalization() (/vps/map/multi-image-query) en vez de
// queryLocalization() (/vps/map/query-form) — el resto del flujo (umbral de
// confianza, suavizado, relocalización de fondo) no se entera de cuál se usó,
// porque las dos devuelven el mismo shape {position, rotation, confidence}.
const MULTI_IMAGE_ENABLED = import.meta.env.VITE_MULTISET_USE_MULTI_IMAGE === 'true';

// ─── Autenticación M2M ──────────────────────────────────────────────────────
// POST /m2m/token con Basic auth (base64 clientId:clientSecret) → { token,
// expiresOn }. El token dura 30 min; lo cacheamos y renovamos con margen.
let cachedToken = null;
let cachedTokenExpiresAt = 0; // epoch ms

async function getToken() {
  if (MOCK_ENABLED) return 'mock-token';

  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) return cachedToken;

  const authorization = 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);

  // Body con {clientId, clientSecret}: así lo pide explícitamente la doc
  // oficial (docs.multiset.ai/multiset/basics/rest-api-docs/authentication).
  // El bundle del SDK (@multisetai/vps) manda el body vacío ("{}") y también
  // funciona — sospechamos que el server ignora el body si las credenciales
  // ya vienen bien en el header Basic — pero ante la duda seguimos la doc
  // escrita al pie de la letra en vez de una inferencia sacada de un bundle.
  const response = await fetch(`${API_BASE}/m2m/token`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
  });

  if (!response.ok) {
    throw new Error(`MultiSet auth falló: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(`MultiSet auth error: ${data.error}`);

  // El SDK oficial acepta tanto "token" como "access_token" en la respuesta
  // — replicamos ese fallback por las dudas de que el server responda con
  // uno u otro según versión.
  cachedToken = data.token ?? data.access_token;
  // Margen de 60s antes de la expiración real para no usar un token vencido
  // por una request que arranca justo en el límite.
  cachedTokenExpiresAt = now + 30 * 60 * 1000 - 60 * 1000;

  return cachedToken;
}

// ─── Localización (Map Query) ──────────────────────────────────────────────
// Historial: esto pasó por dos endpoints equivocados antes de llegar acá.
// Primero /vps/map/query (JSON) con width/height sueltos → 400 "resolution
// is required". Después, adentro de esa misma familia de endpoints, se
// intentó "arreglar" mandando un objeto anidado "resolution" al mismo
// endpoint JSON — pero consultando directo con soporte de MultiSet (y su
// comunidad) se confirmó que el JSON singular (/vps/map/query) NO es la vía
// recomendada para web: la integración real es contra /vps/map/query-form
// (multipart/form-data, UN solo frame). Ahí los campos SÍ van sueltos
// (width/height/px/py/fx/fy como partes de form-data, no anidados en nada) —
// o sea que el primer intento tenía la forma del payload bien, pero apuntaba
// al endpoint que no es.
//
// Devuelve null si no hay pose (poseFound: false), nunca tira excepción por
// eso — sí tira si falla la red/auth, para que el caller distinga "no se
// pudo localizar en este frame" (normal, va a pasar seguido) de "algo está
// roto" (falta de credenciales, CORS, etc).
//
// multipart/form-data: el Content-Type con boundary lo arma el browser solo
// a partir del objeto FormData — si lo seteamos a mano acá, el server no
// puede parsear el body (falta el boundary). Por eso NO va 'Content-Type' en
// headers, a diferencia de getToken()/getMapLocation() que sí son JSON.
//
// "queryImage" viaja como JPEG binario (Blob), no como base64: desde que
// migramos la captura de frame a CameraPixelArray (ver
// diagnosticsPipelineModule/captureImageFrame en main.js), lo que tenemos es
// un ArrayBuffer JPEG a color, ya no un data URL base64 de
// XR8.CanvasScreenshot ni el PNG en escala de grises de una vuelta anterior
// (2026-07-24: se volvió a JPEG color, downsample a 1280px, calidad 0.7 —
// copiado 1:1 del SDK WebXR de referencia, @multisetai/vps/dist/three/
// index.js función ne(), que es el que mejor viene reconociendo contra
// MultiSet). Nombre de campo CONFIRMADO (ya no es una suposición): verificado
// línea por línea contra el bundle de @multisetai/vps (queryLocalization()
// del SDK oficial arma el mismo FormData con "queryImage", "mapCode",
// "isRightHanded", "fx"/"fy"/"px"/"py", "width"/"height", "hintPosition" —
// idéntico a lo que mandamos acá, incluido el mismo formato de imagen).
//
// "isRightHanded: true" se manda a propósito para que la pose vuelva en el
// mismo sistema que usa THREE.js/A-Frame (WebGL, RHS) para componer la
// matriz cloudSpace en main.js, en vez del left-handed (estilo Unity) que la
// API devuelve por default.
//
// "hintPosition" es opcional: si se pasa (última pose conocida), acelera y
// mejora la relocalización siguiente. Formato confirmado contra un ejemplo
// real de la doc: string "x,y,z" (sin corchetes), en LHS (Unity) — el mismo
// sistema que devuelve la API cuando isRightHanded=false — así que el
// caller (main.js) es responsable de convertir antes de pasarlo acá, dado
// que nosotros pedimos isRightHanded=true (RHS) para el resto del pipeline.
// A propósito NO mandamos hintFloorHeight (indicación explícita: en este
// mapa no ayuda y puede restringir de más la búsqueda).
async function queryLocalization(jpegBuffer, cameraIntrinsics, resolution, hintPosition) {
  if (MOCK_ENABLED) return mockLocalization();

  const token = await getToken();

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

  const response = await fetch(`${API_BASE}/vps/map/query-form`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`MultiSet map/query-form falló: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  if (!data.poseFound) return null;

  return {
    position: data.position,     // {x, y, z}
    rotation: data.rotation,     // {x, y, z, w}
    confidence: data.confidence,
  };
}

// ─── Localización (Multi Image Query) ──────────────────────────────────────
// POST /vps/map/multi-image-query — variante de la localización que manda
// varias fotos en un solo request en vez de una. Confirmado contra el schema
// OpenAPI real de la doc (la sección renderizada, no un resumen): la doc en
// texto dice "mínimo 4, hasta 6 imágenes", pero el schema real solo define
// image1 (Required) + image2/image3/image4 (Optional) — NO hay image5 ni
// image6 en la especificación. Implementado con hasta 4 en vez de 6 por eso:
// es lo que el server efectivamente valida, más allá de lo que diga el texto.
//
// Campos por imagen: "imageN" (el archivo, binario) + "imageN_data" (string
// JSON opcional con la pose LOCAL de tracking — SLAM propio del dispositivo,
// no la respuesta de MultiSet — en el momento exacto en que se capturó esa
// imagen puntual). Formato de imageN_data confirmado con el ejemplo textual
// de la doc: {"x","y","z","qx","qy","qz","qw"} — OJO que la rotación acá usa
// prefijo "q" (qx/qy/qz/qw), a diferencia de la respuesta de localización
// que usa x/y/z/w sin prefijo. Mismos campos width/height/px/py/fx/fy/
// mapCode/isRightHanded/queryMode/hintPosition que el single-image.
//
// Shape de retorno IDÉNTICO a queryLocalization() a propósito ({position,
// rotation, confidence}) — así el resto de main.js (umbral de confianza,
// suavizado, relocalización de fondo) no necesita saber cuál de las dos se
// usó. La respuesta cruda de este endpoint viene anidada distinto
// (estimatedPose.position/estimatedPose.rotation, no position/rotation
// sueltos) — la aplanamos acá adentro para que el contrato hacia afuera sea
// el mismo.
//
// "images": array de hasta 4 items { jpegBuffer, localPose } — localPose es
// {x,y,z,qx,qy,qz,qw} o null/undefined si todavía no hay tracking local
// confiable en ese momento (el campo es opcional, se omite en vez de mandar
// ceros inventados).
async function queryMultiImageLocalization(images, cameraIntrinsics, resolution, hintPosition) {
  if (MOCK_ENABLED) return mockLocalization();

  if (!images?.length) {
    throw new Error('queryMultiImageLocalization necesita al menos 1 imagen.');
  }
  const clamped = images.slice(0, 4); // el schema real no soporta más de 4 (image1..image4)

  const token = await getToken();

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

  const response = await fetch(`${API_BASE}/vps/map/multi-image-query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`MultiSet multi-image-query falló: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  if (!data.poseFound) return null;

  // "estimatedPose" es la pose corregida a devolver (análogo al
  // position/rotation suelto del single-image); "trackingPose" no lo usamos
  // — no está 100% confirmado qué representa exactamente (la doc la lista
  // sin desarrollar sus propiedades), pero por nombre y por paralelismo con
  // trackingPipeline suena a un eco/ajuste de la pose de tracking de entrada,
  // no la corrección final.
  return {
    position: data.estimatedPose?.position,
    rotation: data.estimatedPose?.rotation,
    confidence: data.confidence,
  };
}

// Pose fija de ejemplo — solo para poder probar el resto del pipeline
// (captura de frame → anclaje de #map-anchor en main.js) sin depender de que
// MultiSet ya tenga el dominio de ngrok aprobado por CORS.
function mockLocalization() {
  console.log('🧪 [mock] MultiSet devolviendo pose simulada');
  return Promise.resolve({
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    confidence: 0.9,
  });
}

// ─── Ubicación georeferenciada del mapa ────────────────────────────────────
// GET /vps/map/{mapCode} devuelve metadata del mapa, incluyendo la ubicación
// donde se georeferenció (dashboard o POST /vps/map/{mapCode}/georeference,
// ver scripts/georeference-map.mjs). Esta es la fuente de verdad — no hay una
// convención de .env para esto en la doc de MultiSet.
//
// CORRECCIÓN (2026-07-22): asumíamos (por la doc de "Geo Reference panel",
// que habla de un GeoJSON Point) que este campo venía como
// "location.coordinates" = [longitud, latitud, altitud]. Confirmado contra
// una respuesta real de la API después de correr georeference-map.mjs con
// éxito (horizontalRmseMeters: 0.006): el campo real es "coordinates", un
// objeto plano {latitude, longitude, altitude} — no location.coordinates. Con
// el nombre viejo, el código nunca encontraba la ubicación aunque el mapa ya
// estuviera georeferenciado del lado del servidor, y caía siempre al fallback
// de abajo sin darse cuenta del error.
//
// Fallback: si el mapa todavía no fue georeferenciado (coordinates ausente),
// usamos VITE_MAP_LATITUDE/VITE_MAP_LONGITUDE como respaldo manual en vez de
// dejar el chequeo de proximidad inútil. Es un parche local, no lo que dice
// la doc — apenas georeferencies el mapa, este fallback deja de usarse solo
// (la API empieza a devolver coordinates).
//
// Se cachea: la ubicación de un mapa no cambia entre requests.
let cachedMapLocation = null;

async function getMapLocation() {
  if (cachedMapLocation) return cachedMapLocation;

  const token = await getToken();

  const response = await fetch(`${API_BASE}/vps/map/${MAP_CODE}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`MultiSet map details falló: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const coords = data?.coordinates;

  if (coords && typeof coords.latitude === 'number' && typeof coords.longitude === 'number') {
    cachedMapLocation = { lat: coords.latitude, lon: coords.longitude };
    return cachedMapLocation;
  }

  if (ENV_LATITUDE && ENV_LONGITUDE) {
    console.warn('MultiSet: el mapa no está georeferenciado en el dashboard, usando VITE_MAP_LATITUDE/VITE_MAP_LONGITUDE como fallback.');
    cachedMapLocation = { lat: Number(ENV_LATITUDE), lon: Number(ENV_LONGITUDE) };
    return cachedMapLocation;
  }

  throw new Error('El mapa no tiene ubicación georeferenciada (ni location de la API ni VITE_MAP_LATITUDE/VITE_MAP_LONGITUDE en .env).');
}

export { getToken, queryLocalization, queryMultiImageLocalization, getMapLocation, MOCK_ENABLED, MULTI_IMAGE_ENABLED };
