import { XR8Promise } from '@8thwall/engine-binary';
import {
  queryLocalization,
  queryMultiImageLocalization,
  getMapLocation,
  MOCK_ENABLED,
  MULTI_IMAGE_ENABLED,
} from './multiset-client.js';
import { PoseFilter } from './pose-filter.js';

// Usamos el THREE que ya trae empaquetado A-Frame (expuesto en window.AFRAME.THREE)
// en vez de importar el paquete "three" de npm aparte. Antes importábamos los
// dos: A-Frame 1.8.0 carga su propia copia de Three.js (r184, según el log de
// consola) y nuestro import de "three" (^0.185.1 en package.json) traía una
// instancia SEPARADA — de ahí el warning "THREE.WARNING: Multiple instances of
// Three.js being imported." No es solo cosmético: son dos registros de clases
// distintos, así que un chequeo interno tipo "instanceof THREE.Vector3" contra
// un objeto creado con la otra instancia falla en silencio. Reusar la de
// A-Frame elimina el duplicado y además nos ahorra bajar Three.js dos veces al
// bundle. index.html carga aframe.min.js síncrono en <head> (sin async/defer),
// antes que este módulo (que es <script type="module">, deferred por
// default), así que window.AFRAME ya está listo acá.
const THREE = window.AFRAME.THREE;

// ─── Consola visual en mobile (?debug=1) ───────────────────────────────────────
// El inspector remoto de Chrome (chrome://inspect) no está andando para debuggear
// en el celular, así que exponemos una consola en pantalla como alternativa:
// eruda dibuja un botón flotante que abre un panel con console.log/error, red,
// elementos, etc. Solo se carga si el link tiene "?debug=1" para no mostrársela
// a usuarios reales de la experiencia AR.
if (new URLSearchParams(location.search).has('debug')) {
  setupDebugConsole();
}

// El botón de copiar de eruda solo copia UNA línea a la vez, y encima exige
// tocarla primero para "seleccionarla" (si no, queda gris/deshabilitado — no
// es un bug, es así de fábrica). Para debuggear en el celular sirve mucho más
// poder copiar TODO el historial de un toque, así que interceptamos
// console.* nosotros mismos en un buffer propio y agregamos un botón flotante
// aparte que copia ese buffer completo.
function setupDebugConsole() {
  const logBuffer = [];
  const MAX_LOG_LINES = 1000; // evita crecer sin límite en una sesión larga

  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      const line = args
        .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
        .join(' ');
      logBuffer.push(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${line}`);
      if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
    };
  });

  window.addEventListener('error', (e) => {
    logBuffer.push(`[${new Date().toISOString()}] [UNCAUGHT] ${e.message} (${e.filename}:${e.lineno})`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    logBuffer.push(`[${new Date().toISOString()}] [UNHANDLED-REJECTION] ${safeStringify(e.reason)}`);
  });

  import('eruda').then(({ default: eruda }) => {
    eruda.init();

    const btnCopyConsole = document.createElement('button');
    btnCopyConsole.textContent = '📋 Copiar consola';
    Object.assign(btnCopyConsole.style, {
      position: 'fixed',
      bottom: '70px',
      right: '16px',
      zIndex: 2147483647, // por encima del panel de eruda
      width: 'auto',
      padding: '8px 12px',
      fontSize: '12px',
      fontWeight: '600',
      borderRadius: '8px',
      background: 'rgba(0,0,0,0.75)',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.3)',
    });
    btnCopyConsole.addEventListener('click', async () => {
      const text = logBuffer.join('\n') || '(consola vacía)';
      const ok = await copyToClipboard(text);
      const original = btnCopyConsole.textContent;
      btnCopyConsole.textContent = ok ? '✅ Copiado' : '❌ Error al copiar';
      setTimeout(() => { btnCopyConsole.textContent = original; }, 1500);
    });
    document.body.appendChild(btnCopyConsole);
  });
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// navigator.clipboard requiere contexto seguro (https/ngrok) y a veces falla
// en mobile aunque el sitio sea https (permiso denegado, WebView, etc.) — si
// falla, caemos a document.execCommand("copy") con un textarea oculto, que es
// más tolerante en navegadores mobile viejos.
async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // sigue al fallback
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

// ─── UI refs ──────────────────────────────────────────────────────────────────
const landing         = document.getElementById('landing');
const btnStartAR      = document.getElementById('btn-start-ar');
const statusText      = document.getElementById('status-text');
const sceneEl         = document.getElementById('ar-scene');
const mapAnchorEl     = document.getElementById('map-anchor');
const hud             = document.getElementById('hud');
const btnLocalize     = document.getElementById('btn-localize');
const btnToggleBg     = document.getElementById('btn-toggle-bg');
const confidenceBadge = document.getElementById('confidence-badge');
const fallbackViewer  = document.getElementById('fallback-viewer');
const fallbackCanvas  = document.getElementById('fallback-canvas');
const btnFallbackBack = document.getElementById('btn-fallback-back');
const btnDebugToggleView = document.getElementById('btn-debug-toggle-view');

let xr8Instance = null; // seteado apenas XR8Promise resuelve, lo necesita triggerFallback()

function setStatus(msg) {
  statusText.textContent = msg;
  statusText.style.display = msg ? 'block' : 'none';
}

// Muestra el error tanto en el status (visible en pantalla, clave para
// debuggear en un celular sin devtools) como en consola.
function showError(prefix, error) {
  console.error(prefix, error);
  setStatus(`${prefix} ${error?.message || error}`);
  btnStartAR.disabled = false;
  btnStartAR.textContent = 'Iniciar AR';
  landing.style.display = 'flex';
  btnDebugToggleView.style.display = 'none';
}

// ─── Fallback automático por GPU/driver insuficiente: DESACTIVADO ─────────────
// Hubo un intento de detectar reactivamente un SLAM roto (avalancha de errores
// de WebGL, confirmado en el Moto E40 y un Redmi Note 13 Pro con driver ARM
// beta) mandando automáticamente al visor 3D si el tracking nunca llegaba a
// 'NORMAL' dentro de un timeout. Se sacó (2026-07-22): un timeout por tiempo
// (incluso combinado con un mínimo de movimiento acumulado) sigue dando falsos
// positivos — hay dispositivos SANOS que simplemente tardan más en estabilizar
// el SLAM visual-inercial, y no hay forma confiable de distinguir "va a tardar
// más" de "está roto y nunca va a llegar" sin arriesgarse a expulsar a un
// usuario legítimo a mitad de sesión. El botón de testeo
// (#btn-debug-toggle-view) sigue disponible para comparar a mano cámara/AR vs.
// visor 3D cuando haga falta diagnosticar un dispositivo puntual.
let fallbackTriggered = false;

// Se pone en true la primera vez que reality.trackingStatus === 'NORMAL' en
// CUALQUIER momento de la sesión. Habilita el botón "Localizar" (ver
// btnLocalize más abajo: deshabilitado hasta este punto, para no anclar el
// origen del mundo contra una pose de tracking todavía inestable — eso es lo
// que causaba que el cubo "saltara" apenas el SLAM pasaba de INITIALIZING a
// NORMAL).
let everReachedNormalTracking = false;

function triggerFallback(reason) {
  if (fallbackTriggered) return;
  fallbackTriggered = true;

  console.warn('⚠️ Fallback activado:', reason);

  // Frenamos el run loop de XR8 y soltamos la cámara — no tiene sentido seguir
  // gastando batería/CPU en un tracking que ya sabemos que está roto.
  try {
    xr8Instance?.pause();
  } catch (err) {
    console.warn('No se pudo pausar XR8:', err);
  }
  stopBackgroundLocalization();
  stopPoseFilterLoop();
  document.querySelectorAll('video').forEach((video) => {
    video.srcObject?.getTracks().forEach((track) => track.stop());
  });

  landing.style.display = 'none';
  showFallbackView();

  // Este fallback es DEFINITIVO para la sesión (cámara soltada, XR8 pausado)
  // — a diferencia del toggle de testeo, acá no hay forma confiable de
  // volver a la vista de cámara sin recargar (ver btnFallbackBack). Ocultamos
  // el botón de test para no ofrecer una vuelta que no puede funcionar bien.
  btnDebugToggleView.style.display = 'none';
}

// Vista 3D simple del mismo cubo, sin cámara ni tracking — un THREE.Scene
// aparte, independiente de A-Frame/XR8. Gira sola para poder verse desde
// todos los ángulos sin necesitar controles táctiles.
//
// Creada UNA sola vez (lazy, en ensureFallbackScene): el toggle de testeo
// puede mostrar/ocultar este visor muchas veces en la misma sesión, y cada
// "new THREE.WebGLRenderer(...)" abre un contexto WebGL nuevo sobre el mismo
// <canvas> — Android/Chrome tiene un límite bajo de contextos WebGL vivos
// simultáneos, así que recrearlo en cada toggle terminaría agotándolo. Lo que
// SÍ se detiene/reinicia en cada toggle es el loop de animación (rAF), vía
// startFallbackPreview()/stopFallbackPreview().
let fallbackRenderer = null;
let fallbackScene = null;
let fallbackCamera = null;
let fallbackCube = null;
let fallbackAnimating = false;

function ensureFallbackScene() {
  if (fallbackRenderer) return;

  fallbackRenderer = new THREE.WebGLRenderer({ canvas: fallbackCanvas, antialias: true });
  fallbackRenderer.setPixelRatio(window.devicePixelRatio);
  fallbackRenderer.setSize(fallbackCanvas.clientWidth, fallbackCanvas.clientHeight);

  fallbackScene = new THREE.Scene();
  fallbackCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
  fallbackCamera.position.set(1.2, 1, 1.8);
  fallbackCamera.lookAt(0, 0, 0);

  fallbackScene.add(new THREE.AmbientLight(0xffffff, 1));
  const light = new THREE.DirectionalLight(0xffffff, 0.6);
  light.position.set(3, 5, 2);
  fallbackScene.add(light);

  fallbackCube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x6366f1, roughness: 0.4 })
  );
  fallbackScene.add(fallbackCube);
}

function startFallbackPreview() {
  ensureFallbackScene();
  if (fallbackAnimating) return; // ya hay un loop corriendo, no arrancar otro en paralelo
  fallbackAnimating = true;

  function animate() {
    if (!fallbackAnimating) return; // corta el loop al ocultar el fallback
    fallbackCube.rotation.y += 0.012;
    fallbackCube.rotation.x += 0.004;
    fallbackRenderer.render(fallbackScene, fallbackCamera);
    requestAnimationFrame(animate);
  }
  animate();
}

function stopFallbackPreview() {
  fallbackAnimating = false;
}

// ─── Mostrar/ocultar el visor 3D de respaldo ───────────────────────────────
// Compartido entre el fallback automático (triggerFallback, definitivo) y el
// botón de testeo (reversible) — ambos necesitan la misma coreografía de UI,
// solo difieren en si además pausan XR8/sueltan la cámara.
function showFallbackView() {
  sceneEl.style.display = 'none';
  hud.style.display = 'none';
  confidenceBadge.style.display = 'none';
  setStatus('');
  fallbackViewer.style.display = 'flex';
  startFallbackPreview();
}

function showARView() {
  fallbackViewer.style.display = 'none';
  stopFallbackPreview();
  sceneEl.style.display = '';
  hud.style.display = 'flex';
}

btnFallbackBack.addEventListener('click', () => {
  // Recargar es lo más simple y confiable acá: XR8 no está pensado para
  // reiniciar una sesión ya pausada de forma prolija.
  window.location.reload();
});

// ─── Botón de TESTEO: alternar cámara/AR ↔ visor 3D a mano ─────────────────
// A diferencia del fallback automático de arriba, esto NO pausa XR8 ni suelta
// la cámara — el motor sigue corriendo en segundo plano aunque se esté
// mostrando el visor 3D. Sirve para comparar a ojo, en un dispositivo donde
// el cubo no se proyecta, si el problema es de renderizado (nunca aparece
// nada nuevo, ni en este visor de prueba) o de posicionamiento (el visor 3D
// si muestra el cubo, solo que la pose real lo deja fuera de cámara).
let inDebugFallbackView = false;

btnDebugToggleView.addEventListener('click', () => {
  if (fallbackTriggered) return; // ya no hay cámara viva a la que volver

  inDebugFallbackView = !inDebugFallbackView;

  if (inDebugFallbackView) {
    showFallbackView();
    btnDebugToggleView.textContent = '📷 Ver cámara/AR';
  } else {
    showARView();
    btnDebugToggleView.textContent = '🧪 Ver visor 3D';
  }
});

// ─── Fix: forzar la cámara trasera principal (no macro) ───────────────────────
// Dos intentos anteriores fallaron: track.applyConstraints() (OverconstrainedError)
// y pedir el stream nuevo ANTES de soltar el viejo (NotReadableError: "Could not
// start video source"). El error clave estaba en el orden: pedíamos la cámara
// nueva mientras la vieja (la que XR8 ya tenía abierta) seguía activa. Sitios
// como https://es.webcamtests.com/ sí pueden abrir cada lente por separado —
// confirmando que no es un límite del dispositivo, es que hay que soltar la
// cámara actual primero y darle un margen al driver antes de pedir la otra.
// Esto opera a nivel DOM/window (MediaStreamTrack), independiente de si el
// renderizado es Three.js manual o A-Frame — sigue igual con la migración.
async function forceMainBackCamera(videoEl) {
  const track = videoEl?.srcObject?.getVideoTracks?.()[0];
  if (!track) return;

  console.log('📷 Cámara activa:', track.label || '(sin label)');

  let videoInputs;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoInputs = devices.filter((d) => d.kind === 'videoinput');
    console.log(`📷 ${videoInputs.length} cámara(s) detectadas:`,
      videoInputs.map((d) => `${d.label || '(sin label)'} [${d.deviceId.slice(0, 12)}...]`));
  } catch (err) {
    console.warn('No se pudo enumerar cámaras:', err);
    return;
  }

  // Convención de Android: índice más bajo = sensor principal, los índices
  // más altos son lentes auxiliares agregadas después (ultra wide, macro,
  // profundidad). Este equipo etiqueta "camera N, facing back" (sin el "2"
  // que usa el label de Samsung/Huawei), así que parseamos el número en vez
  // de buscar un string exacto.
  const backCameras = videoInputs
    .filter((d) => /facing back/i.test(d.label))
    .map((d) => ({ device: d, index: parseInt((d.label.match(/camera2?\s*(\d+)/i) || [])[1], 10) }))
    .sort((a, b) => (a.index || 0) - (b.index || 0));

  const mainCamera = backCameras[0]?.device;
  const currentId = track.getSettings().deviceId;

  if (!mainCamera || mainCamera.deviceId === currentId) {
    setStatus(`Cámara: ${track.label || 'desconocida'}`);
    return;
  }

  // Soltamos la cámara actual ANTES de pedir la otra (el orden que nos
  // faltaba) y le damos un margen al driver para liberarla de verdad.
  track.stop();
  await new Promise((resolve) => setTimeout(resolve, 300));

  // "ideal" (no "exact"/min): pedimos la mejor calidad posible sin que la
  // request falle si el sensor no llega a 1920x1080/30fps — el browser cae al
  // máximo que sí soporte. SIN esto, Chrome/Android arrancaba el stream de
  // reemplazo en una resolución baja por default (algo como 640x480) en vez
  // de la que el sensor real puede dar — confirmado como la causa de que la
  // cámara se viera de calidad mucho peor que la app nativa de cámara del
  // mismo Redmi Note 13 (que sí anda en 1920x1080).
  const idealVideoConstraints = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
  };

  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: mainCamera.deviceId }, ...idealVideoConstraints },
    });
    videoEl.srcObject = newStream;
    console.log('✅ Cámara cambiada a la principal:', mainCamera.label);
    setStatus(`Cámara: ${mainCamera.label}`);
  } catch (err) {
    // No nos quedamos sin cámara si la principal tampoco abre: reabrimos la
    // original como red de seguridad.
    console.warn('No se pudo abrir la cámara principal, reabriendo la original:', err);
    try {
      const fallbackStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: currentId }, ...idealVideoConstraints },
      });
      videoEl.srcObject = fallbackStream;
      setStatus(`No se pudo cambiar de cámara (${err.name}). Se mantiene: ${track.label}`);
    } catch (fallbackErr) {
      console.error('No se pudo reabrir ninguna cámara:', fallbackErr);
      showError('Error de cámara:', fallbackErr);
    }
  }
}

// XR8 no expone un evento público confiable de "la cámara ya tiene stream"
// (es un motor cerrado, sin documentación de ese detalle interno — un primer
// intento enganchado a un supuesto evento "xr.camerastatuschange" en window
// nunca disparó, así que lo descartamos). En vez de seguir adivinando su bus
// de eventos interno, observamos el DOM directamente: sabemos que crea un
// <video> oculto para el feed de cámara, así que apenas aparece uno con
// stream activo, logueamos qué cámara quedó activa.
function watchForCameraVideo() {
  const tryFix = (video) => {
    if (video.dataset.lensFixApplied) return;
    video.dataset.lensFixApplied = 'true';

    if (video.readyState >= 1 && video.srcObject) {
      forceMainBackCamera(video);
    } else {
      video.addEventListener('loadedmetadata', () => forceMainBackCamera(video), { once: true });
    }
  };

  document.querySelectorAll('video').forEach(tryFix);

  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.tagName === 'VIDEO') tryFix(node);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

watchForCameraVideo();

// ─── Módulo custom del pipeline: diagnóstico ───────────────────────────────────
// El cubo de prueba ahora es 100% declarativo (<a-entity> en index.html) — xrweb
// ya arma la escena/cámara de A-Frame, así que no hace falta un onStart manual
// para agregar el cubo ni para fijar la posición inicial de la cámara. Lo único
// que sigue haciendo falta desde JS es diagnóstico: enterarnos si el pipeline
// tira una excepción, y loguear el estado del tracker.
function diagnosticsPipelineModule() {
  return {
    name: 'diagnostico',

    onStart: () => {
      console.log('✅ Pipeline XR8 iniciado (A-Frame + xrweb).');
      // "Localizar" arranca deshabilitado: trackerFromCloudSpace() usa
      // sceneEl.camera.matrixWorld (el tracker nativo) como referencia para
      // anclar #map-anchor — localizar mientras el SLAM todavía está
      // LIMITED/INITIALIZING metería esa pose inestable directo en el
      // PoseFilter (ver comentario largo junto a everReachedNormalTracking
      // más arriba). Se rehabilita solo, más abajo en onUpdate, la primera
      // vez que trackingStatus === 'NORMAL'.
      btnLocalize.disabled = true;
      setStatus('Motor iniciado. Mové el teléfono lentamente para estabilizar el tracking...');
      hud.style.display = 'flex';
    },

    onException: (error) => showError('Error en el pipeline XR8:', error),

    // "reality.trackingstatus" es un evento interno documentado del framework
    // de Camera Pipeline Modules (a diferencia de "xr.camerastatuschange", que
    // resultó no ser accesible desde afuera). Nos suscribimos acá para ver en
    // consola qué dice el propio tracker sobre su estado — más confiable que
    // juzgar a ojo si el cubo "tiembla mucho" o no.
    listeners: [
      { event: 'reality.trackingstatus', process: (e) => console.log('🧭 reality.trackingstatus:', e.detail) },
    ],

    // Muestreo periódico de processCpuResult.reality (posición/rotación que
    // el propio SLAM de 8th Wall reporta cuadro a cuadro, entre correcciones
    // de MultiSet). "reality" es el nombre fijo con el que XR8 expone el
    // resultado de su world tracking interno a CUALQUIER módulo de pipeline
    // via onUpdate — no hace falta agregar XR8.XrController.pipelineModule()
    // aparte, xrweb ya lo deja corriendo. Se loguea 1 vez por segundo (no cada
    // frame, para no inundar la consola) para tener evidencia objetiva de
    // cuánto "flota" el tracking entre taps de "Localizar", en vez de juzgar
    // a ojo si el cubo tiembla.
    // Además del muestreo, esto replica una técnica del SDK oficial de
    // MultiSet (@multisetai/vps, xrLoop()): cuando no hay pose de tracking
    // durante W=60 frames seguidos (~2s a 30fps) dispara una relocalización
    // automática (this.options.relocalization && this.localizeFrame()). No
    // tenemos "viewer pose ausente" (eso es WebXR); el equivalente en 8th
    // Wall es reality.trackingStatus === 'LIMITED' sostenido. Mismo umbral
    // (60 frames) por no tener uno propio mejor fundamentado.
    //
    // Acá también leemos, cada frame, los intrínsecos reales de cámara
    // (reality.intrinsics) y el buffer crudo de píxeles que entrega
    // CameraPixelArray (processGpuResult.camerapixelarray) — ver el
    // comentario grande junto a "cameraData" más abajo sobre por qué esto
    // vive en onUpdate y no en un onProcessCpu propio.
    onUpdate: (() => {
      let frameCount = 0;
      let trackingLossFrames = 0;
      const TRACKING_LOSS_FRAMES_THRESHOLD = 60;

      return ({ frameStartResult, processGpuResult, processCpuResult }) => {
        const reality = processCpuResult?.reality;
        if (!reality) return;

        if (reality.trackingStatus === 'NORMAL' && !everReachedNormalTracking) {
          everReachedNormalTracking = true;
          // Recién ahora es seguro anclar el origen del mundo contra una
          // pose de tracking estable — habilitamos "Localizar" (no lo
          // tocamos si ya está en medio de una localización/chequeo GPS).
          if (!localizing && !checkingLocation) {
            btnLocalize.disabled = false;
            setStatus('Tracking estable. Tocá "Localizar" para corregir con MultiSet.');
          }
        }

        // Guardado CADA frame (no solo cada 30) — esto es lo que usa
        // captureImageFrame() para armar "imageN_data" en el momento exacto de
        // cada captura, no el log de diagnóstico de más abajo.
        if (reality.position && reality.rotation) {
          latestRealityPose = {
            x: reality.position.x, y: reality.position.y, z: reality.position.z,
            qx: reality.rotation.x, qy: reality.rotation.y, qz: reality.rotation.z, qw: reality.rotation.w,
          };
        }

        // Snapshot del frame de cámara crudo (píxeles + intrínsecos reales)
        // para captureImageFrame(). Ambos requieren que CameraPixelArray haya
        // corrido este frame (se registra en XR8Promise.then() más abajo,
        // como XR8.CameraPixelArray.pipelineModule({maxDimension:1280})) — si
        // todavía no tickeó ninguna vez, camerapixelarray es undefined acá y
        // simplemente no actualizamos cameraData, dejando el valor anterior.
        const camerapixelarray = processGpuResult?.camerapixelarray;
        if (reality.intrinsics && camerapixelarray?.pixels) {
          // OJO (fix 2026-07-24): los intrínsecos hay que calcularlos contra
          // el tamaño REAL del buffer que vamos a mandar (camerapixelarray.
          // cols/rows) y NO contra frameStartResult.textureWidth/Height (el
          // tamaño de la textura GL nativa, antes de cualquier downsample).
          // reality.intrinsics es una matriz de proyección normalizada
          // (independiente de resolución) — fx/fy/px/py en PÍXELES solo
          // salen bien si se escalan contra el ancho/alto de la imagen que
          // efectivamente le llega a MultiSet. Con "maxDimension:1280" activo,
          // cols/rows (post-downsample) puede ser bien distinto de
          // textureWidth/Height (nativo) — antes esto pasaba desapercibido
          // porque sin downsample ambos coincidían casi siempre.
          cameraData.intrinsics = getIntrinsicsFromReality(reality.intrinsics, camerapixelarray.cols, camerapixelarray.rows);
          cameraData.width = camerapixelarray.cols;
          cameraData.height = camerapixelarray.rows;
          cameraData.buffer = camerapixelarray.pixels;
        }

        frameCount++;
        if (frameCount % 30 === 0) {
          console.log('📍 reality (8th Wall SLAM):', {
            trackingStatus: reality.trackingStatus,
            trackingReason: reality.trackingReason,
            position: reality.position,
            rotation: reality.rotation,
          });
        }

        if (reality.trackingStatus === 'LIMITED') {
          trackingLossFrames++;
          if (trackingLossFrames === TRACKING_LOSS_FRAMES_THRESHOLD && hasLocalizedOnce && !localizing) {
            console.warn('⚠️ Tracking LIMITED sostenido (~2s) — relocalizando automáticamente con MultiSet.');
            captureAndLocalize();
          }
        } else {
          trackingLossFrames = 0;
        }
      };
    })(),
  };
}

// ─── Fase 2: puente con MultiSet — módulo de pipeline de cámara ───────────────
// Guía directa del equipo de 8th Wall (respuesta oficial a una consulta sobre
// integrar un VPS externo, ya usado antes por otro cliente): "Registrá un
// módulo de pipeline de cámara. Agarrá un frame, mandalo a tu backend, y si
// se detecta la posición, actualizá el tracking." Ciclo de vida documentado
// (8thwall.org/docs/api/engine/camerapipelinemodule):
//   onBeforeRun → onCameraStatusChange → onStart → onAttach
//     → onProcessGpu → onProcessCpu → onUpdate → onRender
// onProcessCpu es el punto documentado para "leer resultados de
// procesamiento y devolver datos utilizables" — sería el lugar canónico para
// leer processGpuResult.camerapixelarray. PERO ya confirmamos en este
// proyecto, con xrweb (A-Frame), que un onProcessCpu propio no dispara de
// forma confiable (0 requests reales llegando a MultiSet cuando se probó
// antes con la captura vía CanvasScreenshot). Por eso el snapshot del frame
// crudo (cameraData, más abajo) se lee en onUpdate en vez de onProcessCpu —
// ver diagnosticsPipelineModule() más arriba: ESE onUpdate sí dispara
// confiable (es lo que ya sostiene el log de reality.trackingStatus), y
// según el ciclo de vida documentado processGpuResult (con
// camerapixelarray ya poblado por XR8.CameraPixelArray, que corre ANTES en
// la misma fase onProcessGpu) sigue disponible ahí, no solo en onProcessCpu.
//
// El disparo real de una localización (captureAndLocalize) sigue sin vivir
// dentro de ningún hook del pipeline — se llama directo desde el tap del
// botón, el timer de fondo, o la pérdida de tracking sostenida. Mismo patrón
// que @multisetai/vps (SDK oficial, WebXR puro, confirmado funcionando): el
// botón "Localizar" llama directo `await adapter.localizeFrame()` en el
// mismo click handler, sin ninguna indirección por frame.
let localizing = false;

// Último frame de cámara crudo disponible, actualizado cada frame por
// diagnosticsPipelineModule().onUpdate a partir de CameraPixelArray +
// reality.intrinsics — reemplaza la captura anterior por
// XR8.CanvasScreenshot.takeScreenshot() (un JPEG del <canvas> ya renderizado,
// con el overlay 3D encima) e intrinsics.fx/fy estimados por FOV. Acá
// "buffer" es el buffer RGBA (4 canales, 8 bits) que entrega
// CameraPixelArray({maxDimension:1280}) — el sensor de la cámara a color, sin
// nada dibujado encima — e "intrinsics" son los reales que reporta el SLAM
// nativo de 8th Wall (no una aproximación). null hasta que CameraPixelArray
// tickee por primera vez.
const cameraData = {
  width: 0,
  height: 0,
  buffer: null,
  intrinsics: null,
};

// Fórmula EXACTA del módulo oficial de Immersal (immersal-module.js,
// getIntrinsics / immersal/index.js) para derivar fx/fy/px/py a partir de la
// matriz de proyección que el SLAM nativo ya calcula cuadro a cuadro
// (reality.intrinsics) — reales, no una estimación por el FOV de la cámara
// virtual de THREE.js como se hacía antes. m[5] es la escala focal en Y;
// m[8]/m[9] el offset del punto principal en NDC (-1..1), reescalado a
// píxeles de la textura. Asume fx=fy (píxeles cuadrados) porque
// reality.intrinsics no expone un valor separado para X — mismo supuesto que
// hace Immersal con esta misma fórmula.
function getIntrinsicsFromReality(m, textureWidth, textureHeight) {
  const fl = 0.5 * m[5] * textureHeight;
  const px = 0.5 * (m[8] + 1.0) * textureWidth;
  const py = 0.5 * (m[9] + 1.0) * textureHeight;
  return { fx: fl, fy: fl, px, py };
}

// Encoding JPEG a color (2026-07-24, reemplaza el PNG en escala de grises de
// src/png-worker.js) — copiado del SDK WebXR de referencia
// (@multisetai/vps/dist/three/index.js, función ne()): un <canvas> 2D normal
// (no OffscreenCanvas) en el hilo principal, mismo mecanismo que usa esa
// función de referencia (que TAMPOCO usa worker para esto). Se descartó
// mantenerlo en un worker: OffscreenCanvas.convertToBlob no tiene soporte
// confiable en iOS Safari (requisito duro de este proyecto, ver comentarios
// de arquitectura del proyecto), y canvas.toBlob del hilo principal es
// universal — el costo de encoding en sí es bajo (una sola imagen JPEG de
// hasta 1280px, no cada frame).
//
// Reusamos el mismo <canvas> entre capturas (igual que el patrón de
// fallbackCanvas más arriba) en vez de crear uno nuevo por foto.
const jpegCanvas = document.createElement('canvas');
const jpegCtx = jpegCanvas.getContext('2d');
const JPEG_QUALITY = 0.7; // mismo valor que usa el SDK de referencia

function encodeJpegFrame(rgbaBuffer, width, height) {
  jpegCanvas.width = width;
  jpegCanvas.height = height;
  // CameraPixelArray entrega Uint8Array; ImageData exige Uint8ClampedArray
  // específicamente — el constructor de abajo copia a la vez que convierte
  // de tipo, evitando además que putImageData lea un buffer que XR8 podría
  // seguir escribiendo en frames futuros.
  const imageData = new ImageData(new Uint8ClampedArray(rgbaBuffer), width, height);
  jpegCtx.putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    jpegCanvas.toBlob(
      (blob) => (blob ? blob.arrayBuffer().then(resolve, reject) : reject(new Error('canvas.toBlob devolvió null'))),
      'image/jpeg',
      JPEG_QUALITY
    );
  });
}

// Snapshot + encoding de un frame para mandar a MultiSet. El snapshot de
// cameraData.buffer y de latestRealityPose se toma ACÁ, de forma síncrona,
// antes del primer await (new Uint8ClampedArray(rgbaBuffer) dentro de
// encodeJpegFrame ya copia el buffer, así que lo que sigue escribiendo XR8 en
// cameraData.buffer en frames futuros no afecta esta captura en curso).
async function captureImageFrame() {
  if (!cameraData.buffer || !cameraData.intrinsics) {
    throw new Error('Todavía no hay un frame de cámara disponible (CameraPixelArray no tickeó aún).');
  }
  const { buffer, width, height, intrinsics } = cameraData;
  const localPose = latestRealityPose;
  const jpegBuffer = await encodeJpegFrame(buffer, width, height);
  return { jpegBuffer, width, height, intrinsics, localPose };
}

// Última pose LOCAL de tracking (SLAM propio de XR8, no la respuesta de
// MultiSet) — actualizada cada frame por diagnosticsPipelineModule().onUpdate.
// La usa captureMultiImageFrames() para armar "imageN_data" de cada foto en
// el modo multi-image. Ya en la forma {x,y,z,qx,qy,qz,qw} que pide ese campo
// (ver comentario en multiset-client.js sobre el prefijo "q" en la rotación).
let latestRealityPose = null;

// Última pose conocida (en el mismo sistema RHS que pedimos con
// isRightHanded:true) — se usa para armar el "hintPosition" del próximo
// query y acelerar/mejorar la relocalización. null hasta la primera
// localización exitosa.
let lastKnownPosition = null;

// true recién después de la primera corrección aplicada con éxito. Gatea
// dos cosas que no tiene sentido disparar antes de eso: la relocalización
// automática por pérdida de tracking (arriba) y el arranque del timer de
// relocalización periódica (abajo) — ambas asumen que ya hay una pose de
// referencia real, no la posición default de arranque del SLAM.
let hasLocalizedOnce = false;

// ─── Relocalización periódica en segundo plano ─────────────────────────────
// Réplica directa de startBackgroundLocalization() del SDK oficial
// (@multisetai/vps): confirmado en su bundle que corre un setInterval que
// llama a localizeFrame() (si no hay una localización en curso), con el
// intervalo clamped entre 10s y 180s (default 30s para mapas). O sea: el SDK
// "que funciona perfecto" tampoco confía solo en el tracking nativo
// (ARCore/ARKit) para mantenerse anclado — también corrige periódicamente
// contra el VPS. Acá replicamos el mismo patrón porque nuestra brecha
// principal frente a esa versión era justamente no tener ningún re-anclaje
// después del tap manual inicial.
const BG_INTERVAL_MIN_S = 10;
const BG_INTERVAL_MAX_S = 180;
const BG_INTERVAL_DEFAULT_S = 30;
const BG_INTERVAL_MS = Math.max(
  BG_INTERVAL_MIN_S,
  Math.min(Number(import.meta.env.VITE_MULTISET_BG_INTERVAL_SECONDS) || BG_INTERVAL_DEFAULT_S, BG_INTERVAL_MAX_S)
) * 1000;

let bgLocalizationTimer = null;

function startBackgroundLocalization() {
  if (bgLocalizationTimer !== null) return;
  bgLocalizationTimer = setInterval(() => {
    if (!localizing && !checkingLocation) captureAndLocalize();
  }, BG_INTERVAL_MS);
}

function stopBackgroundLocalization() {
  if (bgLocalizationTimer !== null) {
    clearInterval(bgLocalizationTimer);
    bgLocalizationTimer = null;
  }
}

// true si el usuario pausó la relocalización de fondo a mano (botón del HUD).
// Se chequea tanto al pausar/reanudar como en el punto donde
// captureAndLocalize() arranca el timer por primera vez — si el usuario ya
// pausó antes de que llegara la primera localización exitosa, no queremos
// que ese primer éxito reactive el timer por encima de su elección.
let bgLocalizationPaused = false;

btnToggleBg.addEventListener('click', () => {
  bgLocalizationPaused = !bgLocalizationPaused;

  if (bgLocalizationPaused) {
    stopBackgroundLocalization();
    btnToggleBg.textContent = '▶️ Reanudar auto-localización';
  } else {
    btnToggleBg.textContent = '⏸ Pausar auto-localización';
    if (hasLocalizedOnce) startBackgroundLocalization();
  }
});

// ─── Umbral de confianza ────────────────────────────────────────────────────
// Otra técnica confirmada en el bundle del SDK oficial: confidenceCheck +
// confidenceThreshold, clamped entre 0.2 y 0.8 (default 0.5) — si la pose
// devuelta tiene menos confianza que el umbral, el SDK la descarta en vez de
// aplicarla. Tiene sentido acá: en las pruebas reales vimos confianzas de
// 43% a 85%; aplicar sin filtrar una corrección de 43% puede meter una
// posición peor que la que ya había (y verse como "el cubo saltó a un lugar
// raro"), sobre todo viniendo de una relocalización periódica automática
// donde no hay un usuario apuntando deliberadamente la cámara al mapa.
const CONFIDENCE_THRESHOLD_MIN = 0.2;
const CONFIDENCE_THRESHOLD_MAX = 0.8;
const CONFIDENCE_THRESHOLD_DEFAULT = 0.5;
const CONFIDENCE_THRESHOLD = Math.max(
  CONFIDENCE_THRESHOLD_MIN,
  Math.min(Number(import.meta.env.VITE_MULTISET_CONFIDENCE_THRESHOLD) || CONFIDENCE_THRESHOLD_DEFAULT, CONFIDENCE_THRESHOLD_MAX)
);

// ─── Anclaje del mapa (reemplaza updateCameraProjectionMatrix) ─────────────
// Antes, cada corrección de MultiSet reseteaba el origen/orientación de TODO
// el sistema de tracking de XR8 vía updateCameraProjectionMatrix({origin,
// facing}) — un salto duro de todo el mundo, sin versión "continua" ni
// transición documentada. Migramos al patrón que usa el módulo oficial de
// Immersal (immersal-module.js: localize() + su "pointCloud"): el tracking
// nativo de XR8 NUNCA se toca. En cambio, calculamos la transformación entre
// la pose del tracker en el momento exacto de la captura (trackerSpace,
// sceneEl.camera.matrixWorld) y la pose que devuelve el VPS relativa al
// origen del mapa (cloudSpace) — esa transformación es la que hay que
// aplicarle a #map-anchor para que el CONTENIDO quede alineado con el mundo
// real, sin resetear nada del SLAM. El tracking sigue su curso normal entre
// correcciones, así que ya no hay drift acumulado por perder el anclaje del
// origen — solo el contenido se realinea.
function trackerFromCloudSpace(position, rotation, trackerSpace) {
  const cloudPosition = new THREE.Vector3(position.x, position.y, position.z);
  const cloudRotation = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
  const cloudSpace = new THREE.Matrix4().compose(cloudPosition, cloudRotation, new THREE.Vector3(1, 1, 1));
  return new THREE.Matrix4().multiplyMatrices(trackerSpace, cloudSpace.clone().invert());
}

// PoseFilter (ver src/pose-filter.js, puerto de Immersal): en vez de aplicar
// cada corrección cruda, la acumulamos en un historial de 8 muestras que
// promedia y descarta outliers — absorbe una localización puntual mala sin
// que se note como salto.
const poseFilter = new PoseFilter(THREE);

// Umbrales de "warp directo" — si la corrección filtrada implica moverse más
// de 5m o girar más de 20° respecto de donde está el ancla ahora, asumimos
// que es un realineamiento real (no ruido) y saltamos directo en vez de
// interpolar durante segundos hacia el lugar correcto. Mismos valores que
// usa Immersal (warpThresholdDistSq/warpThresholdCosAngle en
// immersal-module.js) — no hay una base empírica propia todavía para este
// mapa puntual, pero son un punto de partida razonable.
const WARP_THRESHOLD_DIST_SQ = 5.0 * 5.0;
const WARP_THRESHOLD_COS_ANGLE = Math.cos((20.0 * Math.PI) / 180.0);
// Factor de suavizado exponencial por frame (no por tiempo fijo como antes)
// — mismo valor default que usa Immersal en su propio onRender.
const POSE_SMOOTHING = 0.025;

let poseLoopRunning = false;
let prevPoseLoopTime = performance.now();

// Loop continuo (no un tween de una sola corrección): persigue
// poseFilter.position/rotation cuadro a cuadro, igual que el onRender de
// Immersal. Arranca una sola vez, con la primera localización exitosa (ver
// applyLocalizationResult), y sigue corriendo indefinidamente — así una
// corrección de fondo (relocalización periódica) también se suaviza, no
// solo la del tap manual inicial.
function poseFilterTick(now) {
  if (!poseLoopRunning) return;

  if (poseFilter.sampleCount() > 0) {
    const anchor = mapAnchorEl.object3D;
    const distSq = anchor.position.distanceToSquared(poseFilter.position);
    const cosAngle = poseFilter.rotation.dot(anchor.quaternion);

    if (poseFilter.sampleCount() === 1 || distSq > WARP_THRESHOLD_DIST_SQ || cosAngle < WARP_THRESHOLD_COS_ANGLE) {
      anchor.position.copy(poseFilter.position);
      anchor.quaternion.copy(poseFilter.rotation);
    } else {
      const elapsedSeconds = (now - prevPoseLoopTime) / 1000;
      const steps = Math.min(6, Math.max(1, elapsedSeconds / (1 / 60)));
      const alpha = 1 - (1 - POSE_SMOOTHING) ** steps;
      anchor.position.lerp(poseFilter.position, alpha);
      anchor.quaternion.slerp(poseFilter.rotation, alpha);
    }
  }

  prevPoseLoopTime = now;
  requestAnimationFrame(poseFilterTick);
}

function startPoseFilterLoop() {
  if (poseLoopRunning) return;
  poseLoopRunning = true;
  prevPoseLoopTime = performance.now();
  requestAnimationFrame(poseFilterTick);
}

function stopPoseFilterLoop() {
  poseLoopRunning = false;
}

// Punto de entrada llamado desde captureAndLocalize() con cada pose aceptada
// (ya pasó el umbral de confianza). trackerSpace es el snapshot tomado ANTES
// de mandar la foto — ver el comentario en captureAndLocalize sobre por qué
// no se puede usar la pose actual del tracker al momento en que llega la
// respuesta.
function applyLocalizationResult(pose, trackerSpace) {
  const m = trackerFromCloudSpace(pose.position, pose.rotation, trackerSpace);
  poseFilter.refinePose(m);

  if (poseFilter.sampleCount() === 1) {
    // Primera corrección real: recién ahora el ancla tiene una
    // transformación con sentido (antes era la identidad, apuntando a
    // cualquier lado según el origen arbitrario del SLAM) — la mostramos y
    // arrancamos el loop que la persigue cuadro a cuadro.
    mapAnchorEl.setAttribute('visible', true);
    startPoseFilterLoop();
  }
}

// REVISIÓN (2026-07-20): hintPosition tiene que ir en LHS (Unity), el mismo
// sistema que usa la doc oficial "Find Hint Coordinates" (coordenadas
// (x,y,z) tomadas directamente sobre el mesh del mapa, relativas al origen).
// Nosotros pedimos la pose en RHS (isRightHanded:true, el sistema que usa
// THREE.js/A-Frame), así que hay que convertir antes de mandarlo.
// Para un vector de POSICIÓN (sin rotación) la conversión RHS<->LHS estándar
// es invertir un solo eje — acá Z — lo cual es matemáticamente correcto y
// suficiente (a diferencia de una matriz/quaternion de rotación, donde
// además habría que invertir esa misma componente en la rotación; no aplica
// acá porque hintPosition no lleva orientación).
// Lo que SIGUE sin confirmar 1:1 es que el eje que MultiSet llama "Z" en su
// LHS interno sea el mismo que nuestro "Z" en RHS antes del flip (podría
// haber además un intercambio de ejes o una rotación de mapeo, no solo un
// flip de signo) — la doc de MultiSet nunca necesita aclararlo porque su
// flujo soportado (portal web / MapPointInspector en Unity) obtiene las
// coordenadas ya en LHS, nunca parte de un sistema RHS a convertir.
// TODO validar en dispositivo: capturar un punto conocido con el método
// oficial de MultiSet (portal o Unity) y comparar contra el valor que
// produce esta función para la misma posición física.
function toHintPositionString(rhsPosition) {
  return `${rhsPosition.x},${rhsPosition.y},${-rhsPosition.z}`;
}

// ─── Chequeo de proximidad GPS ─────────────────────────────────────────────
// Antes de gastar cuota en un request real de vps/map/query, comparamos la
// posición GPS del usuario contra el punto georeferenciado del mapa (ver
// getMapLocation() en multiset-client.js). Si está lejos, ni intentamos
// escanear: avisamos directo dónde tiene que acercarse.
//
// OJO: la precisión de navigator.geolocation en un browser puede andar de
// unos pocos metros (GPS puro, al aire libre) a 50-100+ metros (indoor, por
// wifi/cell triangulation) — justo el escenario típico de un VPS indoor. El
// umbral de abajo es generoso a propósito para no bloquear intentos válidos
// por error de GPS; esto es un chequeo best-effort del lado del cliente, no
// una garantía dura de proximidad — el chequeo real de "coincide o no" lo
// sigue haciendo MultiSet contra la imagen.
const MAX_DISTANCE_METERS = Number(import.meta.env.VITE_MAX_DISTANCE_METERS) || 150;

function getCurrentPosition(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocalización no disponible en este navegador.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      reject,
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10000 }
    );
  });
}

// Fórmula de Haversine — distancia en metros entre dos puntos lat/lon.
function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

let checkingLocation = false;

btnLocalize.addEventListener('click', () => {
  if (localizing || checkingLocation) return;
  // Defensivo: el botón ya queda disabled hasta everReachedNormalTracking
  // (ver diagnosticsPipelineModule().onStart/onUpdate), esto es solo para no
  // confiar ciegamente en el atributo DOM si algo lo pisara desde afuera.
  if (!everReachedNormalTracking) return;
  checkProximityAndRequestLocalization();
});

async function checkProximityAndRequestLocalization() {
  // En mock no hay mapa real georeferenciado contra el cual comparar —
  // saltamos el chequeo para no romper el flujo de prueba local.
  if (MOCK_ENABLED) {
    captureAndLocalize();
    return;
  }

  checkingLocation = true;
  setStatus('Verificando tu ubicación...');

  try {
    const [userPos, mapPos] = await Promise.all([getCurrentPosition(), getMapLocation()]);
    const distance = distanceMeters(userPos, mapPos);

    if (distance > MAX_DISTANCE_METERS) {
      confidenceBadge.style.display = 'none';
      setStatus(
        'No ha sido posible escanearlo debido a que te encontrás muy lejos de la ubicación. '
        + `Por favor acercate a (${mapPos.lat.toFixed(6)}, ${mapPos.lon.toFixed(6)}).`
      );
      return;
    }
  } catch (err) {
    // Fail-open: si no podemos confirmar la ubicación (GPS denegado, sin
    // señal, mapa sin georeferenciar, etc.) dejamos pasar el intento en vez
    // de bloquear la feature entera por un chequeo que es un extra, no el
    // corazón del flujo.
    console.warn('No se pudo verificar la proximidad GPS, se intenta localizar igual:', err);
  } finally {
    checkingLocation = false;
  }

  await captureAndLocalize();
}

// Captura MULTI_IMAGE_COUNT frames en ráfaga para /vps/map/multi-image-query,
// cada uno emparejado con la pose LOCAL de tracking (localPose, snapshot
// tomado dentro de captureImageFrame) en el instante exacto de esa captura.
// MULTI_IMAGE_DELAY_MS entre tomas: sin nada de por medio, dos capturas
// seguidas pueden leer el mismo cameraData.buffer si CameraPixelArray no
// tickeó un frame nuevo entre medio — la espera le da tiempo al pipeline, y
// de paso da margen a que el usuario mueva apenas el teléfono entre tomas
// (el sentido de mandar varias fotos es cubrir ángulos/detalle distintos, no
// repetir la misma imagen 4 veces).
const MULTI_IMAGE_COUNT = 4; // el schema real solo define image1..image4, no hasta 6 como dice el texto de la doc
const MULTI_IMAGE_DELAY_MS = Number(import.meta.env.VITE_MULTISET_MULTI_IMAGE_DELAY_MS) || 200;

async function captureMultiImageFrames() {
  const frames = [];
  for (let i = 0; i < MULTI_IMAGE_COUNT; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, MULTI_IMAGE_DELAY_MS));
    frames.push(await captureImageFrame());
  }
  return frames;
}

async function captureAndLocalize() {
  localizing = true;
  btnLocalize.disabled = true;
  btnLocalize.textContent = 'Localizando...';

  // Snapshot de la pose del tracker EN ESTE INSTANTE, antes de cualquier
  // await — es la pose real de la cámara en el momento en que se toma la
  // foto que le mandamos a MultiSet. Si en cambio leyéramos
  // sceneEl.camera.matrixWorld recién cuando llega la respuesta del server
  // (cientos de ms después), el teléfono ya se movió y trackerFromCloudSpace
  // calcularía la transformación contra la pose equivocada — mismo principio
  // que "const trackerSpace = camera.matrixWorld.clone()" en Immersal.
  const trackerSpaceAtCapture = sceneEl.camera.matrixWorld.clone();

  try {
    let pose;
    const hintPosition = lastKnownPosition ? toHintPositionString(lastKnownPosition) : undefined;

    if (MULTI_IMAGE_ENABLED) {
      setStatus(MOCK_ENABLED ? 'Localizando con MultiSet (mock, multi-imagen)...' : 'Capturando 4 fotos para MultiSet...');

      const frames = await captureMultiImageFrames();
      const { width, height, intrinsics } = frames[0];

      setStatus(MOCK_ENABLED ? 'Localizando con MultiSet (mock)...' : 'Localizando con MultiSet (multi-imagen)...');
      pose = await queryMultiImageLocalization(frames, intrinsics, { width, height }, hintPosition);
    } else {
      setStatus(MOCK_ENABLED ? 'Localizando con MultiSet (mock)...' : 'Localizando con MultiSet...');

      const frame = await captureImageFrame();
      pose = await queryLocalization(frame.jpegBuffer, frame.intrinsics, { width: frame.width, height: frame.height }, hintPosition);
    }

    if (!pose) {
      confidenceBadge.style.display = 'none';
      setStatus('MultiSet: no se pudo localizar en este frame (mapa no reconocido).');
      return;
    }

    // NO es GeoPose/WGS84: confirmado contra la doc oficial
    // (multiset.gitbook.io/multiset/basics/localization/geopose-support) que
    // eso requiere pasar "convertToGeoCoordinates: true" en el request de
    // /vps/map/query — multiset-client.js no lo manda, así que la respuesta
    // ya viene en coordenadas locales cartesianas: position {x,y,z} y
    // rotation como cuaternión real {x,y,z,w} (confirmado con el ejemplo
    // textual de la doc). Sin ángulos de Euler, sin matriz, sin conversión
    // de por medio — se puede pasar directo a trackerFromCloudSpace().
    //
    // Validación defensiva: si la respuesta viniera con position/rotation en
    // una forma inesperada (campo faltante, no numérico), preferimos tirar
    // un error visible acá antes que componer una matriz con undefined/NaN
    // — eso produciría un mal posicionamiento silencioso, muy difícil de
    // diagnosticar después.
    const hasVector3 = (v) => v && ['x', 'y', 'z'].every((k) => typeof v[k] === 'number');
    const hasQuaternion = (q) => q && ['w', 'x', 'y', 'z'].every((k) => typeof q[k] === 'number');
    if (!hasVector3(pose.position) || !hasQuaternion(pose.rotation)) {
      throw new Error(`MultiSet devolvió position/rotation con forma inesperada: ${JSON.stringify(pose)}`);
    }

    const confidencePct = Math.round((pose.confidence || 0) * 100);

    // Umbral de confianza (ver CONFIDENCE_THRESHOLD arriba): una pose de baja
    // confianza puede ser peor que no corregir — la descartamos antes de
    // meterla en el PoseFilter en vez de aplicarla a ciegas.
    if ((pose.confidence || 0) < CONFIDENCE_THRESHOLD) {
      console.warn(`⚠️ MultiSet devolvió confianza ${confidencePct}% (mínimo ${Math.round(CONFIDENCE_THRESHOLD * 100)}%) — corrección descartada.`);
      setStatus(`MultiSet: confianza demasiado baja (${confidencePct}%), se mantiene la posición actual.`);
      confidenceBadge.textContent = `⚠️ Confianza baja (${confidencePct}%) — descartada`;
      confidenceBadge.style.display = 'block';
      return;
    }

    // Log dedicado y en línea plana (no objeto anidado) a propósito: esto es
    // lo que hay que comparar entre dos taps de "Localizar" hechos desde
    // posiciones físicas distintas para diagnosticar un salto/teletransporte
    // del cubo — el mensaje de más abajo ("MultiSet reconoció el mapa") solo
    // mostraba el % de confianza a simple vista, con la pose completa
    // escondida adentro de un objeto que en la consola visual (eruda) o en el
    // texto copiado quedaba menos fácil de leer/diffear de un vistazo.
    console.log(
      `📌 Pose de MultiSet — position: x=${pose.position.x.toFixed(4)}, y=${pose.position.y.toFixed(4)}, z=${pose.position.z.toFixed(4)} `
      + `| rotation: w=${pose.rotation.w.toFixed(4)}, x=${pose.rotation.x.toFixed(4)}, y=${pose.rotation.y.toFixed(4)}, z=${pose.rotation.z.toFixed(4)} `
      + `| confianza=${confidencePct}%`
    );

    // applyLocalizationResult mete la corrección en el PoseFilter (absorbe
    // outliers) y realinea #map-anchor — no el tracking de XR8. La primera
    // vez, hace visible el ancla y arranca el loop que la persigue cuadro a
    // cuadro (ver comentario junto a poseFilterTick más arriba).
    applyLocalizationResult(pose, trackerSpaceAtCapture);
    lastKnownPosition = { x: pose.position.x, y: pose.position.y, z: pose.position.z }; // para el hintPosition del próximo query

    // A partir de la primera corrección real (no la default de arranque),
    // habilitamos la relocalización automática por pérdida de tracking (ver
    // diagnosticsPipelineModule) y arrancamos el timer de relocalización
    // periódica — replicando startBackgroundLocalization() del SDK oficial.
    if (!hasLocalizedOnce) {
      hasLocalizedOnce = true;
      if (!bgLocalizationPaused) startBackgroundLocalization();
    }

    // Confirmación visible de que MultiSet reconoció el mapa que importaste
    // (poseFound:true) — independiente de si el cubo se ve bien o no, esto
    // confirma que el VPS efectivamente lo captó.
    console.log(`✅ MultiSet reconoció el mapa — confianza ${confidencePct}%`, pose);
    setStatus(`MultiSet: localizado (${confidencePct}%)`);
    confidenceBadge.textContent = `✅ Mapa reconocido (${confidencePct}%)`;
    confidenceBadge.style.display = 'block';
  } catch (err) {
    // No usamos showError acá: un fallo de localización no es fatal para la
    // sesión AR (el tracking de XR8 sigue andando), a diferencia de un error
    // del pipeline. Solo lo mostramos como diagnóstico.
    console.error('Error consultando MultiSet:', err);
    setStatus('Error de MultiSet: ' + err.message);
    confidenceBadge.style.display = 'none';
  } finally {
    localizing = false;
    btnLocalize.disabled = false;
    btnLocalize.textContent = '📍 Localizar';
  }
}

// ─── Arranque del motor ─────────────────────────────────────────────────────────
// XR8Promise ya resuelve apenas el script xr.js (cargado en index.html) termina
// de inicializar window.XR8. A diferencia de la versión Three.js manual, ya NO
// llamamos XR8.run() nosotros — eso lo maneja xrweb/xrconfig internamente,
// disparado por el evento "runreality" (ver más abajo). Acá solo registramos
// nuestros módulos propios (no tienen equivalente declarativo en A-Frame) y
// dejamos todo listo para cuando el usuario toque el botón.
XR8Promise.then((XR8) => {
  xr8Instance = XR8; // lo necesita triggerFallback() para pausar el motor

  // Chequeo de compatibilidad ANTES de mostrar "Iniciar AR". Mismo config
  // (allowedDevices: mobile-and-headsets) que usa xrconfig por default —
  // si el dispositivo/navegador no lo cumple, ni mostramos el botón: vamos
  // directo al fallback (visor 3D), la misma pantalla que ya usamos cuando
  // el GPU no aguanta el SLAM. Sin esto, un usuario en un navegador no
  // soportado tocaría "Iniciar AR" y recién ahí vería fallar algo.
  const isCompatible = XR8.XrDevice.isDeviceBrowserCompatible({
    allowedDevices: XR8.XrConfig.device().MOBILE_AND_HEADSETS,
  });
  if (!isCompatible) {
    triggerFallback('Dispositivo o navegador no compatible con AR');
    return;
  }

  // Agregamos los atributos xrconfig/xrweb/xrextras-* recién ACÁ, no en el
  // HTML estático — ver el comentario largo junto a <a-scene> en index.html.
  // Resumen: si estos atributos ya están en el HTML cuando xr.js carga,
  // "AFRAME.registerComponent('xrweb', ...)" dispara el init del componente
  // en el acto, en un punto donde xr.js todavía no terminó de asignar el
  // global "XR8" que el componente necesita — tira "ReferenceError: XR8 is
  // not defined". Seteando los atributos acá, con XR8Promise ya resuelto,
  // ese global está garantizado completo.
  //
  // "landing-page" NO se agrega a propósito: es el componente que muestra
  // la pantalla "Scan or visit ... to continue" con branding de 8th Wall
  // (confirmado en public/landing-page/landing-page.js — defaultParameters
  // trae ese texto hardcodeado). Ya cubrimos su función real (avisar si el
  // dispositivo no es compatible) arriba, con nuestra propia UI.
  sceneEl.setAttribute('xrconfig', 'delayRun: true');
  sceneEl.setAttribute('xrweb', 'scale: absolute');
  sceneEl.setAttribute('xrextras-runtime-error', '');

  // CameraPixelArray SÍ hay que agregarlo a mano — a diferencia de
  // CanvasScreenshot (que la integración A-Frame de XR8 ya agrega sola),
  // este no es parte del set que arma xrweb por default: es opt-in porque
  // tiene un costo de CPU real (lee de vuelta la textura de GPU cada frame).
  // Config (2026-07-24, copiado del SDK WebXR de referencia —
  // @multisetai/vps/dist/three/index.js, función N() — que manda JPEG a
  // color y confirmó ser el que mejor trackea/reconoce contra MultiSet):
  //   - Sin "luminance": default false → RGBA color, no 1 canal (antes
  //     mandábamos escala de grises, una suposición no validada — ver el
  //     TODO que había en multiset-client.js).
  //   - "maxDimension: 1280": downsample en GPU (antes de leer los píxeles)
  //     al mismo límite que usa el SDK de referencia
  //     (Math.min(1, 1280/Math.max(w,h)) en su función N()) — evita mandar
  //     fotos de 4K+ innecesariamente pesadas para el matching visual.
  // Se registra ANTES de nuestro módulo para que, aunque no sería
  // estrictamente necesario dado que onProcessGpu corre completo para todos
  // los módulos antes de que empiece onUpdate para cualquiera, el orden
  // quede igual al que usa el propio ejemplo de Immersal (de donde viene el
  // resto del pipeline de captura).
  XR8.addCameraPipelineModule(XR8.CameraPixelArray.pipelineModule({ maxDimension: 1280 }));
  XR8.addCameraPipelineModule(diagnosticsPipelineModule());

  btnStartAR.disabled = false;

  // IMPORTANTE: emitimos "runreality" de forma síncrona dentro del handler de
  // click, sin ningún await antes, para preservar el gesto de usuario — si no,
  // iOS Safari puede negar el permiso de cámara en silencio (mismo principio
  // que ya aplicábamos con XR8.run() en la versión anterior). xrconfig tiene
  // que tener "delayRun: true" en el HTML para que la cámara no arranque sola
  // al cargar la escena — ver comentario junto a <a-scene> en index.html.
  btnStartAR.addEventListener('click', () => {
    btnStartAR.disabled = true;
    btnStartAR.textContent = 'Iniciando...';

    // El permiso de GPS se pide ACÁ (gesto de usuario de "Iniciar AR"), no en
    // "Localizar" — no bloqueamos el arranque de AR esperando la respuesta,
    // solo disparamos el prompt del navegador ahora. Así, cuando más tarde
    // el usuario toque "Localizar", el permiso ya está resuelto y
    // getCurrentPosition() en checkProximityAndRequestLocalization() no
    // interrumpe ese flujo con un prompt a mitad de camino.
    if (!MOCK_ENABLED && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(() => {}, () => {}, { enableHighAccuracy: true, timeout: 8000 });
    }

    try {
      sceneEl.emit('runreality');
      landing.style.display = 'none';
      btnDebugToggleView.style.display = 'block';
      setStatus('Cargando motor y cámara...');
    } catch (error) {
      showError('No se pudo iniciar XR8:', error);
    }
  });
}).catch((err) => {
  console.error('No se pudo cargar el motor 8th Wall:', err);
  setStatus('Error al cargar el motor 8th Wall.');
});
