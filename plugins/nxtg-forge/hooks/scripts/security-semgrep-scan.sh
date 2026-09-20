#!/bin/bash
#
# NXTG-Forge Security: Semgrep Auto-Scan
# PostToolUse hook for Write/Edit — runs Semgrep SAST on modified files
#
# NON-BLOCKING: always exit 0 (advisory only)
# Input: JSON on stdin with { tool_name, tool_input: { file_path, ... } }
#
# ── ORDERING MATTERS (do not reorder these layers) ────────────────────────────
#   1. PINNED RULESET  — removes the largest source of false-positive noise at the source.
#                        `--config auto` is FP-heavy, which is why developers learn to ignore
#                        this hook. A curated config is the deterministic fix and has zero cost.
#   2. DETERMINISTIC SORT — severity first, then rule id, then line. Same findings, same order,
#                        every run. No network, no judgment.
#   3. JEV TRIAGE      — OPTIONAL, key-gated, ADVISORY. Reorders by an actionability probability
#                        and LABELS likely false positives. It never hides a finding, never
#                        changes the exit code, and is byte-identical-absent when
#                        TYPESAFE_API_KEY is unset.
#
# ── SECRET HYGIENE ───────────────────────────────────────────────────────────
# Layers 1-2 never leave the machine. Layer 3 sends code excerpts to a hosted API, so excerpts are
# REDACTED first: assignment right-hand sides and long opaque tokens are masked. A security hook
# must not become the leak it is meant to catch.

INPUT=$(cat 2>/dev/null || echo "{}")
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")

# Hook cwd is the user's project (same convention as lib.sh's PROJECT_ROOT).
: "${PROJECT_ROOT:=$(pwd)}"

# No file path = skip
[ -z "$FILE_PATH" ] && exit 0
# File doesn't exist (deleted) = skip
[ ! -f "$FILE_PATH" ] && exit 0

# ── Skip: non-source files ───────────────────────────────────────
# ── Skip: non-source files ───────────────────────────────────────
# NOTE: .mjs/.mts/.cts are included — this plugin's own MCP server is ES-module .mjs, and the
# original allowlist silently skipped it, so the server code was never scanned.
case "$FILE_PATH" in
    *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs|*.py|*.rs|*.go|*.java|*.rb|*.php|*.c|*.cpp|*.cs)
        ;; # Source files — scan
    *)
        exit 0 ;; # Markdown, JSON, YAML, etc — skip
esac

# ── Skip: test files (reduce noise) ──────────────────────────────
case "$FILE_PATH" in
    *__tests__*|*.test.*|*.spec.*|*/test/*|*/tests/*|*/fixtures/*)
        exit 0 ;;
esac

# ── Check: is Semgrep installed? ─────────────────────────────────
if ! command -v semgrep &>/dev/null; then
    # Only show install hint once per session (use a temp marker)
    MARKER="/tmp/.forge-semgrep-hint-$$"
    if [ ! -f "$MARKER" ]; then
        echo -e "\033[0;34m[Info]\033[0m Install Semgrep for automatic SAST scanning: pip install semgrep"
        touch "$MARKER" 2>/dev/null
    fi
    exit 0
fi

# ── Layer 1: config resolution (local-first) ─────────────────────
# Resolution order (first hit wins):
#   1. FORGE_SEMGREP_CONFIG      — explicit override (CI, self-hosted ruleset)
#   2. .semgrep.yml in the root  — project-owned rules: local, versioned, reproducible, no network
#   3. auto                      — registry ruleset (needs network + valid token)
# Registry configs like p/default require authentication; where that is unavailable semgrep still
# exits 0 with an EMPTY result set, which is indistinguishable from "clean". Layer 1b below makes
# that case visible instead of silently implying the file was scanned.
SEMGREP_CONFIG="${FORGE_SEMGREP_CONFIG:-}"
if [ -z "$SEMGREP_CONFIG" ]; then
    if [ -f "$PROJECT_ROOT/.semgrep.yml" ]; then
        SEMGREP_CONFIG=".semgrep.yml"
    else
        SEMGREP_CONFIG="auto"
    fi
fi

RESULTS=$(semgrep scan --config "$SEMGREP_CONFIG" --quiet --json "$FILE_PATH" 2>/dev/null)

# ── Layers 1b + 2 in ONE jq pass (hot path) ─────────────────────
# The hook runs on every source Write/Edit, so the semgrep output is parsed exactly once here:
#   * scan-availability: errors with zero scanned paths => config could not load
#   * finding count
#   * deterministic ordering: severity (error>warning>info), then rule id, then line.
# A total order means identical findings render identically, run after run.
# Emits "errors<TAB>scanned<TAB>count" then the ordered findings as compact JSON.
read -r -d '' SCAN_JQ <<'JQEOF'
def sev: (.extra.severity // "warning") | ascii_downcase;
def sevrank: if sev == "error" or sev == "critical" or sev == "high" then 0
             elif sev == "warning" or sev == "medium" then 1 else 2 end;
. as $r
| ([$r.errors, $r.paths.scanned, $r.results] | map(length) | @tsv),
  ([($r.results // [])[]] | sort_by([sevrank, .check_id, (.start.line // 0), (.path // "")]) | tojson)
JQEOF

PARSED=$(printf '%s' "$RESULTS" | jq -r "$SCAN_JQ" 2>/dev/null)
COUNTS=$(printf '%s' "$PARSED" | head -1)
ORDERED=$(printf '%s' "$PARSED" | tail -n +2)

SCAN_ERRORS=$(printf '%s' "$COUNTS" | cut -f1)
SCANNED=$(printf '%s' "$COUNTS" | cut -f2)
FINDING_COUNT=$(printf '%s' "$COUNTS" | cut -f3)

# Scan-availability visibility: a config download/auth failure yields valid JSON with errors and
# zero scanned paths. Report it so "no findings" is never mistaken for "clean". Advisory, exit 0.
if [ "${SCAN_ERRORS:-0}" -gt 0 ] 2>/dev/null && [ "${SCANNED:-0}" -eq 0 ] 2>/dev/null; then
    echo -e "\033[0;33m[Semgrep]\033[0m scan unavailable for $(basename "$FILE_PATH") — config '$SEMGREP_CONFIG' could not be loaded (auth/offline). NOT a clean result."
    exit 0
fi

[ -z "$RESULTS" ] && exit 0
[ "${FINDING_COUNT:-0}" -gt 0 ] 2>/dev/null || exit 0
[ -n "$ORDERED" ] || exit 0

# ── Layer 3: optional JEV actionability triage (advisory) ────────
# Gate on TYPESAFE_API_KEY BEFORE building any state, so the no-key path does nothing extra.
# SCRIPT_DIR via parameter expansion — no fork, no `dirname` exec on the write hot path.
SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
# shellcheck source=lib-jev.sh
[ -f "$SCRIPT_DIR/lib-jev.sh" ] && source "$SCRIPT_DIR/lib-jev.sh"

if declare -f jev_available >/dev/null 2>&1 && jev_available; then
    JEV_HEADER=""
    # jq programs live in quoted heredocs: no shell interpolation, no nested-quote escaping.
    # Redaction runs first (SECRET HYGIENE): mask assignment right-hand sides (quoted OR bare) and
    # any long opaque token before the excerpt can leave the machine.
    # Verified by test: `const password = "hunter2hunter2hunter2"` → `const password = "[REDACTED]"`.
    read -r -d '' JEV_STATE_JQ <<'JQEOF'
def redact:
  # 1. secret-ish key followed by a value: quoted, single-quoted, or bare.
  gsub("(?<k>(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth|credential|private[_-]?key)[[:space:]]*(?:[:=]|=>)[[:space:]]+)(?:\"[^\"]{2,400}\"|'[^']{2,400}'|[^[:space:],;)]{4,})"; "\(.k)[REDACTED]")
  # 2. any long opaque run (tokens, keys, hashes, base64).
  | gsub("[A-Za-z0-9_+/=-]{20,}"; "[REDACTED]");
{
  file: $f,
  findings: [
    .[:10] | to_entries[] | {
      id: "f\(.key)",
      rule: .value.check_id,
      severity: (.value.extra.severity // "warning"),
      line: (.value.start.line // 0),
      message: ((.value.extra.message // "") | redact),
      excerpt: ((.value.extra.lines // "") | redact | .[0:400])
    }
  ]
}
JQEOF

    read -r -d '' JEV_QUESTIONS_JQ <<'JQEOF'
[.findings[].id]
| map({key: ., value: {
    type: "noul",
    text: "This static-analysis finding is a genuine, actionable security issue in this file: the flagged pattern is reachable with attacker-controlled data and is not already neutralised by surrounding validation, parameterisation, or framework defaults."
  }})
| from_entries
JQEOF

    read -r -d '' JEV_JOIN_JQ <<'JQEOF'
def prob($id): (($resp.answers // $resp.results // {})[$id]
                | (.noul // .probability // .probabilities.true // null));
[ to_entries[] | .value + { _id: ("f\(.key)") } ]
| map(. + { _p: prob(._id) })
| sort_by([ (if ._p == null then 1 else 0 end), (._p // 0) * -1, ._id ])
JQEOF

    JEV_STATE=$(echo "$ORDERED" | jq -c --arg f "$(basename "$FILE_PATH")" "$JEV_STATE_JQ" 2>/dev/null)
    JEV_QUESTIONS=$(echo "$JEV_STATE" | jq -c "$JEV_QUESTIONS_JQ" 2>/dev/null)

    if [ -n "$JEV_STATE" ] && [ -n "$JEV_QUESTIONS" ]; then
        JEV_RESPONSE=$(jev_decide "$JEV_STATE" "$JEV_QUESTIONS" "hooks/security-semgrep-scan" 2>/dev/null)
    fi

    if [ -n "$JEV_RESPONSE" ]; then
        # Join probabilities back onto findings and sort by actionability desc. ADVISORY:
        # every finding survives — nothing here may filter.
        JEV_ORDERED=$(echo "$ORDERED" \
            | jq -c --argjson resp "$JEV_RESPONSE" "$JEV_JOIN_JQ" 2>/dev/null)
        if [ -n "$JEV_ORDERED" ]; then
            ORDERED="$JEV_ORDERED"
            JEV_HEADER=$(printf '%s' "$JEV_RESPONSE" \
                | jq -r '"  \u001b[0;36m[jev]\u001b[0m actionability-ranked (advisory · model \(.model // "pinned") · findings never hidden)"' 2>/dev/null)
        fi
    fi
fi

# ── Report ─────────────────────────────────────────────────────
echo -e "\033[1;33m[Semgrep]\033[0m $FINDING_COUNT finding(s) in $(basename "$FILE_PATH"):"
[ -n "${JEV_HEADER:-}" ] && echo -e "$JEV_HEADER"

read -r -d '' JEV_RENDER_JQ <<'JQEOF'
# NOTE: `label` is a reserved word in jq — using it as a function name is a syntax error that
# silently produced zero output lines. Keep this named `fp_note`.
def fp_note($p):
  if ($p != null and $p < 0.4)
  then " \u001b[0;90m(likely FP · p=" + (($p * 100 | floor | tostring)) + "%)\u001b[0m"
  else "" end;
.[:5][]
| "  [\(.extra.severity // "warning" | ascii_upcase)] \(.check_id) (line \(.start.line))"
  + fp_note(._p // null)
JQEOF

echo "$ORDERED" | jq -r "$JEV_RENDER_JQ" 2>/dev/null

if [ "$FINDING_COUNT" -gt 5 ]; then
    echo "  ... and $((FINDING_COUNT - 5)) more. Run: semgrep scan --config ${SEMGREP_CONFIG} $FILE_PATH"
fi

# Always advisory — never block, never suppress.
exit 0