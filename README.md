# FoodScope — Pakistani Food-Business Directory

A public directory of Pakistani food businesses (not a single-restaurant site).
Only approved vendors with a current, unexpired subscription appear publicly.

## Stack

- Node.js 24+, native `node:http` + `node:sqlite` only — **no external dependencies, no `npm install` needed**
- Port **3010** (override with `PORT`)
- SQLite file `foodscope.sqlite` (WAL mode, foreign keys ON) — git-ignored
- Single-page frontend: `public/index.html` + `public/app.js` + `public/styles.css`
- Food-app frontend (final version): Foodpanda-style public home — hero with
  big search bar and city selector, horizontally scrolling category rail with
  arrows, vendor cards in horizontal scrolling rows with large photos, plus a
  full grid below. Cheezious-style theme: near-black background (#0d0d0d),
  bold red primary (#e11d2e), golden yellow accent (#ffc107), clean white
  cards, bold headings. Manager, staff and Portal Admin panels use the same
  theme. Backend, APIs, auth, plans, payments, approvals and reviews are
  unchanged — only the frontend look changed. Animated counters, activity
  chart, WebAudio click sounds and a voice-tour button (sound on/off toggle)
  are kept.
- Deploy note: if the app directory is not writable (for example on
  SnapDeploy), the database and uploads fall back to a writable temp
  directory (`/tmp/foodscope`); on a normal PC the original `foodscope.sqlite`
  / `uploads/` paths are used. On such a host the database resets when the
  container restarts and seed data recreates.

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

## Tests

```bat
node test.js
```

Runs the full HTTP end-to-end suite (124 checks) against a **fresh temporary
copy** of the app on port 3019, so the real `foodscope.sqlite` is never
touched. Covers: approved-only public listing, search/category/city filters,
ratings maths, one-review-per-vendor, review safety scan + visitor flagging
(rate-limited: 5 flags per 30 min per IP), customer/manager OTP login,
change-password revoking other sessions, cross-manager isolation (a manager
cannot attach payments/certificates to another manager's vendor), menu and
fee validation (no negative PKR prices), the full admin approve → pay →
public flow, suspend/unsuspend (a never-approved vendor returns to pending,
never to approved), rejected-vendor resubmit, and audit logging. Exit 0 =
all green.

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

## Required manager account (fresh-DB verified)

- Name: **M. Hashir**
- Email: **mhkhan943223@gmail.com**
- Password: **Manager@2026!** (change after first login)
- Role: manager, verified, with **no vendor yet** — so this account can submit
  a vendor end-to-end (submit → payment → menu → admin approval → public).

## Change password (admin, manager, customer, staff)

Log in, then open **Change password** in the sidebar (or `#/account`).
Enter the old password and a new password of 8+ characters.
The endpoint is `POST /api/auth/change-password` — authenticated only,
CSRF-protected, old-password checked; it keeps your current session and
revokes your other sessions. Demo passwords above must still be changed
after first login.

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
Visitors (logged in or not) can flag reviews for moderation — 5 flags per
30 minutes per IP, so one visitor cannot mass-flag reviews out of the
public averages.

### Managers
Register, verify, then log in with an OTP code. Subscription plans:
Basic 30 days PKR 1,500 / Premium 90 days PKR 4,500 / Featured 90 days
PKR 9,000. Payment methods: Bank Transfer, Easypaisa, JazzCash, Sadapay,
Nayapay, Manual Reference. Payment proof and legal certificate uploads
accept PNG/JPEG/PDF only, with MIME + file-signature + 5 MB size checks,
stored under `uploads/` (git-ignored). Exactly **one** vendor submission
per manager — except a rejected vendor, which the manager may resubmit from
scratch. A payment or certificate may only name the manager's own vendor.
Vendor lifecycle: pending → approved → pending_update →
rejected / suspended. Sensitive fields (name, Google Maps URL, delivery
phone, primary image URL, banner URL, slug) change only via admin-approved
update requests; all other details (description, area, address, city,
category, open/closed, delivery fee, minimum order, delivery time) are
editable directly from the manager panel. An expired subscription hides/locks the listing until renewal.

### Portal Admin (owner)
Approve/reject payments, certificates, vendors, updates and images; suspend
vendors (unsuspend returns a never-approved vendor to pending, not to
approved); platform reports (totals, top 5 by rating, top 5 by review count,
category totals, reviews-per-day activity); audit log; manage manager accounts (suspend/activate);
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
test.js              Full HTTP end-to-end suite (fresh temp copy, port 3019)
package.json         start: node server.js
public/index.html    SPA shell (food-app home: hero, category rail, card rows)
public/app.js        SPA routes, counters, chart, sounds, voice tour
public/styles.css    Black/red/yellow food-app theme (see above)
sql/schema.sql       SQLite schema (also applied by server.js on boot)
.gitignore           Excludes .env, *.sqlite*, uploads/, node_modules/
START_FOODSCOPE_APP.bat  Windows one-click start
```
