# time-card

Minimal self-hosted clock in/out time tracker. Node/Express + SQLite,
single shared-password login, CSV export.

## Running

Requires two env vars:

- `TIMECARD_PASSWORD` — the shared login password.
- `SESSION_SECRET` — random string used to sign the session cookie.

Data is stored in a SQLite file at `DB_PATH` (default `./data/timecard.db`).

```
docker build -t time-card .
docker run -p 8080:80 \
  -e TIMECARD_PASSWORD=changeme \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -v timecard_data:/data -e DB_PATH=/data/timecard.db \
  time-card
```

## Deployment

Built and published to `ghcr.io/normsohl/time-card` by
`.github/workflows/publish.yml` on every push to `main`. Deployed on
sohl-server alongside sohl.com and euphonia.us — see that repo's README
for the shared Caddy/compose pattern.

<!-- deploy pipeline test 2026-09-09T05:34:38Z -->
