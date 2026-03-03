// ═══════════════════════════════════════════
// UI-GAMES — Whiteboard Games (Tic Tac Toe)
// ═══════════════════════════════════════════

import { emit, on } from './state.js';
import { loadIfaceConfig, applyIfaceConfig, saveIfaceConfig } from './ui-settings.js';
import { storage } from './storage.js';
import { KEYS } from './constants.js';

const $ = (id) => document.getElementById(id);

// ── TicTacToe constants ──
const TTT_BOARD_SIZE = 500;
const TTT_CELL_SIZE = Math.round(TTT_BOARD_SIZE / 3);
const TTT_PIECE_SIZE = 120;
const TTT_PIECE_OFFSET = Math.round((TTT_CELL_SIZE - TTT_PIECE_SIZE) / 2);
const TTT_NUMBER_SIZE = 60;
const TTT_NUMBER_OFFSET = Math.round((TTT_CELL_SIZE - TTT_NUMBER_SIZE) / 2);

// Cell ID helpers
const cellId = (n) => `ttt-cell-${n}`;

// ── Game prompt sent to the AI opponent ──
const TTT_GAME_PROMPT = `Let's play Tic Tac Toe! A board is set up on the whiteboard with cells numbered 1-9. You play as X (Cross) and I play as O (Circle).

To see the board: use whiteboard_read or whiteboard_screenshot.
To make a move: first whiteboard_remove the number marker (id: "ttt-cell-N"), then whiteboard_add an image element with url "/games/TicTacToe/Cross.svg" at the same position (get x,y from whiteboard_read), width 120, height 120.

Cell layout:
  1 | 2 | 3
  ---------
  4 | 5 | 6
  ---------
  7 | 8 | 9

You go first — pick a cell and make your move!`;

// ── SVG to DataUrl conversion ──
async function svgToDataUrl(url) {
  const resp = await fetch(url);
  const text = await resp.text();
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text)));
}

// ── Preloaded assets ──
let _assets = {};
let _assetsLoaded = false;

async function preloadAssets() {
  if (_assetsLoaded) return;
  const names = ['Board', 'Cross', 'Circle', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  await Promise.all(names.map(async name => {
    _assets[name] = await svgToDataUrl(`/games/TicTacToe/${name}.svg`);
  }));
  _assetsLoaded = true;
}

// ── Cell coordinate mapping ──
function cellPosition(cellNum, boardX, boardY) {
  const idx = cellNum - 1;
  const col = idx % 3;
  const row = Math.floor(idx / 3);
  return {
    x: boardX + col * TTT_CELL_SIZE + TTT_PIECE_OFFSET,
    y: boardY + row * TTT_CELL_SIZE + TTT_PIECE_OFFSET,
  };
}

// ── Position logo above a board at given boardY ──
function positionLogoAboveBoard(boardY) {
  const logo = document.querySelector('.static-bg-logo');
  if (!logo) return;
  const wbRoot = $('wb-root');
  if (!wbRoot) return;
  const rect = wbRoot.getBoundingClientRect();
  const logoAboveBoardPx = rect.top + boardY - 20;
  logo.classList.add('game-active');
  logo.style.top = logoAboveBoardPx + 'px';
  logo.style.transform = 'translate(-50%, -100%)';
}

// ── Reset logo to default center position ──
function resetLogoPosition() {
  const logo = document.querySelector('.static-bg-logo');
  if (!logo) return;
  logo.classList.remove('game-active');
  logo.style.top = '';
  logo.style.transform = '';
}

// ── Check if a TicTacToe game is active in persisted whiteboard state ──
function detectActiveGame() {
  try {
    const raw = storage.getItem(KEYS.WHITEBOARD);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.elements)) return null;
    const board = data.elements.find(el => el.id === 'ttt-board');
    if (!board) return null;
    return { boardX: board.x, boardY: board.y };
  } catch { return null; }
}

// ── SVG icons for opponent picker ──
const ICON_CLAUDE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>';
const ICON_OPENAI = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg>';
const ICON_GEMINI = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"/></svg>';

const OPPONENTS = [
  { id: 'claude-code', icon: ICON_CLAUDE, label: 'Claude' },
  { id: 'codex',       icon: ICON_OPENAI, label: 'OpenAI' },
  { id: 'gemini',      icon: ICON_GEMINI, label: 'Gemini' },
];

// ── Opponent picker overlay ──
let _pickerEl = null;

function showOpponentPicker(boardX, boardY) {
  removeOpponentPicker();

  const picker = document.createElement('div');
  picker.id = 'ttt-opponent-picker';
  picker.innerHTML = `
    <div class="ttt-picker-title">CHOOSE YOUR OPPONENT</div>
    <div class="ttt-picker-options">
      ${OPPONENTS.map(o => `
        <button class="ttt-picker-btn" data-profile="${o.id}" title="${o.label}">
          <span class="ttt-picker-icon">${o.icon}</span>
          <span class="ttt-picker-label">${o.label}</span>
        </button>
      `).join('')}
    </div>
  `;

  const wbRoot = $('wb-root');
  if (!wbRoot) return;
  wbRoot.appendChild(picker);

  // Center below the board
  picker.style.position = 'absolute';
  picker.style.left = (boardX + TTT_BOARD_SIZE / 2) + 'px';
  picker.style.top = (boardY + TTT_BOARD_SIZE + 24) + 'px';
  picker.style.transform = 'translateX(-50%)';
  picker.style.zIndex = '999';
  picker.style.pointerEvents = 'auto';

  // Wire click handlers
  picker.querySelectorAll('.ttt-picker-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const profile = btn.dataset.profile;
      removeOpponentPicker();
      emit('terminal:launch-floating', {
        profile,
        initialMessage: TTT_GAME_PROMPT,
      });
    });
  });

  _pickerEl = picker;
}

function removeOpponentPicker() {
  if (_pickerEl) {
    _pickerEl.remove();
    _pickerEl = null;
  }
}

// ── Game HUD overlay (close button + arrow annotation) ──
let _hudEl = null;

function showGameHud(boardX, boardY) {
  removeGameHud();

  const hud = document.createElement('div');
  hud.id = 'ttt-hud';
  hud.innerHTML = `
    <button class="ttt-close-btn" title="Close game">&times;</button>
    <svg class="ttt-arrow-annotation" viewBox="0 0 90 60" fill="none">
      <path d="M82,5 C58,4 24,18 15,36"
            stroke="rgba(255,255,255,0.18)" stroke-width="1.5" stroke-linecap="round" fill="none"/>
      <polygon points="11,54 5,37 20,39" fill="rgba(255,255,255,0.18)"/>
    </svg>
    <span class="ttt-arrow-text">Do not Close.... EVER.</span>
  `;

  const wbRoot = $('wb-root');
  if (!wbRoot) return;
  wbRoot.appendChild(hud);

  // Position at top-right corner of the board
  hud.style.position = 'absolute';
  hud.style.left = (boardX + TTT_BOARD_SIZE + 16) + 'px';
  hud.style.top = (boardY - 8) + 'px';
  hud.style.zIndex = '999';
  hud.style.pointerEvents = 'auto';

  hud.querySelector('.ttt-close-btn').addEventListener('click', teardownTicTacToe);

  _hudEl = hud;
}

function removeGameHud() {
  if (_hudEl) {
    _hudEl.remove();
    _hudEl = null;
  }
}

// ── Teardown: clear board + reset everything ──
async function teardownTicTacToe() {
  removeGameHud();
  removeOpponentPicker();
  resetLogoPosition();
  const wbRoot = $('wb-root');
  if (wbRoot) wbRoot.classList.remove('ttt-active');
  await fetch('/api/whiteboard/clear', { method: 'POST' });
}

// ── Enter focus mode (whiteboard) if not already ──
function ensureFocusMode() {
  const cfg = loadIfaceConfig();
  if (cfg.visualizationEnabled !== false) {
    cfg.visualizationEnabled = false;
    applyIfaceConfig(cfg);
    saveIfaceConfig(cfg);
    emit('viz:toggle', false);
  }
}

// ── Setup the TicTacToe board ──
async function setupTicTacToe() {
  // Preload all SVG assets
  await preloadAssets();

  // Enter focus mode (whiteboard)
  ensureFocusMode();

  // Wait a tick for focus mode transition
  await new Promise(r => setTimeout(r, 200));

  // Clear the whiteboard
  await fetch('/api/whiteboard/clear', { method: 'POST' });

  // Wait for clear to propagate
  await new Promise(r => setTimeout(r, 100));

  // Calculate board position (centered in whiteboard)
  const wbRoot = $('wb-root');
  if (!wbRoot) {
    console.error('[games] Whiteboard root not found');
    return;
  }
  wbRoot.classList.add('ttt-active');
  const rect = wbRoot.getBoundingClientRect();
  const boardX = Math.round((rect.width - TTT_BOARD_SIZE) / 2);
  const boardY = Math.round((rect.height - TTT_BOARD_SIZE) / 2);

  // Animate logo above the board + show HUD + opponent picker
  positionLogoAboveBoard(boardY);
  showGameHud(boardX, boardY);
  showOpponentPicker(boardX, boardY);

  // Build all elements in a single batch
  const elements = [];

  // Board grid
  elements.push({
    id: 'ttt-board',
    type: 'image',
    x: boardX,
    y: boardY,
    width: TTT_BOARD_SIZE,
    height: TTT_BOARD_SIZE,
    dataUrl: _assets.Board,
  });

  // Number markers (1-9) — small and dim (opacity handled via CSS)
  for (let i = 1; i <= 9; i++) {
    const idx = i - 1;
    const col = idx % 3;
    const row = Math.floor(idx / 3);
    elements.push({
      id: cellId(i),
      type: 'image',
      x: boardX + col * TTT_CELL_SIZE + TTT_NUMBER_OFFSET,
      y: boardY + row * TTT_CELL_SIZE + TTT_NUMBER_OFFSET,
      width: TTT_NUMBER_SIZE,
      height: TTT_NUMBER_SIZE,
      dataUrl: _assets[String(i)],
    });
  }

  // Send all elements in one request
  const resp = await fetch('/api/whiteboard/elements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ elements }),
  });

  if (!resp.ok) {
    console.error('[games] Failed to set up TicTacToe board:', await resp.text());
  }
}

// ── Clear game elements from persisted storage (call BEFORE initWhiteboard) ──
export function clearGameOnLoad() {
  try {
    const raw = storage.getItem(KEYS.WHITEBOARD);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.elements)) return;
    const hadGame = data.elements.some(el => el.id && el.id.startsWith('ttt-'));
    if (!hadGame) return;
    data.elements = data.elements.filter(el => !el.id || !el.id.startsWith('ttt-'));
    storage.setItem(KEYS.WHITEBOARD, JSON.stringify(data));
    // Also clear server state
    fetch('/api/whiteboard/clear', { method: 'POST' });
  } catch { /* ignore */ }
}

// ── Init ──
export function initGames() {
  // Wire menu click
  const tttItem = $('menu-game-tictactoe');
  if (tttItem) {
    tttItem.addEventListener('click', () => {
      emit('panel:close-all-dropdowns');
      setupTicTacToe();
    });
  }
}
