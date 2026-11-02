import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type LinkService, type LinkRecord, type LinkStats } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { makeFakeAuth, loginAsAdmin } from './helpers/auth.js';

const baseConfig: AppConfig = {
  APP_PORT: 3000,
  SHORTENER_DOMAIN: 'test.local',
  SHORTENER_SCHEME: 'http',
  DATABASE_URL: 'postgres://shortener:shortener@db:5432/shortener',
  SESSION_SECRET: 'test-session-secret-that-is-long-enough-32+',
  SESSION_MAX_AGE_SECONDS: 604800,
  SESSION_COOKIE_NAME: 'link_shortener_session',
  CSRF_COOKIE_NAME: 'link_shortener_csrf',
  ADMIN_TOKEN: 'change-me',
  REDIRECT_STATUS_CODE: 302,
};

function makeLink(overrides: Partial<LinkRecord> = {}): LinkRecord {
  return {
    id: 'link-1',
    slug: 'demo',
    destinationUrl: 'https://example.com',
    redirectStatusCode: 302,
    title: null,
    description: null,
    status: 'active',
    clickCount: 0,
    lastClickedAt: null,
    createdBy: null,
    expiresAt: null,
    deletedAt: null,
    createdAt: new Date('2026-07-13T00:00:00Z'),
    updatedAt: new Date('2026-07-13T00:00:00Z'),
    ...overrides,
  };
}

function makeService(
  link: LinkRecord | null,
): LinkService & {
  recordClickCalls: number;
  lastRecordClickEvent: null | {
    referrer?: string | null;
    userAgent?: string | null;
    country?: string | null;
    ipHash?: string | null;
    ipAddress?: string | null;
  };
} {
  return {
    recordClickCalls: 0,
    lastRecordClickEvent: null,
    async listLinks() {
      return link ? [link] : [];
    },
    async searchLinks() {
      return [];
    },
    async getLinkBySlug() {
      return link;
    },
    async getLinkById() {
      return link;
    },
    async createLink() {
      return makeLink();
    },
    async updateLink() {
      return link;
    },
    async disableLink() {
      return link;
    },
    async recordClick(_link, event) {
      this.recordClickCalls += 1;
      this.lastRecordClickEvent = event;
    },
    async getLinkStats() {
      return link
        ? {
            link,
            totalClicks: 0,
            clicksLast7Days: 0,
            clicksByDay: [],
            clicksByHour: [],
            topReferrers: [],
            recentClicks: [],
          } satisfies LinkStats
        : null;
    },
    async getAllRecentClicks() {
      return [];
    },
  };
}

async function buildApp(link: LinkRecord | null) {
  const { app, ready } = createApp(baseConfig, makeService(link), makeFakeAuth());
  await ready();
  return app;
}

test('redirects use the per-link status code', async () => {
  for (const statusCode of [301, 302, 307, 308] as const) {
    const link = makeLink({ redirectStatusCode: statusCode });
    const service = makeService(link);
    const { app, ready } = createApp(baseConfig, service, makeFakeAuth());
    await ready();

    const response = await app.inject({ method: 'GET', url: '/demo' });

    assert.equal(response.statusCode, statusCode);
    assert.equal(response.headers.location, 'https://example.com');
    assert.equal(service.recordClickCalls, 1);
  }
});

test('returns 410 for disabled links', async () => {
  const link = makeLink({ status: 'disabled' });
  const service = makeService(link);
  const { app, ready } = createApp(baseConfig, service, makeFakeAuth());
  await ready();

  const response = await app.inject({ method: 'GET', url: '/demo' });

  assert.equal(response.statusCode, 410);
  assert.match(response.payload, /Link disabled/);
  assert.equal(service.recordClickCalls, 0);
});

test('returns 410 for expired links', async () => {
  const link = makeLink({ expiresAt: new Date('2026-07-12T00:00:00Z') });
  const service = makeService(link);
  const { app, ready } = createApp(baseConfig, service, makeFakeAuth());
  await ready();

  const response = await app.inject({ method: 'GET', url: '/demo' });

  assert.equal(response.statusCode, 410);
  assert.match(response.payload, /Link expired/);
  assert.equal(service.recordClickCalls, 0);
});

test('returns 404 for unknown slugs', async () => {
  const service = makeService(null);
  const { app, ready } = createApp(baseConfig, service, makeFakeAuth());
  await ready();

  const response = await app.inject({ method: 'GET', url: '/missing' });

  assert.equal(response.statusCode, 404);
  assert.match(response.payload, /Link not found/);
  assert.equal(service.recordClickCalls, 0);
});

test('falls back to IP-based country lookup when cf-ipcountry header is missing', async () => {
  const link = makeLink();
  const service = makeService(link);
  const { app, ready } = createApp(baseConfig, service, makeFakeAuth());
  await ready();

  const response = await app.inject({
    method: 'GET',
    url: '/demo',
    headers: { 'x-forwarded-for': '8.8.8.8' },
  });

  assert.equal(response.statusCode, 302);
  assert.equal(service.recordClickCalls, 1);
  assert.equal(service.lastRecordClickEvent?.country, 'US');
});

test('prefers cf-ipcountry header over IP-based country lookup', async () => {
  const link = makeLink();
  const service = makeService(link);
  const { app, ready } = createApp(baseConfig, service, makeFakeAuth());
  await ready();

  const response = await app.inject({
    method: 'GET',
    url: '/demo',
    headers: {
      'cf-ipcountry': 'AR',
      'x-forwarded-for': '8.8.8.8',
    },
  });

  assert.equal(response.statusCode, 302);
  assert.equal(service.recordClickCalls, 1);
  assert.equal(service.lastRecordClickEvent?.country, 'AR');
});

test('exposes stats payload', async () => {
  const link = makeLink();
  const app = await buildApp(link);
  // Authenticate via session login instead of bearer token.
  const cookies = await loginAsAdmin(app);
  const response = await app.inject({
    method: 'GET',
    url: '/api/links/link-1/stats',
    headers: { cookie: cookies },
  });
  const payload = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(payload.totalClicks, 0);
  assert.equal(payload.clicksLast7Days, 0);
  assert.equal(payload.shortUrl, 'http://test.local/demo');
});
