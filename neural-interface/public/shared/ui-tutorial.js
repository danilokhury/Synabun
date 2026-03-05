// ═══════════════════════════════════════════
// TUTORIAL RUNTIME — Animated onboarding system
// ═══════════════════════════════════════════
//
// Orchestrates the tutorial experience. Two rendering modes:
//
// 1. WHITEBOARD MODE (whiteboardMode: true) — renders hand-drawn animated
//    elements directly on the whiteboard in focus mode. No modals, no overlays.
//    Steps use a render() function for full control.
//
// 2. OVERLAY MODE (legacy) — renders an SVG overlay + card panel on top of
//    the app. Used for non-whiteboard steps or when restarting from ? button.
//
// Drawing is delegated to ui-tutorial-draw.js.
// Step content comes from ui-tutorial-steps.js.

import { storage, flushStorage } from './storage.js';
import { emit, on } from './state.js';
import { KEYS } from './constants.js';
import { registerMenuItem, registerHelpSection } from './registry.js';
import { loadIfaceConfig, saveIfaceConfig, applyIfaceConfig } from './ui-settings.js';
import { TUTORIAL_STEPS } from './ui-tutorial-steps.js';
import {
  createAnimatedArrow,
  createWobblyCircle,
  createHandDrawnUnderline,
  typewriterText,
  handwrittenLabel,
  createDoodle,
  createSpotlight,
  resolveTargetRect,
  resolveAnchorPoint,
  resolveRelativePoint,
  AnimationSequencer,
} from './ui-tutorial-draw.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// ── Internal state ─────────────────────────
let _steps = [];
let _currentStep = -1;
let _active = false;
let _sequencer = null;
let _resizeTimer = null;
let _keyHandler = null;

// Overlay mode state (legacy)
let _spotlight = null;
let _overlayEl = null;
let _cardEl = null;
let _pulseEl = null;
let _annotationGroup = null;
let _advanceCleanup = null;
let _domAnnotationLayer = null;

// Whiteboard mode state
let _wbTutorialSvg = null;
let _wbTutorialDom = null;
let _isFocusModeForced = false;
let _originalVizEnabled = true;
let _isSkipAnimating = false;
let _clickInterceptor = null;
let _adhdMessageTimer = null;


// ═══════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════

export function initTutorial() {
  _steps = TUTORIAL_STEPS;
  if (!_steps || _steps.length === 0) return;

  // Register menu item to restart
  registerMenuItem({
    menu: 'Help',
    order: 50,
    type: 'item',
    id: 'restart-tutorial',
    label: 'Restart Tutorial',
    init(el) { el.addEventListener('click', () => startTutorial(true)); },
  });

  // Register help section
  registerHelpSection({
    order: 95,
    html: `<div class="help-section">
      <div class="help-section-title">Tutorial</div>
      <div class="help-row"><span class="help-desc">Restart the guided tour from Help &rarr; Restart Tutorial</span></div>
    </div>`,
  });

  // Auto-start only on true first visit (never seen tutorial at all)
  const completed = storage.getItem(KEYS.TUTORIAL_COMPLETED);
  const skipped = storage.getItem(KEYS.TUTORIAL_SKIPPED);
  const started = storage.getItem(KEYS.TUTORIAL_STARTED);

  if (!completed && !skipped && !started) {
    // Force focus mode BEFORE boot() reads the config
    _forceFocusForTutorial();

    on('data-loaded', () => {
      setTimeout(() => {
        if (!_active) startTutorial(false);
      }, 500);
    });
  }
}


// ═══════════════════════════════════════════
// FOCUS MODE FORCING
// ═══════════════════════════════════════════

function _forceFocusForTutorial() {
  const cfg = loadIfaceConfig();
  _originalVizEnabled = cfg.visualizationEnabled !== false;
  if (cfg.visualizationEnabled !== false) {
    cfg.visualizationEnabled = false;
    saveIfaceConfig(cfg);
    _isFocusModeForced = true;
  }
}

function _ensureFocusMode() {
  const staticBg = document.getElementById('static-bg');
  if (!staticBg?.classList.contains('visible')) {
    document.getElementById('titlebar-viz-toggle')?.click();
  }
}

function _restoreFocusMode() {
  if (_isFocusModeForced) {
    const cfg = loadIfaceConfig();
    cfg.visualizationEnabled = _originalVizEnabled;
    saveIfaceConfig(cfg);
    applyIfaceConfig(cfg);
    _isFocusModeForced = false;
  }
}


// ═══════════════════════════════════════════
// WHITEBOARD LAYER MANAGEMENT
// ═══════════════════════════════════════════

function _createWhiteboardLayers() {
  if (_wbTutorialSvg) return;

  // Append to document.body with z-index above the titlebar (50000)
  // so tutorial annotations render above dropdowns and navbar elements.
  // Coordinates are viewport-based, so placement is identical.

  // SVG layer for hand-drawn elements
  _wbTutorialSvg = document.createElementNS(SVG_NS, 'svg');
  _wbTutorialSvg.id = 'wb-tutorial';
  _wbTutorialSvg.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:60000;';
  document.body.appendChild(_wbTutorialSvg);

  // DOM layer for clickable interactive elements
  _wbTutorialDom = document.createElement('div');
  _wbTutorialDom.id = 'wb-tutorial-dom';
  _wbTutorialDom.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:60001;';
  document.body.appendChild(_wbTutorialDom);
}

function _destroyWhiteboardLayers() {
  if (_wbTutorialSvg) { _wbTutorialSvg.remove(); _wbTutorialSvg = null; }
  if (_wbTutorialDom) { _wbTutorialDom.remove(); _wbTutorialDom = null; }
}


// ═══════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════

function _hideStaticBgLogo(hide) {
  const logo = document.querySelector('#static-bg .static-bg-logo');
  const breathe = document.querySelector('#static-bg .focus-breathe');
  if (logo) logo.classList.toggle('tutorial-hidden', hide);
  if (breathe) breathe.classList.toggle('tutorial-hidden', hide);
}

function _hideWhiteboardToolbar(hide) {
  const toolbar = document.getElementById('wb-toolbar');
  if (toolbar) toolbar.classList.toggle('tutorial-hidden', hide);
}

function _hideTopControls(hide) {
  const top = document.getElementById('topright-controls');
  if (top) top.classList.toggle('tutorial-hidden', hide);
}


// ═══════════════════════════════════════════
// HAND-DRAWN BUTTON (DOM, Caveat font, clickable)
// ═══════════════════════════════════════════

function _createHandDrawnButton(container, text, { x, y, color = 'rgba(255,255,255,0.5)', fontSize = 26, onClick }) {
  const el = document.createElement('div');
  el.className = 'wb-tutorial-btn';
  el.textContent = text;
  el.style.cssText = `
    position: absolute;
    left: ${x}px;
    top: ${y}px;
    transform: translate(-50%, 0);
    font-family: 'Caveat', cursive;
    font-size: ${fontSize}px;
    color: ${color};
    pointer-events: auto;
    opacity: 0;
  `;
  container.appendChild(el);

  // Animate in
  requestAnimationFrame(() => { el.style.opacity = '1'; });

  // Hover effect
  el.addEventListener('mouseenter', () => {
    el.style.color = 'rgba(255, 255, 255, 0.85)';
    el.style.transform = 'translate(-50%, 0) scale(1.08)';
  });
  el.addEventListener('mouseleave', () => {
    el.style.color = color;
    el.style.transform = 'translate(-50%, 0) scale(1)';
  });

  el.addEventListener('click', onClick);
  return el;
}


// ═══════════════════════════════════════════
// START / STOP
// ═══════════════════════════════════════════

export function startTutorial(fromBeginning = false) {
  if (_active) destroyTutorial();

  _active = true;
  _currentStep = 0;

  // Always start from step 0 — no mid-tutorial resume on refresh
  if (fromBeginning) {
    storage.removeItem(KEYS.TUTORIAL_COMPLETED);
    storage.removeItem(KEYS.TUTORIAL_SKIPPED);
    storage.removeItem(KEYS.TUTORIAL_STARTED);
    storage.removeItem(KEYS.ONBOARDING_EXPLORE);
    storage.removeItem(KEYS.ONBOARDING_CLI);
    storage.removeItem(KEYS.ONBOARDING_MODEL);
    storage.removeItem(KEYS.ONBOARDING_PROJECT);
  }
  storage.removeItem(KEYS.TUTORIAL_STEP);

  // Mark that tutorial has been seen — refresh mid-tutorial won't re-trigger
  // Flush immediately (bypass 500ms debounce) so the flag survives a quick refresh
  storage.setItem(KEYS.TUTORIAL_STARTED, 'true');
  flushStorage();

  const step = _steps[_currentStep];

  if (step?.whiteboardMode) {
    // Whiteboard-based rendering
    _ensureFocusMode();
    _hideStaticBgLogo(true);
    _hideWhiteboardToolbar(true);
    _hideTopControls(true);
    _createWhiteboardLayers();
  } else {
    // Legacy overlay + card rendering
    _createOverlay();
    _createCard();
  }

  _installKeyHandler();
  _installClickInterceptor();
  _installResizeHandler();

  emit('tutorial:start');
  _renderStep(_currentStep);
}

function skipTutorial() {
  storage.setItem(KEYS.TUTORIAL_SKIPPED, 'true');
  storage.removeItem(KEYS.TUTORIAL_STEP);
  _exitStep(() => {
    _restoreFocusMode();
    destroyTutorial();
    emit('tutorial:skip');
  });
}

function completeTutorial() {
  storage.setItem(KEYS.TUTORIAL_COMPLETED, 'true');
  storage.removeItem(KEYS.TUTORIAL_STEP);
  _exitStep(() => _animateCompletion());
}

async function _animateCompletion() {
  // ── 1. Fade out tutorial layers ──
  if (_wbTutorialSvg) {
    _wbTutorialSvg.style.transition = 'opacity 0.6s ease';
    _wbTutorialSvg.style.opacity = '0';
  }
  if (_wbTutorialDom) {
    _wbTutorialDom.style.transition = 'opacity 0.6s ease';
    _wbTutorialDom.style.opacity = '0';
  }

  await new Promise(r => setTimeout(r, 400));

  // ── 2. Reveal logo with scale + fade entrance ──
  const logo = document.querySelector('#static-bg .static-bg-logo');
  const breathe = document.querySelector('#static-bg .focus-breathe');

  if (logo) {
    logo.style.transition = 'none';
    logo.style.transform = 'translate(-50%, -50%) scale(0.7)';
    logo.style.opacity = '0';
    logo.classList.remove('tutorial-hidden');
    logo.offsetHeight; // force reflow
    logo.style.transition = 'opacity 0.8s cubic-bezier(0.22, 1, 0.36, 1), transform 0.8s cubic-bezier(0.22, 1, 0.36, 1)';
    logo.style.opacity = '';  // back to CSS default (0.18)
    logo.style.transform = '';
  }
  if (breathe) {
    breathe.style.transition = 'none';
    breathe.style.opacity = '0';
    breathe.classList.remove('tutorial-hidden');
    breathe.offsetHeight;
    breathe.style.transition = 'opacity 1.2s ease 0.3s';
    breathe.style.opacity = '';
  }

  // ── 3. Slide toolbar in from left (staggered) ──
  const toolbar = document.getElementById('wb-toolbar');
  if (toolbar) {
    toolbar.style.transition = 'none';
    toolbar.style.transform = 'translateX(-30px)';
    toolbar.style.opacity = '0';
    toolbar.style.pointerEvents = '';
    toolbar.classList.remove('tutorial-hidden');
    toolbar.offsetHeight;
    toolbar.style.transition = 'opacity 0.5s ease 0.2s, transform 0.5s cubic-bezier(0.22, 1, 0.36, 1) 0.2s';
    toolbar.style.opacity = '';
    toolbar.style.transform = '';
  }

  // ── 4. Slide top controls in from top (staggered) ──
  const topControls = document.getElementById('topright-controls');
  if (topControls) {
    topControls.style.transition = 'none';
    topControls.style.transform = 'translateY(-20px)';
    topControls.style.opacity = '0';
    topControls.classList.remove('tutorial-hidden');
    topControls.offsetHeight;
    topControls.style.transition = 'opacity 0.5s ease 0.35s, transform 0.5s cubic-bezier(0.22, 1, 0.36, 1) 0.35s';
    topControls.style.opacity = '';
    topControls.style.transform = '';
  }

  // ── 5. Wait for all transitions, then clean up ──
  await new Promise(r => setTimeout(r, 1000));

  // Clean inline styles
  if (logo) { logo.style.transition = ''; logo.style.transform = ''; logo.style.opacity = ''; }
  if (breathe) { breathe.style.transition = ''; breathe.style.opacity = ''; }
  if (toolbar) { toolbar.style.transition = ''; toolbar.style.transform = ''; toolbar.style.opacity = ''; }
  if (topControls) { topControls.style.transition = ''; topControls.style.transform = ''; topControls.style.opacity = ''; }

  _restoreFocusMode();
  destroyTutorial();
  emit('tutorial:complete');
}

function destroyTutorial() {
  _active = false;
  _currentStep = -1;
  _isSkipAnimating = false;
  if (_sequencer) { _sequencer.cancel(); _sequencer = null; }

  // Overlay mode cleanup
  if (_spotlight) { _spotlight.destroy(); _spotlight = null; }
  if (_overlayEl) { _overlayEl.remove(); _overlayEl = null; }
  if (_cardEl) { _cardEl.remove(); _cardEl = null; }
  if (_pulseEl) { _pulseEl.remove(); _pulseEl = null; }
  if (_advanceCleanup) { _advanceCleanup(); _advanceCleanup = null; }
  if (_domAnnotationLayer) { _domAnnotationLayer.remove(); _domAnnotationLayer = null; }

  // Whiteboard mode cleanup
  _destroyWhiteboardLayers();
  _hideStaticBgLogo(false);
  _hideWhiteboardToolbar(false);
  _hideTopControls(false);

  // Close any open menubar dropdowns opened by tutorial
  const openMenu = document.querySelector('.menubar-item.open');
  if (openMenu) openMenu.classList.remove('open');

  // Handlers
  if (_keyHandler) { document.removeEventListener('keydown', _keyHandler, true); _keyHandler = null; }
  _removeClickInterceptor();
  if (_resizeTimer) { clearTimeout(_resizeTimer); _resizeTimer = null; }
  window.removeEventListener('resize', _onResize);
}


// ═══════════════════════════════════════════
// STEP NAVIGATION
// ═══════════════════════════════════════════

function nextStep() {
  if (_isSkipAnimating) return;
  if (_currentStep >= _steps.length - 1) {
    completeTutorial();
    return;
  }
  _exitStep(() => {
    _currentStep++;
    emit('tutorial:step', { index: _currentStep, id: _steps[_currentStep].id });
    _renderStep(_currentStep);
  });
}

function prevStep() {
  if (_isSkipAnimating) return;
  if (_currentStep <= 0) return;
  _exitStep(() => {
    _currentStep--;
    emit('tutorial:step', { index: _currentStep, id: _steps[_currentStep].id });
    _renderStep(_currentStep);
  });
}

function goToStep(targetIndex) {
  if (_isSkipAnimating) return;
  if (targetIndex < 0 || targetIndex >= _steps.length) return;
  _exitStep(() => {
    _currentStep = targetIndex;
    emit('tutorial:step', { index: _currentStep, id: _steps[_currentStep].id });
    _renderStep(_currentStep);
  });
}


// ═══════════════════════════════════════════
// STEP RENDERING (ROUTER)
// ═══════════════════════════════════════════

function _renderStep(index) {
  const step = _steps[index];
  if (!step) return;

  step.onEnter?.({ nextStep, prevStep, skipTutorial, emit });

  if (step.whiteboardMode) {
    _renderWhiteboardStep(step, index);
  } else {
    // Legacy overlay mode
    if (step.focusModeRequired) {
      const staticBg = document.getElementById('static-bg');
      if (!staticBg?.classList.contains('visible')) {
        document.getElementById('titlebar-viz-toggle')?.click();
        setTimeout(() => _renderOverlayStep(step, index), 600);
        return;
      }
    }
    _renderOverlayStep(step, index);
  }
}


// ═══════════════════════════════════════════
// WHITEBOARD MODE RENDERING
// ═══════════════════════════════════════════

function _renderWhiteboardStep(step, index) {
  // Clean previous step content
  if (_sequencer) { _sequencer.cancel(); _sequencer = null; }
  if (_wbTutorialSvg) _wbTutorialSvg.innerHTML = '';
  if (_wbTutorialDom) _wbTutorialDom.innerHTML = '';

  if (!step.render) return;

  _sequencer = new AnimationSequencer();
  step.render({
    svg: _wbTutorialSvg,
    dom: _wbTutorialDom,
    seq: _sequencer,
    vw: window.innerWidth,
    vh: window.innerHeight,
    nextStep,
    prevStep,
    goToStep,
    skipTutorial,
    onSkipWithArrow: _animateSkipArrow,
    createButton: _createHandDrawnButton,
  });
  _sequencer.play();
}


// ═══════════════════════════════════════════
// SKIP ARROW ANIMATION ("I'll be here")
// ═══════════════════════════════════════════

async function _animateSkipArrow() {
  if (_isSkipAnimating) return;
  _isSkipAnimating = true;

  // Clear current content
  if (_sequencer) { _sequencer.cancel(); _sequencer = null; }
  if (_wbTutorialSvg) _wbTutorialSvg.innerHTML = '';
  if (_wbTutorialDom) _wbTutorialDom.innerHTML = '';

  // Find the ? button
  const tutBtn = document.getElementById('titlebar-tutorial-btn');
  const btnRect = tutBtn?.getBoundingClientRect();
  if (!btnRect || !_wbTutorialSvg) { _finishSkip(); return; }

  // Arrow tip: below the ? button, clear of the toolbar
  const toX = btnRect.left + btnRect.width / 2;
  const toY = btnRect.bottom + 16;

  // Arrow start: well below the toolbar so nothing overlaps
  const fromX = toX - 50;
  const fromY = toY + 120;

  const seq = new AnimationSequencer();
  _sequencer = seq;

  // "I'll be here" handwritten text — appears first, then arrow points up from it
  seq.add(() => handwrittenLabel(_wbTutorialSvg, "I'll be here", {
    x: fromX - 30,
    y: fromY + 28,
    color: 'rgba(255, 255, 255, 0.45)',
    fontSize: 20,
    duration: 500,
  }), 200);

  // Small curvy arrow from text area up to the ? button
  seq.add(() => createAnimatedArrow(_wbTutorialSvg, {
    from: { x: fromX, y: fromY },
    to: { x: toX, y: toY },
    color: 'rgba(255, 255, 255, 0.35)',
    wobbleSeed: 'skip-arrow',
    duration: 600,
    delay: 0,
  }), 300);

  // Tiny sparkle near the button
  seq.add(() => createDoodle(_wbTutorialSvg, 'sparkle', {
    x: toX + 18,
    y: toY + 6,
    scale: 0.6,
    color: 'rgba(255, 255, 255, 0.3)',
    duration: 400,
  }), 400);

  await seq.play();

  // Hold for 2 seconds so the user can read it
  await new Promise(r => setTimeout(r, 2000));
  if (!_active) return;

  // ── Graceful exit: fade arrow, fade in logo, slide in toolbar ──

  // 1. Fade out the tutorial drawings
  if (_wbTutorialSvg) {
    _wbTutorialSvg.style.transition = 'opacity 0.5s ease';
    _wbTutorialSvg.style.opacity = '0';
  }
  if (_wbTutorialDom) {
    _wbTutorialDom.style.transition = 'opacity 0.5s ease';
    _wbTutorialDom.style.opacity = '0';
  }

  await new Promise(r => setTimeout(r, 300));
  if (!_active) return;

  // 2. Fade in the center logo (remove tutorial-hidden — CSS transition handles fade)
  _hideStaticBgLogo(false);

  // 3. Slide toolbar in from left
  const toolbar = document.getElementById('wb-toolbar');
  if (toolbar) {
    toolbar.style.transition = 'none';
    toolbar.style.transform = 'translateX(-30px)';
    toolbar.style.opacity = '0';
    toolbar.style.pointerEvents = '';
    toolbar.classList.remove('tutorial-hidden');
    toolbar.offsetHeight; // eslint-disable-line no-unused-expressions
    toolbar.style.transition = 'opacity 0.5s ease, transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)';
    toolbar.style.opacity = '';
    toolbar.style.transform = '';
  }

  // 4. Slide top controls in from top
  const topControls = document.getElementById('topright-controls');
  if (topControls) {
    topControls.style.transition = 'none';
    topControls.style.transform = 'translateY(-20px)';
    topControls.style.opacity = '0';
    topControls.classList.remove('tutorial-hidden');
    topControls.offsetHeight; // eslint-disable-line no-unused-expressions
    topControls.style.transition = 'opacity 0.5s ease 0.1s, transform 0.5s cubic-bezier(0.22, 1, 0.36, 1) 0.1s';
    topControls.style.opacity = '';
    topControls.style.transform = '';
  }

  // Wait for transitions to finish
  await new Promise(r => setTimeout(r, 700));
  if (!_active) return;

  // Clean up inline styles
  if (toolbar) {
    toolbar.style.transition = '';
    toolbar.style.transform = '';
    toolbar.style.opacity = '';
  }
  if (topControls) {
    topControls.style.transition = '';
    topControls.style.transform = '';
    topControls.style.opacity = '';
  }

  _finishSkip();
}

function _finishSkip() {
  storage.setItem(KEYS.TUTORIAL_SKIPPED, 'true');
  storage.removeItem(KEYS.TUTORIAL_STEP);
  _hideStaticBgLogo(false);
  _hideWhiteboardToolbar(false);
  _hideTopControls(false);
  _restoreFocusMode();
  destroyTutorial();
  emit('tutorial:skip');
}


// ═══════════════════════════════════════════
// OVERLAY MODE RENDERING (LEGACY)
// ═══════════════════════════════════════════

function _createOverlay() {
  if (_overlayEl) return;
  _overlayEl = document.createElementNS(SVG_NS, 'svg');
  _overlayEl.id = 'tutorial-overlay';
  _overlayEl.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
  document.body.appendChild(_overlayEl);
}

function _createCard() {
  if (_cardEl) return;
  _cardEl = document.createElement('div');
  _cardEl.className = 'tutorial-card';
  _cardEl.innerHTML = `
    <div class="tutorial-title"></div>
    <div class="tutorial-body"></div>
    <div class="tutorial-nav">
      <button class="tutorial-nav-btn tutorial-btn-back">Back</button>
      <span class="tutorial-step-counter"></span>
      <button class="tutorial-nav-btn primary tutorial-btn-next">Next</button>
    </div>
    <span class="tutorial-skip">Skip tutorial</span>
  `;
  document.body.appendChild(_cardEl);
  _cardEl.querySelector('.tutorial-btn-next').addEventListener('click', nextStep);
  _cardEl.querySelector('.tutorial-btn-back').addEventListener('click', prevStep);
  _cardEl.querySelector('.tutorial-skip').addEventListener('click', skipTutorial);
}

function _renderOverlayStep(step, index) {
  const targetRect = resolveTargetRect(step.target);

  // Spotlight
  if (_spotlight) { _spotlight.destroy(); _spotlight = null; }
  if (step.spotlight !== false) {
    _spotlight = createSpotlight(_overlayEl, targetRect, {
      padding: step.spotlightPadding || 16,
      wobbleSeed: step.id + '-spot',
    });
  }

  // Card
  _updateCard(step, index, targetRect);

  // Annotations
  if (_annotationGroup) _annotationGroup.remove();
  _annotationGroup = document.createElementNS(SVG_NS, 'g');
  _annotationGroup.classList.add('tutorial-annotations');
  _overlayEl.appendChild(_annotationGroup);

  if (_sequencer) _sequencer.cancel();
  _sequencer = new AnimationSequencer();
  for (const ann of (step.annotations || [])) {
    _sequencer.add(() => _renderAnnotation(ann, step, targetRect), ann.delay || 0);
  }
  _sequencer.play();

  _setupAdvanceTrigger(step, targetRect);
  _updatePulseRing(step, targetRect);
}

function _updateCard(step, index, targetRect) {
  _cardEl.querySelector('.tutorial-title').textContent = step.title || '';
  _cardEl.querySelector('.tutorial-body').textContent = step.body || '';
  _cardEl.querySelector('.tutorial-step-counter').textContent = `${index + 1} of ${_steps.length}`;
  _cardEl.querySelector('.tutorial-btn-back').style.display = index === 0 ? 'none' : '';
  _cardEl.querySelector('.tutorial-btn-next').textContent = index === _steps.length - 1 ? 'Finish' : 'Next';

  _positionCard(step.cardPosition || 'auto', targetRect);
  _cardEl.classList.remove('exit');
  requestAnimationFrame(() => { _cardEl.classList.add('visible'); });
}

function _positionCard(position, targetRect) {
  const cardW = 380;
  const cardH = _cardEl.offsetHeight || 200;
  const margin = 24;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left, top;

  if (position === 'center' || !targetRect) {
    left = (vw - cardW) / 2;
    top = (vh - cardH) / 2;
  } else if (position === 'auto') {
    const cx = targetRect.left + targetRect.width / 2;
    const cy = targetRect.top + targetRect.height / 2;
    left = cx < vw / 2
      ? Math.min(targetRect.right + margin + 20, vw - cardW - margin)
      : Math.max(targetRect.left - cardW - margin - 20, margin);
    top = cy < vh / 2
      ? Math.max(targetRect.bottom + margin, margin)
      : Math.max(targetRect.top - cardH - margin, margin);
    left = Math.max(margin, Math.min(left, vw - cardW - margin));
    top = Math.max(margin, Math.min(top, vh - cardH - margin));
  } else {
    const positions = {
      'top-left': { left: margin, top: margin },
      'top-right': { left: vw - cardW - margin, top: margin },
      'bottom-left': { left: margin, top: vh - cardH - margin },
      'bottom-right': { left: vw - cardW - margin, top: vh - cardH - margin },
      'top-center': { left: (vw - cardW) / 2, top: margin },
      'bottom-center': { left: (vw - cardW) / 2, top: vh - cardH - margin },
    };
    const pos = positions[position] || positions['top-right'];
    left = pos.left;
    top = pos.top;
  }
  _cardEl.style.left = `${left}px`;
  _cardEl.style.top = `${top}px`;
}

function _renderAnnotation(ann, step, targetRect) {
  const svg = _annotationGroup;

  switch (ann.type) {
    case 'arrow': {
      const from = _resolveAnnotationPoint(ann.from, targetRect);
      const to = _resolveAnnotationPoint(ann.to, targetRect, step.targetAnchor);
      if (!from || !to) return null;
      return createAnimatedArrow(svg, {
        from, to,
        color: ann.color || 'rgba(255,255,255,0.35)',
        wobbleSeed: step.id + '-arrow',
        duration: ann.duration || 800,
        arrowheadSize: ann.arrowheadSize || 14,
      });
    }
    case 'circle': {
      const rect = ann.target === 'inherit' ? targetRect : resolveTargetRect(ann.target);
      if (!rect) return null;
      return createWobblyCircle(svg, rect, {
        color: ann.color || 'rgba(255,255,255,0.3)',
        padding: ann.padding || 12,
        wobbleSeed: step.id + '-circle',
        duration: ann.duration || 700,
      });
    }
    case 'underline': {
      const rect = ann.target === 'inherit' ? targetRect : resolveTargetRect(ann.target);
      if (!rect) return null;
      return createHandDrawnUnderline(svg, rect, {
        color: ann.color || 'rgba(255,255,255,0.3)',
        wobbleSeed: step.id + '-underline',
        duration: ann.duration || 500,
      });
    }
    case 'text': {
      if (ann.style === 'handwritten') {
        const pos = _resolveAnnotationPoint(ann.position, targetRect);
        if (!pos) return null;
        return handwrittenLabel(svg, ann.text, {
          x: pos.x, y: pos.y,
          color: ann.color || 'rgba(255,255,255,0.4)',
          fontSize: ann.fontSize || 18,
          textAnchor: ann.textAnchor,
          duration: ann.duration || 400,
        });
      }
      const container = _getOrCreateDomAnnotationLayer();
      return typewriterText(container, ann.text, {
        charDelay: ann.charDelay || 35,
        font: ann.font || 'sans',
        color: ann.color || 'rgba(255,255,255,0.6)',
      });
    }
    case 'doodle': {
      const pos = _resolveAnnotationPoint(ann.position, targetRect);
      if (!pos) return null;
      return createDoodle(svg, ann.doodleId, {
        x: pos.x, y: pos.y,
        scale: ann.scale || 1,
        color: ann.color || 'rgba(255,255,255,0.3)',
        duration: ann.duration || 600,
      });
    }
    default:
      return null;
  }
}

function _resolveAnnotationPoint(value, targetRect, defaultAnchor) {
  if (!value) return null;
  if (value === 'target') {
    if (!targetRect) return null;
    return resolveAnchorPoint(targetRect, defaultAnchor || 'center');
  }
  if (typeof value === 'object' && 'x' in value && 'y' in value) {
    if (value.x <= 1 && value.y <= 1 && value.x >= 0 && value.y >= 0) {
      return resolveRelativePoint(value);
    }
    return value;
  }
  return null;
}

function _getOrCreateDomAnnotationLayer() {
  if (_domAnnotationLayer && _domAnnotationLayer.parentNode) return _domAnnotationLayer;
  _domAnnotationLayer = document.createElement('div');
  _domAnnotationLayer.style.cssText = 'position:fixed;inset:0;z-index:9998;pointer-events:none;display:flex;align-items:center;justify-content:center;padding:20px;';
  document.body.appendChild(_domAnnotationLayer);
  return _domAnnotationLayer;
}

function _setupAdvanceTrigger(step, targetRect) {
  if (_advanceCleanup) { _advanceCleanup(); _advanceCleanup = null; }
  const advanceOn = step.advanceOn || 'click';

  if (advanceOn === 'click') return;

  if (advanceOn === 'target-click' && step.target) {
    const targetEl = document.querySelector(step.target);
    if (targetEl) {
      const handler = () => nextStep();
      targetEl.addEventListener('click', handler, { once: true });
      _advanceCleanup = () => targetEl.removeEventListener('click', handler);
    }
    return;
  }
  if (advanceOn.startsWith('key:')) {
    const key = advanceOn.slice(4).toLowerCase();
    const handler = (e) => {
      if (e.key.toLowerCase() === key) { nextStep(); document.removeEventListener('keydown', handler); }
    };
    document.addEventListener('keydown', handler);
    _advanceCleanup = () => document.removeEventListener('keydown', handler);
    return;
  }
  if (advanceOn.startsWith('auto:')) {
    const ms = parseInt(advanceOn.slice(5), 10) || 3000;
    const timer = setTimeout(nextStep, ms);
    _advanceCleanup = () => clearTimeout(timer);
  }
}

function _updatePulseRing(step, targetRect) {
  if (_pulseEl) { _pulseEl.remove(); _pulseEl = null; }
  if (step.advanceOn === 'target-click' && targetRect) {
    _pulseEl = document.createElement('div');
    _pulseEl.className = 'tutorial-pulse-ring';
    _pulseEl.style.left = `${targetRect.left - 4}px`;
    _pulseEl.style.top = `${targetRect.top - 4}px`;
    _pulseEl.style.width = `${targetRect.width + 8}px`;
    _pulseEl.style.height = `${targetRect.height + 8}px`;
    document.body.appendChild(_pulseEl);
  }
}


// ═══════════════════════════════════════════
// STEP EXIT
// ═══════════════════════════════════════════

function _exitStep(callback) {
  const step = _steps[_currentStep];
  if (step) step.onExit?.({ nextStep, prevStep, skipTutorial, emit });

  if (_sequencer) { _sequencer.cancel(); _sequencer = null; }
  if (_advanceCleanup) { _advanceCleanup(); _advanceCleanup = null; }
  if (_pulseEl) { _pulseEl.remove(); _pulseEl = null; }

  if (step?.whiteboardMode) {
    // Whiteboard mode: just clear the layers
    if (_wbTutorialSvg) _wbTutorialSvg.innerHTML = '';
    if (_wbTutorialDom) _wbTutorialDom.innerHTML = '';
    callback?.();
  } else {
    // Overlay mode: fade out annotations + card
    if (_annotationGroup) {
      _annotationGroup.style.transition = 'opacity 0.2s ease';
      _annotationGroup.style.opacity = '0';
    }
    if (_cardEl) {
      _cardEl.classList.remove('visible');
      _cardEl.classList.add('exit');
    }
    if (_spotlight) {
      _spotlight.fadeOut(() => {
        if (_spotlight) { _spotlight.destroy(); _spotlight = null; }
      });
    }
    if (_domAnnotationLayer) {
      _domAnnotationLayer.remove();
      _domAnnotationLayer = null;
    }
    setTimeout(() => {
      if (_annotationGroup) { _annotationGroup.remove(); _annotationGroup = null; }
      callback?.();
    }, 300);
  }
}


// ═══════════════════════════════════════════
// KEYBOARD HANDLER
// ═══════════════════════════════════════════

function _installKeyHandler() {
  if (_keyHandler) return;
  _keyHandler = (e) => {
    if (!_active) return;

    const step = _steps[_currentStep];

    // Block V key during whiteboard steps to prevent exiting focus mode
    if ((e.key === 'v' || e.key === 'V') && step?.whiteboardMode) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    if (e.key === 'Escape') {
      e.stopPropagation();
      if (_isSkipAnimating) return;
      if (step?.id === 'welcome' && step?.whiteboardMode) {
        _animateSkipArrow();
      } else if (_currentStep <= 5) {
        skipTutorial();
      } else {
        prevStep();
      }
      return;
    }

    if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation();
      e.preventDefault();
      nextStep();
      return;
    }

    if (e.key === 'ArrowLeft') {
      e.stopPropagation();
      prevStep();
    }
  };
  document.addEventListener('keydown', _keyHandler, true);
}


// ═══════════════════════════════════════════
// TOOLBAR CLICK INTERCEPTOR (ADHD protection)
// ═══════════════════════════════════════════

const _interceptedBtnIds = [
  'titlebar-viz-toggle',
  'titlebar-fullscreen-btn',
];

function _installClickInterceptor() {
  if (_clickInterceptor) return;
  _clickInterceptor = (e) => {
    if (!_active || _isSkipAnimating) return;
    const step = _steps[_currentStep];
    if (!step?.whiteboardMode) return;

    // Check if the click target is one of the intercepted buttons or menu items
    const btn = e.target.closest('#titlebar-viz-toggle, #titlebar-fullscreen-btn, #topright-keybinds-btn, .menubar-dropdown .menu-item, .menubar-label');
    if (!btn) return;

    e.stopPropagation();
    e.preventDefault();
    _showAdhdMessage();
  };
  document.addEventListener('click', _clickInterceptor, true);
}

function _removeClickInterceptor() {
  if (_clickInterceptor) {
    document.removeEventListener('click', _clickInterceptor, true);
    _clickInterceptor = null;
  }
  if (_adhdMessageTimer) {
    clearTimeout(_adhdMessageTimer);
    _adhdMessageTimer = null;
  }
}

function _showAdhdMessage() {
  if (!_wbTutorialSvg || !_wbTutorialDom) return;

  // Cancel the step's sequencer so pending tasks don't re-add elements
  if (_sequencer) { _sequencer.cancel(); _sequencer = null; }

  // Save current step content and replace with ADHD message
  const savedSvg = _wbTutorialSvg.innerHTML;
  const savedDom = _wbTutorialDom.innerHTML;
  _wbTutorialSvg.innerHTML = '';
  _wbTutorialDom.innerHTML = '';

  if (_adhdMessageTimer) clearTimeout(_adhdMessageTimer);

  const seq = new AnimationSequencer();
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2 - 20;

  seq.add(() => handwrittenLabel(_wbTutorialSvg, 'Wait bro... gee', {
    x: cx, y: cy - 10,
    textAnchor: 'middle',
    color: 'rgba(255, 255, 255, 0.55)',
    fontSize: 28, duration: 400,
  }), 100);

  seq.add(() => handwrittenLabel(_wbTutorialSvg, 'You can click shit later.', {
    x: cx, y: cy + 30,
    textAnchor: 'middle',
    color: 'rgba(255, 255, 255, 0.35)',
    fontSize: 20, duration: 400,
  }), 400);

  // OK button to dismiss and return to the step
  seq.add(() => {
    const okEl = _createHandDrawnButton(_wbTutorialDom, 'Ok', {
      x: cx, y: cy + 100, fontSize: 24,
      color: 'rgba(255, 255, 255, 0.45)',
      onClick: () => {
        if (!_wbTutorialSvg || !_wbTutorialDom || !_active) return;
        _wbTutorialSvg.innerHTML = '';
        _wbTutorialDom.innerHTML = '';
        const step = _steps[_currentStep];
        if (step) _renderWhiteboardStep(step, _currentStep);
      },
    });
    return { destroy() { okEl.remove(); } };
  }, 700);

  seq.play();
}


// ═══════════════════════════════════════════
// RESIZE HANDLER
// ═══════════════════════════════════════════

function _onResize() {
  if (_resizeTimer) clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (!_active || _currentStep < 0) return;

    const step = _steps[_currentStep];
    if (!step) return;

    if (step.whiteboardMode && !_isSkipAnimating) {
      // Re-render the whiteboard step to re-center
      _renderWhiteboardStep(step, _currentStep);
    } else if (!step.whiteboardMode) {
      if (_overlayEl) {
        _overlayEl.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
      }
      const targetRect = resolveTargetRect(step.target);
      if (_spotlight) _spotlight.update(targetRect);
      if (_cardEl) _positionCard(step.cardPosition || 'auto', targetRect);
      if (_pulseEl && targetRect) {
        _pulseEl.style.left = `${targetRect.left - 4}px`;
        _pulseEl.style.top = `${targetRect.top - 4}px`;
        _pulseEl.style.width = `${targetRect.width + 8}px`;
        _pulseEl.style.height = `${targetRect.height + 8}px`;
      }
    }
  }, 300);
}

function _installResizeHandler() {
  window.addEventListener('resize', _onResize);
}
