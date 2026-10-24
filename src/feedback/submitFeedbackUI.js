// #2718 (sub-issue of #2715, "[Tracking] In-app 'Submit Feedback' bug
// reports with automatic rendering-state capture"): the "Submit Feedback"
// button + modal. Shop mode only for now -- #2715's own body says "Shop
// mode at minimum; consider global placement," and the ring buffer #2717
// feeds (./renderStateBuffer.js) is itself only ever populated from Shop
// mode's own per-frame loop (src/shop/mode.js) today -- a report submitted
// anywhere else would have an empty buffer and nothing useful for the
// "what rendered in the preceding ~60s" half of this feature. Extending
// capture (and this button) to Build/Sell mode is a separate, later scope
// decision, not folded in here.
//
// A fully self-contained leaf, unlike most of Shop mode's other DOM
// buttons (shopFlyBtn and friends, still owned/exported by src/main.js,
// pending #2500/#2504's larger split) -- this is brand-new markup with no
// main.js legacy to respect, so it looks its own elements up directly and
// wires its own listeners here (same shape src/ui/modal.js's own top-level
// document keydown listener already uses), rather than routing through
// main.js the way the older shop/*.js leaves do. shopFeedbackBtn is
// exported only so src/shop/mode.js's enterShopMode can reveal it
// (classList.add('visible')) the same moment it reveals shopFlyBtn/
// shopVerticalControlsEl, once the avatar is actually ready.
//
// On submit, posts a multipart body (screenshot blob + a JSON metadata
// field) to POST /api/feedback/bug-report via api.js's
// submitFeedbackBugReport -- the Worker endpoint #2719 adds. Built ahead
// of that landing, per #2715's own "can be built against a stubbed/
// mocked... endpoint in the meantime if landing out of order" -- until
// #2719 merges, submitting here 404s; handleFeedbackSubmit below surfaces
// that as an ordinary inline error, not a crash.
import { openModalA11y, closeModalA11y } from '../ui/modal.js';
import { scene, camera, renderer, canvas } from '../world/scene.js';
import { getRenderStateBuffer, clearRenderStateBuffer } from './renderStateBuffer.js';
import { submitFeedbackBugReport } from '../api.js';
import { currentAuthUser } from '../account/auth.js';

export const shopFeedbackBtn = document.getElementById('shop-feedback-btn');

const feedbackModalEl = document.getElementById('feedback-modal');
const feedbackCloseBtn = document.getElementById('feedback-close-btn');
const feedbackCancelBtn = document.getElementById('feedback-cancel-btn');
const feedbackSubmitBtn = document.getElementById('feedback-submit-btn');
const feedbackScreenshotPreview = document.getElementById('feedback-screenshot-preview');
const feedbackDescriptionEl = document.getElementById('feedback-description');
const feedbackStatusEl = document.getElementById('feedback-status');

// Set by openFeedbackModal, read by handleFeedbackSubmit, revoked by
// closeFeedbackModal -- create-on-open/revoke-on-close, so a captured
// screenshot never outlives the one modal session it was taken for.
let feedbackScreenshotBlob = null;
let feedbackScreenshotUrl = null;

// #2718's own body: "the actual GPU/driver string via
// WEBGL_debug_renderer_info ... gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
// / UNMASKED_VENDOR_WEBGL" -- not every browser/context exposes this
// extension (it can be disabled for privacy), so this degrades to nulls
// rather than throwing.
function webglDebugInfo() {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  if (!ext) return { renderer: null, vendor: null };
  return {
    renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
    vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),
  };
}

// canvas.toBlob reads whatever is currently sitting in the drawing
// buffer -- with the shared renderer's own default preserveDrawingBuffer:
// false (src/world/scene.js's `new THREE.WebGLRenderer({ canvas,
// antialias: true })`), that buffer is free to already be stale/cleared
// by the time an async click handler actually runs, since the browser can
// clear it any time after the last animate() frame composited. Forcing
// one fresh, synchronous render right here -- with no await between it
// and the toBlob() call below -- guarantees the buffer holds exactly this
// frame rather than whatever the last composite happened to leave behind.
function captureShopScreenshotBlob() {
  renderer.render(scene, camera);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function setFeedbackStatus(message, isError) {
  feedbackStatusEl.textContent = message;
  feedbackStatusEl.classList.toggle('error', !!isError);
}

async function openFeedbackModal() {
  setFeedbackStatus('', false);
  feedbackDescriptionEl.value = '';
  feedbackScreenshotPreview.removeAttribute('src');
  feedbackModalEl.classList.add('visible');
  openModalA11y(feedbackModalEl, closeFeedbackModal);
  try {
    feedbackScreenshotBlob = await captureShopScreenshotBlob();
  } catch (err) {
    // A screenshot failing to capture (e.g. toBlob unsupported) shouldn't
    // block submitting a report at all -- the ring buffer + WebGL/browser
    // info below are still useful on their own.
    console.warn('Could not capture a feedback screenshot:', err);
    feedbackScreenshotBlob = null;
  }
  if (feedbackScreenshotBlob) {
    feedbackScreenshotUrl = URL.createObjectURL(feedbackScreenshotBlob);
    feedbackScreenshotPreview.src = feedbackScreenshotUrl;
  }
}

function closeFeedbackModal() {
  feedbackModalEl.classList.remove('visible');
  closeModalA11y(feedbackModalEl);
  if (feedbackScreenshotUrl) {
    URL.revokeObjectURL(feedbackScreenshotUrl);
    feedbackScreenshotUrl = null;
  }
  feedbackScreenshotBlob = null;
}

async function handleFeedbackSubmit() {
  const description = feedbackDescriptionEl.value.trim();
  const { renderer: webglRenderer, vendor: webglVendor } = webglDebugInfo();
  // #2715's own field list ("camera/avatar position + orientation,
  // relevant shader uniforms ..., frame timestamp") is exactly what
  // getRenderStateBuffer() already returns -- no need to re-shape it here.
  const metadata = {
    description: description || undefined,
    webglRenderer,
    webglVendor,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    renderStateBuffer: getRenderStateBuffer(),
    submittedAt: new Date().toISOString(),
    userId: currentAuthUser?.userId ?? null,
  };
  const form = new FormData();
  if (feedbackScreenshotBlob) form.append('screenshot', feedbackScreenshotBlob, 'feedback.png');
  form.append('metadata', JSON.stringify(metadata));
  feedbackSubmitBtn.disabled = true;
  feedbackCancelBtn.disabled = true;
  setFeedbackStatus('Submitting…', false);
  try {
    await submitFeedbackBugReport(form);
    // #2715's own "discarded if never submitted" framing for the ring
    // buffer -- a successful submit is the one case worth acting on.
    clearRenderStateBuffer();
    setFeedbackStatus('Thanks! Your feedback was submitted.', false);
    setTimeout(closeFeedbackModal, 1200);
  } catch (err) {
    setFeedbackStatus(err.message || "Couldn't submit that feedback.", true);
  } finally {
    feedbackSubmitBtn.disabled = false;
    feedbackCancelBtn.disabled = false;
  }
}

shopFeedbackBtn.addEventListener('click', openFeedbackModal);
feedbackCloseBtn.addEventListener('click', closeFeedbackModal);
feedbackCancelBtn.addEventListener('click', closeFeedbackModal);
feedbackSubmitBtn.addEventListener('click', handleFeedbackSubmit);
