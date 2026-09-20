#!/usr/bin/env node
/**
 * JEV decision CLI — the single client for non-MCP callers (bash hooks).
 *
 * WHY THIS EXISTS
 * ---------------
 * PostToolUse hooks cannot speak MCP (the governance-mcp server is a separate stdio process), but
 * that only justifies not speaking MCP — it does not justify a second JEV *client*. An earlier
 * revision re-implemented the endpoint, model pin, timeout, question wording and answer parser in
 * bash, and the copies immediately drifted: the hook shipped question text that no longer matched
 * the versioned definition, and the bash audit record had a different schema from the Node one.
 *
 * So: one client. Hooks gate on TYPESAFE_API_KEY, then shell out to this file. Every rule,
 * threshold, question definition and audit record comes from jev.mjs — the same code the MCP tool
 * uses — so there is exactly one place a wire-format change or a threshold change has to land.
 *
 * CONTRACT
 * --------
 *   stdin  : the decision state (raw JSON, or plain text)
 *   argv   : --questions <comma-separated names> [--caller <name>] [--root <dir>]
 *   stdout : the decideJev() envelope as JSON, ALWAYS, on every path
 *   exit   : 0 on every path
 *
 * Exit 0 unconditionally is deliberate. Degradation is expressed in the envelope
 * (`"available": false`), not in an exit code, so a shell caller reads one field instead of
 * re-implementing sentinel handling per call site. A missing key, a timeout and a network failure
 * are all ordinary data, not shell errors.
 *
 * Node is already a hard requirement of this plugin (it ships governance-mcp), so this adds no new
 * runtime dependency. If node is somehow absent the hook's `command -v` guard skips it entirely.
 */

import { decideJev, isJevAvailable, jevUnavailableReason, loadQuestions } from "./jev.mjs";
import { readFileSync } from "fs";

/**
 * Parse `--flag value` pairs. Deliberately tiny: this is called per file-write, so it avoids a
 * dependency and any startup ceremony beyond what Node itself charges.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{questions: string[], caller: string, root: string|null}}
 */
function parseArgs(argv) {
  const out = { questions: [], caller: "hook", root: null };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inlineValue] = argv[i].split("=");
    const value = inlineValue ?? argv[++i];
    if (flag === "--questions") out.questions = String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (flag === "--caller") out.caller = String(value ?? "hook");
    else if (flag === "--root") out.root = value ?? null;
  }
  return out;
}

/** Read all of stdin. Returns "" when stdin is empty or already closed. */
function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

async function main() {  const { questions, caller, root } = parseArgs(process.argv.slice(2));

  if (questions.length === 0) {
    process.stdout.write(JSON.stringify({
      available: false,
      reason: "jev-cli: --questions is required (comma-separated question names)",
    }));
    return;
  }

  // Gate before touching stdin state or the network — the TYPESAFE_API_KEY contract.
  if (!isJevAvailable()) {
    process.stdout.write(JSON.stringify({ available: false, reason: jevUnavailableReason() }));
    return;
  }

  // Validate names up front so a typo fails loudly here rather than silently no-op'ing inside the
  // answer loop (decideJev would throw; we surface it as an envelope instead of a stack trace,
  // because a hook's stderr is user-facing noise on a hot path).
  try {
    const known = loadQuestions().questions;
    const unknown = questions.filter((q) => !(q in known));
    if (unknown.length > 0) {
      process.stdout.write(JSON.stringify({
        available: false,
        reason: `jev-cli: unknown question(s) ${unknown.join(", ")}. Known: ${Object.keys(known).join(", ")}`,
      }));
      return;
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({ available: false, reason: `jev-cli: ${err.message}` }));
    return;
  }

  const raw = readStdin();
  let state = raw;
  try {
    state = JSON.parse(raw); // prefer structured state; fall back to the raw text
  } catch { /* plain-text state is valid input */ }

  const envelope = await decideJev({
    state,
    questionNames: questions,
    caller,
    ...(root ? { root } : {}),
  });

  process.stdout.write(JSON.stringify(envelope));
}

main().catch((err) => {
  // Never crash a hook: any unexpected throw still yields a well-formed envelope.
  process.stdout.write(JSON.stringify({ available: false, reason: `jev-cli: ${err?.message ?? "unknown error"}` }));
});