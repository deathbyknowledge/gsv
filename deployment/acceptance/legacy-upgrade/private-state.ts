import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function assertPrivateDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error("Credential state requires an owned private directory");
  }
}

/** Open without following a symlink and verify permissions on the opened file. */
export function readPrivateState(filename: string): string {
  assertPrivateDirectory(dirname(filename));
  const file = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("Credential state file is not owned and private");
    return readFileSync(file, "utf8");
  } finally { closeSync(file); }
}

/** Preserve the previous complete credential record until its replacement is durable. */
export function writePrivateState(filename: string, contents: string): void {
  const directory = dirname(filename);
  assertPrivateDirectory(directory);
  if (lstatSync(filename, { throwIfNoEntry: false })) readPrivateState(filename);
  const temporary = join(directory, `.${basename(filename)}.${randomUUID()}.tmp`);
  const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(file, contents); fsyncSync(file); }
    finally { closeSync(file); }
    renameSync(temporary, filename);
    const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { rmSync(temporary, { force: true }); }
}
