// CollatrEdge — version command tests
// PRD refs: §18 Deployment & Distribution

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { versionCommand } from "../../../src/cli/commands/version";

describe("version command", () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stdoutOutput: string[];

  beforeEach(() => {
    stdoutOutput = [];
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        const str =
          typeof chunk === "string"
            ? chunk
            : new TextDecoder().decode(chunk);
        stdoutOutput.push(str);
        return true;
      },
    );
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  function stdout(): string {
    return stdoutOutput.join("");
  }

  // =========================================================================
  // Output format
  // =========================================================================

  it("returns exit code 0", () => {
    const code = versionCommand();
    expect(code).toBe(0);
  });

  it("outputs version from package.json", () => {
    versionCommand();
    expect(stdout()).toContain("CollatrEdge v0.1.0");
  });

  it("outputs Bun runtime version", () => {
    versionCommand();
    expect(stdout()).toContain(`Runtime: Bun ${Bun.version}`);
  });

  it("outputs platform and architecture", () => {
    versionCommand();
    expect(stdout()).toContain(
      `Platform: ${process.platform}-${process.arch}`,
    );
  });

  it("outputs build timestamp", () => {
    versionCommand();
    const output = stdout();
    expect(output).toContain("Build: ");
    // Build line should contain an ISO 8601 timestamp
    const buildLine = output.split("\n").find((l) => l.startsWith("Build: "));
    expect(buildLine).toBeDefined();
    const timestamp = buildLine!.replace("Build: ", "");
    // Verify it parses as a valid date
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
  });

  it("uses BUILD_TIME env var when set", () => {
    const original = Bun.env.BUILD_TIME;
    Bun.env.BUILD_TIME = "2026-01-15T12:00:00Z";

    versionCommand();
    expect(stdout()).toContain("Build: 2026-01-15T12:00:00Z");

    // Restore
    if (original !== undefined) {
      Bun.env.BUILD_TIME = original;
    } else {
      delete Bun.env.BUILD_TIME;
    }
  });

  it("outputs four lines (version, runtime, platform, build)", () => {
    versionCommand();
    const lines = stdout().trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^CollatrEdge v/);
    expect(lines[1]).toMatch(/^Runtime: /);
    expect(lines[2]).toMatch(/^Platform: /);
    expect(lines[3]).toMatch(/^Build: /);
  });
});
