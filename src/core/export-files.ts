import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const EXPORT_MARKER = ".zeus-export.json";
const EXPORT_FORMAT = "zeus-memory-export";
const EXPORT_VERSION = 1;

type ExportMarker = {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  files: string[];
};

export type ExportWorkspace = {
  /** Private staging directory. Write the export here, then call `finish()`. */
  path: string;
  /** User-requested final destination. */
  destination: string;
  finish(): void;
  cleanup(): void;
};

/**
 * Create a private staging directory for an export and validate the eventual target.
 *
 * Existing non-empty directories are replaced only when they carry a valid Zeus
 * marker and contain exactly the files named by that marker. This lets a second
 * export remove stale source text without ever recursively clearing an arbitrary
 * user directory.
 */
export function prepareExportWorkspace(
  requestedPath: string,
  options: { repoRoot?: string; sourceDbPath?: string } = {},
): ExportWorkspace {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const destination = resolveExportDestination(requestedPath, repoRoot);
  const canonicalDestination = canonicalizeWithMissingLeaf(destination);
  const sourceDbPath = options.sourceDbPath;
  if (sourceDbPath && sourceDbPath !== ":memory:") {
    const resolvedDb = resolve(sourceDbPath);
    if (canonicalDestination === resolvedDb || canonicalDestination === dirname(resolvedDb)) {
      throw new Error("Refusing to export over the Zeus database or its data directory");
    }
  }

  assertNoSymlinkComponents(destination);
  const existing = inspectExistingDestination(destination);
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(parent);

  const staging = mkdtempSync(join(parent, `.${basename(destination)}.tmp-`));
  chmodSync(staging, 0o700);
  let finished = false;

  function cleanup(): void {
    if (finished || !existsSync(staging)) return;
    rmSync(staging, { recursive: true, force: true });
  }

  function finish(): void {
    if (finished) throw new Error("Export workspace was already finalized");
    const files = secureAndListExportTree(staging);
    writePrivateFile(
      join(staging, EXPORT_MARKER),
      `${JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, files }, null, 2)}\n`,
    );

    if (existing.kind === "empty") {
      rmdirSync(destination);
    } else if (existing.kind === "managed") {
      // Revalidate immediately before the destructive rename. A concurrent or manual
      // change turns replacement into a refusal instead of deleting an unknown file.
      const marker = validateManagedDestination(destination);
      try {
        removeManagedDestination(destination, marker);
      } catch (error) {
        throw new Error(
          "Could not clean the previous managed Zeus export. Fix its permissions and rerun the same export; the marker makes cleanup safely retryable.",
          { cause: error },
        );
      }
    }

    renameSync(staging, destination);
    finished = true;
    chmodSync(destination, 0o700);
  }

  return { path: staging, destination, finish, cleanup };
}

export function writePrivateFile(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function resolveExportDestination(requestedPath: string, repoRoot: string): string {
  if (!requestedPath.trim() || requestedPath.includes("\0")) {
    throw new Error("Export destination must be a non-empty filesystem path");
  }
  if (requestedPath.split(/[\\/]/u).includes("..")) {
    throw new Error("Export destination must not contain parent-directory traversal");
  }

  const destination = resolve(requestedPath);
  const root = parse(destination).root;
  if (destination === root || destination === homedir() || destination === repoRoot) {
    throw new Error("Refusing to use a broad or sensitive directory as an export target");
  }

  const withinRepo = relative(repoRoot, destination);
  if (withinRepo && !withinRepo.startsWith(`..${sep}`) && withinRepo !== ".." && !isAbsolute(withinRepo)) {
    const parts = withinRepo.split(sep);
    const allowed = parts.length === 1 && /^zeus-export(?:-[a-z0-9._-]+)?$/iu.test(parts[0]!);
    if (!allowed) {
      throw new Error(
        "Repository-local exports must use ./zeus-export or ./zeus-export-<name>",
      );
    }
  }
  return destination;
}

function inspectExistingDestination(
  destination: string,
): { kind: "absent" | "empty" | "managed" } {
  if (!existsSync(destination)) return { kind: "absent" };
  const stat = lstatSync(destination);
  if (stat.isSymbolicLink()) throw new Error("Export destination must not be a symbolic link");
  if (!stat.isDirectory()) throw new Error("Export destination already exists and is not a directory");
  if (readdirSync(destination).length === 0) return { kind: "empty" };
  validateManagedDestination(destination);
  return { kind: "managed" };
}

function validateManagedDestination(destination: string): ExportMarker {
  assertNoSymlinkComponents(destination);
  const markerPath = join(destination, EXPORT_MARKER);
  if (!existsSync(markerPath) || lstatSync(markerPath).isSymbolicLink()) {
    throw new Error(
      "Refusing to overwrite a non-empty directory that is not a managed Zeus export",
    );
  }

  let marker: ExportMarker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8")) as ExportMarker;
  } catch {
    throw new Error("Refusing to overwrite an export with an invalid management marker");
  }
  if (
    marker.format !== EXPORT_FORMAT || marker.version !== EXPORT_VERSION ||
    !Array.isArray(marker.files) || marker.files.some((file) => !isSafeRelativeFile(file))
  ) {
    throw new Error("Refusing to overwrite an export with an invalid management marker");
  }

  const expectedFiles = new Set([...marker.files, EXPORT_MARKER]);
  const expectedDirectories = new Set<string>();
  for (const file of marker.files) {
    let parent = dirname(file);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = dirname(parent);
    }
  }
  const actual = listTree(destination);
  for (const entry of actual) {
    if (entry.symbolicLink) {
      throw new Error("Refusing to replace a managed export containing a symbolic link");
    }
    const expected = entry.directory
      ? expectedDirectories.has(entry.path)
      : expectedFiles.has(entry.path);
    if (!expected) {
      throw new Error(
        `Refusing to replace a managed export containing an unrecognized entry: ${entry.path}`,
      );
    }
  }
  return marker;
}

/**
 * Remove only entries named by a validated marker. Missing recorded files are
 * tolerated so a retry can finish cleanup after interruption; unknown entries and
 * symlinks are rejected by `validateManagedDestination`. The marker is removed last,
 * leaving an interrupted cleanup recognizable and safely retryable.
 */
function removeManagedDestination(destination: string, marker: ExportMarker): void {
  const directories = new Set<string>();
  const files = [...marker.files].sort((left, right) => right.length - left.length);
  for (const file of files) {
    const absolute = join(destination, file);
    if (existsSync(absolute)) rmSync(absolute, { force: false });
    let parent = dirname(file);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    const absolute = join(destination, directory);
    if (existsSync(absolute)) rmdirSync(absolute);
  }
  rmSync(join(destination, EXPORT_MARKER), { force: false });
  rmdirSync(destination);
}

function secureAndListExportTree(root: string): string[] {
  const files: string[] = [];
  for (const entry of listTree(root)) {
    if (entry.symbolicLink) throw new Error("Export staging tree contains a symbolic link");
    const absolute = join(root, entry.path);
    if (entry.directory) chmodSync(absolute, 0o700);
    else {
      chmodSync(absolute, 0o600);
      files.push(entry.path);
    }
  }
  return files.sort();
}

function listTree(root: string): Array<{
  path: string;
  directory: boolean;
  symbolicLink: boolean;
}> {
  const entries: Array<{ path: string; directory: boolean; symbolicLink: boolean }> = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const path = relative(root, absolute);
      const stat = lstatSync(absolute);
      const symbolicLink = stat.isSymbolicLink();
      const isDirectory = stat.isDirectory() && !symbolicLink;
      entries.push({ path, directory: isDirectory, symbolicLink });
      if (isDirectory) visit(absolute);
    }
  };
  visit(root);
  return entries;
}

function assertNoSymlinkComponents(path: string): void {
  const canonical = canonicalizeWithMissingLeaf(path);
  if (canonical !== resolve(path)) {
    throw new Error(`Export path must not traverse a symbolic link: ${path}`);
  }
}

function canonicalizeWithMissingLeaf(path: string): string {
  let cursor = resolve(path);
  const components: string[] = [];
  while (!existsSync(cursor)) {
    components.push(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  let canonical = realpathSync(cursor);
  for (const component of components.reverse()) canonical = join(canonical, component);
  return canonical;
}

function isSafeRelativeFile(path: string): boolean {
  return Boolean(path) && !isAbsolute(path) && !path.split(/[\\/]/u).includes("..") &&
    path !== EXPORT_MARKER;
}
