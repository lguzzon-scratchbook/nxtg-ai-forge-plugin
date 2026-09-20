/**
 * JEV (TypeSafe AI "System One") decision layer for the NXTG-Forge governance MCP.
 *
 * WHAT THIS IS
 * ------------
 * JEV is a hosted *decision* API: state in, typed probabilistic decisions out. It is not a
 * generative model — it answers Noul (binary proposition -> probability), Choice (fixed option
 * set -> selection + distribution + confidence) and Score (ordered rubric -> probability-weighted
 * scalar) questions. Its guarantee is SCHEMA VALIDITY ONLY: answers are always inside the declared
 * output space, but a wrong-but-valid answer is possible, and adversarial state can influence it.
 *
 * ARCHITECTURAL RULES (do not violate — see docs/jev.md)
 * -----------------------------------------------------
 * 1. HARD GATE: `TYPESAFE_API_KEY` must be present. Absent -> `{ available: false }` and every
 *    caller falls back to its previous behavior, byte-identically. JEV is never a hard dependency.
 * 2. JEV NEVER touches the deterministic governance score (`getGovernanceScore`, frozen rubric
 *    v1.0) and NEVER gates a blocking PreToolUse security guard. Those paths must stay local,
 *    offline and deterministic.
 * 3. JEV output is ADVISORY everywhere. It may label, reorder, or escalate — it must not silently
 *    suppress a security finding or auto-authorize an irreversible action.
 * 4. Every call is logged to `.claude/logs/jev-audit.jsonl` (question version + model + probability
 *    + confidence + applied rule). That log is the calibration corpus: thresholds are tuned from
 *    it, never from vendor claims.
 * 5. Model version is PINNED in `jev/questions.v1.json`, not an alias like `jev-latest`, so
 *    decision behavior is reproducible across sessions.
 *
 * WIRE-FORMAT CAVEAT
 * ------------------
 * The request/response shape below is reconstructed from public documentation, not from a verified
 * live capture against `api.typesafe.ai`. All response interpretation funnels through
 * `translateAnswer()`, and `FORGE_JEV_DEBUG=1` captures the raw response so an operator can diff
 * reality against the fixtures in `tests/jev.test.mjs` on the first real call.
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Token that gates every JEV call. No key -> no network call, ever. */
export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";

/** Relative path (from project root) of the append-only decision audit log. */
export const AUDIT_REL_PATH = join(".claude", "logs", "jev-audit.jsonl");

/**
 * Resolve the JEV API key from an environment object.
 * Claude Code plugins inherit the user's environment, so the key lives in the shell profile or in
 * the plugin's `.mcp.json` env block — never in the repo.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment to read (defaults to process.env)
 * @returns {string|null} the key, or null when unset/blank
 */
export function getJevApiKey(env = process.env) {
  const key = env?.[JEV_API_KEY_ENV];
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The single availability gate. Every JEV-backed feature must call this BEFORE doing any work
 * (building state, running jq over findings, etc.) and take its existing code path when false.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment to read
 * @returns {boolean} true only when a usable API key is present
 */
export function isJevAvailable(env = process.env) {
  return getJevApiKey(env) !== null;
}

/**
 * Human-readable reason JEV is unavailable, for hooks/agents to surface once (not per call).
 * @param {NodeJS.ProcessEnv} [env] - environment to read
 * @returns {string|null} reason string, or null when JEV is available
 */
export function jevUnavailableReason(env = process.env) {
  if (isJevAvailable(env)) return null;
  return `${JEV_API_KEY_ENV} is not set — JEV advisory layer disabled (deterministic behavior unchanged)`;
}

// ---------------------------------------------------------------------------
// Question definitions (pinned, versioned)
// ---------------------------------------------------------------------------

let _questionsCache = null;

/** Shipped definition path. A caller passing anything else opts out of the cache. */
const _defaultQuestionsPath = join(import.meta.dirname, "jev", "questions.v1.json");

/**
 * Load and validate the pinned question/rubric definitions.
 *
 * Definitions live in `jev/questions.v1.json` so that question wording, option sets, rubric levels
 * and thresholds are versioned WITH the repository — not improvised per call. Changing them is a
 * reviewable diff, and the version string travels into every audit entry.
 *
 * @param {string} [path] - override path (tests only)
 * @returns {{version: string, model: string, questions: Record<string, object>}}
 * @throws {Error} when the file is missing, unparseable, or structurally invalid
 */
export function loadQuestions(path = _defaultQuestionsPath) {
  const isDefault = path === _defaultQuestionsPath;
  if (_questionsCache && isDefault) return _questionsCache;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`JEV question definitions unreadable at ${path}: ${err.message}`);
  }

  if (!parsed?.version || !parsed?.model || typeof parsed?.questions !== "object") {
    throw new Error(`JEV question definitions malformed at ${path}: need {version, model, questions}`);
  }
  for (const [name, q] of Object.entries(parsed.questions)) {
    if (!["noul", "choice", "score"].includes(q?.type)) {
      throw new Error(`JEV question "${name}" has unsupported type "${q?.type}"`);
    }
    if (typeof q.text !== "string" || q.text.length < 10) {
      throw new Error(`JEV question "${name}" needs a descriptive text`);
    }
    if (q.type === "choice" && (!Array.isArray(q.options) || q.options.length === 0)) {
      throw new Error(`JEV question "${name}" is a choice but declares no options`);
    }
    if (q.type === "score" && (!Array.isArray(q.levels) || q.levels.length < 2)) {
      throw new Error(`JEV question "${name}" is a score but declares fewer than 2 levels`);
    }
  }

  if (isDefault) _questionsCache = parsed;
  return parsed;
}

/**
 * Resolve a named question into its wire form plus its local decision rule.
 *
 * @param {string} name - question key in questions.v1.json
 * @returns {{name: string, type: string, wire: object, rule: object, text: string}}
 * @throws {Error} when the name is unknown (fail loudly — a typo must not silently no-op)
 */
export function resolveQuestion(name) {
  const { questions } = loadQuestions();
  const q = questions[name];
  if (!q) {
    throw new Error(`Unknown JEV question "${name}". Known: ${Object.keys(questions).join(", ")}`);
  }
  const wire = { type: q.type, text: q.text };
  if (q.type === "choice") wire.options = q.options;
  if (q.type === "score") wire.levels = q.levels;
  if (q.type === "noul" && q.criteria) wire.criteria = q.criteria;
  return { name, type: q.type, wire, rule: q.rule ?? {}, text: q.text };
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

/**
 * Build the systemone request body.
 *
 * State is serialized compactly and clamped to the documented budget: ~64k tokens for state plus
 * all questions, ~32k for state plus the longest single question. State assembly must already have
 * filtered out irrelevant context (JEV accuracy degrades with context rot) — this function only
 * enforces the size ceiling so an oversized call fails locally instead of at the API.
 *
 * @param {object} args
 * @param {object|string} args.state - the decision state (JSON-serializable, or pre-rendered text)
 * @param {string[]} args.questionNames - names resolved from questions.v1.json
 * @param {string} [args.model] - model override (defaults to the pinned model)
 * @param {number} [args.maxStateChars] - local ceiling (default ~120000 chars ≈ 30k tokens)
 * @returns {{model: string, state: string, questions: Record<string, object>}}
 * @throws {Error} when state exceeds the local ceiling
 */
export function buildRequest({ state, questionNames, model, maxStateChars = 120000 }) {
  const defs = loadQuestions();
  const stateText = typeof state === "string" ? state : JSON.stringify(state);
  if (stateText.length > maxStateChars) {
    throw new Error(
      `JEV state too large locally: ${stateText.length} chars > ${maxStateChars}. ` +
      `Filter the state before calling — context rot degrades decision accuracy.`
    );
  }

  const questions = {};
  for (const name of questionNames) questions[name] = resolveQuestion(name).wire;

  return { model: model ?? defs.model, state: stateText, questions };
}

// ---------------------------------------------------------------------------
// Response interpretation
// ---------------------------------------------------------------------------

/**
 * Normalize one raw JEV answer into a stable local shape.
 *
 * Deliberately lenient about field names: `noul` / `probability` / `probabilities.true` are all
 * accepted for a Noul, likewise `choice` / `selected_option` / `value` for a Choice. Any shape
 * that cannot be normalized yields `{parsed: false, raw}` so callers degrade rather than crash.
 *
 * IMPORTANT — confidence is NOT defaulted from probability. They are different quantities: a model
 * can be 0.95 sure and poorly calibrated. When the provider omits `confidence` this returns null,
 * and every rule in applyRule() treats null as INSUFFICIENT confidence (escalate / report), never
 * as sufficient. Fabricating confidence here would silently defeat every confidence gate.
 *
 * @param {{name: string, type: string}} q - resolved question
 * @param {object} raw - the raw answer object from the API
 * @returns {{parsed: boolean, type: string, probability: number|null, confidence: number|null,
 *            value: (string|number|null), probabilities: object|null, raw: object}}
 */
export function translateAnswer(q, raw) {
  const base = {
    parsed: false, type: q.type, probability: null, confidence: null,
    value: null, probabilities: null, raw: raw ?? null,
  };
  if (!raw || typeof raw !== "object") return base;

  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const conf = num(raw.confidence);

  if (q.type === "noul") {
    const p = num(raw.noul) ?? num(raw.probability) ?? num(raw.probabilities?.true);
    if (p === null) return base;
    return { ...base, parsed: true, probability: p, confidence: conf };
  }

  if (q.type === "choice") {
    const value = raw.choice ?? raw.selected_option ?? raw.value ?? null;
    const probs = raw.probabilities && typeof raw.probabilities === "object" ? raw.probabilities : null;
    if (value === null && !probs) return base;
    return {
      ...base, parsed: true, value: value === null ? null : String(value),
      probabilities: probs, confidence: conf ?? (probs && value != null ? num(probs[value]) : null),
    };
  }

  // score
  const value = num(raw.score) ?? num(raw.value);
  if (value === null) return base;
  const probs = raw.probabilities && typeof raw.probabilities === "object" ? raw.probabilities : null;
  return { ...base, parsed: true, value, probabilities: probs, confidence: conf };
}

/**
 * Apply a question's LOCAL decision rule to a parsed answer.
 *
 * Rules are hardcoded here (and parameterized in questions.v1.json), NOT left to the calling LLM —
 * that is the entire point: thresholds must be reviewable, identical across runs, and logged.
 *
 * Supported rule keys:
 *   justify_above / revert_below : asymmetric thresholds for a Noul verdict
 *   likely_fp_below              : Noul probability under which a finding is labelled likely-FP
 *   suppress_above               : one-sided gate — a finding may be dropped ONLY at/above this
 *                                  probability of "not exploitable"; every other case reports
 *   min_probability / min_confidence : confirmation gate for a pattern finding
 *
 * @param {string} name - question name
 * @param {object} answer - output of translateAnswer()
 * @returns {{label: string|null, reason: string}}
 */
export function applyRule(name, answer) {
  if (!answer?.parsed) return { label: null, reason: "answer unparsed — caller must use its default path" };
  const { rule } = resolveQuestion(name);
  const p = answer.probability;
  const c = answer.confidence;

  // Noul: justified / revert / human-review banding (governance-verifier)
  if (rule.justify_above !== undefined && rule.revert_below !== undefined) {
    const floor = rule.confidence_min ?? 0.6;
    // A missing confidence is NOT sufficient confidence. An unknown-certainty answer cannot
    // justify a REVERT (the expensive error) any more than it can clear a change.
    if (c === null || c < floor) {
      return { label: "HUMAN_REVIEW", reason: `confidence ${c ?? "missing"} below ${floor} — escalate` };
    }
    if (p >= rule.justify_above) return { label: "JUSTIFIED", reason: `p=${p} >= ${rule.justify_above} with confidence ${c}` };
    if (p <= rule.revert_below) return { label: "REVERT_RECOMMENDED", reason: `p=${p} <= ${rule.revert_below} with confidence ${c}` };
    return { label: "HUMAN_REVIEW", reason: `p=${p} inside the wide middle band (${rule.revert_below}..${rule.justify_above})` };
  }

  // Noul: one-sided suppression gate (owasp-security)
  if (rule.suppress_above !== undefined) {
    const floor = rule.suppress_confidence ?? rule.suppress_above;
    // FAIL-SAFE: suppression needs BOTH a high probability and a real confidence. A missing
    // confidence reports. This is the only dangerous outcome in the whole layer, so the gate
    // never treats "unknown" as "sure".
    if (p !== null && p >= rule.suppress_above && c !== null && c >= floor) {
      return { label: "SUPPRESS", reason: `not-exploitable p=${p} >= ${rule.suppress_above} at confidence ${c}` };
    }
    return { label: "REPORT", reason: `p=${p ?? "n/a"} / confidence ${c ?? "missing"} — one-sided gate keeps the finding` };
  }

  // Noul: likely-false-positive labelling (semgrep triage)
  if (rule.likely_fp_below !== undefined) {
    if (p !== null && p < rule.likely_fp_below) {
      return { label: "LIKELY_FP", reason: `actionability p=${p} < ${rule.likely_fp_below}` };
    }
    return { label: "KEEP", reason: `actionability p=${p ?? "n/a"}` };
  }

  // Pattern confirmation gate (crucible-audit)
  if (rule.min_probability !== undefined) {
    const floor = rule.min_confidence ?? 0;
    if (p === null) return { label: "UNCONFIRMED", reason: "no probability returned" };
    // Unknown confidence cannot confirm an accusation — it is a lead, not a verdict.
    if (c === null || c < floor) {
      return { label: "UNCONFIRMED", reason: `confidence ${c ?? "missing"} below ${floor} — lead only` };
    }
    if (p >= rule.min_probability) return { label: "FOUND", reason: `p=${p} >= ${rule.min_probability}, confidence ${c}` };
    return { label: "UNCONFIRMED", reason: `p=${p} below ${rule.min_probability}` };
  }

  return { label: null, reason: "no rule configured" };
}

// ---------------------------------------------------------------------------
// Calling JEV
// ---------------------------------------------------------------------------

/**
 * Call JEV and return normalized, rule-applied answers.
 *
 * NEVER throws. Any failure — no key, timeout, network error, HTTP error, unparseable body —
 * returns `{ available: false, reason }` so the caller takes its deterministic path. This is what
 * makes the layer safe to call from advisory hooks and from markdown-driven agents.
 *
 * @param {object} args
 * @param {object|string} args.state - decision state (already filtered — see buildRequest)
 * @param {string[]} args.questionNames - questions to fan out in ONE call
 * @param {string} [args.caller] - who is asking (audit log + debugging)
 * @param {string} [args.root] - project root for the audit log
 * @param {NodeJS.ProcessEnv} [args.env] - environment (tests)
 * @param {Function} [args.fetchImpl] - fetch override (tests); defaults to global fetch
 * @param {number} [args.timeoutMs] - per-call budget
 * @returns {Promise<{available: boolean, reason?: string, model?: string, questions_version?: string,
 *                    answers?: Record<string, object>, audit_path?: string}>}
 */
export async function decideJev({
  state, questionNames, caller = "unknown", root = process.env.FORGE_PROJECT_ROOT || process.cwd(),
  env = process.env, fetchImpl, timeoutMs = 3000,
}) {
  const key = getJevApiKey(env);
  if (!key) return { available: false, reason: jevUnavailableReason(env) };

  let body;
  try {
    body = buildRequest({ state, questionNames });
  } catch (err) {
    return { available: false, reason: `request not buildable: ${err.message}` };
  }

  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { available: false, reason: "no fetch implementation available (requires Node 18+)" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let payload;
  try {
    const res = await doFetch(JEV_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { available: false, reason: `HTTP ${res.status} from JEV` };
    }
    payload = await res.json();
  } catch (err) {
    const reason = err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : `request failed: ${err.message}`;
    return { available: false, reason };
  } finally {
    clearTimeout(timer);
  }

  if (env.FORGE_JEV_DEBUG === "1") {
    // Raw capture for first-run wire-format verification against tests/jev.test.mjs fixtures.
    console.error("[jev] raw response:", JSON.stringify(payload).slice(0, 4000));
  }

  const rawAnswers = payload?.answers ?? payload?.results ?? {};
  const defs = loadQuestions();
  const answers = {};

  // Short-name fallback map: the provider may key answers by the segment after the last dot
  // (`verdict` for `gv.verdict`). Build it ONLY for suffixes that identify exactly one requested
  // question — if two questions share a suffix, the short key is ambiguous and is refused rather
  // than guessed. Silently attaching another question's answer would be worse than degrading.
  const suffixCounts = new Map();
  for (const name of questionNames) {
    const s = name.split(".").pop();
    suffixCounts.set(s, (suffixCounts.get(s) ?? 0) + 1);
  }
  const unambiguousSuffix = (name) => {
    const s = name.split(".").pop();
    return suffixCounts.get(s) === 1 ? s : null;
  };

  for (const name of questionNames) {
    const q = resolveQuestion(name);
    const short = unambiguousSuffix(name);
    const raw = rawAnswers[name] ?? (short ? rawAnswers[short] : null) ?? null;
    const translated = translateAnswer(q, raw);
    answers[name] = { ...translated, ...applyRule(name, translated) };
  }

  const result = {
    available: true,
    model: payload?.model ?? body.model,
    questions_version: defs.version,
    answers,
    audit_path: appendAudit({ caller, model: payload?.model ?? body.model, questions_version: defs.version, answers }, root),
  };
  return result;
}

/**
 * Append one decision record to the audit log. Best-effort: never throws, never blocks a caller.
 *
 * The log is the calibration corpus. It records the pinned model, the question-definition version,
 * every probability/confidence, and the rule label actually applied — so any threshold change can
 * later be replayed against real decisions instead of vendor benchmarks.
 *
 * @param {{caller: string, model: string, questions_version: string, answers: object}} entry
 * @param {string} root - project root
 * @returns {string|null} path written, or null when the write failed
 */
export function appendAudit(entry, root) {
  const path = join(root, AUDIT_REL_PATH);
  const record = {
    ts: new Date().toISOString(),
    caller: entry.caller,
    model: entry.model,
    questions_version: entry.questions_version,
    decisions: Object.entries(entry.answers ?? {}).map(([name, a]) => ({
      question: name, type: a.type, probability: a.probability,
      confidence: a.confidence, value: a.value, label: a.label ?? null,
    })),
  };
  try {
    const dir = join(root, ".claude", "logs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n");
    return path;
  } catch (err) {
    console.error("[jev] audit append failed:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt rendering (for markdown-driven agents and skills)
// ---------------------------------------------------------------------------

/**
 * Render JEV answers as a compact, deterministic advisory block for a markdown agent/skill to
 * copy into its report. Kept intentionally plain: the agent must be able to quote probabilities
 * and the applied rule verbatim, and to override them (overrides are the agent's authority — JEV
 * only adds a calibrated, logged second opinion).
 *
 * @param {object} jevResult - output of decideJev()
 * @returns {string} markdown block, or "" when JEV was unavailable
 */
export function renderDecisionBlock(jevResult) {
  if (!jevResult?.available) return "";
  const lines = [
    `<!-- jev advisory · model=${jevResult.model} · questions=v${jevResult.questions_version} -->`,
    "| Question | Decision | Probability | Confidence | Rule |",
    "|----------|----------|-------------|------------|------|",
  ];
  for (const [name, a] of Object.entries(jevResult.answers ?? {})) {
    const p = a.probability !== null ? a.probability.toFixed(3) : "—";
    const c = a.confidence !== null ? a.confidence.toFixed(3) : "—";
    lines.push(`| \`${name}\` | ${a.value ?? "—"} | ${p} | ${c} | ${a.label ?? "—"} |`);
  }
  return lines.join("\n");
}