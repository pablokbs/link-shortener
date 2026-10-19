# Automation and agent access

The JSON API can be called directly by a script, an agent runtime, or a thin MCP
adapter. The service remains responsible for validating requests; the agent
decides when to call it. No browser session or dashboard automation is needed.

## Create a scoped token

Run this command on the host with access to the application's database, after
applying migrations:

```bash
docker compose --env-file .env.production -f compose.production.yml exec app \
  npm run api-token -- create --name codex-links \
  --scopes links:read,links:write --expires-days 90
```

The command displays the secret **once**. The database stores only its SHA-256
hash. Copy the secret to the agent runtime's secret store; do not put it in a
prompt, source file, screenshot, or command-line argument. Tokens expire after
90 days by default (maximum 365 days). Issue a separate token per runtime so
each one can be revoked independently.

Available scopes:

| Scope | Allows |
| --- | --- |
| `links:read` | `GET /api/links/:id` |
| `links:write` | `POST /api/links`, `PATCH /api/links/:id`, `DELETE /api/links/:id` |
| `stats:read` | `GET /api/links/:id/stats` |

The existing `GET /api/links` remains public for compatibility. Token scopes
do not make that route private. Browser admin sessions and the legacy
`ADMIN_TOKEN` continue to work with full API access; new automation should
use scoped tokens instead.

## Call the API

```bash
# SHORTENER_TOKEN must come from your secret store, not a literal in this command.
curl -fsS -X POST "https://go.example.com/api/links" \
  -H "Authorization: Bearer ${SHORTENER_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"slug":"release-notes","destinationUrl":"https://example.com/releases"}'
```

The response includes `shortUrl`. A token without the required scope receives
`403`; an unknown, expired, or revoked token receives `401`. Creation with
an already-used slug returns `409`: agents should inspect the existing link
before retrying rather than silently creating a different slug.

Link creation records `createdBy` as `token:<token-id>` for automation
requests. Automation tokens cannot forge or overwrite that field. The server
logs the token ID and scope for authorized API requests, never the secret.

## List or revoke

```bash
npm run api-token -- list
npm run api-token -- revoke --id <token-id>
```

These commands also require database access on the host. Listing returns token
metadata, never secrets. Revocation takes effect on the next API request.

For agent workflows, prefer read-only inspection first and request human
confirmation before changing a destination or disabling a link. A separate
`links:read` token is appropriate for read-only agents.
