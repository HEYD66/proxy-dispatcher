import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('retention removes expired events and archives only when enabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pd-retention-test-'));
  const file = join(directory, 'events.jsonl');
  process.env.EVENT_LOG_FILE = file;
  const { readEvents, pruneOldEvents, setLogRetentionDays } = await import('../event-log.mjs');
  const old = { time: new Date(Date.now() - 20 * 86400000).toISOString(), level: 'info', category: 'test', message: 'old' };
  const recent = { time: new Date().toISOString(), level: 'info', category: 'test', message: 'recent' };
  const archive = `${file}.old.archive`;
  try {
    await writeFile(file, JSON.stringify(old) + '\n' + JSON.stringify(recent) + '\n');
    await writeFile(archive, 'archived');
    const oldDate = new Date(Date.now() - 20 * 86400000);
    await utimes(archive, oldDate, oldDate);
    setLogRetentionDays(0);
    assert.equal((await pruneOldEvents()).removed, 0);
    assert.equal((await readEvents()).length, 2);
    setLogRetentionDays(7);
    assert.equal((await pruneOldEvents()).removed, 2);
    assert.equal((await readEvents()).length, 1);
    assert.equal((await readEvents())[0].message, 'recent');
    await assert.rejects(readFile(archive), { code: 'ENOENT' });
  } finally {
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tmpdir(), 'pd-retention-test-')));
    await rm(target, { recursive: true, force: true });
  }
});
