// Snapshot committed SQLite pages, then upload with the VM identity.
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const account = process.env.ASOF_STORAGE;
if (!/^[a-z0-9]{3,24}$/.test(account ?? '')) throw new Error('ASOF_STORAGE is required');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const temporary = await mkdtemp(join(tmpdir(), 'asof-backup-'));
try {
  const response = await fetch('http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F', {
    headers: { Metadata: 'true' }, signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Identity returned ${response.status}`);
  const token = (await response.json()).access_token;
  async function upload(name, body) {
    const result = await fetch(`https://${account}.blob.core.windows.net/backups/${stamp}/${name}`, {
      method: 'PUT', body, redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${token}`, 'x-ms-version': '2023-11-03', 'x-ms-blob-type': 'BlockBlob', 'If-None-Match': '*' },
    });
    if (!result.ok) throw new Error(`Backup upload returned ${result.status}`);
  }
  const manifest = { createdAt: stamp, files: [] };
  // Wallet last: a live snapshot can conservatively include newer charges.
  for (const name of ['asof.db', 'asof.db.temporal.db', 'provider-spend.db']) {
    const source = new DatabaseSync(`/opt/asof/app/data/${name}`, { readOnly: true });
    try { await backup(source, join(temporary, name)); } finally { source.close(); }
    const snapshot = new DatabaseSync(join(temporary, name), { readOnly: true });
    try {
      const rows = snapshot.prepare('PRAGMA integrity_check').all();
      if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new Error('Backup integrity failed');
    } finally { snapshot.close(); }
    const body = await readFile(join(temporary, name));
    await upload(name, body);
    manifest.files.push({ name, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
  }
  // A prefix without this manifest is incomplete and must not be restored.
  await upload('manifest.json', JSON.stringify(manifest, null, 2));
  console.log(`Backup complete: ${stamp}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
