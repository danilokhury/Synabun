// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: the completion list
// ═══════════════════════════════════════════
//
// What the list under the caret offers (CodeMirror's autocompletion): the
// completions of the document's language, and the words of the document. Three
// rules are kept here, on top of what CodeMirror does:
//
//   - the list never offers the word that already stands before the caret: an
//     option that would only write that word again is left out, and the list
//     closes when nothing else is left to offer;
//   - no name is listed twice: what the language offers (a variable) is not
//     repeated as a word of the document, nor by a second source of the language;
//   - while AI autocomplete is expected to suggest for the document, its words
//     do not open the list by themselves (`wordsYield`). Asked for (Ctrl-Space),
//     they are listed; what the language offers opens the list as always.
//
// An option that carries more than its label (a snippet, an `apply` of its own)
// is not "the same word": the two `for` loops of JavaScript stay next to the
// keyword, also when `for` is typed in full.
//
// CodeMirror asks a source once and reuses its answer while the word grows, so
// each answer is given an `update` of its own here: it is filtered again on
// every key. Takes the vendored bundle as an argument: no imports. The helpers
// at the top need no page: `node --test` loads them as they are.

/** How many completion sources a language (and the languages nested in it) is given room for at one position. */
export const LANGUAGE_SOURCES = 8;

/** An option that would only write its own label: there is nothing else to tell it from another of that label. */
export function isPlainOption(option) {
  return !!option && typeof option.label === 'string' && (option.apply == null || option.apply === option.label);
}

/**
 * The options of one source as the list shows them.
 * @param {object[]} options a source's own (CodeMirror completions: `{ label, apply?, type?, detail? }`)
 * @param {{ typed?: string, taken?: Set<string> | null }} [o] `typed`: the word before the caret, as far as this
 *   source would replace it; `taken`: the labels another source already offers as plain options
 * @returns {object[]} in the same order, without the plain option that is the typed word, without a plain option
 *   whose label is taken, and with one plain option for a label at most
 */
export function offeredOptions(options, { typed = '', taken = null } = {}) {
  const seen = new Set();
  const out = [];
  for (const option of Array.isArray(options) ? options : []) {
    if (!option || typeof option.label !== 'string') continue;
    if (isPlainOption(option)) {
      if (option.label === typed || taken?.has(option.label) || seen.has(option.label)) continue;
      seen.add(option.label);
    }
    out.push(option);
  }
  return out;
}

/** The labels of a result's plain options, added to `into`. */
export function plainLabels(result, into = new Set()) {
  for (const option of result?.options || []) if (isPlainOption(option)) into.add(option.label);
  return into;
}

/**
 * Whether a source's result still applies to the text between `from` and `to`, by the rule the result came with
 * (CodeMirror's `validFor`: a function, or an expression the whole text must match). Without a rule it does not.
 */
export function stillValid(validFor, state, from, to) {
  if (!validFor) return false;
  const text = state.sliceDoc(from, to);
  if (typeof validFor === 'function') return !!validFor(text, from, to, state);
  const { source } = validFor;
  const start = source[0] !== '^';
  const end = source[source.length - 1] !== '$';
  const whole = start || end ? new RegExp(`${start ? '^' : ''}(?:${source})${end ? '$' : ''}`, validFor.flags ?? '') : validFor;
  return whole.test(text);
}

/**
 * @param {object} cm the vendored CodeMirror bundle (editor-loader.js)
 * @param {{ wordsYield?: (context: object) => boolean }} [o] `wordsYield`: suggestions are expected at this caret,
 *   so the document's words stay out of a list nobody asked for
 */
export function editorCompletionList(cm, { wordsYield = () => false } = {}) {
  // A language may hand over a list of completions in place of a source: one source per list, as CodeMirror keeps them.
  const fromLists = new WeakMap();
  const asSource = (source) => {
    if (typeof source === 'function') return source;
    if (!Array.isArray(source)) return () => null;
    if (!fromLists.has(source)) fromLists.set(source, cm.completeFromList(source));
    return fromLists.get(source);
  };
  /** What the language at a position completes with: its own sources, in the order it names them. */
  const languageSources = (state, pos) => state.languageDataAt('autocomplete', pos).map(asSource);

  const isPromise = (value) => !!value && typeof value.then === 'function';

  /**
   * A source's result as the list uses it: its options filtered for the word before the caret, and filtered again
   * each time that word changes.
   * @param {object} original what the source answered
   * @param {string} typed the text the result would replace
   * @param {Set<string>} taken plain labels the sources in front of this one offer
   */
  function shape(original, typed, taken) {
    const shaped = {
      ...original,
      options: offeredOptions(original.options, { typed, taken }),
      // CodeMirror reuses a result while `validFor` holds, without asking anybody: here it asks `update` instead.
      validFor: undefined,
      update(current, from, to, context) {
        const text = context.state.sliceDoc(from, to);
        if (stillValid(original.validFor, context.state, from, to)) return shape({ ...original, from, to }, text, taken);
        const renewed = typeof original.update === 'function' ? original.update(original, from, to, context) : null;
        return renewed ? shape(renewed, context.state.sliceDoc(renewed.from, renewed.to ?? context.pos), taken) : null;
      },
    };
    if (typeof original.map === 'function') {
      shaped.map = (current, changes) => {
        const mapped = original.map(original, changes);
        return mapped ? shape(mapped, typed, taken) : null;
      };
    }
    return shaped;
  }

  /**
   * The result of the last of `sources`, shaped: without what the sources before it already offer.
   * A source before it that fails or answers late is no reason to hold this one back: it offers nothing here.
   */
  function resultOf(sources, context) {
    const last = sources.length - 1;
    const before = sources.slice(0, last).map((source) => {
      try {
        const value = source(context);
        return isPromise(value) ? value.catch(() => null) : value;
      } catch { return null; }
    });
    let own;
    try { own = sources[last](context); } catch (error) { return Promise.reject(error); }   // CodeMirror logs it and closes the list
    const finish = (result, earlier) => {
      if (!result || !Array.isArray(result.options)) return null;
      const taken = new Set();
      for (const other of earlier) plainLabels(other, taken);
      return shape(result, context.state.sliceDoc(result.from, result.to ?? context.pos), taken);
    };
    if (isPromise(own) || before.some(isPromise)) return Promise.all([own, ...before]).then(([result, ...earlier]) => finish(result, earlier));
    return finish(own, before);
  }

  // One place for each source the language may have at the caret. CodeMirror keeps a source's answer by the
  // source's identity: a place is always the same function, whichever source it stands for at a position.
  const languagePlace = (index) => (context) => {
    const sources = languageSources(context.state, context.pos);
    return index < sources.length ? resultOf(sources.slice(0, index + 1), context) : null;
  };

  /** The words of the document, after everything the language offers. */
  const words = (context) => {
    if (!context.explicit && wordsYield(context)) return null;
    const sources = languageSources(context.state, context.pos).slice(0, LANGUAGE_SOURCES);
    return resultOf([...sources, cm.completeAnyWord], context);
  };

  const sources = [...Array.from({ length: LANGUAGE_SOURCES }, (_, index) => languagePlace(index)), words];

  return {
    /** The list, for the view: CodeMirror's autocompletion over the sources above. */
    extension: cm.autocompletion({ override: sources }),
    /** The sources themselves, in the order the list asks them (tests). */
    sources,
  };
}
