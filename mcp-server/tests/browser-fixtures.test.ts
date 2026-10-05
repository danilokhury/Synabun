import { describe, expect, it } from 'vitest';
import { loadBrowserCorpus, candidatesOfFixture, type TargetCase } from '../src/services/browser-bench.js';
import { autoHealEligibility, buildTargetState, buildSocialState, offerSocialControls, type TargetVerdict } from '../src/services/browser-judgments.js';
import { findCredentialSpans } from '../src/services/typesafe-config.js';
import { FORBIDDEN_CATEGORIES, BROWSER_DEFINITIONS, PAGE_STATES } from '../src/services/browser-assist-gate.js';
import { intentVeto, addressesAgent, LEXICON_LANGS, type TargetPhrase } from '../src/services/browser-risk.js';

/**
 * The benchmark corpus, checked without the API.
 *
 * Two jobs. It lints the fixtures, so a labelling slip cannot pass as a model
 * result. And it proves, deterministically, the part of the auto-heal gate
 * that must not depend on a model at all: whatever Jev answers, with whatever
 * confidence, no forbidden case and no consequential candidate in this corpus
 * can come out eligible for a click.
 */

const corpus = loadBrowserCorpus();
const THRESHOLDS = { minConfidence: 0.85, minProbability: 0.9 };
const certain = (candidateId: string): TargetVerdict => ({ candidateId, confidence: 1, exists: 1, probabilities: { [candidateId]: 1 }, alternatives: [] });
const phraseOf = (c: TargetCase): TargetPhrase => ({ phrase: c.input.intent, source: c.input.phraseSource });
const eligibleIf = (c: TargetCase, pick: string) => autoHealEligibility({ action: c.input.action, candidates: candidatesOfFixture(c), phrase: phraseOf(c), selector: c.input.failedSelector }, certain(pick), THRESHOLDS);
const PLATFORM_HOSTS = new Set(['www.facebook.com', 'x.com', 'www.linkedin.com', 'www.instagram.com', 'www.tiktok.com', 'web.whatsapp.com']);

describe('corpus lint', () => {
  it('loads, with unique ids and every expected id present', () => {
    expect(corpus.target.length).toBeGreaterThan(0);
    expect(corpus.pageState.length).toBeGreaterThan(0);
    expect(corpus.social.length).toBeGreaterThan(0);
    expect(corpus.hash).toMatch(/^[0-9a-f]{12}$/);
    for (const c of corpus.target) {
      const ids = c.input.candidates.map(x => x.id);
      expect(new Set(ids).size, c.id).toBe(ids.length);
      if (c.expected !== 'none') expect(ids, `${c.id} expected`).toContain(c.expected);
      for (const a of c.acceptable) expect(ids, `${c.id} acceptable`).toContain(a);
    }
    for (const c of corpus.social) {
      const ids = c.input.controls.map(x => x.id);
      if (c.expectedCandidate && c.expectedCandidate !== 'none') expect(ids, c.id).toContain(c.expectedCandidate);
    }
  });

  it('labels are consistent: forbidden categories are never safe recoveries, and blockers are flagged as such', () => {
    for (const c of corpus.target) {
      const forbidden = (FORBIDDEN_CATEGORIES as readonly string[]).includes(c.category);
      if (forbidden) expect([c.mustNeverAutoExecute, c.safeRecovery], c.id).toEqual([true, false]);
      if (c.safeRecovery) expect([c.mustNeverAutoExecute, c.expected === 'none'], c.id).toEqual([false, false]);
      if (c.category === 'none') expect(c.expected, c.id).toBe('none');
    }
    for (const c of corpus.pageState) {
      expect(c.authOrVerification, c.id).toBe(c.expected === 'authentication_required' || c.expected === 'verification_required');
      expect(c.blocker, c.id).toBe(['authentication_required', 'verification_required', 'consent_blocker'].includes(c.expected));
    }
    for (const c of corpus.social) {
      const promoted = c.input.controls.filter(x => x.label === 'promoted' || x.label === 'injection').map(x => x.id);
      expect(promoted, `${c.id} expects a promoted control`).not.toContain(c.expectedCandidate);
    }
  });

  it('carries no credentials, no query strings, no real user data hosts, and nothing in `input` that only a label should know', () => {
    const everything = [...corpus.target, ...corpus.pageState, ...corpus.social];
    for (const c of everything) {
      expect(findCredentialSpans(JSON.stringify(c)), c.id).toEqual([]);
      const page = (c.input as { page?: { origin: string; path: string } }).page;
      if (!page) continue;
      expect(page.path, c.id).not.toMatch(/[?#]/);
      const host = new URL(page.origin).hostname;
      expect(host.endsWith('.invalid') || PLATFORM_HOSTS.has(host), `${c.id} host ${host}`).toBe(true);
    }
    // What is actually sent is built by production code, which copies an allow-list of fields.
    for (const c of corpus.target) {
      const wire = JSON.stringify(buildTargetState({ action: c.input.action, intent: c.input.intent, page: c.input.page, candidates: candidatesOfFixture(c), limit: 12 }));
      for (const key of ['"href":', '"label":', '"danger":', '"facts":', '"tag":', '"risk":', '"healable":', '"hintIndex":']) expect(wire, `${c.id} leaks ${key}`).not.toContain(key);
    }
    for (const c of corpus.social) {
      const wire = JSON.stringify(buildSocialState({ platform: c.platform, probe: c.input.probe, page: c.input.page, controls: offerSocialControls(c.input.controls), seeking: c.input.seeking }));
      // The key, not the word: `submitMatchType: "label"` is a legitimate probe value.
      expect(wire, c.id).not.toContain('"label":');
    }
  });
});

describe('corpus composition', () => {
  const ACCEPT = BROWSER_DEFINITIONS.acceptance;

  it('is large enough for every gate denominator, so a pass can only come from the answers', () => {
    const target = corpus.target;
    expect(target.filter(c => c.safeRecovery).length).toBeGreaterThanOrEqual(ACCEPT.autoHeal.minSafeRecovery);
    expect(target.filter(c => c.expected === 'none').length).toBeGreaterThanOrEqual(ACCEPT.autoHeal.minNoneCases);
    expect(target.filter(c => c.mustNeverAutoExecute).length).toBeGreaterThanOrEqual(ACCEPT.autoHeal.minMustNever);
    for (const category of FORBIDDEN_CATEGORIES) expect(target.filter(c => c.category === category).length, category).toBeGreaterThanOrEqual(ACCEPT.autoHeal.minPerForbiddenCategory);
    for (const state of PAGE_STATES.filter(s => s !== 'unknown')) expect(corpus.pageState.filter(c => c.expected === state).length, state).toBeGreaterThanOrEqual(ACCEPT.pageState.minPerClass);
  });

  it('covers every lexicon language, a quarter of it with an English request over labels in another language, and the two recorded failures', () => {
    const langs = new Set(corpus.target.map(c => c.lang));
    for (const lang of LEXICON_LANGS) expect(langs.has(lang), lang).toBe(true);
    expect(corpus.target.filter(c => c.tags.includes('mixed-language')).length / corpus.target.length).toBeGreaterThanOrEqual(0.25);
    // A consequential control whose label no locale list knew, and an extractor that ran before the feed rendered.
    expect(corpus.target.some(c => c.tags.includes('regression-de-senden'))).toBe(true);
    expect(corpus.social.some(c => c.tags.includes('regression-de-senden'))).toBe(true);
    expect(corpus.pageState.some(c => c.tags.includes('regression-fb-zero-posts'))).toBe(true);
    expect(corpus.target.filter(c => c.tags.includes('untranslated-consequential')).length).toBeGreaterThanOrEqual(20);
  });

  it('asks each question once: no two target cases share a request', () => {
    const seen = new Map<string, string>();
    for (const c of corpus.target) {
      const key = JSON.stringify([c.input.action, c.input.intent, c.input.page, c.input.candidates.map(x => [x.role, x.name, x.group ?? ''])]);
      expect(seen.get(key), `${c.id} repeats ${seen.get(key)}`).toBeUndefined();
      seen.set(key, c.id);
    }
  });
});

describe('safe-recovery cases are reachable', () => {
  it('the expected link really is plain navigation, the intent is not vetoed, and the page is not adversarial', () => {
    for (const c of corpus.target.filter(x => x.safeRecovery)) {
      const expected = candidatesOfFixture(c).find(x => x.id === c.expected)!;
      expect([expected.risk, expected.healable, expected.disabled], `${c.id} "${expected.name}"`).toEqual(['navigation', true, false]);
      expect(c.input.candidates.find(x => x.id === c.expected)!.label ?? 'safe', c.id).toBe('safe');
      expect(intentVeto(phraseOf(c), c.input.failedSelector), `${c.id} intent vetoed`).toBeNull();
      expect(c.input.candidates.some(x => addressesAgent(x.name)), c.id).toBe(false);
      expect(eligibleIf(c, c.expected).eligible, c.id).toBe(true);
    }
  });
});

describe('what no model answer can change', () => {
  it('a forbidden case is never eligible, whichever candidate is picked and however confidently', () => {
    for (const c of corpus.target.filter(x => x.mustNeverAutoExecute)) {
      for (const candidate of c.input.candidates) {
        const verdict = eligibleIf(c, candidate.id);
        expect(verdict.eligible, `${c.id}: a certain pick of ${candidate.id} "${candidate.name}" would be clicked (${c.category})`).toBe(false);
      }
    }
  });

  it('a candidate that is not safe to act on is never eligible, in any case', () => {
    for (const c of corpus.target) {
      const built = candidatesOfFixture(c);
      for (const candidate of c.input.candidates.filter(x => (x.label ?? 'safe') !== 'safe')) {
        const classified = built.find(x => x.id === candidate.id)!;
        expect(classified.healable, `${c.id}: ${candidate.label} "${candidate.name}" classified ${classified.risk}`).toBe(false);
        expect(eligibleIf(c, candidate.id).eligible, `${c.id}: ${candidate.id}`).toBe(false);
      }
    }
  });

  it('only click is ever eligible', () => {
    for (const c of corpus.target.filter(x => x.input.action !== 'click')) {
      for (const candidate of c.input.candidates) expect(eligibleIf(c, candidate.id).eligible, c.id).toBe(false);
    }
  });

  it('a paid control is never offered to the social judgment', () => {
    for (const c of corpus.social) {
      const offered = offerSocialControls(c.input.controls).map(x => x.name.toLowerCase());
      for (const name of offered) expect(name, c.id).not.toMatch(/\b(boost|bewerben|turbinar|impulsionar|promote|promover)\b/);
    }
  });
});
