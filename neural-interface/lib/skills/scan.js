// ── What a skill can do, read without running anything ──
// A local, deterministic look at every file of a skill before it is installed: what it would run and when
// (scripts, Claude Code dynamic context, hooks that stay for the session, tool grants), what it reaches (URLs,
// sensitive paths, credentials), and what hides from a reader (invisible characters, look-alike names). Nothing
// is executed, fetched or sent anywhere; no configuration of the skill's own is honoured; time and bytes are
// bounded.
//
// The result is a record bound to the digest of the exact bytes scanned. Its `status` is `no_findings`,
// `findings`, `error` (the scan failed: never a pass) or `incomplete` (part of the skill could not be read:
// never a pass either), and its `gate` is what an install may do: `allowed`, `review` (a person confirms the
// findings for this digest) or `blocked`. A finding is evidence of capability, not a verdict of malice: a backup
// skill legitimately reads files and uploads them; it is shown so the person installing it knows.

import { findHiddenChars, inspectName, revealHidden } from '../../public/shared/skills/ss-unicode.js';
import { isEditableText } from '../../public/shared/skills/ss-doc.js';

export const SCAN_ENGINE = 'synabun-static';
export const SCAN_ENGINE_VERSION = '1.2.0';
// skills-p1: typosquats of a shipped skill's name (S-13), calibrated on tests/fixtures/skills-scan/corpus.json;
// 1.2.0: a name that is exactly a shipped skill's, on something that is not that skill (S-13-shipped-name).
export const SCAN_POLICY = 'skills-p1-2026-10-22b';
export const SCAN_LIMITS = Object.freeze({ maxFileChars: 2 * 1024 * 1024, maxTotalChars: 16 * 1024 * 1024, maxLineChars: 20000, maxFindings: 400 });

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

const SCRIPT_EXT = /\.(?:sh|bash|zsh|fish|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|lua|applescript|scpt)$/i;
const INSTRUCTION_EXT = /\.(?:md|markdown|txt|mdx)$/i;
const MAGIC = [
  [[0x7F, 0x45, 0x4C, 0x46], 'ELF program'],
  [[0xCF, 0xFA, 0xED, 0xFE], 'Mach-O program'], [[0xCE, 0xFA, 0xED, 0xFE], 'Mach-O program'],
  [[0xCA, 0xFE, 0xBA, 0xBE], 'Mach-O universal program'],
  [[0x4D, 0x5A], 'Windows program'],
  [[0x50, 0x4B, 0x03, 0x04], 'ZIP archive'], [[0x1F, 0x8B], 'gzip archive'], [[0x37, 0x7A, 0xBC, 0xAF], '7z archive'],
  [[0x00, 0x61, 0x73, 0x6D], 'WebAssembly module'],
];

// Each rule: id, severity, a pattern tested on one line, the message, what to do. Patterns are linear (no nested
// quantifiers over overlapping classes) and run on lines cut at maxLineChars.
const LINE_RULES = [
  { id: 'S-08-remote-pipe', severity: 'high', re: /\b(?:curl|wget|fetch|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]{0,400}\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b|\b(?:curl|wget)\b[^|\n]{0,400}\|\s*(?:sudo\s+)?(?:python3?|node|perl|ruby|iex|Invoke-Expression)\b/i,
    message: 'Downloads a script and runs it in one step.', remediation: 'Pin what is downloaded (a version, a checksum) and show it before it runs, or drop the step.' },
  { id: 'S-08-remote-subshell', severity: 'high', re: /\b(?:ba|z)?sh\s+(?:-c\s+)?["']?\$?\(\s*(?:curl|wget)\b|\bsource\s+<\(\s*(?:curl|wget)\b|\.\s+<\(\s*(?:curl|wget)\b/i,
    message: 'Runs a script fetched from the network.', remediation: 'Ship the script with the skill, or pin and verify it.' },
  { id: 'S-08-installer', severity: 'medium', re: /\b(?:npm\s+(?:i|install)\s+(?:-g|--global)\b|npx\s+(?:-y|--yes)\b|pip3?\s+install\b|pipx\s+install\b|brew\s+install\b|gem\s+install\b|cargo\s+install\b|go\s+install\b|apt(?:-get)?\s+install\b)/i,
    message: 'Installs software on the machine that runs it.', remediation: 'Say which package and version, and why; a reviewer decides.' },
  { id: 'S-09-decode-exec', severity: 'high', re: /\bbase64\s+(?:-d|--decode|-D)\b[^\n]{0,200}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\becho\s+[A-Za-z0-9+/=]{24,}\s*\|\s*base64\b|\b(?:eval|exec)\s*\(\s*(?:atob|Buffer\.from|base64\.b64decode|bytes\.fromhex|codecs\.decode)\b|FromBase64String\s*\([^)]{0,200}\)[^\n]{0,200}(?:Invoke-Expression|iex)\b|powershell(?:\.exe)?\s+[^\n]{0,80}-(?:e|en|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i,
    message: 'Decodes hidden text and runs it.', remediation: 'Write the command out in plain text, or remove it.' },
  { id: 'S-09-eval', severity: 'low', re: /\beval\s+["'`$(]|\beval\s*\(/,
    message: 'Builds a command at run time and evaluates it.', remediation: 'Prefer fixed commands a reader can check.' },
  { id: 'S-10-sensitive-path', severity: 'medium', re: /(?:~|\$HOME|%USERPROFILE%|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/(?:\.ssh|\.aws\/credentials|\.netrc|\.gnupg|\.kube\/config|\.docker\/config\.json|\.config\/gcloud|Library\/Keychains|Library\/Cookies|Library\/Application Support\/(?:Google\/Chrome|BraveSoftware|Firefox|Microsoft Edge|com\.apple\.TCC))|\bid_(?:rsa|ed25519|ecdsa)\b|\blogin\.keychain|\bsecurity\s+find-(?:generic|internet)-password\b|\/etc\/(?:shadow|sudoers)\b|\bLogin Data\b/i,
    message: 'Reads credentials or other private data of the user.', remediation: 'Say why it needs them; a reviewer decides.' },
  { id: 'S-05-authority-spoof', severity: 'medium', re: /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|prompts?)\b|\byou\s+are\s+now\s+(?:in\s+)?(?:developer|dan|god|jailbreak|unrestricted)\b|<\/?\s*system\s*>|\[\s*system\s*\]\s*:|\bdo\s+not\s+(?:tell|inform|show|mention\s+(?:this\s+)?to)\s+the\s+user\b|\bwithout\s+(?:asking|telling|informing)\s+the\s+user\b|\b(?:disable|bypass|turn\s+off|ignore)\s+(?:the\s+)?(?:safety|security|permission|sandbox|approval)\s+(?:checks?|prompts?|rules?|settings?|mode)\b/i,
    message: 'Text that tries to override instructions, hide what it does, or switch off a safeguard.', remediation: 'Remove it, or make sure it is quoted as an example and not an instruction.' },
  { id: 'S-07-persistent-write', severity: 'high', re: /(?:>>?\s*|\btee\s+(?:-a\s+)?|\bcp\s+[^\n]{0,200}\s|\bmv\s+[^\n]{0,200}\s|\bwrite(?:File)?\w*\s*\([^)]{0,200})["']?(?:~|\$HOME)?\/?[^\s"']{0,300}(?:\.bashrc|\.zshrc|\.bash_profile|\.profile|\.zprofile|\.config\/fish\/config\.fish|crontab|LaunchAgents\/|\.claude\/settings(?:\.local)?\.json|\.claude\/CLAUDE\.md|CLAUDE\.md|AGENTS\.md|\.codex\/config\.toml|\.mcp\.json|\.gitconfig)\b|\bcrontab\s+-[^l\s]|\blaunchctl\s+(?:load|bootstrap)\b/i,
    message: 'Changes configuration that lasts beyond this task (shell start-up files, scheduled jobs, agent settings or instructions).', remediation: 'Say what it changes and why; a reviewer decides.' },
];

const NETWORK_SINK = /\bcurl\b[^\n]{0,300}\s(?:-d|--data(?:-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file)\b|\bwget\b[^\n]{0,300}--post-(?:data|file)\b|\b(?:nc|ncat|netcat)\s+[^\n]{0,100}\d+|\bscp\s+[^\n]{0,300}@|\brsync\s+[^\n]{0,300}@[^\s:]+:|Invoke-(?:WebRequest|RestMethod)\b[^\n]{0,300}-Method\s+(?:Post|Put)\b|\brequests\.(?:post|put)\s*\(|\bfetch\s*\([^)]{0,300}method\s*:\s*["'](?:POST|PUT)["']/i;
const SECRET_ENV = /\$\{?(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?)[A-Z0-9_]*)\}?|\bprocess\.env\.[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)\b|\bos\.environ\b/;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]{1,300}/gi;

// Credentials written into a file: the value is never repeated in a finding.
const SECRET_PATTERNS = [
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe key', /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ['credential', /\b(?:api[_-]?key|secret|token|passwd|password|auth)\s*[:=]\s*["'][A-Za-z0-9_\-+/=.]{16,}["']/i],
];

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Edits (insert, delete, substitute, swap two neighbours) from one name to another, stopping above `max`. */
export function nameDistance(a, b, max = 3) {
  const s = String(a); const t = String(b);
  if (Math.abs(s.length - t.length) > max) return max + 1;
  const d = Array.from({ length: s.length + 1 }, (_, i) => [i, ...Array(t.length).fill(0)]);
  for (let j = 1; j <= t.length; j++) d[0][j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[s.length][t.length];
}

/** A known name this one is a slip away from (one edit; two for long names), or null. */
export function typosquatOf(name, known = []) {
  const plain = String(name ?? '').toLowerCase();
  if (plain.length < 4) return null;
  for (const k of known || []) {
    const ref = String(k ?? '').toLowerCase();
    if (!ref || ref === plain) continue;
    const limit = Math.min(ref.length, plain.length) >= 8 ? 2 : 1;
    if (nameDistance(plain, ref, limit) <= limit) return k;
  }
  return null;
}
const evidenceOf = (line) => clip(revealHidden(String(line).trim(), { identifier: false }).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' '));

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return null; }
}

/**
 * Scan the files of one artifact.
 * @param {object} o
 * @param {'skill'|'command'|'agent'} o.type
 * @param {string} o.name the folder (skill) or file name (command, agent) it would be installed under
 * @param {{ path: string, bytes: Buffer, executable?: boolean }[]} o.files
 * @param {object|null} [o.frontmatter] the head file's parsed metadata (for hooks and tool grants)
 * @param {string} o.digest the digest of exactly these files
 * @param {string[]} [o.knownNames] names it must not pass for (the bundled skills)
 * @param {string[]} [o.reservedNames] the shipped names this artifact is not: under one of them it would replace or
 *   shadow SynaBun's own skill (the caller leaves out the artifact's own name when it is that shipped skill)
 */
export function scanArtifact({ type, name, files, frontmatter = null, digest, knownNames = [], reservedNames = [] }) {
  const findings = [];
  const authority = { scripts: [], binaries: [], dynamicContext: [], hooks: [], toolGrants: [], domains: [], sensitive: [], persistentWrites: [], installers: [] };
  const coverage = { scanned: 0, skipped: [], complete: true };
  const add = (finding) => { if (findings.length < SCAN_LIMITS.maxFindings) findings.push(finding); };
  try {
    // The name it would be installed under.
    const look = inspectName(name, knownNames);
    if (look.hidden.length) add({ ruleId: 'S-12-hidden-name', severity: 'critical', file: null, line: null, message: `The name holds characters nobody can see (${look.hidden.map((h) => h.label).join(', ')}).`, evidence: revealHidden(name), remediation: 'Rename it with visible characters only.' });
    if (look.confusable || look.scripts.length > 1) add({ ruleId: 'S-13-confusable-name', severity: 'medium', file: null, line: null, message: `The name mixes scripts or uses letters that look Latin (reads as "${look.skeleton}").`, evidence: revealHidden(name), remediation: 'Use a plain ASCII name.' });
    if (look.impersonates) add({ ruleId: 'S-13-impersonation', severity: 'high', file: null, line: null, message: `The name looks like "${look.impersonates}", which SynaBun ships, but is not it.`, evidence: revealHidden(name), remediation: 'Rename it so it cannot pass for another skill.' });
    const squat = look.impersonates ? null : typosquatOf(name, knownNames);
    if (squat) add({ ruleId: 'S-13-impersonation', severity: 'high', file: null, line: null, message: `The name is a slip away from "${squat}", which SynaBun ships: it could be taken for it.`, evidence: revealHidden(name), remediation: 'Rename it so it cannot pass for another skill.' });
    const taken = (reservedNames || []).find((k) => String(k ?? '').toLowerCase() === String(name ?? '').toLowerCase());
    if (taken) add({ ruleId: 'S-13-shipped-name', severity: 'high', file: null, line: null, message: `It installs as "${taken}", the name of a skill SynaBun ships: it would replace or shadow SynaBun's own.`, evidence: revealHidden(name), remediation: 'Give it a name of its own, or customize the shipped skill in Skills Studio instead.' });

    // Frontmatter: hooks that stay for the session, tool grants for the invoking turn.
    const fm = frontmatter && typeof frontmatter === 'object' ? frontmatter : {};
    if (fm.hooks && typeof fm.hooks === 'object') {
      for (const [event, value] of Object.entries(fm.hooks)) {
        const commands = [];
        const walk = (v) => {
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === 'object') { if (typeof v.command === 'string') commands.push(v.command); Object.values(v).forEach((x) => { if (x && typeof x === 'object') walk(x); }); }
        };
        walk(value);
        authority.hooks.push({ event, commands: commands.map((c) => clip(c, 200)) });
      }
      add({ ruleId: 'S-07-hooks', severity: 'high', file: 'frontmatter', line: null, message: `Registers hooks (${authority.hooks.map((h) => h.event).join(', ')}) that stay active for the rest of the session once the skill is used.`, evidence: clip(authority.hooks.flatMap((h) => h.commands).join(' · ') || Object.keys(fm.hooks).join(', ')), remediation: 'Check every hook command; a reviewer decides.' });
    }
    for (const key of ['allowed-tools', 'tools']) {
      const value = fm[key];
      const list = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/,\s*|\s+(?![^(]*\))/).filter(Boolean) : []);
      for (const raw of list) {
        if (typeof raw !== 'string') continue;
        const tool = raw.trim();
        const broad = /^(?:Bash|Shell|PowerShell)(?:\(\s*\*?\s*\))?$/i.test(tool) || /^\*$/.test(tool);
        authority.toolGrants.push({ key, tool, broad });
      }
    }
    const broad = authority.toolGrants.filter((g) => g.broad);
    if (broad.length) add({ ruleId: 'S-06-broad-grant', severity: 'high', file: 'frontmatter', line: null, message: `Pre-approves ${broad.map((g) => g.tool).join(', ')} for the turn that invokes it: any shell command runs without asking.`, evidence: broad.map((g) => `${g.key}: ${g.tool}`).join(', '), remediation: 'Grant only the commands it needs, for example Bash(git status:*).' });

    let total = 0;
    for (const file of files) {
      const path = String(file.path);
      const bytes = file.bytes;
      const lower = path.toLowerCase();
      // Plugin parts run outside Claude's tool sandbox.
      if (/(^|\/)\.claude-plugin\//.test(path) || /(^|\/)hooks\/hooks\.json$/.test(path) || /(^|\/)\.mcp\.json$/.test(path) || /^bin\//.test(path)) {
        add({ ruleId: 'S-14-plugin-component', severity: 'high', file: path, line: null, message: 'A plugin component (hooks, MCP servers, programs) that runs outside the tool sandbox.', evidence: path, remediation: 'Install plugins as plugins, after reviewing them.' });
      }
      if (!isEditableText(bytes)) {
        const head = Array.from(bytes.subarray(0, 4));
        const magic = MAGIC.find(([sig]) => sig.every((b, i) => head[i] === b));
        authority.binaries.push({ path, size: bytes.length, kind: magic ? magic[1] : 'binary', executable: !!file.executable });
        if (magic || file.executable) {
          add({ ruleId: 'S-09-opaque-binary', severity: 'high', file: path, line: null, message: `${magic ? `A ${magic[1]}` : 'An executable binary file'} that could not be read: what it does is unknown.`, evidence: `${path} (${bytes.length} bytes)`, remediation: 'Ship source code instead, or remove it.' });
        }
        coverage.skipped.push({ path, reason: 'binary' });
        continue;
      }
      let text = bytes.toString('utf-8');
      if (text.length > SCAN_LIMITS.maxFileChars || total + text.length > SCAN_LIMITS.maxTotalChars) {
        coverage.skipped.push({ path, reason: 'too-large' });
        coverage.complete = false;
        continue;
      }
      total += text.length;
      coverage.scanned++;
      const isScript = SCRIPT_EXT.test(lower) || text.startsWith('#!') || !!file.executable;
      if (isScript) authority.scripts.push({ path, executable: !!file.executable, interpreter: text.startsWith('#!') ? clip(text.slice(2, text.indexOf('\n') > 0 ? text.indexOf('\n') : 80).trim(), 80) : null });
      const instructions = INSTRUCTION_EXT.test(lower) || (!isScript && !lower.includes('.'));

      // Hidden characters: in instructions and in scripts alike.
      for (const hit of findHiddenChars(text, { limit: 20 })) {
        add({ ruleId: 'S-12-hidden-chars', severity: hit.kind === 'bidi' || hit.kind === 'tag' ? 'high' : 'medium', file: path, line: hit.line, message: `A character nobody can see: ${hit.label}.`, evidence: evidenceOf(text.split('\n')[hit.line - 1] || ''), remediation: 'Remove it, or replace it with what it was meant to be.' });
      }

      const lines = text.split('\n');
      let inBangFence = false;
      let hasSensitive = false; let hasSink = false; let sinkLine = 0; let sensitiveLine = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].length > SCAN_LIMITS.maxLineChars ? lines[i].slice(0, SCAN_LIMITS.maxLineChars) : lines[i];
        const n = i + 1;
        // Claude Code dynamic context: !`command` inline, and ```! fenced blocks. They run before the model reads the skill.
        if (instructions) {
          if (/^\s*```!/.test(line)) { inBangFence = true; authority.dynamicContext.push({ file: path, line: n, command: '(block)' }); add({ ruleId: 'S-06-dynamic-context', severity: 'high', file: path, line: n, message: 'A shell block that Claude Code runs when the skill is loaded, before the model reads it, without asking.', evidence: evidenceOf(line), remediation: 'Make sure every command in it is safe to run unattended; a reviewer decides.' }); continue; }
          if (inBangFence) { if (/^\s*```\s*$/.test(line)) inBangFence = false; else if (authority.dynamicContext.length < 200) authority.dynamicContext.push({ file: path, line: n, command: clip(line.trim(), 200) }); }
          for (const m of line.matchAll(/!`([^`\n]{1,500})`/g)) {
            authority.dynamicContext.push({ file: path, line: n, command: clip(m[1], 200) });
            add({ ruleId: 'S-06-dynamic-context', severity: 'high', file: path, line: n, message: 'A shell command Claude Code runs when the skill is loaded, before the model reads it, without asking.', evidence: evidenceOf(m[0]), remediation: 'Make sure it is safe to run unattended; a reviewer decides.' });
          }
        }
        for (const rule of LINE_RULES) {
          if (!rule.re.test(line)) continue;
          add({ ruleId: rule.id, severity: rule.severity, file: path, line: n, message: rule.message, evidence: evidenceOf(line), remediation: rule.remediation });
          if (rule.id === 'S-10-sensitive-path') { hasSensitive = true; sensitiveLine = sensitiveLine || n; authority.sensitive.push({ file: path, line: n }); }
          if (rule.id === 'S-07-persistent-write') authority.persistentWrites.push({ file: path, line: n });
          if (rule.id === 'S-08-installer' || rule.id.startsWith('S-08-remote')) authority.installers.push({ file: path, line: n });
        }
        if (SECRET_ENV.test(line)) { hasSensitive = true; sensitiveLine = sensitiveLine || n; }
        if (NETWORK_SINK.test(line)) { hasSink = true; sinkLine = sinkLine || n; }
        for (const [label, re] of SECRET_PATTERNS) {
          const m = re.exec(line);
          if (!m) continue;
          const shown = `${m[0].slice(0, 4)}… (${m[0].length} characters)`;
          add({ ruleId: 'S-10-embedded-secret', severity: 'high', file: path, line: n, message: `Looks like a ${label} written into the skill.`, evidence: shown, remediation: 'Remove it and revoke it; read secrets from the user\'s own configuration at run time.' });
          break;
        }
        for (const m of line.matchAll(URL_RE)) {
          const host = hostOf(m[0]);
          if (host && !authority.domains.includes(host) && authority.domains.length < 200) authority.domains.push(host);
        }
      }
      if (hasSensitive && hasSink) {
        add({ ruleId: 'S-11-exfiltration', severity: 'high', file: path, line: sinkLine, message: `Reads private data or secrets (line ${sensitiveLine}) and sends data off the machine (line ${sinkLine}) in the same file.`, evidence: evidenceOf(lines[sinkLine - 1] || ''), remediation: 'Check exactly what is sent where; a reviewer decides.' });
      }
    }
  } catch (err) {
    return record({ type, name, digest, status: 'error', findings, authority, coverage: { ...coverage, complete: false }, error: String(err?.message || err) });
  }
  const status = !coverage.complete ? 'incomplete' : (findings.length ? 'findings' : 'no_findings');
  return record({ type, name, digest, status, findings, authority, coverage });
}

function record({ type, name, digest, status, findings, authority, coverage, error = null }) {
  const top = findings.reduce((max, f) => Math.max(max, SEVERITY_RANK[f.severity] ?? 0), -1);
  // A scan that failed or could not read everything never lets an install through on its own.
  let gate = 'allowed';
  if (status === 'error') gate = 'blocked';
  else if (top >= SEVERITY_RANK.critical) gate = 'blocked';
  else if (status === 'incomplete' || top >= SEVERITY_RANK.medium) gate = 'review';
  const sorted = findings.slice().sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || String(a.file).localeCompare(String(b.file)) || ((a.line || 0) - (b.line || 0)));
  return {
    engine: SCAN_ENGINE, engineVersion: SCAN_ENGINE_VERSION, policy: SCAN_POLICY,
    type, name, digest, status, gate, error,
    counts: Object.fromEntries(Object.keys(SEVERITY_RANK).map((s) => [s, findings.filter((f) => f.severity === s).length])),
    findings: sorted, authority, coverage,
    disclosure: 'Scanned on this computer. No file left it.',
  };
}

/** Whether an install may go ahead on this scan for these bytes, with what the person confirmed. */
export function scanAllows(scan, { digest, acknowledgedDigest = null } = {}) {
  if (!scan || scan.digest !== digest) return { ok: false, code: 'scan_stale', message: 'The scan is not of these files: scan them again.' };
  if (scan.status === 'error') return { ok: false, code: 'scan_error', message: `The scan failed (${scan.error || 'error'}): nothing is installed without one.` };
  if (scan.gate === 'blocked') return { ok: false, code: 'scan_blocked', message: 'The scan found something that blocks this install.' };
  if (scan.gate === 'review' && acknowledgedDigest !== digest) return { ok: false, code: 'review_required', message: 'Review the findings and confirm them for these exact files first.' };
  return { ok: true };
}
