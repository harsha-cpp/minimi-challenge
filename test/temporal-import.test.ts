import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TemporalStore } from "../src/temporal/store.ts";

const original = {
  sourceId: "reviewed-official-announcement", url: "https://example.com/announcement", title: "Original announcement",
  text: "Mira Chen became chief executive.", availableAt: "2020-01-01T00:00:00Z", provenanceKind: "primary-source",
  provenanceUrl: "https://archive.example.com/original", reviewed: true,
};

test("corpus CLI imports source manifests idempotently without model or network configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-temporal-import-"));
  const manifest = join(dir, "sources.json"), database = join(dir, "corpus.db");
  const run = () => spawnSync(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", "scripts/import-corpus.ts", manifest, "--db", database], { encoding: "utf8", env: { ...process.env, LLM_API_KEY: "", EXA_API_KEY: "" } });
  try {
    writeFileSync(manifest, JSON.stringify({ documents: [original] }));
    const first = run(); assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).reviewed, 1);
    writeFileSync(manifest, JSON.stringify([original]));
    const second = run(); assert.equal(second.status, 0, second.stderr);
    const store = new TemporalStore(database);
    try { assert.equal(store.coverage().reviewedDocuments, 1); } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corpus CLI validates the entire manifest before creating a database", () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-temporal-invalid-"));
  const manifest = join(dir, "sources.json"), database = join(dir, "must-not-exist.db");
  try {
    writeFileSync(manifest, JSON.stringify([original, { ...original, sourceId: "bad", availableAt: "2020-02-30T00:00:00Z" }]));
    const result = spawnSync(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", "scripts/import-corpus.ts", manifest, "--db", database], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /real ISO timestamp/);
    assert.equal(existsSync(database), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corpus CLI defaults to the server's dedicated temporal database configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-temporal-default-"));
  const manifest = join(dir, "sources.json");
  const command = ["--import", "tsx", "--disable-warning=ExperimentalWarning", "scripts/import-corpus.ts", manifest];
  try {
    writeFileSync(manifest, JSON.stringify([original]));
    const explicit = join(dir, "configured-temporal.db");
    const configured = spawnSync(process.execPath, command, { encoding: "utf8", env: { ...process.env, TEMPORAL_DB_PATH: explicit, DB_PATH: join(dir, "unused.db") } });
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(JSON.parse(configured.stdout).database, explicit);
    assert.ok(existsSync(explicit));
    assert.equal(existsSync(join(dir, "unused.db")), false);
    const memory = join(dir, "conversation.db");
    const fallback = spawnSync(process.execPath, command, { encoding: "utf8", env: { ...process.env, TEMPORAL_DB_PATH: "", DB_PATH: memory } });
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.equal(JSON.parse(fallback.stdout).database, `${memory}.temporal.db`);
    assert.ok(existsSync(`${memory}.temporal.db`));
    assert.equal(existsSync(memory), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
