# JEV advisory decision layer

Forge can call **JEV** (TypeSafe AI's "System One" model) at a handful of bounded decision points
where the current choice is made by unconstrained prose: a governance verdict, a fraud-pattern
confirmation, a false-positive triage. This document covers what that buys, what it costs, and the
rules the integration must never break.

## What JEV is

A hosted decision API: **state in, typed probabilistic decisions out.** Three primitives:

| Primitive | Question | Answer |
|---|---|---|
| **Noul** | Is proposition X true? | probability 0–1 (+ confidence) |
| **Choice** | Which of these known options? | selection + full distribution (+ confidence) |
| **Score** | Where on this ordered rubric? | probability-weighted scalar (+ per-level distribution) |

It does not generate text. It cannot do arithmetic, count, order dates, or read images. Its
guarantee is **schema validity only** — the answer is always inside the space you declared, but a
wrong-but-valid answer is possible, and adversarial state can influence it.

**That distinction is the whole design premise:** JEV must never be the only thing standing between
a hostile input and a consequential action.

## Enabling it

```bash
export TYPESAFE_API_KEY="..."     # the one credential JEV needs
```

`TYPESAFE_API_KEY` is a **hard gate**. With it unset:

- `forge_jev_decide` returns `{available: false, reason}` — it never throws, never retries, never
  calls the network.
- Every hook and skill follows its original deterministic path, byte-identically.
- No audit log is written, no state leaves the machine.

Optional knobs:

| Variable | Default | Effect |
|---|---|---|
| `JEV_ENDPOINT` | `https://api.typesafe.ai/v1/systemone` | override for self-hosting or testing |
| `JEV_MODEL` | pinned in `questions.v1.json` | override the pinned model |
| `JEV_TIMEOUT` | `3` (seconds) | per-call budget in the bash layer |
| `FORGE_JEV_DEBUG=1` | off | dump the raw response to stderr (first-run wire-format check) |
| `FORGE_SEMGREP_CONFIG` | resolved local-first | semgrep ruleset override |

## The four invariants

Violating any of these is a regression, regardless of how good the decision accuracy looks.

1. **No key, no behavior change.** Every JEV path is additive. Removing the key must restore the
   previous behavior exactly — that is the test, not a hope.
2. **Never gate a blocking path.** The PreToolUse security guards (command, secret, injection, SQL)
   are local, offline and deterministic. A 70–500 ms network call with adversarial-manipulation
   risk on an exit-2 deny path makes the system worse, not better. JEV may add an *advisory* second
   opinion alongside a guard; it may never stand in for one.
3. **Never touch the deterministic score.** `getGovernanceScore` and its frozen rubric v1.0 stay
   exactly as they are. A probabilistic answer inside a byte-reproducible score would destroy the
   property the score exists to provide. This is enforced by a test that recomputes the score
   across a JEV call and asserts it is unchanged.
4. **Never silently suppress.** JEV may reorder, label, and escalate. On a security finding it may
   suppress only through an explicit one-sided high-confidence gate, and every such suppression is
   logged. Reordering that hides a finding is a bug.

## Where it is wired in

| Site | Primitives | What JEV does | What it must never do |
|---|---|---|---|
| `agents/governance-verifier.md` Step 3 | Noul + Choice + Score, one fan-out | Maps evidence to JUSTIFIED / REVERT_RECOMMENDED / HUMAN_REVIEW via asymmetric thresholds | Auto-revert; override the user; run on unavailable network |
| `skills/crucible-audit` Phase 2 | 8 parallel Nouls | Confirms grep *leads* into FOUND / FOUND (UNCONFIRMED) | Clear a pattern without a line-level read; count UNCONFIRMED toward the fraud margin |
| `skills/owasp-security` triage | Noul + Choice | One-sided fail-safe noise triage; taxonomy mapping | Suppress below 0.9 confidence; run before the deterministic exclusion list |
| `hooks/security-semgrep-scan.sh` | Noul fan-out | Actionability reorder + "(likely FP)" label | Drop a finding; run without a key; send unredacted source |

The `--config auto` semgrep hook had a bigger problem than false positives: it was
**unauthenticated**, so a 401 left it silently reporting nothing. The hook now prefers a local
`.semgrep.yml`, then falls back to `auto`, and **reports when the config could not be loaded** rather
than implying the file was clean.

## Thresholds live in the repo, not in a prompt

`servers/governance-mcp/jev/questions.v1.json` holds every question's wording, option set, rubric
levels — and its decision rule:

```json
"gv.verdict": {
  "type": "noul",
  "text": "The flagged change is justified by the collected evidence: ...",
  "rule": { "justify_above": 0.8, "revert_below": 0.2, "confidence_min": 0.6 }
}
```

Two consequences worth stating plainly:

- Thresholds are **identical across runs** and reviewable in a diff. A calling LLM cannot quietly
  pick a different cutoff.
- Changing wording or thresholds is a **semantic change**: bump `version`. Every audit record
  carries it, so old decisions stay interpretable.

**Pin an exact model** (`jev-1.13.0`), never an alias like `jev-latest`. An alias means yesterday's
threshold can be calibrated against a model that no longer answers the same way.

### Why the verdict rule is asymmetric

A false `REVERT_RECOMMENDED` blocks correct work and burns trust in the gate. A missed revert gets
caught at the next review. So REVERT requires a *low probability AND adequate confidence*, and the
wide 0.2–0.8 middle band escalates to a human instead of picking a side.

### Why the OWASP gate is one-sided

A wrong-but-confident suppression silently hides a real vulnerability. So suppression requires
≥ 0.9 probability of not-exploitable at ≥ 0.9 confidence, and every other outcome — including a
missing answer — keeps the finding in the report. Noise reduction never outranks a missed vuln.

## The audit log is the calibration corpus

Every call appends one line to `.claude/logs/jev-audit.jsonl`:

```json
{"ts":"2026-09-19T22:06:09Z","caller":"hooks/security-semgrep-scan","model":"jev-1.13.0",
 "questions_version":"1.0.0",
 "decisions":[{"question":"f0","probability":0.93,"confidence":0.91,"value":null,"label":"KEEP"}]}
```

This exists so thresholds are tuned from **your** distribution, not a vendor benchmark. Two
practices it enables:

- **Calibration:** collect labelled outcomes (was the finding real? did the revert hold?) and check
  whether p ≥ 0.8 actually means ~80% justified on your data. If not, adjust the threshold in
  `questions.v1.json` and bump the version.
- **Replay:** re-run a new question version against recorded decisions before shipping the change.

Add `.claude/logs/` to `.gitignore` — it is telemetry, not source.

## Data leaving the machine

Semgrep triage is the one path that sends source excerpts to a hosted API. Excerpts are **redacted
first**: secret-shaped assignments (quoted or bare) and long opaque tokens are masked before the
request is built. The working pattern, verified by test:

```
const password = "hunter2hunter2hunter2";     →  const password = [REDACTED];
const apiKey = 'sk_live_abcdefghijkl...';     →  const apiKey = '[REDACTED]';
fetch(url, {headers:{authorization:"Bearer eyJ..."}})  →  ...authorization:"Bearer [REDACTED].abc"
```

Redaction is best-effort, not a guarantee. If your code must never leave the machine, do not set
`TYPESAFE_API_KEY` — the deterministic path is complete without it. Note that `--config auto` also
reaches the network; a local `.semgrep.yml` keeps layer 1–2 entirely offline.

## Wire-format caveat (read before debugging)

The request/response shape in `jev.mjs` is reconstructed from public documentation, **not** from a
verified live capture. Response interpretation is deliberately lenient (several spellings accepted
per primitive) and pinned by fixtures in `tests/fixtures/jev-responses.json`.

On the first real call:

```bash
FORGE_JEV_DEBUG=1 <your command>
```

and diff the raw payload against those fixtures. A provider field rename should show up as a
deliberate fixture edit, not a silently-unparsed answer. `translateAnswer()` returns
`parsed: false` rather than throwing, so a drift degrades to the deterministic path instead of
crashing a hook.

## Testing

```bash
cd plugins/nxtg-forge/servers/governance-mcp
npm run test:unit          # includes tests/jev.test.mjs (45 cases)
node tests/integration/l1-journey.mjs   # asserts the key gate over a real stdio handshake
```

The suite's central contract is the gate: **no key → zero network calls, zero audit writes,
`available: false`**, plus the rule tables (the middle band escalates; the one-sided gate reports
unless certain; `label` is a reserved jq word — the kind of thing that silently printed nothing
before it was caught).

## Rollback

Unset `TYPESAFE_API_KEY`. Nothing else is required: there is no cache to clear, no lockfile change,
no migration. To remove the integration entirely, delete `jev.mjs`, `jev/`, and `lib-jev.sh`, and
revert the `forge_jev_decide` entry in `TOOLS`; the markdown wiring is inert without the tool.
