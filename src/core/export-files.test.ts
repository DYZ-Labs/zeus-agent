import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prepareExportWorkspace, writePrivateFile } from "./export-files";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "zeus-export-files-"));
  temporaryRoots.push(root);
  return root;
}

describe("managed private exports", () => {
  it("writes owner-only trees and replaces every file from the prior managed export", () => {
    const root = temporaryRoot();
    const destination = join(root, "private-export");
    const first = prepareExportWorkspace(destination, { repoRoot: join(root, "repo") });
    mkdirSync(join(first.path, "entities"), { mode: 0o777 });
    writePrivateFile(join(first.path, "entities", "erased.md"), "deleted sentinel");
    writePrivateFile(join(first.path, "README.md"), "first");
    first.finish();

    const second = prepareExportWorkspace(destination, { repoRoot: join(root, "repo") });
    writePrivateFile(join(second.path, "README.md"), "second");
    second.finish();

    expect(readFileSync(join(destination, "README.md"), "utf8")).toBe("second");
    expect(() => readFileSync(join(destination, "entities", "erased.md"), "utf8")).toThrow();
    expect(lstatSync(destination).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(destination, "README.md")).mode & 0o777).toBe(0o600);
  });

  it("refuses a non-export directory without modifying it", () => {
    const root = temporaryRoot();
    const destination = join(root, "ordinary-directory");
    mkdirSync(destination);
    const sentinel = join(destination, "keep.txt");
    writeFileSync(sentinel, "do not remove");

    expect(() => prepareExportWorkspace(destination, { repoRoot: join(root, "repo") })).toThrow(
      /not a managed Zeus export/u,
    );
    expect(readFileSync(sentinel, "utf8")).toBe("do not remove");
  });

  it("rejects traversal and symbolic-link destinations", () => {
    const root = temporaryRoot();
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "linked");
    symlinkSync(real, link);

    expect(() => prepareExportWorkspace(join(link, "output"), {
      repoRoot: join(root, "repo"),
    })).toThrow(
      /symbolic link/u,
    );
    expect(() => prepareExportWorkspace(`${root}/child/../output`, {
      repoRoot: join(root, "repo"),
    })).toThrow(/traversal/u);
  });

  it("limits repository-local destinations to ignored export names", () => {
    const root = temporaryRoot();
    const repo = join(root, "repo");
    mkdirSync(repo);

    expect(() => prepareExportWorkspace(join(repo, "personal-data"), { repoRoot: repo }))
      .toThrow(/Repository-local exports/u);
    const allowed = prepareExportWorkspace(join(repo, "zeus-export-private"), {
      repoRoot: repo,
    });
    allowed.cleanup();
  });
});
