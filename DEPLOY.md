# FoodScope — Deploy Guide

FoodScope is a zero-dependency Node.js app (native `node:http` +
`node:sqlite` only). There is nothing to install: no `npm install` step,
no build step.

## Requirements

- **Node.js 24+** (`package.json` declares `"engines": { "node": ">=24" }`
  — `node:sqlite` (`DatabaseSync`) requires Node 24).
- No external dependencies, no database server. SQLite file is created
  and seeded automatically on first run.

## Start command

```bash
node server.js
# or
npm start
```

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3010` | Port the server listens on. Hosts that assign a port (Render, SnapDeploy) set this themselves. |
| `NODE_ENV` | _(unset = development)_ | **Set `NODE_ENV=production` on the host.** See below — this is the one variable that must be set correctly. |
| `NODE_VERSION` | — | `24` on Render (see `render.yaml`). Only needed where the host picks the Node version from an env var. |

### NODE_ENV=production — set it on the host, every deploy

**Set `NODE_ENV=production` on the host.** When `NODE_ENV` is anything
other than `production`, the app runs in development mode and the 6-digit
verification codes (customer/manager registration) **and** the manager
login OTP codes are returned in the API responses (`dev_code` field) and
shown on screen. That is intentional for local setup — there is no real
SMTP/SMS delivery — but on any shared or public deployment it would let
anyone complete registration/login for any account without access to the
email or phone. In production mode (`NODE_ENV=production`) the codes are
never returned; wire a real email/SMS provider before going live.

## Writable directory / data storage

The app writes two things at runtime: the SQLite database
(`foodscope.sqlite`) and uploaded files (`uploads/` — payment proof and
legal certificates, PNG/JPEG/PDF only, 5 MB max).

- On a normal PC/server the app directory is writable, so the database
  and uploads live next to `server.js` exactly as before.
- **Read-only app directory fallback (already in `server.js`):** if the
  app directory cannot be written (e.g. SnapDeploy's `/app`, which denied
  creating `/app/uploads` and `/app/foodscope.sqlite`), the database and
  uploads automatically move to a writable temp directory
  (`os.tmpdir()/foodscope`, i.e. `/tmp/foodscope` on Linux). The app logs
  `FoodScope data directory (read-only app dir fallback): ...` on startup
  when the fallback is active. No code or env change is needed for this.
- **Warning:** data under `/tmp` is ephemeral — it can disappear on a
  container restart/redeploy, taking the database and uploads with it.
  On a host that offers a persistent disk/volume, mount one and point the
  app directory at it (or keep the app directory itself writable) so the
  database survives restarts. Until then, treat a `/tmp`-fallback deploy
  as demo data only.

## Deploy settings

### Render (`render.yaml` — already in the repo)

- Type: `web`, Environment: `node`
- Build command: _(empty — nothing to build)_
- Start command: `node server.js`
- Env var: `NODE_VERSION: "24"`
- **Add on the Render dashboard:** `NODE_ENV=production` (and `PORT` is
  set automatically by Render).

### SnapDeploy

- Start command: `node server.js` (Node 24 image)
- Set `NODE_ENV=production` in the container's environment variables.
  `PORT` is assigned by the host — do not hard-code it.
- The read-only `/app` fallback above applies automatically; see the
  `/tmp` ephemerality warning before treating the deploy as permanent.

## First login after deploy

- Portal Admin (owner): **M. Hashir — mhkh3200@gmail.com**. Seeded demo
  accounts exist for local setup only; their passwords are set at seed
  time in `server.js` and are **not** documented in the README or anywhere
  else. **Change every seeded account's password after first login**
  (sidebar → Change password, or `#/account`) before any shared/public
  use. The seeded test manager is **M. Hashir — mhkhan943223@gmail.com**
  (verified, no vendor yet — for the end-to-end submit → pay → approve →
  public flow).
- No real email/SMS is wired: in production, verification/OTP codes are
  not delivered anywhere until a provider is connected (see
  `NODE_ENV=production` above).

## Smoke check after deploy

1. Open the site — the home page lists approved vendors only (Peshawar,
   Karachi, Lahore, Islamabad seeds; two pending listings must NOT appear).
2. `GET /api/plans` returns the three plans (Basic 30d PKR 1,500,
   Premium 90d PKR 4,500, Featured 90d PKR 9,000).
3. Registering a new account in production must NOT return a
   `dev_code` in the response.
4. Locally, the full suite covers all of this: `node test.js`
   (124 checks, fresh temp copy on port 3019, exit 0 = all green).
