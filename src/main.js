import { XR8Promise } from '@8thwall/engine-binary';
import {
  queryLocalization,
  queryMultiImageLocalization,
  getMapLocation,
  MOCK_ENABLED,
  MULTI_IMAGE_ENABLED,
} from './multiset-client.js';
import { PoseFilter } from './pose-filter.js';

// We use the THREE that A-Frame already bundles (exposed at
// window.AFRAME.THREE) instead of importing the "three" npm package
// separately. Previously we imported both: A-Frame 1.8.0 loads its own
// copy of Three.js (r184, per the console log) and our "three" import
// (^0.185.1 in package.json) brought a SEPARATE instance — hence the
// warning "THREE.WARNING: Multiple instances of Three.js being imported."
// It's not just cosmetic: they have two separate class registries, so an
// internal check like "instanceof THREE.Vector3" against an object
// created with the other instance fails silently. Reusing A-Frame's
// eliminates the duplicate and also saves downloading Three.js twice in
// the bundle. index.html loads aframe.min.js synchronously in <head>
// (no async/defer), before this module (which is <script type="module">,
// deferred by default), so window.AFRAME is already ready here.
const THREE = window.AFRAME.THREE;

// ─── Visual console on mobile (?debug=1) ────────────────────────────────────
// Chrome's remote inspector (chrome://inspect) isn't working for debugging
// on the phone, so we expose an on-screen console as an alternative: eruda
// draws a floating button that opens a panel with console.log/error,
// network, elements, etc. Only loaded if the URL has "?debug=1" to avoid
// showing it to real users of the AR experience.
if (new URLSearchParams(location.search).has('debug')) {
  setupDebugConsole();
}

// Eruda's copy button only copies ONE line at a time, and it also
// requires tapping it first to "select" it (otherwise it's grayed out/
// disabled — not a bug, that's by design). For debugging on a phone it's
// much more useful to be able to copy ALL history in one tap, so we
// intercept console.* ourselves in our own buffer and add a separate
// floating button that copies the full buffer.
function setupDebugConsole() {
  const logBuffer = [];
  const MAX_LOG_LINES = 1000; // avoid growing without limit in a long session

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
    btnCopyConsole.textContent = '📋 Copy console';
    Object.assign(btnCopyConsole.style, {
      position: 'fixed',
      bottom: '70px',
      right: '16px',
      zIndex: 2147483647, // above the eruda panel
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
      const text = logBuffer.join('\n') || '(empty console)';
      const ok = await copyToClipboard(text);
      const original = btnCopyConsole.textContent;
      btnCopyConsole.textContent = ok ? '✅ Copied' : '❌ Copy failed';
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

// navigator.clipboard requires a secure context (https/ngrok) and
// sometimes fails on mobile even if the site is https (permission
// denied, WebView, etc.) — if it fails, we fall back to
// document.execCommand("copy") with a hidden textarea, which is more
// tolerant in older mobile browsers.
async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to fallback
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
const landing = document.getElementById('landing');
const btnStartAR = document.getElementById('btn-start-ar');
const statusText = document.getElementById('status-text');
const sceneEl = document.getElementById('ar-scene');
const mapAnchorEl = document.getElementById('map-anchor');
const hud = document.getElementById('hud');
const btnLocalize = document.getElementById('btn-localize');
const confidenceBadge = document.getElementById('confidence-badge');
const fallbackViewer = document.getElementById('fallback-viewer');
const fallbackCanvas = document.getElementById('fallback-canvas');
const btnFallbackBack = document.getElementById('btn-fallback-back');
const btnDebugToggleView = document.getElementById('btn-debug-toggle-view');
const cubeScaleSlider = document.getElementById('cube-scale-slider');
const arCube = document.getElementById('ar-cube');

let xr8Instance = null; // set as soon as XR8Promise resolves, needed by triggerFallback()

function setStatus(msg) {
  statusText.textContent = msg;
  statusText.style.display = msg ? 'block' : 'none';
}

// Shows the error both in the status bar (visible on screen, crucial for
// debugging on a phone without devtools) and in console.
function showError(prefix, error) {
  console.error(prefix, error);
  setStatus(`${prefix} ${error?.message || error}`);
  btnStartAR.disabled = false;
  btnStartAR.textContent = 'Start AR';
  landing.style.display = 'flex';
  btnDebugToggleView.style.display = 'none';
}

// ─── Automatic fallback for insufficient GPU/driver: DISABLED ─────────────────
// There was an attempt to reactively detect a broken SLAM (avalanche of WebGL
// errors, confirmed on Moto E40 and a Redmi Note 13 Pro with ARM beta driver)
// by automatically sending users to the 3D viewer if tracking never reached
// 'NORMAL' within a timeout. Removed (2026-07-22): a time-based timeout
// (even combined with a minimum of accumulated movement) still gives false
// positives — there are HEALTHY devices that simply take longer to stabilize
// visual-inertial SLAM, and there's no reliable way to distinguish "it'll take
// longer" from "it's broken and will never get there" without risking ejecting
// a legitimate user mid-session. The test button (#btn-debug-toggle-view)
// remains available for manually comparing camera/AR vs. 3D viewer when
// diagnosing a specific device.
let fallbackTriggered = false;

// Set to true the first time reality.trackingStatus === 'NORMAL' at
// ANY point during the session. Enables the "Localize" button (see
// btnLocalize below: disabled until this point, to avoid anchoring
// the world origin against a still-unstable tracking pose — that's
// what caused the cube to "jump" as soon as SLAM transitioned from
// INITIALIZING to NORMAL).
let everReachedNormalTracking = false;

function triggerFallback(reason) {
  if (fallbackTriggered) return;
  fallbackTriggered = true;

  console.warn('⚠️ Fallback triggered:', reason);

  // Stop XR8's run loop and release the camera — no point in continuing
  // to spend battery/CPU on tracking we already know is broken.
  try {
    xr8Instance?.pause();
  } catch (err) {
    console.warn('Could not pause XR8:', err);
  }
  stopBackgroundLocalization();
  stopPoseFilterLoop();
  document.querySelectorAll('video').forEach((video) => {
    video.srcObject?.getTracks().forEach((track) => track.stop());
  });

  landing.style.display = 'none';
  showFallbackView();

  // This fallback is DEFINITIVE for the session (camera released, XR8
  // paused) — unlike the test toggle, there's no reliable way to
  // return to the camera view without reloading (see btnFallbackBack).
  // We hide the test button so we don't offer a return that can't work.
  btnDebugToggleView.style.display = 'none';
}

// Simple 3D view of the same cube, without camera or tracking — a
// separate THREE.Scene, independent of A-Frame/XR8. Auto-rotates so
// it can be viewed from all angles without needing touch controls.
//
// Created ONCE (lazy, in ensureFallbackScene): the test toggle can
// show/hide this viewer many times in the same session, and each
// "new THREE.WebGLRenderer(...)" opens a new WebGL context on the same
// <canvas> — Android/Chrome has a low limit of simultaneous live WebGL
// contexts, so recreating it on each toggle would exhaust it. What IS
// stopped/restarted on each toggle is the animation loop (rAF), via
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
  if (fallbackAnimating) return; // loop already running, don't start another in parallel
  fallbackAnimating = true;

  function animate() {
    if (!fallbackAnimating) return; // cuts the loop when hiding fallback
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

// ─── Show/hide the fallback 3D viewer ───────────────────────────────────────
// Shared between the automatic fallback (triggerFallback, definitive) and
// the test button (reversible) — both need the same UI choreography,
// they only differ in whether they also pause XR8/release the camera.
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
  // Reload is the simplest and most reliable approach here: XR8 isn't
  // designed to cleanly restart an already-paused session.
  window.location.reload();
});

// ─── TEST button: manually toggle camera/AR ↔ 3D viewer ─────────────────────
// Unlike the automatic fallback above, this does NOT pause XR8 or
// release the camera — the engine keeps running in the background even
// while the 3D viewer is showing. Useful for visually comparing, on a
// device where the cube doesn't project, whether the problem is
// rendering (nothing new ever appears, not even in this test viewer) or
// positioning (the 3D viewer does show the cube, it's just that the
// real pose puts it out of camera view).
let inDebugFallbackView = false;

btnDebugToggleView.addEventListener('click', () => {
  if (fallbackTriggered) return; // no live camera to go back to

  inDebugFallbackView = !inDebugFallbackView;

  if (inDebugFallbackView) {
    showFallbackView();
    btnDebugToggleView.textContent = '📷 View camera/AR';
  } else {
    showARView();
    btnDebugToggleView.textContent = '🧪 View 3D viewer';
  }
});

// ─── Fix: force the main back camera (not macro) ────────────────────────────
// Two previous attempts failed: track.applyConstraints()
// (OverconstrainedError) and requesting the new stream BEFORE releasing
// the old one (NotReadableError: "Could not start video source"). The
// key mistake was in the order: we requested the new camera while the
// old one (that XR8 already had open) was still active. Sites like
// https://es.webcamtests.com/ CAN open each lens separately —
// confirming it's not a device limitation; you just need to release
// the current camera first and give the driver a margin before
// requesting the other one. This operates at DOM/window level
// (MediaStreamTrack), independent of whether rendering is manual
// Three.js or A-Frame — stays the same with the migration.
async function forceMainBackCamera(videoEl) {
  const track = videoEl?.srcObject?.getVideoTracks?.()[0];
  if (!track) return;

  console.log('📷 Active camera:', track.label || '(no label)');

  let videoInputs;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoInputs = devices.filter((d) => d.kind === 'videoinput');
    console.log(`📷 ${videoInputs.length} camera(s) detected:`,
      videoInputs.map((d) => `${d.label || '(no label)'} [${d.deviceId.slice(0, 12)}...]`));
  } catch (err) {
    console.warn('Could not enumerate cameras:', err);
    return;
  }

  // Android convention: lowest index = main sensor, higher indices
  // are auxiliary lenses added later (ultra wide, macro, depth).
  // This device labels "camera N, facing back" (without the "2"
  // Samsung/Huawei labels use), so we parse the number instead
  // of looking for an exact string.
  const backCameras = videoInputs
    .filter((d) => /facing back/i.test(d.label))
    .map((d) => ({ device: d, index: parseInt((d.label.match(/camera2?\s*(\d+)/i) || [])[1], 10) }))
    .sort((a, b) => (a.index || 0) - (b.index || 0));

  const mainCamera = backCameras[0]?.device;
  const currentId = track.getSettings().deviceId;

  if (!mainCamera || mainCamera.deviceId === currentId) {
    setStatus(`Camera: ${track.label || 'unknown'}`);
    return;
  }

  // Release the current camera BEFORE requesting the other one (the
  // step we were missing) and give the driver margin to actually free it.
  track.stop();
  await new Promise((resolve) => setTimeout(resolve, 300));

  // "ideal" (not "exact"/min): request the best possible quality without
  // the request failing if the sensor can't reach 1920x1080/30fps — the
  // browser falls back to the maximum it does support. WITHOUT this,
  // Chrome/Android started the replacement stream at a low default
  // resolution (something like 640x480) instead of what the sensor can
  // actually deliver — confirmed as the cause of the camera looking
  // much worse quality than the native camera app on the same Redmi
  // Note 13 (which does run at 1920x1080).
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
    console.log('✅ Camera switched to main:', mainCamera.label);
    setStatus(`Camera: ${mainCamera.label}`);
  } catch (err) {
    // Don't leave the user without a camera if the main one also
    // fails to open: reopen the original as a safety net.
    console.warn('Could not open main camera, reopening original:', err);
    try {
      const fallbackStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: currentId }, ...idealVideoConstraints },
      });
      videoEl.srcObject = fallbackStream;
      setStatus(`Could not switch camera (${err.name}). Keeping: ${track.label}`);
    } catch (fallbackErr) {
      console.error('Could not reopen any camera:', fallbackErr);
      showError('Camera error:', fallbackErr);
    }
  }
}

// XR8 doesn't expose a reliable public event for "the camera now has a
// stream" (it's a closed engine, with no documentation on that internal
// detail — a first attempt hooked to a supposed "xr.camerastatuschange"
// event on window never fired, so we discarded it). Instead of guessing
// its internal event bus, we observe the DOM directly: we know it creates
// a hidden <video> for the camera feed, so as soon as one appears with
// an active stream, we log which camera ended up active.
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

// ─── Custom pipeline module: diagnostics ─────────────────────────────────────
// The test cube is now 100% declarative (<a-entity> in index.html) — xrweb
// already sets up the A-Frame scene/camera, so there's no need for a manual
// onStart to add the cube or fix the camera's initial position. The only
// thing still needed from JS is diagnostics: knowing if the pipeline throws
// an exception, and logging the tracker state.
function diagnosticsPipelineModule() {
  return {
    name: 'diagnostics',

    onStart: () => {
      console.log('✅ XR8 pipeline started (A-Frame + xrweb).');
      // "Localize" starts disabled: trackerFromCloudSpace() uses
      // sceneEl.camera.matrixWorld (the native tracker) as reference
      // to anchor #map-anchor — localizing while SLAM is still
      // LIMITED/INITIALIZING would feed that unstable pose directly
      // into the PoseFilter (see long comment next to
      // everReachedNormalTracking above). It gets re-enabled below
      // in onUpdate, the first time trackingStatus === 'NORMAL'.
      btnLocalize.disabled = true;
      setStatus('Engine started. Move the phone slowly to stabilize tracking...');
      hud.style.display = 'flex';
    },

    onException: (error) => showError('XR8 pipeline error:', error),

    // "reality.trackingstatus" is a documented internal event from the
    // Camera Pipeline Modules framework (unlike
    // "xr.camerastatuschange", which turned out to not be accessible
    // from outside). We subscribe here to see in console what the
    // tracker itself reports about its state — more reliable than
    // judging by eye whether the cube "shakes too much" or not.
    listeners: [
      { event: 'reality.trackingstatus', process: (e) => console.log('🧭 reality.trackingstatus:', e.detail) },
    ],

    // Periodic sampling of processCpuResult.reality (position/rotation
    // that 8th Wall's own SLAM reports frame by frame, between MultiSet
    // corrections). "reality" is the fixed name XR8 uses to expose its
    // internal world tracking result to ANY pipeline module via
    // onUpdate — no need to add XR8.XrController.pipelineModule()
    // separately, xrweb already has it running. Logged once per second
    // (not every frame, to avoid flooding the console) to have
    // objective evidence of how much tracking "floats" between
    // "Localize" taps, instead of judging by eye whether the cube
    // shakes.
    // Additionally, this replicates a technique from the official
    // MultiSet SDK (@multisetai/vps, xrLoop()): when there's no
    // tracking pose for W=60 consecutive frames (~2s at 30fps), it
    // triggers an automatic relocalization
    // (this.options.relocalization && this.localizeFrame()). We don't
    // have "absent viewer pose" (that's WebXR); the equivalent in 8th
    // Wall is a sustained reality.trackingStatus === 'LIMITED'. Same
    // threshold (60 frames) since we don't have our own better
    // grounded one.
    //
    // Also here, each frame, we read the real camera intrinsics
    // (reality.intrinsics) and the raw pixel buffer delivered by
    // CameraPixelArray (processGpuResult.camerapixelarray) — see the
    // long comment next to "cameraData" below about why this lives in
    // onUpdate and not in a separate onProcessCpu.
    onUpdate: (() => {
      let frameCount = 0;
      let trackingLossFrames = 0;
      const TRACKING_LOSS_FRAMES_THRESHOLD = 60;

      return ({ frameStartResult, processGpuResult, processCpuResult }) => {
        const reality = processCpuResult?.reality;
        if (!reality) return;

        if (reality.trackingStatus === 'NORMAL' && !everReachedNormalTracking) {
          everReachedNormalTracking = true;
          // Only now is it safe to anchor the world origin against a
          // stable tracking pose — we enable "Localize" (we don't
          // touch it if already in the middle of a localization/GPS
          // check).
          if (!localizing && !checkingLocation) {
            btnLocalize.disabled = false;
            setStatus('Tracking stable. Tap "Localize" to correct with MultiSet.');
          }
        }

        // Saved EVERY frame (not just every 30) — this is what
        // captureImageFrame() uses to build "imageN_data" at the exact
        // moment of each capture, not the diagnostic log below.
        if (reality.position && reality.rotation) {
          latestRealityPose = {
            x: reality.position.x, y: reality.position.y, z: reality.position.z,
            qx: reality.rotation.x, qy: reality.rotation.y, qz: reality.rotation.z, qw: reality.rotation.w,
          };
        }

        // Snapshot of the raw camera frame (pixels + real intrinsics)
        // for captureImageFrame(). Both require CameraPixelArray to
        // have run this frame (registered in XR8Promise.then() below,
        // as XR8.CameraPixelArray.pipelineModule({maxDimension:1280}))
        // — if it hasn't ticked once yet, camerapixelarray is
        // undefined here and we simply don't update cameraData,
        // leaving the previous value.
        const camerapixelarray = processGpuResult?.camerapixelarray;
        if (reality.intrinsics && camerapixelarray?.pixels) {
          // NOTE (fix 2026-07-24): intrinsics must be calculated
          // against the REAL size of the buffer we'll send
          // (camerapixelarray.cols/rows) and NOT against
          // frameStartResult.textureWidth/Height (the native GL
          // texture size, before any downsample).
          // reality.intrinsics is a normalized projection matrix
          // (resolution-independent) — fx/fy/px/py in PIXELS only
          // come out right if scaled against the width/height of the
          // image that actually reaches MultiSet. With
          // "maxDimension:1280" active, cols/rows (post-downsample)
          // can be quite different from textureWidth/Height (native)
          // — before, this went unnoticed because without downsample
          // both almost always coincided.
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
            console.warn('⚠️ Sustained LIMITED tracking (~2s) — auto-relocalizing with MultiSet.');
            captureAndLocalize();
          }
        } else {
          trackingLossFrames = 0;
        }
      };
    })(),
  };
}

// ─── Phase 2: MultiSet bridge — camera pipeline module ────────────────────────
// Direct guidance from the 8th Wall team (official response to a query about
// integrating an external VPS, already used before by another client):
// "Register a camera pipeline module. Grab a frame, send it to your backend,
// and if the position is detected, update the tracking." Documented lifecycle
// (8thwall.org/docs/api/engine/camerapipelinemodule):
//   onBeforeRun → onCameraStatusChange → onStart → onAttach
//     → onProcessGpu → onProcessCpu → onUpdate → onRender
// onProcessCpu is the documented point for "reading processing results and
// returning usable data" — it would be the canonical place to read
// processGpuResult.camerapixelarray. BUT we already confirmed in this
// project, with xrweb (A-Frame), that a custom onProcessCpu doesn't fire
// reliably (0 real requests reaching MultiSet when tried previously with
// CanvasScreenshot capture). That's why the raw frame snapshot (cameraData,
// below) is read in onUpdate instead of onProcessCpu — see
// diagnosticsPipelineModule() above: THAT onUpdate does fire reliably
// (it's what already sustains the reality.trackingStatus log), and per the
// documented lifecycle processGpuResult (with camerapixelarray already
// populated by XR8.CameraPixelArray, which runs EARLIER in the same
// onProcessGpu phase) remains available there, not only in onProcessCpu.
//
// The actual localization trigger (captureAndLocalize) still doesn't live
// inside any pipeline hook — it's called directly from the button tap, the
// background timer, or sustained tracking loss. Same pattern as
// @multisetai/vps (official SDK, pure WebXR, confirmed working): the
// "Localize" button calls `await adapter.localizeFrame()` directly in the
// click handler, without any per-frame indirection.
let localizing = false;

// Latest raw camera frame available, updated every frame by
// diagnosticsPipelineModule().onUpdate from CameraPixelArray +
// reality.intrinsics — replaces the previous capture via
// XR8.CanvasScreenshot.takeScreenshot() (a JPEG of the already-rendered
// <canvas>, with the 3D overlay on top) and intrinsics.fx/fy estimated
// from FOV. Here "buffer" is the RGBA buffer (4 channels, 8 bits)
// delivered by CameraPixelArray({maxDimension:1280}) — the camera
// sensor in color, with nothing drawn on top — and "intrinsics" are the
// real ones reported by 8th Wall's native SLAM (not an approximation).
// null until CameraPixelArray ticks for the first time.
const cameraData = {
  width: 0,
  height: 0,
  buffer: null,
  intrinsics: null,
};

// EXACT formula from the official Immersal module (immersal-module.js,
// getIntrinsics / immersal/index.js) to derive fx/fy/px/py from the
// projection matrix that the native SLAM already computes frame by frame
// (reality.intrinsics) — real values, not an estimate from the THREE.js
// virtual camera's FOV as done before. m[5] is the focal scale in Y;
// m[8]/m[9] the principal point offset in NDC (-1..1), rescaled to
// texture pixels. Assumes fx=fy (square pixels) because
// reality.intrinsics doesn't expose a separate value for X — same
// assumption Immersal makes with this same formula.
function getIntrinsicsFromReality(m, textureWidth, textureHeight) {
  const fl = 0.5 * m[5] * textureHeight;
  const px = 0.5 * (m[8] + 1.0) * textureWidth;
  const py = 0.5 * (m[9] + 1.0) * textureHeight;
  return { fx: fl, fy: fl, px, py };
}

// Color JPEG encoding (2026-07-24, replaces the grayscale PNG from
// src/png-worker.js) — copied from the reference WebXR SDK
// (@multisetai/vps/dist/three/index.js, function ne()): a normal 2D
// <canvas> (not OffscreenCanvas) on the main thread, same mechanism
// that reference function uses (which also does NOT use a worker for
// this). Keeping it in a worker was discarded: OffscreenCanvas.
// convertToBlob doesn't have reliable support on iOS Safari (a hard
// requirement for this project, see project architecture comments),
// and main-thread canvas.toBlob is universal — the encoding cost
// itself is low (a single JPEG image up to 1280px, not every frame).
//
// We reuse the same <canvas> between captures (same pattern as
// fallbackCanvas above) instead of creating a new one per photo.
const jpegCanvas = document.createElement('canvas');
const jpegCtx = jpegCanvas.getContext('2d');
const JPEG_QUALITY = 0.7; // same value the reference SDK uses

function encodeJpegFrame(rgbaBuffer, width, height) {
  jpegCanvas.width = width;
  jpegCanvas.height = height;
  // CameraPixelArray delivers Uint8Array; ImageData specifically
  // requires Uint8ClampedArray — the constructor below copies and
  // converts type simultaneously, also preventing putImageData from
  // reading a buffer that XR8 might keep writing to in future frames.
  const imageData = new ImageData(new Uint8ClampedArray(rgbaBuffer), width, height);
  jpegCtx.putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    jpegCanvas.toBlob(
      (blob) => (blob ? blob.arrayBuffer().then(resolve, reject) : reject(new Error('canvas.toBlob returned null'))),
      'image/jpeg',
      JPEG_QUALITY
    );
  });
}

// Snapshot + encoding of a frame to send to MultiSet. The snapshot of
// cameraData.buffer and latestRealityPose is taken HERE, synchronously,
// before the first await (new Uint8ClampedArray(rgbaBuffer) inside
// encodeJpegFrame already copies the buffer, so what XR8 keeps writing
// to cameraData.buffer in future frames doesn't affect this capture
// in progress).
async function captureImageFrame() {
  if (!cameraData.buffer || !cameraData.intrinsics) {
    throw new Error('No camera frame available yet (CameraPixelArray has not ticked).');
  }
  const { buffer, width, height, intrinsics } = cameraData;
  const localPose = latestRealityPose;
  const jpegBuffer = await encodeJpegFrame(buffer, width, height);
  return { jpegBuffer, width, height, intrinsics, localPose };
}

// Latest LOCAL tracking pose (XR8's own SLAM, not MultiSet's response)
// — updated every frame by diagnosticsPipelineModule().onUpdate.
// Used by captureMultiImageFrames() to build "imageN_data" for each
// photo in multi-image mode. Already in the {x,y,z,qx,qy,qz,qw}
// format that field requires (see comment in multiset-client.js about
// the "q" prefix in rotation).
let latestRealityPose = null;

// Last known pose (in the same RHS system we request with
// isRightHanded:true) — used to build the "hintPosition" for the next
// query and speed up/improve relocalization. null until the first
// successful localization.
let lastKnownPosition = null;

// true only after the first successfully applied correction. Gates
// two things that don't make sense before that: the automatic
// relocalization on tracking loss (above) and the start of the
// periodic relocalization timer (below) — both assume there's already
// a real reference pose, not the default SLAM startup position.
let hasLocalizedOnce = false;

// ─── Periodic background relocalization ─────────────────────────────────────
// Direct replica of startBackgroundLocalization() from the official SDK
// (@multisetai/vps): confirmed in its bundle that it runs a setInterval
// that calls localizeFrame() (if no localization is in progress), with
// the interval clamped between 10s and 180s (default 30s for maps).
// Meaning: the SDK "that works perfectly" also doesn't rely solely on
// native tracking (ARCore/ARKit) to stay anchored — it also corrects
// periodically against the VPS. We replicate the same pattern here
// because our main gap versus that version was precisely having no
// re-anchoring after the initial manual tap.
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

// Background auto-relocalization: can no longer be paused (button was removed).
// To disable it in the future, comment out the call to startBackgroundLocalization().
const bgLocalizationPaused = false;

cubeScaleSlider.addEventListener('input', (e) => {
  const scale = parseFloat(e.target.value);
  arCube.setAttribute('scale', `${scale} ${scale} ${scale}`);
});

// ─── Confidence threshold ───────────────────────────────────────────────────
// Another technique confirmed in the official SDK bundle:
// confidenceCheck + confidenceThreshold, clamped between 0.2 and 0.8
// (default 0.5) — if the returned pose has less confidence than the
// threshold, the SDK discards it instead of applying it. Makes sense
// here: in real-world tests we saw confidences from 43% to 85%;
// applying an unfiltered 43% correction can introduce a worse position
// than the current one (and appear as "the cube jumped somewhere
// weird"), especially from an automatic background relocalization where
// the user isn't deliberately pointing the camera at the map.
const CONFIDENCE_THRESHOLD_MIN = 0.2;
const CONFIDENCE_THRESHOLD_MAX = 0.8;
const CONFIDENCE_THRESHOLD_DEFAULT = 0.5;
const CONFIDENCE_THRESHOLD = Math.max(
  CONFIDENCE_THRESHOLD_MIN,
  Math.min(Number(import.meta.env.VITE_MULTISET_CONFIDENCE_THRESHOLD) || CONFIDENCE_THRESHOLD_DEFAULT, CONFIDENCE_THRESHOLD_MAX)
);

// ─── Map anchoring (replaces updateCameraProjectionMatrix) ──────────────────
// Previously, each MultiSet correction reset the origin/orientation of
// the ENTIRE XR8 tracking system via updateCameraProjectionMatrix
// ({origin, facing}) — a hard jump of the whole world, with no
// documented "continuous" version or transition. We migrated to the
// pattern used by the official Immersal module (immersal-module.js:
// localize() + its "pointCloud"): the native XR8 tracking is NEVER
// touched. Instead, we compute the transformation between the tracker
// pose at the exact moment of capture (trackerSpace,
// sceneEl.camera.matrixWorld) and the pose returned by the VPS relative
// to the map origin (cloudSpace) — that transformation is what gets
// applied to #map-anchor so the CONTENT aligns with the real world,
// without resetting any SLAM state. Tracking continues its normal
// course between corrections, so there's no accumulated drift from
// losing the origin anchor — only the content gets realigned.
function trackerFromCloudSpace(position, rotation, trackerSpace) {
  const cloudPosition = new THREE.Vector3(position.x, position.y, position.z);
  const cloudRotation = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
  const cloudSpace = new THREE.Matrix4().compose(cloudPosition, cloudRotation, new THREE.Vector3(1, 1, 1));
  return new THREE.Matrix4().multiplyMatrices(trackerSpace, cloudSpace.clone().invert());
}

// PoseFilter (see src/pose-filter.js, port from Immersal): instead of
// applying each raw correction, we accumulate it in a history of 8
// samples that averages and discards outliers — absorbs a single bad
// localization without it appearing as a jump.
const poseFilter = new PoseFilter(THREE);

// "Direct warp" thresholds — if the filtered correction implies moving
// more than 5m or rotating more than 20° from where the anchor
// currently is, we assume it's a real realignment (not noise) and jump
// directly instead of interpolating for seconds toward the correct
// place. Same values Immersal uses (warpThresholdDistSq/
// warpThresholdCosAngle in immersal-module.js) — there's no empirical
// basis of our own yet for this particular map, but they're a
// reasonable starting point.
const WARP_THRESHOLD_DIST_SQ = 5.0 * 5.0;
const WARP_THRESHOLD_COS_ANGLE = Math.cos((20.0 * Math.PI) / 180.0);
// Exponential smoothing factor per frame (not per fixed time as before)
// — same default value Immersal uses in its own onRender.
const POSE_SMOOTHING = 0.025;

let poseLoopRunning = false;
let prevPoseLoopTime = performance.now();

// Continuous loop (not a one-shot tween for a single correction):
// chases poseFilter.position/rotation frame by frame, just like
// Immersal's onRender. Starts once, with the first successful
// localization (see applyLocalizationResult), and keeps running
// indefinitely — so a background correction (periodic relocalization)
// also gets smoothed, not just the initial manual tap.
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

// Entry point called from captureAndLocalize() with each accepted pose
// (already passed the confidence threshold). trackerSpace is the
// snapshot taken BEFORE sending the photo — see the comment in
// captureAndLocalize about why we can't use the tracker's current
// pose at the time the response arrives.
function applyLocalizationResult(pose, trackerSpace) {
  const m = trackerFromCloudSpace(pose.position, pose.rotation, trackerSpace);
  poseFilter.refinePose(m);

  if (poseFilter.sampleCount() === 1) {
    // First real correction: only now does the anchor have a
    // meaningful transformation (before it was identity, pointing
    // in an arbitrary direction per the SLAM's arbitrary origin) —
    // we show it and start the loop that chases it frame by frame.
    mapAnchorEl.setAttribute('visible', true);
    startPoseFilterLoop();
  }
}

// REVISION (2026-07-20): hintPosition must be in LHS (Unity), the same
// system the official doc "Find Hint Coordinates" uses (coordinates
// (x,y,z) taken directly on the map mesh, relative to the origin).
// We request the pose in RHS (isRightHanded:true, the system
// THREE.js/A-Frame uses), so we need to convert before sending.
// For a POSITION vector (no rotation) the standard RHS↔LHS conversion
// is inverting a single axis — here Z — which is mathematically
// correct and sufficient (unlike a rotation matrix/quaternion, where
// you'd also need to invert that same component in the rotation;
// doesn't apply here because hintPosition has no orientation).
// What REMAINS unconfirmed 1:1 is whether the axis MultiSet calls "Z"
// in its internal LHS is the same as our "Z" in RHS before the flip
// (there could also be an axis swap or a mapping rotation, not just a
// sign flip) — MultiSet's docs never need to clarify this because
// their supported flow (web portal / MapPointInspector in Unity)
// obtains the coordinates already in LHS, never starting from RHS.
// TODO: validate on device: capture a known point with MultiSet's
// official method (portal or Unity) and compare against the value this
// function produces for the same physical position.
function toHintPositionString(rhsPosition) {
  return `${rhsPosition.x},${rhsPosition.y},${-rhsPosition.z}`;
}

// ─── GPS proximity check ───────────────────────────────────────────────────
// Before spending quota on a real vps/map/query request, we compare the
// user's GPS position against the map's georeferenced point (see
// getMapLocation() in multiset-client.js). If they're far away, we
// don't even try to scan: we tell them directly where they need to go.
//
// NOTE: navigator.geolocation accuracy in a browser can range from a
// few meters (pure GPS, outdoors) to 50-100+ meters (indoor, via
// wifi/cell triangulation) — exactly the typical scenario for an indoor
// VPS. The threshold below is generous on purpose to avoid blocking
// valid attempts due to GPS error; this is a best-effort client-side
// check, not a hard proximity guarantee — the real "does it match or
// not" check is still done by MultiSet against the image.
const MAX_DISTANCE_METERS = Number(import.meta.env.VITE_MAX_DISTANCE_METERS) || 150;

function getCurrentPosition(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation not available in this browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      reject,
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10000 }
    );
  });
}

// Haversine formula — distance in meters between two lat/lon points.
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
  // Defensive: the button is already disabled until
  // everReachedNormalTracking (see
  // diagnosticsPipelineModule().onStart/onUpdate), this is just to
  // not blindly trust the DOM attribute if something overwrote it.
  if (!everReachedNormalTracking) return;
  checkProximityAndRequestLocalization();
});

async function checkProximityAndRequestLocalization() {
  // In mock mode there's no real georeferenced map to compare against —
  // skip the check to not break the local testing flow.
  if (MOCK_ENABLED) {
    captureAndLocalize();
    return;
  }

  checkingLocation = true;
  setStatus('Checking your location...');

  try {
    const [userPos, mapPos] = await Promise.all([getCurrentPosition(), getMapLocation()]);
    const distance = distanceMeters(userPos, mapPos);

    if (distance > MAX_DISTANCE_METERS) {
      confidenceBadge.style.display = 'none';
      setStatus(
        'Could not scan because you are too far from the location. '
        + `Please move closer to (${mapPos.lat.toFixed(6)}, ${mapPos.lon.toFixed(6)}).`
      );
      return;
    }
  } catch (err) {
    // Fail-open: if we can't confirm the location (GPS denied, no
    // signal, map not georeferenced, etc.) we let the attempt through
    // instead of blocking the entire feature for a check that's an
    // extra, not the core of the flow.
    console.warn('Could not verify GPS proximity, attempting localization anyway:', err);
  } finally {
    checkingLocation = false;
  }

  await captureAndLocalize();
}

// Captures MULTI_IMAGE_COUNT frames in burst for
// /vps/map/multi-image-query, each paired with the LOCAL tracking pose
// (localPose, snapshot taken inside captureImageFrame) at the exact
// instant of that capture. MULTI_IMAGE_DELAY_MS between shots: without
// any gap, two consecutive captures may read the same
// cameraData.buffer if CameraPixelArray hasn't ticked a new frame in
// between — the wait gives the pipeline time, and also gives margin
// for the user to slightly move the phone between shots (the point of
// sending multiple photos is to cover different angles/detail, not to
// repeat the same image 4 times).
const MULTI_IMAGE_COUNT = 4; // the real schema only defines image1..image4, not up to 6 as the text says
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
  btnLocalize.textContent = 'Localizing...';

  // Snapshot of the tracker pose AT THIS INSTANT, before any await —
  // it's the real camera pose at the moment the photo we send to
  // MultiSet is taken. If instead we read sceneEl.camera.matrixWorld
  // only when the server response arrives (hundreds of ms later), the
  // phone has already moved and trackerFromCloudSpace would compute
  // the transformation against the wrong pose — same principle as
  // "const trackerSpace = camera.matrixWorld.clone()" in Immersal.
  const trackerSpaceAtCapture = sceneEl.camera.matrixWorld.clone();

  try {
    let pose;
    const hintPosition = lastKnownPosition ? toHintPositionString(lastKnownPosition) : undefined;

    if (MULTI_IMAGE_ENABLED) {
      setStatus(MOCK_ENABLED ? 'Localizing with MultiSet (mock, multi-image)...' : 'Capturing 4 photos for MultiSet...');

      const frames = await captureMultiImageFrames();
      const { width, height, intrinsics } = frames[0];

      setStatus(MOCK_ENABLED ? 'Localizing with MultiSet (mock)...' : 'Localizing with MultiSet (multi-image)...');
      pose = await queryMultiImageLocalization(frames, intrinsics, { width, height }, hintPosition);
    } else {
      setStatus(MOCK_ENABLED ? 'Localizing with MultiSet (mock)...' : 'Localizing with MultiSet...');

      const frame = await captureImageFrame();
      pose = await queryLocalization(frame.jpegBuffer, frame.intrinsics, { width: frame.width, height: frame.height }, hintPosition);
    }

    if (!pose) {
      confidenceBadge.style.display = 'none';
      setStatus('MultiSet: could not localize in this frame (map not recognized).');
      return;
    }

    // NOT GeoPose/WGS84: confirmed against the official docs
    // (multiset.gitbook.io/multiset/basics/localization/geopose-support)
    // that it requires passing "convertToGeoCoordinates: true" in the
    // /vps/map/query request — multiset-client.js doesn't send it,
    // so the response already comes in local Cartesian coordinates:
    // position {x,y,z} and rotation as a real quaternion {x,y,z,w}
    // (confirmed with the doc's text example). No Euler angles, no
    // matrix, no conversion needed — can be passed directly to
    // trackerFromCloudSpace().
    //
    // Defensive validation: if the response came with
    // position/rotation in an unexpected shape (missing field, not
    // numeric), we prefer to throw a visible error here rather than
    // composing a matrix with undefined/NaN — that would produce a
    // silent mispositioning, very hard to diagnose later.
    const hasVector3 = (v) => v && ['x', 'y', 'z'].every((k) => typeof v[k] === 'number');
    const hasQuaternion = (q) => q && ['w', 'x', 'y', 'z'].every((k) => typeof q[k] === 'number');
    if (!hasVector3(pose.position) || !hasQuaternion(pose.rotation)) {
      throw new Error(`MultiSet returned position/rotation with unexpected shape: ${JSON.stringify(pose)}`);
    }

    const confidencePct = Math.round((pose.confidence || 0) * 100);

    // Confidence threshold (see CONFIDENCE_THRESHOLD above): a
    // low-confidence pose can be worse than not correcting — we
    // discard it before feeding it into the PoseFilter instead of
    // applying it blindly.
    if ((pose.confidence || 0) < CONFIDENCE_THRESHOLD) {
      console.warn(`⚠️ MultiSet returned confidence ${confidencePct}% (minimum ${Math.round(CONFIDENCE_THRESHOLD * 100)}%) — correction discarded.`);
      setStatus(`MultiSet: confidence too low (${confidencePct}%), keeping current position.`);
      confidenceBadge.textContent = `⚠️ Low confidence (${confidencePct}%) — discarded`;
      confidenceBadge.style.display = 'block';
      return;
    }

    // Dedicated log in a flat line (not a nested object) on purpose:
    // this is what needs to be compared between two "Localize" taps
    // done from different physical positions to diagnose a cube
    // jump/teleport — the message below ("MultiSet recognized the
    // map") only showed the % confidence at a glance, with the full
    // pose hidden inside an object that in the visual console (eruda)
    // or in copied text was less easy to read/diff at a glance.
    console.log(
      `📌 MultiSet pose — position: x=${pose.position.x.toFixed(4)}, y=${pose.position.y.toFixed(4)}, z=${pose.position.z.toFixed(4)} `
      + `| rotation: w=${pose.rotation.w.toFixed(4)}, x=${pose.rotation.x.toFixed(4)}, y=${pose.rotation.y.toFixed(4)}, z=${pose.rotation.z.toFixed(4)} `
      + `| confidence=${confidencePct}%`
    );

    // applyLocalizationResult feeds the correction into the
    // PoseFilter (absorbs outliers) and realigns #map-anchor — not
    // XR8's tracking. The first time, it makes the anchor visible
    // and starts the loop that chases it frame by frame (see
    // comment next to poseFilterTick above).
    applyLocalizationResult(pose, trackerSpaceAtCapture);
    lastKnownPosition = { x: pose.position.x, y: pose.position.y, z: pose.position.z }; // for the next query's hintPosition

    // Starting from the first real correction (not the default
    // startup one), we enable the automatic relocalization on
    // tracking loss (see diagnosticsPipelineModule) and start
    // the periodic relocalization timer — replicating
    // startBackgroundLocalization() from the official SDK.
    if (!hasLocalizedOnce) {
      hasLocalizedOnce = true;
      if (!bgLocalizationPaused) startBackgroundLocalization();
    }

    // Visible confirmation that MultiSet recognized the imported
    // map (poseFound:true) — independent of whether the cube looks
    // right or not, this confirms the VPS effectively detected it.
    console.log(`✅ MultiSet recognized the map — confidence ${confidencePct}%`, pose);
    setStatus(`MultiSet: localized (${confidencePct}%)`);
    confidenceBadge.textContent = `✅ Map recognized (${confidencePct}%)`;
    confidenceBadge.style.display = 'block';
  } catch (err) {
    // We don't use showError here: a localization failure isn't
    // fatal for the AR session (XR8 tracking keeps running),
    // unlike a pipeline error. We just display it as diagnostics.
    console.error('Error querying MultiSet:', err);
    setStatus('MultiSet error: ' + err.message);
    confidenceBadge.style.display = 'none';
  } finally {
    localizing = false;
    btnLocalize.disabled = false;
    btnLocalize.textContent = '📍 Localize';
  }
}

// ─── Engine startup ──────────────────────────────────────────────────────────
// XR8Promise resolves as soon as the xr.js script (loaded in index.html)
// finishes initializing window.XR8. Unlike the manual Three.js version,
// we no longer call XR8.run() ourselves — xrweb/xrconfig handles that
// internally, triggered by the "runreality" event (see below). Here we
// only register our custom modules (which have no declarative equivalent
// in A-Frame) and get everything ready for when the user taps the button.
XR8Promise.then((XR8) => {
  xr8Instance = XR8; // needed by triggerFallback() to pause the engine

  // Compatibility check BEFORE showing "Start AR". Same config
  // (allowedDevices: mobile-and-headsets) that xrconfig uses by
  // default — if the device/browser doesn't meet it, we don't even
  // show the button: we go directly to the fallback (3D viewer), the
  // same screen we already use when the GPU can't handle SLAM.
  // Without this, a user on an unsupported browser would tap "Start
  // AR" and only then see something fail.
  const isCompatible = XR8.XrDevice.isDeviceBrowserCompatible({
    allowedDevices: XR8.XrConfig.device().MOBILE_AND_HEADSETS,
  });
  if (!isCompatible) {
    triggerFallback('Device or browser not compatible with AR');
    return;
  }

  // We add the xrconfig/xrweb/xrextras-* attributes HERE, not in
  // the static HTML — see the long comment next to <a-scene> in
  // index.html. Summary: if these attributes are already in the HTML
  // when xr.js loads, "AFRAME.registerComponent('xrweb', ...)"
  // fires the component init immediately, at a point where xr.js
  // hasn't finished assigning the "XR8" global that the component
  // needs — throws "ReferenceError: XR8 is not defined". Setting
  // them here, with XR8Promise already resolved, guarantees that
  // global is complete.
  //
  // "landing-page" is NOT added on purpose: it's the component that
  // shows the "Scan or visit ... to continue" screen with 8th Wall
  // branding (confirmed in public/landing-page/landing-page.js —
  // defaultParameters has that text hardcoded). We already cover its
  // real function (warning if the device is incompatible) above,
  // with our own UI.
  sceneEl.setAttribute('xrconfig', 'delayRun: true');
  sceneEl.setAttribute('xrweb', 'scale: absolute');
  sceneEl.setAttribute('xrextras-runtime-error', '');

  // CameraPixelArray DOES need to be added manually — unlike
  // CanvasScreenshot (which XR8's A-Frame integration adds
  // automatically), this is not part of the default set xrweb sets
  // up: it's opt-in because it has a real CPU cost (reads back the
  // GPU texture every frame).
  // Config (2026-07-24, copied from the reference WebXR SDK —
  // @multisetai/vps/dist/three/index.js, function N() — which sends
  // color JPEG and confirmed to be the one with the best tracking/
  // recognition against MultiSet):
  //   - Without "luminance": default false → RGBA color, not 1
  //     channel (we previously sent grayscale, an unvalidated
  //     assumption — see the TODO that was in multiset-client.js).
  //   - "maxDimension: 1280": GPU downsample (before reading pixels)
  //     to the same limit the reference SDK uses
  //     (Math.min(1, 1280/Math.max(w,h)) in its function N()) —
  //     avoids sending unnecessarily heavy 4K+ photos for visual
  //     matching.
  // Registered BEFORE our module so that, although not strictly
  // necessary since onProcessGpu runs completely for all modules
  // before onUpdate starts for any of them, the order matches what
  // the Immersal example itself uses (from which the rest of the
  // capture pipeline comes).
  XR8.addCameraPipelineModule(XR8.CameraPixelArray.pipelineModule({ maxDimension: 1280 }));
  XR8.addCameraPipelineModule(diagnosticsPipelineModule());

  btnStartAR.disabled = false;

  // IMPORTANT: we emit "runreality" synchronously inside the click
  // handler, without any await before it, to preserve the user
  // gesture — otherwise iOS Safari may silently deny the camera
  // permission (same principle we already applied with XR8.run() in
  // the previous version). xrconfig must have "delayRun: true" in
  // the HTML so the camera doesn't start automatically when the
  // scene loads — see comment next to <a-scene> in index.html.
  btnStartAR.addEventListener('click', () => {
    btnStartAR.disabled = true;
    btnStartAR.textContent = 'Starting...';

    // The GPS permission is requested HERE (user gesture from "Start
    // AR"), not in "Localize" — we don't block the AR start waiting
    // for the response, just trigger the browser prompt now. This
    // way, when the user later taps "Localize", the permission is
    // already resolved and getCurrentPosition() in
    // checkProximityAndRequestLocalization() doesn't interrupt that
    // flow with a prompt mid-way.
    if (!MOCK_ENABLED && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(() => { }, () => { }, { enableHighAccuracy: true, timeout: 8000 });
    }

    try {
      sceneEl.emit('runreality');
      landing.style.display = 'none';
      btnDebugToggleView.style.display = 'block';
      setStatus('Loading engine and camera...');
    } catch (error) {
      showError('Could not start XR8:', error);
    }
  });
}).catch((err) => {
  console.error('Could not load the 8th Wall engine:', err);
  setStatus('Error loading the 8th Wall engine.');
});
