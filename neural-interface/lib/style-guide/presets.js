// ═══════════════════════════════════════════
// SynaBun — Style Guide presets
// ═══════════════════════════════════════════
//
// Eight complete starting points. Every value is SynaBun's own: no preset copies a
// brand. A preset is a partial config (palette bases become full 11-step scales
// here); applyPreset lays it over the current guide (`merge`) or over the defaults
// (`replace`) with the same rules an import follows. Pure, no I/O.

import { scaleFromBase } from './color.js';
import { buildImport } from './import.js';
import { defaultStyleGuide } from './schema.js';

const google = (family, fallback, weights, features = '') => ({ family, fallback, source: 'google', weights, features });
const SANS = 'system-ui, sans-serif';
const SERIF = 'Georgia, serif';
const MONO = 'ui-monospace, monospace';
const style = (font, size, mobileSize, weight, lineHeight, letterSpacing, usage, transform = 'none') => ({ font, size, mobileSize, weight, lineHeight, letterSpacing, transform, usage });

/** The twelve text styles at a given weight and tightness (sizes in px: display, h1…h4). */
function styles([display, h1, h2, h3, h4], { headingWeight = 700, subWeight = 600, tracking = -0.02, body = 16, bodyLine = 1.5 } = {}) {
  return {
    display: style('heading', display, Math.round(display * 0.64), headingWeight, 1.05, tracking, 'Hero headline'),
    h1: style('heading', h1, Math.round(h1 * 0.8), headingWeight, 1.1, tracking, 'Page title'),
    h2: style('heading', h2, Math.round(h2 * 0.82), headingWeight, 1.15, tracking / 2, 'Section heading'),
    h3: style('heading', h3, Math.round(h3 * 0.9), subWeight, 1.25, tracking / 2, 'Subsection heading'),
    h4: style('heading', h4, Math.round(h4 * 0.9), subWeight, 1.3, 0, 'Card and group titles'),
    'body-lg': style('body', body + 2, body + 2, 400, bodyLine + 0.1, 0, 'Lead paragraphs'),
    body: style('body', body, body, 400, bodyLine, 0, 'Default text'),
    'body-sm': style('body', body - 2, body - 2, 400, bodyLine, 0, 'Secondary text, table cells'),
    caption: style('body', 12, 12, 400, 1.4, 0.01, 'Captions and helper text'),
    overline: style('body', 12, 12, 600, 1.3, 0.08, 'Eyebrows and labels above headings', 'uppercase'),
    button: style('body', 14, 14, 500, 1.2, 0.01, 'Buttons and controls'),
    code: style('mono', 14, 14, 400, 1.5, 0, 'Code and data'),
  };
}

const palettes = (bases) => Object.fromEntries(Object.entries(bases).map(([key, [base, usage]]) => [key, { base, usage, locked: false, steps: scaleFromBase(base) }]));
const elevation = (sm, md, lg) => ({ none: { shadow: 'none', usage: 'Flat surfaces' }, sm: { shadow: sm, usage: 'Cards' }, md: { shadow: md, usage: 'Dropdowns, popovers' }, lg: { shadow: lg, usage: 'Modals' } });

export const PRESETS = Object.freeze([
  {
    id: 'synabun-default',
    name: 'SynaBun Default',
    description: 'A balanced blue and violet system on cool neutrals: a sensible start for any product.',
    patch: {
      brand: { personality: ['clear', 'capable', 'friendly'], vibe: 'Clean and modern with one confident accent: nothing decorative that does not help the reader.', keyCharacteristics: ['Cool neutrals with a single saturated primary', 'Geometric headings over a neutral body face', 'Medium radii and soft, short shadows'], voice: { tone: 'Plain, direct and helpful.', dos: ['Say what happens next'], donts: ['Use jargon where a plain word works'] } },
      colors: { palettes: palettes({ primary: ['#3b82f6', 'CTAs, links, focus'], secondary: ['#8b5cf6', 'Supporting actions and highlights'], accent: ['#eab308', 'Emphasis, badges, sparing decoration'], neutral: ['#64748b', 'Text, surfaces, borders'] }) },
      typography: { fonts: { heading: google('Space Grotesk', SANS, [600, 700]), body: google('Inter', SANS, [400, 500]), mono: google('JetBrains Mono', MONO, [400]) }, scale: { base: 16, ratio: 1.25, preset: 'major-third' }, styles: styles([56, 40, 32, 24, 20]) },
      shape: { radius: { none: 0, sm: 4, md: 8, lg: 12, xl: 16, pill: 9999 }, radiusRoles: { button: 'md', card: 'lg', input: 'sm', badge: 'pill', modal: 'xl' }, elevation: elevation('0 1px 2px rgba(0,0,0,.06)', '0 4px 12px rgba(0,0,0,.10)', '0 12px 32px rgba(0,0,0,.18)') },
      motion: { durations: { fast: 150, normal: 250, slow: 400 }, easings: { standard: 'cubic-bezier(0.2, 0, 0, 1)', enter: 'cubic-bezier(0, 0, 0.2, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)' } },
      iconography: { library: 'lucide', style: 'outline', strokeWidth: 1.5 },
      imagery: { style: 'photography', mood: 'Bright, natural light, real people and real screens', generation: { promptPrefix: 'Clean modern product photography, natural light, cool neutral background, one blue accent', negativePrompt: 'clutter, heavy filters, stock-photo poses' } },
      rules: { dos: ['Use the semantic color roles, not raw palette steps', 'One primary action per view'], donts: ['Mix more than two type families on a screen', 'Put body text on a saturated color'] },
    },
  },
  {
    id: 'minimal-saas',
    name: 'Minimal SaaS',
    description: 'Quiet indigo on near-white with one type family: calm, dense and easy to scan.',
    patch: {
      brand: { personality: ['calm', 'focused', 'trustworthy'], vibe: 'Almost nothing on the page except the work: generous whitespace, hairline borders, one indigo accent.', keyCharacteristics: ['A single sans-serif family at a few weights', 'Hairline borders instead of shadows', 'Small radii, flat surfaces'], voice: { tone: 'Short sentences, no hype.', dos: ['Lead with the outcome'], donts: ['Add exclamation marks'] } },
      colors: {
        palettes: palettes({ primary: ['#4f46e5', 'Primary actions, links, selection'], secondary: ['#0891b2', 'Secondary highlights, charts'], accent: ['#f97316', 'Rare emphasis: new, beta, upgrade'], neutral: ['#6b7280', 'Text, borders, surfaces'] }),
        semantic: { light: { background: '#ffffff', surface: '{neutral.50}', border: '{neutral.200}', onAccent: '#ffffff' } },
      },
      typography: { fonts: { heading: google('Inter', SANS, [600, 700]), body: google('Inter', SANS, [400, 500]), mono: google('JetBrains Mono', MONO, [400]) }, scale: { base: 15, ratio: 1.2, preset: 'minor-third' }, styles: styles([48, 34, 26, 20, 17], { headingWeight: 600, subWeight: 600, tracking: -0.02, body: 15 }) },
      layout: { container: { maxWidth: 1120, padding: 24 } },
      shape: { radius: { none: 0, sm: 4, md: 6, lg: 8, xl: 12, pill: 9999 }, radiusRoles: { button: 'md', card: 'lg', input: 'md', badge: 'pill', modal: 'xl' }, elevation: elevation('0 1px 1px rgba(17,24,39,.04)', '0 4px 10px rgba(17,24,39,.08)', '0 16px 40px rgba(17,24,39,.14)') },
      motion: { durations: { fast: 120, normal: 200, slow: 320 }, easings: { standard: 'cubic-bezier(0.2, 0, 0, 1)', enter: 'cubic-bezier(0, 0, 0.2, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)' } },
      iconography: { library: 'lucide', style: 'outline', strokeWidth: 1.5 },
      imagery: { style: 'abstract', mood: 'Product screenshots on plain backgrounds, soft gradients at most', generation: { promptPrefix: 'Minimal interface illustration, flat shapes, indigo and soft gray on white, lots of empty space', negativePrompt: '3D renders, people, busy backgrounds' } },
      rules: { dos: ['Separate regions with borders and whitespace', 'Keep one accent color per screen'], donts: ['Stack shadows on borders', 'Use color for decoration'] },
    },
  },
  {
    id: 'dark-developer',
    name: 'Dark Developer',
    description: 'A dark-first console look: cyan and violet on near-black, monospace details.',
    patch: {
      brand: { personality: ['precise', 'technical', 'fast'], vibe: 'A terminal that grew up: near-black surfaces, thin lines, luminous accents and code everywhere it helps.', keyCharacteristics: ['Dark by default, with a light theme for docs', 'Monospace for data, labels and numbers', 'Glowing accents used once per view'], voice: { tone: 'Exact and dry. Commands, not slogans.', dos: ['Show the command or the code'], donts: ['Explain what a developer already knows'] } },
      colors: {
        palettes: palettes({ primary: ['#22d3ee', 'Primary actions, links, live state'], secondary: ['#a78bfa', 'Syntax, tags, secondary highlights'], accent: ['#f472b6', 'Alerts worth a glance, diffs'], neutral: ['#71717a', 'Text, lines, surfaces'] }),
        semantic: {
          light: { link: '{primary.700}', primary: '{primary.600}', focus: '{primary.600}' },
          dark: { background: '#09090b', surface: '{neutral.950}', surfaceRaised: '{neutral.900}', border: '{neutral.800}', primary: '{primary.500}', link: '{primary.400}', focus: '{primary.500}' },
        },
        themes: { default: 'dark', supports: ['light', 'dark'] },
        gradients: [{ name: 'hero', css: 'linear-gradient(135deg, {primary.500}, {secondary.500})', usage: 'One glow behind the hero' }],
      },
      typography: { fonts: { heading: google('IBM Plex Sans', SANS, [500, 600]), body: google('IBM Plex Sans', SANS, [400, 500]), mono: google('IBM Plex Mono', MONO, [400, 500]) }, scale: { base: 15, ratio: 1.2, preset: 'minor-third' }, styles: styles([52, 36, 28, 21, 17], { headingWeight: 600, subWeight: 500, tracking: -0.02, body: 15 }) },
      shape: { radius: { none: 0, sm: 2, md: 4, lg: 6, xl: 10, pill: 9999 }, radiusRoles: { button: 'md', card: 'lg', input: 'md', badge: 'sm', modal: 'xl' }, elevation: elevation('0 0 0 1px rgba(255,255,255,.06)', '0 8px 24px rgba(0,0,0,.5)', '0 24px 64px rgba(0,0,0,.6)') },
      motion: { durations: { fast: 100, normal: 180, slow: 300 }, easings: { standard: 'cubic-bezier(0.2, 0, 0, 1)', enter: 'cubic-bezier(0, 0, 0.2, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)' } },
      iconography: { library: 'phosphor', style: 'outline', strokeWidth: 1.5 },
      imagery: { style: 'abstract', mood: 'Code, terminals and diagrams; glow on black', generation: { promptPrefix: 'Dark technical illustration, near-black background, thin cyan and violet lines, subtle glow, grid', negativePrompt: 'stock photos, bright backgrounds, cartoon style' } },
      rules: { dos: ['Set numbers, ids and shortcuts in the mono face', 'Keep surfaces one step apart in lightness'], donts: ['Use pure white text on pure black', 'Animate anything that blocks typing'] },
    },
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Serif headlines, long-form measure and a restrained red: made for reading.',
    patch: {
      brand: { personality: ['considered', 'literate', 'confident'], vibe: 'A printed magazine on a screen: strong serif headlines, a narrow measure, rules instead of boxes.', keyCharacteristics: ['High-contrast serif display over a text serif', 'Square corners and hairline rules', 'One red, used like a highlighter'], voice: { tone: 'Measured and specific. Full sentences.', dos: ['Write headlines that say something'], donts: ['Shout in capitals'] } },
      colors: {
        palettes: palettes({ primary: ['#b42318', 'Links, section marks, the one accent'], secondary: ['#1f3a5f', 'Secondary navigation, footers'], accent: ['#c8940a', 'Pull quotes, highlights'], neutral: ['#78716c', 'Text, rules, paper tones'] }),
        semantic: { light: { background: '#fdfcfa', surface: '{neutral.50}', text: '{neutral.950}', border: '{neutral.300}', link: '{primary.600}' } },
      },
      typography: { fonts: { heading: google('Playfair Display', SERIF, [600, 700, 800]), body: google('Source Serif 4', SERIF, [400, 600]), mono: google('IBM Plex Mono', MONO, [400]) }, scale: { base: 18, ratio: 1.333, preset: 'perfect-fourth' }, styles: styles([72, 52, 38, 28, 22], { headingWeight: 700, subWeight: 600, tracking: -0.01, body: 18, bodyLine: 1.6 }), principles: ['Body lines run 60 to 72 characters', 'Headlines are set tight, text is set loose'] },
      layout: { container: { maxWidth: 1080, padding: 32 }, principles: ['Whitespace separates stories; rules separate sections'] },
      shape: { radius: { none: 0, sm: 0, md: 2, lg: 2, xl: 4, pill: 9999 }, radiusRoles: { button: 'md', card: 'none', input: 'md', badge: 'md', modal: 'xl' }, elevation: elevation('0 1px 0 rgba(28,25,23,.08)', '0 6px 18px rgba(28,25,23,.10)', '0 18px 48px rgba(28,25,23,.16)') },
      motion: { durations: { fast: 150, normal: 250, slow: 450 }, easings: { standard: 'cubic-bezier(0.25, 0.1, 0.25, 1)', enter: 'cubic-bezier(0, 0, 0.2, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)' } },
      iconography: { library: 'phosphor', style: 'outline', strokeWidth: 1.25 },
      imagery: { style: 'photography', mood: 'Documentary, honest, uncropped where possible', generation: { promptPrefix: 'Editorial documentary photograph, natural color, soft daylight, considered composition', negativePrompt: 'HDR, oversaturated, staged smiles' } },
      rules: { dos: ['Give every image a caption or a credit', 'Let headlines break naturally'], donts: ['Center long text', 'Round the corners of photographs'] },
    },
  },
  {
    id: 'playful',
    name: 'Playful',
    description: 'Round, bright and bouncy: rose, violet and sunshine on big friendly shapes.',
    patch: {
      brand: { personality: ['cheerful', 'curious', 'kind'], vibe: 'Big rounded shapes, saturated color and motion with a little bounce: it should feel like a toy that works.', keyCharacteristics: ['Rounded display type and pill buttons', 'Three bright colors used together', 'Springy motion on taps and rewards'], voice: { tone: 'Warm and encouraging, never childish.', dos: ['Celebrate small wins'], donts: ['Blame the user for an error'] } },
      colors: {
        palettes: palettes({ primary: ['#f43f5e', 'Primary actions, hearts, streaks'], secondary: ['#7c3aed', 'Secondary actions, levels'], accent: ['#facc15', 'Rewards, stars, highlights'], neutral: ['#6b7280', 'Text and soft surfaces'] }),
        semantic: { light: { background: '#fffbf5', surface: '#ffffff', onAccent: '{neutral.900}' } },
        gradients: [{ name: 'hero', css: 'linear-gradient(135deg, {primary.400}, {secondary.500})', usage: 'Headers and celebration moments' }],
      },
      typography: { fonts: { heading: google('Fredoka', SANS, [500, 600, 700]), body: google('Nunito', SANS, [400, 600, 700]), mono: google('DM Mono', MONO, [400]) }, scale: { base: 17, ratio: 1.25, preset: 'major-third' }, styles: styles([60, 44, 34, 26, 21], { headingWeight: 600, subWeight: 600, tracking: -0.01, body: 17, bodyLine: 1.55 }) },
      shape: { radius: { none: 0, sm: 8, md: 12, lg: 20, xl: 28, pill: 9999 }, radiusRoles: { button: 'pill', card: 'lg', input: 'md', badge: 'pill', modal: 'xl' }, borders: { thin: 2, thick: 3 }, elevation: elevation('0 2px 0 rgba(17,24,39,.08)', '0 8px 0 rgba(17,24,39,.08)', '0 18px 40px rgba(124,58,237,.22)') },
      motion: { durations: { fast: 160, normal: 280, slow: 480 }, easings: { standard: 'cubic-bezier(0.34, 1.56, 0.64, 1)', enter: 'cubic-bezier(0.22, 1, 0.36, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)' } },
      iconography: { library: 'phosphor', style: 'duotone', strokeWidth: 2 },
      imagery: { style: 'illustration', mood: 'Chunky, rounded characters and objects in flat color', generation: { promptPrefix: 'Playful flat vector illustration, rounded chunky shapes, rose, violet and yellow, soft cream background', negativePrompt: 'photorealism, sharp corners, dark moods' } },
      rules: { dos: ['Round everything a finger touches', 'Use motion to reward, not to decorate'], donts: ['Put three bright colors behind text', 'Use bounce on errors'] },
    },
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'Dependable blue, dense tables and strict contrast: built for long working days.',
    patch: {
      brand: { personality: ['dependable', 'structured', 'efficient'], vibe: 'Information first: compact rows, clear hierarchy, conservative color and nothing that needs explaining.', keyCharacteristics: ['Compact spacing and 14px body text in data views', 'Blue for action, teal for status accents', 'Square-ish corners and visible focus'], voice: { tone: 'Neutral, precise, consistent terminology.', dos: ['Name things the way the domain does'], donts: ['Rename a feature between screens'] } },
      colors: {
        palettes: palettes({ primary: ['#1d4ed8', 'Primary actions, links, selected rows'], secondary: ['#0f766e', 'Secondary actions, positive trends'], accent: ['#b45309', 'Flags and items needing attention'], neutral: ['#64748b', 'Text, table lines, surfaces'] }),
        semantic: { light: { primary: '{primary.500}', link: '{primary.600}', onAccent: '#ffffff', border: '{neutral.300}' } },
      },
      typography: { fonts: { heading: google('Source Sans 3', SANS, [600, 700]), body: google('Source Sans 3', SANS, [400, 600]), mono: google('Source Code Pro', MONO, [400, 500]) }, scale: { base: 15, ratio: 1.2, preset: 'minor-third' }, styles: styles([44, 32, 25, 20, 17], { headingWeight: 600, subWeight: 600, tracking: -0.01, body: 15 }) },
      layout: { spacing: { base: 4, scale: { xs: 2, sm: 4, md: 8, lg: 12, xl: 16, '2xl': 24, '3xl': 32, '4xl': 48 } }, container: { maxWidth: 1440, padding: 24 }, grid: { columns: 12, gutter: 16 } },
      shape: { radius: { none: 0, sm: 2, md: 4, lg: 6, xl: 8, pill: 9999 }, radiusRoles: { button: 'md', card: 'lg', input: 'md', badge: 'sm', modal: 'xl' }, elevation: elevation('0 1px 2px rgba(15,23,42,.08)', '0 4px 12px rgba(15,23,42,.12)', '0 12px 32px rgba(15,23,42,.20)') },
      motion: { durations: { fast: 100, normal: 160, slow: 240 }, easings: { standard: 'cubic-bezier(0.2, 0, 0.38, 0.9)', enter: 'cubic-bezier(0, 0, 0.38, 0.9)', exit: 'cubic-bezier(0.2, 0, 1, 0.9)' } },
      iconography: { library: 'tabler', style: 'outline', strokeWidth: 1.75 },
      accessibility: { level: 'AA', minContrastText: 4.5, minContrastLarge: 3, minTouchTarget: 44 },
      imagery: { style: 'photography', mood: 'Workplaces and real products, neutral and unposed', generation: { promptPrefix: 'Professional workplace photograph, neutral tones, even light, calm composition', negativePrompt: 'handshakes, exaggerated smiles, lens flare' } },
      rules: { dos: ['Right-align numbers in tables', 'Keep the same action in the same place on every screen'], donts: ['Hide a destructive action behind an icon alone', 'Truncate without a tooltip'] },
    },
  },
  {
    id: 'fintech-precision',
    name: 'Fintech Precision',
    description: 'Deep green and ink with tabular numbers: money shown exactly and calmly.',
    patch: {
      brand: { personality: ['exact', 'calm', 'secure'], vibe: 'Numbers are the interface: aligned, tabular and never rounded without saying so. Deep green signals growth, ink carries everything else.', keyCharacteristics: ['Tabular figures everywhere an amount appears', 'Green for gain, a muted red for loss, never alone', 'Soft, wide shadows on a few raised cards'], voice: { tone: 'Exact and reassuring. State amounts, dates and fees.', dos: ['Show the currency and the sign'], donts: ['Use urgency to sell'] } },
      colors: {
        palettes: palettes({ primary: ['#0a7c66', 'Primary actions, positive amounts'], secondary: ['#1e293b', 'Navigation, dense headers'], accent: ['#c99a2e', 'Premium, rewards, highlights'], neutral: ['#5b6472', 'Text, dividers, surfaces'] }),
        semantic: { light: { background: '#fbfcfb', onSecondary: '#ffffff', link: '{primary.600}' } },
        status: { success: '#12805c', warning: '#c27803', danger: '#c2410c', info: '#0369a1' },
      },
      typography: { fonts: { heading: google('Manrope', SANS, [600, 700, 800]), body: google('Inter', SANS, [400, 500], '"tnum" 1, "cv11" 1'), mono: google('JetBrains Mono', MONO, [400, 500]) }, scale: { base: 16, ratio: 1.25, preset: 'major-third' }, styles: styles([54, 40, 30, 23, 19], { headingWeight: 700, subWeight: 600, tracking: -0.02 }), principles: ['Amounts use tabular figures and align on the decimal point'] },
      shape: { radius: { none: 0, sm: 6, md: 10, lg: 14, xl: 20, pill: 9999 }, radiusRoles: { button: 'md', card: 'lg', input: 'md', badge: 'pill', modal: 'xl' }, elevation: elevation('0 1px 2px rgba(10,35,30,.06)', '0 8px 24px rgba(10,35,30,.08)', '0 24px 56px rgba(10,35,30,.14)') },
      motion: { durations: { fast: 140, normal: 220, slow: 360 }, easings: { standard: 'cubic-bezier(0.2, 0, 0, 1)', enter: 'cubic-bezier(0, 0, 0.2, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)' } },
      iconography: { library: 'lucide', style: 'outline', strokeWidth: 1.75 },
      imagery: { style: 'abstract', mood: 'Calm charts and soft geometric forms, no cash or coins', generation: { promptPrefix: 'Calm abstract financial illustration, deep green and ink with a gold accent, soft gradients, precise lines', negativePrompt: 'piles of cash, coins, rockets, neon' } },
      rules: { dos: ['Pair color with a sign or an arrow for gains and losses', 'Confirm every transfer with the full amount'], donts: ['Animate a balance change longer than 400 ms', 'Round an amount silently'] },
    },
  },
  {
    id: 'warm-organic',
    name: 'Warm Organic',
    description: 'Terracotta, sage and cream with a soft serif: human, tactile and unhurried.',
    patch: {
      brand: { personality: ['warm', 'grounded', 'honest'], vibe: 'Paper, clay and leaves: warm off-whites, earthy color, soft corners and a serif with character.', keyCharacteristics: ['Cream surfaces instead of white', 'A soft serif for headings, a humanist sans for text', 'Large radii and diffuse warm shadows'], voice: { tone: 'Conversational and sincere.', dos: ['Write the way you would say it'], donts: ['Sound like a corporation'] } },
      colors: {
        palettes: palettes({ primary: ['#b4532a', 'Primary actions, links'], secondary: ['#5f7a54', 'Secondary actions, nature and calm'], accent: ['#e0a458', 'Highlights, seasonal moments'], neutral: ['#7a6f63', 'Text, lines, warm surfaces'] }),
        semantic: { light: { background: '#fbf7f1', surface: '#f4ede2', surfaceRaised: '#fffdf9', onAccent: '{neutral.950}' }, dark: { background: '#1c1815', surface: '#26211c' } },
      },
      typography: { fonts: { heading: google('Fraunces', SERIF, [500, 600, 700]), body: google('DM Sans', SANS, [400, 500]), mono: google('DM Mono', MONO, [400]) }, scale: { base: 17, ratio: 1.25, preset: 'major-third' }, styles: styles([60, 44, 34, 26, 21], { headingWeight: 600, subWeight: 500, tracking: -0.015, body: 17, bodyLine: 1.6 }) },
      shape: { radius: { none: 0, sm: 6, md: 10, lg: 16, xl: 24, pill: 9999 }, radiusRoles: { button: 'pill', card: 'lg', input: 'md', badge: 'pill', modal: 'xl' }, elevation: elevation('0 1px 3px rgba(74,52,33,.08)', '0 8px 24px rgba(74,52,33,.10)', '0 20px 48px rgba(74,52,33,.16)') },
      motion: { durations: { fast: 180, normal: 300, slow: 500 }, easings: { standard: 'cubic-bezier(0.25, 0.1, 0.25, 1)', enter: 'cubic-bezier(0.16, 1, 0.3, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)' } },
      iconography: { library: 'phosphor', style: 'outline', strokeWidth: 1.5 },
      imagery: { style: 'photography', mood: 'Natural materials, hands at work, warm daylight', generation: { promptPrefix: 'Warm natural-light photograph, earthy terracotta and sage tones, linen and clay textures, soft shadows', negativePrompt: 'cold blue light, plastic, glossy studio look' } },
      rules: { dos: ['Use cream surfaces and let photographs carry the color', 'Leave generous margins'], donts: ['Use pure white or pure black', 'Use sharp corners next to round ones'] },
    },
  },
]);

/** Preview data for one preset: its colors and its two main fonts. */
function preview(preset) {
  const { config } = buildImport(defaultStyleGuide(''), buildPatch(preset), { merge: 'replace' });
  const p = config.colors.palettes;
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    swatches: [p.primary.base, p.secondary.base, p.accent.base, p.neutral.base],
    fonts: { heading: config.typography.fonts.heading.family, body: config.typography.fonts.body.family },
    theme: config.colors.themes.default,
  };
}

function buildPatch(preset) {
  return JSON.parse(JSON.stringify(preset.patch));
}

/** [{ id, name, description, swatches, fonts: { heading, body }, theme }] */
export function listPresets() {
  return PRESETS.map(preview);
}

export function getPreset(id) {
  return PRESETS.find((preset) => preset.id === String(id || '')) || null;
}

/**
 * A preset over a guide. `replace` (the default): the preset over the defaults, keeping the project, the
 * logo files and the agent / export settings. `merge`: the preset's fields over the current guide.
 * → { config, diff }, or null for an unknown id.
 */
export function applyPreset(base, presetId, { merge = 'replace' } = {}) {
  const preset = getPreset(presetId);
  if (!preset) return null;
  return buildImport(base, buildPatch(preset), { merge: merge === 'merge' ? 'merge' : 'replace' });
}
