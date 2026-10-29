// Literal shell dataflow only. Tokens are never expanded or executed.
const runner = /^(?:bash|sh|zsh|dash|ksh|fish|python[23]?|node|perl|ruby|php|lua|pwsh|powershell|deno|bun|osascript|tclsh|Rscript|source|\.)$/;
// Arity belongs to the wrapper, never to a shared spelling: e.g. sudo -n
// takes no value, while nice/xargs -n do. Optional values must be attached.
const options = (value, none) => ({ value: new Set(value.split(' ').filter(Boolean)), none: new Set(none.split(' ').filter(Boolean)) });
const wrapperOptions = {
  exec: options('-a', '-c -l -f'),
  command: options('', '-p -v -V'),
  env: options('-u --unset -C --chdir -a --argv0 -P -S --split-string', '-i --ignore-environment -0 --null -v --debug --block-signal --default-signal --ignore-signal --list-signal-handling'),
  nohup: options('', '--help --version'),
  timeout: options('-k --kill-after -s --signal', '--foreground --preserve-status -v --verbose'),
  xargs: options('-a --arg-file -d --delimiter -E -I -L -n --max-args -P --max-procs -s --max-chars -J -R -S --process-slot-var', '-0 --null -o --open-tty -p --interactive -r --no-run-if-empty -t --verbose -x --exit -e --eof -i --replace -l --max-lines'),
  nice: options('-n --adjustment', '--help --version'),
  time: options('-o --output -f --format', '-a --append -p --portability -v --verbose -q --quiet -h -l'),
  setsid: options('', '-c --ctty -f --fork -w --wait'),
  sudo: options('-a --auth-type -c --login-class -u --user -g --group -C --close-from -D --chdir -h --host -p --prompt -r --role -t --type -U --other-user -T --command-timeout -R --chroot', '-A --askpass -B --bell -e --edit -v --validate -n --non-interactive -s --shell -k --reset-timestamp -P --preserve-groups -b --background -E --preserve-env -H --set-home -i --login -K --remove-timestamp -l --list -N --no-update -S --stdin -V --version'),
};
const wrapper = new RegExp(`^(?:${Object.keys(wrapperOptions).join('|')})$`);
function optionArgument(w, option) {
  const table = wrapperOptions[w];
  if (option.startsWith('--')) {
    const equals = option.indexOf('='), flag = equals < 0 ? option : option.slice(0, equals);
    return table.value.has(flag) ? { flag, attached: equals < 0 ? null : option.slice(equals + 1) } : null;
  }
  // Walk short clusters until a required value (possibly attached) or unknown
  // option. Unknown arity never consumes the next token: it may be the program.
  for (let i = 1; i < option.length; i++) {
    const flag = `-${option[i]}`;
    if (table.value.has(flag)) return { flag, attached: option.slice(i + 1) || null };
    if (!table.none.has(flag)) return null;
    if (w === 'xargs' && ['-e', '-i', '-l'].includes(flag)) return null;
  }
  return null;
}
const media = /\.(?:png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|mp[34]|m4[av]|wav|ogg|flac|webm|mov|avi)$/i;
const key = (p) => p?.replace(/^\.\//, '').replace(/\$\{([A-Za-z_]\w*)\}/g, '\$$1');
const base = (p) => p?.split('/').at(-1);
const tokenize = (s) => (s.match(/(?:"[^"\n]*"|'[^'\n]*'|[^\s"'|;&>])+/g) || []).map((s) => s.replace(/["']/g, ''));
function unwrap(tokens) {
  let t = tokens.slice(), wrapped = false;
  while (/^[A-Za-z_]\w*=/.test(t[0])) t.shift();
  for (let n = 0; n < 12 && wrapper.test(base(t[0])); n++) {
    const w = base(t.shift()); wrapped = true;
    while (t[0]?.startsWith('-') || ['env', 'sudo'].includes(w) && /^[A-Za-z_]\w*=/.test(t[0])) {
      const option = t.shift();
      if (option === '--') break;
      const argument = optionArgument(w, option);
      if (argument) {
        const value = argument.attached ?? t.shift();
        // env's split-string value can itself name the program. Tokenize the
        // literal value only; never perform shell expansion or execution.
        if (w === 'env' && ['-S', '--split-string'].includes(argument.flag)) t.unshift(...tokenize(value || ''));
      }
    }
    if (['env', 'sudo'].includes(w)) while (/^[A-Za-z_]\w*=/.test(t[0])) t.shift();
    if (w === 'timeout') t.shift();
  }
  return { tokens: t, wrapped };
}
function commands(file, functions) {
  // A bounded literal function body: calls substitute positional tokens, never eval shell strings.
  const source = /\.(?:md|markdown|mdx)$/i.test(file.path) ? file.text.replace(/`([^`\n]+)`/g, ';$1;') : file.text;
  const text = source.replace(/(?:^|[\n;])\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{([^{}]*)\}/g, (all, name, body, offset) => {
    functions.set(name, { text: body, file: file.path, line: file.text.slice(0, offset).split('\n').length });
    return all.replace(/[^\n]/g, ' ');
  });
  return { ...file, text };
}
export function shellFindings(files) {
  if (!files.some((f) => /\b(?:curl|wget|base64)\b/.test(f.text))) return { hits: [], complete: true };
  const functions = new Map(), prepared = files.map((f) => commands(f, functions));
  const hits = new Map(); let remaining = 100000;
  function walk(file, outputs, collect, depth = 0, written = new Set()) {
    if (depth > 8) { remaining = -1; return; }
    let line = file.line || 1, pipe = null;
    const normalized = file.text.replace(/\\\r?\n/g, '');
    for (const part of normalized.split(/(\n|;|&&|\|\||\|)/)) {
      if (--remaining < 0) return;
      if (part === '\n') { line++; pipe = null; continue; }
      if (/^(?:;|&&|\|\|)$/.test(part)) { pipe = null; continue; }
      if (part === '|' || !part.trim()) continue;
      const raw = part.trim().replace(/^`+|`+$/g, '');
      if (raw.startsWith('#')) continue;
      const { tokens: t, wrapped } = unwrap(tokenize(raw));
      const cmd = base(t[0]); if (!cmd) continue;
      const fn = functions.get(cmd);
      if (fn) {
        const body = fn.text.replace(/\$\{?([1-9])\}?/g, (_, n) => t[Number(n)] || '');
        walk({ ...fn, path: file.path, text: body, line }, outputs, collect, depth + 1, written); continue;
      }
      // A wrapper does not turn a bare PATH command into a relative file path.
      const arg = runner.test(cmd) ? t.slice(1).find((v) => !v.startsWith('-')) : t[0].includes('/') ? t[0] : null;
      const emit = (ruleId) => {
        if (collect) hits.set(`${file.path}:${line}:${ruleId}`, { ruleId, file: file.path, line, evidence: raw });
      };
      if (arg && outputs.has(key(arg))) emit(outputs.get(key(arg)));
      if (runner.test(cmd) && arg && media.test(arg)) emit('S-09-asset-exec');
      const remote = cmd === 'curl' || cmd === 'wget';
      const decode = cmd === 'base64' && t.some((s) => /^(?:-d|-D|--decode)$/.test(s));
      const origin = remote ? 'S-08-remote-file' : decode ? 'S-09-decode-file' : null;
      const redirect = /(?:^|\s)>{1,2}\s*((?:"[^"]*"|'[^']*'|[^\s;|&])+)/.exec(raw);
      let destination = redirect?.[1].replace(/["']/g, '');
      if (remote) {
        for (let i = 1; i < t.length; i++) {
          const long = (cmd === 'curl' ? /^--output(?:=(.*))?$/ : /^--output-document(?:=(.*))?$/).exec(t[i]);
          const short = (cmd === 'curl' ? /^-[a-zA-Z]*?o(.*)$/ : /^-[a-zA-Z]*?O(.*)$/).exec(t[i]);
          if (long || short) destination = (long || short)[1] || t[i + 1];
        }
      }
      if (destination && destination !== '-') {
        written.add(key(destination)); outputs.delete(key(destination));
        if (origin || pipe) outputs.set(key(destination), origin || pipe);
      }
      if (cmd === 'tee') for (const dest of t.slice(1).filter((s) => !s.startsWith('-'))) {
        written.add(key(dest)); outputs.delete(key(dest)); if (pipe) outputs.set(key(dest), pipe);
      }
      if (['cp', 'mv', 'ln', 'install'].includes(cmd)) {
        const args = t.slice(1).filter((s, i, a) => !s.startsWith('-') && !['-m', '-o', '-g', '-t'].includes(a[i - 1]));
        if (args.length >= 2) {
          const source = key(args.at(-2)), dest = key(args.at(-1)), taint = outputs.get(source);
          written.add(dest); outputs.delete(dest); if (taint) outputs.set(dest, taint);
          if (cmd === 'mv') outputs.delete(source);
        }
      }
      if (cmd === 'rm') for (const p of t.slice(1)) outputs.delete(key(p));
      pipe = origin || (cmd === 'tee' ? pipe : null);
    }
  }
  // Files have no reliable execution order. Seed each from the *other* files' final literal outputs,
  // then preserve production/overwrite/removal order within that file. Iterate for cross-file copies.
  let summaries = prepared.map(() => new Map());
  for (let pass = 0; pass <= prepared.length && remaining > 0; pass++) {
    let changed = false;
    const next = prepared.map((file, i) => {
      const seed = new Map(summaries.flatMap((s, j) => j === i ? [] : [...s]));
      const written = new Set(); walk(file, seed, false, 0, written);
      const own = new Map([...seed].filter(([p]) => written.has(p)));
      if (JSON.stringify([...own]) !== JSON.stringify([...summaries[i]])) changed = true;
      return own;
    });
    summaries = next; if (!changed) break;
  }
  for (let i = 0; i < prepared.length && remaining > 0; i++) walk(prepared[i], new Map(summaries.flatMap((s, j) => j === i ? [] : [...s])), true);
  return { hits: [...hits.values()], complete: remaining >= 0 };
}

// A command-shaped printable run in an image/font cannot be treated as passive metadata.
export function looksLikeShell(text) {
  return /(?:^|\n)\s*#!\s*\/[A-Za-z]|(?:^|[;|&`])\s*(?:(?:[A-Za-z_]\w*=\S+)\s+)*(?:curl|wget|sh|bash|zsh|dash|source|python[23]?|node|perl|ruby|php|lua|pwsh|deno|bun|osascript|tclsh|exec|eval|env|nohup|timeout|sudo|command|xargs|nice|time|setsid|chmod|chown|rm|cp|mv|ln|touch|mkdir|printf|echo|cat|tee|base64|export|unset|alias|read|set|trap)\s+\S|(?:^|[;|&`])\s*(?:\.\s+["']?(?:[\w$~]|\.{0,2}\/)[^\s;|&]*|(?:\.{1,2}\/|\/(?:usr\/bin|bin|tmp)\/)\S+\s+\S)|\$\([^)]*\)/.test(text);
}

const passive = new Set('cp mv ln rm mkdir ls stat file du wc touch shasum sha256sum md5 md5sum open xdg-open qlmanage sips magick convert identify optipng pngcrush cwebp ffmpeg fc-list fc-cache'.split(' '));
const readers = new Set(['cat', 'head', 'tail', 'xxd']);
const executableMode = (cmd, raw) => cmd === 'chmod' && /(?:^|\s)(?:[ugoa]*\+[^\s]*x|[0-7]*[1357][0-7]{2})(?:\s|$)/.test(raw)
  || cmd === 'install' && /(?:-m\s*|--mode[=\s]+)0?7[0-7]{2}\b/.test(raw);
function reviewParts(line) {
  const parts = []; let current = '', quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && quote !== "'") { current += c + (line[++i] || ''); continue; }
    if (quote) { current += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; current += c; continue; }
    if (c === '$' && line[i + 1] === '{') { const end = line.indexOf('}', i + 2); if (end >= 0) { current += line.slice(i, end + 1); i = end; continue; } }
    if (c === '$' && line[i + 1] === '(') continue;
    if (';|&(){}'.includes(c)) {
      let separator = ';';
      if (c === '|' || c === '&') { separator = c; if (line[i + 1] === c) { separator += c; i++; } }
      parts.push(current, separator); current = '';
    } else current += c;
  }
  parts.push(current); return parts;
}

// Raw-text catch-alls: no token expansion, quoting or command position can hide these
// capabilities. Vocabulary deliberately avoids English verbs such as plain "fetch"/"run".
const downloadText = /\b(?:curl|wget|aria2c|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|uudecode)\b|\bgit\s+clone\b|\b(?:fetch|https?)\s+(?:-[\w-]+\s+)*https?:\/\/|\b(?:fetch|urlopen|URI\.open|requests\.(?:get|request)|https?\.get)\s*\(|\b(?:python[23]?|node|ruby|perl)\b[^\n]*(?:get|request)[^\n]*https?:\/\/|\bbase64\b[^\n]*?(?:--decode\b|-[A-Za-z]*[dD][A-Za-z]*\b)|\bopenssl\s+(?:base64|enc)\b[^\n]*?\s-d\b|\bxxd\s+[^\n]*?-r\b/i;
const runText = /\b(?:bash|sh|zsh|dash|ksh|fish|python[23]?|node|perl|ruby|php|lua|pwsh|powershell|deno|bun|osascript|tclsh|Rscript|npx|eval|Invoke-Expression|iex)\b|\bpnpm\s+dlx\b|\bexec\s+["'`$./\w]|(?:^|[;|&()"'`])\s*(?:(?:env|nohup|command|sudo|exec)\s+(?:-[\w-]+\s+)*)?(?:\.{1,2}\/|\/[\w.-]+\/)[\w./$-]+|\$\{?[A-Za-z_]\w*\}?["']?\s+["'./\w$]|\bchmod\s+[^\n]*?(?:\+\w*x|[0-7]*[1357][0-7]{2})\b|\binstall\s+[^\n]*?(?:-m\s*|--mode[=\s]+)0?7[0-7]{2}\b/i;
// Unlike interpreter names, "make" is common prose. Require command position
// in code, or an unfenced command list starting with a known shell program.
function makeCommand(line) {
  // Consume a command character so an empty start cannot skip a leading brace.
  for (const match of line.matchAll(/(?:^|[;|&(`{])\s*(?:(?:if|then|elif|else|do|while|until|!)\s+)*([^\s;|&(`{])/g)) {
    const { tokens } = unwrap(tokenize(line.slice(match.index + match[0].length - 1)));
    if (/^make(?=[)}`]|$)/.test(tokens[0] || '')) return true;
  }
  return false;
}
function makeRun(line, code) {
  if (code) return makeCommand(line);
  if ([...line.matchAll(/`([^`\n]+)`/g)].some((m) => makeCommand(m[1]))) return true;
  return /^\s*(?:curl|wget|base64|echo|printf)\s/.test(line) && makeCommand(line);
}
const rawRun = (line, code) => runText.test(line) || makeRun(line, code) || /(?:^|[;|&(`])\s*\.\s+(?:["'$./~]|[a-z_][\w.-]*)/.test(line) || /\bsource\s+(?:["'`$./]|[\w-]+\.[\w.-]+)/.test(line)
  // A substitution in command position runs its result, including $(<file) and
  // $(cat file). Assignment/echo arguments alone do not run the substituted data.
  || /(?:^|[;|&(`])\s*(?:[A-Za-z_]\w*=\S+\s+)*(?:(?:env|nohup|command|sudo|exec)\s+(?:(?:-[\w-]+|[A-Za-z_]\w*=\S+)\s+)*)?["']?\$\(/.test(line)
  || (downloadText.test(line) || /\b(?:cat|head|tail|xxd|tee)\s+[^|]+\|/.test(line)) && !/^\s*\|.*\|\s*$/.test(line) && [...line.matchAll(/\|\s*([\w$./\\-]+)(?=\s|["'`)]|$)/g)].some((m) => !passive.has(base(m[1])) && !readers.has(base(m[1])) && base(m[1]) !== 'tee');
const assetText = /(?:[\w$~./-]+|\$\{\w+\})\.(?:png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|mp[34]|m4[av]|wav|ogg|flac|webm|mov|avi)(?=$|[^\w.-])/i;
const instruction = /^(?:Use|Run|Fetch|Read|See|Open|Copy|Move|Install|Download|Put|Place|Add|Include|Embed|Display|Save|The|This|A|An)\b\s*/i;
const article = /^(?:The|This|A|An|the|this|a|an)\b/;

function presentationFree(line) {
  // References are data, even when a value happens to contain a program's name.
  return line.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/\burl\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/gi, '')
    .replace(/(["'][^"'\n]+["']\s*:\s*)(?:"[^"\n]*"|'[^'\n]*')/g, '$1');
}
function assetInputs(line) {
  // URLs name remote resources, not local executable asset operands. Mask only
  // known curl/wget output options; preserve uploads, nested programs and later
  // commands, even if they use the very same filename as the output destination.
  return presentationFree(line).replace(/\bhttps?:\/\/[^\s"'`<>()[\]{};|]+/gi, '')
    .replace(/\b(curl|wget)\b[^;|&\n]*/g, (command, program) => command.replace(program === 'curl'
      ? /\s(?:--output(?:=|\s+)|-[A-Za-z]*?o\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s;|&()<>"']+)/g
      : /\s(?:--output-document(?:=|\s+)|-[A-Za-z]*?O\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s;|&()<>"']+)/g, (output) => /\$\(|`/.test(output) ? output : ' '))
    .replace(/\d*>{1,2}\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s;|&()<>]+)/g, (output) => /\$\(|`/.test(output) ? output : '')
    .replace(/(?:^|[;|&])\s*(?:echo|printf)\b[^;|&\n]*/g, (command, offset, text) => {
      // Literal presentation remains passive beside another command on this line.
      // Keep executable substitutions and anything handed down a pipe visible.
      if (/\$\(|`/.test(command) || text[offset + command.length] === '|') return command;
      return command.replace(new RegExp(assetText.source, 'gi'), '');
    });
}
function assetRun(line, markdown, fenced) {
  // A destination written by a tool is data, not an asset passed in to run.
  const raw = assetInputs(line);
  if (!assetText.test(raw)) return false;
  // Inspect inline code as code; on prose instructions remove only the instruction word.
  const inline = markdown && !fenced ? [...raw.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]) : [];
  const proseLine = raw.trim().replace(/^[-*+]\s+/, '');
  // A real passive command (notably `open`) keeps its quoted filename arguments.
  const proseBody = passive.has(proseLine.match(/^\S+/)?.[0]) ? proseLine : proseLine.replace(instruction, '');
  const candidates = [markdown && !fenced ? proseBody : raw, ...inline];
  for (const [index, candidate] of candidates.entries()) {
    if (!assetText.test(candidate)) continue;
    const prose = markdown && !fenced && index === 0;
    const proseLead = prose && (article.test(raw.trim()) || article.test(candidate.trim()));
    // Raw punctuation exposes nested/quoted bodies, including process substitutions. No
    // shell tokenizer is used: e.g. php "$(cat logo.png)" still names both on this line.
    for (const match of candidate.matchAll(/(?:^|[;|&(){}"'`])\s*(?:(?:if|then|elif|else|do|while|until|!)\s+)*((?:[\w$~./\\-]|\$\{\w+\})+)(?=\s|["'`,()<]|$)/g)) {
      const cmd = base(match[1].replace(/^\\/, ''));
      if (!cmd || media.test(cmd) || ['true', 'false', 'echo', 'printf'].includes(cmd) || passive.has(cmd) || readers.has(cmd)) continue;
      // Quoted arguments of a passive program are still arguments, not new
      // programs. Substitutions/argv expressions retain their raw punctuation.
      if (/^["']/.test(match[0]) && match.index > 0 && !/[([{},;|&]$/.test(candidate.slice(0, match.index).trim())) continue;
      const rest = candidate.slice(match.index + match[0].length).replace(/^["'`]+/, '');
      if (prose && match.index === 0 && /^[A-Z][a-z]+$/.test(cmd) && /^\s+`/.test(rest)) continue;
      if (prose && match.index === 0 && !runner.test(cmd) && !wrapper.test(cmd) && /^[A-Za-z]+$/.test(cmd)
        && (/^(?:image|logo|font|asset|media|icon|picture|illustration)$/i.test(cmd)
          || /^\s+(?:is|are|was|were|lives|contains|shows|belongs|the|an?|to|of)\b/i.test(rest))) continue;
      // An article-led description is prose, but never skip the whole line: code
      // later in that same line must still be inspected. A code-shaped first
      // operand also survives ("The php <(cat logo.png)" is still reviewable).
      if (proseLead && match.index === 0 && (article.test(cmd)
        || !/^\s+(?:[-<$"'`(]|[\w$~./-]+\.(?:png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|mp[34]|m4[av]|wav|ogg|flac|webm|mov|avi)\b)/i.test(rest))) continue;
      if (cmd === 'git' && /^\s+(?:add|mv|rm)\b/.test(rest)) continue;
      if (cmd === 'chmod' && !executableMode(cmd, candidate)) continue;
      // The raw line already names an asset. Any remaining command-shaped program
      // is reviewable, even when other operands precede the asset.
      if (runner.test(cmd) || wrapper.test(cmd) || cmd === 'busybox' || executableMode(cmd, candidate)
        || /^\s+\S/.test(rest)
        || /^\s*</.test(rest) || /^\s*$/.test(rest) && /[|>]/.test(candidate)) return true;
    }
    // A reader redirecting into a program is command evidence even if the program is
    // unknown. Plain file output and ordinary cat/head/tail/xxd stay passive.
    if (/\b(?:cat|head|tail|xxd)\b/.test(candidate) && />\s*(?:>\(|\$\()/.test(candidate)) return true;
  }
  return false;
}

// Join continuations while retaining the original first physical line as evidence.
const fenceMarker = /^\s*(`{3,}|~{3,})/;
function logicalLines(text, markdown) {
  const result = []; let value = '', first = 1;
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    // Fence syntax belongs to the physical Markdown line. Neither its info
    // string nor a preceding continuation may absorb the adjacent code line.
    if (markdown && fenceMarker.test(line)) {
      if (first < index + 1) result.push({ text: value, line: first });
      result.push({ text: line.replace(/\r$/, ''), line: index + 1 });
      value = ''; first = index + 2; continue;
    }
    value += line.replace(/\r$/, '');
    if (index < lines.length - 1 && value.endsWith('\\')) { value = value.slice(0, -1); continue; }
    result.push({ text: value, line: first }); value = ''; first = index + 2;
  }
  if (value) result.push({ text: value, line: first });
  return result;
}

export function shellReviewFindings(files) {
  let download = null, run = null;
  const hits = [];
  for (const file of files) {
    const markdown = /\.(?:md|markdown|mdx|txt)$/i.test(file.path);
    let fence = null;
    for (const { text: line, line: lineNo } of logicalLines(file.text, markdown)) {
      // Only the file's own shebang is excluded, not comments, examples or quoted text.
      if (lineNo === 1 && line.startsWith('#!')) continue;
      if (markdown) {
        const marker = fenceMarker.exec(line)?.[1];
        if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null; continue; }
      }
      const location = { file: file.path, line: lineNo, evidence: line.trim() };
      if (!download && downloadText.test(line)) download = location;
      if (!run && rawRun(line, !markdown || !!fence)) run = location;
      if (assetRun(line, markdown, !!fence)) hits.push({ ruleId: 'S-09-asset-exec', ...location });
      // Retain the precise pipe-through-tee evidence from 1.6. It is additional
      // evidence; the two catch-alls above never depend on this command parser.
      const parts = reviewParts(line); let pipedDownload = false;
      for (let i = 0; i < parts.length; i += 2) {
        const raw = parts[i].trim().replace(/^(?:(?:if|then|elif|else|do|while|until|!)\s+)+/, '');
        const { tokens: t } = unwrap(tokenize(raw)), cmd = base(t[0]);
        if (pipedDownload && runner.test(cmd)) hits.push({ ruleId: 'S-08-remote-pipe', ...location });
        pipedDownload = parts[i + 1] === '|' && (/^(?:curl|wget)$/.test(cmd) || pipedDownload);
      }
    }
  }
  if (download && run) hits.push({ ruleId: 'S-08-download-run', file: download.file, line: download.line,
    locations: { download, run }, evidence: `${download.file}:${download.line} ${download.evidence} → ${run.file}:${run.line} ${run.evidence}` });
  return hits;
}
