# Bubu AI (`bubu-whatsapp-agent`)

## Architecture & Runtime
- Fastify + SQLite WAL WhatsApp AI agent managed via PM2 (`bubu`) on `127.0.0.1:3088`.
- Internal Docker-to-host webhook bridge via OpenResty on `10.3.14.216:3089` (ACL `172.19/20.0.0/16`).
- Daily backup cron runs at `03:00` via `scripts/backup.js`.

## Verification Commands
- Full check (syntax + tests): `npm run check`
- Unit tests: `npm run test:unit`
- Integration tests: `npm run test:integration`
- Contract tests: `npm run test:contracts`

## Guardrails
- Never echo, log, or commit `.env` or secret values.
- Keep service bound strictly to `127.0.0.1:3088`.
- Protect `data/` and `backups/` from destructive operations or accidental deletion.
