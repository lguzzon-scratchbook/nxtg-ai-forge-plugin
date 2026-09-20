/**
 * NXTG-Forge Governance MCP Server
 *
 * MCP server wiring only. All tool implementations live in tools.mjs.
 * Provides project governance tools for Claude Code via MCP protocol.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  getGovernanceState,
  getGitStatus,
  getCodeMetrics,
  getHealthScore,
  getTestResults,
  listCheckpoints,
  getSecurityScan,
  generateDashboard,
  findApplicationRoot,
  serverVersion,
} from "./tools.mjs";

import { decideJev, isJevAvailable, jevUnavailableReason, renderDecisionBlock } from "./jev.mjs";

// Re-export all tool functions so tests can destructure from index.mjs
export {
  getGovernanceState,
  getGitStatus,
  getCodeMetrics,
  getHealthScore,
  getTestResults,
  listCheckpoints,
  getSecurityScan,
  generateDashboard,
  findApplicationRoot,
  serverVersion,
} from "./tools.mjs";

// Re-export the JEV decision layer so agents/tests can reach it from the server entrypoint.
export { decideJev, isJevAvailable, jevUnavailableReason, renderDecisionBlock } from "./jev.mjs";

// ---------------------------------------------------------------------------
// Tool definitions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * MCP tool definitions for the forge-governance server.
 * Each entry describes one callable tool: its name, description, and JSON
 * Schema for its input parameters. Exported so test suites can assert on
 * the tool list without starting the server.
 *
 * @type {Array<{name: string, description: string, inputSchema: object}>}
 */
export const TOOLS = [
  {
    name: "forge_get_governance_health",
    description:
      "Get the project health score (0-100) with letter grade and detailed check results. Evaluates governance, git cleanliness, test coverage, documentation, type safety, file sizes, and security.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "forge_get_governance_state",
    description:
      "Read the project's governance.json — project name, vision, goals, workstreams, quality gates, and session metrics.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "forge_get_git_status",
    description:
      "Get git repository status: branch, commit count, last commit, modified/untracked/staged file counts, and top contributors.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "forge_get_code_metrics",
    description:
      "Get code metrics: source file count, test file count, test coverage percentage, total lines, largest files, and dependency counts.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "forge_run_tests",
    description:
      "Detect the test runner (vitest/jest/pytest) and run the test suite. Returns pass/fail counts and raw output. May take up to 60 seconds.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "forge_list_checkpoints",
    description:
      "List all saved governance checkpoints with names and creation dates.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "forge_security_scan",
    description:
      "Scan for security issues: hardcoded secrets, eval() usage, .env files in git, and npm audit vulnerabilities.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "forge_open_dashboard",
    description:
      "Generate a beautiful HTML governance dashboard and open it in the browser. Shows health score, metrics, git status, security findings, and checkpoints. Returns the file path.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "forge_jev_decide",
    description:
      "ADVISORY decision layer (JEV / TypeSafe System One). Runs one or more named, pinned, versioned questions against a supplied state and returns typed probabilistic answers (Noul probability, Choice selection, Score) plus the locally-applied decision rule and an audit-log path. REQUIRES the TYPESAFE_API_KEY environment variable: when it is unset this tool returns {available:false, reason} and the caller MUST keep its existing deterministic behavior. JEV output is advisory only — it never gates a blocking security guard and never contributes to the deterministic governance score. State must be pre-filtered: accuracy degrades with irrelevant context.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          description:
            "Decision state: a JSON object/array or a pre-rendered string. Filter it to only the evidence the questions need.",
        },
        questions: {
          type: "array",
          items: { type: "string" },
          description:
            "Named questions from jev/questions.v1.json (e.g. gv.verdict, gv.concern_type, gv.severity, gv.severity, semgrep.actionable, owasp.exploitable, crucible.pattern5_fake_integration). All are evaluated independently and in parallel within a single call.",
        },
        caller: {
          type: "string",
          description: "Who is asking (agent/skill/hook name) — recorded in the audit log.",
        },
      },
      required: ["state", "questions"],
    },
  },
];

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "forge-governance", version: serverVersion },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// ---------------------------------------------------------------------------
// Tool dispatch (exported for testing — called by the request handler)
// ---------------------------------------------------------------------------

/**
 * Dispatch a tool call by name and return its result.
 * Exported so test suites can invoke tools directly without going through
 * the MCP request handler.
 *
 * @param {string} name - The tool name (must match a name in TOOLS).
 * @param {object} [args] - Tool arguments (only forge_jev_decide takes any today).
 * @returns {Promise<object>} The tool's result object.
 * @throws {Error} If the tool name is not recognised, or its arguments are invalid.
 */
export async function dispatchToolCall(name, args = {}) {
  switch (name) {
    case "forge_get_governance_health":        return getHealthScore();
    case "forge_get_governance_state": return getGovernanceState();
    case "forge_get_git_status":    return getGitStatus();
    case "forge_get_code_metrics":  return getCodeMetrics();
    case "forge_run_tests":         return getTestResults();
    case "forge_list_checkpoints":  return listCheckpoints();
    case "forge_security_scan":     return getSecurityScan();
    case "forge_open_dashboard":    return await generateDashboard();
    case "forge_jev_decide":        return await dispatchJevDecide(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Validate and execute a forge_jev_decide call.
 *
 * Fails loudly on bad input (a mistyped question name must not silently no-op), but never fails on
 * a missing key or an unreachable API — those return `{available:false, reason}` so the caller can
 * keep its deterministic path.
 *
 * @param {object} args - { state, questions, caller }
 * @returns {Promise<object>} decideJev() envelope
 * @throws {Error} when state/questions are missing or malformed
 */
async function dispatchJevDecide(args = {}) {
  const { state, questions, caller = "mcp" } = args;

  if (state === undefined || state === null) {
    throw new Error("forge_jev_decide: `state` is required");
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("forge_jev_decide: `questions` must be a non-empty array of question names");
  }
  for (const q of questions) {
    if (typeof q !== "string" || q.trim() === "") {
      throw new Error("forge_jev_decide: every entry in `questions` must be a non-empty string");
    }
  }

  // Single availability check up front — the whole point of the TYPESAFE_API_KEY gate.
  if (!isJevAvailable()) {
    return { available: false, reason: jevUnavailableReason(), caller };
  }

  return await decideJev({ state, questionNames: questions, caller });
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await dispatchToolCall(name, args ?? {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const isUnknown = error.message.startsWith("Unknown tool:");
    return {
      content: [
        {
          type: "text",
          text: isUnknown
            ? error.message
            : `Error in ${name}: ${error.message}\n${error.stack}`,
        },
      ],
      isError: true,
    };
  }
});

// Start (FORGE_TEST_MODE guard enables vitest to import without blocking on stdio)
if (!process.env.FORGE_TEST_MODE) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
