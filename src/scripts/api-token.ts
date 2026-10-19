import { createDb } from '../db/index.js';
import { createApiTokenService, API_TOKEN_SCOPES, type ApiTokenScope } from '../auth/api-tokens.js';
import { loadConfig } from '../config.js';

function usage(): never {
  throw new Error(
    'Usage: api-token create --name NAME --scopes links:read,links:write[,stats:read] [--expires-days 90]\n' +
    '       api-token list\n' +
    '       api-token revoke --id UUID',
  );
}

function parseOptions(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) usage();
    const separator = arg.indexOf('=');
    const key = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
    const value = separator === -1 ? args[++i] : arg.slice(separator + 1);
    if (!key || !value || value.startsWith('--') || options.has(key)) usage();
    options.set(key, value);
  }
  return options;
}

function expectOptions(options: Map<string, string>, allowed: string[]): void {
  for (const key of options.keys()) if (!allowed.includes(key)) usage();
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  if (!['create', 'list', 'revoke'].includes(command ?? '')) usage();
  const config = loadConfig();
  const db = createDb(config);
  const tokens = createApiTokenService(db);

  try {
    if (command === 'create') {
      expectOptions(options, ['name', 'scopes', 'expires-days']);
      const name = options.get('name');
      const scopeArg = options.get('scopes');
      if (!name || !scopeArg) usage();
      const scopes = scopeArg.split(',').map((scope) => scope.trim());
      if (scopes.some((scope) => !API_TOKEN_SCOPES.includes(scope as ApiTokenScope))) usage();
      const days = Number(options.get('expires-days') ?? '90');
      if (!Number.isInteger(days) || days < 1 || days > 365) usage();
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      const { token, record } = await tokens.create(name, scopes as ApiTokenScope[], expiresAt);
      console.error(`Created token ${record.id} (${record.name}); expires ${record.expiresAt.toISOString()}. Secret is shown once:`);
      console.log(token);
    } else if (command === 'list') {
      expectOptions(options, []);
      console.log(JSON.stringify(await tokens.list(), null, 2));
    } else {
      expectOptions(options, ['id']);
      const id = options.get('id');
      if (!id || !/^[0-9a-f-]{36}$/i.test(id)) usage();
      if (!await tokens.revoke(id)) throw new Error('Token not found');
      console.log(`Revoked token ${id}`);
    }
  } finally {
    const client = (db as unknown as { $client?: { end: (opts?: { timeout?: number }) => Promise<void> } }).$client;
    await client?.end({ timeout: 1 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
