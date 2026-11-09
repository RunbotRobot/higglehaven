// #2718 (sub-issue of #2715, "[Tracking] In-app 'Submit Feedback' bug
// reports with automatic rendering-state capture"): the Submit Feedback
// modal.
//
// #3302: the entry point is now "Send feedback" in the Settings modal (every
// mode), not a Shop-only HUD pill -- owner decision 2026-11-09: utilities
// live in Settings so the world stays uncluttered. settings/modal.js imports
// openFeedbackModal and passes the Settings modal as `returnTo`, so closing
// this modal puts the person back in Settings (the stacked-modal pattern
// #2515 fixed for the upload/seller pair). The ring buffer #2717 feeds
// (./renderStateBuffer.js) is now populated from Shop's, Build's and Sell's
// per-frame callbacks, and the payload carries `mode`.
//
// Self-contained: looks its own modal elements up directly and wires its
// own listeners here.
//
// On submit, posts a multipart body (screenshot blob + a JSON metadata
// field) to POST /api/feedback/bug-report via api.js's
// submitFeedbackBugReport. handleFeedbackSubmit below surfaces a failed
// request as an ordinary inline error, not a crash.
import { openModalA11y, closeModalA11y } from '../ui/modal.js';
import { scene, camera, renderer, canvas } from '../world/scene.js';
import { getRenderStateBuffer, clearRenderStateBuffer } from './renderStateBuffer.js';
import { submitFeedbackBugReport } from '../api.js';
import { currentAuthUser } from '../account/auth.js';
import { currentMode } from '../world/state.js';
import { getRecentVisibleMessages } from '../ui/visibleMessages.js';

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

// #2731: captureShopScreenshotBlob's canvas.toBlob is real async work (PNG
// encoding), so openFeedbackModal's own continuation can still be pending
// when the user closes the modal (or reopens it, starting a second,
// overlapping capture) -- same out-of-order-resolution hazard
// shop/avatar.js's own shopAvatarEquipToken guards against. Without this,
// a capture that resolves after close resurrects feedbackScreenshotBlob/Url
// post-close and leaks the object URL forever (closeFeedbackModal already
// ran and won't run again for it, and the next openFeedbackModal overwrites
// feedbackScreenshotUrl without revoking the orphaned one). Incremented by
// both openFeedbackModal and closeFeedbackModal so either one supersedes an
// in-flight capture from the other.
let feedbackModalToken = 0;

// #3302: the modal this one was opened over (Settings), re-armed on close so
// Settings is not left on screen but untrapped -- same bug class #2515 fixed
// for the upload/seller pair. Null when opened from anywhere else.
let feedbackReturnTo = null;

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

export async function openFeedbackModal(returnTo = null) {
  feedbackReturnTo = returnTo;
  const myToken = ++feedbackModalToken;
  setFeedbackStatus('', false);
  feedbackDescriptionEl.value = '';
  feedbackScreenshotPreview.removeAttribute('src');
  // Hidden until there is a picture to show: an <img> with no src paints a
  // broken-image icon and its alt text, which is what the builder saw while
  // the capture was still running (or for good if it produced nothing).
  feedbackScreenshotPreview.hidden = true;
  feedbackModalEl.classList.add('visible');
  openModalA11y(feedbackModalEl, closeFeedbackModal);
  let screenshotBlob;
  try {
    screenshotBlob = await captureShopScreenshotBlob();
  } catch (err) {
    // A screenshot failing to capture (e.g. toBlob unsupported) shouldn't
    // block submitting a report at all -- the ring buffer + WebGL/browser
    // info below are still useful on their own.
    console.warn('Could not capture a feedback screenshot:', err);
    screenshotBlob = null;
  }
  if (myToken !== feedbackModalToken) return; // superseded by a close or a newer open while capturing
  feedbackScreenshotBlob = screenshotBlob;
  if (feedbackScreenshotBlob) {
    feedbackScreenshotUrl = URL.createObjectURL(feedbackScreenshotBlob);
    feedbackScreenshotPreview.src = feedbackScreenshotUrl;
    feedbackScreenshotPreview.hidden = false;
  } else {
    // A missing screenshot is a quiet gap otherwise: the report would go without one
    // and the person would never know (No silent loss). Still sendable.
    setFeedbackStatus("We couldn't capture a picture of your view, but you can still send your report.", false);
  }
}

function closeFeedbackModal() {
  feedbackModalToken++;
  feedbackModalEl.classList.remove('visible');
  feedbackScreenshotPreview.hidden = true;
  closeModalA11y(feedbackModalEl);
  if (feedbackScreenshotUrl) {
    URL.revokeObjectURL(feedbackScreenshotUrl);
    feedbackScreenshotUrl = null;
  }
  feedbackScreenshotBlob = null;
  const returnTo = feedbackReturnTo;
  feedbackReturnTo = null;
  if (returnTo?.el?.classList.contains('visible')) openModalA11y(returnTo.el, returnTo.close);
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
    // #3302: which mode the person was in when they sent the report.
    mode: currentMode,
    renderStateBuffer: getRenderStateBuffer(),
    submittedAt: new Date().toISOString(),
    userId: currentAuthUser?.userId ?? null,
    // added for #3303 -- the owner hit a Group refusal on a phone, could not
    // copy it, and had to describe it from memory; the exact error/refusal
    // words the person was last shown make the next report diagnosable even
    // when they could not copy them. Remove only once #3303 is closed and no
    // report has needed it for a while.
    recentUserVisibleMessages: getRecentVisibleMessages(),
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

feedbackCloseBtn.addEventListener('click', closeFeedbackModal);
feedbackCancelBtn.addEventListener('click', closeFeedbackModal);
feedbackSubmitBtn.addEventListener('click', handleFeedbackSubmit);
