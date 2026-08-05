# Heartline dating platform

Heartline is a Next.js App Router application with localized English and Simplified Chinese marketing routes.

## Local setup

Install dependencies and create local environment files:

```bash
npm install
cp .env.example .env.local
```

The values in `.env.example` are development-only defaults. Generate new passwords and a random `BETTER_AUTH_SECRET` of at least 32 characters for every deployed environment. Production `APP_URL` and `BETTER_AUTH_URL` values must use HTTPS.

Start PostgreSQL, password-protected Redis, and MinIO with Docker Compose:

```bash
docker compose --env-file .env.local up -d
```

All container ports bind to `127.0.0.1`, and persistent data is stored in named Docker volumes. The application uses these environment variables:

- `DATABASE_URL`: `postgres://` or `postgresql://` URL.
- `REDIS_URL`: `redis://` or `rediss://` URL, including the configured password.
- `BETTER_AUTH_SECRET`: trimmed secret with at least 32 characters.
- `BETTER_AUTH_URL`: Better Auth HTTP(S) endpoint; HTTPS is required in production.
- `APP_URL`: application HTTP(S) origin; HTTPS is required in production.

## Run the application

```bash
npm run dev
```

Open [http://localhost:3000/en](http://localhost:3000/en) for English or [http://localhost:3000/zh](http://localhost:3000/zh) for Simplified Chinese. Unsupported locale paths return a 404 response.

## Checks

```bash
npm run test
npm run lint
npm run build
```
