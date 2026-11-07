/**
 * End-to-end coverage for `copperhead create`.
 *
 * Drives the full 8-stage pipeline (spec-seed → architecture → part-selection →
 * schematic → layout-draft → outputs → firmware → dev-plan) from a natural
 * language brief to a committed final stage, asserting that every stage
 * commits cleanly and that the resulting workspace is coherent.
 *
 * Requires a KiCad + `kicad-cli` environment. Skipped automatically when the
 * toolchain is unavailable so unit-only CI stays green.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");

const STAGES = [
  "spec-seed",
  "architecture",
  "part-selection",
  "schematic",
  "layout-draft",
  "outputs",
  "firmware",
  "dev-plan",
] as const;

const BRIEF =
  "A small USB-C powered ESP32-S3 dev board with a 3.3V LDO, " +
  "a reset button, a boot button, and a QWIIC I2C connector.";

function hasKicad(): boolean {
  const probe = spawnSync("kicad-cli", ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

function runCreate(args: string[], cwd: string): { stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, "create", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, COPPERHEAD_NONINTERACTIVE: "1" },
    timeout: 15 * 60 * 1000,
  });
  if (res.status !== 0) {
    throw new Error(
      `copperhead create ${args.join(" ")} failed (${res.status})\n` +
        `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe.skipIf(!hasKicad())("copperhead create — end-to-end", () => {
  let workdir: string;

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), "copperhead-e2e-"));
    git(workdir, "init", "-q");
    git(workdir, "config", "user.email", "e2e@copperhead.test");
    git(workdir, "config", "user.name", "Copperhead E2E");
    git(workdir, "commit", "--allow-empty", "-q", "-m", "init");
  });

  afterAll(() => {
    if (workdir && existsSync(workdir)) {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("runs the full 8-stage pipeline from a brief to a committed final stage", () => {
    // Stage 1: seed the project from the brief.
    runCreate(["init", "--brief", BRIEF], workdir);

    // Stages 2..8: advance one stage at a time, asserting each commits.
    for (const stage of STAGES.slice(1)) {
      const before = git(workdir, "rev-parse", "HEAD");
      const { stdout } = runCreate(["advance", "--stage", stage], workdir);
      const after = git(workdir, "rev-parse", "HEAD");

      expect(after, `stage ${stage} did not produce a commit`).not.toBe(before);
      expect(stdout).toContain(stage);

      // Every stage commit must be a clean, self-contained commit.
      const status = git(workdir, "status", "--porcelain");
      expect(status, `stage ${stage} left a dirty tree`).toBe("");
    }

    // Final stage must be recorded as the current stage.
    const state = JSON.parse(
      readFileSync(join(workdir, ".copperhead", "state.json"), "utf8"),
    );
    expect(state.stage).toBe("dev-plan");

    // The full history must contain one commit per stage.
    const log = git(workdir, "log", "--format=%s");
    for (const stage of STAGES) {
      expect(log).toContain(stage);
    }
  }, 20 * 60 * 1000);

  it("produces a clean ERC on the generated schematic", () => {
    const schematic = join(workdir, "hardware", "board.kicad_sch");
    expect(existsSync(schematic)).toBe(true);

    const erc = spawnSync(
      "kicad-cli",
      ["sch", "erc", "--exit-code-violations", schematic],
      { encoding: "utf8" },
    );
    // A false-green ERC on an empty schematic is a known regression class;
    // assert both a zero exit and non-empty report content.
    expect(erc.status, `ERC failed:\n${erc.stdout}\n${erc.stderr}`).toBe(0);
    expect((erc.stdout ?? "").trim().length).toBeGreaterThan(0);
  }, 5 * 60 * 1000);

  it("does not leak unbounded temp or .history growth", () => {
    const history = join(workdir, ".history");
    if (existsSync(history)) {
      const entries = execFileSync("find", [history, "-type", "f"], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);
      // Guard against the unbounded-growth regression.
      expect(entries.length).toBeLessThan(500);
    }
  });
});
