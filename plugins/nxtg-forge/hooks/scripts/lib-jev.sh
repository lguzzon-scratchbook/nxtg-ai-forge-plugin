#!/bin/bash
#
# NXTG-Forge JEV advisory sidecar (bash)
#
# WHY THIS EXISTS
# ---------------
# PostToolUse hooks cannot call the MCP server (it is a separate stdio process), so hooks reach the
# JEV decision API directly over HTTPS. This file is the ONLY place in the hook layer that talks to
# the network, and it is gated on TYPESAFE_API_KEY.
#
# CONTRACT (every function here obeys it)
# --------------------------------------
# * No key  -> return non-zero immediately, print nothing. Caller takes its existing code path,
#              and its output stays byte-identical to the pre-JEV behavior.
# * Timeout -> curl --max-time bounds the call; non-zero return, no output.
# * Never throws, never blocks, never suppresses a finding. Hooks stay advisory (exit 0).
#
# Usage:
#   source "$(dirname "$0")/lib-jev.sh"
#   jev_available || exit 0            # gate BEFORE doing any work
#   RESULT=$(jev_decide "$STATE_JSON" "$QUESTIONS_JSON" "$CALLER") || exit 0

# Configuration — overridable for tests/self-hosted endpoints.
JEV_ENDPOINT="${JEV_ENDPOINT:-https://api.typesafe.ai/v1/systemone}"
JEV_MODEL="${JEV_MODEL:-jev-1.13.0}"
JEV_TIMEOUT="${JEV_TIMEOUT:-3}"
JEV_AUDIT_LOG="${JEV_AUDIT_LOG:-$PROJECT_ROOT/.claude/logs/jev-audit.jsonl}"

# Audit records carry the question-definition version so old decisions stay interpretable.
# Keep in sync with the `version` field in servers/governance-mcp/jev/questions.v1.json.
JEV_QUESTIONS_VERSION="${JEV_QUESTIONS_VERSION:-1.0.0}"

# Is the JEV advisory layer enabled? Single gate for the whole hook layer.
# Returns 0 (true) only when TYPESAFE_API_KEY is set and non-blank.
jev_available() {
    [ -n "${TYPESAFE_API_KEY:-}" ] || return 1
    command -v curl >/dev/null 2>&1 || return 1
    command -v jq >/dev/null 2>&1 || return 1
    return 0
}

# jev_decide <state_json> <questions_json_object> [caller]
#   state_json        — JSON value (object/array/string) for the decision state
#   questions_json    — JSON object of {"question_name": {"type": "...", ...}}
#   caller            — name recorded in the audit log
# Prints the raw response JSON on success; prints nothing and returns non-zero otherwise.
jev_decide() {
    local state="$1" questions="$2" caller="${3:-hook}"
    jev_available || return 1
    [ -n "$state" ] || return 1
    [ -n "$questions" ] || return 1

    local body
    body=$(jq -cn \
        --argjson state "$state" \
        --argjson questions "$questions" \
        --arg model "$JEV_MODEL" \
        '{model:$model, state:($state|tostring), questions:$questions}' 2>/dev/null) \
        || return 1

    local response
    response=$(curl -sS --max-time "$JEV_TIMEOUT" \
        -H "content-type: application/json" \
        -H "authorization: Bearer $TYPESAFE_API_KEY" \
        -X POST "$JEV_ENDPOINT" -d "$body" 2>/dev/null) || return 1
    [ -n "$response" ] || return 1

    # Non-object response (error payload) — bail, caller keeps its default path.
    printf '%s' "$response" | jq -e 'type == "object"' >/dev/null 2>&1 || return 1

    [ "${FORGE_JEV_DEBUG:-0}" = "1" ] && printf '[jev] raw: %s\n' "${response:0:2000}" >&2

    jev_audit "$response" "$caller"
    printf '%s' "$response"
    return 0
}

# jev_audit <response_json> <caller>
# Appends one decision record to the audit log. Best-effort: failures are swallowed so an
# unwritable log never breaks a hook.
jev_audit() {
    local response="$1" caller="$2"
    local dir; dir=$(dirname "$JEV_AUDIT_LOG")
    mkdir -p "$dir" 2>/dev/null || return 0
    local line
    line=$(printf '%s' "$response" | jq -cn \
        --arg caller "$caller" --arg model "$JEV_MODEL" --arg ver "$JEV_QUESTIONS_VERSION" \
        --argjson resp "$response" \
        '{ts:(now|todateiso8601), caller:$caller, model:($resp.model // $model),
          questions_version:$ver,
          decisions: (($resp.answers // $resp.results // {}) | to_entries | map({
            question:.key,
            probability:(.value.noul // .value.probability // .value.probabilities.true // null),
            confidence:(.value.confidence // null),
            value:(.value.choice // .value.score // .value.value // null)
          }))}' 2>/dev/null) || return 0
    [ -n "$line" ] && printf '%s\n' "$line" >> "$JEV_AUDIT_LOG" 2>/dev/null
    return 0
}
