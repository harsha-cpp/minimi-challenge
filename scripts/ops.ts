import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, chmodSync, copyFileSync, linkSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { MemoryStore } from "../src/memory/store.ts";

type Integrity = ReturnType<MemoryStore["integrityCheck"]>;
export interface SnapshotReport { path: string; sha256: string; bytes: number; createdAt: string; integrity: Integrity; interruptedTurns?: number; }
function existingFile(path: string): string {
  const result = resolve(path);
  if (!existsSync(result) || !statSync(result).isFile()) throw new Error("Database does not exist or is not a regular file.");
  return result;
}
function destinationPath(path: string, source: string): string {
  const result = resolve(path);
  if (result === source) throw new Error("Source and destination must be different files.");
  if ([result, `${result}-wal`, `${result}-shm`].some(existsSync)) throw new Error("Destination already exists; restore into a clean path.");
  mkdirSync(dirname(result), { recursive: true, mode: 0o700 });
  return result;
}
async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function cleanup(path: string): void { for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true }); }
function checked(store: MemoryStore): Integrity {
  const result = store.integrityCheck();
  if (!result.ok) throw new Error(`Database integrity validation failed: ${result.issues.join("; ")}`);
  return result;
}
function publish(temporary: string, destination: string): void {
  chmodSync(temporary, 0o600);
  // A same-directory hard link is an atomic, exclusive publication; rename would overwrite.
  try { linkSync(temporary, destination); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new Error("Destination already exists."); throw error; }
}
/** SQLite's backup API includes committed WAL pages while the service is running. */
export async function backupDatabase(sourcePath: string, targetPath: string): Promise<SnapshotReport> {
  const source = existingFile(sourcePath), target = destinationPath(targetPath, source), temporary = `${target}.${randomUUID()}.tmp`;
  const validation = `${temporary}.validation`;
  let sourceDb: DatabaseSync | undefined, snapshot: MemoryStore | undefined;
  try {
    // A pre-upgrade backup must retain the source schema. MemoryStore construction migrates it.
    sourceDb = new DatabaseSync(source, { readOnly: true });
    await sqliteBackup(sourceDb, temporary);
    copyFileSync(temporary, validation);
    snapshot = new MemoryStore(validation);
    const integrity = checked(snapshot);
    snapshot.close(); snapshot = undefined;
    const report: SnapshotReport = { path: target, sha256: await sha256(temporary), bytes: statSync(temporary).size, createdAt: new Date().toISOString(), integrity };
    publish(temporary, target);
    return report;
  } finally { snapshot?.close(); sourceDb?.close(); cleanup(validation); cleanup(temporary); }
}
/** Restore migrates and validates a private copy; the original backup is never opened writable. */
export async function restoreDatabase(snapshotPath: string, targetPath: string, expectedHash?: string): Promise<SnapshotReport> {
  const source = existingFile(snapshotPath), target = destinationPath(targetPath, source), temporary = `${target}.${randomUUID()}.tmp`;
  if (existsSync(`${source}-wal`) && statSync(`${source}-wal`).size > 0) throw new Error("Restore requires a standalone backup snapshot, not a live WAL database.");
  if (expectedHash !== undefined && (!/^[a-f0-9]{64}$/i.test(expectedHash) || await sha256(source) !== expectedHash.toLowerCase())) throw new Error("Backup hash does not match the expected SHA-256.");
  let snapshot: MemoryStore | undefined;
  try {
    copyFileSync(source, temporary); chmodSync(temporary, 0o600);
    snapshot = new MemoryStore(temporary);
    checked(snapshot);
    const interruptedTurns = snapshot.recoverInterruptedTurns();
    const integrity = checked(snapshot);
    snapshot.checkpoint(); snapshot.close(); snapshot = undefined;
    const report: SnapshotReport = { path: target, sha256: await sha256(temporary), bytes: statSync(temporary).size, createdAt: new Date().toISOString(), integrity, interruptedTurns };
    publish(temporary, target);
    return report;
  } finally { snapshot?.close(); cleanup(temporary); }
}
/** This opens the database under the current migration policy, like application startup. */
export function inspectDatabase(path: string): Integrity {
  const store = new MemoryStore(existingFile(path));
  try { return checked(store); } finally { store.close(); }
}
export function pruneDatabase(path: string, days = 14): { traces: number; jobs: number } {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Retention days must be an integer from 1 to 365.");
  const store = new MemoryStore(existingFile(path));
  try { return store.purgeOperational(Date.now() - days * 86_400_000); } finally { store.close(); }
}
async function main(args: string[]): Promise<void> {
  const [command, source, target, ...extra] = args;
  let result: unknown;
  if (command === "check" && source && target === undefined) result = inspectDatabase(source);
  else if (command === "backup" && source && target && !extra.length) result = await backupDatabase(source, target);
  else if (command === "restore" && source && target && (extra.length === 0 || (extra.length === 2 && extra[0] === "--sha256"))) result = await restoreDatabase(source, target, extra[1]);
  else if (command === "prune" && source && (target === undefined || (target === "--days" && extra.length === 1))) result = pruneDatabase(source, extra[0] === undefined ? 14 : Number(extra[0]));
  else throw new Error("Usage: ops.ts check DATABASE | backup DATABASE SNAPSHOT | restore SNAPSHOT NEW_DATABASE [--sha256 HASH] | prune DATABASE [--days 14]");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Database operation failed."}\n`); process.exitCode = 1; });
}
