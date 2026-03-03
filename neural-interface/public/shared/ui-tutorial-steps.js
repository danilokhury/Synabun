// ═══════════════════════════════════════════
// TUTORIAL STEP DEFINITIONS
// ═══════════════════════════════════════════
//
// Each step describes what to show and how.
// Steps with whiteboardMode: true render directly on the whiteboard
// using a render() function. Others use the legacy overlay+card mode.

import {
  handwrittenLabel,
  createDoodle,
  createHandDrawnUnderline,
  createAnimatedArrow,
  createWobblyCircle,
} from './ui-tutorial-draw.js';
import { emit } from './state.js';

export const TUTORIAL_STEPS = [
  // ── Step 0: Welcome (whiteboard mode) ─────────────────────
  {
    id: 'welcome',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, onSkipWithArrow, createButton }) {
      const cx = vw / 2;
      const cy = vh / 2 - 40;

      // 1. Hand-drawn question text (centered, Caveat, large)
      seq.add(() => handwrittenLabel(svg, 'Do you want to see the tutorial?', {
        x: cx,
        y: cy,
        color: 'rgba(255, 255, 255, 0.55)',
        fontSize: 36,
        textAnchor: 'middle',
        duration: 400,
      }), 200);

      // 2. Decorative sparkle doodles
      seq.add(() => createDoodle(svg, 'sparkle', {
        x: cx - 240,
        y: cy - 60,
        scale: 1.2,
        color: 'rgba(255, 255, 255, 0.3)',
        duration: 350,
      }), 200);

      seq.add(() => createDoodle(svg, 'sparkle', {
        x: cx + 210,
        y: cy + 20,
        scale: 0.9,
        color: 'rgba(255, 255, 255, 0.3)',
        duration: 350,
      }), 200);

      // 3. Interactive Yes / No buttons
      seq.add(() => {
        const btnY = cy + 50;
        const gap = 80;

        const yesEl = createButton(dom, 'Yes', {
          x: cx - gap,
          y: btnY,
          color: 'rgba(255, 255, 255, 0.5)',
          fontSize: 28,
          onClick: () => nextStep(),
        });

        const noEl = createButton(dom, 'No', {
          x: cx + gap,
          y: btnY,
          color: 'rgba(255, 255, 255, 0.5)',
          fontSize: 28,
          onClick: () => onSkipWithArrow(),
        });

        // Draw hand-drawn underlines after buttons paint
        setTimeout(() => {
          const yesRect = yesEl.getBoundingClientRect();
          const noRect = noEl.getBoundingClientRect();

          createHandDrawnUnderline(svg, yesRect, {
            color: 'rgba(255, 255, 255, 0.22)',
            wobbleSeed: 'yes-underline',
            duration: 250,
            offset: 2,
          });
          createHandDrawnUnderline(svg, noRect, {
            color: 'rgba(255, 255, 255, 0.22)',
            wobbleSeed: 'no-underline',
            duration: 250,
            offset: 2,
          });
        }, 100);

        return {
          destroy() { yesEl.remove(); noEl.remove(); },
        };
      }, 200);
    },
  },

  // ── Step 1: Focus Mode ──────────────────────────────────
  {
    id: 'explain-focus',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const btn = document.getElementById('titlebar-viz-toggle');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      // Everything near the button — arrow tip below navbar, text below arrow
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 100;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'focus-circle', duration: 300,
      }), 100);

      // Short ~80px arrow from above text to below button
      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'focus-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Switch between the graph and this whiteboard', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 110;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => skipTutorial(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); endEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 2: Fullscreen ─────────────────────────────────
  {
    id: 'explain-fullscreen',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const btn = document.getElementById('titlebar-fullscreen-btn');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 100;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'fs-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'fs-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Go fullscreen for a clean, distraction-free experience', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 110;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => skipTutorial(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); endEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 3: Help / Tutorial Button ─────────────────────
  {
    id: 'explain-help',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const btn = document.getElementById('titlebar-tutorial-btn');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 100;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'help-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'help-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Click here anytime to restart this tour', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 110;
        const backEl = createButton(dom, 'Back', {
          x: textX - 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 4: Clock ─────────────────────────────────────
  {
    id: 'explain-clock',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      // Hide toolbar if coming back from step 5
      const topControls = document.getElementById('topright-controls');
      if (topControls) topControls.classList.add('tutorial-hidden');

      const clock = document.getElementById('titlebar-clock');
      const rect = clock?.getBoundingClientRect();
      if (!rect) return;

      const clockCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(clockCx, vw - 180));
      const textY = arrowTipY + 80;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 8, wobbleSeed: 'clock-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: clockCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'clock-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Whoa... a clock', {
        x: textX, y: textY,
        textAnchor: 'middle',
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 90;
        const backEl = createButton(dom, 'Back', {
          x: textX - 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 5: Reveal toolbar + explain workspace ─────────
  {
    id: 'explain-toolbar',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      // Slide in the top controls toolbar
      const topControls = document.getElementById('topright-controls');
      if (topControls) {
        topControls.classList.remove('tutorial-hidden');
        topControls.style.transform = 'translateY(-20px)';
        topControls.style.opacity = '0';
        topControls.style.transition = 'transform 0.35s ease, opacity 0.35s ease';
        requestAnimationFrame(() => {
          topControls.style.transform = 'translateY(0)';
          topControls.style.opacity = '1';
        });
      }

      // Point to the workspace indicator
      const wsEl = document.getElementById('ws-indicator');
      const rect = wsEl?.getBoundingClientRect();
      if (!rect) return;

      const wsCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(wsCx, vw - 180));
      const textY = arrowTipY + 80;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 8, wobbleSeed: 'ws-circle', duration: 300,
      }), 300);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: wsCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'ws-arrow', duration: 300,
      }), 200);

      seq.add(() => handwrittenLabel(svg, 'Save and load your whiteboard layouts', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 110;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => skipTutorial(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); endEl.remove(); nextEl.remove(); } };
      }, 200);
    },
  },

  // ── Step 6: Grid snap ─────────────────────────────────
  {
    id: 'explain-grid',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const btn = document.getElementById('ws-grid-toggle');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 80;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'grid-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'grid-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Snap cards to a grid for that tidy look', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 90;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => skipTutorial(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); endEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 7: Trash ─────────────────────────────────────
  {
    id: 'explain-trash',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const btn = document.getElementById('topright-trash-btn');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 80;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'trash-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'trash-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Deleted cards end up here', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 90;
        const backEl = createButton(dom, 'Back', {
          x: textX - 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 8: Keybinds ────────────────────────────────────
  {
    id: 'explain-keybinds',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const btn = document.getElementById('topright-keybinds-btn');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 80;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'kb-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'kb-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Rebind every shortcut to your liking', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 90;
        const backEl = createButton(dom, 'Back', {
          x: textX - 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 9: Share / Invite ─────────────────────────────
  {
    id: 'explain-share',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const btn = document.getElementById('invite-btn');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 80;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'share-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'share-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Invite friends to your whiteboard in real-time', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 90;
        const backEl = createButton(dom, 'Back', {
          x: textX - 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 10: Apps menu ─────────────────────────────────
  {
    id: 'explain-apps',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      // Programmatically open the Apps dropdown
      const menuItem = document.querySelector('.menubar-item[data-menu="apps"]');
      if (menuItem) menuItem.classList.add('open');

      // Force layout so getBoundingClientRect is accurate
      const dropdown = menuItem?.querySelector('.menubar-dropdown');
      if (dropdown) dropdown.offsetHeight; // force reflow
      const ddRect = dropdown?.getBoundingClientRect();
      if (!ddRect || ddRect.width === 0) return;

      // Text below the dropdown, centered on it — clear of navbar and dropdown
      const ddCx = ddRect.left + ddRect.width / 2;
      const textX = Math.max(180, Math.min(ddCx, vw - 180));
      const textY = ddRect.bottom + 60;

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: ddCx, y: ddRect.bottom + 12 },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'apps-arrow', duration: 300,
      }), 100);

      seq.add(() => handwrittenLabel(svg, 'Tools streamed through a virtual terminal from your machine', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 25, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 100;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            prevStep();
          },
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            skipTutorial();
          },
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            nextStep();
          },
        });
        return { destroy() {
          backEl.remove(); endEl.remove(); nextEl.remove();
          if (menuItem) menuItem.classList.remove('open');
        } };
      }, 150);
    },
  },

  // ── Step 11: View menu ─────────────────────────────────
  {
    id: 'explain-view',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      // Close apps dropdown if still open
      const appsMenu = document.querySelector('.menubar-item[data-menu="apps"]');
      if (appsMenu) appsMenu.classList.remove('open');

      const menuItem = document.querySelector('.menubar-item[data-menu="view"]');
      if (menuItem) menuItem.classList.add('open');

      const dropdown = menuItem?.querySelector('.menubar-dropdown');
      if (dropdown) dropdown.offsetHeight;
      const ddRect = dropdown?.getBoundingClientRect();
      if (!ddRect || ddRect.width === 0) return;

      const ddCx = ddRect.left + ddRect.width / 2;
      const textX = Math.max(180, Math.min(ddCx, vw - 180));
      const textY = ddRect.bottom + 60;

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: ddCx, y: ddRect.bottom + 12 },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'view-arrow', duration: 300,
      }), 100);

      seq.add(() => handwrittenLabel(svg, 'Toggle sidebars and panels to customize your layout', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 25, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 100;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            prevStep();
          },
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            skipTutorial();
          },
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            nextStep();
          },
        });
        return { destroy() {
          backEl.remove(); endEl.remove(); nextEl.remove();
          if (menuItem) menuItem.classList.remove('open');
        } };
      }, 150);
    },
  },

  // ── Step 12: Graph menu ───────────────────────────────
  {
    id: 'explain-graph',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const prevMenu = document.querySelector('.menubar-item[data-menu="view"]');
      if (prevMenu) prevMenu.classList.remove('open');

      const menuItem = document.querySelector('.menubar-item[data-menu="graph"]');
      if (menuItem) menuItem.classList.add('open');

      const dropdown = menuItem?.querySelector('.menubar-dropdown');
      if (dropdown) dropdown.offsetHeight;
      const ddRect = dropdown?.getBoundingClientRect();
      if (!ddRect || ddRect.width === 0) return;

      const ddCx = ddRect.left + ddRect.width / 2;
      const textX = Math.max(180, Math.min(ddCx, vw - 180));
      const textY = ddRect.bottom + 60;

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: ddCx, y: ddRect.bottom + 12 },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'graph-arrow', duration: 300,
      }), 100);

      seq.add(() => handwrittenLabel(svg, 'Control how memory connections are displayed on the graph', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 25, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 100;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            prevStep();
          },
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            skipTutorial();
          },
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            nextStep();
          },
        });
        return { destroy() {
          backEl.remove(); endEl.remove(); nextEl.remove();
          if (menuItem) menuItem.classList.remove('open');
        } };
      }, 150);
    },
  },

  // ── Step 13: Skills menu ──────────────────────────────
  {
    id: 'explain-skills',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const prevMenu = document.querySelector('.menubar-item[data-menu="graph"]');
      if (prevMenu) prevMenu.classList.remove('open');

      const menuItem = document.querySelector('.menubar-item[data-menu="skills"]');
      if (menuItem) menuItem.classList.add('open');

      const dropdown = menuItem?.querySelector('.menubar-dropdown');
      if (dropdown) dropdown.offsetHeight;
      const ddRect = dropdown?.getBoundingClientRect();
      if (!ddRect || ddRect.width === 0) return;

      const ddCx = ddRect.left + ddRect.width / 2;
      const textX = Math.max(180, Math.min(ddCx, vw - 180));
      const textY = ddRect.bottom + 60;

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: ddCx, y: ddRect.bottom + 12 },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'skills-arrow', duration: 300,
      }), 100);

      seq.add(() => handwrittenLabel(svg, 'Create reusable AI skills your assistant can execute on demand', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 25, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 100;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            prevStep();
          },
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            skipTutorial();
          },
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            nextStep();
          },
        });
        return { destroy() {
          backEl.remove(); endEl.remove(); nextEl.remove();
          if (menuItem) menuItem.classList.remove('open');
        } };
      }, 150);
    },
  },

  // ── Step 14: Automations menu ─────────────────────────
  {
    id: 'explain-automations',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const prevMenu = document.querySelector('.menubar-item[data-menu="skills"]');
      if (prevMenu) prevMenu.classList.remove('open');

      const menuItem = document.querySelector('.menubar-item[data-menu="automations"]');
      if (menuItem) menuItem.classList.add('open');

      const dropdown = menuItem?.querySelector('.menubar-dropdown');
      if (dropdown) dropdown.offsetHeight;
      const ddRect = dropdown?.getBoundingClientRect();
      if (!ddRect || ddRect.width === 0) return;

      const ddCx = ddRect.left + ddRect.width / 2;
      const textX = Math.max(180, Math.min(ddCx, vw - 180));
      const textY = ddRect.bottom + 60;

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: ddCx, y: ddRect.bottom + 12 },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'auto-arrow', duration: 300,
      }), 100);

      seq.add(() => handwrittenLabel(svg, 'Set up automated workflows triggered by events or schedules', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 25, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 100;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            prevStep();
          },
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            skipTutorial();
          },
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            nextStep();
          },
        });
        return { destroy() {
          backEl.remove(); endEl.remove(); nextEl.remove();
          if (menuItem) menuItem.classList.remove('open');
        } };
      }, 150);
    },
  },

  // ── Step 15: Games menu ───────────────────────────────
  {
    id: 'explain-games',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const prevMenu = document.querySelector('.menubar-item[data-menu="automations"]');
      if (prevMenu) prevMenu.classList.remove('open');

      const menuItem = document.querySelector('.menubar-item[data-menu="games"]');
      if (menuItem) menuItem.classList.add('open');

      const dropdown = menuItem?.querySelector('.menubar-dropdown');
      if (dropdown) dropdown.offsetHeight;
      const ddRect = dropdown?.getBoundingClientRect();
      if (!ddRect || ddRect.width === 0) return;

      const ddCx = ddRect.left + ddRect.width / 2;
      const textX = Math.max(180, Math.min(ddCx, vw - 180));
      const textY = ddRect.bottom + 60;

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: ddCx, y: ddRect.bottom + 12 },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'games-arrow', duration: 300,
      }), 100);

      seq.add(() => handwrittenLabel(svg, 'Take a break... you earned it', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 25, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 100;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            prevStep();
          },
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            skipTutorial();
          },
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            nextStep();
          },
        });
        return { destroy() {
          backEl.remove(); endEl.remove(); nextEl.remove();
          if (menuItem) menuItem.classList.remove('open');
        } };
      }, 150);
    },
  },

  // ── Step 16: Bookmarks menu ───────────────────────────
  {
    id: 'explain-bookmarks',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const prevMenu = document.querySelector('.menubar-item[data-menu="games"]');
      if (prevMenu) prevMenu.classList.remove('open');

      const menuItem = document.querySelector('.menubar-item[data-menu="bookmarks"]');
      if (menuItem) menuItem.classList.add('open');
      emit('bookmarks:render');

      const dropdown = menuItem?.querySelector('.menubar-dropdown');

      seq.add(() => {
        if (dropdown) dropdown.offsetHeight;
        const ddRect = dropdown?.getBoundingClientRect();
        if (!ddRect || ddRect.height === 0) return;

        const ddCx = ddRect.left + ddRect.width / 2;
        const textX = Math.max(180, Math.min(ddCx, vw - 180));
        const textY = ddRect.bottom + 60;

        createAnimatedArrow(svg, {
          from: { x: textX, y: textY - 15 },
          to: { x: ddCx, y: ddRect.bottom + 12 },
          color: 'rgba(255, 255, 255, 0.3)',
          wobbleSeed: 'bm-arrow', duration: 300,
        });

        handwrittenLabel(svg, 'Pin important memories for quick access from anywhere', {
          x: textX, y: textY,
          textAnchor: 'middle', maxWidth: 500,
          color: 'rgba(255, 255, 255, 0.5)',
          fontSize: 25, duration: 300,
        });

        const navY = textY + 100;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            prevStep();
          },
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            skipTutorial();
          },
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            nextStep();
          },
        });
        return { destroy() {
          backEl.remove(); endEl.remove(); nextEl.remove();
          if (menuItem) menuItem.classList.remove('open');
        } };
      }, 300);
    },
  },

  // ── Step 17: Settings button ──────────────────────────
  {
    id: 'explain-settings',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      // Close bookmarks dropdown
      const prevMenu = document.querySelector('.menubar-item[data-menu="bookmarks"]');
      if (prevMenu) prevMenu.classList.remove('open');

      const btn = document.getElementById('menubar-settings-btn');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 80;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'settings-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'settings-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Customize every aspect of your workspace', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 25, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 90;
        const backEl = createButton(dom, 'Back', {
          x: textX - 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 18: Feedback / Social links ───────────────────
  {
    id: 'feedback',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      // Close any previously open dropdowns
      document.querySelectorAll('.menubar-item.open').forEach(m => m.classList.remove('open'));

      const cx = vw / 2;
      const cy = vh / 2 - 60;

      // 1. "Feedback is always welcome" handwritten text
      seq.add(() => handwrittenLabel(svg, 'Feedback is always welcome', {
        x: cx,
        y: cy,
        color: 'rgba(255, 255, 255, 0.55)',
        fontSize: 34,
        textAnchor: 'middle',
        duration: 400,
      }), 200);

      // 2. Decorative sparkles
      seq.add(() => createDoodle(svg, 'sparkle', {
        x: cx - 220, y: cy - 50,
        scale: 1, color: 'rgba(255, 255, 255, 0.25)', duration: 300,
      }), 300);
      seq.add(() => createDoodle(svg, 'sparkle', {
        x: cx + 200, y: cy + 10,
        scale: 0.8, color: 'rgba(255, 255, 255, 0.25)', duration: 300,
      }), 400);

      // 3. Social icons row
      seq.add(() => {
        const iconY = cy + 60;
        const gap = 90;

        const socials = [
          {
            label: 'Discord',
            url: 'https://discord.gg/x6yWqE9GZP',
            svg: '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>',
          },
          {
            label: 'GitHub',
            url: 'https://github.com/danilokhury/Synabun',
            svg: '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
          },
          {
            label: 'X',
            url: 'https://x.com/SynabunAI',
            svg: '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
          },
        ];

        const els = [];
        socials.forEach((s, i) => {
          const x = cx + (i - 1) * gap;
          const el = document.createElement('a');
          el.href = s.url;
          el.target = '_blank';
          el.rel = 'noopener';
          el.title = s.label;
          el.style.cssText = `
            position: absolute;
            left: ${x}px; top: ${iconY}px;
            transform: translate(-50%, 0);
            display: flex; flex-direction: column; align-items: center; gap: 8px;
            color: rgba(255, 255, 255, 0.4);
            text-decoration: none;
            pointer-events: auto;
            transition: color 0.2s, transform 0.2s;
            opacity: 0;
            font-family: 'Caveat', cursive;
            font-size: 18px;
            cursor: pointer;
          `;
          el.innerHTML = `${s.svg}<span>${s.label}</span>`;
          dom.appendChild(el);
          requestAnimationFrame(() => { el.style.opacity = '1'; });

          el.addEventListener('mouseenter', () => {
            el.style.color = 'rgba(255, 255, 255, 0.8)';
            el.style.transform = 'translate(-50%, 0) scale(1.1)';
          });
          el.addEventListener('mouseleave', () => {
            el.style.color = 'rgba(255, 255, 255, 0.4)';
            el.style.transform = 'translate(-50%, 0) scale(1)';
          });
          els.push(el);
        });

        return { destroy() { els.forEach(e => e.remove()); } };
      }, 300);

      // 4. Navigation buttons
      seq.add(() => {
        const navY = cy + 170;
        const backEl = createButton(dom, 'Back', {
          x: cx - 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const doneEl = createButton(dom, 'Done', {
          x: cx + 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); doneEl.remove(); } };
      }, 200);
    },
  },
];
