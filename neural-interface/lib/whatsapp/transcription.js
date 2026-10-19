// WhatsApp Link — voice notes turned into text on this computer.
//
// Runs inside the WhatsApp host (host.js → host-core.js), the only process
// that loads Baileys: the adapter hands over the bytes of a voice note the
// owner sent (the owner and duplicate checks already passed) and gets its
// transcript back. Local only, nothing is ever downloaded: FFmpeg decodes the
// note to 16 kHz mono PCM, whisper.cpp's CLI (`whisper-cli`) and a ggml model
// turn that into text. The user installs all three (docs/whatsapp.md → Voice
// notes); SynaBun ships none of them.
//
//   - Both programs run with execFile (never a shell), windowsHide, a timeout,
//     arguments only and a minimal environment. FFmpeg reads local files and
//     pipes only, only the audio containers WhatsApp sends and only audio
//     decoders (-protocol_whitelist, -format_whitelist, -codec_whitelist: a
//     forwarded file is third-party data). A program found on PATH is never
//     one inside SynaBun, a dependency's node_modules or a Windows app alias.
//   - The decoded duration is what counts (600 s at most), whatever the
//     message said about itself.
//   - The audio and every copy of it live in a private scratch folder (0700,
//     one mkdtemp per note) that is removed in `finally`; folders a crash left
//     behind are removed when the next host starts.
//   - No output of either program is logged or returned: it can hold the
//     transcript. A failure is a reason and a stage word, nothing more.
//   - One note at a time (a queue), so several notes never saturate the CPU.
//
// The main process imports the pure parts only (resolveTranscriptionTools,
// checkToolPath, settingsFromPrefs): Settings shows what is missing and
// config.js refuses a path that cannot work. It never runs a tool.

import { execFile as nodeExecFile } from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodeFsp from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, TRANSCRIPTION_LANGUAGE_RE } from './protocol.js';

export const TRANSCRIPTION_LIMITS = Object.freeze({
  maxBytes: LIMITS.MAX_AUDIO_BYTES,
  maxSeconds: LIMITS.MAX_AUDIO_SECONDS,
  decodeTimeoutMs: 30_000,
  runTimeoutMs: 180_000,
  // Availability is looked at again on every configure, and otherwise at most this often.
  recheckMs: 60_000,
  maxThreads: 8,
  // A transcript longer than this is cut (the inbound message holds 8,192 characters anyway).
  maxTranscriptChars: 65_536,
});

/** The demuxers FFmpeg may use: the containers WhatsApp sends audio in (verified with FFmpeg 9.0.1 on macOS). */
export const AUDIO_FORMATS = Object.freeze(['ogg', 'mp3', 'mov', 'aac', 'amr', 'amrnb', 'amrwb', 'wav', 'matroska', 'flac']);
/** The decoders FFmpeg may open (probing included): the audio codecs those containers carry, FFmpeg's own names. */
export const AUDIO_DECODERS = Object.freeze([
  'opus', 'vorbis', 'mp3float', 'mp3', 'aac', 'aac_fixed', 'alac', 'amrnb', 'amrwb', 'flac',
  'pcm_s16le', 'pcm_s16be', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8', 'pcm_alaw', 'pcm_mulaw',
]);
/** What the programs get of the environment: where to look and where temporary files go, nothing else (no keys, no proxies). */
const PROGRAM_ENV = Object.freeze(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT', 'WINDIR']);
// SynaBun's own folder (neural-interface/lib/whatsapp → the package root): never searched for a program.
const SYNABUN_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const TOOL_IDS = Object.freeze(['engine', 'model', 'ffmpeg']);
export const MODEL_FILE = 'ggml-small.bin';
const SAMPLE_RATE = 16_000;
const PCM_BYTES_PER_SECOND = SAMPLE_RATE * 2; // mono, 16-bit
const SCRATCH = 'scratch';
const SCRATCH_PREFIX = 'vn-';
// What whisper.cpp writes for a stretch without speech: not words.
const NON_SPEECH = /\[BLANK_AUDIO\]/gi;

const pathApi = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const programName = (name, platform) => (platform === 'win32' ? `${name}.exe` : name);

/** The variable `name` of `env`, by any letter case on Windows (Path, PATH). */
function envValue(env, name, platform) {
  if (!env || typeof env !== 'object') return '';
  if (platform !== 'win32') return typeof env[name] === 'string' ? env[name] : '';
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key && typeof env[key] === 'string' ? env[key] : '';
}

/** A UNC path or another network location (`\\server\share`, `//server/share`): not on this computer. */
function isNetworkPath(value) {
  return /^[\\/]{2}/.test(value);
}

/**
 * A PATH folder that is not the user's own tools (the rules of lib/cli-resolver.js): a dependency's
 * node_modules (an npm-launched server has node_modules/.bin on PATH), a Windows app alias folder, or
 * SynaBun's own folder.
 */
export function isForeignProgramDir(dir, { platform = process.platform, root = SYNABUN_ROOT } = {}) {
  const text = String(dir || '');
  if (/(?:^|[\\/])node_modules(?:[\\/]|$)/i.test(text)) return true;
  if (/[\\/]microsoft[\\/]windowsapps(?:[\\/]|$)/i.test(text)) return true;
  const p = pathApi(platform);
  const fold = (value) => p.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const own = fold(root);
  const here = fold(text);
  return here === own || here.startsWith(`${own}/`);
}

/** The environment a program runs with: PROGRAM_ENV only (any letter case on Windows). */
export function programEnv(env = process.env, platform = process.platform) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (typeof value !== 'string') continue;
    if (PROGRAM_ENV.includes(platform === 'win32' ? key.toUpperCase() : key)) out[key] = value;
  }
  return out;
}

/**
 * Whether `value` names a tool SynaBun may use: an absolute path on this
 * computer to an existing regular file (links are followed), executable when
 * `kind` is 'program' (an .exe on Windows), readable and not empty when it is
 * 'file'. Never looked up on PATH.
 * @returns {null | 'not_absolute'|'network'|'missing'|'not_file'|'not_executable'|'unreadable'|'empty'} null when it can be used
 */
export function checkToolPath(value, kind = 'program', { platform = process.platform, fs = nodeFs } = {}) {
  const p = pathApi(platform);
  if (typeof value !== 'string' || !value || !p.isAbsolute(value)) return 'not_absolute';
  if (isNetworkPath(value)) return 'network';
  let stat;
  try { stat = fs.statSync(value); } catch { return 'missing'; }
  if (!stat?.isFile?.()) return 'not_file';
  if (kind === 'program') {
    if (platform === 'win32') return /\.exe$/i.test(value) ? null : 'not_executable';
    try { fs.accessSync(value, fs.constants?.X_OK ?? 1); } catch { return 'not_executable'; }
    return null;
  }
  if (!(Number(stat.size) > 0)) return 'empty';
  try { fs.accessSync(value, fs.constants?.R_OK ?? 4); } catch { return 'unreadable'; }
  return null;
}

/**
 * The folders a program is looked for in: PATH (absolute entries on this computer only, never a
 * dependency's or SynaBun's own: isForeignProgramDir), then Homebrew's on macOS.
 */
export function programDirs({ env = process.env, platform = process.platform, root = SYNABUN_ROOT } = {}) {
  const p = pathApi(platform);
  const dirs = envValue(env, 'PATH', platform)
    .split(platform === 'win32' ? ';' : ':')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    // A relative entry would resolve against whatever the current folder is.
    .filter((dir) => dir && p.isAbsolute(dir) && !isNetworkPath(dir) && !isForeignProgramDir(dir, { platform, root }));
  // A server started from the Dock or Finder may not have Homebrew on PATH.
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  return [...new Set(dirs)];
}

/**
 * Where the engine, the model and FFmpeg are, in this order:
 *   engine  the override; else <home>/bin/whisper-cli(.exe), <home>/bin/Release/whisper-cli(.exe)
 *           (the layout of the official Windows zip), then whisper-cli on PATH and, on macOS,
 *           in /opt/homebrew/bin and /usr/local/bin
 *   ffmpeg  the override; else <home>/bin/ffmpeg(.exe), then PATH and the Homebrew folders
 *   model   the override; else <home>/ggml-small.bin
 * An override is used as it is or not at all: one that cannot be used is missing (and `invalid`),
 * never replaced by a search.
 * @returns {{engine:string|null, model:string|null, ffmpeg:string|null, missing:string[], invalid:string[], available:boolean}}
 */
export function resolveTranscriptionTools({
  home = null, enginePath = '', modelPath = '', ffmpegPath = '', env = process.env, platform = process.platform, fs = nodeFs, root = SYNABUN_ROOT,
} = {}) {
  const p = pathApi(platform);
  const usable = (candidate, kind) => checkToolPath(candidate, kind, { platform, fs }) === null;
  const invalid = [];
  const pick = (id, override, kind, candidates) => {
    if (override) {
      if (usable(override, kind)) return override;
      invalid.push(id);
      return null;
    }
    return candidates.find((candidate) => usable(candidate, kind)) || null;
  };
  const homeDir = typeof home === 'string' && home && p.isAbsolute(home) ? home : null;
  const inHome = (...parts) => (homeDir ? [p.join(homeDir, ...parts)] : []);
  const dirs = programDirs({ env, platform, root });
  const onPath = (name) => dirs.map((dir) => p.join(dir, programName(name, platform)));
  const engine = pick('engine', enginePath, 'program', [
    ...inHome('bin', programName('whisper-cli', platform)),
    ...inHome('bin', 'Release', programName('whisper-cli', platform)),
    ...onPath('whisper-cli'),
  ]);
  const model = pick('model', modelPath, 'file', inHome(MODEL_FILE));
  const ffmpeg = pick('ffmpeg', ffmpegPath, 'program', [...inHome('bin', programName('ffmpeg', platform)), ...onPath('ffmpeg')]);
  const found = { engine, model, ffmpeg };
  const missing = TOOL_IDS.filter((id) => !found[id]);
  return { ...found, missing, invalid, available: missing.length === 0 };
}

/** The transcription preferences of a configure (protocol.js PREFS_SPEC); a host never configured transcribes nothing. */
export function settingsFromPrefs(prefs = {}) {
  const text = (value) => (typeof value === 'string' ? value : '');
  return {
    enabled: prefs?.transcriptionEnabled === true,
    language: TRANSCRIPTION_LANGUAGE_RE.test(text(prefs?.transcriptionLanguage)) ? prefs.transcriptionLanguage : 'auto',
    enginePath: text(prefs?.transcriptionEnginePath),
    modelPath: text(prefs?.transcriptionModelPath),
    ffmpegPath: text(prefs?.transcriptionFfmpegPath),
  };
}

/** A 44-byte RIFF/WAVE header for 16 kHz mono 16-bit PCM of `dataBytes` bytes. */
export function wavHeader(dataBytes) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);            // fmt chunk size
  header.writeUInt16LE(1, 20);             // PCM
  header.writeUInt16LE(1, 22);             // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(PCM_BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);             // block align
  header.writeUInt16LE(16, 34);            // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

// `file:` keeps a path from ever reading as an option or another protocol.
const fileUrl = (target) => `file:${target}`;

/** FFmpeg: local files only, WhatsApp's audio containers and audio decoders only, at most maxSeconds + 1 s of 16 kHz mono s16le. */
export function ffmpegArgs(input, output, { maxSeconds = TRANSCRIPTION_LIMITS.maxSeconds } = {}) {
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
    '-protocol_whitelist', 'file,pipe', '-format_whitelist', AUDIO_FORMATS.join(','), '-codec_whitelist', AUDIO_DECODERS.join(','),
    '-i', fileUrl(input),
    '-vn', '-t', String(maxSeconds + 1), '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', fileUrl(output),
  ];
}

/** whisper-cli: greedy decoding (-bs 1 -bo 1), text without timestamps into `<outBase>.txt`. No -ng: a Metal or CUDA build may use its GPU. */
export function whisperArgs({ model, wav, language, threads, outBase }) {
  return ['-m', model, '-f', wav, '-l', language, '-t', String(threads), '-bs', '1', '-bo', '1', '-nt', '-otxt', '-of', outBase];
}

/** whisper.cpp's text file as one line: whitespace collapsed, non-speech markers dropped. */
export function cleanTranscript(raw, max = TRANSCRIPTION_LIMITS.maxTranscriptChars) {
  return String(raw ?? '').replace(NON_SPEECH, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

const STAGE_TEXT = Object.freeze({
  missing_tool: 'a program or the model it needs is no longer there',
  bad_audio: 'the audio was empty or too large',
  download: 'the audio could not be stored for decoding',
  decode_failed: 'FFmpeg could not decode the audio',
  decode_timeout: 'FFmpeg took longer than 30 s',
  no_audio: 'the decoded audio was empty',
  too_long: 'the audio is longer than 10 minutes',
  engine_failed: 'whisper-cli failed',
  engine_timeout: 'whisper-cli took longer than 3 minutes',
  no_text: 'whisper-cli found no words',
  stopped: 'the WhatsApp connector stopped',
});

function stageError(stage) {
  const error = new Error(stage);
  error.stage = stage;
  return error;
}

/**
 * @param {object} o
 * @param {string|null} o.home      the transcription home (paths.js transcriptionDir)
 * @param {Function} [o.execFile]   child_process.execFile-shaped (tests pass a fake)
 * @param {object} [o.fs]           sync stat/access (resolution and checks)
 * @param {object} [o.files]        fs/promises-shaped (scratch folders and files)
 * @param {(level:string, message:string) => void} [o.log]  never given subprocess output
 */
export function createTranscriber({
  home = null,
  env = process.env,
  platform = process.platform,
  execFile = nodeExecFile,
  fs = nodeFs,
  files = nodeFsp,
  parallelism = () => availableParallelism(),
  now = () => Date.now(),
  limits = {},
  log = () => {},
} = {}) {
  const L = { ...TRANSCRIPTION_LIMITS, ...(limits || {}) };
  const p = pathApi(platform);
  let settings = settingsFromPrefs({});
  let tools = null;          // { at, value } of resolveTranscriptionTools
  let chain = Promise.resolve();
  let waiting = 0;           // notes queued or running
  let child = null;          // the program running now
  let currentDir = null;     // the scratch folder of the note being transcribed
  let stopped = false;
  const childEnv = programEnv(env, platform);
  const scratchRoot = typeof home === 'string' && home && p.isAbsolute(home) ? p.join(home, SCRATCH) : null;

  const say = (level, message) => { try { log(level, `[whatsapp] ${message}`); } catch {} };

  // What a crash left behind (the folder of a note whose `finally` never ran).
  if (scratchRoot) {
    try {
      for (const name of fs.readdirSync(scratchRoot)) {
        if (name.startsWith(SCRATCH_PREFIX)) { try { fs.rmSync(p.join(scratchRoot, name), { recursive: true, force: true }); } catch {} }
      }
    } catch {}
  }

  function check({ force = false } = {}) {
    if (!force && tools && now() - tools.at < L.recheckMs) return tools.value;
    const value = resolveTranscriptionTools({ home, enginePath: settings.enginePath, modelPath: settings.modelPath, ffmpegPath: settings.ffmpegPath, env, platform, fs });
    tools = { at: now(), value };
    return value;
  }

  /** New preferences (every configure): the tools are looked at again at once. */
  function configure(prefs = {}) {
    settings = settingsFromPrefs(prefs);
    tools = null;
    check({ force: true });
    return status();
  }

  function status() {
    const v = check();
    return { enabled: settings.enabled, available: v.available, missing: [...v.missing], invalid: [...v.invalid], language: settings.language, pending: waiting };
  }

  /** Text ready to be asked for: on, and the engine, the model and FFmpeg found (looked at again at most every minute). */
  function available() {
    return settings.enabled && !!scratchRoot && check().available;
  }

  /** Right before a program runs: the file it was resolved to is still a usable one. */
  function ensure(file, kind) {
    if (checkToolPath(file, kind, { platform, fs }) !== null) throw stageError('missing_tool');
  }

  function run(file, args, { timeoutMs, cwd, timeoutStage, failStage }) {
    return new Promise((resolve, reject) => {
      if (stopped) { reject(stageError('stopped')); return; }
      let proc;
      try {
        proc = execFile(file, args, {
          cwd, env: childEnv, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer',
        }, (error) => {
          if (child === proc) child = null;
          // Neither stdout nor stderr is read: they can hold the transcript.
          if (!error) { resolve(); return; }
          if (stopped) reject(stageError('stopped'));
          else if (error.code === 'ENOENT' || error.code === 'EACCES') reject(stageError('missing_tool'));
          else if (error.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(stageError(timeoutStage));
          else reject(stageError(failStage));
        });
      } catch {
        reject(stageError(failStage));
        return;
      }
      child = proc;
    });
  }

  async function transcribeNow(audio) {
    if (stopped) throw stageError('stopped');
    if (!settings.enabled) return { ok: false, reason: 'transcription_disabled', stage: 'disabled' };
    const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
    if (!bytes.length) throw stageError('bad_audio');
    if (bytes.length > L.maxBytes) return { ok: false, reason: 'too_large', stage: 'too_large' };
    // Checked again right before anything runs: an override (or a found program) may be gone or replaced.
    const found = check({ force: true });
    if (!found.available || !scratchRoot) throw stageError('missing_tool');
    let dir = null;
    try {
      try {
        await files.mkdir(scratchRoot, { recursive: true, mode: 0o700 });
        await files.chmod(scratchRoot, 0o700).catch(() => {});
        dir = await files.mkdtemp(p.join(scratchRoot, SCRATCH_PREFIX));
        currentDir = dir;
        await files.chmod(dir, 0o700).catch(() => {});
      } catch {
        throw stageError('download');
      }
      const input = p.join(dir, 'audio.in');
      const pcmPath = p.join(dir, 'audio.pcm');
      const wavPath = p.join(dir, 'audio.wav');
      const outBase = p.join(dir, 'transcript');
      try { await files.writeFile(input, bytes, { mode: 0o600, flag: 'wx' }); } catch { throw stageError('download'); }
      ensure(found.ffmpeg, 'program');
      await run(found.ffmpeg, ffmpegArgs(input, pcmPath, { maxSeconds: L.maxSeconds }), { timeoutMs: L.decodeTimeoutMs, cwd: dir, timeoutStage: 'decode_timeout', failStage: 'decode_failed' });
      let pcm;
      try { pcm = await files.readFile(pcmPath); } catch { throw stageError('decode_failed'); }
      // The decoded duration counts, whatever the message declared about itself.
      if (pcm.length > L.maxSeconds * PCM_BYTES_PER_SECOND) return { ok: false, reason: 'too_long', stage: 'too_long' };
      const samples = pcm.length - (pcm.length % 2);
      if (samples <= 0) throw stageError('no_audio');
      try { await files.writeFile(wavPath, Buffer.concat([wavHeader(samples), pcm.subarray(0, samples)]), { mode: 0o600, flag: 'wx' }); } catch { throw stageError('decode_failed'); }
      pcm = null;
      const threads = Math.max(1, Math.min(L.maxThreads, Number(parallelism()) || 1));
      ensure(found.engine, 'program');
      ensure(found.model, 'file');
      await run(found.engine, whisperArgs({ model: found.model, wav: wavPath, language: settings.language, threads, outBase }), { timeoutMs: L.runTimeoutMs, cwd: dir, timeoutStage: 'engine_timeout', failStage: 'engine_failed' });
      let raw;
      try { raw = await files.readFile(`${outBase}.txt`, 'utf8'); } catch { throw stageError('engine_failed'); }
      const text = cleanTranscript(raw, L.maxTranscriptChars);
      if (!text) throw stageError('no_text');
      return { ok: true, text, seconds: Math.round((samples / PCM_BYTES_PER_SECOND) * 10) / 10 };
    } finally {
      if (currentDir === dir) currentDir = null;
      if (dir) await files.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    }
  }

  /**
   * One voice note → { ok: true, text, seconds } | { ok: false, reason, stage }. Never rejects.
   * reason: 'too_long' (decoded audio over the limit), 'too_large', 'transcription_disabled' or
   * 'transcription_failed' (a program or file missing, a failed or timed-out run, no words).
   * Notes wait their turn: one transcription at a time.
   */
  function transcribe(audio) {
    waiting += 1;
    const job = async () => {
      try {
        const result = await transcribeNow(audio);
        if (!result.ok && result.stage !== 'disabled') say('warn', `a voice note was not transcribed: ${STAGE_TEXT[result.stage] || result.stage}`);
        return result;
      } catch (error) {
        const stage = typeof error?.stage === 'string' ? error.stage : 'engine_failed';
        say('warn', `a voice note was not transcribed: ${STAGE_TEXT[stage] || 'it failed'}`);
        return { ok: false, reason: 'transcription_failed', stage };
      } finally {
        waiting -= 1;
      }
    };
    const result = chain.then(job, job);
    chain = result.then(() => {}, () => {});
    return result;
  }

  /**
   * The host is going away: the program running now is killed, its scratch folder removed at once
   * (the process may exit before the note's own finally runs), and the notes waiting fail.
   */
  function stop() {
    stopped = true;
    const proc = child;
    child = null;
    if (proc) { try { proc.kill('SIGKILL'); } catch {} }
    const dir = currentDir;
    currentDir = null;
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }

  return {
    configure,
    status,
    available,
    transcribe,
    stop,
    get enabled() { return settings.enabled; },
    get pending() { return waiting; },
  };
}
