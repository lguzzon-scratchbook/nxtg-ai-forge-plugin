/**
 * Tests for index.mjs — MCP server wiring layer.
 *
 * Covers: TOOLS definitions, re-exports, and dispatchToolCall dispatch logic.
 * FORGE_TEST_MODE=1 is set in vitest.config.mjs so server.connect() is skipped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupFixture, teardownFixture } from './setup.mjs';

import {
  TOOLS,
  dispatchToolCall,
  // Re-exports from tools.mjs
  getGovernanceState,
  getGitStatus,
  getCodeMetrics,
  getHealthScore,
  getTestResults,
  listCheckpoints,
  getSecurityScan,
  generateDashboard,
  findApplicationRoot,
} from '../index.mjs';

beforeAll(setupFixture);
afterAll(teardownFixture);

// ---------------------------------------------------------------------------
// TOOLS definitions
// ---------------------------------------------------------------------------

describe('TOOLS definitions', () => {
  it('exports exactly 9 tools', () => {
    expect(TOOLS).toHaveLength(9);
  });

  it('all tool names use forge_ prefix', () => {
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^forge_/);
    }
  });

  it('all tools have a non-empty description', () => {
    for (const tool of TOOLS) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('the 8 read-only governance tools take no arguments', () => {
    // forge_jev_decide is the single tool that accepts input — it needs state + questions.
    const noArg = TOOLS.filter((t) => t.name !== 'forge_jev_decide');
    expect(noArg).toHaveLength(8);
    for (const tool of noArg) {
      expect(tool.inputSchema).toEqual({ type: 'object', properties: {}, required: [] });
    }
  });

  it('forge_jev_decide declares state + questions as required', () => {
    const jev = TOOLS.find((t) => t.name === 'forge_jev_decide');
    expect(jev).toBeDefined();
    expect(jev.inputSchema.required).toEqual(['state', 'questions']);
    expect(Object.keys(jev.inputSchema.properties)).toContain('caller');
    expect(jev.inputSchema.properties.questions.type).toBe('array');
  });

  it('contains all expected tool names', () => {
    const names = TOOLS.map((t) => t.name);
    const expected = [
      'forge_get_governance_health',
      'forge_get_governance_state',
      'forge_get_git_status',
      'forge_get_code_metrics',
      'forge_run_tests',
      'forge_list_checkpoints',
      'forge_security_scan',
      'forge_open_dashboard',
      'forge_jev_decide',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// Re-exports from tools.mjs
// ---------------------------------------------------------------------------

describe('re-exports', () => {
  it('all 9 tool functions are exported from index.mjs', () => {
    expect(typeof getGovernanceState).toBe('function');
    expect(typeof getGitStatus).toBe('function');
    expect(typeof getCodeMetrics).toBe('function');
    expect(typeof getHealthScore).toBe('function');
    expect(typeof getTestResults).toBe('function');
    expect(typeof listCheckpoints).toBe('function');
    expect(typeof getSecurityScan).toBe('function');
    expect(typeof generateDashboard).toBe('function');
    expect(typeof findApplicationRoot).toBe('function');
  });

  it('re-exported functions are identical to those in tools.mjs', async () => {
    const tools = await import('../tools.mjs');
    expect(getGovernanceState).toBe(tools.getGovernanceState);
    expect(getGitStatus).toBe(tools.getGitStatus);
    expect(getHealthScore).toBe(tools.getHealthScore);
    expect(findApplicationRoot).toBe(tools.findApplicationRoot);
  });
});

// ---------------------------------------------------------------------------
// dispatchToolCall
// ---------------------------------------------------------------------------

describe('dispatchToolCall', () => {
  it('throws for unknown tool name', async () => {
    await expect(dispatchToolCall('unknown_tool')).rejects.toThrow('Unknown tool: unknown_tool');
  });

  it('throws for empty string tool name', async () => {
    await expect(dispatchToolCall('')).rejects.toThrow('Unknown tool:');
  });

  it('throws for tool names that almost match', async () => {
    await expect(dispatchToolCall('forge_get_health_score')).rejects.toThrow('Unknown tool:');
    await expect(dispatchToolCall('FORGE_GET_HEALTH')).rejects.toThrow('Unknown tool:');
  });

  it('dispatches forge_get_governance_health and returns valid health object', async () => {
    const result = await dispatchToolCall('forge_get_governance_health');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(['A', 'B', 'C', 'D', 'F']).toContain(result.grade);
    expect(result.maxScore).toBe(100);
    expect(Array.isArray(result.checks)).toBe(true);
  });

  it('dispatches forge_get_git_status and returns git info', async () => {
    const result = await dispatchToolCall('forge_get_git_status');
    // Running in the forge-plugin repo directory — should have a valid branch
    expect(result.branch).toMatch(/\S+/);
    expect(typeof result.commitCount).toBe('number');
    expect(Array.isArray(result.contributors)).toBe(true);
  });

  it('dispatches forge_list_checkpoints and returns checkpoints array', async () => {
    const result = await dispatchToolCall('forge_list_checkpoints');
    expect(Array.isArray(result.checkpoints)).toBe(true);
  });

  it('dispatches forge_get_governance_state and returns initialized field', async () => {
    const result = await dispatchToolCall('forge_get_governance_state');
    expect(typeof result.initialized).toBe('boolean');
  });

  it('dispatches forge_get_code_metrics and returns structured metrics', async () => {
    const result = await dispatchToolCall('forge_get_code_metrics');
    expect(typeof result.projectType).toBe('string');
    expect(typeof result.sourceFiles).toBe('number');
    expect(typeof result.testFiles).toBe('number');
  });

  it('dispatches forge_security_scan and returns findings array', async () => {
    const result = await dispatchToolCall('forge_security_scan');
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.totalFindings).toBe(result.findings.length);
  });

  it('dispatches forge_open_dashboard and returns path, browserUrl, and projectName', async () => {
    const result = await dispatchToolCall('forge_open_dashboard');
    expect(result.path).toMatch(/\.html$/);
    expect(result.browserUrl).toMatch(/^file:\/\//);
    expect(typeof result.projectName).toBe('string');
  });

  // -------------------------------------------------------------------------
  // forge_jev_decide — the TYPESAFE_API_KEY gate is the contract under test
  // -------------------------------------------------------------------------

  it('forge_jev_decide is unavailable without TYPESAFE_API_KEY and says why', async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const result = await dispatchToolCall('forge_jev_decide', {
        state: { evidence: 'x' },
        questions: ['gv.verdict'],
      });
      expect(result.available).toBe(false);
      expect(result.reason).toContain('TYPESAFE_API_KEY');
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });

  it('forge_jev_decide rejects missing state, empty questions and non-string question names', async () => {
    await expect(dispatchToolCall('forge_jev_decide', { questions: ['gv.verdict'] }))
      .rejects.toThrow(/`state` is required/);
    await expect(dispatchToolCall('forge_jev_decide', { state: {}, questions: [] }))
      .rejects.toThrow(/non-empty array/);
    await expect(dispatchToolCall('forge_jev_decide', { state: {}, questions: [42] }))
      .rejects.toThrow(/non-empty string/);
  });

  it('forge_jev_decide rejects an unknown question name even with a key set (fail loudly)', async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'test-key';
    try {
      await expect(dispatchToolCall('forge_jev_decide', {
        state: { a: 1 }, questions: ['not.a.question'],
      })).resolves.toMatchObject({ available: false });
    } finally {
      if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = saved;
    }
  });

  // Note: forge_run_tests dispatch is NOT tested here because calling
  // getTestResults() during a vitest run triggers a recursive vitest process
  // that deadlocks. It is covered in tests/test-runner.test.mjs instead.
});
