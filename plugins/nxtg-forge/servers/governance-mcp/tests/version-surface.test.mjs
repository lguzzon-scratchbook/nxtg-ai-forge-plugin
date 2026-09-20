// Version-surface contract (DIRECTIVE-NXTG-20260718-10 item 3). All version surfaces + the MCP
// handshake must agree (the drift class fixed in v3.10.2 G-10). Uses the same checkVersionsAgree()
// the L1 harness uses; includes a seeded-mismatch negative control.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serverVersion } from "../index.mjs";
import { checkVersionsAgree } from "./lib/checks.mjs";

const REPO = join(import.meta.dirname, "../../../../../"); // -> forge-plugin/
const rd = (p) => JSON.parse(readFileSync(p, "utf8"));

describe("version-surface agreement", () => {
  it("all 4 version surfaces + lockfile + MCP handshake agree", () => {
    const surfaces = {
      "root .claude-plugin/plugin.json": rd(join(REPO, ".claude-plugin/plugin.json")).version,
      "plugin manifest": rd(join(REPO, "plugins/nxtg-forge/.claude-plugin/plugin.json")).version,
      "marketplace.json": rd(join(REPO, ".claude-plugin/marketplace.json")).plugins[0].version,
      "governance-mcp/package.json": rd(join(import.meta.dirname, "../package.json")).version,
      "package-lock.json": rd(join(import.meta.dirname, "../package-lock.json")).version,
      "mcp handshake (serverVersion)": serverVersion,
    };
    const r = checkVersionsAgree(surfaces);
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("negative control: checkVersionsAgree fails on a seeded mismatch", () => {
    const r = checkVersionsAgree({ a: "3.10.3", b: "3.10.3", c: "3.10.2" });
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes("c=3.10.2"))).toBe(true);
  });

  // The bash JEV sidecar stamps its own copy of the question-definition version into every audit
  // record. If the two drift, an audit line silently mislabels which rubric produced it — the
  // exact failure the version surfaces exist to prevent, in a second language.
  it("lib-jev.sh JEV_QUESTIONS_VERSION matches questions.v1.json", () => {
    const bashVer = readFileSync(
      join(REPO, "plugins/nxtg-forge/hooks/scripts/lib-jev.sh"), "utf8"
    ).match(/^JEV_QUESTIONS_VERSION="\$\{JEV_QUESTIONS_VERSION:-([^}]+)\}"/m)?.[1];
    const jsonVer = rd(join(import.meta.dirname, "../jev/questions.v1.json")).version;
    expect(bashVer, "JEV_QUESTIONS_VERSION not found in lib-jev.sh").toBeDefined();
    expect(bashVer).toBe(jsonVer);
  });

  it("the pinned JEV model is an exact version, never an alias", () => {
    const model = rd(join(import.meta.dirname, "../jev/questions.v1.json")).model;
    expect(model).not.toMatch(/latest|preview|stable|\*/i);
    expect(model).toMatch(/^jev-\d+\.\d+\.\d+$/);
  });
});
