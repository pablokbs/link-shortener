import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type LinkRecord, type LinkService } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { ApiTokenRecord } from '../src/auth/api-tokens.js';
import { makeFakeAuth } from './helpers/auth.js';

const config: AppConfig = {
  APP_PORT: 3000,
  SHORTENER_DOMAIN: 'test.local',
  SHORTENER_SCHEME: 'http',
  DATABASE_URL: 'postgres://test',
  SESSION_SECRET: 'test-session-secret-that-is-long-enough-32+',
  SESSION_MAX_AGE_SECONDS: 604800,
  SESSION_COOKIE_NAME: 'link_shortener_session',
  CSRF_COOKIE_NAME: 'link_shortener_csrf',
  ADMIN_TOKEN: 'legacy-admin-token',
  REDIRECT_STATUS_CODE: 302,
};

const link: LinkRecord = {
  id: 'link-1',
  slug: 'demo',
  destinationUrl: 'https://example.com',
  redirectStatusCode: 302,
  status: 'active',
  clickCount: 0,
  lastClickedAt: null,
};

test('automation bearer tokens enforce scopes and attribute created links', async () => {
  let createdBy: string | null | undefined;
  let patchedBy: string | null | undefined;
  const links: LinkService = {
    async listLinks() { return [link]; },
    async getLinkBySlug() { return link; },
    async getLinkById() { return link; },
    async createLink(input) { createdBy = input.createdBy; return { ...link, createdBy }; },
    async updateLink(_id, patch) { patchedBy = patch.createdBy; return link; },
    async disableLink() { return link; },
    async recordClick() {},
    async getLinkStats() {
      return {
        link, totalClicks: 0, clicksLast7Days: 0,
        clicksByDay: [], clicksByHour: [], topReferrers: [], recentClicks: [],
      };
    },
    async getAllRecentClicks() { return []; },
  };
  const tokens = new Map<string, ApiTokenRecord>([
    ['lst_read-token', { id: 'read-id', name: 'reader', scopes: ['links:read'], expiresAt: new Date('2099-01-01'), revokedAt: null, createdAt: new Date() }],
    ['lst_write-token', { id: 'write-id', name: 'writer', scopes: ['links:write'], expiresAt: new Date('2099-01-01'), revokedAt: null, createdAt: new Date() }],
    ['lst_stats-token', { id: 'stats-id', name: 'stats', scopes: ['stats:read'], expiresAt: new Date('2099-01-01'), revokedAt: null, createdAt: new Date() }],
  ]);
  const { app, ready } = createApp(config, links, makeFakeAuth(), {
    async getByRawToken(raw) { return tokens.get(raw) ?? null; },
  });
  await ready();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/links' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/links/link-1' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/links/link-1', headers: { authorization: 'Bearer lst_read-token' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/links', headers: { authorization: 'Bearer lst_read-token' }, payload: { slug: 'new', destinationUrl: 'https://example.com' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/links/link-1/stats', headers: { authorization: 'Bearer lst_read-token' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/links/link-1/stats', headers: { authorization: 'Bearer lst_stats-token' } })).statusCode, 200);

    const create = await app.inject({
      method: 'POST', url: '/api/links',
      headers: { authorization: 'Bearer lst_write-token' },
      payload: { slug: 'new', destinationUrl: 'https://example.com', createdBy: 'spoofed-user' },
    });
    assert.equal(create.statusCode, 201);
    assert.equal(createdBy, 'token:write-id');

    const patch = await app.inject({
      method: 'PATCH', url: '/api/links/link-1',
      headers: { authorization: 'Bearer lst_write-token' },
      payload: { title: 'Changed', createdBy: 'spoofed-user' },
    });
    assert.equal(patch.statusCode, 200);
    assert.equal(patchedBy, undefined);

    assert.equal((await app.inject({ method: 'DELETE', url: '/api/links/link-1', headers: { authorization: 'Bearer lst_write-token' } })).statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url: '/api/links/link-1', headers: { authorization: 'Bearer lst_write-token' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/links', headers: { authorization: 'Bearer wrong' }, payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/links', headers: { authorization: 'Bearer legacy-admin-token' }, payload: { slug: 'legacy', destinationUrl: 'https://example.com' } })).statusCode, 201);
  } finally {
    await app.close();
  }
});
