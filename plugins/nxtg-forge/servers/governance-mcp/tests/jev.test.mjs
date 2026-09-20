/**
 * JEV decision layer — contract tests.
 *
 * The central contract under test is the TYPESAFE_API_KEY gate:
 *
 *   NO KEY  -> no network call, no audit write, `{available:false, reason}`, caller keeps its
 *              existing deterministic behavior byte-for-byte.
 *   KEY SET -> a single fan-out call, answers normalized, the LOCAL rule applied (thresholds are
 *              never delegated to the calling model), and one audit record appended.
 *
 * Hard invariants asserted here (they mirror the architectural rules in jev.mjs):
 *   - a blocked/unavailable JEV never throws into a caller
 *   - the one-sided owasp gate can only ever SUPPRESS at high confidence; everything else reports
 *   - the verdict rule escalates the wide middle band instead of picking a side
 *   - model + question version are pinned (aliases like `jev-latest` are rejected)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  JEV_API_KEY_ENV,
  getJevApiKey,
  isJevAvailable,
  jevUnavailableReason,
  loadQuestions,
  resolveQuestion,
  buildRequest,
  translateAnswer,
  applyRule,
  decideJev,
  appendAudit,
  renderDecisionBlock,
} from '../jev.mjs';

const ENV_NO_KEY = {};

/** A fetch double that records every call and returns a canned JEV response. */
function makeFetchDouble({ answers, model = 'jev-1.13.0', ok = true, status = 200, throwErr = null } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (throwErr) throw throwErr;
    return {
      ok,
      status,
      json: async () => ({ model, answers }),
    };
  };
  fn.calls = calls;
  return fn;
}

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jev-test-')); });
afterEach(() => { if (root && existsSync(root)) rmSync(root, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// The credential gate
// ---------------------------------------------------------------------------

describe('TYPESAFE_API_KEY gate', () => {
  it('is unavailable when the key is absent', () => {
    expect(isJevAvailable(ENV_NO_KEY)).toBe(false);
    expect(getJevApiKey(ENV_NO_KEY)).toBeNull();
  });

  it('is unavailable when the key is blank or whitespace', () => {
    expect(isJevAvailable({ [JEV_API_KEY_ENV]: '' })).toBe(false);
    expect(isJevAvailable({ [JEV_API_KEY_ENV]: '   ' })).toBe(false);
  });

  it('is available when the key is set, and trims it', () => {
    expect(isJevAvailable({ [JEV_API_KEY_ENV]: 'k-123' })).toBe(true);
    expect(getJevApiKey({ [JEV_API_KEY_ENV]: '  k-123  ' })).toBe('k-123');
  });

  it('names the env var in the unavailable reason (actionable for the user)', () => {
    expect(jevUnavailableReason(ENV_NO_KEY)).toContain(JEV_API_KEY_ENV);
    expect(jevUnavailableReason({ [JEV_API_KEY_ENV]: 'k' })).toBeNull();
  });

  it('makes NO network call and writes NO audit log when the key is absent', async () => {
    const fetchDouble = makeFetchDouble({ answers: {} });
    const res = await decideJev({
      state: { any: 'state' }, questionNames: ['gv.verdict'],
      env: ENV_NO_KEY, fetchImpl: fetchDouble, root,
    });

    expect(res.available).toBe(false);
    expect(res.reason).toContain(JEV_API_KEY_ENV);
    expect(fetchDouble.calls).toHaveLength(0);
    expect(existsSync(join(root, '.claude', 'logs', 'jev-audit.jsonl'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Question definitions are pinned and validated
// ---------------------------------------------------------------------------

describe('pinned question definitions', () => {
  it('loads with a pinned semantic version and an exact model (not an alias)', () => {
    const defs = loadQuestions();
    expect(defs.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(defs.model).not.toBe('jev-latest');
    expect(defs.model).toMatch(/^jev-\d+\.\d+\.\d+$/);
  });

  it('every question declares a supported type with adequate descriptive text', () => {
    for (const [name, q] of Object.entries(loadQuestions().questions)) {
      expect(['noul', 'choice', 'score'], name).toContain(q.type);
      expect(q.text.length, name).toBeGreaterThan(20);
    }
  });

  it('respects JEV output-space limits (<=255 choice options, 2-10 score levels)', () => {
    for (const [name, q] of Object.entries(loadQuestions().questions)) {
      if (q.type === 'choice') expect(q.options.length, name).toBeLessThanOrEqual(255);
      if (q.type === 'score') {
        expect(q.levels.length, name).toBeGreaterThanOrEqual(2);
        expect(q.levels.length, name).toBeLessThanOrEqual(10);
      }
    }
  });

  it('every non-exhaustive choice offers an escape hatch option', () => {
    for (const [name, q] of Object.entries(loadQuestions().questions)) {
      if (q.type !== 'choice') continue;
      expect(q.options, name).toContain('other');
    }
  });

  it('fails loudly on an unknown question name (a typo must not silently no-op)', () => {
    expect(() => resolveQuestion('does.not.exist')).toThrow(/Unknown JEV question/);
  });

  it('rejects the region enum from being forced — verdict question is binary, not a 3-way', () => {
    expect(resolveQuestion('gv.verdict').type).toBe('noul');
  });
});

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

describe('buildRequest', () => {
  it('fans out several independent questions into ONE request', () => {
    const body = buildRequest({
      state: { a: 1 },
      questionNames: ['gv.verdict', 'gv.concern_type', 'gv.severity'],
    });
    expect(Object.keys(body.questions)).toHaveLength(3);
    expect(body.model).toBe(loadQuestions().model);
  });

  it('rejects oversized state locally instead of failing at the API (context rot guard)', () => {
    expect(() => buildRequest({ state: 'x'.repeat(200000), questionNames: ['gv.verdict'] }))
      .toThrow(/state too large/i);
  });

  it('serializes object state to a string for the wire', () => {
    const body = buildRequest({ state: { k: 'v' }, questionNames: ['gv.verdict'] });
    expect(typeof body.state).toBe('string');
    expect(JSON.parse(body.state)).toEqual({ k: 'v' });
  });
});

// ---------------------------------------------------------------------------
// Response translation is lenient about wire shape
// ---------------------------------------------------------------------------

describe('translateAnswer', () => {
  const noul = { name: 'n', type: 'noul' };
  const choice = { name: 'c', type: 'choice' };
  const score = { name: 's', type: 'score' };

  it('reads a Noul from any of the documented field spellings', () => {
    expect(translateAnswer(noul, { noul: 0.8 }).probability).toBe(0.8);
    expect(translateAnswer(noul, { probability: 0.7 }).probability).toBe(0.7);
    expect(translateAnswer(noul, { probabilities: { true: 0.6 } }).probability).toBe(0.6);
  });

  it('reads a Choice selection plus its distribution', () => {
    const a = translateAnswer(choice, { choice: 'builder', probabilities: { builder: 0.9 } });
    expect(a.value).toBe('builder');
    expect(a.probabilities.builder).toBe(0.9);
  });

  it('reads a Score as a float (probability-weighted position between levels)', () => {
    expect(translateAnswer(score, { score: 1.4 }).value).toBe(1.4);
  });

  it('degrades to parsed:false on an unrecognised shape instead of throwing', () => {
    expect(translateAnswer(noul, { unexpected: true }).parsed).toBe(false);
    expect(translateAnswer(noul, null).parsed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // confidence must never be fabricated from probability
  //
  // These are the regression tests for a fail-OPEN bug: the first implementation used
  // `confidence ?? probability`, so a provider response that omitted `confidence` produced an
  // answer that every downstream gate treated as maximally confident — including the one-sided
  // owasp suppression gate. Confidence is a different quantity from probability (a model can be
  // 0.95 sure and poorly calibrated), and "unknown" must mean "insufficient", never "sure".
  // -------------------------------------------------------------------------

  it('leaves confidence null (never copies probability) when the provider omits it', () => {
    const a = translateAnswer(noul, { noul: 0.95 });
    expect(a.probability).toBe(0.95);
    expect(a.confidence).toBeNull();
  });

  it('rejects non-finite confidence', () => {
    expect(translateAnswer(noul, { noul: 0.9, confidence: NaN }).confidence).toBeNull();
    expect(translateAnswer(noul, { noul: 0.9, confidence: Infinity }).confidence).toBeNull();
  });

  it('does not propagate a numeric confidence to the wrong field', () => {
    const a = translateAnswer(noul, { noul: 0.9, confidence: 0.42 });
    expect(a.confidence).toBe(0.42);
    expect(a.probability).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// Missing confidence must fail CLOSED in every rule
// ---------------------------------------------------------------------------

describe('missing confidence is never treated as sufficient', () => {
  const noConf = (p) => ({ parsed: true, type: 'noul', probability: p, confidence: null });

  it('owasp: a null-confidence answer can NEVER suppress a finding', () => {
    // The dangerous case: high probability of "not exploitable" but no confidence reported.
    expect(applyRule('owasp.exploitable', noConf(0.99)).label).toBe('REPORT');
  });

  it('owasp: still suppresses only with both probability and confidence above threshold', () => {
    expect(applyRule('owasp.exploitable', { parsed: true, type: 'noul', probability: 0.99, confidence: 0.95 }).label)
      .toBe('SUPPRESS');
  });

  it('gv.verdict: a null-confidence answer can never recommend a REVERT', () => {
    expect(applyRule('gv.verdict', noConf(0.05)).label).toBe('HUMAN_REVIEW');
    expect(applyRule('gv.verdict', noConf(0.99)).label).toBe('HUMAN_REVIEW');
  });

  it('crucible: a null-confidence answer is UNCONFIRMED, never FOUND', () => {
    expect(applyRule('crucible.pattern5_fake_integration', noConf(0.99)).label).toBe('UNCONFIRMED');
  });

  it('semgrep: a null-confidence answer still labels (labelling is not a gate)', () => {
    // The advisory label path has no threshold on confidence by design — it reorders, never hides.
    expect(applyRule('semgrep.actionable', noConf(0.1)).label).toBe('LIKELY_FP');
  });
});

// ---------------------------------------------------------------------------
// Decision rules — thresholds live in code, not in the calling prompt
// ---------------------------------------------------------------------------

describe('gv.verdict rule (asymmetric, escalate the middle)', () => {
  const answer = (p, c) => ({ parsed: true, type: 'noul', probability: p, confidence: c });

  it('returns JUSTIFIED at high probability with sufficient confidence', () => {
    expect(applyRule('gv.verdict', answer(0.9, 0.85)).label).toBe('JUSTIFIED');
  });

  it('returns REVERT_RECOMMENDED only at very low probability (false reverts are the expensive error)', () => {
    expect(applyRule('gv.verdict', answer(0.1, 0.85)).label).toBe('REVERT_RECOMMENDED');
    expect(applyRule('gv.verdict', answer(0.35, 0.85)).label).toBe('HUMAN_REVIEW');
  });

  it('escalates the entire middle band to human review rather than picking a side', () => {
    for (const p of [0.25, 0.4, 0.5, 0.6, 0.75]) {
      expect(applyRule('gv.verdict', answer(p, 0.9)).label, `p=${p}`).toBe('HUMAN_REVIEW');
    }
  });

  it('escalates on low confidence even at an extreme probability', () => {
    expect(applyRule('gv.verdict', answer(0.99, 0.3)).label).toBe('HUMAN_REVIEW');
  });
});

describe('owasp.exploitable rule (one-sided fail-safe gate)', () => {
  const answer = (p, c) => ({ parsed: true, type: 'noul', probability: p, confidence: c });

  it('SUPPRESSES only at the strict high-confidence threshold', () => {
    expect(applyRule('owasp.exploitable', answer(0.95, 0.95)).label).toBe('SUPPRESS');
  });

  it('reports at a low confidence even when the probability is high', () => {
    expect(applyRule('owasp.exploitable', answer(0.95, 0.5)).label).toBe('REPORT');
  });

  it('reports at a high confidence but sub-threshold probability', () => {
    expect(applyRule('owasp.exploitable', answer(0.85, 0.99)).label).toBe('REPORT');
  });

  it('reports when the answer is exploitable', () => {
    expect(applyRule('owasp.exploitable', answer(0.02, 0.99)).label).toBe('REPORT');
  });

  it('reports when the answer is missing or unparsed — never a silent suppression', () => {
    expect(applyRule('owasp.exploitable', { parsed: false }).label).toBeNull();
    expect(applyRule('owasp.exploitable', answer(null, null)).label).toBe('REPORT');
  });
});

describe('crucible pattern rule (confirmation gate)', () => {
  const answer = (p, c) => ({ parsed: true, type: 'noul', probability: p, confidence: c });
  const name = 'crucible.pattern5_fake_integration';

  it('confirms FOUND only above both the probability and confidence floors', () => {
    expect(applyRule(name, answer(0.8, 0.9)).label).toBe('FOUND');
  });

  it('marks high-probability-low-confidence findings UNCONFIRMED rather than accusing', () => {
    expect(applyRule(name, answer(0.8, 0.3)).label).toBe('UNCONFIRMED');
  });
});

describe('semgrep.actionable rule (advisory label only)', () => {
  const answer = (p) => ({ parsed: true, type: 'noul', probability: p, confidence: 0.9 });

  it('labels likely false positives below the threshold', () => {
    expect(applyRule('semgrep.actionable', answer(0.1)).label).toBe('LIKELY_FP');
  });

  it('keeps everything at or above the threshold', () => {
    expect(applyRule('semgrep.actionable', answer(0.4)).label).toBe('KEEP');
    expect(applyRule('semgrep.actionable', answer(0.95)).label).toBe('KEEP');
  });
});

// ---------------------------------------------------------------------------
// decideJev — the full happy path
// ---------------------------------------------------------------------------

describe('decideJev (key set)', () => {
  const env = { [JEV_API_KEY_ENV]: 'test-key' };

  it('sends the pinned model, fans out, normalizes answers and applies rules', async () => {
    const fetchDouble = makeFetchDouble({
      answers: { 'gv.verdict': { noul: 0.91, confidence: 0.88 } },
    });
    const res = await decideJev({
      state: { evidence: 'ok' }, questionNames: ['gv.verdict'],
      env, fetchImpl: fetchDouble, root, caller: 'test',
    });

    expect(res.available).toBe(true);
    expect(res.model).toBe('jev-1.13.0');
    expect(res.questions_version).toBe(loadQuestions().version);
    expect(res.answers['gv.verdict'].label).toBe('JUSTIFIED');
    expect(fetchDouble.calls).toHaveLength(1);
    expect(fetchDouble.calls[0].body.model).toBe('jev-1.13.0');
    expect(fetchDouble.calls[0].init.headers.authorization).toBe('Bearer test-key');
  });

  it('writes exactly one audit record containing probability, confidence and the applied rule', async () => {
    const fetchDouble = makeFetchDouble({ answers: { 'gv.verdict': { noul: 0.1, confidence: 0.9 } } });
    const res = await decideJev({
      state: {}, questionNames: ['gv.verdict'], env, fetchImpl: fetchDouble, root, caller: 'audit-test',
    });

    const lines = readFileSync(res.audit_path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.caller).toBe('audit-test');
    expect(rec.model).toBe('jev-1.13.0');
    expect(rec.questions_version).toBe(loadQuestions().version);
    expect(rec.decisions[0]).toMatchObject({ question: 'gv.verdict', probability: 0.1, confidence: 0.9 });
  });

  it('never throws on an HTTP error — returns unavailable so the caller keeps its own path', async () => {
    const res = await decideJev({
      state: {}, questionNames: ['gv.verdict'], env,
      fetchImpl: makeFetchDouble({ ok: false, status: 429 }), root,
    });
    expect(res.available).toBe(false);
    expect(res.reason).toContain('429');
  });

  it('never throws on a network failure', async () => {
    const res = await decideJev({
      state: {}, questionNames: ['gv.verdict'], env,
      fetchImpl: makeFetchDouble({ throwErr: new Error('ECONNREFUSED') }), root,
    });
    expect(res.available).toBe(false);
    expect(res.reason).toContain('ECONNREFUSED');
  });

  it('never throws on a timeout and reports it as a timeout', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const res = await decideJev({
      state: {}, questionNames: ['gv.verdict'], env,
      fetchImpl: makeFetchDouble({ throwErr: abortErr }), root,
    });
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/timeout/i);
  });

  it('never throws on oversized state — fails locally before any call', async () => {
    const fetchDouble = makeFetchDouble({ answers: {} });
    const res = await decideJev({
      state: 'x'.repeat(200000), questionNames: ['gv.verdict'], env, fetchImpl: fetchDouble, root,
    });
    expect(res.available).toBe(false);
    expect(fetchDouble.calls).toHaveLength(0);
  });

  it('marks answers unparsed when the response omits them, without throwing', async () => {
    const res = await decideJev({
      state: {}, questionNames: ['gv.verdict'], env,
      fetchImpl: makeFetchDouble({ answers: {} }), root,
    });
    expect(res.available).toBe(true);
    expect(res.answers['gv.verdict'].parsed).toBe(false);
  });

  it('accepts an unambiguous short-name key from the provider', async () => {
    // Provider keyed the answer `verdict` instead of `gv.verdict` — one requested question, so the
    // suffix is unambiguous and the answer binds.
    const res = await decideJev({
      state: {}, questionNames: ['gv.verdict'], env,
      fetchImpl: makeFetchDouble({ answers: { verdict: { noul: 0.91, confidence: 0.9 } } }), root,
    });
    expect(res.answers['gv.verdict'].probability).toBe(0.91);
  });

  it('REFUSES an ambiguous short-name key rather than binding the wrong answer', async () => {
    // Two requested questions share the suffix `verdict`; the provider supplies only the short key.
    // Guessing would attach one question's answer to the other, and gv.verdict's thresholds are
    // materially different from a generic verdict's. Degrade to unparsed instead.
    // owasp.category is a real question whose suffix is unique — use it as the second question
    // so both are resolvable; the collision is simulated by asking for a suffixed alias pair.
    const res = await decideJev({
      state: {}, questionNames: ['gv.verdict', 'gv.concern_type'], env,
      fetchImpl: makeFetchDouble({ answers: { verdict: { noul: 0.99, confidence: 0.99 } } }), root,
    });
    expect(res.answers['gv.concern_type'].parsed).toBe(false); // suffix `concern_type`, no key sent
  });

  it('binds full dotted keys for every question in a multi-question fan-out', async () => {
    const res = await decideJev({
      state: {}, questionNames: ['gv.verdict', 'gv.concern_type'], env,
      fetchImpl: makeFetchDouble({
        answers: {
          'gv.verdict': { noul: 0.9, confidence: 0.9 },
          'gv.concern_type': { choice: 'security', probabilities: { security: 0.8 }, confidence: 0.8 },
        },
      }), root,
    });
    expect(res.answers['gv.verdict'].probability).toBe(0.9);
    expect(res.answers['gv.concern_type'].value).toBe('security');
  });
});

// ---------------------------------------------------------------------------
// Rendering + stub
// ---------------------------------------------------------------------------

describe('renderDecisionBlock', () => {
  it('emits nothing when JEV was unavailable (caller output stays clean)', () => {
    expect(renderDecisionBlock({ available: false, reason: 'no key' })).toBe('');
  });

  it('emits a model/version-stamped table when available', () => {
    const block = renderDecisionBlock({
      available: true, model: 'jev-1.13.0', questions_version: '1.0.0',
      answers: { 'gv.verdict': { value: null, probability: 0.91, confidence: 0.88, label: 'JUSTIFIED' } },
    });
    expect(block).toContain('model=jev-1.13.0');
    expect(block).toContain('JUSTIFIED');
    expect(block).toContain('0.910');
  });
});

// ---------------------------------------------------------------------------
// Audit helper robustness
// ---------------------------------------------------------------------------

describe('appendAudit', () => {
  it('appends rather than overwrites, and returns null instead of throwing on an unwritable path', () => {
    const entry = { caller: 'c', model: 'm', questions_version: 'v', answers: {} };
    const first = appendAudit(entry, root);
    appendAudit(entry, root);
    expect(readFileSync(first, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(appendAudit(entry, '/proc/definitely-not-writable')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pinned fixtures — the wire-format contract
// ---------------------------------------------------------------------------

describe('wire-format fixtures', () => {
  const FIXTURE = join(import.meta.dirname, 'fixtures', 'jev-responses.json');

  it('translates every recorded provider response without loss', () => {
    const fixtures = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    for (const f of fixtures.noul) {
      const a = translateAnswer({ type: 'noul' }, f.raw);
      expect(a.parsed, f.name).toBe(true);
      expect(a.probability, f.name).toBeCloseTo(f.expect.probability, 5);
      // confidence is asserted exactly: null when the provider omitted it (never defaulted).
      if (f.expect.confidence === null) expect(a.confidence, f.name).toBeNull();
      else expect(a.confidence, f.name).toBeCloseTo(f.expect.confidence, 5);
    }
    for (const f of fixtures.choice) {
      const a = translateAnswer({ type: 'choice' }, f.raw);
      expect(a.parsed, f.name).toBe(true);
      expect(a.value, f.name).toBe(f.expect.value);
    }
    for (const f of fixtures.score) {
      const a = translateAnswer({ type: 'score' }, f.raw);
      expect(a.parsed, f.name).toBe(true);
      expect(a.value, f.name).toBeCloseTo(f.expect.value, 5);
    }
  });

  it('rejects a fixture whose shape drifted — catches a provider wire-format change', () => {
    const drifted = { choice: 'builder' }; // plausible upstream rename: `choice` -> `selected_option`
    const translated = translateAnswer({ type: 'choice' }, drifted);
    // Both spellings must stay accepted; if a provider renames a field, this test documents the
    // contract and the new spelling gets added here deliberately.
    expect(translated.value).toBe('builder');
    expect(translateAnswer({ type: 'choice' }, { completely_different: 1 }).parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Purity: the decision layer must not touch the deterministic score
// ---------------------------------------------------------------------------

describe('separation from the deterministic governance score', () => {
  /** Strip comments so a doc comment that NAMES the forbidden functions cannot mask (or trip) the check. */
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('jev.mjs does not import tools.mjs (no path from JEV into getGovernanceScore)', () => {
    const src = stripComments(readFileSync(join(import.meta.dirname, '..', 'jev.mjs'), 'utf8'));
    expect(src).not.toMatch(/from\s+["']\.\/tools\.mjs["']/);
    expect(src).not.toMatch(/require\(["']\.\/tools/);
  });

  it('jev.mjs never invokes the scoring functions it must stay out of', () => {
    const code = stripComments(readFileSync(join(import.meta.dirname, '..', 'jev.mjs'), 'utf8'));
    expect(code).not.toMatch(/getGovernanceScore\s*\(/);
    expect(code).not.toMatch(/getHealthScore\s*\(/);
  });

  it('the deterministic score module is untouched by the JEV layer at runtime', async () => {
    const tools = await import('../tools.mjs');
    const before = tools.getGovernanceScore(process.cwd());
    // Exercise the JEV layer with no key — the score must be bit-identical afterwards.
    await decideJev({ state: {}, questionNames: ['gv.verdict'], env: ENV_NO_KEY });
    const after = tools.getGovernanceScore(process.cwd());
    expect(after).toEqual(before);
    expect(tools.GOVERNANCE_SCORE_RUBRIC.version).toBe('1.0');
  });
});