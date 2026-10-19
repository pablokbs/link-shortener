import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createApiTokenService } from './api-tokens.js';
import { apiTokens } from '../db/schema.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

test('automation tokens are hashed, scoped, expiring and revocable', async () => {
  const pg = new PGlite();
  try {
    for (const name of readdirSync(migrationsDir).filter((entry) => entry.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(migrationsDir, name), 'utf8')
        .replace(/^\s*CREATE\s+EXTENSION[^;]*;\s*$/gim, '');
      await pg.exec(sql);
    }
    const db = drizzle(pg);
    let now = Date.parse('2026-09-23T12:00:00Z');
    const service = createApiTokenService(db, () => now);
    const expiry = new Date(now + 60_000);
    const { token, record } = await service.create('Codex', ['links:read', 'stats:read'], expiry);

    assert.match(token, /^lst_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(record.scopes, ['links:read', 'stats:read']);
    assert.equal((record as { tokenHash?: string }).tokenHash, undefined);
    const [stored] = await db.select().from(apiTokens);
    assert.notEqual(stored.tokenHash, token);
    assert.match(stored.tokenHash, /^[0-9a-f]{64}$/);
    assert.equal((await service.getByRawToken(token))?.id, record.id);
    assert.equal(await service.getByRawToken('lst_invalid'), null);
    assert.equal((await service.list())[0].id, record.id);

    now += 60_000;
    assert.equal(await service.getByRawToken(token), null);
    const second = await service.create('OpenClaw', ['links:write'], new Date(now + 60_000));
    assert.equal(await service.revoke(second.record.id), true);
    assert.equal(await service.getByRawToken(second.token), null);
  } finally {
    await pg.close();
  }
});

test('automation token creation rejects invalid parameters', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(readFileSync(join(migrationsDir, '0005_add_api_tokens.sql'), 'utf8'));
    const service = createApiTokenService(drizzle(pg), () => 1000);
    await assert.rejects(() => service.create('', ['links:read'], new Date(2000)));
    await assert.rejects(() => service.create('bad', [] as never[], new Date(2000)));
    await assert.rejects(() => service.create('expired', ['links:read'], new Date(1000)));
  } finally {
    await pg.close();
  }
});
