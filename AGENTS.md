# Bubu AI (`bubu-whatsapp-agent`)

## Architecture & Runtime
- Fastify + SQLite WAL WhatsApp AI agent managed via PM2 (`bubu`) on `127.0.0.1:3088`.
- Internal Docker-to-host webhook bridge via OpenResty on `10.3.14.216:3089` (ACL `172.19/20.0.0/16`).
- Daily backup cron runs at `03:00` via `scripts/backup.js`.

## Verification Commands
- Full backend check (syntax + tests): `npm run check`
- Unit tests: `npm run test:unit`
- Integration tests: `npm run test:integration`
- Contract tests: `npm run test:contracts`
- Frontend 3D visualizer typecheck & build: `cd web && npx tsc --noEmit && npm run build`
- Frontend static deploy (`waha.andresptr.site`): `bash scripts/deploy-web.sh`

## Guardrails
- Never echo, log, or commit `.env` or secret values.
- Keep service bound strictly to `127.0.0.1:3088`.
- Protect `data/` and `backups/` from destructive operations or accidental deletion.
- Keep `/api/visualizer/*` strictly read-only and sanitized (no raw WhatsApp text or JIDs/phone numbers); never expose `/webhook` in public OpenResty proxy configs.
