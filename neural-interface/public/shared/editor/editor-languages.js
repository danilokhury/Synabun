// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: which language a file is
// ═══════════════════════════════════════════
//
// File name → the language it is highlighted as, and the word the status bar
// shows. A language is named the way @codemirror/language-data names it; the
// view looks the name up in the vendored bundle and loads its chunk. This table
// only holds what language-data does not know by itself: dotfiles, lockfiles
// and a few extensions. For every other name the view asks language-data.
// No DOM and no imports: loaded by `node --test` as it is.

const PROPERTIES = 'Properties files';

// Exact file names, lower case.
const BY_NAME = {
  // shell start-up files
  '.bashrc': { language: 'Shell' },
  '.bash_profile': { language: 'Shell' },
  '.bash_aliases': { language: 'Shell' },
  '.bash_logout': { language: 'Shell' },
  '.profile': { language: 'Shell' },
  '.zshrc': { language: 'Shell' },
  '.zshenv': { language: 'Shell' },
  '.zprofile': { language: 'Shell' },
  '.zlogin': { language: 'Shell' },
  '.envrc': { language: 'Shell' },
  // key = value files
  '.npmrc': { language: PROPERTIES, label: 'Properties' },
  '.yarnrc': { language: PROPERTIES, label: 'Properties' },
  '.editorconfig': { language: PROPERTIES, label: 'EditorConfig' },
  '.gitconfig': { language: PROPERTIES, label: 'Git Config' },
  '.gitmodules': { language: PROPERTIES, label: 'Git Config' },
  '.netrc': { language: null, label: 'Plain Text' },
  // JSON under another name
  '.babelrc': { language: 'JSON' },
  '.eslintrc': { language: 'JSON' },
  '.prettierrc': { language: 'JSON' },
  '.stylelintrc': { language: 'JSON' },
  '.swcrc': { language: 'JSON' },
  '.watchmanconfig': { language: 'JSON' },
  // lockfiles
  'package-lock.json': { language: 'JSON' },
  'npm-shrinkwrap.json': { language: 'JSON' },
  'composer.lock': { language: 'JSON' },
  'pipfile.lock': { language: 'JSON' },
  'flake.lock': { language: 'JSON' },
  'bun.lock': { language: 'JSON' },
  'deno.lock': { language: 'JSON' },
  'yarn.lock': { language: 'YAML' },
  'pnpm-lock.yaml': { language: 'YAML' },
  'cargo.lock': { language: 'TOML' },
  'poetry.lock': { language: 'TOML' },
  'uv.lock': { language: 'TOML' },
  'pdm.lock': { language: 'TOML' },
  'gemfile.lock': { language: null, label: 'Plain Text' },
  'go.sum': { language: null, label: 'Plain Text' },
  // build files
  'makefile': { language: 'Shell', label: 'Makefile' },
  'gnumakefile': { language: 'Shell', label: 'Makefile' },
  'containerfile': { language: 'Dockerfile' },
  'gemfile': { language: 'Ruby' },
  'rakefile': { language: 'Ruby' },
  'pipfile': { language: 'TOML' },
};

// File name patterns, first match wins.
const BY_PATTERN = [
  { test: /^\.env(\.|$)/i, language: PROPERTIES, label: 'ENV' },
  { test: /\.env$/i, language: PROPERTIES, label: 'ENV' },
  { test: /^\.[\w-]*ignore$/i, language: 'Shell', label: 'Ignore' },
  { test: /^dockerfile(\.|$)/i, language: 'Dockerfile' },
  { test: /\.dockerfile$/i, language: 'Dockerfile' },
  { test: /^\.(eslintrc|prettierrc|stylelintrc)\.json[c5]?$/i, language: 'JSON' },
];

// Extensions language-data has no entry for, lower case.
const BY_EXTENSION = {
  jsonc: { language: 'JSON' },
  json5: { language: 'JSON' },
  jsonl: { language: 'JSON' },
  ndjson: { language: 'JSON' },
  webmanifest: { language: 'JSON' },
  mdx: { language: 'Markdown' },
  mdc: { language: 'Markdown' },
  svelte: { language: 'HTML', label: 'Svelte' },
  astro: { language: 'HTML', label: 'Astro' },
  xhtml: { language: 'HTML' },
  plist: { language: 'XML' },
  zsh: { language: 'Shell' },
  fish: { language: 'Shell' },
  command: { language: 'Shell' },
  cfg: { language: PROPERTIES, label: 'Properties' },
  conf: { language: PROPERTIES, label: 'Properties' },
  ini: { language: PROPERTIES, label: 'INI' },
  properties: { language: PROPERTIES, label: 'Properties' },
  diff: { language: 'diff', label: 'Diff' },
  patch: { language: 'diff', label: 'Diff' },
};

/** The last path segment of `path`, whichever separator it uses. */
export function baseName(path) {
  const s = String(path ?? '');
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return cut === -1 ? s : s.slice(cut + 1);
}

/** The extension of a file name, lower case, without the dot. '' for a name that has none (a dotfile has none). */
export function extensionOf(fileName) {
  const name = baseName(fileName);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * What this table says about a file name.
 * @returns {{ language: string | null, label: string | null, known: boolean }}
 *   `known: false` → the table has no entry: ask language-data by file name.
 *   `language: null` with `known: true` → plain text, on purpose.
 *   `label: null` → show the language's own name.
 */
export function resolveLanguage(fileName) {
  const name = baseName(fileName);
  const lower = name.toLowerCase();
  const hit = BY_NAME[lower]
    || BY_PATTERN.find((p) => p.test.test(name))
    || BY_EXTENSION[extensionOf(name)];
  if (!hit) return { language: null, label: null, known: false };
  return { language: hit.language ?? null, label: hit.label ?? null, known: true };
}

/**
 * The word the status bar shows for a file.
 * @param {string} fileName
 * @param {string | null} languageName the name of the language that was found for it (language-data's), if any
 * @returns {string | null} null → plain text: the caller shows its own translated words
 */
export function languageLabel(fileName, languageName) {
  const { label, known, language } = resolveLanguage(fileName);
  if (label) return label === 'Plain Text' ? null : label;
  if (languageName) return languageName;
  if (known && language) return language;
  const ext = extensionOf(fileName);
  return ext ? ext.toUpperCase() : null;
}

/** Whether a file is Markdown (it gets the Raw / Preview switch). */
export function isMarkdownFile(fileName) {
  const ext = extensionOf(fileName);
  return ext === 'md' || ext === 'markdown' || ext === 'mkd' || ext === 'mdx' || ext === 'mdc';
}

/** Every language name this table can ask for (tests check each one exists in the bundle). */
export function namedLanguages() {
  const all = [...Object.values(BY_NAME), ...BY_PATTERN, ...Object.values(BY_EXTENSION)];
  return [...new Set(all.map((e) => e.language).filter(Boolean))].sort();
}
