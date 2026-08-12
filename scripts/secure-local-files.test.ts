import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("private local file preflight", () => {
  it("enforces owner-only modes without reading or rewriting private contents", () => {
    const root = temporaryRoot();
    const nested = join(root, "config");
    const exportDirectory = join(root, "zeus-export-private");
    mkdirSync(nested);
    mkdirSync(exportDirectory);
    const privateFiles = [
      join(root, ".env.local"),
      join(root, ".mcp.json"),
      join(root, ".npmrc"),
      join(nested, "service-credentials.json"),
      join(nested, "private.key"),
      join(exportDirectory, "memory.md"),
    ];
    for (const path of privateFiles) {
      writeFileSync(path, "private sentinel", { mode: 0o666 });
      chmodSync(path, 0o666);
    }
    const example = join(root, ".env.example");
    writeFileSync(example, "PLACEHOLDER=", { mode: 0o644 });
    chmodSync(exportDirectory, 0o777);

    runPreflight(root);

    for (const path of privateFiles) expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(exportDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(example).mode & 0o777).toBe(0o644);
  });

  it("refuses a private symlink instead of changing its target", () => {
    const root = temporaryRoot();
    const target = join(root, "target.txt");
    writeFileSync(target, "target", { mode: 0o644 });
    symlinkSync(target, join(root, ".env.local"));

    expect(() => runPreflight(root)).toThrow();
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zeus-private-files-"));
  roots.push(root);
  return root;
}

function runPreflight(root: string): void {
  execFileSync(process.execPath, ["scripts/secure-local-files.mjs", root], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
}
