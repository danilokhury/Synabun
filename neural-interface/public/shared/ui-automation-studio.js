// ═══════════════════════════════════════════
// SynaBun Neural Interface — Automation Studio
// Browse, configure, launch, and track loop automations.
// Powered by SynaBun memory + browser integration.
// ═══════════════════════════════════════════

import { emit, on } from './state.js';
import { storage } from './storage.js';
import { isGuest, hasPermission, showGuestToast } from './ui-sync.js';
import {
  fetchLoopTemplates,
  createLoopTemplate,
  updateLoopTemplate,
  deleteLoopTemplate,
  importLoopTemplates,
  fetchActiveLoop,
  fetchLoopHistory,
  searchMemoriesByCategory,
  storeLoopCompletion,
  launchLoop,
  stopLoop,
  deleteLoopHistory,
  deleteMemory,
  fetchBrowserSessions,
} from './api.js';

const $ = (id) => document.getElementById(id);

// ── Module-local state ──
let _panel = null;
let _templates = [];       // user-created templates from API
let _activeLoop = null;    // current active loop status
let _history = [];         // completed loops / memories
let _view = 'welcome';    // 'welcome' | 'picker' | 'detail' | 'wizard' | 'running' | 'history'
let _selected = null;      // currently open template in detail view
let _filterCategory = 'all';
let _searchQuery = '';
let _focusMode = false;
let _pollTimer = null;
let _prevLoopActive = false;

// Detail/editor state
let _metaDirty = false;
let _detailDirty = false;
let _editorContent = '';
let _originalContent = '';
let _previewMode = false;
let _fetchSeq = 0;

// Wizard state
let _wizardState = null;
let _wizardStep = 0;
let _wizardPreset = null;

// ── Constants ──
const PANEL_KEY = 'neural-panel-automation-studio';
const POLL_INTERVAL = 5000;

const CATEGORY_LABELS = {
  social: 'Social',
  productivity: 'Productivity',
  monitoring: 'Monitoring',
  custom: 'Custom',
};

const CATEGORY_COLORS = {
  social: 'hsla(200, 40%, 55%, 0.9)',
  productivity: 'hsla(160, 40%, 55%, 0.9)',
  monitoring: 'hsla(35, 50%, 58%, 0.9)',
  custom: 'hsla(270, 30%, 60%, 0.9)',
};

// ── SVG Icons (stroke-based, 16x16, matches Skills Studio pattern) ──
const _s = (d) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const AS_ICONS = {
  // Preset template icons
  twitter:    _s('<path d="M2 13c2.5 0 4.5-1 5.5-3 1 2 3.5 3 6.5 1"/><path d="M14 3c-1 .5-2 .8-3 .8C10 3 8.5 2.5 7 3.5c-1.5 1-1.5 3-.5 4"/>'),
  search:     _s('<circle cx="7" cy="7" r="4"/><path d="M14 14l-3.5-3.5"/>'),
  research:   _s('<path d="M3 2h10M3 6h10M3 10h7"/><circle cx="13" cy="12" r="2"/><path d="M11.5 10.5l-1-1"/>'),
  chart:      _s('<path d="M3 14V8M7 14V4M11 14V9M15 14V6"/><path d="M1 14h14"/>'),
  mail:       _s('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 5l6 4 6-4"/>'),
  globe:      _s('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12"/>'),
  monitor:    _s('<rect x="2" y="2" width="12" height="9" rx="1.5"/><path d="M5 14h6M8 11v3"/>'),
  code:       _s('<polyline points="5 4.5 2 8 5 11.5"/><polyline points="11 4.5 14 8 11 11.5"/>'),
  pencil:     _s('<path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z"/>'),
  chat:       _s('<path d="M3 3h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 3v-3H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>'),
  refresh:    _s('<path d="M3 8a5 5 0 0 1 9-3M13 8a5 5 0 0 1-9 3"/><polyline points="3 3 3 6 6 6"/><polyline points="13 13 13 10 10 10"/>'),
  brain:      _s('<path d="M8 2C6 2 4.5 3.5 4.5 5c-1.5.5-2.5 2-2 3.5.5 1.5 2 2.5 3.5 2.5M8 2c2 0 3.5 1.5 3.5 3 1.5.5 2.5 2 2 3.5-.5 1.5-2 2.5-3.5 2.5M8 2v12"/><path d="M5 8h6"/>'),
  plus:       _s('<path d="M8 3v10M3 8h10"/>'),
  bolt:       _s('<path d="M9 2L4 9h4l-1 5 5-7H8l1-5z"/>'),
  blank:      _s('<rect x="3" y="2" width="10" height="12" rx="1.5"/><path d="M6 6h4M6 9h2"/>'),

  // UI chrome
  back:       _s('<path d="M10 3L5 8l5 5"/>'),
  forward:    _s('<path d="M6 3l5 5-5 5"/>'),
  down:       _s('<path d="M3 6l5 5 5-5"/>'),
  close:      _s('<path d="M4 4l8 8M12 4l-8 8"/>'),
  export:     _s('<path d="M8 2v8M4 6l4-4 4 4"/><path d="M2 11v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2"/>'),
};

/** Resolve icon key → SVG HTML. Falls back to refresh icon for unknown keys. */
function icon(key) { return AS_ICONS[key] || AS_ICONS.refresh; }

/** Icon keys available for template selection (excludes UI-only icons). */
const ICON_KEYS = Object.keys(AS_ICONS).filter(k => !['back','forward','down','close','export','plus','bolt','blank'].includes(k));

// ── CLI profiles and model options ──
const CLI_PROFILES = [
  { id: 'claude-code', label: 'Claude Code', desc: 'Anthropic' },
  { id: 'codex',       label: 'Codex CLI',   desc: 'OpenAI' },
  { id: 'gemini',      label: 'Gemini CLI',  desc: 'Google' },
];

const CLI_MODELS = {
  'claude-code': [
    { id: 'claude-opus-4-6',   label: 'Opus 4.6',   desc: 'Most capable', tier: 'top' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6',  desc: 'Balanced', tier: 'default' },
    { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',   desc: 'Fastest' },
  ],
  'codex': [
    { id: 'o3',      label: 'o3',      desc: 'Deep reasoning', tier: 'top' },
    { id: 'o4-mini', label: 'o4-mini', desc: 'Fast reasoning', tier: 'default' },
  ],
  'gemini': [
    { id: 'gemini-2.5-pro',   label: '2.5 Pro',   desc: 'Most capable', tier: 'default' },
    { id: 'gemini-2.5-flash', label: '2.5 Flash', desc: 'Lightweight' },
  ],
};

// Persistent launch preferences (remembered across launches in session)
let _launchProfile = storage.getItem('as-launch-profile') || 'claude-code';
let _launchModel = storage.getItem('as-launch-model') || null;

// ── Preset Templates with Wizard Steps ──

const PRESET_TEMPLATES = [
  {
    id: '__preset_twitter',
    name: 'Twitter Outreach',
    description: 'Research-powered Twitter engagement. Recalls stored findings, navigates hashtags, and composes replies in assisted mode.',
    task: 'Browse Twitter/X using recalled research. Find relevant threads and compose thoughtful replies for human review.',
    context: 'ASSISTED MODE: Compose but never submit without user review. Use SynaBun browser tools only.',
    iterations: 5,
    maxMinutes: 45,
    icon: 'twitter',
    category: 'social',
    usesBrowser: true,
    steps: [
      {
        title: 'Research Source',
        subtitle: 'Where should the agent pull engagement targets from?',
        buildContent(state) {
          return `
            <div class="awiz-field">
              <label>Memory Category</label>
              <input type="text" data-key="researchCategory" placeholder="social-interactions" value="${esc(state.researchCategory || 'social-interactions')}" />
              <span class="awiz-hint">SynaBun memory category to recall research from</span>
            </div>
            <div class="awiz-field">
              <label>Filter Tags <span class="awiz-optional">(optional)</span></label>
              <input type="text" data-key="researchTags" placeholder="research, twitter, ai, vibecoding" value="${esc(state.researchTags || '')}" />
              <span class="awiz-hint">Comma-separated tags to narrow recall results</span>
            </div>
            <div class="awiz-field">
              <label>Fallback Hashtags</label>
              <input type="text" data-key="fallbackHashtags" placeholder="#vibecoding, #buildinpublic, #webdev" value="${esc(state.fallbackHashtags || '')}" />
              <span class="awiz-hint">Used if no research memories are found</span>
            </div>`;
        },
        validate(state) {
          if (!state.researchCategory?.trim() && !state.fallbackHashtags?.trim()) {
            return 'Enter a memory category or at least one fallback hashtag';
          }
          return null;
        },
      },
      {
        title: 'Persona',
        subtitle: 'Define the voice and personality for engagement',
        buildContent(state) {
          const lang = state.language || 'en';
          const formality = state.formality || 'balanced';
          const moods = state.mood || ['helpful', 'friendly'];
          const emoji = state.emojiUsage || 'minimal';
          const length = state.replyLength || 'medium';
          return `
            <div class="awiz-field">
              <label>Language</label>
              <div class="awiz-chips" data-key="language" data-mode="single">
                ${chip('PT-BR', lang, 'pt-br')}
                ${chip('English', lang, 'en')}
                ${chip('Spanish', lang, 'es')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Formality</label>
              <div class="awiz-chips" data-key="formality" data-mode="single">
                ${chip('Very Casual', formality, 'very-casual')}
                ${chip('Casual', formality, 'casual')}
                ${chip('Balanced', formality, 'balanced')}
                ${chip('Professional', formality, 'professional')}
                ${chip('Formal', formality, 'formal')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Mood</label>
              <div class="awiz-chips" data-key="mood" data-mode="multi">
                ${mchip('Helpful', moods, 'helpful')}
                ${mchip('Witty', moods, 'witty')}
                ${mchip('Curious', moods, 'curious')}
                ${mchip('Provocative', moods, 'provocative')}
                ${mchip('Technical', moods, 'technical')}
                ${mchip('Friendly', moods, 'friendly')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Emoji Usage</label>
              <div class="awiz-chips" data-key="emojiUsage" data-mode="single">
                ${chip('None', emoji, 'none')}
                ${chip('Minimal', emoji, 'minimal')}
                ${chip('Moderate', emoji, 'moderate')}
                ${chip('Heavy', emoji, 'heavy')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Reply Length</label>
              <div class="awiz-chips" data-key="replyLength" data-mode="single">
                ${chip('Short (1-2 sentences)', length, 'short')}
                ${chip('Medium (3-4 sentences)', length, 'medium')}
                ${chip('Long (paragraph)', length, 'long')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Voice Description <span class="awiz-optional">(optional)</span></label>
              <textarea data-key="voiceDescription" placeholder="e.g. Sound like a fellow developer who genuinely wants to help. Use first person. Share small personal anecdotes when relevant." rows="3">${esc(state.voiceDescription || '')}</textarea>
            </div>
            <div class="awiz-field">
              <label>Example Phrases <span class="awiz-optional">(optional)</span></label>
              <textarea data-key="examplePhrases" placeholder="e.g. 'Interesting approach! Have you tried...' or 'This is exactly what I needed for my project'" rows="3">${esc(state.examplePhrases || '')}</textarea>
              <span class="awiz-hint">Phrases for the agent to mimic in style and tone</span>
            </div>`;
        },
      },
      {
        title: 'Engagement',
        subtitle: 'What types of interactions should the agent perform?',
        buildContent(state) {
          const types = state.engagementTypes || ['reply', 'like'];
          return `
            <div class="awiz-field">
              <label>Engagement Types</label>
              <div class="awiz-chips" data-key="engagementTypes" data-mode="multi">
                ${mchip('Reply', types, 'reply')}
                ${mchip('Like', types, 'like')}
                ${mchip('Retweet', types, 'retweet')}
                ${mchip('Quote Tweet', types, 'quote')}
                ${mchip('Follow', types, 'follow')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Interactions Per Iteration</label>
              <input type="number" data-key="interactionCap" placeholder="5" value="${state.interactionCap || ''}" />
              <span class="awiz-hint">Max posts to interact with per iteration (default: 5)</span>
            </div>
            <div class="awiz-field">
              <label>Content to Avoid <span class="awiz-optional">(optional)</span></label>
              <input type="text" data-key="avoid" placeholder="politics, controversial takes, crypto shilling" value="${esc(state.avoid || '')}" />
            </div>`;
        },
        validate(state) {
          const types = state.engagementTypes;
          if (!Array.isArray(types) || types.length === 0) {
            return 'Select at least one engagement type';
          }
          return null;
        },
      },
      {
        title: 'Rules',
        subtitle: 'Behavioral constraints \u2014 order = priority',
        buildContent(state) {
          if (!Array.isArray(state.rules)) state.rules = [];
          const items = state.rules.map((rule, i) => `
            <div class="awiz-rule-item" draggable="true" data-rule-idx="${i}">
              <span class="awiz-rule-grip" title="Drag to reorder">\u2261</span>
              <span class="awiz-rule-num">${i + 1}</span>
              <span class="awiz-rule-text">${esc(rule)}</span>
              <button class="awiz-rule-remove" data-remove-idx="${i}" title="Remove">&times;</button>
            </div>`).join('');
          return `
            <div class="awiz-field">
              <div class="awiz-rule-add-row">
                <input type="text" id="awiz-rule-input" placeholder="e.g. Never be confrontational or dismissive" />
                <button class="awiz-rule-add-btn" id="awiz-rule-add">Add</button>
              </div>
              <div class="awiz-rules-list" id="awiz-rules-list">${items || '<div class="awiz-rules-empty">No rules yet. Add rules to guide engagement behavior.</div>'}</div>
              <span class="awiz-hint">Drag to reorder. Top rules have highest priority.</span>
            </div>`;
        },
        afterRender(container, state) { wireRulesListEvents(container, state); },
      },
    ],
    buildCommand(state) {
      const langMap = { 'pt-br': 'Brazilian Portuguese', 'en': 'English', 'es': 'Spanish' };
      const formalityMap = {
        'very-casual': 'very casual, like texting a friend',
        'casual': 'casual and relaxed',
        'balanced': 'balanced \u2014 conversational but clear',
        'professional': 'professional and polished',
        'formal': 'formal and measured',
      };
      const lengthMap = { 'short': '1-2 sentences max', 'medium': '3-4 sentences', 'long': 'up to a full paragraph' };
      const emojiMap = {
        'none': 'Do NOT use any emojis.',
        'minimal': 'Use emojis sparingly \u2014 at most 1 per reply.',
        'moderate': 'Use emojis naturally, 2-3 per reply where appropriate.',
        'heavy': 'Use emojis liberally to express emotion and emphasis.',
      };

      const lang = state.language || 'en';
      const formality = state.formality || 'balanced';
      const moods = state.mood || ['helpful', 'friendly'];
      const emoji = state.emojiUsage || 'minimal';
      const length = state.replyLength || 'medium';
      const cap = state.interactionCap || 5;
      const types = state.engagementTypes || ['reply', 'like'];
      const category = (state.researchCategory || 'social-interactions').trim();
      const tags = state.researchTags?.trim() || '';
      const fallback = state.fallbackHashtags?.trim() || '';
      const rules = Array.isArray(state.rules) && state.rules.length > 0
        ? state.rules.map((r, i) => `  ${i + 1}. ${r}`).join('\n') : null;

      const lines = [
        '=== TWITTER OUTREACH \u2014 ASSISTED MODE ===', '',
        'STEP 1 \u2014 RECALL RESEARCH:',
        `At the start of this iteration, call the SynaBun \`recall\` tool to retrieve engagement targets.`,
        `- Query: "twitter engagement targets hashtags users topics"`,
        `- Category: "${esc(category)}"`,
        tags ? `- Filter for memories tagged with: ${tags}` : '',
        'Parse the recalled memories for:',
        '  - Hashtag URLs (e.g. https://x.com/search?q=%23...)',
        '  - Specific user handles to engage with',
        '  - Topic summaries and engagement opportunities',
        fallback ? `If recall returns no results, fall back to these hashtags: ${fallback}` : 'If recall returns no results, skip this iteration and report that no research data was found.',
        '',
        'STEP 2 \u2014 NAVIGATE & FIND THREADS:',
        'Using the SynaBun browser tools (browser_navigate, browser_scroll, browser_extract_tweets, browser_click, browser_snapshot, browser_fill, browser_type):',
        '- Call browser_navigate with the hashtag search URL: https://x.com/search?q=%23HASHTAG&f=live (replace HASHTAG — use %23 not #)',
        '- Call browser_wait with loadState:"load" to wait for the feed',
        '- Call browser_extract_tweets to get structured JSON of all visible tweets (faster than browser_snapshot)',
        '- Call browser_scroll {direction:"down", distance:1200} to load more, then browser_extract_tweets again',
        '- Browse the feed and identify relevant, recent threads',
        `- Find up to ${cap} posts worth engaging with per iteration`,
        'IMPORTANT: Use ONLY SynaBun browser tools (browser_*). Do NOT use Playwright plugin tools.',
        '',
        'STEP 3 \u2014 ENGAGE:',
        `Engagement types: ${types.join(', ')}.`,
        state.avoid ? `Content to AVOID: ${state.avoid}.` : '',
        '',
        'PERSONA:',
        `Language: ${langMap[lang] || 'English'}. ALL replies MUST be written in ${langMap[lang] || 'English'}.`,
        `Formality: ${formalityMap[formality] || 'balanced'}.`,
        `Mood/personality: ${moods.join(', ')}.`,
        `Reply length: ${lengthMap[length] || '3-4 sentences'}.`,
        emojiMap[emoji] || '',
        state.voiceDescription ? `Voice notes: ${state.voiceDescription}` : '',
        state.examplePhrases ? `Mimic these example phrases in style:\n${state.examplePhrases}` : '',
        '',
        rules ? `RULES (ordered by priority \u2014 #1 is most important):\n${rules}` : '',
        '',
        '=== ASSISTED MODE (CRITICAL) ===',
        'This is ASSISTED mode. The profile owner must review every post before it goes live.',
        'For EVERY reply or quote tweet:',
        '  1. Navigate to the post',
        '  2. Click the reply button to open the reply box',
        '  3. Type your composed reply into the reply box',
        '  4. STOP. Do NOT click the submit/post/reply button.',
        '  5. Take a browser_screenshot so the user can see what you composed.',
        '  6. Report what you wrote and move on to the next post.',
        'The user will review your draft in the visual browser and decide whether to post it.',
        'For likes, retweets, and follows: these may be performed directly (no review needed).',
        '',
        `Interact with up to ${cap} posts per iteration.`,
        'Be authentic. Add genuine value. Never be spammy.',
      ];
      return lines.filter(Boolean).join('\n');
    },
  },
  {
    id: '__preset_codereview',
    name: 'Code Review',
    description: 'Scan codebase for issues, code smells, and improvement opportunities.',
    task: 'Review code for bugs, security issues, and performance problems.',
    context: 'Prioritize high-impact issues. Be constructive.',
    iterations: 10, maxMinutes: 45,
    icon: 'search', category: 'productivity', usesBrowser: false,
    steps: [
      {
        title: 'Target', subtitle: 'What code should Claude review?',
        buildContent(state) {
          const areas = state.focusAreas || ['bugs', 'security'];
          return `
            <div class="awiz-field">
              <label>Directory or File Path</label>
              <input type="text" data-key="targetPath" placeholder="src/components/ or src/lib/services/auth.ts" value="${esc(state.targetPath || '')}" />
              <span class="awiz-hint">Leave empty to scan the entire project</span>
            </div>
            <div class="awiz-field">
              <label>Language / Framework</label>
              <input type="text" data-key="techStack" placeholder="TypeScript, React, Next.js" value="${esc(state.techStack || '')}" />
            </div>
            <div class="awiz-field">
              <label>Focus Areas</label>
              <div class="awiz-chips" data-key="focusAreas" data-mode="multi">
                ${mchip('Bugs', areas, 'bugs')} ${mchip('Security', areas, 'security')}
                ${mchip('Performance', areas, 'performance')} ${mchip('Readability', areas, 'readability')}
              </div>
            </div>`;
        },
      },
      {
        title: 'Standards', subtitle: 'How thorough should the review be?',
        buildContent(state) {
          const severity = state.severity || 'all';
          return `
            <div class="awiz-field">
              <label>Severity Threshold</label>
              <div class="awiz-chips" data-key="severity" data-mode="single">
                ${chip('Critical Only', severity, 'critical')} ${chip('All Issues', severity, 'all')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Style Guide Notes <span class="awiz-optional">(optional)</span></label>
              <textarea data-key="styleNotes" placeholder="e.g. Follow ESLint config, prefer named exports" rows="3">${esc(state.styleNotes || '')}</textarea>
            </div>
            <div class="awiz-field">
              <label>Skip / Ignore <span class="awiz-optional">(optional)</span></label>
              <input type="text" data-key="skipPatterns" placeholder="test files, generated code" value="${esc(state.skipPatterns || '')}" />
            </div>`;
        },
      },
    ],
    buildCommand(state) {
      const lines = [
        state.targetPath ? `Review code in: ${state.targetPath}.` : 'Scan the codebase for issues.',
        state.techStack ? `Tech stack: ${state.techStack}.` : '',
        `Focus on: ${(state.focusAreas || ['bugs', 'security']).join(', ')}.`,
        `Severity: ${state.severity === 'critical' ? 'critical issues only' : 'all issues'}.`,
        state.styleNotes ? `Style guidelines: ${state.styleNotes}` : '',
        state.skipPatterns ? `Skip: ${state.skipPatterns}.` : '',
        'Document findings with file paths and line numbers. Suggest specific fixes.',
      ];
      return lines.filter(Boolean).join('\n');
    },
  },
  {
    id: '__preset_research',
    name: 'Content Research',
    description: 'Search topics, summarize findings, and collect useful references.',
    task: 'Research topics, summarize findings, collect references.',
    context: 'Focus on authoritative sources. Note conflicting viewpoints.',
    iterations: 8, maxMinutes: 30,
    icon: 'research', category: 'productivity', usesBrowser: true,
    steps: [
      {
        title: 'Topic', subtitle: 'Describe what Claude should research',
        buildContent(state) {
          const sources = state.sources || ['blogs', 'docs'];
          return `
            <div class="awiz-field">
              <label>Research Description</label>
              <textarea data-key="subject" placeholder="e.g. Find the latest WebSocket scaling patterns for Node.js." rows="4">${esc(state.subject || '')}</textarea>
            </div>
            <div class="awiz-field">
              <label>Source Preferences</label>
              <div class="awiz-chips" data-key="sources" data-mode="multi">
                ${mchip('Academic', sources, 'academic')} ${mchip('Blogs', sources, 'blogs')}
                ${mchip('Forums', sources, 'forums')} ${mchip('Docs', sources, 'docs')}
              </div>
            </div>`;
        },
        validate(state) { if (!state.subject?.trim()) return 'Describe what to research'; return null; },
      },
      {
        title: 'Rules', subtitle: 'Define rules for the research \u2014 order = priority',
        buildContent(state) {
          if (!Array.isArray(state.rules)) state.rules = [];
          const items = state.rules.map((rule, i) => `
            <div class="awiz-rule-item" draggable="true" data-rule-idx="${i}">
              <span class="awiz-rule-grip" title="Drag to reorder">\u2261</span>
              <span class="awiz-rule-num">${i + 1}</span>
              <span class="awiz-rule-text">${esc(rule)}</span>
              <button class="awiz-rule-remove" data-remove-idx="${i}" title="Remove">&times;</button>
            </div>`).join('');
          return `
            <div class="awiz-field">
              <div class="awiz-rule-add-row">
                <input type="text" id="awiz-rule-input" placeholder="e.g. Only use sources from the last 2 years" />
                <button class="awiz-rule-add-btn" id="awiz-rule-add">Add</button>
              </div>
              <div class="awiz-rules-list" id="awiz-rules-list">${items || '<div class="awiz-rules-empty">No rules yet.</div>'}</div>
              <span class="awiz-hint">Drag to reorder. Top rules have highest priority.</span>
            </div>`;
        },
        afterRender(container, state) { wireRulesListEvents(container, state); },
      },
      {
        title: 'Output', subtitle: 'How should findings be formatted?',
        buildContent(state) {
          const format = state.outputFormat || 'bullets';
          const depth = state.depth || 'moderate';
          return `
            <div class="awiz-field">
              <label>Format</label>
              <div class="awiz-chips" data-key="outputFormat" data-mode="single">
                ${chip('Bullet Summary', format, 'bullets')} ${chip('Detailed Notes', format, 'detailed')} ${chip('Annotated Links', format, 'links')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Depth</label>
              <div class="awiz-chips" data-key="depth" data-mode="single">
                ${chip('Quick Scan', depth, 'quick')} ${chip('Moderate', depth, 'moderate')} ${chip('Deep Dive', depth, 'deep')}
              </div>
            </div>`;
        },
      },
      {
        title: 'Memory Storage', subtitle: 'Where should findings be saved in SynaBun?',
        buildContent(state) {
          return `
            <div class="awiz-field">
              <label>Research Name</label>
              <input type="text" data-key="researchName" placeholder="e.g. WebSocket Scaling Patterns" value="${esc(state.researchName || '')}" />
              <span class="awiz-hint">A short name to identify this research batch</span>
            </div>
            <div class="awiz-field">
              <label>Category</label>
              <input type="text" data-key="researchCategory" placeholder="e.g. websocket-scaling" value="${esc(state.researchCategory || '')}" />
              <span class="awiz-hint">Child category under <strong>research</strong></span>
            </div>`;
        },
        validate(state) {
          if (!state.researchName?.trim()) return 'Give this research a name';
          if (!state.researchCategory?.trim()) return 'Choose a category for the findings';
          return null;
        },
      },
    ],
    buildCommand(state) {
      const cat = (state.researchCategory || 'general').trim().toLowerCase().replace(/\s+/g, '-');
      const rules = Array.isArray(state.rules) && state.rules.length > 0
        ? state.rules.map((r, i) => `  ${i + 1}. ${r}`).join('\n') : null;
      const lines = [
        `Research: ${state.subject || 'the assigned topic'}.`,
        rules ? `RULES (ordered by priority \u2014 #1 is most important):\n${rules}` : '',
        `Preferred sources: ${(state.sources || ['blogs', 'docs']).join(', ')}.`,
        `Output format: ${state.outputFormat === 'detailed' ? 'detailed notes' : state.outputFormat === 'links' ? 'annotated links' : 'bullet summaries'}.`,
        `Depth: ${state.depth === 'deep' ? 'deep dive' : state.depth === 'quick' ? 'quick scan' : 'moderate'}.`,
        'Use browser tools to search the web. Prioritize authoritative sources.', '',
        'MEMORY STORAGE (MANDATORY):',
        `After each iteration, store your findings using the SynaBun \`remember\` tool with these EXACT parameters:`,
        `- category: "${cat}"`,
        `- tags: ["research", "${esc(state.researchName || 'unnamed').toLowerCase().replace(/\s+/g, '-')}"]`,
        `- importance: 7`,
        `- Content: Include the research name "${esc(state.researchName || '')}" as a header, then your findings for that iteration.`,
        `If category "${cat}" does not exist, first call the \`category\` tool with action "create", name "${cat}", parent "research".`,
        'Do NOT skip the memory storage step. Every iteration MUST produce at least one memory entry.',
      ];
      return lines.filter(Boolean).join('\n');
    },
  },
  {
    id: '__preset_monitoring',
    name: 'Site Monitoring',
    description: 'Check URLs for changes, errors, and performance issues.',
    task: 'Check sites for uptime, errors, and visual changes.',
    context: 'Record response times. Screenshot regressions.',
    iterations: 5, maxMinutes: 15,
    icon: 'chart', category: 'monitoring', usesBrowser: true,
    steps: [
      {
        title: 'Targets', subtitle: 'What URLs should Claude monitor?',
        buildContent(state) {
          const checks = state.checks || ['uptime', 'performance'];
          return `
            <div class="awiz-field">
              <label>URLs to Monitor</label>
              <textarea data-key="urls" placeholder="https://example.com\nhttps://api.example.com/health" rows="4">${esc(state.urls || '')}</textarea>
              <span class="awiz-hint">One URL per line</span>
            </div>
            <div class="awiz-field">
              <label>What to Check</label>
              <div class="awiz-chips" data-key="checks" data-mode="multi">
                ${mchip('Uptime', checks, 'uptime')} ${mchip('Visual Changes', checks, 'visual')}
                ${mchip('Performance', checks, 'performance')} ${mchip('SSL', checks, 'ssl')}
              </div>
            </div>`;
        },
        validate(state) { if (!state.urls?.trim()) return 'Enter at least one URL'; return null; },
      },
      {
        title: 'Alerts', subtitle: 'What thresholds and behaviors to use?',
        buildContent(state) {
          return `
            <div class="awiz-field">
              <label>Response Time Threshold (ms)</label>
              <input type="number" data-key="threshold" placeholder="3000" value="${state.threshold || ''}" />
              <span class="awiz-hint">Flag pages slower than this (default: 3000ms)</span>
            </div>
            <div class="awiz-field">
              <label>Screenshot on Change</label>
              <div class="awiz-chips" data-key="screenshotOnChange" data-mode="single">
                ${chip('Yes', state.screenshotOnChange ?? 'yes', 'yes')} ${chip('No', state.screenshotOnChange, 'no')}
              </div>
            </div>`;
        },
      },
    ],
    buildCommand(state) {
      const lines = [
        `Monitor these URLs:\n${state.urls || '(none specified)'}`,
        `Check for: ${(state.checks || ['uptime', 'performance']).join(', ')}.`,
        state.threshold ? `Flag responses slower than ${state.threshold}ms.` : '',
        (state.screenshotOnChange ?? 'yes') === 'yes' ? 'Take screenshots on visual changes.' : '',
        'Use browser tools to visit each URL. Report issues with evidence.',
      ];
      return lines.filter(Boolean).join('\n');
    },
  },
  {
    id: '__preset_inbox',
    name: 'Inbox Triage',
    description: 'Process messages, categorize by priority, and draft replies.',
    task: 'Triage inbox: categorize by urgency, draft replies.',
    context: 'Be concise. Prioritize time-sensitive items.',
    iterations: 10, maxMinutes: 30,
    icon: 'mail', category: 'productivity', usesBrowser: false,
    steps: [
      {
        title: 'Source', subtitle: 'Where are the messages coming from?',
        buildContent(state) {
          const platform = state.inboxPlatform || 'email';
          return `
            <div class="awiz-field">
              <label>Platform</label>
              <div class="awiz-chips" data-key="inboxPlatform" data-mode="single">
                ${chip('Email', platform, 'email')} ${chip('Slack', platform, 'slack')}
                ${chip('Discord', platform, 'discord')} ${chip('GitHub', platform, 'github')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Priority Rules <span class="awiz-optional">(optional)</span></label>
              <textarea data-key="priorityRules" placeholder="e.g. Messages from @boss are always urgent" rows="3">${esc(state.priorityRules || '')}</textarea>
            </div>
            <div class="awiz-field">
              <label>Auto-Reply</label>
              <div class="awiz-chips" data-key="autoReply" data-mode="single">
                ${chip('Draft Only', state.autoReply || 'draft', 'draft')}
                ${chip('Auto-Send Low Priority', state.autoReply, 'auto-low')}
              </div>
            </div>`;
        },
      },
      {
        title: 'Actions', subtitle: 'What should Claude do with each message?',
        buildContent(state) {
          const draftStyle = state.draftStyle || 'concise';
          return `
            <div class="awiz-field">
              <label>Draft Style</label>
              <div class="awiz-chips" data-key="draftStyle" data-mode="single">
                ${chip('Concise', draftStyle, 'concise')} ${chip('Detailed', draftStyle, 'detailed')} ${chip('Friendly', draftStyle, 'friendly')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Escalation Rules <span class="awiz-optional">(optional)</span></label>
              <textarea data-key="escalation" placeholder="e.g. Escalate billing issues to finance" rows="3">${esc(state.escalation || '')}</textarea>
            </div>`;
        },
      },
    ],
    buildCommand(state) {
      const lines = [
        `Triage ${state.inboxPlatform || 'email'} inbox.`,
        'Categorize each message: urgent, normal, low.',
        state.priorityRules ? `Priority rules:\n${state.priorityRules}` : '',
        `Reply mode: ${state.autoReply === 'auto-low' ? 'auto-send low-priority, draft rest' : 'draft only'}.`,
        `Draft style: ${state.draftStyle || 'concise'}.`,
        state.escalation ? `Escalation:\n${state.escalation}` : '',
        'Flag items requiring human decision.',
      ];
      return lines.filter(Boolean).join('\n');
    },
  },
];

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function chip(label, currentVal, value) {
  const v = value ?? label;
  const active = (typeof currentVal === 'string' && currentVal.toLowerCase() === v.toLowerCase()) ? 'active' : '';
  return `<button class="awiz-chip ${active}" data-value="${esc(v)}">${esc(label)}</button>`;
}

function mchip(label, currentArr, value) {
  const active = Array.isArray(currentArr) && currentArr.includes(value) ? 'active' : '';
  return `<button class="awiz-chip ${active}" data-value="${esc(value)}">${esc(label)}</button>`;
}

function showToast(msg) {
  const existing = document.querySelector('.as-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'as-toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 2000);
}

function formatLoopCommand(taskText, state) {
  const lines = ['Start a loop with these settings:', `Task: ${taskText}`];
  if (state.usesBrowser) {
    lines.push('', 'BROWSER: This automation REQUIRES the SynaBun internal browser.',
      'Use ONLY SynaBun browser tools (browser_navigate, browser_go_back, browser_go_forward, browser_reload, browser_click, browser_fill, browser_type, browser_hover, browser_select, browser_press, browser_scroll, browser_upload, browser_snapshot, browser_content, browser_screenshot, browser_evaluate, browser_wait, browser_session, browser_extract_tweets, browser_extract_fb_posts, browser_extract_tiktok_videos, browser_extract_tiktok_search, browser_extract_tiktok_studio, browser_extract_tiktok_profile, browser_extract_wa_chats, browser_extract_wa_messages, browser_extract_ig_feed, browser_extract_ig_profile, browser_extract_ig_post, browser_extract_ig_reels, browser_extract_ig_search, browser_extract_li_feed, browser_extract_li_profile, browser_extract_li_post, browser_extract_li_notifications, browser_extract_li_messages, browser_extract_li_search_people, browser_extract_li_network).',
      'Start by calling browser_navigate with your target URL — it auto-creates a session.',
      'NEVER use Playwright plugin tools or WebFetch — they bypass the visible browser.');
  }
  lines.push(`Iterations: ${state.iterations}`);
  lines.push(`Time cap: ${state.maxMinutes} minutes`);
  return lines.join('\n');
}

const BROWSER_CONTEXT = 'BROWSER REQUIRED: Use ONLY SynaBun browser tools: browser_navigate, browser_go_back, browser_go_forward, browser_reload, browser_click, browser_fill, browser_type, browser_hover, browser_select, browser_press, browser_scroll, browser_upload, browser_snapshot, browser_content, browser_screenshot, browser_evaluate, browser_wait, browser_session, browser_extract_tweets, browser_extract_fb_posts, browser_extract_tiktok_videos, browser_extract_tiktok_search, browser_extract_tiktok_studio, browser_extract_tiktok_profile, browser_extract_wa_chats, browser_extract_wa_messages, browser_extract_ig_feed, browser_extract_ig_profile, browser_extract_ig_post, browser_extract_ig_reels, browser_extract_ig_search, browser_extract_li_feed, browser_extract_li_profile, browser_extract_li_post, browser_extract_li_notifications, browser_extract_li_messages, browser_extract_li_search_people, browser_extract_li_network. Start by calling browser_navigate with your target URL — it auto-creates a session. NEVER use Playwright plugin tools or WebFetch.';

// ── Launch dialog ──
// Instead of launching immediately, show a confirmation dialog where the user picks CLI + model

let _pendingLaunchParams = null; // stashed params while dialog is open
// Browser mode removed — automations use saved browser settings directly

function showLaunchDialog(params) {
  // Enforce browser context before stashing
  if (params.usesBrowser && (!params.context || !params.context.includes('BROWSER REQUIRED'))) {
    params.context = BROWSER_CONTEXT;
  }
  _pendingLaunchParams = params;

  // Remove any existing dialog
  _panel?.querySelector('.as-launch-dialog')?.remove();

  const profile = _launchProfile || 'claude-code';
  const models = CLI_MODELS[profile] || [];
  const defaultModel = models.find(m => m.tier === 'default') || models[0];
  const currentModel = _launchModel && models.some(m => m.id === _launchModel) ? _launchModel : defaultModel?.id;

  const iterCount = params.iterations || 10;
  const timeCount = params.maxMinutes || 30;

  const html = `
    <div class="as-launch-dialog">
      <div class="as-launch-dialog-inner">
        <div class="as-launch-dialog-header">
          <span class="as-launch-dialog-title">Launch</span>
          <button class="as-launch-dialog-close" data-action="launch-dialog-close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M11 3L3 11M3 3l8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="as-launch-dialog-body">
          <div class="as-launch-section">
            <label class="as-launch-label">Agent</label>
            <div class="as-launch-profiles" id="as-launch-profiles">
              ${CLI_PROFILES.map(p => `
                <button class="as-launch-profile${p.id === profile ? ' active' : ''}" data-profile="${p.id}">
                  <span class="as-launch-profile-name">${p.label}</span>
                  <span class="as-launch-profile-org">${p.desc}</span>
                </button>
              `).join('')}
            </div>
          </div>
          <div class="as-launch-section" id="as-launch-model-section">
            <label class="as-launch-label">Model</label>
            <div class="as-launch-models" id="as-launch-models">
              ${renderModelChips(profile, currentModel)}
            </div>
          </div>
          <div class="as-launch-section as-launch-summary">
            <div class="as-launch-summary-row">
              <span class="as-launch-summary-key">Task</span>
              <span class="as-launch-summary-val as-launch-summary-task">${esc((params.task || '').slice(0, 100))}${(params.task || '').length > 100 ? '\u2026' : ''}</span>
            </div>
            <div class="as-launch-summary-row">
              <span class="as-launch-summary-key">Iterations</span>
              <span class="as-launch-summary-val">${iterCount}</span>
            </div>
            <div class="as-launch-summary-row">
              <span class="as-launch-summary-key">Time cap</span>
              <span class="as-launch-summary-val">${timeCount} min</span>
            </div>
            ${params.usesBrowser ? `<div class="as-launch-summary-row"><span class="as-launch-summary-key">Browser</span><span class="as-launch-summary-val">Yes &mdash; uses your Browser settings</span></div>` : ''}
          </div>
        </div>
        <div class="as-launch-dialog-footer">
          <button class="as-launch-cancel" data-action="launch-dialog-close">Cancel</button>
          <button class="as-launch-go" data-action="launch-dialog-confirm" id="as-launch-confirm-btn">
            Launch
          </button>
        </div>
      </div>
    </div>
  `;

  _panel.insertAdjacentHTML('beforeend', html);
  wireLaunchDialog();
}

function renderModelChips(profileId, selectedModel) {
  const models = CLI_MODELS[profileId] || [];
  if (!models.length) return '<span class="as-launch-no-models">No model selection available</span>';
  return models.map(m => `
    <button class="as-launch-model${m.id === selectedModel ? ' active' : ''}${m.tier ? ` as-launch-model--${m.tier}` : ''}" data-model="${m.id}">
      <span class="as-launch-model-name">${m.label}</span>
      <span class="as-launch-model-desc">${m.desc}</span>
    </button>
  `).join('');
}

function wireLaunchDialog() {
  const dialog = _panel?.querySelector('.as-launch-dialog');
  if (!dialog) return;

  // Profile selection
  dialog.querySelectorAll('.as-launch-profile').forEach(btn => {
    btn.addEventListener('click', () => {
      dialog.querySelectorAll('.as-launch-profile').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const profileId = btn.dataset.profile;
      _launchProfile = profileId;
      storage.setItem('as-launch-profile', profileId);

      // Update models for selected profile
      const models = CLI_MODELS[profileId] || [];
      const defaultModel = models.find(m => m.tier === 'default') || models[0];
      _launchModel = defaultModel?.id || null;
      storage.setItem('as-launch-model', _launchModel);
      const modelsContainer = dialog.querySelector('#as-launch-models');
      if (modelsContainer) {
        modelsContainer.innerHTML = renderModelChips(profileId, _launchModel);
        wireModelChips(dialog);
      }
    });
  });

  wireModelChips(dialog);

  // Close on backdrop click
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) closeLaunchDialog();
  });

  // Escape key
  const escHandler = (e) => {
    if (e.key === 'Escape') { closeLaunchDialog(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);
}

function wireModelChips(dialog) {
  dialog.querySelectorAll('.as-launch-model').forEach(btn => {
    btn.addEventListener('click', () => {
      dialog.querySelectorAll('.as-launch-model').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _launchModel = btn.dataset.model;
      storage.setItem('as-launch-model', _launchModel);
    });
  });
}

function closeLaunchDialog() {
  _panel?.querySelector('.as-launch-dialog')?.remove();
  _pendingLaunchParams = null;
}

async function confirmLaunch() {
  if (!_pendingLaunchParams) return;
  const params = { ..._pendingLaunchParams, profile: _launchProfile, model: _launchModel };
  closeLaunchDialog();

  try {
    // If automation needs a browser, ensure one is open before launching the loop.
    // Check if a session already exists (user may have opened one from Apps menu).
    // Only create a new one if none exist.
    if (params.usesBrowser) {
      let hasBrowser = false;
      try {
        const existing = await fetchBrowserSessions();
        const sessions = existing?.sessions || [];
        hasBrowser = sessions.length > 0;
      } catch { /* assume none */ }

      if (!hasBrowser) {
        showToast('Opening browser...');
        // Wait for the browser session to be created (server broadcasts sync:browser:created)
        const browserReady = new Promise((resolve) => {
          const unsub = on('sync:browser:created', () => { unsub(); resolve(); });
          // Timeout fallback — don't block forever if browser fails
          setTimeout(() => { unsub(); resolve(); }, 12000);
        });
        // Use force=true to bypass _opening guard (may be stuck from a previous failed attempt)
        // Don't use fresh=true — that destroys existing sessions
        emit('browser:open', { url: 'about:blank', force: true });
        await browserReady;
      } else {
        showToast('Using existing browser session...');
      }
    }

    showToast('Launching loop...');
    const result = await launchLoop(params);
    if (!result?.ok) { showToast(result?.error || 'Failed to launch loop'); return; }
    emit('terminal:attach-floating', {
      terminalSessionId: result.terminalSessionId,
      profile: params.profile || 'claude-code',
      initialMessage: '[SynaBun Loop] Begin task.',
      autoSubmit: true,
    });
    const profileLabel = CLI_PROFILES.find(p => p.id === params.profile)?.label || params.profile;
    showToast(`Loop started — ${profileLabel} launching...`);
  } catch (err) { showToast('Launch failed: ' + (err.message || 'unknown error')); }
}

// Backward-compatible wrapper — all call sites use this, it now shows the dialog
async function serverLaunchLoop(params) {
  showLaunchDialog(params);
}

function relativeTime(dateStr) {
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function buildTemplateCommand(template) {
  const isPreset = template.id?.startsWith('__preset_');
  if (isPreset && template.buildCommand) {
    return template.buildCommand(template._lastState || {});
  }
  let cmd = template.task || '';
  if (template.context) cmd += '\n\n' + template.context;
  return cmd;
}

// ═══════════════════════════════════════════
// PANEL LIFECYCLE
// ═══════════════════════════════════════════

export function initAutomationStudio() {
  on('automations:open', () => openPanel());
  on('automations:open-wizard', () => { openPanel(); });
  on('automations:import', () => { openPanel().then(() => triggerImport()); });
}

async function openPanel() {
  if (isGuest() && !hasPermission('automations')) {
    showGuestToast('Automation Studio is disabled by the host');
    return;
  }
  if (_panel) { _panel.focus(); return; }

  _panel = document.createElement('div');
  _panel.className = 'automation-studio-panel glass resizable';
  _panel.id = 'automation-studio-panel';
  _panel.innerHTML = buildPanelHTML();
  document.body.appendChild(_panel);

  try {
    const saved = JSON.parse(storage.getItem(PANEL_KEY));
    if (saved) {
      if (saved.x != null) _panel.style.left = saved.x + 'px';
      if (saved.y != null) _panel.style.top = Math.max(48, saved.y) + 'px';
      if (saved.w) _panel.style.width = saved.w + 'px';
      if (saved.h) _panel.style.height = saved.h + 'px';
    }
  } catch {}

  if (!_panel.style.left) {
    const vw = window.innerWidth, vh = window.innerHeight;
    _panel.style.left = Math.max(20, (vw - 980) / 2) + 'px';
    _panel.style.top = Math.max(48, (vh - 640) / 2) + 'px';
  }

  wirePanel();
  await loadData();
  renderView();
  requestAnimationFrame(() => _panel.classList.add('open'));
  startPolling();
}

function closePanel() {
  if (!_panel) return;
  try {
    const rect = _panel.getBoundingClientRect();
    storage.setItem(PANEL_KEY, JSON.stringify({
      x: Math.round(rect.left), y: Math.round(rect.top),
      w: Math.round(rect.width), h: Math.round(rect.height),
    }));
  } catch {}

  stopPolling();
  _panel.remove(); _panel = null;
  _templates = []; _activeLoop = null; _history = [];
  _view = 'welcome'; _selected = null;
  resetDirty(); _editorContent = ''; _originalContent = '';
  _previewMode = false; _focusMode = false;
  _wizardState = null; _wizardStep = 0; _wizardPreset = null;
  _prevLoopActive = false; _fetchSeq = 0;
}

function buildPanelHTML() {
  return `
    <div class="resize-handle resize-handle-t" data-resize="t"></div>
    <div class="resize-handle resize-handle-r" data-resize="r"></div>
    <div class="resize-handle resize-handle-b" data-resize="b"></div>
    <div class="resize-handle resize-handle-l" data-resize="l"></div>
    <div class="resize-handle resize-handle-tl" data-resize="tl"></div>
    <div class="resize-handle resize-handle-tr" data-resize="tr"></div>
    <div class="resize-handle resize-handle-bl" data-resize="bl"></div>
    <div class="resize-handle resize-handle-br" data-resize="br"></div>

    <div class="as-header drag-handle" data-drag="automation-studio-panel">
      <div class="as-header-left">
        <h3>Automation Studio</h3>
        <span class="as-count" id="as-total-count"></span>
        <span class="as-active-badge" id="as-active-badge" style="display:none">
          <span class="as-running-pulse"></span>
          <span id="as-active-badge-name"></span>
        </span>
      </div>
      <div class="as-header-actions">
        <button class="as-header-btn" id="as-history-btn">History</button>
        <button class="as-header-btn" id="as-new-btn">+ New</button>
        <button class="as-header-btn" id="as-import-btn">Import</button>
      </div>
      <button class="as-focus-btn" id="as-focus" data-tooltip="Focus mode">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
          <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
      <button class="as-close" id="as-close">&times;</button>
    </div>

    <div class="as-body">
      <aside class="as-sidebar" id="as-sidebar">
        <div class="as-search-wrap">
          <input type="text" class="as-search" id="as-search" placeholder="Filter..." autocomplete="off" spellcheck="false">
        </div>
        <div class="as-filters">
          <button class="as-filter active" data-cat="all">All</button>
          <button class="as-filter" data-cat="social">Social</button>
          <button class="as-filter" data-cat="productivity">Productivity</button>
          <button class="as-filter" data-cat="monitoring">Monitoring</button>
          <button class="as-filter" data-cat="custom">Custom</button>
        </div>
        <div class="as-template-list" id="as-template-list"></div>
        <div class="as-sidebar-footer" id="as-sidebar-footer" style="display:none">
          <div class="as-loop-indicator" data-action="view-running">
            <span class="as-running-pulse"></span>
            <div class="as-loop-indicator-info">
              <span class="as-loop-indicator-name" id="as-loop-indicator-name">Loop Active</span>
              <span class="as-loop-indicator-detail" id="as-loop-indicator-detail"></span>
            </div>
            <button class="as-loop-stop-mini" data-action="force-stop" title="Stop">\u25A0</button>
          </div>
        </div>
      </aside>
      <main class="as-main" id="as-main"></main>
    </div>
  `;
}

function wirePanel() {
  $('as-close')?.addEventListener('click', closePanel);
  $('as-new-btn')?.addEventListener('click', () => { _view = 'picker'; _selected = null; renderView(); });
  $('as-import-btn')?.addEventListener('click', () => triggerImport());
  $('as-history-btn')?.addEventListener('click', () => { _view = 'history'; renderView(); });

  $('as-focus')?.addEventListener('click', () => {
    _focusMode = !_focusMode;
    $('as-focus')?.classList.toggle('active', _focusMode);
  });

  $('as-search')?.addEventListener('input', (e) => {
    _searchQuery = e.target.value.toLowerCase();
    renderSidebar();
  });

  _panel.querySelectorAll('.as-filter[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      _filterCategory = btn.dataset.cat;
      _panel.querySelectorAll('.as-filter[data-cat]').forEach(b => b.classList.toggle('active', b === btn));
      renderSidebar();
    });
  });

  // Delegated click handler for all data-action buttons
  _panel.addEventListener('click', (e) => handlePanelClick(e));

  // Escape key
  const onEsc = (e) => {
    if (e.key === 'Escape' && _panel) {
      if (_view === 'wizard') { _view = _selected ? 'detail' : 'welcome'; renderView(); return; }
      if (_view === 'detail' || _view === 'history' || _view === 'running' || _view === 'picker') {
        if (_detailDirty && !confirm('Discard unsaved changes?')) return;
        _view = 'welcome'; _selected = null; resetDirty(); renderView(); return;
      }
      closePanel();
      document.removeEventListener('keydown', onEsc);
    }
  };
  document.addEventListener('keydown', onEsc);
  _panel._onEsc = onEsc;

  initDrag();
}

// ═══════════════════════════════════════════
// DRAG SUPPORT
// ═══════════════════════════════════════════

function initDrag() {
  const handle = _panel.querySelector('.drag-handle');
  if (!handle) return;
  let dragging = false, startX, startY, startLeft, startTop;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.target.closest('input')) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    const rect = _panel.getBoundingClientRect();
    startLeft = rect.left; startTop = rect.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    _panel.style.left = (startLeft + e.clientX - startX) + 'px';
    _panel.style.top = (startTop + e.clientY - startY) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

// ═══════════════════════════════════════════
// DATA LOADING & POLLING
// ═══════════════════════════════════════════

async function loadData() {
  try { _templates = await fetchLoopTemplates(); } catch { _templates = []; }
  try { _activeLoop = await fetchActiveLoop(); } catch { _activeLoop = null; }
  updateHeaderBadge();
  updateSidebarFooter();
}

function startPolling() {
  stopPolling();
  _pollTimer = setInterval(async () => {
    if (!_panel) { stopPolling(); return; }
    try {
      const prev = _activeLoop?.active;
      _activeLoop = await fetchActiveLoop();
      updateHeaderBadge();
      updateSidebarFooter();

      if (prev && !_activeLoop?.active) {
        _prevLoopActive = false;
        try {
          const history = await fetchLoopHistory(5);
          const latest = Array.isArray(history) ? history[0] : null;
          if (latest?.task) {
            const elapsed = latest.startedAt && latest.finishedAt
              ? Math.round((new Date(latest.finishedAt) - new Date(latest.startedAt)) / 60000) : null;
            await storeLoopCompletion({
              task: latest.task, context: latest.context || null, template: latest.template || null,
              iterations: `${latest.completedIterations ?? 0}/${latest.totalIterations ?? '?'}`,
              duration: elapsed != null ? `${elapsed}min` : '?',
              tags: ['automation', 'loop', latest.stopped ? 'stopped' : 'completed'],
            });
          }
        } catch { /* best-effort */ }
      }
      if (_view === 'running') renderRunningMain();
    } catch {}
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function updateHeaderBadge() {
  const badge = $('as-active-badge');
  const nameEl = $('as-active-badge-name');
  const active = _activeLoop?.active;
  if (badge) badge.style.display = active ? '' : 'none';
  if (active && nameEl) {
    nameEl.textContent = (_activeLoop.task || 'Loop').slice(0, 30);
  }
}

function updateSidebarFooter() {
  const footer = $('as-sidebar-footer');
  const active = _activeLoop?.active;
  if (footer) footer.style.display = active ? '' : 'none';
  if (active && _activeLoop) {
    const nameEl = $('as-loop-indicator-name');
    const detailEl = $('as-loop-indicator-detail');
    if (nameEl) nameEl.textContent = (_activeLoop.task || 'Loop Active').slice(0, 40);
    if (detailEl) detailEl.textContent = `${_activeLoop.currentIteration || 0}/${_activeLoop.totalIterations} iterations`;
  }
}

// ═══════════════════════════════════════════
// VIEW MACHINE
// ═══════════════════════════════════════════

function renderView() {
  renderSidebar();
  const count = $('as-total-count');
  if (count) count.textContent = `${PRESET_TEMPLATES.length + _templates.length}`;

  switch (_view) {
    case 'welcome': renderWelcomeMain(); break;
    case 'picker': renderPickerMain(); break;
    case 'detail': renderDetailMain(); break;
    case 'wizard': renderWizardMain(); break;
    case 'running': renderRunningMain(); break;
    case 'history': renderHistoryMain(); break;
  }
}

function filterTemplates(all) {
  return all.filter(t => {
    if (_filterCategory !== 'all' && t.category !== _filterCategory) return false;
    if (_searchQuery && !t.name.toLowerCase().includes(_searchQuery) && !t.description?.toLowerCase().includes(_searchQuery)) return false;
    return true;
  });
}

// ── Sidebar ──

function renderSidebar() {
  const list = $('as-template-list');
  if (!list) return;

  const all = [...PRESET_TEMPLATES, ..._templates];
  const filtered = filterTemplates(all);

  const groups = {};
  for (const t of filtered) {
    const cat = t.category || 'custom';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(t);
  }

  let html = '';
  for (const [cat, items] of Object.entries(groups)) {
    html += `<div class="as-sidebar-group">
      <div class="as-sidebar-group-header">
        ${CATEGORY_LABELS[cat] || cat}
        <span class="as-sidebar-group-count">${items.length}</span>
      </div>`;
    for (const t of items) {
      const active = _selected?.id === t.id ? ' active' : '';
      const isPreset = t.id.startsWith('__preset_');
      const dot = isPreset ? '<span class="as-item-preset-dot"></span>' : '<span class="as-item-custom-dot"></span>';
      html += `<div class="as-sidebar-item${active}" data-action="open-detail" data-id="${t.id}">
        <div class="as-sidebar-icon">${icon(t.icon)}</div>
        <div class="as-sidebar-info">
          <div class="as-sidebar-name">${dot}${esc(t.name)}</div>
          <div class="as-sidebar-desc">${t.iterations}x \u00B7 ${t.maxMinutes}m${t.usesBrowser ? ' \u00B7 <span class="as-browser-dot"></span>' : ''}</div>
        </div>
      </div>`;
    }
    html += '</div>';
  }

  if (!filtered.length) html = '<div class="as-empty">No templates match your filter.</div>';
  list.innerHTML = html;
}

// ── Welcome ──

function renderWelcomeMain() {
  const main = $('as-main');
  if (!main) return;
  const presetCount = PRESET_TEMPLATES.length;
  const customCount = _templates.length;

  main.innerHTML = `
    <div class="as-welcome">
      <div class="as-welcome-hero">
        <img src="synabun.png?v=2" alt="SynaBun" class="as-welcome-logo">
        <h2>Automation Studio</h2>
      </div>
      <p class="as-welcome-sub">Launch, edit, and track loop automations.</p>
      <div class="as-stats-row">
        <div class="as-stat">
          <span class="as-stat-num">${presetCount}</span>
          <span class="as-stat-label">Presets</span>
        </div>
        <div class="as-stat">
          <span class="as-stat-num">${customCount}</span>
          <span class="as-stat-label">Custom</span>
        </div>
      </div>
      <p class="as-welcome-hint">Select a template from the sidebar, or click + New to create one.</p>
    </div>
  `;
}

// ── Preset Picker (+ New) ──

function renderPickerMain() {
  const main = $('as-main');
  if (!main) return;

  const cards = PRESET_TEMPLATES.map(t => `
    <div class="as-picker-card" data-action="pick-preset" data-id="${t.id}">
      <div class="as-picker-icon">${icon(t.icon)}</div>
      <div class="as-picker-name">${esc(t.name)}</div>
      <div class="as-picker-desc">${esc(t.description)}</div>
      <div class="as-picker-meta">
        <span class="as-badge">${t.iterations}x</span>
        <span class="as-badge">${t.maxMinutes}m</span>
        ${t.usesBrowser ? '<span class="as-badge as-badge--browser">Browser</span>' : ''}
      </div>
    </div>
  `).join('');

  main.innerHTML = `
    <div class="as-picker">
      <div class="as-picker-header">
        <button class="as-back-btn" data-action="go-welcome">\u2190 Back</button>
        <h3>Choose a Starting Point</h3>
      </div>
      <p class="as-picker-sub">Pick a preset to configure with a guided wizard, or start from scratch.</p>
      <div class="as-picker-grid">
        ${cards}
        <div class="as-picker-card as-picker-card--blank" data-action="pick-blank">
          <div class="as-picker-icon as-picker-icon--blank">${AS_ICONS.plus}</div>
          <div class="as-picker-name">Blank</div>
          <div class="as-picker-desc">Start from scratch with an empty template.</div>
        </div>
      </div>
    </div>
  `;
}

// ── Detail/Editor View ──

function switchToDetail(template) {
  if (_detailDirty && _selected && _selected.id !== template.id) {
    if (!confirm('Discard unsaved changes?')) return;
  }
  const seq = ++_fetchSeq;
  _selected = template;
  _editorContent = buildTemplateCommand(template);
  _originalContent = _editorContent;
  resetDirty();
  _previewMode = false;
  _view = 'detail';
  if (seq !== _fetchSeq) return;
  renderView();
}

function renderDetailMain() {
  const main = $('as-main');
  if (!main || !_selected) return;
  const t = _selected;
  const isPreset = t.id.startsWith('__preset_');

  main.innerHTML = `
    <div class="as-detail-header">
      <button class="as-back-btn" data-action="go-welcome">\u2190 Templates</button>
      <span class="as-detail-icon">${icon(t.icon)}</span>
      <span class="as-detail-name">${esc(t.name)}</span>
      <span class="as-badge as-badge--cat" style="--cat-color:${CATEGORY_COLORS[t.category] || 'var(--t-muted)'}">${esc(CATEGORY_LABELS[t.category] || t.category)}</span>
      ${isPreset ? '<span class="as-badge as-badge--preset">Preset</span>' : ''}
      <span class="as-detail-spacer"></span>
      ${isPreset ? `<button class="as-header-btn as-customize-btn" data-action="customize">Customize</button>` : ''}
      ${!isPreset ? `
        <button class="as-header-btn" data-action="export-one" data-id="${t.id}">\u2193 Export</button>
        <button class="as-header-btn as-discard-btn" id="as-discard" disabled>Discard</button>
        <button class="as-header-btn as-save-btn" id="as-save" disabled>Save</button>
        <button class="as-header-btn as-delete-btn" data-action="delete-template" data-id="${t.id}">\u2715</button>
      ` : ''}
    </div>

    <div class="as-detail-body">
      <div class="as-detail-meta" id="as-detail-meta">
        ${buildDetailMeta(t, isPreset)}
      </div>
      <div class="as-detail-content">
        <div class="as-md-toolbar" id="as-md-toolbar">
          <button class="ss-md-tool" data-cmd="heading" data-tooltip="Heading"><svg viewBox="0 0 24 24"><path d="M4 4v16M20 4v16M4 12h16"/></svg></button>
          <button class="ss-md-tool" data-cmd="bold" data-tooltip="Bold (Ctrl+B)"><b style="font-size:13px">B</b></button>
          <button class="ss-md-tool" data-cmd="italic" data-tooltip="Italic (Ctrl+I)"><i style="font-size:13px">I</i></button>
          <button class="ss-md-tool" data-cmd="strikethrough" data-tooltip="Strikethrough"><s style="font-size:12px">S</s></button>
          <div class="ss-md-toolbar-sep"></div>
          <button class="ss-md-tool" data-cmd="ul" data-tooltip="Bullet list"><svg viewBox="0 0 24 24"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="5" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="5" cy="18" r="1.5" fill="currentColor" stroke="none"/></svg></button>
          <button class="ss-md-tool" data-cmd="ol" data-tooltip="Numbered list"><svg viewBox="0 0 24 24"><line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><text x="4" y="8" font-size="7" fill="currentColor" stroke="none" font-weight="600">1</text><text x="4" y="14" font-size="7" fill="currentColor" stroke="none" font-weight="600">2</text><text x="4" y="20" font-size="7" fill="currentColor" stroke="none" font-weight="600">3</text></svg></button>
          <button class="ss-md-tool" data-cmd="quote" data-tooltip="Blockquote"><svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h12"/><rect x="1" y="5" width="2" height="14" rx="1" fill="currentColor" stroke="none" opacity="0.4"/></svg></button>
          <div class="ss-md-toolbar-sep"></div>
          <button class="ss-md-tool" data-cmd="code" data-tooltip="Inline code"><svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></button>
          <button class="ss-md-tool" data-cmd="codeblock" data-tooltip="Code block"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 8 5 12 9 16" stroke-width="1.5"/><polyline points="15 8 19 12 15 16" stroke-width="1.5"/></svg></button>
          <button class="ss-md-tool" data-cmd="link" data-tooltip="Link (Ctrl+K)"><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
          <button class="ss-md-tool" data-cmd="hr" data-tooltip="Horizontal rule">&mdash;</button>
          <div class="ss-view-toggle">
            <button class="ss-view-toggle-btn${_previewMode ? '' : ' active'}" data-mode="raw">Raw</button>
            <button class="ss-view-toggle-btn${_previewMode ? ' active' : ''}" data-mode="preview">Preview</button>
          </div>
        </div>
        <textarea class="as-cmd-editor${_previewMode ? ' as-hidden' : ''}" id="as-cmd-editor"
          spellcheck="false" autocorrect="off" autocapitalize="off"
          ${isPreset ? 'readonly' : ''}>${esc(_editorContent)}</textarea>
        <div class="as-cmd-preview${_previewMode ? ' visible' : ''}" id="as-cmd-preview"></div>
        <div class="as-detail-actions">
          <button class="as-action-btn" data-action="copy-cmd">
            <svg viewBox="0 0 24 24" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2"/></svg>
            Copy
          </button>
          ${isPreset ? `<button class="as-action-btn" data-action="reconfigure">Wizard</button>` : ''}
          <div class="as-action-spacer"></div>
          <button class="as-action-btn as-action-btn--test" data-action="test-run">Test (1 iter)</button>
          <button class="as-action-btn as-action-btn--launch" data-action="launch-loop">
            <svg viewBox="0 0 24 24" width="14" height="14"><polyline points="4 17 10 11 4 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="19" x2="20" y2="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            Launch
          </button>
        </div>
      </div>
    </div>
  `;

  wireDetailView(isPreset);
}

function buildDetailMeta(t, isPreset) {
  const disabled = isPreset ? 'disabled readonly' : '';
  return `
    <div class="as-meta-section">
      <div class="as-field">
        <label>Name</label>
        <input type="text" class="as-input" id="as-f-name" value="${esc(t.name)}" ${disabled} />
      </div>
      <div class="as-field">
        <label>Category</label>
        ${isPreset
          ? `<span class="as-value-text">${esc(CATEGORY_LABELS[t.category] || t.category)}</span>`
          : `<div class="as-cat-picker" id="as-cat-picker">
              <input type="hidden" id="as-f-category" value="${esc(t.category || 'custom')}">
              <button type="button" class="as-cat-picker-trigger" id="as-cat-trigger">
                <span class="as-cat-picker-label">${esc(CATEGORY_LABELS[t.category] || t.category || 'Custom')}</span>
                <span class="as-icon-picker-chevron">${AS_ICONS.down}</span>
              </button>
              <div class="as-cat-picker-menu" id="as-cat-menu">
                ${Object.entries(CATEGORY_LABELS).map(([k, v]) =>
                  `<button type="button" class="as-cat-picker-item${k === (t.category || 'custom') ? ' selected' : ''}" data-cat="${k}">${esc(v)}</button>`
                ).join('')}
              </div>
            </div>`
        }
      </div>
      <div class="as-field">
        <label>Description</label>
        <textarea class="as-textarea" id="as-f-desc" rows="3" ${disabled}>${esc(t.description || '')}</textarea>
      </div>
      <div class="as-field">
        <label>Iterations <span class="as-range-val" id="as-f-iter-val">${t.iterations}</span></label>
        <input type="range" class="as-range" id="as-f-iterations" min="1" max="50" value="${t.iterations}" />
      </div>
      <div class="as-field">
        <label>Time cap <span class="as-range-val" id="as-f-min-val">${t.maxMinutes}m</span></label>
        <input type="range" class="as-range" id="as-f-maxminutes" min="1" max="120" value="${t.maxMinutes}" />
      </div>
      <div class="as-field as-field--toggle">
        <label>Uses Browser</label>
        <label class="as-toggle">
          <input type="checkbox" id="as-f-browser" ${t.usesBrowser ? 'checked' : ''} ${isPreset ? 'disabled' : ''}>
          <span class="as-toggle-track"></span>
        </label>
      </div>
      ${isPreset ? `
        <div class="as-meta-divider"></div>
        <div class="as-preset-hint">
          Built-in preset.
          <button class="as-inline-link" data-action="reconfigure">Re-run Wizard</button> to change parameters, or
          <button class="as-inline-link" data-action="customize">Customize</button> to create an editable copy.
        </div>
      ` : `
        <div class="as-meta-divider"></div>
        <div class="as-field">
          <label>Icon</label>
          <div class="as-icon-picker" id="as-icon-picker">
            <input type="hidden" id="as-f-icon" value="${esc(t.icon || 'refresh')}">
            <button type="button" class="as-icon-picker-trigger" id="as-icon-trigger">
              <span class="as-icon-picker-preview">${icon(t.icon || 'refresh')}</span>
              <span class="as-icon-picker-label">${esc(t.icon || 'refresh')}</span>
              <span class="as-icon-picker-chevron">${AS_ICONS.down}</span>
            </button>
            <div class="as-icon-picker-menu" id="as-icon-menu">
              ${ICON_KEYS.map(k =>
                `<button type="button" class="as-icon-picker-item${k === (t.icon || 'refresh') ? ' selected' : ''}" data-icon="${k}" title="${k}">${icon(k)}</button>`
              ).join('')}
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

function wireDetailView(isPreset) {
  // Sliders
  const iterSlider = $('as-f-iterations');
  const iterVal = $('as-f-iter-val');
  if (iterSlider && iterVal) iterSlider.addEventListener('input', () => { iterVal.textContent = iterSlider.value; if (!isPreset) markDirty(); });
  const minSlider = $('as-f-maxminutes');
  const minVal = $('as-f-min-val');
  if (minSlider && minVal) minSlider.addEventListener('input', () => { minVal.textContent = minSlider.value + 'm'; if (!isPreset) markDirty(); });

  // Browser toggle
  const browserToggle = $('as-f-browser');
  if (browserToggle && !isPreset) browserToggle.addEventListener('change', () => markDirty());

  // Editor textarea
  const editor = $('as-cmd-editor');
  if (editor && !isPreset) {
    editor.addEventListener('input', () => {
      _editorContent = editor.value;
      _detailDirty = _metaDirty || (_editorContent !== _originalContent);
      updateDetailDirtyState();
    });
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = editor.selectionStart, end = editor.selectionEnd;
        editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
        editor.selectionStart = editor.selectionEnd = start + 2;
        _editorContent = editor.value;
      }
      // Keyboard shortcuts
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'b') { e.preventDefault(); mdWrap(editor, '**', '**'); }
        else if (e.key === 'i') { e.preventDefault(); mdWrap(editor, '*', '*'); }
        else if (e.key === 'k') { e.preventDefault(); mdLink(editor); }
      }
    });
  }

  // Metadata field dirty tracking
  if (!isPreset) {
    _panel?.querySelectorAll('#as-detail-meta input:not([type="range"]):not([type="checkbox"]), #as-detail-meta textarea, #as-detail-meta select').forEach(el => {
      el.addEventListener('input', () => markDirty());
      el.addEventListener('change', () => markDirty());
    });
  }

  // Icon picker & category picker
  wireIconPicker(isPreset);
  wireCategoryPicker(isPreset);

  // Markdown toolbar
  wireMdToolbar();

  // Preview toggle
  _panel?.querySelectorAll('.ss-view-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      _previewMode = mode === 'preview';
      _panel.querySelectorAll('.ss-view-toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
      const ed = $('as-cmd-editor');
      const prev = $('as-cmd-preview');
      const toolbar = $('as-md-toolbar');
      if (ed) ed.classList.toggle('as-hidden', _previewMode);
      if (prev) {
        prev.classList.toggle('visible', _previewMode);
        if (_previewMode) prev.innerHTML = `<pre style="white-space:pre-wrap;margin:0;font-size:12px;line-height:1.65;color:var(--t-primary)">${esc(ed?.value || '')}</pre>`;
      }
      if (toolbar) toolbar.querySelectorAll('.ss-md-tool').forEach(t => t.style.visibility = _previewMode ? 'hidden' : '');
    });
  });

  // Save/Discard
  $('as-save')?.addEventListener('click', () => saveCurrentTemplate());
  $('as-discard')?.addEventListener('click', () => {
    _editorContent = _originalContent;
    resetDirty();
    switchToDetail(_selected); // re-render with original data
  });
}

function wireIconPicker(isPreset) {
  if (isPreset) return;
  const picker = $('as-icon-picker');
  const trigger = $('as-icon-trigger');
  const menu = $('as-icon-menu');
  const hidden = $('as-f-icon');
  if (!picker || !trigger || !menu || !hidden) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.contains('open');
    menu.classList.toggle('open', !isOpen);
    trigger.classList.toggle('open', !isOpen);
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.as-icon-picker-item');
    if (!item) return;
    const key = item.dataset.icon;
    hidden.value = key;
    trigger.querySelector('.as-icon-picker-preview').innerHTML = icon(key);
    trigger.querySelector('.as-icon-picker-label').textContent = key;
    menu.querySelectorAll('.as-icon-picker-item').forEach(i => i.classList.toggle('selected', i === item));
    menu.classList.remove('open');
    trigger.classList.remove('open');
    // Update detail header icon
    const headerIcon = _panel?.querySelector('.as-detail-icon');
    if (headerIcon) headerIcon.innerHTML = icon(key);
    markDirty();
  });

  // Close on click outside
  document.addEventListener('click', function _closeIconPicker(e) {
    if (!picker.contains(e.target)) {
      menu.classList.remove('open');
      trigger.classList.remove('open');
    }
  });
}

function wireCategoryPicker(isPreset) {
  if (isPreset) return;
  const picker = $('as-cat-picker');
  const trigger = $('as-cat-trigger');
  const menu = $('as-cat-menu');
  const hidden = $('as-f-category');
  if (!picker || !trigger || !menu || !hidden) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.contains('open');
    menu.classList.toggle('open', !isOpen);
    trigger.classList.toggle('open', !isOpen);
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.as-cat-picker-item');
    if (!item) return;
    const key = item.dataset.cat;
    hidden.value = key;
    trigger.querySelector('.as-cat-picker-label').textContent = CATEGORY_LABELS[key] || key;
    menu.querySelectorAll('.as-cat-picker-item').forEach(i => i.classList.toggle('selected', i === item));
    menu.classList.remove('open');
    trigger.classList.remove('open');
    markDirty();
  });

  document.addEventListener('click', function _closeCatPicker(e) {
    if (!picker.contains(e.target)) {
      menu.classList.remove('open');
      trigger.classList.remove('open');
    }
  });
}

function resetDirty() {
  _metaDirty = false;
  _detailDirty = false;
}

function markDirty() {
  _metaDirty = true;
  _detailDirty = true;
  updateDetailDirtyState();
}

function updateDetailDirtyState() {
  const saveBtn = $('as-save');
  const discardBtn = $('as-discard');
  if (saveBtn) { saveBtn.disabled = !_detailDirty; saveBtn.classList.toggle('dirty', _detailDirty); }
  if (discardBtn) discardBtn.disabled = !_detailDirty;
}

async function saveCurrentTemplate() {
  if (!_selected || _selected.id.startsWith('__preset_')) return;
  const name = $('as-f-name')?.value?.trim() || _selected.name;
  const category = $('as-f-category')?.value || _selected.category;
  const description = $('as-f-desc')?.value?.trim() || '';
  const iconKey = $('as-f-icon')?.value || _selected.icon || 'refresh';
  const iterations = parseInt($('as-f-iterations')?.value || '10', 10);
  const maxMinutes = parseInt($('as-f-maxminutes')?.value || '30', 10);
  const usesBrowser = $('as-f-browser')?.checked || false;
  const task = $('as-cmd-editor')?.value?.trim() || '';

  if (!name) { showToast('Name is required'); return; }
  if (!task) { showToast('Task description is required'); return; }

  const payload = { name, icon: iconKey, category, task, context: '', description: description || task.slice(0, 120), iterations, maxMinutes, usesBrowser };

  try {
    if (_selected.id) { await updateLoopTemplate(_selected.id, payload); }
    else { const result = await createLoopTemplate(payload); if (result?.id) _selected.id = result.id; }
    _templates = await fetchLoopTemplates();
    const updated = _templates.find(t => t.id === _selected.id);
    if (updated) _selected = updated;
    _originalContent = task;
    _editorContent = task;
    resetDirty();
    renderView();
    showToast('Saved');
  } catch (err) { showToast('Save failed: ' + err.message); }
}

// ── Markdown toolbar ──

function wireMdToolbar() {
  const toolbar = $('as-md-toolbar');
  if (!toolbar) return;
  toolbar.querySelectorAll('.ss-md-tool[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => {
      const editor = $('as-cmd-editor');
      if (!editor || editor.readOnly) return;
      const cmd = btn.dataset.cmd;
      switch (cmd) {
        case 'bold': mdWrap(editor, '**', '**'); break;
        case 'italic': mdWrap(editor, '*', '*'); break;
        case 'strikethrough': mdWrap(editor, '~~', '~~'); break;
        case 'code': mdWrap(editor, '`', '`'); break;
        case 'codeblock': mdWrap(editor, '\n```\n', '\n```\n'); break;
        case 'heading': mdPrefix(editor, '## '); break;
        case 'ul': mdPrefix(editor, '- '); break;
        case 'ol': mdPrefix(editor, '1. '); break;
        case 'quote': mdPrefix(editor, '> '); break;
        case 'link': mdLink(editor); break;
        case 'hr': {
          const s = editor.selectionStart;
          editor.value = editor.value.substring(0, s) + '\n---\n' + editor.value.substring(s);
          editor.selectionStart = editor.selectionEnd = s + 5;
          editor.focus();
          break;
        }
      }
      _editorContent = editor.value;
      if (_editorContent !== _originalContent) { _detailDirty = true; updateDetailDirtyState(); }
    });
  });
}

function mdWrap(editor, before, after) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const sel = editor.value.substring(s, e) || 'text';
  editor.value = editor.value.substring(0, s) + before + sel + after + editor.value.substring(e);
  editor.selectionStart = s + before.length;
  editor.selectionEnd = s + before.length + sel.length;
  editor.focus();
}

function mdPrefix(editor, prefix) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const val = editor.value;
  const lineStart = val.lastIndexOf('\n', s - 1) + 1;
  const lineEnd = val.indexOf('\n', e);
  const end = lineEnd < 0 ? val.length : lineEnd;
  const lines = val.substring(lineStart, end).split('\n');
  const toggled = lines.map(line => {
    if (line.startsWith(prefix)) return line.substring(prefix.length);
    // Strip other prefixes
    return prefix + line.replace(/^(#{1,6}\s|[-*]\s|\d+\.\s|>\s)/, '');
  });
  editor.value = val.substring(0, lineStart) + toggled.join('\n') + val.substring(end);
  editor.selectionStart = lineStart;
  editor.selectionEnd = lineStart + toggled.join('\n').length;
  editor.focus();
}

function mdLink(editor) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const sel = editor.value.substring(s, e) || 'text';
  const inserted = `[${sel}](url)`;
  editor.value = editor.value.substring(0, s) + inserted + editor.value.substring(e);
  editor.selectionStart = s + sel.length + 3;
  editor.selectionEnd = s + sel.length + 6;
  editor.focus();
}

// ── Customize (clone preset → custom) ──

async function customizePreset(preset) {
  try {
    const cmd = buildTemplateCommand(preset);
    const payload = {
      name: preset.name + ' (Custom)',
      icon: preset.icon,
      category: preset.category,
      task: cmd,
      context: '',
      iterations: parseInt($('as-f-iterations')?.value || String(preset.iterations), 10),
      maxMinutes: parseInt($('as-f-maxminutes')?.value || String(preset.maxMinutes), 10),
      usesBrowser: preset.usesBrowser || false,
      description: preset.description,
    };
    const result = await createLoopTemplate(payload);
    if (result?.id) {
      _templates = await fetchLoopTemplates();
      const newTpl = _templates.find(t => t.id === result.id);
      if (newTpl) {
        showToast('Customized \u2014 edit and save your copy');
        switchToDetail(newTpl);
      }
    }
  } catch (err) { showToast('Customize failed: ' + err.message); }
}

// ── Test Run ──

function handleTestRun() {
  if (!_selected) return;
  const cmd = $('as-cmd-editor')?.value || _editorContent;
  const iterations = parseInt($('as-f-iterations')?.value || '1', 10);
  const maxMinutes = parseInt($('as-f-maxminutes')?.value || '10', 10);
  const usesBrowser = $('as-f-browser')?.checked || _selected.usesBrowser || false;
  serverLaunchLoop({
    task: cmd,
    context: null,
    iterations: 1, maxMinutes: 10,
    usesBrowser,
  });
}

// ── Launch ──

function handleLaunch() {
  if (!_selected) return;

  // If dirty and saveable (not a preset), show unsaved-changes modal
  const isPreset = _selected.id?.startsWith('__preset_');
  if (_detailDirty && !isPreset) {
    showUnsavedLaunchModal();
    return;
  }

  proceedWithLaunch();
}

function proceedWithLaunch() {
  const cmd = $('as-cmd-editor')?.value || _editorContent;
  const iterations = parseInt($('as-f-iterations')?.value || String(_selected.iterations), 10);
  const maxMinutes = parseInt($('as-f-maxminutes')?.value || String(_selected.maxMinutes), 10);
  const usesBrowser = $('as-f-browser')?.checked || _selected.usesBrowser || false;
  serverLaunchLoop({
    task: cmd,
    context: null,
    iterations, maxMinutes, usesBrowser,
  });
}

function showUnsavedLaunchModal() {
  _panel?.querySelector('.as-unsaved-dialog')?.remove();

  const html = `
    <div class="as-unsaved-dialog">
      <div class="as-unsaved-dialog-inner">
        <div class="as-unsaved-dialog-header">
          <span class="as-unsaved-dialog-title">Unsaved Changes</span>
          <button class="as-launch-dialog-close" data-action="unsaved-dialog-close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M11 3L3 11M3 3l8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="as-unsaved-dialog-body">
          <p class="as-unsaved-dialog-msg">You have unsaved changes to this automation. Save before launching?</p>
        </div>
        <div class="as-unsaved-dialog-footer">
          <button class="as-launch-cancel" data-action="unsaved-dialog-close">Cancel</button>
          <button class="as-launch-go" data-action="unsaved-save-launch">Save &amp; Continue</button>
        </div>
      </div>
    </div>
  `;

  _panel.insertAdjacentHTML('beforeend', html);
}

async function handleSaveAndLaunch() {
  const dialog = _panel?.querySelector('.as-unsaved-dialog');
  const btn = dialog?.querySelector('[data-action="unsaved-save-launch"]');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

  await saveCurrentTemplate();

  // saveCurrentTemplate resets _detailDirty on success
  if (!_detailDirty) {
    dialog?.remove();
    proceedWithLaunch();
  } else {
    // Save failed — restore button
    if (btn) { btn.textContent = 'Save & Continue'; btn.disabled = false; }
  }
}

// ═══════════════════════════════════════════
// WIZARD (rendered in main area)
// ═══════════════════════════════════════════

function openWizard(preset) {
  _wizardPreset = preset;
  _wizardStep = 0;
  _wizardState = {
    iterations: preset.iterations,
    maxMinutes: preset.maxMinutes,
    usesBrowser: preset.usesBrowser || false,
  };
  _view = 'wizard';
  renderView();
}

function renderWizardMain() {
  const main = $('as-main');
  if (!main || !_wizardPreset) return;
  const totalSteps = _wizardPreset.steps.length + 1;
  const stepNames = [..._wizardPreset.steps.map(s => s.title), 'Review'];

  main.innerHTML = `
    <div class="as-wizard">
      <div class="as-wizard-header">
        <button class="as-back-btn" data-action="cancel-wizard">\u2190 Cancel</button>
        <span class="as-wizard-icon">${icon(_wizardPreset.icon)}</span>
        <span class="as-wizard-title">${esc(_wizardPreset.name)}</span>
      </div>
      <div class="as-wizard-steps">
        ${stepNames.map((s, i) => `
          <div class="as-wiz-step${i === _wizardStep ? ' active' : ''}${i < _wizardStep ? ' done' : ''}">
            <span class="as-wiz-step-num">${i + 1}</span>
            <span class="as-wiz-step-label">${esc(s)}</span>
          </div>
        `).join('')}
      </div>
      <div class="as-wizard-body" id="as-wizard-body"></div>
      <div class="as-wizard-nav">
        <button class="as-header-btn" data-action="wizard-back" style="visibility:${_wizardStep === 0 ? 'hidden' : 'visible'}">\u2190 Back</button>
        <button class="as-header-btn as-save-btn" data-action="wizard-next">${_wizardStep === totalSteps - 2 ? 'Review' : _wizardStep >= totalSteps - 1 ? '' : 'Next \u2192'}</button>
      </div>
    </div>
  `;

  renderWizardStep();
}

function renderWizardStep() {
  const body = $('as-wizard-body');
  if (!body || !_wizardPreset) return;
  const totalSteps = _wizardPreset.steps.length + 1;
  const isLastStep = _wizardStep === totalSteps - 1;

  // Update step indicators
  _panel?.querySelectorAll('.as-wiz-step').forEach((el, i) => {
    el.classList.toggle('active', i === _wizardStep);
    el.classList.toggle('done', i < _wizardStep);
  });

  const backBtn = _panel?.querySelector('[data-action="wizard-back"]');
  const nextBtn = _panel?.querySelector('[data-action="wizard-next"]');
  if (backBtn) backBtn.style.visibility = _wizardStep === 0 ? 'hidden' : 'visible';

  if (isLastStep) {
    body.innerHTML = buildReviewStep();
    if (nextBtn) nextBtn.style.display = 'none';
    wireReviewEvents();
  } else {
    const step = _wizardPreset.steps[_wizardStep];
    body.innerHTML = `
      <div class="awiz-step-title">${esc(step.title)}</div>
      <div class="awiz-step-subtitle">${esc(step.subtitle)}</div>
      <div class="awiz-step-content">${step.buildContent(_wizardState)}</div>`;
    if (nextBtn) {
      nextBtn.style.display = '';
      nextBtn.textContent = _wizardStep === totalSteps - 2 ? 'Review' : 'Next \u2192';
    }
  }

  wireChipEvents(_panel);
  wireInputSync(_panel);
  if (!isLastStep) {
    const step = _wizardPreset.steps[_wizardStep];
    if (step?.afterRender) step.afterRender(_panel, _wizardState);
  }
}

function buildReviewStep() {
  const state = _wizardState;
  const preset = _wizardPreset;
  const command = preset.buildCommand(state);

  const summaryPairs = [];
  for (const step of preset.steps) {
    const tmp = document.createElement('div');
    tmp.innerHTML = step.buildContent(state);
    tmp.querySelectorAll('.awiz-field').forEach(field => {
      const label = field.querySelector('label')?.textContent?.replace(/\(optional\)/i, '').trim();
      if (!label) return;
      const input = field.querySelector('input, textarea');
      const chips = field.querySelector('.awiz-chips');
      let value = '';
      if (input && input.value) value = input.value;
      else if (chips) {
        value = Array.from(chips.querySelectorAll('.awiz-chip.active')).map(c => c.textContent).join(', ');
      }
      if (value) summaryPairs.push({ label, value });
    });
  }

  const summaryHtml = summaryPairs.map(p =>
    `<div class="awiz-summary-row"><span class="awiz-summary-label">${esc(p.label)}</span><span class="awiz-summary-value">${esc(p.value)}</span></div>`
  ).join('');

  return `
    <div class="awiz-step-title">Review & Launch</div>
    <div class="awiz-step-subtitle">Confirm your settings and go</div>
    <div class="awiz-summary">${summaryHtml}</div>
    <div class="awiz-controls">
      <div class="awiz-control-row">
        <label>Iterations</label>
        <input type="range" id="awiz-iterations" min="1" max="50" value="${state.iterations}" />
        <span class="awiz-range-val" id="awiz-iter-val">${state.iterations}</span>
      </div>
      <div class="awiz-control-row">
        <label>Time cap</label>
        <input type="range" id="awiz-minutes" min="1" max="60" value="${state.maxMinutes}" />
        <span class="awiz-range-val" id="awiz-min-val">${state.maxMinutes}m</span>
      </div>
    </div>
    ${state.usesBrowser ? '<div style="font-size:11px;color:hsla(210,40%,65%,0.9);margin-bottom:12px;display:flex;align-items:center;gap:6px"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> This automation uses browser tools</div>' : ''}
    <div class="awiz-command-preview">
      <div class="awiz-preview-label">Command Preview</div>
      <pre class="awiz-preview-text">${esc(formatLoopCommand(command, state))}</pre>
    </div>
    <div class="awiz-launch-actions">
      <button class="awiz-btn-copy" data-action="wizard-copy">
        <svg viewBox="0 0 24 24" width="16" height="16"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2"/></svg>
        Copy Command
      </button>
      <button class="awiz-btn-launch" data-action="wizard-open-editor">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Open in Editor
      </button>
      <button class="awiz-btn-launch" data-action="wizard-launch">
        <svg viewBox="0 0 24 24" width="16" height="16"><polyline points="4 17 10 11 4 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="19" x2="20" y2="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        Launch Terminal
      </button>
    </div>`;
}

function wireReviewEvents() {
  const iterSlider = $('awiz-iterations');
  const iterVal = $('awiz-iter-val');
  const minSlider = $('awiz-minutes');
  const minVal = $('awiz-min-val');

  if (iterSlider && iterVal) {
    iterSlider.addEventListener('input', () => {
      _wizardState.iterations = parseInt(iterSlider.value, 10);
      iterVal.textContent = iterSlider.value;
      updateWizardPreview();
    });
  }
  if (minSlider && minVal) {
    minSlider.addEventListener('input', () => {
      _wizardState.maxMinutes = parseInt(minSlider.value, 10);
      minVal.textContent = minSlider.value + 'm';
      updateWizardPreview();
    });
  }
}

function updateWizardPreview() {
  const pre = _panel?.querySelector('.awiz-preview-text');
  if (pre) pre.textContent = formatLoopCommand(_wizardPreset.buildCommand(_wizardState), _wizardState);
}

function collectInputValues() {
  if (!_panel) return;
  _panel.querySelectorAll('.awiz-step-content input[data-key], .awiz-step-content textarea[data-key]').forEach(input => {
    _wizardState[input.dataset.key] = input.type === 'number' ? Number(input.value) : input.value;
  });
  _panel.querySelectorAll('.awiz-chips').forEach(group => {
    const key = group.dataset.key;
    const mode = group.dataset.mode;
    if (mode === 'single') {
      const active = group.querySelector('.awiz-chip.active');
      if (active) _wizardState[key] = active.dataset.value;
    } else {
      _wizardState[key] = Array.from(group.querySelectorAll('.awiz-chip.active')).map(c => c.dataset.value);
    }
  });
}

// ═══════════════════════════════════════════
// RUNNING VIEW
// ═══════════════════════════════════════════

function renderRunningMain() {
  const main = $('as-main');
  if (!main) return;

  if (!_activeLoop?.active) {
    main.innerHTML = `
      <div class="as-detail-header">
        <button class="as-back-btn" data-action="go-welcome">\u2190 Back</button>
        <h3 style="font-size:14px;font-weight:600;color:var(--t-bright)">Running</h3>
      </div>
      <div class="as-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <div>No automations running</div>
        <div style="margin-top:8px;font-size:11px;color:var(--t-faint)">Launch an automation from a template to see it here.</div>
      </div>`;
    return;
  }

  const loop = _activeLoop;
  const pct = loop.totalIterations > 0 ? Math.round((loop.currentIteration / loop.totalIterations) * 100) : 0;

  main.innerHTML = `
    <div class="as-detail-header">
      <button class="as-back-btn" data-action="go-welcome">\u2190 Back</button>
      <h3 style="font-size:14px;font-weight:600;color:var(--t-bright)">Running</h3>
    </div>
    <div style="padding:20px">
      <div class="as-running-card">
        <div class="as-running-header">
          <div class="as-running-label"><span class="as-running-pulse"></span> Loop Active</div>
          ${loop.usesBrowser ? '<span class="as-browser-indicator"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Browser Active</span>' : ''}
        </div>
        <div class="as-running-task">${esc(loop.task)}</div>
        <div class="as-running-progress"><div class="as-running-progress-fill" style="width:${pct}%"></div></div>
        <div class="as-running-stats">
          <span>Iteration ${loop.currentIteration}/${loop.totalIterations}</span>
          <span>${loop.remainingMinutes ?? '?'}min remaining</span>
          <span>${loop.elapsedMinutes ?? '?'}min elapsed</span>
        </div>
        <div class="as-running-controls">
          <button class="as-btn-stop" data-action="force-stop">Stop</button>
        </div>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════
// HISTORY VIEW
// ═══════════════════════════════════════════

async function renderHistoryMain() {
  const main = $('as-main');
  if (!main) return;

  main.innerHTML = `
    <div class="as-detail-header">
      <button class="as-back-btn" data-action="go-welcome">\u2190 Back</button>
      <h3 style="font-size:14px;font-weight:600;color:var(--t-bright)">History</h3>
    </div>
    <div style="padding:12px 16px">
      <div class="as-history-toolbar">
        <input type="text" class="as-history-search" id="as-history-search" placeholder="Search past automations..." />
      </div>
      <div class="as-history-list" id="as-history-list">
        <div class="as-empty" style="padding:20px">Loading history...</div>
      </div>
    </div>`;

  const searchInput = $('as-history-search');
  if (searchInput) {
    searchInput.addEventListener('input', debounce(async () => {
      await loadHistory(searchInput.value.trim());
    }, 300));
  }
  await loadHistory('');
}

async function loadHistory(query) {
  const list = $('as-history-list');
  if (!list) return;

  try {
    const [fileHistory, memoryResults] = await Promise.allSettled([
      fetchLoopHistory(),
      query ? searchMemoriesByCategory(query, 'automations', 15) : searchMemoriesByCategory('loop automation completed', 'automations', 15),
    ]);

    const items = [];
    if (fileHistory.status === 'fulfilled' && Array.isArray(fileHistory.value)) {
      for (const h of fileHistory.value) {
        items.push({
          type: 'file', id: h.sessionId,
          name: h.task?.slice(0, 60) || 'Unnamed Loop', icon: 'refresh',
          date: h.finishedAt || h.startedAt,
          iterations: `${h.completedIterations ?? h.currentIteration ?? 0}/${h.totalIterations}`,
          duration: h.maxMinutes ? `${h.maxMinutes}m` : '?',
          content: h.task, context: h.context,
          totalIterations: h.totalIterations || 10,
          maxMinutes: h.maxMinutes || 30,
          usesBrowser: !!h.usesBrowser,
          stopped: !!h.stopped, stale: !!h.stale,
        });
      }
    }
    if (memoryResults.status === 'fulfilled' && Array.isArray(memoryResults.value)) {
      for (const m of memoryResults.value) {
        if (items.some(i => i.id === m.id)) continue;
        items.push({
          type: 'memory', id: m.id,
          name: m.tags?.[0] || 'Automation Result', icon: 'brain',
          date: m.created_at, iterations: '', duration: '',
          content: m.content, importance: m.importance,
        });
      }
    }
    items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    if (!items.length) {
      list.innerHTML = '<div class="as-empty">No automation history yet.</div>';
      return;
    }

    list.innerHTML = items.map(item => `
      <div class="as-history-item" data-history-id="${esc(item.id)}">
        <div class="as-history-header" data-action="toggle-history" data-history-id="${esc(item.id)}">
          <span class="as-history-icon">${icon(item.icon)}</span>
          <span class="as-history-name">${esc(item.name)}</span>
          <span class="as-history-date">${item.date ? relativeTime(item.date) : ''}</span>
        </div>
        <div class="as-history-meta">
          ${item.iterations ? `<span>${item.iterations} iterations</span>` : ''}
          ${item.duration ? `<span>${item.duration}</span>` : ''}
          ${item.stale ? '<span class="as-history-tag--stopped">Stale</span>' : item.stopped ? '<span class="as-history-tag--stopped">Stopped</span>' : ''}
          ${item.usesBrowser ? '<span class="as-history-tag--browser">Browser</span>' : ''}
        </div>
        <div class="as-history-detail" style="display:none">
          <pre class="as-history-task-text">${esc(item.content || '')}</pre>
          <div class="as-history-actions">
            <button class="as-history-btn" data-action="rerun-history" data-history-id="${esc(item.id)}">Rerun</button>
            <button class="as-history-btn" data-action="save-as-template" data-history-id="${esc(item.id)}">Save as Template</button>
            <button class="as-history-btn as-history-btn--danger" data-action="delete-history" data-history-id="${esc(item.id)}">Delete</button>
          </div>
        </div>
      </div>
    `).join('');
    _history = items;
  } catch (err) {
    list.innerHTML = `<div class="as-empty">Failed to load history: ${esc(err.message)}</div>`;
  }
}

// ═══════════════════════════════════════════
// EVENT HANDLERS (delegated)
// ═══════════════════════════════════════════

async function handlePanelClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  switch (action) {
    case 'go-welcome':
      if (_detailDirty && !confirm('Discard unsaved changes?')) return;
      _view = 'welcome'; _selected = null; resetDirty();
      renderView();
      break;

    case 'go-picker':
      _view = 'picker'; renderView();
      break;

    case 'launch-dialog-close':
      closeLaunchDialog();
      break;

    case 'launch-dialog-confirm':
      confirmLaunch();
      break;

    case 'unsaved-dialog-close':
      _panel?.querySelector('.as-unsaved-dialog')?.remove();
      break;

    case 'unsaved-save-launch':
      handleSaveAndLaunch();
      break;

    case 'open-detail': {
      const all = [...PRESET_TEMPLATES, ..._templates];
      const tpl = all.find(t => t.id === id);
      if (tpl) switchToDetail(tpl);
      break;
    }

    case 'pick-preset': {
      const preset = PRESET_TEMPLATES.find(t => t.id === id);
      if (preset) openWizard(preset);
      break;
    }

    case 'pick-blank': {
      const blank = { id: '', name: '', description: '', task: '', context: '', iterations: 10, maxMinutes: 30, icon: 'refresh', category: 'custom', usesBrowser: false };
      _selected = blank;
      _editorContent = ''; _originalContent = '';
      resetDirty(); _previewMode = false;
      _view = 'detail';
      renderView();
      break;
    }

    case 'configure':
    case 'reconfigure': {
      const all = [...PRESET_TEMPLATES, ..._templates];
      const preset = all.find(t => t.id === (_selected?.id || id));
      if (preset && preset.steps) openWizard(preset);
      break;
    }

    case 'customize': {
      if (_selected) customizePreset(_selected);
      break;
    }

    case 'copy-cmd': {
      const text = $('as-cmd-editor')?.value || _editorContent;
      const full = formatLoopCommand(text, {
        iterations: parseInt($('as-f-iterations')?.value || String(_selected?.iterations || 10), 10),
        maxMinutes: parseInt($('as-f-maxminutes')?.value || String(_selected?.maxMinutes || 30), 10),
        usesBrowser: $('as-f-browser')?.checked || false,
      });
      navigator.clipboard.writeText(full).then(() => showToast('Copied to clipboard')).catch(() => showToast('Copy failed'));
      break;
    }

    case 'test-run':
      handleTestRun();
      break;

    case 'launch-loop':
      handleLaunch();
      break;

    case 'force-stop': {
      try {
        const result = await stopLoop();
        if (result?.ok) {
          showToast(result.stopped > 0 ? 'Loop stopped' : 'No active loops');
          _activeLoop = null;
          updateHeaderBadge(); updateSidebarFooter();
          if (_view === 'running') renderRunningMain();
        } else { showToast(result?.error || 'Stop failed'); }
      } catch (err) { showToast('Stop failed: ' + err.message); }
      break;
    }

    case 'view-running':
      _view = 'running';
      renderView();
      break;

    case 'delete-template': {
      if (!confirm('Delete this automation?')) break;
      try {
        await deleteLoopTemplate(id);
        _templates = _templates.filter(t => t.id !== id);
        if (_selected?.id === id) { _selected = null; _view = 'welcome'; }
        renderView();
        showToast('Deleted');
      } catch (err) { showToast('Delete failed: ' + err.message); }
      break;
    }

    case 'export-one': {
      const tpl = _templates.find(t => t.id === id);
      if (tpl) downloadJson({ version: 1, type: 'synabun-loop-template', template: tpl }, `loop-${tpl.name.toLowerCase().replace(/\s+/g, '-')}.json`);
      break;
    }

    case 'toggle-history': {
      const item = btn.closest('.as-history-item');
      const detail = item?.querySelector('.as-history-detail');
      if (detail) {
        const show = detail.style.display === 'none';
        detail.style.display = show ? 'block' : 'none';
        item.classList.toggle('expanded', show);
      }
      break;
    }

    case 'rerun-history': {
      const histItem = _history.find(h => h.id === btn.dataset.historyId);
      if (!histItem) { showToast('History entry not found'); break; }
      serverLaunchLoop({
        task: histItem.content,
        context: null,
        iterations: histItem.totalIterations || 10,
        maxMinutes: histItem.maxMinutes || 30,
        usesBrowser: histItem.usesBrowser || false,
      });
      break;
    }

    case 'save-as-template': {
      const histItem = _history.find(h => h.id === btn.dataset.historyId);
      if (!histItem) { showToast('History entry not found'); break; }
      try {
        const template = {
          name: (histItem.content || 'Unnamed').slice(0, 50),
          task: histItem.content || '', context: histItem.context || '',
          iterations: histItem.totalIterations || 10, maxMinutes: histItem.maxMinutes || 30,
          usesBrowser: histItem.usesBrowser || false,
          category: 'custom', icon: histItem.usesBrowser ? 'globe' : 'refresh',
        };
        const result = await createLoopTemplate(template);
        if (result?.id) {
          _templates = await fetchLoopTemplates() || [];
          showToast('Saved as custom template');
          _view = 'welcome'; _filterCategory = 'custom';
          renderView();
        } else { showToast(result?.error || 'Save failed'); }
      } catch (err) { showToast('Save failed: ' + err.message); }
      break;
    }

    case 'delete-history': {
      const hid = btn.dataset.historyId;
      const histEntry = _history.find(h => h.id === hid);
      if (!histEntry) break;
      try {
        if (histEntry.type === 'file') {
          const result = await deleteLoopHistory(hid);
          if (!result?.ok) { showToast(result?.error || 'Delete failed'); break; }
        } else if (histEntry.type === 'memory') { await deleteMemory(hid); }
        _history = _history.filter(h => h.id !== hid);
        const item = btn.closest('.as-history-item');
        if (item) item.remove();
        if (!_history.length) {
          const list = $('as-history-list');
          if (list) list.innerHTML = '<div class="as-empty">No automation history yet.</div>';
        }
        showToast('Deleted');
      } catch (err) { showToast('Delete failed: ' + err.message); }
      break;
    }

    case 'cancel-wizard':
      _wizardState = null; _wizardStep = 0; _wizardPreset = null;
      _view = _selected ? 'detail' : 'welcome';
      renderView();
      break;

    case 'wizard-back':
      if (_wizardStep > 0) { collectInputValues(); _wizardStep--; renderWizardStep(); }
      break;

    case 'wizard-next': {
      collectInputValues();
      const step = _wizardPreset.steps[_wizardStep];
      if (step?.validate) { const err = step.validate(_wizardState); if (err) { showToast(err); return; } }
      _wizardStep++;
      renderWizardStep();
      break;
    }

    case 'wizard-copy': {
      collectInputValues();
      const cmd = formatLoopCommand(_wizardPreset.buildCommand(_wizardState), _wizardState);
      navigator.clipboard.writeText(cmd).then(() => showToast('Copied to clipboard')).catch(() => showToast('Copy failed'));
      break;
    }

    case 'wizard-open-editor': {
      collectInputValues();
      const cmd = _wizardPreset.buildCommand(_wizardState);
      _wizardPreset._lastState = { ..._wizardState };
      _selected = _wizardPreset;
      _editorContent = cmd;
      _originalContent = cmd;
      resetDirty(); _previewMode = false;
      _wizardState = null; _wizardStep = 0; _wizardPreset = null;
      _view = 'detail';
      renderView();
      break;
    }

    case 'wizard-launch': {
      collectInputValues();
      const taskText = _wizardPreset.buildCommand(_wizardState);
      serverLaunchLoop({
        task: taskText,
        context: null,
        iterations: _wizardState.iterations,
        maxMinutes: _wizardState.maxMinutes,
        usesBrowser: _wizardState.usesBrowser,
      });
      _wizardState = null; _wizardStep = 0; _wizardPreset = null;
      _view = 'welcome';
      renderView();
      break;
    }
  }
}

// ═══════════════════════════════════════════
// WIZARD INFRASTRUCTURE (chip/input/rules)
// ═══════════════════════════════════════════

function wireRulesListEvents(container, state) {
  if (!Array.isArray(state.rules)) state.rules = [];
  const list = container.querySelector('#awiz-rules-list');
  const input = container.querySelector('#awiz-rule-input');
  const addBtn = container.querySelector('#awiz-rule-add');
  if (!list || !input || !addBtn) return;

  function rerender() {
    if (state.rules.length === 0) {
      list.innerHTML = '<div class="awiz-rules-empty">No rules yet.</div>';
    } else {
      list.innerHTML = state.rules.map((rule, i) => `
        <div class="awiz-rule-item" draggable="true" data-rule-idx="${i}">
          <span class="awiz-rule-grip" title="Drag to reorder">\u2261</span>
          <span class="awiz-rule-num">${i + 1}</span>
          <span class="awiz-rule-text">${esc(rule)}</span>
          <button class="awiz-rule-remove" data-remove-idx="${i}" title="Remove">&times;</button>
        </div>`).join('');
      wireDragDrop();
    }
  }

  function addRule() {
    const val = input.value.trim();
    if (!val) return;
    state.rules.push(val);
    input.value = ''; input.focus();
    rerender();
  }

  addBtn.addEventListener('click', (e) => { e.preventDefault(); addRule(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addRule(); } });

  list.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.awiz-rule-remove');
    if (!removeBtn) return;
    const idx = parseInt(removeBtn.dataset.removeIdx, 10);
    if (!isNaN(idx) && idx >= 0 && idx < state.rules.length) {
      state.rules.splice(idx, 1);
      rerender();
    }
  });

  let _dragIdx = null;
  function wireDragDrop() {
    list.querySelectorAll('.awiz-rule-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        _dragIdx = parseInt(item.dataset.ruleIdx, 10);
        item.classList.add('awiz-rule-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('awiz-rule-dragging'); _dragIdx = null;
        list.querySelectorAll('.awiz-rule-item').forEach(el => el.classList.remove('awiz-rule-over'));
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        list.querySelectorAll('.awiz-rule-item').forEach(el => el.classList.remove('awiz-rule-over'));
        item.classList.add('awiz-rule-over');
      });
      item.addEventListener('dragleave', () => { item.classList.remove('awiz-rule-over'); });
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        const dropIdx = parseInt(item.dataset.ruleIdx, 10);
        if (_dragIdx !== null && _dragIdx !== dropIdx) {
          const [moved] = state.rules.splice(_dragIdx, 1);
          state.rules.splice(dropIdx, 0, moved);
          rerender();
        }
      });
    });
  }
  if (state.rules.length > 0) wireDragDrop();
}

function wireChipEvents(container) {
  container.querySelectorAll('.awiz-chips').forEach(group => {
    group.querySelectorAll('.awiz-chip').forEach(btn => {
      const fresh = btn.cloneNode(true);
      btn.parentNode.replaceChild(fresh, btn);
      fresh.addEventListener('click', (e) => {
        e.preventDefault();
        const c = fresh.closest('.awiz-chips');
        const mode = c.dataset.mode;
        const key = c.dataset.key;
        const value = fresh.dataset.value;
        if (mode === 'single') {
          c.querySelectorAll('.awiz-chip').forEach(ch => ch.classList.remove('active'));
          fresh.classList.add('active');
          _wizardState[key] = value;
        } else {
          fresh.classList.toggle('active');
          _wizardState[key] = Array.from(c.querySelectorAll('.awiz-chip.active')).map(ch => ch.dataset.value);
        }
      });
    });
  });
}

function wireInputSync(container) {
  container.querySelectorAll('.awiz-step-content input[data-key], .awiz-step-content textarea[data-key]').forEach(input => {
    input.addEventListener('input', () => {
      _wizardState[input.dataset.key] = input.type === 'number' ? Number(input.value) : input.value;
    });
  });
}

// ═══════════════════════════════════════════
// IMPORT / EXPORT
// ═══════════════════════════════════════════

function triggerImport() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json'; input.style.display = 'none';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.type !== 'synabun-loop-templates' && data.type !== 'synabun-loop-template') {
        showToast('Invalid file format'); return;
      }
      const result = await importLoopTemplates(data);
      _templates = await fetchLoopTemplates();
      renderView();
      showToast(`Imported: ${result.added} added, ${result.updated} updated`);
    } catch (err) { showToast('Import failed: ' + err.message); }
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}
