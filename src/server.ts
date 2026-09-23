import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { createLinkService } from './lib/links.js';
import { createAuthService } from './auth/service.js';
import { createApiTokenService } from './auth/api-tokens.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = createDb(config);
const links = createLinkService(config);
const auth = createAuthService(config, db);
const apiTokens = createApiTokenService(db);
const { app, ready } = createApp(config, links, auth, apiTokens);

await ready();
const port = config.APP_PORT;
await app.listen({ port, host: '0.0.0.0' });
