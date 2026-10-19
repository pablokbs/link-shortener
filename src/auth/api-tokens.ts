import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AuthDb } from './service.js';
import { apiTokens } from '../db/schema.js';

export const API_TOKEN_SCOPES = ['links:read', 'links:write', 'stats:read'] as const;
export type ApiTokenScope = typeof API_TOKEN_SCOPES[number];
export type ApiTokenRecord = Omit<typeof apiTokens.$inferSelect, 'tokenHash'>;

export interface ApiTokenService {
  create(name: string, scopes: ApiTokenScope[], expiresAt: Date): Promise<{ token: string; record: ApiTokenRecord }>;
  getByRawToken(rawToken: string): Promise<ApiTokenRecord | null>;
  list(): Promise<ApiTokenRecord[]>;
  revoke(id: string): Promise<boolean>;
}

function withoutHash(row: typeof apiTokens.$inferSelect): ApiTokenRecord {
  const { tokenHash: _tokenHash, ...record } = row;
  return record;
}

export function createApiTokenService(db: AuthDb, now: () => number = Date.now): ApiTokenService {
  return {
    async create(name, scopes, expiresAt) {
      const normalizedName = name.trim();
      if (!normalizedName || normalizedName.length > 100) {
        throw new Error('Token name must be between 1 and 100 characters');
      }
      if (!scopes.length || scopes.some((scope) => !API_TOKEN_SCOPES.includes(scope))) {
        throw new Error('At least one valid scope is required');
      }
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now()) {
        throw new Error('Token expiration must be in the future');
      }
      const token = `lst_${randomBytes(32).toString('base64url')}`;
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const [row] = await db.insert(apiTokens).values({
        name: normalizedName,
        tokenHash,
        scopes: [...new Set(scopes)],
        expiresAt,
      }).returning();
      return { token, record: withoutHash(row) };
    },

    async getByRawToken(rawToken) {
      if (!/^lst_[A-Za-z0-9_-]{43}$/.test(rawToken)) return null;
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const [row] = await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash)).limit(1);
      if (!row || row.revokedAt || row.expiresAt.getTime() <= now()) return null;
      return withoutHash(row);
    },

    async list() {
      const rows = await db.select().from(apiTokens);
      return rows.map(withoutHash);
    },

    async revoke(id) {
      const [row] = await db.update(apiTokens)
        .set({ revokedAt: new Date(now()) })
        .where(eq(apiTokens.id, id))
        .returning();
      return Boolean(row);
    },
  };
}
