import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type LinkService, type LinkRecord, type LinkStats } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type {
  AuthService,
  CreateSessionResult,
  CreateUserInput,
  GetSessionResult,
  SessionRecord,
  UserRecord,
} from '../src/auth/types.js';

const baseConfig: AppConfig = {
  APP_PORT: 3000,
  SHORTENER_DOMAIN: 'test.local',
  SHORTENER_SCHEME: 'http',
  DATABASE_URL: 'postgres://shortener:shortener@db:5432/shortener',
  SESSION_SECRET: 'test-session-secret-that-is-long-enough-32+',
  SESSION_MAX_AGE_SECONDS: 604800,
  SESSION_COOKIE_NAME: 'link_shortener_session',
  CSRF_COOKIE_NAME: 'link_shortener_csrf',
  ADMIN_TOKEN: 'legacy-admin-token',
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

function makeLinkService(link: LinkRecord | null = null): LinkService {
  const stats: LinkStats = {
    link: link ?? makeLink(),
    totalClicks: 0,
    clicksLast7Days: 0,
    clicksByDay: [],
    clicksByHour: [],
    topReferrers: [],
    recentClicks: [],
  };
  return {
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
    async recordClick() {},
    async getLinkStats() {
      return link ? stats : null;
    },
    async getAllRecentClicks() {
      return [];
    },
  };
}

interface FakeAuthOptions {
  sessionValid?: boolean;
  userActive?: boolean;
  passwordChanged?: boolean;
}

function makeFakeAuth(options: FakeAuthOptions = {}): AuthService {
  const sessionValid = options.sessionValid ?? true;
  const userActive = options.userActive ?? true;
  const passwordChanged = options.passwordChanged ?? false;

  const user: UserRecord = {
    id: 'user-1',
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: 'fake-hash',
    role: 'admin',
    isActive: userActive,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  const session: SessionRecord = {
    id: 'session-1',
    userId: 'user-1',
    tokenHash: 'fake-token-hash',
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  let currentPassword = 'password123';
  let currentRawToken = 'test-session-token';
  let createSessionCalls = 0;

  return {
    hashPassword: async () => 'fake-hash',
    createUser: async (_input: CreateUserInput): Promise<UserRecord> => {
      throw new Error('createUser not implemented in fake auth');
    },
    validateCredentials: async (email: string, password: string) => {
      if (
        typeof email === 'string' &&
        email.toLowerCase() === user.email.toLowerCase() &&
        password === currentPassword
      ) {
        return user;
      }
      return null;
    },
    createSession: async (_userId: string): Promise<CreateSessionResult> => {
      createSessionCalls += 1;
      currentRawToken = `test-session-token-${createSessionCalls}`;
      return {
        rawToken: currentRawToken,
        sessionRecord: { ...session, tokenHash: currentRawToken },
      };
    },
    getSessionByToken: async (rawToken: string): Promise<GetSessionResult | null> => {
      if (rawToken !== currentRawToken || !sessionValid) {
        return null;
      }
      return { session, user };
    },
    revokeSessionByRawToken: async () => {},
    revokeSessionByHash: async () => {},
    revokeAllUserSessions: async () => {},
    updatePassword: async (_userId: string, newPassword: string): Promise<void> => {
      if (newPassword.length < 8) {
        const err = new Error('Password must be at least 8 characters');
        (err as Error & { statusCode: number }).statusCode = 400;
        throw err;
      }
      currentPassword = newPassword;
      // Simulate the production behavior of revoking all existing sessions
      // (including the current one) when a password changes.
      currentRawToken = '';
    },
  };
}

function cookieNameValue(setCookie: string): string {
  return setCookie.split(';')[0]?.trim() ?? '';
}

function extractCookie(
  setCookieHeader: string | string[] | undefined,
  predicate: (name: string) => boolean,
): string | null {
  if (!setCookieHeader) return null;
  const entries = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const entry of entries) {
    const nameValue = cookieNameValue(entry);
    if (!nameValue) continue;
    const [name] = nameValue.split('=');
    if (predicate(name ?? '')) {
      return nameValue;
    }
  }
  return null;
}

function extractCsrfCookie(setCookieHeader: string | string[] | undefined): string | null {
  return extractCookie(setCookieHeader, (name) => /csrf/i.test(name));
}

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string | null {
  return extractCookie(setCookieHeader, (name) => /session/i.test(name) && !/csrf/i.test(name));
}

function extractCsrfTokenFromHtml(html: string): string | null {
  const match = html.match(/name="csrfToken"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

async function buildApp(auth: AuthService = makeFakeAuth()) {
  const { app, ready } = createApp(baseConfig, makeLinkService(makeLink()), auth);
  await ready();
  return app;
}

async function loginPage(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({ method: 'GET', url: '/admin/login' });
  const csrfToken = extractCsrfTokenFromHtml(res.body);
  const csrfCookie = extractCsrfCookie(res.headers['set-cookie']);
  return { res, csrfToken, csrfCookie };
}

async function loginAsAdmin(
  app: Awaited<ReturnType<typeof buildApp>>,
  password = 'password123',
): Promise<{ sessionCookie: string; csrfCookie: string }> {
  const { csrfToken, csrfCookie } = await loginPage(app);
  assert.ok(csrfToken, 'expected csrf token');
  assert.ok(csrfCookie, 'expected csrf cookie');

  const res = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: csrfCookie,
    },
    payload: `email=admin@example.com&password=${encodeURIComponent(password)}&csrfToken=${encodeURIComponent(csrfToken)}`,
  });

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/admin/dashboard');

  const sessionCookie = extractSessionCookie(res.headers['set-cookie']);
  const newCsrfCookie = extractCsrfCookie(res.headers['set-cookie']);
  assert.ok(sessionCookie, 'expected session cookie after login');
  return { sessionCookie, csrfCookie: newCsrfCookie ?? '' };
}

describe('auth routes', () => {
  it('GET /admin/login renders a login form with a CSRF token', async () => {
    const app = await buildApp();
    const { res, csrfToken, csrfCookie } = await loginPage(app);
    assert.equal(res.statusCode, 200);
    assert.ok(csrfToken);
    assert.ok(csrfCookie);
  });

  it('POST /admin/login with valid credentials sets a session cookie and redirects to dashboard', async () => {
    const app = await buildApp();
    const { sessionCookie } = await loginAsAdmin(app);
    assert.match(sessionCookie, /link_shortener_session=/);
  });

  it('POST /admin/login with invalid credentials returns 401 and re-renders login', async () => {
    const app = await buildApp();
    const { csrfToken, csrfCookie } = await loginPage(app);
    assert.ok(csrfToken, 'expected csrf token');
    assert.ok(csrfCookie, 'expected csrf cookie');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: csrfCookie,
      },
      payload: `email=admin@example.com&password=wrongpassword&csrfToken=${encodeURIComponent(csrfToken)}`,
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.body, /Invalid email or password/i);
  });

  it('POST /admin/login without CSRF token returns 403', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=admin@example.com&password=password123',
    });
    assert.equal(res.statusCode, 403);
  });

  it('POST /admin/logout clears the session and redirects to login', async () => {
    const app = await buildApp();
    const { sessionCookie } = await loginAsAdmin(app);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/logout',
      headers: { cookie: sessionCookie },
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/admin/login');
    const setCookie = res.headers['set-cookie'];
    const entries = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
    const cleared = entries.some(
      (entry) => /Max-Age=0/i.test(entry) && new RegExp(`^${baseConfig.SESSION_COOKIE_NAME}=;?`).test(cookieNameValue(entry)),
    );
    assert.ok(cleared, 'expected session cookie to be cleared');
  });

  it('GET /admin/session returns authenticated when logged in', async () => {
    const app = await buildApp();
    const { sessionCookie } = await loginAsAdmin(app);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/session',
      headers: { cookie: sessionCookie },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.email, 'admin@example.com');
  });

  it('GET /admin/session returns 401 when not logged in', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/admin/session' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().authenticated, false);
  });

  it('legacy ADMIN_TOKEN bearer still works for API routes', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/links/link-1/stats',
      headers: { authorization: 'Bearer legacy-admin-token' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().totalClicks, 0);
  });

  it('API routes without auth return 401 JSON', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/links/link-1/stats' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'Unauthorized');
  });

  it('HTML admin routes redirect to login with an expired session', async () => {
    const app = await buildApp(makeFakeAuth({ sessionValid: false }));
    const res = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      headers: { cookie: 'link_shortener_session=test-session-token' },
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/admin/login');
  });

  it('HTML admin routes redirect to login for a deactivated user', async () => {
    const app = await buildApp(makeFakeAuth({ userActive: false }));
    const res = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      headers: { cookie: 'link_shortener_session=test-session-token' },
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/admin/login');
  });

  it('POST /admin/change-password updates password and keeps caller logged in', async () => {
    const app = await buildApp(makeFakeAuth({ passwordChanged: true }));
    const { sessionCookie } = await loginAsAdmin(app);

    // Fetch dashboard to get a fresh CSRF token and cookie for the change-password form.
    const dashboard = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      headers: { cookie: sessionCookie },
    });
    assert.equal(dashboard.statusCode, 200);
    const csrfToken = extractCsrfTokenFromHtml(dashboard.body);
    const csrfCookie = extractCsrfCookie(dashboard.headers['set-cookie']);
    assert.ok(csrfToken);
    assert.ok(csrfCookie);

    const change = await app.inject({
      method: 'POST',
      url: '/admin/change-password',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${sessionCookie}; ${csrfCookie}`,
      },
      payload: `currentPassword=password123&newPassword=newpassword456&csrfToken=${encodeURIComponent(csrfToken)}`,
    });
    assert.equal(change.statusCode, 302);
    assert.equal(change.headers.location, '/admin/dashboard?success=password-changed');

    // A new session cookie should be issued.
    const newSessionCookie = extractSessionCookie(change.headers['set-cookie']);
    assert.ok(newSessionCookie);

    // Old session should no longer work.
    const oldSession = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      headers: { cookie: sessionCookie },
    });
    assert.equal(oldSession.statusCode, 302);
    assert.equal(oldSession.headers.location, '/admin/login');

    // New session should work.
    const newSession = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      headers: { cookie: newSessionCookie },
    });
    assert.equal(newSession.statusCode, 200);
  });
});
