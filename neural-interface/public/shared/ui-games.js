// ═══════════════════════════════════════════
// UI-GAMES — Whiteboard Games (Tic Tac Toe)
// ═══════════════════════════════════════════

import { emit, on } from './state.js';
import { loadIfaceConfig, applyIfaceConfig, saveIfaceConfig } from './ui-settings.js';
import { storage } from './storage.js';
import { KEYS } from './constants.js';

const $ = (id) => document.getElementById(id);

// ── TicTacToe constants (only used for UI positioning) ──
const TTT_BOARD_SIZE = 500;

// ── Game prompts (dynamic based on dice roll) ──
function buildGamePrompt(humanFirst, opponentLabel) {
  const youPiece = humanFirst ? 'O' : 'X';
  const themPiece = humanFirst ? 'X' : 'O';

  return `Tic Tac Toe. You are ${youPiece}. Use tictactoe tool (action "move", cell 1-9) for all moves — yours AND the human's. ${humanFirst ? 'Human goes first. Wait for their cell number.' : 'You go first. Pick a cell now.'}

Each turn: place the human's ${themPiece} at their cell, then place your ${youPiece}. Keep responses short.`;
}

// ── Dice face dot patterns (grid positions: TL=0, TC=1, TR=2, ML=3, MC=4, MR=5, BL=6, BC=7, BR=8) ──
const DICE_FACES = {
  1: [4],                     // center
  2: [2, 6],                  // TR, BL
  3: [2, 4, 6],               // TR, MC, BL
  4: [0, 2, 6, 8],            // four corners
  5: [0, 2, 4, 6, 8],         // four corners + center
  6: [0, 3, 6, 2, 5, 8],      // left col + right col
};

function createDieElement() {
  const die = document.createElement('div');
  die.className = 'ttt-die';
  for (let i = 0; i < 9; i++) {
    const dot = document.createElement('div');
    dot.className = 'ttt-dot';
    dot.dataset.pos = i;
    die.appendChild(dot);
  }
  return die;
}

function setDieFace(die, face) {
  const dots = die.querySelectorAll('.ttt-dot');
  const active = DICE_FACES[face] || [];
  dots.forEach((dot, i) => {
    dot.classList.toggle('visible', active.includes(i));
  });
  die.dataset.face = face;
}

// ── Dice roll overlay ──
function showDiceRoll(opponentLabel) {
  return new Promise((resolve) => {
    const wbRoot = $('wb-root');
    if (!wbRoot) return resolve({ humanFirst: true });

    // Move logo up so dice don't overlap it
    const rect = wbRoot.getBoundingClientRect();
    const diceAreaTop = Math.round(rect.height / 2) - 80; // dice center minus half their height
    positionLogoAboveBoard(diceAreaTop);

    const overlay = document.createElement('div');
    overlay.id = 'ttt-dice-overlay';

    const row = document.createElement('div');
    row.className = 'ttt-dice-row';

    // Human die
    const humanPlayer = document.createElement('div');
    humanPlayer.className = 'ttt-dice-player';
    const humanDie = createDieElement();
    const humanLabel = document.createElement('div');
    humanLabel.className = 'ttt-dice-label';
    humanLabel.textContent = 'YOU';
    humanPlayer.appendChild(humanDie);
    humanPlayer.appendChild(humanLabel);

    // VS text
    const vs = document.createElement('div');
    vs.className = 'ttt-dice-vs';
    vs.textContent = 'VS';

    // AI die
    const aiPlayer = document.createElement('div');
    aiPlayer.className = 'ttt-dice-player';
    const aiDie = createDieElement();
    const aiLabel = document.createElement('div');
    aiLabel.className = 'ttt-dice-label';
    aiLabel.textContent = opponentLabel.toUpperCase();
    aiPlayer.appendChild(aiDie);
    aiPlayer.appendChild(aiLabel);

    row.appendChild(humanPlayer);
    row.appendChild(vs);
    row.appendChild(aiPlayer);

    // Result text (hidden initially)
    const resultEl = document.createElement('div');
    resultEl.className = 'ttt-dice-result';

    overlay.appendChild(row);
    overlay.appendChild(resultEl);
    wbRoot.appendChild(overlay);

    // Generate final values (ensure no tie)
    let humanRoll, aiRoll;
    do {
      humanRoll = Math.floor(Math.random() * 6) + 1;
      aiRoll = Math.floor(Math.random() * 6) + 1;
    } while (humanRoll === aiRoll);

    const humanFirst = humanRoll > aiRoll;

    // Start rolling animation
    setDieFace(humanDie, 1);
    setDieFace(aiDie, 1);
    humanDie.classList.add('rolling');
    aiDie.classList.add('rolling');

    const rollInterval = setInterval(() => {
      setDieFace(humanDie, Math.floor(Math.random() * 6) + 1);
      setDieFace(aiDie, Math.floor(Math.random() * 6) + 1);
    }, 80);

    // Settle after 1.5s
    setTimeout(() => {
      clearInterval(rollInterval);
      humanDie.classList.remove('rolling');
      aiDie.classList.remove('rolling');

      setDieFace(humanDie, humanRoll);
      setDieFace(aiDie, aiRoll);

      humanDie.classList.add('settled');
      aiDie.classList.add('settled');

      // Show result text
      setTimeout(() => {
        resultEl.textContent = humanFirst
          ? 'You go first!'
          : `${opponentLabel} goes first!`;
        resultEl.classList.add('show');
      }, 400);

      // Fade out and resolve after 1.8s
      setTimeout(() => {
        overlay.classList.add('fade-out');
        setTimeout(() => {
          overlay.remove();
          resolve({ humanFirst, humanRoll, aiRoll });
        }, 500);
      }, 1800);
    }, 1500);
  });
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

function showOpponentPicker() {
  removeOpponentPicker();

  const picker = document.createElement('div');
  picker.id = 'ttt-opponent-picker';
  picker.innerHTML = `
    <div class="ttt-picker-title">CHOOSE YOUR OPPONENT</div>
    <div class="ttt-picker-options">
      ${OPPONENTS.map(o => `
        <button class="ttt-picker-btn" data-profile="${o.id}" data-label="${o.label}" title="${o.label}">
          <span class="ttt-picker-icon">${o.icon}</span>
          <span class="ttt-picker-label">${o.label}</span>
        </button>
      `).join('')}
    </div>
  `;

  const wbRoot = $('wb-root');
  if (!wbRoot) return;
  wbRoot.appendChild(picker);

  // Move logo up so picker doesn't overlap it
  const rect = wbRoot.getBoundingClientRect();
  const pickerAreaTop = Math.round(rect.height / 2) - 40;
  positionLogoAboveBoard(pickerAreaTop);

  // Center in whiteboard, nudged slightly below center
  picker.style.position = 'absolute';
  picker.style.left = '50%';
  picker.style.top = 'calc(50% + 20px)';
  picker.style.transform = 'translate(-50%, -50%)';
  picker.style.zIndex = '999';
  picker.style.pointerEvents = 'auto';

  // Wire click handlers — each button triggers dice roll → game start
  picker.querySelectorAll('.ttt-picker-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const profile = btn.dataset.profile;
      const label = btn.dataset.label;
      removeOpponentPicker();

      // Dice roll to determine who goes first
      const { humanFirst } = await showDiceRoll(label);

      // Start the game — human is X if they go first, AI is X otherwise
      await startGameAfterDice(profile, label, humanFirst);
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

// ── Start game after dice roll ──
async function startGameAfterDice(profile, opponentLabel, humanFirst) {
  const wbRoot = $('wb-root');
  if (!wbRoot) return;

  // If human goes first, human is X. If AI goes first, AI is X.
  // The `piece` param in /start represents which piece X is assigned to.
  // X always goes first. We just control the prompt to assign roles.
  const resp = await fetch('/api/games/tictactoe/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ piece: 'X' }),
  });

  if (!resp.ok) {
    console.error('[games] Failed to start TicTacToe:', await resp.text());
    return;
  }

  const rect = wbRoot.getBoundingClientRect();
  const boardX = Math.round((rect.width - TTT_BOARD_SIZE) / 2);
  const boardY = Math.round((rect.height - TTT_BOARD_SIZE) / 2);

  positionLogoAboveBoard(boardY);
  showGameHud(boardX, boardY);

  // Launch terminal with dynamic prompt based on dice result
  const prompt = buildGamePrompt(humanFirst, opponentLabel);
  emit('terminal:launch-floating', {
    profile,
    initialMessage: prompt,
  });
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

// ── Teardown: end game via API + reset UI ──
async function teardownTicTacToe() {
  removeGameHud();
  removeOpponentPicker();
  resetLogoPosition();
  const wbRoot = $('wb-root');
  if (wbRoot) wbRoot.classList.remove('ttt-active');
  await fetch('/api/games/tictactoe/end', { method: 'POST' });
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

// ── Setup the TicTacToe game ──
async function setupTicTacToe() {
  // Enter focus mode (whiteboard)
  ensureFocusMode();

  // Wait a tick for focus mode transition
  await new Promise(r => setTimeout(r, 200));

  const wbRoot = $('wb-root');
  if (!wbRoot) {
    console.error('[games] Whiteboard root not found');
    return;
  }
  wbRoot.classList.add('ttt-active');

  // Show opponent picker — it handles dice roll → game start → terminal launch
  showOpponentPicker();
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
    fetch('/api/games/tictactoe/end', { method: 'POST' });
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
