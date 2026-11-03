# FoodScope — Pakistani Food-Business Directory

A public directory of Pakistani food businesses (not a single-restaurant site).
Only approved vendors with a current, unexpired subscription appear publicly.

## Stack

- Node.js 24+, native `node:http` + `node:sqlite` only — **no external dependencies, no `npm install` needed**
- Port **3010** (override with `PORT`)
- SQLite file `foodscope.sqlite` (WAL mode, foreign keys ON) — git-ignored
- Single-page frontend: `public/index.html` + `public/app.js` + `public/styles.css`
- Dark-mode dashboard style with blue accents, left sidebar, animated counters,
  activity chart, WebAudio click sounds and a voice-tour button (sound on/off toggle).
  No cream/red/gold styling.

## Run locally (exact steps)

```bat
cd foodscope
node server.js
```

Or on Windows, double-click `START_FOODSCOPE_APP.bat`.

Then open **http://localhost:3010**

- Public directory: `#/` (hash routes: `#/`, `#/vendor/:id`, `#/about`,
  `#/contact`, `#/privacy`, `#/terms`, `#/admin`, plus `#/login`, `#/register`, `#/manager`)
- Health check: `http://localhost:3010/api/health`

The database is created and seeded automatically on first run.

## Portal Admin login (demo — CHANGE AFTER FIRST LOGIN)

- Name: **M. Hashir**
- Email: **mhkh3200@gmail.com**
- Demo password: **FoodScope@2026!Admin**
- Role: owner (Portal Admin)

> ⚠️ This demo password is only for local setup. Change it after your first
> login (or replace the seeded owner row) before any shared/public deployment.

Seeded manager accounts (for testing) use password `Manager@2026!`
(e.g. `chapli.house.peshawar@gmail.com`); seeded customer accounts use
`Customer@2026!`. Seeded vendors include approved listings in Peshawar,
Karachi (Burns Road), Lahore and Islamabad, plus two pending listings that
correctly do **not** appear publicly.

## Verification codes — development mode only

**No real SMTP/SMS delivery is implemented or claimed.** In development mode
(`NODE_ENV` not set to `production`), the 6-digit verification code — and the
manager login OTP code — is returned in the API response and shown on screen
so you can complete registration/login locally. In production mode the code
is not returned; wire a real email/SMS provider before going live.

## How the product works

### Public
Browse approved vendors only: status `approved` or `pending_update`, open,
previously approved, and with an unexpired subscription. Search + category +
city filters, vendor detail with menu (PKR prices), gallery, delivery details,
Google Maps link, and ratings (food, hygiene, value, overall, and delivery
only when the vendor offers delivery). Contact form (name, valid email,
subject, 10+ character message) and newsletter form (valid email) are
rate-limited: contact 4 per 30 min, newsletter 5 per 30 min (per IP).

### Customers
Register with **exactly one** contact channel — email OR phone, never both.
Verify with a 6-digit code, 30-day session, one active review per vendor.
Visitors (logged in or not) can flag reviews for moderation.

### Managers
Register, verify, then log in with an OTP code. Subscription plans:
Basic 30 days PKR 1,500 / Premium 90 days PKR 4,500 / Featured 90 days
PKR 9,000. Payment methods: Bank Transfer, Easypaisa, JazzCash, Sadapay,
Nayapay, Manual Reference. Payment proof and legal certificate uploads
accept PNG/JPEG/PDF only, with MIME + file-signature + 5 MB size checks,
stored under `uploads/` (git-ignored). Exactly **one** vendor submission
per manager. Vendor lifecycle: pending → approved → pending_update →
rejected / suspended. Sensitive fields (name, Google Maps URL, delivery
phone, primary image URL, banner URL, slug) change only via admin-approved
update requests. An expired subscription hides/locks the listing until renewal.

### Portal Admin (owner)
Approve/reject payments, certificates, vendors, updates and images; suspend
vendors; platform reports (totals, top 5 by rating, top 5 by review count,
category totals); audit log; manage manager accounts (suspend/activate);
emergency vendor edit/delete — both require a safety reason and are
audit-logged.

### Staff
Restricted to their assigned vendor, menu/availability only. Staff cannot
edit vendor details, payments or admin routes.

### Roles are enforced server-side
Every `/api/manager/*`, `/api/staff/*` and `/api/admin/*` route checks the
session's server-side role — browser-supplied IDs are never trusted.

### Review safety scan
Rule-based scan (profanity/abuse, threats, spam, exposed contact info,
repeated characters, short low-context) flags a review at score ≥ 40.
Admins can add a note, reply, or soft-delete; only an admin can restore.

### Security
PBKDF2-SHA-256 passwords (random salt, 210,000 iterations), hashed session
tokens (HttpOnly, SameSite=Lax cookies, 30 days), CSRF tokens on mutations
(fetch `GET /api/csrf`, send `X-CSRF-Token`; auth bootstrap routes exempt),
prepared SQL statements, foreign keys ON, WAL mode.

## API quick reference

| Route | Notes |
|---|---|
| `GET /api/health` | Liveness |
| `GET /api/vendors?q&category&city` | Public approved vendors only |
| `GET /api/vendors/:id` | Public vendor detail (menu, gallery, reviews) |
| `POST /api/contact`, `POST /api/newsletter` | Rate-limited public forms |
| `POST /api/auth/register-customer` | Exactly one contact channel |
| `POST /api/auth/register-manager` | Manager signup |
| `POST /api/auth/verify` | 6-digit code |
| `POST /api/auth/login` | Managers get an OTP step (`login-verify`) |
| `POST /api/reviews` | Customer, one active review per vendor |
| `POST /api/reviews/:id/flag` | Visitor flagging |
| `GET/POST /api/manager/*` | Manager panel |
| `GET/POST /api/staff/*` | Staff, assigned vendor only |
| `GET/POST /api/admin/*` | Owner only: vendors, payments, certificates, updates, gallery, reviews, reports, audit log, users |

## Files

```
server.js            All API + auth + validation
package.json         start: node server.js
public/index.html    SPA shell (dark dashboard, sidebar)
public/app.js        SPA routes, counters, chart, sounds, voice tour
public/styles.css    Dark theme, blue accents
sql/schema.sql       SQLite schema (also applied by server.js on boot)
.gitignore           Excludes .env, *.sqlite*, uploads/, node_modules/
START_FOODSCOPE_APP.bat  Windows one-click start
```
