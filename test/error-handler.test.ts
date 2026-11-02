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

function makeServiceThatThrows(message: string): LinkService {
  return {
    async listLinks() {
      throw Object.assign(new Error(message), { statusCode: 500 });
    },
    async searchLinks() {
      return [];
    },
    async getLinkBySlug() {
      return null;
    },
    async getLinkById() {
      return null;
    },
    async createLink() {
      return makeLink();
    },
    async updateLink() {
      return null;
    },
    async disableLink() {
      return null;
    },
    async recordClick() {},
    async getLinkStats() {
      return null;
    },
    async getAllRecentClicks() {
      return [];
    },
  };
}

function makeServiceForStats(): LinkService {
  return {
    async listLinks() {
      return [];
    },
    async searchLinks() {
      return [];
    },
    async getLinkBySlug() {
      return null;
    },
    async getLinkById() {
      return null;
    },
    async createLink() {
      return makeLink();
    },
    async updateLink() {
      return null;
    },
    async disableLink() {
      return null;
    },
    async recordClick() {},
    async getLinkStats() {
      throw Object.assign(new Error('connection refused: postgres://user:secret@db:5432/shortener at port 5432'), { statusCode: 500 });
    },
    async getAllRecentClicks() {
      return [];
    },
  };
}

async function buildApp(service: LinkService) {
  const { app, ready } = createApp(baseConfig, service, makeFakeAuth());
  await ready();
  return app;
}

test('error handler in development passes through 4xx error.message', async (t) => {
  const previousEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });

  // Service throws a 400 with an internal-looking message.
  const service: LinkService = makeServiceForStats();
  service.listLinks = async () => {
    throw Object.assign(new Error('internal pg detail: relation "links" does not exist'), { statusCode: 400 });
  };

  const app = await buildApp(service);
  const response = await app.inject({ method: 'GET', url: '/api/links' });

  assert.equal(response.statusCode, 400);
  // In dev (NODE_ENV not 'production'), the raw error message is included
  // for debugging.
  const body = response.json();
  assert.match(body.error, /internal pg detail/);
});

test('error handler in production returns generic messages for 5xx', async (t) => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });

  const app = await buildApp(makeServiceForStats());
  // Authenticate via the session login flow so the request reaches the
  // stats endpoint that throws a 500.
  const cookies = await loginAsAdmin(app);
  const response = await app.inject({
    method: 'GET',
    url: '/api/links/link-1/stats',
    headers: { cookie: cookies },
  });

  assert.equal(response.statusCode, 500);
  const body = response.json();
  // Generic message must not leak the underlying error text.
  assert.equal(body.error, 'Internal Server Error');
  assert.doesNotMatch(body.error, /connection refused/);
  assert.doesNotMatch(body.error, /postgres/);
  assert.doesNotMatch(body.error, /secret/);
});

test('error handler in production returns 302 redirect to /admin/login for unauthenticated dashboard request', async (t) => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });

  const app = await buildApp(makeServiceForStats());
  const response = await app.inject({
    method: 'GET',
    url: '/admin/dashboard',
  });

  // The HTML guard redirects unauthenticated requests to the login page
  // instead of returning a 401 JSON body.
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/admin/login');
});

test('error handler in production returns generic 401 JSON for unauthenticated API request', async (t) => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });

  const app = await buildApp(makeServiceForStats());
  const response = await app.inject({
    method: 'GET',
    url: '/api/links/link-1/stats',
    headers: { authorization: 'Bearer invalid' },
  });

  assert.equal(response.statusCode, 401);
  const body = response.json();
  assert.equal(body.error, 'Unauthorized');
  // Session-based auth no longer sends WWW-Authenticate.
  assert.equal(response.headers['www-authenticate'], undefined);
});

test('error handler in production does not leak 4xx error.message from downstream', async (t) => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });

  // Service that throws a 400 with an internal-looking message.
  const service: LinkService = {
    ...makeServiceThatThrows('internal pg detail: relation "links" does not exist at offset 42'),
  };
  // Override listLinks to throw a 400 instead.
  service.listLinks = async () => {
    throw Object.assign(new Error('internal pg detail: relation "links" does not exist at offset 42'), { statusCode: 400 });
  };

  const app = await buildApp(service);
  // GET /api/links does not require auth and triggers listLinks().
  const response = await app.inject({ method: 'GET', url: '/api/links' });

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.error, 'Bad Request');
  assert.doesNotMatch(body.error, /pg/);
  assert.doesNotMatch(body.error, /links/);
});

test('error handler in production returns 404 generic message for unknown route', async (t) => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });

  const app = await buildApp(makeServiceForStats());
  // Multi-segment path so it does not match the wildcard /:slug route.
  const response = await app.inject({ method: 'GET', url: '/multi/segment/path' });

  assert.equal(response.statusCode, 404);
  const body = response.json();
  assert.equal(body.error, 'Not Found');
});

test('error handler preserves statusCode from thrown error in production', async (t) => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });

  const service: LinkService = makeServiceForStats();
  service.listLinks = async () => {
    throw Object.assign(new Error('not allowed'), { statusCode: 403 });
  };

  const app = await buildApp(service);
  const response = await app.inject({ method: 'GET', url: '/api/links' });

  // The statusCode from the error must be preserved even though the
  // message is replaced with a generic one.
  assert.equal(response.statusCode, 403);
  const body = response.json();
  assert.equal(body.error, 'Forbidden');
  assert.doesNotMatch(body.error, /not allowed/);
});

test('error handler returns 409 for duplicate slug on POST /api/links in production', async (t) => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });

  const service: LinkService = makeServiceForStats();
  service.createLink = async () => {
    const error = new Error('Slug already exists') as Error & { statusCode: number };
    error.statusCode = 409;
    throw error;
  };

  const app = await buildApp(service);
  const cookies = await loginAsAdmin(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/links',
    headers: {
      cookie: cookies,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: 'slug=demo&destinationUrl=https%3A%2F%2Fexample.com&redirectStatusCode=302',
  });

  assert.equal(response.statusCode, 409);
  const body = response.json();
  assert.equal(body.error, 'Conflict');
  assert.doesNotMatch(body.error, /Slug already exists/);
});
