// FoodScope test suite — HTTP end-to-end against a FRESH temp copy of the app.
// Run: node test.js   (exit 0 = all pass, exit 1 = failures)
// The suite copies server.js + public/ + sql/ into a temp dir so the real
// ~/workspace/foodscope/foodscope.sqlite is NEVER touched. All accounts use
// dummy credentials only. No GitHub, no live container.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = 3019;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = __dirname;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

// ---- tiny HTTP client with cookie jar ----
class Client {
  constructor() { this.cookies = {}; }
  async req(method, p, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (ck) headers.Cookie = ck;
    if (opts.csrf) headers['X-CSRF-Token'] = this.csrfToken;
    const res = await fetch(BASE + p, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookie) {
      const m = c.match(/^([^=]+)=([^;]*)/);
      if (m) this.cookies[m[1]] = decodeURIComponent(m[2]);
    }
    let json = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = { _text: text }; }
    return { status: res.status, json, text };
  }
  async csrf() {
    const r = await this.req('GET', '/api/csrf');
    this.csrfToken = r.json.csrfToken;
    return r;
  }
  async get(p) { return this.req('GET', p); }
  async post(p, body, useCsrf = true) { if (useCsrf) await this.csrf(); return this.req('POST', p, body, { csrf: useCsrf }); }
  async patch(p, body) { await this.csrf(); return this.req('PATCH', p, body, { csrf: true }); }
  async del(p, body) { await this.csrf(); return this.req('DELETE', p, body, { csrf: true }); }
}

// ---- boot a fresh copy ----
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodscope-test-'));
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'sql'), path.join(tmp, 'sql'), { recursive: true });
  const child = spawn('node', ['server.js'], {
    cwd: tmp, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    await waitForHealth();
    await runTests();
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(' - ' + f)); }
  process.exit(fail ? 1 : 0);
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.status === 200) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

async function runTests() {
  const anon = new Client();
  console.log('\n== public / health ==');
  let r = await anon.get('/api/health');
  eq('health 200 ok', r.json.ok, true);
  r = await fetch(BASE + '/');
  ok('homepage 200 html', r.status === 200 && (await r.text()).includes('FoodScope'));
  r = await anon.get('/api/plans');
  eq('plans: Basic 1500/30d', r.json.plans.Basic, { days: 30, price: 1500 });
  eq('plans: Featured 9000/90d', r.json.plans.Featured, { days: 90, price: 9000 });
  r = await anon.get('/api/categories');
  ok('categories include Karahi + BBQ', r.json.categories.includes('Karahi') && r.json.categories.includes('BBQ'));

  console.log('\n== public vendor listing (approved-only) ==');
  r = await anon.get('/api/vendors');
  eq('public vendors = 5 (2 pending hidden)', r.json.vendors.length, 5);
  ok('no pending vendor leaks', r.json.vendors.every((v) => v.status === 'approved' || v.status === 'pending_update'));
  ok('pending_update vendor 4 IS public', r.json.vendors.some((v) => v.id === 4));
  r = await anon.get('/api/vendors?q=nihari');
  eq('search nihari = 1', r.json.vendors.length, 1);
  r = await anon.get('/api/vendors?category=Karahi');
  eq('category Karahi = 1', r.json.vendors.length, 1);
  r = await anon.get('/api/vendors?city=Lahore');
  eq('city Lahore = 2', r.json.vendors.length, 2);
  r = await anon.get('/api/vendors?city=Nowhere');
  eq('city Nowhere = 0', r.json.vendors.length, 0);
  r = await anon.get('/api/vendors/6');
  eq('pending vendor detail = 404', r.status, 404);
  r = await anon.get('/api/vendors/999');
  eq('missing vendor detail = 404', r.status, 404);

  console.log('\n== vendor detail + ratings maths ==');
  r = await anon.get('/api/vendors/1');
  eq('vendor 1 menu items = 4', r.json.vendor.menu.length, 4);
  eq('vendor 1 menu prices PKR', r.json.vendor.menu.map((m) => m.price_pkr).sort((a, b) => a - b), [40, 380, 450, 850]);
  eq('vendor 1 reviews = 2', r.json.vendor.reviews.length, 2);
  eq('vendor 1 ratings count 2 overall 5.0', r.json.vendor.ratings, { count: 2, food: 5, hygiene: 4.5, value: 5, overall: 5, delivery: 4.5 });
  r = await anon.get('/api/vendors/5');
  eq('vendor 5 (no delivery) delivery rating null', r.json.vendor.ratings.delivery, null);
  ok('vendor 5 delivery_enabled false', r.json.vendor.delivery_enabled === false);

  console.log('\n== contact / newsletter ==');
  r = await anon.post('/api/contact', { name: 'Test', email: 'bad', subject: 'Hi', message: 'short' });
  eq('contact bad email = 400', r.status, 400);
  r = await anon.post('/api/contact', { name: 'Test User', email: 'test@example.com', subject: 'Hello', message: 'This is a proper test message.' });
  eq('contact valid = 201', r.status, 201);
  r = await anon.post('/api/newsletter', { email: 'news@example.com' });
  eq('newsletter = 201', r.status, 201);
  r = await anon.post('/api/newsletter', { email: 'news@example.com' });
  eq('newsletter duplicate = 200 idempotent', r.status, 200);
  r = await anon.req('POST', '/api/contact', { name: 'X', email: 'x@example.com', subject: 's', message: 'long enough message here' });
  eq('contact without CSRF = 403', r.status, 403);

  console.log('\n== customer register / verify / login / review flow ==');
  const cust = new Client();
  r = await cust.post('/api/auth/register-customer', { name: 'Test Customer', email: 'testcust@example.com', password: 'DummyPass1!' }, false);
  eq('register customer = 201 + dev code', r.status === 201 && typeof r.json.dev_code === 'string' && r.json.dev_code.length === 6, true);
  const custCode = r.json.dev_code;
  r = await cust.post('/api/auth/register-customer', { name: 'Both', email: 'both@example.com', phone: '03001234567', password: 'DummyPass1!' }, false);
  eq('register with both channels = 400', r.status, 400);
  r = await cust.post('/api/auth/verify', { identifier: 'testcust@example.com', code: '000000' }, false);
  eq('verify wrong code = 400', r.status, 400);
  r = await cust.post('/api/auth/verify', { identifier: 'testcust@example.com', code: custCode }, false);
  eq('verify correct code = 200', r.status, 200);
  r = await cust.post('/api/auth/login', { identifier: 'testcust@example.com', password: 'WrongPass1!' }, false);
  eq('login wrong password = 401', r.status, 401);
  r = await cust.post('/api/auth/login', { identifier: 'testcust@example.com', password: 'DummyPass1!' }, false);
  eq('login customer = 200 role customer', r.status === 200 && r.json.user.role === 'customer', true);
  r = await cust.get('/api/auth/me');
  eq('me returns customer', r.json.user && r.json.user.email, 'testcust@example.com');

  r = await cust.post('/api/reviews', { vendor_id: 6, food: 5, hygiene: 5, value: 5, overall: 5, comment: 'Should not be allowed on pending.' });
  eq('review on pending vendor = 404', r.status, 404);
  r = await cust.post('/api/reviews', { vendor_id: 1, food: 6, hygiene: 5, value: 5, overall: 5, comment: 'Rating out of range test here.' });
  eq('review rating 6 = 400', r.status, 400);
  r = await cust.post('/api/reviews', { vendor_id: 1, food: 5, hygiene: 5, value: 5, overall: 5, comment: 'short' });
  eq('review short comment = 400', r.status, 400);
  r = await cust.post('/api/reviews', { vendor_id: 5, food: 5, hygiene: 5, value: 5, overall: 5, delivery: 4, comment: 'Great mithai, fresh and tasty.' });
  eq('delivery rating on no-delivery vendor = 400', r.status, 400);
  r = await cust.post('/api/reviews', { vendor_id: 1, food: 4, hygiene: 4, value: 5, overall: 4, delivery: 5, comment: 'Great chapli kabab, fresh naan, quick service.' });
  eq('review submit = 201 active', r.status === 201 && r.json.status === 'active', true);
  const reviewId = r.json.reviewId;
  r = await cust.post('/api/reviews', { vendor_id: 1, food: 5, hygiene: 5, value: 5, overall: 5, comment: 'Trying to post a second review here.' });
  eq('second review same vendor = 409', r.status, 409);
  r = await anon.get('/api/vendors/1');
  eq('ratings count now 3 after new review', r.json.vendor.ratings.count, 3);
  eq('overall avg now (5+5+4)/3 = 4.7', r.json.vendor.ratings.overall, 4.7);
  ok('new review appears in detail', r.json.vendor.reviews.some((x) => x.id === reviewId && x.customer_name === 'Test Customer'));
  r = await cust.post('/api/reviews', { vendor_id: 1, food: 1, hygiene: 1, value: 1, overall: 1, comment: 'This review contains shit and should be flagged automatically by scan.' });
  eq('second review still 409 even if abusive', r.status, 409);

  // safety scan: fresh customer, abusive review gets flagged
  const cust2 = new Client();
  r = await cust2.post('/api/auth/register-customer', { name: 'Scan Test', email: 'scan@example.com', password: 'DummyPass1!' }, false);
  await cust2.post('/api/auth/verify', { identifier: 'scan@example.com', code: r.json.dev_code }, false);
  await cust2.post('/api/auth/login', { identifier: 'scan@example.com', password: 'DummyPass1!' }, false);
  r = await cust2.post('/api/reviews', { vendor_id: 2, food: 1, hygiene: 1, value: 1, overall: 1, comment: 'This place is bakwas and I will kill the owner, terrible food.' });
  eq('abusive review = 201 flagged', r.status === 201 && r.json.status === 'flagged', true);
  ok('flag score >= 40', r.json.flag_score >= 40);
  r = await anon.get('/api/vendors/2');
  eq('flagged review excluded from ratings count', r.json.vendor.ratings.count, 2);

  console.log('\n== review flagging (visitor) ==');
  r = await anon.post(`/api/reviews/${reviewId}/flag`, { reason: 'test flag' });
  eq('visitor flag = 200', r.status, 200);
  r = await anon.get('/api/vendors/1');
  ok('flagged review no longer counts in ratings', r.json.vendor.ratings.count === 2);

  console.log('\n== authz: role gates ==');
  r = await anon.get('/api/manager/vendor');
  eq('anon manager route = 401', r.status, 401);
  r = await cust.get('/api/admin/reports');
  eq('customer admin route = 403', r.status, 403);
  r = await cust.get('/api/manager/vendor');
  eq('customer manager route = 403', r.status, 403);

  console.log('\n== change password revokes other sessions ==');
  const custA = new Client(), custB = new Client();
  await custA.post('/api/auth/login', { identifier: 'testcust@example.com', password: 'DummyPass1!' }, false);
  await custB.post('/api/auth/login', { identifier: 'testcust@example.com', password: 'DummyPass1!' }, false);
  r = await custA.get('/api/auth/me');
  ok('session A alive before change', !!r.json.user);
  r = await custB.get('/api/auth/me');
  ok('session B alive before change', !!r.json.user);
  r = await custA.post('/api/auth/change-password', { old_password: 'WrongOld1!', new_password: 'NewDummyPass2!' });
  eq('change password wrong old = 401', r.status, 401);
  r = await custA.post('/api/auth/change-password', { old_password: 'DummyPass1!', new_password: 'short' });
  eq('change password short new = 400', r.status, 400);
  r = await custA.post('/api/auth/change-password', { old_password: 'DummyPass1!', new_password: 'NewDummyPass2!' });
  eq('change password = 200', r.status, 200);
  r = await custA.get('/api/auth/me');
  ok('own session survives password change', !!r.json.user);
  r = await custB.get('/api/auth/me');
  ok('other session revoked after password change', r.json.user === null);
  r = await custA.post('/api/auth/login', { identifier: 'testcust@example.com', password: 'NewDummyPass2!' }, false);
  eq('login with new password works', r.status, 200);

  console.log('\n== manager OTP login + vendor submit ==');
  const mgr = new Client();
  r = await mgr.post('/api/auth/register-manager', { name: 'Test Manager', email: 'testmgr@example.com', password: 'DummyPass1!' }, false);
  eq('register manager = 201', r.status, 201);
  const mgrCode = r.json.dev_code;
  await mgr.post('/api/auth/verify', { identifier: 'testmgr@example.com', code: mgrCode }, false);
  r = await mgr.post('/api/auth/login', { identifier: 'testmgr@example.com', password: 'DummyPass1!' }, false);
  eq('manager login asks OTP', r.status === 200 && r.json.otp_required === true && typeof r.json.dev_code === 'string', true);
  r = await mgr.post('/api/auth/login-verify', { login_token: r.json.login_token, code: '000000' }, false);
  eq('manager OTP wrong code = 400', r.status, 400);
  r = await mgr.post('/api/auth/login', { identifier: 'testmgr@example.com', password: 'DummyPass1!' }, false);
  const loginToken = r.json.login_token, otpCode = r.json.dev_code;
  r = await mgr.post('/api/auth/login-verify', { login_token: loginToken, code: otpCode }, false);
  eq('manager OTP correct = 200 role manager', r.status === 200 && r.json.user.role === 'manager', true);
  r = await mgr.get('/api/manager/vendor');
  eq('new manager has no vendor', r.json.vendor, null);
  r = await mgr.post('/api/manager/vendors', { name: 'Test Biryani House', category: 'NotACategory', city: 'Peshawar' });
  eq('vendor bad category = 400', r.status, 400);
  r = await mgr.post('/api/manager/vendors', { name: 'Test Biryani House', category: 'Desi', city: 'Peshawar', area: 'Hayatabad', delivery_enabled: true, delivery_fee_pkr: 100, min_order_pkr: 300 });
  eq('vendor submit = 201 pending', r.status === 201 && r.json.status === 'pending', true);
  const newVendorId = r.json.vendorId;
  r = await mgr.post('/api/manager/vendors', { name: 'Second Place', category: 'Desi', city: 'Lahore' });
  eq('second vendor per manager = 409', r.status, 409);
  r = await mgr.get('/api/manager/vendor');
  eq('manager sees own vendor', r.json.vendor && r.json.vendor.id === newVendorId, true);

  console.log('\n== manager: cross-vendor isolation ==');
  const mgr2 = new Client();
  r = await mgr2.post('/api/auth/register-manager', { name: 'Second Manager', email: 'testmgr2@example.com', password: 'DummyPass1!' }, false);
  await mgr2.post('/api/auth/verify', { identifier: 'testmgr2@example.com', code: r.json.dev_code }, false);
  r = await mgr2.post('/api/auth/login', { identifier: 'testmgr2@example.com', password: 'DummyPass1!' }, false);
  await mgr2.post('/api/auth/login-verify', { login_token: r.json.login_token, code: r.json.dev_code }, false);
  r = await mgr2.patch(`/api/manager/vendors/${newVendorId}`, { city: 'Karachi' });
  eq('manager B PATCH manager A vendor = 404', r.status, 404);
  r = await mgr2.post('/api/manager/payments', { plan: 'Basic', method: 'JazzCash', reference_text: 'TEST-1', vendor_id: newVendorId });
  eq('manager B payment attached to A vendor = 400/403', r.status === 400 || r.status === 403, true);
  r = await mgr2.post('/api/manager/certificates', { cert_type: 'Food Licence', vendor_id: newVendorId });
  eq('manager B certificate attached to A vendor = 400/403', r.status === 400 || r.status === 403, true);
  r = await mgr.post('/api/manager/payments', { plan: 'Basic', method: 'JazzCash', reference_text: 'TEST-OWN', vendor_id: newVendorId });
  eq('manager A payment on own vendor = 201 amount 1500', r.status === 201 && r.json.amount_pkr === 1500, true);
  const ownPaymentId = r.json.paymentId;
  r = await mgr.post('/api/manager/payments', { plan: 'Wrong', method: 'JazzCash', reference_text: 'x' });
  eq('payment bad plan = 400', r.status, 400);
  r = await mgr.post('/api/manager/payments', { plan: 'Basic', method: 'JazzCash', reference_text: 'x', proof_filename: 'p.png', proof_mimetype: 'image/png', proof_base64: Buffer.from('%PDF-fake').toString('base64') });
  eq('payment proof magic mismatch = 400', r.status, 400);
  r = await mgr.post('/api/manager/payments', { plan: 'Basic', method: 'JazzCash', reference_text: 'x', proof_filename: 'p.png', proof_mimetype: 'image/png', proof_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString('base64') });
  eq('payment proof valid PNG magic = 201', r.status, 201);

  console.log('\n== manager: sensitive fields + menu validation ==');
  r = await mgr.patch(`/api/manager/vendors/${newVendorId}`, { name: 'Hacked Name' });
  eq('PATCH sensitive field name = 400', r.status, 400);
  r = await mgr.patch(`/api/manager/vendors/${newVendorId}`, { description: 'Updated description', delivery_fee_pkr: -50 });
  eq('PATCH negative delivery fee = 400', r.status, 400);
  r = await mgr.patch(`/api/manager/vendors/${newVendorId}`, { description: 'Updated description', open: true });
  eq('PATCH non-sensitive = 200', r.status, 200);
  r = await mgr.post('/api/manager/menu', { name: 'Chicken Biryani', price_pkr: -100 });
  eq('menu negative price = 400', r.status, 400);
  r = await mgr.post('/api/manager/menu', { name: 'Chicken Biryani', price_pkr: 320, category: 'Desi' });
  eq('menu add = 201', r.status, 201);
  const menuId = r.json.menuId;
  r = await mgr.patch(`/api/manager/menu/${menuId}`, { price_pkr: -5 });
  eq('menu PATCH negative price = 400', r.status, 400);
  r = await mgr.patch(`/api/manager/menu/${menuId}`, { price_pkr: 350 });
  eq('menu PATCH price = 200', r.status, 200);
  r = await mgr.post('/api/manager/vendors/' + newVendorId + '/update-request', { name: 'Test Biryani House Updated' });
  eq('sensitive update request = 201', r.status, 201);
  r = await mgr.post('/api/manager/gallery', { url: 'https://example.com/photo.jpg', caption: 'test' });
  eq('gallery submit = 201 pending', r.status === 201 && r.json.status === 'pending', true);
  r = await mgr.post('/api/manager/staff', { name: 'Test Staff', email: 'teststaff@example.com', password: 'DummyPass1!' });
  eq('staff create = 201', r.status, 201);
  const staffId = r.json.staffId;

  console.log('\n== staff: assigned vendor only ==');
  const staff = new Client();
  r = await staff.post('/api/auth/login', { identifier: 'teststaff@example.com', password: 'DummyPass1!' }, false);
  eq('staff login = 200', r.status, 200);
  r = await staff.get('/api/staff/vendor');
  eq('staff sees assigned vendor', r.json.vendor && r.json.vendor.id === newVendorId, true);
  r = await staff.post('/api/staff/menu', { name: 'Staff Item', price_pkr: -10 });
  eq('staff menu negative price = 400', r.status, 400);
  r = await staff.post('/api/staff/menu', { name: 'Staff Item', price_pkr: 200 });
  eq('staff menu add = 201', r.status, 201);
  const staffMenuId = r.json.menuId;
  r = await staff.patch(`/api/staff/menu/${staffMenuId}`, { price_pkr: -1 });
  eq('staff menu PATCH negative = 400', r.status, 400);
  r = await staff.patch('/api/staff/menu/1', { price_pkr: 999 });
  eq('staff PATCH other vendor menu = 404', r.status, 404);
  r = await staff.get('/api/admin/reports');
  eq('staff admin route = 403', r.status, 403);

  console.log('\n== admin: approve flow end-to-end ==');
  const admin = new Client();
  r = await admin.post('/api/auth/login', { identifier: 'mhkh3200@gmail.com', password: 'FoodScope@2026!Admin' }, false);
  eq('admin login = 200 owner', r.status === 200 && r.json.user.role === 'owner', true);
  r = await admin.get('/api/admin/reports');
  eq('reports totals vendors_total = 8', r.json.totals.vendors_total, 8);
  ok('reports has top_by_rating + category_totals', Array.isArray(r.json.top_by_rating) && Array.isArray(r.json.category_totals));
  r = await admin.get('/api/admin/audit-log');
  ok('audit log non-empty', r.json.log.length > 0);
  r = await admin.get('/api/admin/vendors');
  eq('admin vendors list = 8', r.json.vendors.length, 8);
  r = await admin.post(`/api/admin/payments/${ownPaymentId}/approve`, {});
  eq('admin approve payment = 200', r.status, 200);
  r = await admin.post(`/api/admin/vendors/${newVendorId}/approve`, {});
  eq('admin approve vendor = 200', r.status, 200);
  r = await anon.get('/api/vendors');
  ok('newly approved+paid vendor now public', r.json.vendors.some((v) => v.id === newVendorId));
  eq('public vendors now 6', r.json.vendors.length, 6);
  r = await admin.post(`/api/admin/vendors/${newVendorId}/suspend`, {});
  eq('suspend without reason = 400', r.status, 400);
  r = await admin.post(`/api/admin/vendors/${newVendorId}/suspend`, { reason: 'test suspension' });
  eq('suspend with reason = 200', r.status, 200);
  r = await anon.get('/api/vendors');
  ok('suspended vendor hidden publicly', !r.json.vendors.some((v) => v.id === newVendorId));
  r = await admin.post(`/api/admin/vendors/${newVendorId}/unsuspend`, {});
  eq('unsuspend = 200', r.status, 200);
  r = await anon.get('/api/vendors');
  ok('unsuspended vendor public again', r.json.vendors.some((v) => v.id === newVendorId));
  r = await admin.post(`/api/admin/users/${staffId}/suspend`, {});
  eq('admin suspend staff user = 200', r.status, 200);
  r = await staff.get('/api/auth/me');
  ok('suspended staff session dead', r.json.user === null);
  r = await admin.post(`/api/admin/users/${staffId}/activate`, {});
  eq('admin activate staff user = 200', r.status, 200);
  r = await admin.post('/api/admin/users/1/suspend', {});
  eq('cannot suspend owner = 403', r.status, 403);
  r = await admin.get('/api/admin/activity');
  ok('activity endpoint returns rows', Array.isArray(r.json.activity));
  r = await admin.post(`/api/admin/reviews/${reviewId}/reply`, { reply: 'Thanks for visiting!' });
  eq('admin reply to review = 200', r.status, 200);
  r = await anon.get('/api/vendors/1');
  ok('admin reply visible on vendor detail', r.json.vendor.reviews.some((x) => x.admin_reply === 'Thanks for visiting!'));

  console.log('\n== rejected vendor resubmit + unsuspend of never-approved ==');
  r = await mgr2.post('/api/manager/vendors', { name: 'Second Manager Place', category: 'BBQ', city: 'Karachi' });
  eq('manager B vendor submit = 201', r.status, 201);
  const mgr2VendorId = r.json.vendorId;
  r = await admin.post(`/api/admin/vendors/${mgr2VendorId}/reject`, { reason: 'test rejection' });
  eq('admin reject vendor = 200', r.status, 200);
  r = await mgr2.post('/api/manager/vendors', { name: 'Second Manager Place v2', category: 'BBQ', city: 'Karachi' });
  eq('resubmit after rejection = 201 (not 409)', r.status, 201);
  r = await admin.post('/api/admin/vendors/6/suspend', { reason: 'test suspend of pending vendor' });
  eq('suspend pending vendor = 200', r.status, 200);
  r = await admin.post('/api/admin/vendors/6/unsuspend', {});
  eq('unsuspend never-approved vendor = 200', r.status, 200);
  r = await admin.get('/api/admin/vendors');
  ok('unsuspended never-approved vendor back to pending, not approved',
    r.json.vendors.find((v) => v.id === 6).status === 'pending');
  r = await anon.get('/api/vendors');
  ok('never-approved vendor still not public after unsuspend', !r.json.vendors.some((v) => v.id === 6));

  console.log('\n== flag rate limit ==');
  for (let i = 0; i < 4; i++) await anon.post(`/api/reviews/${reviewId}/flag`, { reason: 'rate test ' + i });
  r = await anon.post(`/api/reviews/${reviewId}/flag`, { reason: '6th flag in 30 min' });
  eq('6th flag within 30 min = 429', r.status, 429);

  console.log('\n== static assets ==');
  r = await fetch(BASE + '/app.js');
  ok('app.js 200', r.status === 200);
  r = await fetch(BASE + '/styles.css');
  ok('styles.css 200', r.status === 200);
  r = await fetch(BASE + '/nope.js');
  eq('unknown static = 404', r.status, 404);
  r = await fetch(BASE + '/api/nope');
  eq('unknown api = 404', r.status, 404);
}

main().catch((e) => { console.error('SUITE CRASH:', e); process.exit(1); });
