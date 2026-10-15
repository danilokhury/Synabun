// ═══════════════════════════════════════════
// SynaBun — Assistant user context: the learning loop
// ═══════════════════════════════════════════
//
// What a human turn teaches about the user, off the reply path and at zero
// brain tokens:
//
//   1. prefilter (free): origin, the typed words only, not trivial, a cue
//      lexicon in English and Portuguese, the session's caps, a content hash;
//   2. one Jev request (surface `user-learning`, origin `assistant`) over the
//      message, its sentences, the previous reply (context only) and up to six
//      known statements: durable signal, facet, scope, the evidence sentence,
//      the known statement it matches, and whether it contradicts each;
//   3. the writer (assistant-user-writer.js), only when step 2 passed, checked
//      by a second Jev question; a statement that adds anything is dropped for
//      the user's own sentence;
//   4. exactly one write: create, update or supersede.
//
// Jev and the writer are injected and may be missing: without Jev nothing is
// learned (there is no heuristic that should write to the owner's memory),
// without the writer the statement is the user's sentence. Nothing here throws.

import { createHash } from 'node:crypto';
import { isTrivialPrompt } from '../../hooks/claude-code/prompt-origin.mjs';
import { FACETS, FACET_KIND, LEARN } from './assistant-user-context-budgets.js';
import { addEvidence, cleanQuote, cleanStatement, formatKnowledge, guessFacet, raiseConfidence } from './assistant-user-knowledge.js';

// ── typed words ─────────────────────────────────────────────────────────────

const FENCE_RE = /```[\s\S]*?(?:```|$)/g;
const FILE_RE = /<file path="[^"]*">[\s\S]*?<\/file>/g;
const MEMORY_RE = /<memory id="[^"]*"[^>]*>[\s\S]*?<\/memory>/g;
// asst-composer.js attachmentPromptLine.
const UPLOAD_RE = /^The user attached a file: .*$/gm;

/**
 * The words the user typed: the composer's own report (`typed`: the text without its long pastes)
 * when every line of it is in the prompt, else the prompt. Attachments (inline files, attached
 * memories, upload lines) and fenced blocks are removed either way.
 */
export function typedEvidence({ prompt = '', typed = null } = {}) {
  const full = String(prompt ?? '');
  let source = full;
  if (typeof typed === 'string') {
    const lines = typed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.every((line) => full.includes(line))) source = typed;
  }
  return source.replace(FENCE_RE, ' ').replace(FILE_RE, ' ').replace(MEMORY_RE, ' ').replace(UPLOAD_RE, ' ')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── cue lexicon ─────────────────────────────────────────────────────────────
// Words that mark a standing instruction, a habit, a repeated request or a
// correction. A prompt without one costs nothing; with one, Jev decides.

const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const cue = (name, source) => [name, new RegExp(`${B}(?:${source})${E}`, 'iu')];

export const CUE_LEXICON = Object.freeze([
  cue('always', 'always|every ?time|each time|whenever|sempre|toda vez|todas as vezes|cada vez'),
  cue('never', "never|not ever|don'?t ever|nunca|jamais"),
  cue('from now on', 'from now on|going forward|from here on|in (?:the )?future|next time|de agora em diante|daqui (?:pra|para) frente|a partir de agora|da pr[óo]xima vez|no futuro'),
  cue('I told you', "i (?:already )?told you|i(?:'ve| have) (?:already )?(?:told|said|asked)|as i said|like i said|i said|how many times|again and again|j[áa] (?:te )?(?:falei|disse|pedi)|(?:eu )?te (?:falei|disse|pedi)|como eu (?:disse|falei)|quantas vezes"),
  cue('stop', "stop (?:\\p{L}+ing|that|it)|quit (?:\\p{L}+ing|that|it)|no more|pare de|para de|chega de|n[ãa]o (?:fa[çc]a|use|coloque|adicione|mexa) mais"),
  cue('by default', 'by default|as a rule|in general|as usual|por padr[ãa]o|como regra|em geral|como de costume'),
  cue('prefer', "i(?:'d| would)? (?:much )?(?:prefer|rather)|my preference|i (?:really )?(?:hate|dislike|like|love) (?:it )?when|(?:eu )?prefiro|minha prefer[êe]ncia|(?:eu )?(?:odeio|detesto|gosto|adoro) quando"),
  cue('remember', "remember (?:that|to)|keep in mind|don'?t forget|make sure (?:to|you) always|lembre(?:-se)?(?: de)? que|n[ãa]o (?:se )?esque[çc]a|tenha em mente"),
  cue('must', "(?:you )?must (?:always|never|not)|should (?:always|never)|(?:you )?(?:deve|devem|precisa) (?:sempre|nunca)|tem que sempre"),
]);

/** The cue names a text hits, in lexicon order. */
export function matchCues(text) {
  const value = String(text ?? '');
  return CUE_LEXICON.filter(([, re]) => re.test(value)).map(([name]) => name);
}

/** The sentences of a typed text: those with a cue first when there are too many, in their original order. */
export function splitSentences(text, { max = LEARN.maxSentences, clip = LEARN.sentenceClip } = {}) {
  const parts = String(text ?? '').split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}"'(\[¿¡])|\n+/u).map((part) => part.trim()).filter((part) => part.length >= 3);
  let kept = parts.map((part, index) => ({ part, index }));
  if (kept.length > max) {
    const withCue = kept.filter(({ part }) => matchCues(part).length);
    const rest = kept.filter(({ part }) => !matchCues(part).length);
    kept = [...withCue, ...rest].slice(0, max).sort((a, b) => a.index - b.index);
  }
  return kept.map(({ part }) => (part.length > clip ? `${part.slice(0, clip - 1)}…` : part));
}

export function contentHash(text) {
  return createHash('sha256').update(String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * The free filter. `turn`: { origin, untrusted, system, prompt, typed }; `session`:
 * { counts:{ gate, writer, writes }, hashes:[…] } (read only).
 * → { pass, reason, text, sentences, cues, hash, chars }
 *   reason: system | origin | untrusted | no-typed-text | trivial | short | no-cue | seen | gate-cap | write-cap | null
 */
export function prefilter(turn = {}, session = {}, limits = LEARN) {
  const fail = (reason, extra = {}) => ({ pass: false, reason, text: '', sentences: [], cues: [], hash: null, chars: 0, ...extra });
  if (turn.system) return fail('system');
  if (turn.origin !== 'ui' && turn.origin !== 'whatsapp') return fail('origin');
  if (turn.origin === 'whatsapp' && turn.untrusted === true) return fail('untrusted');
  const text = typedEvidence(turn);
  if (!text) return fail('no-typed-text');
  if (isTrivialPrompt(text)) return fail('trivial', { chars: text.length });
  if (text.length < limits.minChars) return fail('short', { chars: text.length });
  const cues = matchCues(text);
  if (!cues.length) return fail('no-cue', { chars: text.length });
  const hash = contentHash(text);
  if (Array.isArray(session.hashes) && session.hashes.includes(hash)) return fail('seen', { chars: text.length, cues, hash });
  const counts = session.counts || {};
  if ((Number(counts.gate) || 0) >= limits.gateCap) return fail('gate-cap', { chars: text.length, cues, hash });
  if ((Number(counts.writes) || 0) >= limits.writeCap) return fail('write-cap', { chars: text.length, cues, hash });
  const clipped = text.length > limits.messageClip ? `${text.slice(0, limits.messageClip - 1)}…` : text;
  return { pass: true, reason: null, text: clipped, sentences: splitSentences(text, { max: limits.maxSentences, clip: limits.sentenceClip }), cues, hash, chars: text.length };
}

// ── Jev questions ───────────────────────────────────────────────────────────

const noul = (instructions, criteria) => ({ type: 'noul', instructions, criteria });
const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
export const readNoul = (answer) => (answer?.type === 'noul' && Number.isFinite(answer.noul) ? answer.noul : null);
export const readChoice = (answer) => (answer?.type === 'choice' && typeof answer.choice === 'string'
  ? { choice: answer.choice, confidence: Number.isFinite(answer.confidence) ? answer.confidence : 0 } : null);

const FACET_CRITERIA = Object.freeze({
  instructions: 'How to answer or act: language, format, length, steps, what to include or leave out.',
  expectations: 'What the user expects of the work or the assistant: quality, thoroughness, initiative, how results are reported.',
  decisions: 'A choice the user made that should stick: a tool, a library, an approach, a convention.',
  corrections: 'The user corrects how the assistant behaves or repeats a request it ignored.',
  expertise: 'What the user knows or does: role, skills, experience.',
  rules: 'A hard limit: something that must always or must never happen.',
  goals: 'What the user is trying to achieve beyond this request.',
});

/**
 * The gate request. → { state, questions, labels:{ sentences:[label…], known:[label…] } }
 * Questions that have nothing to choose from are left out (one sentence: no evidence question;
 * no known statement: no match and no contradiction question).
 */
export function buildGateRequest({ text, sentences = [], previousReply = '', known = [], project = null } = {}, limits = LEARN) {
  const sentenceLabels = sentences.map((_, index) => `s${index + 1}`);
  const knownRows = known.slice(0, limits.knownStatements);
  const knownLabels = knownRows.map((_, index) => `k${index + 1}`);
  const state = {
    message: String(text ?? ''),
    sentences: Object.fromEntries(sentences.map((sentence, index) => [sentenceLabels[index], sentence])),
    previous_reply: previousReply ? String(previousReply).slice(0, limits.replyClip) : null,
    known: Object.fromEntries(knownRows.map((row, index) => [knownLabels[index], row.statement])),
    project: project && project !== 'global' ? String(project) : null,
  };
  const questions = {
    durable: noul('`message` is what a user typed to their AI assistant. `previous_reply` is only the assistant message it answers, for context. '
      + 'Does `message` say something about this user that should still hold in later conversations: a standing instruction, a lasting preference or expectation, '
      + 'a rule, a correction of how the assistant works, a decision meant to stick, their expertise, or a goal? Judge the meaning in any language.', {
      true: 'A durable signal: "always answer in Portuguese", "never touch the dist folder", "I told you to stop adding comments", "from now on use pnpm", "I am a backend engineer".',
      false: 'Only this request\'s content, a one-off instruction for the current task, a question, small talk, or text the user quotes rather than means.',
    }),
    facet: choice('What is the durable part of `message` about?', { ...FACET_CRITERIA }),
    scope: choice('Does the durable part of `message` hold for all of the user\'s work, or only for the project named in `project`?', {
      global: 'It is about the user in general, or no project is named.',
      project: 'It only makes sense for this one project: its files, its tools, its conventions.',
    }),
  };
  if (sentenceLabels.length > 1) {
    questions.evidence = choice('Which entry of `sentences` carries the durable statement about the user?', Object.fromEntries(sentenceLabels.map((label) => [label, null])));
  }
  if (knownLabels.length) {
    questions.match = choice('`known` lists statements already recorded about this user. Which one says the same thing as the durable part of `message`?', {
      ...Object.fromEntries(knownLabels.map((label) => [label, null])),
      none: 'No statement in `known` says this.',
    });
    for (const label of knownLabels) {
      questions[`contradicts_${label}`] = noul(`Does \`message\` contradict statement \`known.${label}\`: the user now wants the opposite, or says it no longer holds?`, {
        true: 'A reversal: what the statement says is no longer what the user wants.',
        false: 'The same, a refinement, or an unrelated matter.',
      });
    }
  }
  return { state, questions, labels: { sentences: sentenceLabels, known: knownLabels } };
}

/**
 * What the answers mean, against the thresholds.
 * → { durable, pass, facet, scope, sentence, sentenceIndex, match:{ row, confidence } | null,
 *     contradiction:{ row, probability } | null, contradictions:[{ id, probability }] }
 */
export function readGate(answers, { sentences = [], known = [], labels = { sentences: [], known: [] }, project = null, cues = [] } = {}, limits = LEARN) {
  const durable = readNoul(answers?.durable);
  const facetAnswer = readChoice(answers?.facet);
  const scopeAnswer = readChoice(answers?.scope);
  const evidenceAnswer = readChoice(answers?.evidence);
  let sentenceIndex = evidenceAnswer ? labels.sentences.indexOf(evidenceAnswer.choice) : -1;
  if (sentenceIndex < 0) sentenceIndex = sentences.findIndex((sentence) => matchCues(sentence).length);
  if (sentenceIndex < 0) sentenceIndex = 0;
  const sentence = sentences[sentenceIndex] || '';
  const projectScoped = scopeAnswer?.choice === 'project' && scopeAnswer.confidence >= 0.6 && project && project !== 'global';
  const contradictions = [];
  labels.known.forEach((label, index) => {
    const p = readNoul(answers?.[`contradicts_${label}`]);
    if (p !== null && known[index]) contradictions.push({ row: known[index], probability: p });
  });
  const strongest = contradictions.filter((item) => item.probability >= limits.contradictMin).sort((a, b) => b.probability - a.probability)[0] || null;
  const matchAnswer = readChoice(answers?.match);
  const matchIndex = matchAnswer && matchAnswer.choice !== 'none' ? labels.known.indexOf(matchAnswer.choice) : -1;
  const match = matchIndex >= 0 && matchAnswer.confidence >= limits.matchMin && known[matchIndex] ? { row: known[matchIndex], confidence: matchAnswer.confidence } : null;
  return {
    durable,
    pass: durable !== null && durable >= limits.durableMin,
    facet: facetAnswer && FACETS.includes(facetAnswer.choice) ? facetAnswer.choice : guessFacet(sentence),
    scope: projectScoped ? String(project) : 'global',
    sentence, sentenceIndex, cues,
    match,
    contradiction: strongest,
    contradictions: contradictions.map((item) => ({ id: item.row.id, probability: item.probability })),
  };
}

const FAITHFUL_QUESTION = noul('`statement` was written from `sentence`, which a user typed (and, when given, from `previous_statement`, already recorded about them). '
  + 'Does `statement` say only what they say about the user, adding no fact, reason, preference, scope or detail of its own and dropping no condition?', {
  true: 'A faithful restatement in the third person.',
  false: 'It adds, generalises, weakens or changes something.',
});

const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0);

/**
 * @param {object} deps
 * @param {{ ask: Function, available?: Function } | null} deps.judge
 *        ask(state, questions, { sessionId, project, timeoutMs, onUsage, onLogged }) → answers | null
 * @param {{ write: Function, available?: Function } | null} deps.writer
 * @param {object} deps.store   { known(text, { project, limit }), create(args), update(id, args), supersede(newId, oldId, { sessionId }) }
 * @param {() => ({ input?: number, output?: number } | null)} [deps.rates]  Jev's $ per million tokens
 */
export function createUserLearner({ judge = null, writer = null, store = null, rates = () => null, limits = LEARN, now = Date.now, log = () => {} } = {}) {
  const today = () => new Date(now()).toISOString().slice(0, 10);

  function judgeAvailable() {
    if (!judge || typeof judge.ask !== 'function') return false;
    try { return typeof judge.available === 'function' ? !!judge.available() : true; } catch { return false; }
  }

  /**
   * One captured turn → what was learned (always an object, for the trace).
   * `capture`: { sessionId, project, text, sentences, cues, hash, previousReply };
   * `session`: { counts:{ gate, writer, writes }, hashes:[…] } (updated in place).
   */
  async function learn(capture = {}, session = { counts: {}, hashes: [] }) {
    const counts = (session.counts ||= {});
    const result = {
      gate: null, writer: null, action: { type: 'none', reason: null },
      cost: { jevRequests: 0, jevInputTokens: 0, jevOutputTokens: 0, jevUsd: 0, writerTokens: null, writerUsd: 0, totalUsd: 0 },
    };
    const finish = () => {
      let rate = null;
      try { rate = rates() || null; } catch { rate = null; }
      const perMillion = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);
      result.cost.jevUsd = Number(((result.cost.jevInputTokens * perMillion(rate?.input, 0.042) + result.cost.jevOutputTokens * perMillion(rate?.output, 0)) / 1e6).toFixed(8));
      result.cost.totalUsd = Number((result.cost.jevUsd + (Number(result.cost.writerUsd) || 0)).toFixed(8));
      return result;
    };
    const ask = async (state, questions) => {
      const usage = { inputTokens: 0, outputTokens: 0, cached: false, ms: 0 };
      let logId = null;
      let answers = null;
      try {
        answers = await judge.ask(state, questions, {
          sessionId: capture.sessionId || null, project: capture.project && capture.project !== 'global' ? capture.project : null, timeoutMs: limits.timeoutMs,
          onUsage: (u) => { usage.inputTokens = count(u?.inputTokens); usage.outputTokens = count(u?.outputTokens); usage.cached = u?.cached === true; usage.ms = count(u?.latencyMs); },
          onLogged: (id) => { logId = id ?? null; },
        });
      } catch { answers = null; }
      if (!usage.cached) result.cost.jevRequests += 1;
      result.cost.jevInputTokens += usage.inputTokens;
      result.cost.jevOutputTokens += usage.outputTokens;
      return { answers: answers && typeof answers === 'object' ? answers : null, usage, logId };
    };

    if (!store) { result.action.reason = 'no-store'; return finish(); }
    if (!judgeAvailable()) { result.action.reason = 'jev-unavailable'; return finish(); }
    if (!capture.text || !Array.isArray(capture.sentences) || !capture.sentences.length) { result.action.reason = 'no-typed-text'; return finish(); }

    // The content hash is spent whether or not anything is learned: the same words are never judged twice.
    if (capture.hash) session.hashes = [...(Array.isArray(session.hashes) ? session.hashes : []).filter((hash) => hash !== capture.hash), capture.hash].slice(-limits.hashesKept);
    counts.gate = (Number(counts.gate) || 0) + 1;

    let known = [];
    try { known = (await store.known(capture.text, { project: capture.project || 'global', limit: limits.knownStatements })) || []; }
    catch (error) { log('user-context:known-error', error?.message || String(error)); known = []; }
    known = known.filter((row) => row?.id && row.statement).slice(0, limits.knownStatements);

    const request = buildGateRequest({ text: capture.text, sentences: capture.sentences, previousReply: capture.previousReply, known, project: capture.project }, limits);
    const asked = await ask(request.state, request.questions);
    if (!asked.answers) {
      result.gate = { asked: true, answered: false, logId: asked.logId, tokens: { input: asked.usage.inputTokens, output: asked.usage.outputTokens }, known: known.length };
      result.action.reason = 'no-answer';
      return finish();
    }
    const gate = readGate(asked.answers, { sentences: capture.sentences, known, labels: request.labels, project: capture.project, cues: capture.cues || [] }, limits);
    result.gate = {
      asked: true, answered: true, logId: asked.logId, ms: asked.usage.ms, cached: asked.usage.cached,
      tokens: { input: asked.usage.inputTokens, output: asked.usage.outputTokens },
      durable: gate.durable, pass: gate.pass, facet: gate.facet, scope: gate.scope, sentence: gate.sentence,
      known: known.length,
      match: gate.match ? { id: gate.match.row.id, statement: gate.match.row.statement, confidence: gate.match.confidence, seed: !gate.match.row.structured } : null,
      contradicts: gate.contradiction ? { id: gate.contradiction.row.id, statement: gate.contradiction.row.statement, probability: gate.contradiction.probability } : null,
    };
    if (!gate.pass) { result.action.reason = gate.durable === null ? 'no-answer' : 'not-durable'; return finish(); }
    if (!gate.sentence) { result.action.reason = 'no-evidence'; return finish(); }
    if ((Number(counts.writes) || 0) >= limits.writeCap) { result.action.reason = 'write-cap'; return finish(); }

    const target = gate.contradiction?.row || gate.match?.row || null;
    const kind = gate.contradiction ? 'supersede' : (gate.match ? (target.structured ? 'update' : 'create') : 'create');
    // An update refines the statement it matched; everything else starts from the user's sentence.
    const refining = kind === 'update' ? target : null;
    const own = cleanStatement(gate.sentence);

    // ── the writer, checked ──
    let statement = refining ? refining.statement : own;
    let engine = refining ? 'kept' : 'user-sentence';
    const writerInfo = { used: false, model: null, verified: null, reason: null, tokens: null, costUsd: 0, ms: 0 };
    const writerOn = writer && typeof writer.write === 'function' && (typeof writer.available !== 'function' || writer.available());
    if (!writerOn) writerInfo.reason = 'no-writer';
    else if ((Number(counts.writer) || 0) >= limits.writerCap) writerInfo.reason = 'writer-cap';
    else {
      counts.writer = (Number(counts.writer) || 0) + 1;
      writerInfo.used = true;
      let drafted = null;
      try { drafted = await writer.write({ sentence: gate.sentence, existing: refining ? refining.statement : null, sessionId: capture.sessionId || null, taskId: capture.taskId || null }); }
      catch (error) { drafted = { statement: '', error: error?.message || String(error) }; }
      writerInfo.model = drafted?.model || null;
      writerInfo.tokens = drafted?.tokens || null;
      writerInfo.costUsd = Number(drafted?.costUsd) || 0;
      writerInfo.ms = count(drafted?.ms);
      result.cost.writerTokens = writerInfo.tokens;
      result.cost.writerUsd = writerInfo.costUsd;
      if (!drafted?.statement) writerInfo.reason = drafted?.error || 'writer-failed';
      else {
        const checked = await ask({ sentence: gate.sentence, previous_statement: refining ? refining.statement : null, statement: drafted.statement }, { faithful: FAITHFUL_QUESTION });
        const p = readNoul(checked.answers?.faithful);
        writerInfo.verified = p;
        writerInfo.draft = drafted.statement;
        if (p !== null && p >= limits.faithfulMin) { statement = drafted.statement; engine = `claude-code/${drafted.model || 'claude'}`; }
        else writerInfo.reason = p === null ? 'unverified' : 'not-faithful';
      }
    }
    result.writer = writerInfo;
    if (!statement || statement.length < 8) { result.action.reason = 'no-statement'; return finish(); }

    // ── exactly one write ──
    const evidence = { quote: cleanQuote(gate.sentence, limits.quoteMax), date: today() };
    const action = { type: kind, reason: null, statement, evidence: evidence.quote, facet: gate.facet, scope: gate.scope, engine, memoryId: null };
    try {
      if (kind === 'update') {
        const content = formatKnowledge({
          statement, facet: target.facet,
          evidence: addEvidence(target.evidence, evidence, limits.evidenceMax),
          seen: (Number(target.seen) || 1) + 1,
          confidence: raiseConfidence(target.confidence, gate.durable),
        });
        const updated = await store.update(target.id, { content, expectedRevision: target.revision || null, sessionId: capture.sessionId || null, project: target.project });
        if (!updated?.ok) { action.type = 'none'; action.reason = updated?.error || 'update-failed'; }
        else { action.memoryId = target.id; action.facet = target.facet; action.scope = target.project; action.seen = (Number(target.seen) || 1) + 1; }
      } else {
        // A matched seed counts as one earlier sighting; the new memory links to it and the seed leaves the digest.
        const seed = kind === 'create' && gate.match && !target.structured ? target : null;
        const content = formatKnowledge({
          statement, facet: gate.facet, evidence: [evidence],
          seen: seed ? 2 : 1,
          confidence: seed ? raiseConfidence(Math.max(seed.confidence, 0.6), gate.durable) : Math.min(0.99, gate.durable),
        });
        const created = await store.create({
          content, project: gate.scope, facet: gate.facet, kind: FACET_KIND[gate.facet] || 'preference',
          sessionId: capture.sessionId || null, links: seed ? [seed.id] : [], hash: capture.hash || contentHash(capture.text),
        });
        if (!created?.id || created.duplicateOf) {
          action.type = 'none';
          action.reason = created?.duplicateOf ? 'duplicate' : (created?.error || 'create-failed');
          if (created?.duplicateOf) action.duplicateOf = created.duplicateOf;
        } else {
          action.memoryId = created.id;
          if (seed) action.seedId = seed.id;
          if (kind === 'supersede') {
            action.supersedes = target.id;
            action.replaced = target.statement;
            const linked = await store.supersede(created.id, target.id, { sessionId: capture.sessionId || null });
            if (!linked?.ok) action.supersedeError = linked?.error || 'supersede-failed';
          }
        }
      }
    } catch (error) {
      log('user-context:write-error', error?.message || String(error));
      action.type = 'none';
      action.reason = 'write-error';
    }
    if (action.type !== 'none') counts.writes = (Number(counts.writes) || 0) + 1;
    result.action = action;
    return finish();
  }

  return { learn, available: judgeAvailable };
}
