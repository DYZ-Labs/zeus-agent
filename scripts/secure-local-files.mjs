#!/usr/bin/env node

import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const credentialName = /(?:^|[._-])(?:credentials?|secrets?|tokens?)(?:[._-]|$)/iu;
const skippedDirectories = new Set([".git", ".models", ".next", "node_modules", "out"]);

function isPrivateLocalFile(name) {
  if (name === ".env.example") return false;
  return name === ".env" || name.startsWith(".env.") || name === ".mcp.json" ||
    name === ".npmrc" || credentialName.test(name) || /\.(?:key|p12|pem|pfx)$/iu.test(name);
}

function secureTree(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to follow symbolic link in private local data: ${path}`);
  }
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    let count = 1;
    for (const name of readdirSync(path)) count += secureTree(join(path, name));
    return count;
  }
  if (stat.isFile()) {
    chmodSync(path, 0o600);
    return 1;
  }
  throw new Error(`Private local data must be a regular file or directory: ${path}`);
}

let secured = 0;
function secureCredentials(directory) {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const repositoryRootEntry = directory === root;
    if (entry.isSymbolicLink()) {
      if (
        isPrivateLocalFile(entry.name) ||
        (repositoryRootEntry && /^zeus-export(?:-|$)/u.test(entry.name))
      ) {
        throw new Error(`Private local path must not be a symbolic link: ${path}`);
      }
      continue;
    }
    if (entry.isFile() && isPrivateLocalFile(entry.name)) count += secureTree(path);
    else if (
      entry.isDirectory() && repositoryRootEntry && /^zeus-export(?:-|$)/u.test(entry.name)
    ) {
      count += secureTree(path);
    } else if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
      count += secureCredentials(path);
    }
  }
  return count;
}
secured = secureCredentials(root);

console.log(`zeus: enforced owner-only access on ${secured} private local path${secured === 1 ? "" : "s"}`);
