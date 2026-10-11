// ═══════════════════════════════════════════
// SynaBun — Assistant: test density
// ═══════════════════════════════════════════
//
// How much testing SynaBun asks of the workers the Assistant dispatches. The
// user picks a level next to the permission toggle in the Assistant's
// composer; it is stored per session like the route mode (the runtime's
// record.testDensity, null = the default) and read by the dispatcher when it
// composes a worker's prompt, so a stale brain prompt never changes what the
// worker gets. This module is the wording and the rules: the TESTING block of
// a worker brief, the line the brain's prompt carries, the "[SynaBun Tests]"
// line a change sends, and when a "Not tested" result is not a claim to check.
// Pure module: no I/O, no server imports.

export const TEST_DENSITIES = Object.freeze(['none', 'light', 'standard', 'thorough']);
export const DEFAULT_TEST_DENSITY = 'light';
export const TEST_DENSITY_LABELS = Object.freeze({ none: 'None', light: 'Light', standard: 'Standard', thorough: 'Thorough' });
export const TESTS_HEADER = '[SynaBun Tests]';

/** A known level, else `fallback` (the default level unless the caller wants to tell "not set" apart). */
export function normalizeTestDensity(value, fallback = DEFAULT_TEST_DENSITY) {
  const key = String(value ?? '').trim().toLowerCase();
  return TEST_DENSITIES.includes(key) ? key : fallback;
}

export function testDensityLabel(level) {
  return TEST_DENSITY_LABELS[normalizeTestDensity(level)];
}

// The classes whose work is code. A dispatch with no class is treated as one of them.
const TESTING_CLASSES = new Set(['code', 'complex', 'quick']);

/** Does a run of this class get the TESTING block? (review, research, browser, computer, automation, design and media runs do not.) */
export function testingApplies(taskClass) {
  const cls = String(taskClass ?? '').trim();
  return !cls || TESTING_CLASSES.has(cls);
}

const TESTING_RULES = Object.freeze({
  none: [
    'Do not write tests and do not run test suites.',
    'Only confirm the change loads: a syntax or type check of the files you touched, nothing more.',
    'No browser, visual or live checks.',
    'In ## Result say "Not tested" and list what a person should check.',
  ],
  light: [
    'Run only the existing test files that directly cover the code you changed: a few files, never the whole suite.',
    'Add a test only for a bug fix (one regression test) or for new logic that is easy to get wrong; at most one new test file.',
    'No browser, visual or live checks unless TASK names one.',
    'In ## Result list what you ran and what you did not verify.',
  ],
  standard: [
    'Add focused tests for the behavior you add or change.',
    'Run the test files for the area you touched, then that package\'s regular non-browser suite once at the end.',
    'Browser or visual checks only when the change is user-facing and TASK asks for one.',
    'In ## Result list what you ran and what you did not verify.',
  ],
  thorough: [
    'Cover the change with unit and integration tests, including edge cases and failure paths; add or update browser tests for user-facing changes.',
    'Run the whole suite and fix what you broke.',
    'Verify the result live where the environment allows.',
    'In ## Result list everything you ran and its outcome.',
  ],
});

/** What workers do at a level, in one sentence (the brain's lines and a follow-up turn's). */
const TESTING_SUMMARY = Object.freeze({
  none: 'workers write no tests and run no suites; they only check that the change loads and report "Not tested"',
  light: 'workers run only the test files that cover the change and add a test only for a bug fix or logic that is easy to get wrong',
  standard: 'workers add focused tests, run the test files of the area and then the package\'s regular non-browser suite once',
  thorough: 'workers cover the change with unit and integration tests, run the whole suite and verify live where they can',
});

export function testDensitySummary(level) {
  return TESTING_SUMMARY[normalizeTestDensity(level)];
}

/**
 * The TESTING block of a worker brief (assistant-task-prompt.js buildTaskPrompt): the one place
 * SynaBun tells a worker how much to test. '' for a class that gets none, and when no level is given.
 */
export function testingBlock(level, taskClass = null) {
  if (level === null || level === undefined || level === '' || !testingApplies(taskClass)) return '';
  const id = normalizeTestDensity(level);
  return [
    `TESTING (the user's Test density setting: ${TEST_DENSITY_LABELS[id]}). Binding: it overrides any heavier test or verification instruction in TASK or CONTEXT. Exception: when writing or running tests is itself what TASK asks you to deliver, do that work in full.`,
    ...TESTING_RULES[id].map((rule) => `- ${rule}`),
  ].join('\n');
}

/** A follow-up turn of a run whose level changed since its brief: the new rules, in place of the brief's. */
export function testingFollowUpLine(level) {
  const id = normalizeTestDensity(level);
  return `TESTING changed (the user's Test density setting is now ${TEST_DENSITY_LABELS[id]}; this replaces the TESTING block of your brief): ${TESTING_RULES[id].join(' ')}`;
}

/** At these levels the brain reports what was not tested instead of verifying it. */
export function reportsUntested(level) {
  const id = normalizeTestDensity(level);
  return id === 'none' || id === 'light';
}

/**
 * The entry of the brain's system prompt (assistant-persona.js, Rails).
 * `where`: how the prompt names the control (a chat channel has no composer).
 */
export function testDensityPersonaLine(level, { where = 'next to the permission toggle' } = {}) {
  const id = normalizeTestDensity(level);
  return `- Test density: ${TEST_DENSITY_LABELS[id]} (the user's setting, ${where}): ${TESTING_SUMMARY[id]}. SynaBun adds the matching binding TESTING rules to every code / complex / quick worker brief. `
    + 'Do not write test or verification requirements into a task beyond what the user asked for in this request, and do not dispatch a run whose only purpose is to test another run at None or Light unless the user asks. '
    + 'Follow the same level in your own direct edits. At None or Light, report what was not tested instead of verifying it yourself. '
    + `A change of level arrives as a "${TESTS_HEADER}" line.`;
}

/** The line a running brain gets when the level changes (like the router's "[SynaBun Router]" line). */
export function testDensityStamp(level) {
  const id = normalizeTestDensity(level);
  return `${TESTS_HEADER} Test density: ${TEST_DENSITY_LABELS[id]} - ${TESTING_SUMMARY[id]}. Do not write heavier test or verification requirements into a task, and follow the same level in your own edits.`;
}

// "Not tested", "untested", "no tests were run", "did not run tests".
const NOT_TESTED_RE = /\b(?:not|un)[\s-]?tested\b|\bno tests? (?:were |was )?(?:run|ran|written|added)\b|\b(?:did not|didn't|have not|haven't) (?:run|write) (?:any |the )?tests?\b/i;
// A report that tests ran green: "tests pass", "the suite is green", "12 tests passed", "all specs passing".
const TESTS_PASSED_RE = /\b(?:tests?|suites?|specs?)\b[^.\n]{0,40}\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?)\b|\b\d+\s+pass(?:ed|ing)?\b/i;

/**
 * Is the worker-claim question left out for this turn? Only at None, for a run that got the
 * TESTING block: the worker was told not to test and to say "Not tested", so a "done" with no test
 * output is the report that was asked for, not a claim to check. Still judged, at every level: a
 * message that says tests passed, and a turn in which a command or a tool failed.
 * `text`: the worker's final message; `evidence`: assistant-evidence.js evidenceSnapshot.
 */
export function claimCheckWaived({ level, taskClass = null, text = '', evidence = null } = {}) {
  if (level === null || level === undefined || level === '') return false;
  if (normalizeTestDensity(level) !== 'none' || !testingApplies(taskClass)) return false;
  const message = String(text || '');
  if (!NOT_TESTED_RE.test(message) || TESTS_PASSED_RE.test(message)) return false;
  const commands = Array.isArray(evidence?.commands) ? evidence.commands : [];
  const results = Array.isArray(evidence?.results) ? evidence.results : [];
  if (commands.some((c) => c?.exit === 'error') || results.some((r) => r?.is_error === true)) return false;
  return true;
}
