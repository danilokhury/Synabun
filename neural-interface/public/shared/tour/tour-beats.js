// The Workspace tour's storyboard, as data: 12 beats in 5 chapters (about
// 100 s at a natural pace; every beat waits for the user). The engine
// (tour-engine.js) plays a beat's script op by op:
//
//   ['pose', name, opts]        the rig's pose (MASCOT_POSES)
//   ['react', name]             one reaction (MASCOT_REACTIONS + wiggle)
//   ['travel', place, opts]     the mascot flies: home | corner | top | topright | composer
//   ['look', target]            gaze only
//   ['point', target | null]    arms + gaze at a control (null: arms away)
//   ['poke']                    two pokes toward it (the beat landed)
//   ['ring', target | null]     the one highlight ring springs to a control (null: it fades)
//   ['say', key, { computerless }]  the narration (laid out whole, revealed a word at a time; announced
//                               once); `computerless` names the line used where there is no computer use
//   ['wait', ms]
//   ['label', key, at, opts]    handwriting; at { beside: 'actor' | target, side, dy } picks the first free side
//                               (clear of the mascot, its arm, the ring, the caption, the panel's words and other ink)
//   ['box' | 'arrow' | 'line' | 'underline' | 'drum' | 'doodle' | 'sparkle', …] ink
//   ['erase']                   the board wipes, newest stroke first
//   ['words', on]               the empty state's own words (heading, starters) show or step aside
//   ['context', on]             the empty state's context line (Project · Budget) shows on the board
//   ['handoff', on]             the hand-off: words back, the composer ringed
//   ['parallel', ops] / ['seq', ops]
//   ['if', envKey, op, elseOp]  op unless env[envKey] is false (then elseOp)
//
// A target is { sel: [selectors…] } (the first one on screen, looked up in the
// panel, its toolbar, then the page; `pad` / `padY` / `radius` / `tail` shape its ring)
// or, for ink, [x, y] board units, { keepout: side, dx, dy } (just outside what
// the mascot draws: ink never touches it) or { after: 'label' } (the last
// writing's end). Board units: 0-100 across the board's width, the same unit down.
// A beat may say `when(env)` (dropped when false), `caption: 'top'` (the
// narration moves to the head of the board, so nothing sits between the
// narrator and the composer), `after` (the beat it continues on the same
// board; reached any other way it first draws `prelude` at once).
// Strings: tour.chapters.<id>, tour.beats.<id>.line, tour.ink.<key> in
// i18n/en.json and pt-BR.json (tests/tour-beats.test.mjs keeps both whole).

export const CHAPTERS = Object.freeze(['hello', 'work', 'controls', 'workspace', 'first']);

// Controls the beats point at. Alternatives in order; the first one on screen wins.
export const TARGETS = Object.freeze({
  composer: { sel: ['.asst-composer'] },
  // The composer sits 6-8 px in from the panel's edge: a small gap, a modest corner (a larger one makes the ring grow
  // round the corners) and a short pen-tail (it bows out on the left side), so the ring stays inside the panel.
  composerCard: { sel: ['.asst-composer'], pad: 1, radius: 10, tail: 1.2 },
  model: { sel: ['.asst-dd-model'] },
  effortMode: { sel: ['.asst-dd-effort', '.asst-dd-mode'], union: true },
  project: { sel: ['.asst-empty-project .asst-empty-project-btn', '.asst-dd-project'] },
  route: { sel: ['.asst-route-chip'] },
  computer: { sel: ['.asst-computer-toggle'] },
  // With the workspace tools hidden (the toolbar's toggle) the Memory Explorer is off screen: the toggle shows them.
  explorer: { sel: ['#topright-memory-explorer-btn', '#topright-tools-btn'] },
  focus: { sel: ['#titlebar-viz-toggle'] },
  sessions: { sel: ['.asp-tabs-btn'] },
  automations: { sel: ['[data-menu="automations"] > .menubar-label'] },
  schedules: { sel: ['#menubar-schedules-btn'] },
});

const T = TARGETS;

export const BEATS = Object.freeze([
  {
    id: 'hello', chapter: 'hello', seconds: 7,
    // Reached from a later beat (the chapter list, ←): what that beat left (its ink, the ring, an arm) goes first.
    script: [
      ['erase'], ['ring', null], ['point', null],
      ['pose', 'sleep'], ['wait', 420],
      ['pose', 'idle'], ['react', 'hop'], ['wait', 300],
      ['words', false],
      ['travel', 'corner'],
      ['pose', 'present'], ['look', T.composer],
      ['parallel', [
        ['say', 'hello'],
        ['seq', [['wait', 420], ['label', 'hi', { beside: 'actor', side: 'right', dy: -10 }, { cls: 'gold big' }], ['sparkle', { after: 'label', dx: 8, dy: -2 }]]],
      ]],
      ['react', 'nod'],
    ],
  },
  {
    id: 'routing', chapter: 'work', seconds: 10,
    script: [
      ['erase'], ['ring', null], ['point', null],
      ['travel', 'top'], ['pose', 'plan', { ticks: 0 }],
      ['parallel', [
        ['say', 'routing'],
        ['seq', [
          ['box', [3, 9, 22, 11], { seed: 'you' }], ['label', 'you', [14, 17], { anchor: 'middle' }],
          ['point', [20, 14.5]],
          ['arrow', [26, 14.5], { keepout: 'left', dx: -3 }, { cls: 'gold', curve: -0.14 }],
          ['wait', 160], ['point', null], ['pose', 'subagent', { count: 3 }], ['react', 'pop'],
          ['parallel', [
            ['arrow', { keepout: 'bottom', dx: -12, dy: 3 }, [14, 42], { cls: 'gold', curve: 0.18 }],
            ['arrow', { keepout: 'bottom', dx: 0, dy: 3 }, [50, 42], { cls: 'gold', curve: 0.02, delay: 80 }],
            ['arrow', { keepout: 'bottom', dx: 12, dy: 3 }, [86, 42], { cls: 'gold', curve: -0.18, delay: 160 }],
          ]],
          ['parallel', [
            ['box', [3, 43, 22, 11], { seed: 'w1' }], ['box', [39, 43, 22, 11], { seed: 'w2', delay: 60 }], ['box', [75, 43, 22, 11], { seed: 'w3', delay: 120 }],
          ]],
          ['parallel', [
            ['label', 'code', [14, 51], { anchor: 'middle' }],
            ['label', 'research', [50, 51], { anchor: 'middle', delay: 60 }],
            ['label', 'design', [86, 51], { anchor: 'middle', delay: 120 }],
          ]],
        ]],
      ]],
    ],
  },
  {
    id: 'memory', chapter: 'work', seconds: 7, after: 'routing',
    // Reached without the routing figure on the board (the chapter list, ← from tools): the ring and the arm the
    // other beat left go away, then the middle worker it hangs from, drawn at once.
    prelude: [['ring', null], ['point', null], ['travel', 'top'], ['box', [39, 43, 22, 11], { seed: 'w2' }], ['label', 'research', [50, 51], { anchor: 'middle' }]],
    script: [
      ['pose', 'memory', { mode: 'remember' }],
      ['parallel', [
        ['say', 'memory'],
        ['seq', [
          ['arrow', [50, 55.5], [50, 66], { cls: 'faint', curve: 0 }],
          ['drum', [37, 67, 26, 14]],
          ['label', 'memory', [50, 77.5], { anchor: 'middle', cls: 'gold' }],
          // What is saved comes back next time: a loop beside the drum (an arrow back up would cross the figure).
          ['doodle', 'cycle', [74, 73, 9]],
        ]],
      ]],
      ['react', 'nod'],
    ],
  },
  {
    id: 'tools', chapter: 'work', seconds: 8,
    script: [
      ['erase'], ['ring', null], ['point', null],
      ['travel', 'top'], ['pose', 'web'],
      ['parallel', [
        ['say', 'tools', { computerless: 'lineNoComputer' }],
        // Three doodles in a row (two where this Mac has no computer use), the arm on each as it is drawn.
        ['if', 'computer', ['seq', [
          ['point', [16, 40]], ['doodle', 'globe', [16, 44, 18]], ['label', 'web', [16, 63], { anchor: 'middle' }],
          ['pose', 'computer'],
          ['point', [50, 40]], ['doodle', 'laptop', [50, 44, 20]], ['label', 'mac', [50, 63], { anchor: 'middle' }],
          ['ring', T.computer],
          ['point', [84, 40]], ['doodle', 'folder', [84, 44, 18]], ['label', 'files', [84, 63], { anchor: 'middle' }],
          ['point', T.computer],
        ]], ['seq', [
          ['point', [30, 40]], ['doodle', 'globe', [30, 44, 18]], ['label', 'web', [30, 63], { anchor: 'middle' }],
          ['point', [70, 40]], ['doodle', 'folder', [70, 44, 18]], ['label', 'files', [70, 63], { anchor: 'middle' }],
        ]]],
      ]],
      ['poke'],
    ],
  },
  {
    id: 'project', chapter: 'controls', seconds: 8,
    // The ring and the arm stay out from the tools beat: the ring glides to the project, the arm trails the flight.
    script: [
      ['erase'],
      ['label', 'chapter3', [3, 10], { cls: 'quiet' }],
      ['label', 'controls', [3, 21], { cls: 'gold big' }],
      ['underline', [3, 14, 46, 9]],
      ['context', true],
      ['travel', { beside: T.project }], ['pose', 'project'],
      ['parallel', [
        ['say', 'project'],
        ['seq', [['ring', T.project], ['point', T.project], ['label', 'whereIWork', { beside: T.project, side: 'above' }, { cls: 'gold' }]]],
      ]],
      ['poke'],
    ],
  },
  {
    id: 'model', chapter: 'controls', seconds: 9, caption: 'top',
    script: [
      ['erase'], ['context', false],
      ['travel', 'composer'], ['pose', 'present'],
      ['parallel', [
        ['seq', [['ring', T.model], ['point', T.model], ['label', 'myBrain', { beside: 'actor', side: 'right', dy: -6 }, { cls: 'gold' }]]],
        // No arrow: it would cross the composer's placeholder. The arms, the gaze and the ring point.
        ['say', 'model'],
      ]],
      ['poke'],
    ],
  },
  {
    id: 'effort', chapter: 'controls', seconds: 9, caption: 'top',
    script: [
      ['erase'],
      ['travel', 'composer'], ['pose', 'ask'],
      ['parallel', [
        ['seq', [['ring', T.effortMode], ['point', T.effortMode], ['label', 'howHard', { beside: 'actor', side: 'right', dy: -10 }, { cls: 'gold small' }], ['label', 'whenIAsk', { beside: 'actor', side: 'right', dy: 10 }, { cls: 'gold small' }]]],
        ['say', 'effort'],
      ]],
      ['poke'],
    ],
  },
  {
    id: 'routes', chapter: 'controls', seconds: 9,
    script: [
      ['erase'],
      ['travel', 'corner'], ['pose', 'pick'],
      ['parallel', [
        ['seq', [['ring', T.route], ['point', T.route], ['doodle', 'fork', [58, 22, 26]], ['label', 'me', [47, 52], { anchor: 'middle', cls: 'gold' }], ['label', 'worker', [72, 52], { anchor: 'middle' }]]],
        ['say', 'routes'],
      ]],
      ['poke'],
    ],
  },
  {
    id: 'workspace', chapter: 'workspace', seconds: 9,
    script: [
      ['erase'],
      ['react', 'wiggle'],
      ['label', 'chapter4', [3, 12], { cls: 'quiet' }],
      ['label', 'workspaceTitle', [3, 24], { cls: 'gold big' }],
      ['underline', [3, 17, 56, 9]],
      ['travel', 'topright'], ['pose', 'present'],
      ['parallel', [
        ['seq', [['ring', T.explorer], ['point', T.explorer], ['doodle', 'island', [50, 50, 30]]]],
        ['say', 'workspace'],
      ]],
      ['poke'],
    ],
  },
  {
    id: 'whiteboard', chapter: 'workspace', seconds: 8,
    script: [
      ['erase'],
      ['travel', 'topright'], ['pose', 'present'],
      ['parallel', [
        ['seq', [
          ['ring', T.focus], ['point', T.focus], ['doodle', 'board', [50, 40, 34]],
          ['wait', 900],
          ['ring', T.sessions], ['point', T.sessions], ['label', 'sessions', [50, 66], { anchor: 'middle', cls: 'gold' }],
        ]],
        ['say', 'whiteboard'],
      ]],
      ['poke'],
    ],
  },
  {
    id: 'automations', chapter: 'workspace', seconds: 8,
    script: [
      ['erase'],
      ['travel', 'topright'], ['pose', 'runs'],
      ['parallel', [
        ['seq', [
          ['ring', T.automations], ['point', T.automations], ['doodle', 'clock', [50, 42, 26]],
          ['wait', 900],
          ['ring', T.schedules], ['point', T.schedules], ['label', 'onTime', [50, 66], { anchor: 'middle', cls: 'gold' }],
        ]],
        ['say', 'automations'],
      ]],
      ['poke'],
    ],
  },
  {
    id: 'handoff', chapter: 'first', seconds: 8, last: true, caption: 'top',
    script: [
      ['erase'], ['point', null], ['context', false],
      ['travel', 'home'],
      ['pose', 'success', { then: 'present' }],
      ['words', true], ['wait', 360],
      ['handoff', true],
      // The ring and the gaze hand over; an arm from home would cross the heading and the starters.
      ['ring', T.composerCard], ['look', T.composerCard],
      ['say', 'handoff'],
      ['react', 'nod'],
    ],
  },
]);

/** The beat a chapter starts with. */
export function chapterStart(chapter, beats = BEATS) {
  return Math.max(0, beats.findIndex(b => b.chapter === chapter));
}

// The cursor of the tours before this one: their step ids (and the numeric
// indices of the oldest) land on the beat that covers the same ground.
const LEGACY_STEPS = {
  welcome: 'hello',
  'assistant-start': 'handoff',
  'assistant-project': 'project',
  'assistant-model': 'model',
  'assistant-effort': 'effort',
  'assistant-permissions': 'effort',
  'assistant-route': 'routes',
  'assistant-routes': 'routes',
  'assistant-models': 'routes',
  'assistant-tools': 'tools',
  'assistant-context': 'tools',
  'assistant-track': 'routing',
  'assistant-budget': 'routing',
  'assistant-sessions': 'whiteboard',
  'explain-memory-explorer': 'workspace',
  'explain-graph': 'workspace',
  'explain-focus': 'whiteboard',
  'explain-workspaces': 'whiteboard',
  'explain-terminals': 'tools',
  'explain-browser': 'tools',
  'explain-side-panel': 'tools',
  'explain-automations': 'automations',
  'explain-schedules': 'automations',
  'explain-help': 'handoff',
};
const LEGACY_INDEX = ['onboarding-explore', 'onboarding-token-warning', 'onboarding-cli-picker', 'onboarding-model-picker',
  'onboarding-project-picker', 'onboarding-memory-explain', 'welcome', 'explain-sessions', 'explain-gallery',
  'explain-cost', 'explain-help', 'explain-focus', 'explain-fullscreen', 'explain-clock', 'explain-trash', 'explain-grid',
  'explain-tile', 'explain-keybinds', 'explain-memory-explorer', 'explain-file-explorer', 'explain-bookmarks',
  'explain-share', 'explain-workspaces', 'explain-side-panel', 'explain-menubar', 'explain-whiteboard-toolbar', 'feedback'];

/** The beat a saved cursor resumes: a beat id, an older tour's step id or its numeric index; else the first beat. */
export function resumeBeat(value, beats = BEATS) {
  const id = String(value ?? '');
  const direct = beats.findIndex(b => b.id === id);
  if (direct >= 0) return direct;
  const step = /^\d+$/.test(id) ? LEGACY_INDEX[Number(id)] : id;
  const mapped = beats.findIndex(b => b.id === LEGACY_STEPS[step]);
  return mapped >= 0 ? mapped : 0;
}

/** The beats this workspace can show: a beat whose `when` says no is left out. */
export function beatsFor(env = {}, beats = BEATS) {
  return beats.filter(b => typeof b.when !== 'function' || b.when(env));
}

/** Every i18n key the storyboard uses (the contract test checks both locales carry them). */
export function storyboardKeys(beats = BEATS) {
  const keys = new Set(CHAPTERS.map(c => `tour.chapters.${c}`));
  const walk = (ops) => {
    for (const op of ops || []) {
      if (!Array.isArray(op)) continue;
      if (op[0] === 'say') { keys.add(`tour.beats.${op[1]}.line`); if (op[2]?.computerless) keys.add(`tour.beats.${op[1]}.${op[2].computerless}`); }
      if (op[0] === 'label') keys.add(`tour.ink.${op[1]}`);
      if (op[0] === 'parallel' || op[0] === 'seq') walk(op[1]);
      if (op[0] === 'if') walk([op[2], op[3]].filter(Boolean));
    }
  };
  for (const b of beats) { walk(b.script); walk(b.prelude); }
  return [...keys];
}
