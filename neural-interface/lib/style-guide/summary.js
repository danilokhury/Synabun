// ═══════════════════════════════════════════
// SynaBun — Style Guide summary for agents
// ═══════════════════════════════════════════
//
// The 300–500 token text a worker gets in its prompt (SPEC §7) and the `style_guide`
// tool returns for action `summary`: the brand in a line, the colors that matter in
// both themes, fonts and main text styles, spacing, radius roles, motion, icons,
// logo files, imagery direction and the top rules. Image and video runs get the
// imagery and the generation prefix first. Pure and deterministic; never more than
// SUMMARY_MAX_TOKENS by the estimate below (lines are dropped from the least
// important up).

import { STYLE_GUIDE_OUT_DIR, normalizeStyleGuide, resolveColor } from './schema.js';
import { guideName } from './render-design-md.js';
import { px, themesOf } from './tokens.js';

export const SUMMARY_MAX_TOKENS = 600;
const MEDIA_CLASSES = new Set(['image_gen', 'video_gen']);

/** A rough token count: four characters a token, the estimate the budget gauge uses elsewhere. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

const clip = (text, max) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value; };
const firstSentence = (text, max) => clip(String(text ?? '').split(/(?<=[.!?])\s/)[0], max);

function themeLine(config, theme) {
  const colors = config.colors.semantic[theme];
  const hex = (role) => resolveColor(config, colors[role], { theme });
  return `${theme}: background ${hex('background')}, surface ${hex('surface')}, text ${hex('text')}, muted ${hex('textMuted')}, border ${hex('border')}, primary ${hex('primary')} (text on it ${hex('onPrimary')}), link ${hex('link')}`;
}

/** The summary as prioritised lines: [{ text, keep }] (a higher `keep` survives a tight budget longer). */
function lines(config, taskClass) {
  const { brand, colors, typography, layout, shape, motion, iconography, logo, imagery, rules, agents } = config;
  const media = MEDIA_CLASSES.has(taskClass);
  const themes = themesOf(config);
  const out = [];
  const add = (group, keep, text) => { if (text) out.push({ group, keep, text }); };

  const about = brand.tagline || firstSentence(brand.description || brand.vibe, 160);
  add('brand', 9, `Brand: ${guideName(config)}${about ? ` — ${clip(about, 160)}` : ''}`);
  if (brand.personality.length) add('brand', 6, `Personality: ${brand.personality.slice(0, 5).join(', ')}.${brand.voice.tone ? ` Voice: ${clip(brand.voice.tone, 100)}` : ''}`);
  if (brand.audience) add('brand', 3, `Audience: ${clip(brand.audience, 120)}`);

  const palettes = Object.entries(colors.palettes).slice(0, 6).map(([key, palette]) => `${key} ${palette.base}`).join(', ');
  add('colors', 9, `Colors (${themes.join(' + ')}, default ${themes[0]}): ${palettes}`);
  for (const theme of themes) add('colors', theme === themes[0] ? 8 : 6, `- ${themeLine(config, theme)}`);
  add('colors', 5, `- status: ${Object.entries(colors.status).slice(0, 4).map(([key, hex]) => `${key} ${hex}`).join(', ')}`);

  const fonts = typography.fonts;
  const family = (font) => `${font.family} (${font.weights.join('/')})`;
  add('type', 8, `Fonts: headings ${family(fonts.heading)}, body ${family(fonts.body)}, mono ${fonts.mono.family}${fonts.display ? `, display ${fonts.display.family}` : ''}`);
  if (!media) {
    const main = ['display', 'h1', 'h2', 'h3', 'body', 'body-sm', 'caption', 'button'].filter((id) => typography.styles[id]);
    const ids = main.length >= 3 ? main : Object.keys(typography.styles).slice(0, 8);
    add('type', 6, `Text styles (px/line-height/weight): ${ids.map((id) => { const s = typography.styles[id]; return `${id} ${s.size}/${s.lineHeight}/${s.weight}`; }).join(', ')}`);
    add('layout', 6, `Spacing (base ${layout.spacing.base}px): ${Object.entries(layout.spacing.scale).slice(0, 10).map(([key, value]) => `${key} ${value}`).join(', ')}`);
    add('layout', 6, `Radius: ${Object.entries(shape.radiusRoles).slice(0, 6).map(([role, key]) => `${role} ${px(shape.radius[key])}`).join(', ')}`);
    add('motion', 4, `Motion: ${Object.entries(motion.durations).slice(0, 4).map(([key, value]) => `${key} ${value}ms`).join(', ')}; easing ${Object.values(motion.easings)[0] || 'ease'}${motion.reducedMotion === 'respect' ? '; honour prefers-reduced-motion' : ''}`);
    add('icons', 4, `Icons: ${iconography.library}, ${iconography.style}, ${iconography.strokeWidth}px stroke`);
  }
  const logos = logo.variants.filter((variant) => variant.file).slice(0, 4).map((variant) => `${variant.kind} ${STYLE_GUIDE_OUT_DIR}/${variant.file} (on ${variant.bg})`);
  if (logos.length) add('logo', media ? 7 : 5, `Logo: ${logos.join('; ')}; minimum ${px(logo.minSize.px)}${logo.clearSpace ? `; clear space ${clip(logo.clearSpace, 60)}` : ''}`);

  const imageryLead = media ? 10 : 5;
  add('imagery', imageryLead, `Imagery: ${imagery.style}${imagery.mood ? ` — ${clip(imagery.mood, 140)}` : ''}${imagery.notes ? `. ${clip(imagery.notes, media ? 240 : 120)}` : ''}`);
  if (imagery.generation.promptPrefix) add('imagery', media ? 10 : 5, `Image-generation prefix: "${clip(imagery.generation.promptPrefix, media ? 400 : 200)}"`);
  if (imagery.generation.negativePrompt) add('imagery', media ? 9 : 3, `Avoid in images: ${clip(imagery.generation.negativePrompt, media ? 240 : 120)}`);
  if (media && imagery.generation.aspectRatios.length) add('imagery', 8, `Aspect ratios: ${imagery.generation.aspectRatios.join(', ')}`);
  if (media && imagery.generation.styleReferences.length) add('imagery', 6, `Style references: ${imagery.generation.styleReferences.slice(0, 3).map((ref) => clip(ref, 80)).join('; ')}`);
  if (media && (imagery.dos.length || imagery.donts.length)) add('imagery', 7, [imagery.dos.length ? `Do: ${imagery.dos.slice(0, 3).map((item) => clip(item, 80)).join('; ')}` : '', imagery.donts.length ? `Don't: ${imagery.donts.slice(0, 3).map((item) => clip(item, 80)).join('; ')}` : ''].filter(Boolean).join(' '));

  if (rules.dos.length) add('rules', 7, `Do: ${rules.dos.slice(0, 4).map((item) => clip(item, 90)).join('; ')}`);
  if (rules.donts.length) add('rules', 7, `Don't: ${rules.donts.slice(0, 4).map((item) => clip(item, 90)).join('; ')}`);
  if (agents.instructions.trim()) add('instructions', 8, `Project instructions: ${clip(agents.instructions, 360)}`);

  if (media) {
    // Image and video runs read what shapes a picture first.
    const order = ['imagery', 'brand', 'colors', 'logo', 'type', 'rules', 'instructions'];
    out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  }
  return out;
}

/**
 * The compact block for one guide. `taskClass` image_gen / video_gen puts imagery and the generation
 * prefix first and leaves layout details out. → text (no trailing newline).
 */
export function styleGuideSummary(input, { taskClass = null, maxTokens = SUMMARY_MAX_TOKENS } = {}) {
  const config = normalizeStyleGuide(input);
  const all = lines(config, taskClass);
  const text = () => all.map((line) => line.text).join('\n');
  while (all.length > 1 && estimateTokens(text()) > maxTokens) {
    let drop = all.length - 1;
    for (let i = all.length - 1; i >= 0; i--) if (all[i].keep < all[drop].keep) drop = i;
    all.splice(drop, 1);
  }
  return text();
}

/** The summary for a task class (image_gen and video_gen lead with imagery). */
export function styleGuideSummaryForClass(config, taskClass) {
  return styleGuideSummary(config, { taskClass });
}
