// FoodScope — Pakistani food-business directory
// Node.js 24+, native node:http + node:sqlite ONLY. No external dependencies.
// Run: node server.js  (port 3010, or PORT env)
// Dev mode: verification codes are returned in API responses ONLY when
// NODE_ENV is not 'production' (DEV_CODE_IN_RESPONSE). No real SMTP/SMS is used.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3010);
const ROOT = __dirname;
// Deploy-only writable-location fallback (no behaviour change on a normal PC):
// on a local run ROOT is writable, so the original paths below are used exactly
// as before. Only when ROOT cannot be written (e.g. SnapDeploy's /app, which
// denied creating /app/uploads and /app/foodscope.sqlite) do the database and
// uploads move to a writable temp directory. No API, schema or seed changes.
const os = require('node:os');
function writableBase() {
  try { fs.accessSync(ROOT, fs.constants.W_OK); return ROOT; }
  catch { return path.join(os.tmpdir(), 'foodscope'); }
}
const DATA_ROOT = writableBase();
const DB_PATH = path.join(DATA_ROOT, 'foodscope.sqlite');
const UPLOAD_DIR = path.join(DATA_ROOT, 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEV = process.env.NODE_ENV !== 'production';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (DATA_ROOT !== ROOT) console.log('FoodScope data directory (read-only app dir fallback):', DATA_ROOT);

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode=WAL;");
db.exec("PRAGMA foreign_keys=ON;");
const schemaPath = path.join(ROOT, 'sql', 'schema.sql');
if (fs.existsSync(schemaPath)) db.exec(fs.readFileSync(schemaPath, 'utf8'));

const PLANS = {
  Basic: { days: 30, price: 1500 },
  Premium: { days: 90, price: 4500 },
  Featured: { days: 90, price: 9000 },
};
const PAYMENT_METHODS = ['Bank Transfer', 'Easypaisa', 'JazzCash', 'Sadapay', 'Nayapay', 'Manual Reference'];
const CATEGORIES = ['Desi', 'BBQ', 'Karahi', 'Fast Food', 'Sweets', 'Chinese', 'Bakery', 'Beverages'];
const SENSITIVE_FIELDS = ['name', 'google_maps_url', 'delivery_phone', 'primary_image_url', 'banner_url', 'slug'];
const NON_SENSITIVE_VENDOR_FIELDS = ['category', 'city', 'area', 'address', 'description', 'open', 'delivery_enabled', 'delivery_fee_pkr', 'min_order_pkr', 'delivery_time'];

// ---------- helpers ----------
function nowISO() { return new Date().toISOString(); }
function addDaysISO(days) { return new Date(Date.now() + days * 86400000).toISOString(); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function randToken(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }
function randCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
}
function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vendor';
}
function isEmail(s) { return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim()); }
function isPhonePK(s) {
  if (typeof s !== 'string') return false;
  const t = s.replace(/[\s-]/g, '');
  return /^(03\d{9}|\+92\d{10}|92\d{10})$/.test(t);
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, opts = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  if (opts.httpOnly) c += '; HttpOnly';
  if (opts.maxAge) c += `; Max-Age=${opts.maxAge}`;
  if (opts.expires) c += `; Expires=${opts.expires}`;
  const prev = res.getHeader('Set-Cookie');
  if (prev) res.setHeader('Set-Cookie', Array.isArray(prev) ? [...prev, c] : [prev, c]);
  else res.setHeader('Set-Cookie', c);
}
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 6 * 1024 * 1024) { req.destroy(); reject(new Error('Body too large')); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw }); }
    });
    req.on('error', reject);
  });
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, verified: !!u.verified, status: u.status };
}
function audit(actor, action, targetType, targetId, reason, details) {
  try {
    db.prepare('INSERT INTO audit_log (actor_id, actor_role, action, target_type, target_id, reason, details) VALUES (?,?,?,?,?,?,?)')
      .run(actor ? actor.id : null, actor ? actor.role : null, action, targetType || null, targetId || null, reason || null, details ? JSON.stringify(details) : null);
  } catch { /* audit must never break the request */ }
}
// Rate limiting (in-memory, per IP + key): contact 4/30min, newsletter 5/30min
const rateBuckets = new Map();
function rateLimit(ip, key, max, windowMs) {
  const now = Date.now();
  const k = ip + ':' + key;
  const arr = (rateBuckets.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now); rateBuckets.set(k, arr); return true;
}
const loginOtpStore = new Map(); // login_token -> {userId, codeHash, expiresAt}
// ---------- review safety scan ----------
const PROFANITY = ['bakwas', 'harami', 'chutiya', 'bhenchod', 'madarchod', 'lanat', 'haramzada', 'kutta', 'idiot', 'stupid', 'shit', 'fuck', 'bitch', 'bastard', 'damn'];
const THREATS = ['kill', 'mar dunga', 'maar dunga', 'jaan se mar', 'bomb', 'i will kill', 'threat', 'attack you', 'goli'];
function scanReview(comment) {
  const text = String(comment || '');
  const low = text.toLowerCase();
  let score = 0; const reasons = [];
  for (const w of PROFANITY) if (low.includes(w)) { score += 25; reasons.push('profanity/abuse: ' + w); break; }
  for (const w of THREATS) if (low.includes(w)) { score += 30; reasons.push('threat: ' + w); break; }
  if (/https?:\/\/|www\./i.test(text)) { score += 25; reasons.push('spam: link'); }
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) { score += 25; reasons.push('exposed contact: email'); }
  if (/(03\d{9}|\+92\d{10})/.test(text.replace(/[\s-]/g, ''))) { score += 25; reasons.push('exposed contact: phone'); }
  if (/(.)\1{4,}/.test(text)) { score += 15; reasons.push('repeated characters'); }
  if (text.trim().length < 15) { score += 20; reasons.push('short low-context'); }
  if (/(free|discount|promo|click|whatsapp|order now).{0,20}(free|discount|promo|click|whatsapp)/i.test(text)) { score += 20; reasons.push('spam pattern'); }
  return { score, reasons };
}
// ---------- uploads (base64 JSON) ----------
const ALLOWED_UPLOADS = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
  'application/pdf': Buffer.from('%PDF'),
};
function saveUpload({ filename, mimetype, base64 }) {
  if (!filename || !mimetype || !base64) return { error: 'filename, mimetype and base64 are required' };
  if (!ALLOWED_UPLOADS[mimetype]) return { error: 'Only PNG, JPEG or PDF uploads are allowed' };
  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0 || buf.length > 5 * 1024 * 1024) return { error: 'Upload must be non-empty and under 5 MB' };
  const magic = ALLOWED_UPLOADS[mimetype];
  if (!buf.subarray(0, magic.length).equals(magic)) return { error: 'File signature does not match its declared type' };
  const ext = mimetype === 'application/pdf' ? 'pdf' : mimetype === 'image/png' ? 'png' : 'jpg';
  const name = randToken(12) + '.' + ext;
  const full = path.join(UPLOAD_DIR, name);
  fs.writeFileSync(full, buf);
  return { path: 'uploads/' + name, mimetype };
}
// ---------- vendor visibility / ratings ----------
function isPublicVendor(v) {
  if (!v) return false;
  if (v.status !== 'approved' && v.status !== 'pending_update') return false;
  if (!v.open) return false;
  if (!v.approved_at) return false;
  if (!v.subscription_expires_at) return false;
  if (new Date(v.subscription_expires_at).getTime() <= Date.now()) return false;
  return true;
}
function vendorRatings(vendorId) {
  const rows = db.prepare("SELECT food, hygiene, value_rating, overall, delivery FROM reviews WHERE vendor_id=? AND status='active'").all(vendorId);
  if (!rows.length) return { count: 0, food: null, hygiene: null, value: null, overall: null, delivery: null };
  const avg = (k) => {
    const vals = rows.map((r) => r[k]).filter((x) => x != null);
    if (!vals.length) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  };
  return { count: rows.length, food: avg('food'), hygiene: avg('hygiene'), value: avg('value_rating'), overall: avg('overall'), delivery: avg('delivery') };
}
function vendorPublic(v) {
  return {
    id: v.id, name: v.name, slug: v.slug, category: v.category, city: v.city, area: v.area,
    address: v.address, description: v.description, delivery_phone: v.delivery_phone,
    google_maps_url: v.google_maps_url, primary_image_url: v.primary_image_url, banner_url: v.banner_url,
    status: v.status, open: !!v.open, delivery_enabled: !!v.delivery_enabled,
    delivery_fee_pkr: v.delivery_fee_pkr, min_order_pkr: v.min_order_pkr, delivery_time: v.delivery_time,
    subscription_plan: v.subscription_plan, ratings: vendorRatings(v.id),
  };
}
function vendorDetail(v) {
  const out = vendorPublic(v);
  out.menu = db.prepare('SELECT * FROM menu_items WHERE vendor_id=? ORDER BY category, name').all(v.id)
    .map((m) => ({ ...m, available: !!m.available }));
  out.gallery = db.prepare("SELECT * FROM gallery_items WHERE vendor_id=? AND status='approved' ORDER BY id").all(v.id);
  out.reviews = db.prepare("SELECT r.*, u.name AS customer_name FROM reviews r JOIN users u ON u.id=r.customer_id WHERE r.vendor_id=? AND r.status IN ('active','flagged') ORDER BY r.created_at DESC").all(v.id)
    .map((r) => ({ id: r.id, customer_name: r.customer_name, food: r.food, hygiene: r.hygiene, value: r.value_rating, overall: r.overall, delivery: r.delivery, comment: r.comment, status: r.status, admin_reply: r.admin_reply, created_at: r.created_at }));
  return out;
}
function getSessionUser(req) {
  const cookies = parseCookies(req);
  const token = cookies.fs_session;
  if (!token) return { user: null, session: null, cookies };
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(sha256(token));
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return { user: null, session: null, cookies };
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id);
  if (!user || user.status === 'suspended') return { user: null, session: null, cookies };
  return { user, session: row, cookies };
}
function requireAuth(req, res, roles) {
  const { user, session } = getSessionUser(req);
  if (!user) { sendJSON(res, 401, { error: 'Login required' }); return null; }
  if (roles && !roles.includes(user.role)) { sendJSON(res, 403, { error: 'Forbidden for role ' + user.role }); return null; }
  return { user, session };
}
function requireCsrf(req, res, session) {
  const cookies = parseCookies(req);
  const header = req.headers['x-csrf-token'];
  const cookieVal = cookies.fs_csrf;
  const ok = header && cookieVal && header === cookieVal;
  const okSession = session && header && header === session.csrf_token;
  if (!ok && !okSession) { sendJSON(res, 403, { error: 'Invalid CSRF token. Fetch GET /api/csrf first and send X-CSRF-Token.' }); return false; }
  return true;
}
const CSRF_EXEMPT = new Set(['/api/auth/login', '/api/auth/register-customer', '/api/auth/register-manager', '/api/auth/verify', '/api/auth/request-code', '/api/auth/login-verify']);
function isMutation(method, pathname) { return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method); }

// ---------- seed ----------
function createUserSeed({ name, email, phone, contact_type, role, password, verified }) {
  const salt = randToken(16);
  const r = db.prepare('INSERT INTO users (name,email,phone,contact_type,role,password_hash,salt,verified) VALUES (?,?,?,?,?,?,?,?)')
    .run(name, email || null, phone || null, contact_type || null, role, hashPassword(password, salt), salt, verified ? 1 : 0);
  return Number(r.lastInsertRowid);
}
function seed() {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count > 0) return;
  console.log('Seeding FoodScope...');
  const adminId = createUserSeed({ name: 'M. Hashir', email: 'mhkh3200@gmail.com', contact_type: 'email', role: 'owner', password: 'FoodScope@2026!Admin', verified: 1 });
  // Managers (one vendor each)
  const mgr = {};
  mgr.chapli = createUserSeed({ name: 'Khan Bahadur', email: 'chapli.house.peshawar@gmail.com', contact_type: 'email', role: 'manager', password: 'Manager@2026!', verified: 1 });
  mgr.burns = createUserSeed({ name: 'Syed Imran Ali', email: 'burns.nihari.karachi@gmail.com', contact_type: 'email', role: 'manager', password: 'Manager@2026!', verified: 1 });
  mgr.lahore = createUserSeed({ name: 'Malik Naveed', email: 'lahore.karahi.house@gmail.com', contact_type: 'email', role: 'manager', password: 'Manager@2026!', verified: 1 });
  mgr.isb = createUserSeed({ name: 'Ahmed Faraz', email: 'islamabad.grill@gmail.com', contact_type: 'email', role: 'manager', password: 'Manager@2026!', verified: 1 });
  mgr.sweets = createUserSeed({ name: 'Haji Rafiq', email: 'sweet.palace.lahore@gmail.com', contact_type: 'email', role: 'manager', password: 'Manager@2026!', verified: 1 });
  mgr.pending1 = createUserSeed({ name: 'Bilal Sheikh', email: 'bilal.fastfood.khi@gmail.com', contact_type: 'email', role: 'manager', password: 'Manager@2026!', verified: 1 });
  mgr.pending2 = createUserSeed({ name: 'Usman Ghani', email: 'usman.chinese.isb@gmail.com', contact_type: 'email', role: 'manager', password: 'Manager@2026!', verified: 1 });
  // Required manager account (verified 2026-11-03 on the VM test copy, re-seeded here
  // so it works on a fresh DB). Intentionally has NO vendor yet, so the manager can
  // submit one end-to-end. Name is M. Hashir — the admin name is M. Hashir everywhere.
  mgr.hashir = createUserSeed({ name: 'M. Hashir', email: 'mhkhan943223@gmail.com', contact_type: 'email', role: 'manager', password: 'Manager@2026!', verified: 1 });
  // Customers
  const cust = {};
  const customers = [
    ['Ahmed Raza', 'ahmed.raza.khi@gmail.com'], ['Fatima Khan', 'fatima.khan.lhr@gmail.com'],
    ['Bilal Hussain', 'bilal.hussain.psh@gmail.com'], ['Ayesha Siddiqui', 'ayesha.siddiqui.isb@gmail.com'],
    ['Usman Tariq', 'usman.tariq.lhr@gmail.com'], ['Zainab Ali', 'zainab.ali.khi@gmail.com'],
    ['Hassan Javed', 'hassan.javed.psh@gmail.com'], ['Maryam Nawaz', null],
  ];
  for (const [n, e] of customers) {
    cust[n] = createUserSeed({ name: n, email: e, phone: e ? null : '03001234567', contact_type: e ? 'email' : 'phone', role: 'customer', password: 'Customer@2026!', verified: 1 });
  }
  const far = addDaysISO(120); // subscription comfortably in the future
  const insV = db.prepare(`INSERT INTO vendors (manager_id,name,slug,category,city,area,address,description,delivery_phone,google_maps_url,primary_image_url,banner_url,status,open,delivery_enabled,delivery_fee_pkr,min_order_pkr,delivery_time,subscription_plan,subscription_expires_at,approved_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const addMenu = db.prepare('INSERT INTO menu_items (vendor_id,name,description,price_pkr,category,available) VALUES (?,?,?,?,?,1)');
  const addGallery = db.prepare("INSERT INTO gallery_items (vendor_id,url,caption,status) VALUES (?,?,?,'approved')");
  const addReview = db.prepare('INSERT INTO reviews (vendor_id,customer_id,food,hygiene,value_rating,overall,delivery,comment) VALUES (?,?,?,?,?,?,?,?)');
  const addPay = db.prepare("INSERT INTO payments (manager_id,vendor_id,plan,amount_pkr,method,reference_text,status,decided_at) VALUES (?,?,?,?,?,?,'approved',datetime('now'))");

  // 1. Approved — Peshawar BBQ/Desi
  let id = Number(insV.run(mgr.chapli, 'Chapli Kabab House', 'chapli-kabab-house', 'BBQ', 'Peshawar', 'University Road', 'Main University Road, Peshawar', 'Famous Peshawari chapli kababs cooked on open flame, served with naan, salad and green chutney. Family seating available.', '03331234567', 'https://maps.google.com/?q=Chapli+Kabab+House+Peshawar', 'https://images.unsplash.com/photo-1603360946369-dc9bb6258143?w=800', 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=1200', 'approved', 1, 1, 150, 500, '30-45 min', 'Premium', far, nowISO()).lastInsertRowid);
  addMenu.run(id, 'Chapli Kabab (2 pcs)', 'Beef chapli kabab with tomato, onion and green chilli', 450, 'BBQ');
  addMenu.run(id, 'Chapli Kabab Platter', '4 kababs, naan, salad, raita and chutney', 850, 'BBQ');
  addMenu.run(id, 'Chicken Tikka', 'Charcoal-grilled chicken tikka, served hot', 380, 'BBQ');
  addMenu.run(id, 'Naan', 'Fresh tandoori naan', 40, 'Bread');
  addGallery.run(id, 'https://images.unsplash.com/photo-1603360946369-dc9bb6258143?w=800', 'Chapli kabab platter');
  addReview.run(id, cust['Bilal Hussain'], 5, 5, 5, 5, 4, 'Best chapli kabab in Peshawar. Fresh, juicy and properly spiced. The naan was fresh and service was quick.');
  addReview.run(id, cust['Hassan Javed'], 5, 4, 5, 5, 5, 'Visited with family on Sunday. Clean seating, generous portions and honest prices.');
  addPay.run(mgr.chapli, id, 'Premium', 4500, 'JazzCash', 'JAZZ-884120');

  // 2. Approved — Karachi Burns Road Desi
  id = Number(insV.run(mgr.burns, 'Burns Road Nihari', 'burns-road-nihari', 'Desi', 'Karachi', 'Burns Road', 'Burns Road, Saddar, Karachi', 'Slow-cooked beef nihari since decades, served with ginger, lemon and fresh naan. A Burns Road classic.', '03211234567', 'https://maps.google.com/?q=Burns+Road+Nihari+Karachi', 'https://images.unsplash.com/photo-1589302168068-964664d93dc0?w=800', 'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=1200', 'approved', 1, 1, 200, 600, '40-60 min', 'Featured', far, nowISO()).lastInsertRowid);
  addMenu.run(id, 'Beef Nihari (Single)', 'Slow-cooked nihari with gravy, ginger and lemon', 650, 'Desi');
  addMenu.run(id, 'Beef Nihari (Double)', 'Double portion for a full appetite', 1100, 'Desi');
  addMenu.run(id, 'Chicken Nihari', 'Lighter chicken nihari, same rich gravy', 550, 'Desi');
  addMenu.run(id, 'Naan', 'Tandoori naan', 50, 'Bread');
  addReview.run(id, cust['Ahmed Raza'], 5, 4, 4, 5, 4, 'Proper old Karachi taste. The gravy is rich and the meat falls off the bone. Worth the visit.');
  addReview.run(id, cust['Zainab Ali'], 4, 4, 5, 4, 4, 'Good nihari at a fair price. Delivery took a little longer on a busy evening but food arrived hot.');
  addPay.run(mgr.burns, id, 'Featured', 9000, 'Bank Transfer', 'TRF-99210');

  // 3. Approved — Lahore Karahi
  id = Number(insV.run(mgr.lahore, 'Lahore Karahi House', 'lahore-karahi-house', 'Karahi', 'Lahore', 'Food Street, Fort Road', 'Food Street, Fort Road, Lahore', 'Desi chicken and mutton karahi cooked in desi ghee, with fresh tomatoes and green chillies.', '03001239876', 'https://maps.google.com/?q=Lahore+Karahi+House+Food+Street', 'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=800', 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=1200', 'approved', 1, 1, 180, 800, '35-50 min', 'Premium', far, nowISO()).lastInsertRowid);
  addMenu.run(id, 'Chicken Karahi (Half)', 'Half chicken karahi in desi ghee', 950, 'Karahi');
  addMenu.run(id, 'Chicken Karahi (Full)', 'Full chicken karahi, serves 3-4', 1800, 'Karahi');
  addMenu.run(id, 'Mutton Karahi (Half)', 'Mutton karahi, slow cooked', 2200, 'Karahi');
  addMenu.run(id, 'Garlic Naan', 'Garlic butter naan', 80, 'Bread');
  addReview.run(id, cust['Fatima Khan'], 5, 5, 4, 5, 5, 'Excellent karahi, fresh ingredients and clean kitchen visible from seating. Highly recommended for families.');
  addReview.run(id, cust['Usman Tariq'], 4, 4, 4, 4, 4, 'Tasty and consistent. Slightly oily as expected for karahi, but flavour is very good.');
  addPay.run(mgr.lahore, id, 'Premium', 4500, 'Easypaisa', 'EASY-77120');

  // 4. Pending update — still public (approved before, update requested)
  id = Number(insV.run(mgr.isb, 'Islamabad Grill & Burgers', 'islamabad-grill-burgers', 'Fast Food', 'Islamabad', 'F-7 Markaz', 'Jinnah Super Market, F-7 Markaz, Islamabad', 'Grilled burgers, loaded fries and shakes. Dine-in and delivery across Islamabad.', '03151234567', 'https://maps.google.com/?q=Islamabad+Grill+Burgers+F7', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800', 'https://images.unsplash.com/photo-1571091718767-18b5b1457add?w=1200', 'pending_update', 1, 1, 150, 400, '25-40 min', 'Basic', far, nowISO()).lastInsertRowid);
  addMenu.run(id, 'Zinger Burger', 'Crispy chicken zinger with fries', 550, 'Burgers');
  addMenu.run(id, 'Beef Smash Burger', 'Double smashed beef patty, cheese and sauce', 750, 'Burgers');
  addMenu.run(id, 'Loaded Fries', 'Fries with chicken, cheese sauce and jalapenos', 450, 'Sides');
  addReview.run(id, cust['Ayesha Siddiqui'], 4, 5, 4, 4, 5, 'Clean place, fresh buns and quick delivery. The smash burger is the best item on the menu.');
  db.prepare('INSERT INTO vendor_update_requests (vendor_id,manager_id,fields_json,status) VALUES (?,?,?,?)')
    .run(id, mgr.isb, JSON.stringify({ primary_image_url: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800' }), 'pending');
  addPay.run(mgr.isb, id, 'Basic', 1500, 'Sadapay', 'SADA-55109');

  // 5. Approved — Sweets
  id = Number(insV.run(mgr.sweets, 'Sweet Palace Lahore', 'sweet-palace-lahore', 'Sweets', 'Lahore', 'Gulberg III', 'Main Boulevard, Gulberg III, Lahore', 'Fresh barfi, gulab jamun, jalebi and traditional mithai made daily. Gift boxes available.', '03007654321', 'https://maps.google.com/?q=Sweet+Palace+Lahore+Gulberg', 'https://images.unsplash.com/photo-1551024506-0bccd828d307?w=800', 'https://images.unsplash.com/photo-1589308078059-be1415eab4c3?w=1200', 'approved', 1, 0, 0, 300, '', 'Basic', far, nowISO()).lastInsertRowid);
  addMenu.run(id, 'Mix Barfi (1 kg)', 'Assorted fresh barfi', 1200, 'Mithai');
  addMenu.run(id, 'Gulab Jamun (1 kg)', 'Soft gulab jamun in light syrup', 900, 'Mithai');
  addMenu.run(id, 'Fresh Jalebi (500 g)', 'Crispy jalebi made to order', 450, 'Mithai');
  addReview.run(id, cust['Fatima Khan'], 5, 5, 5, 5, null, 'Fresh mithai, not overly sweet. The mix barfi box was perfect for a family visit.');
  addPay.run(mgr.sweets, id, 'Basic', 1500, 'Nayapay', 'NAYA-33187');

  // 6 & 7. Pending — NOT public
  id = Number(insV.run(mgr.pending1, 'Karachi Fast Bites', 'karachi-fast-bites', 'Fast Food', 'Karachi', 'Gulshan-e-Iqbal', 'Main University Road, Gulshan-e-Iqbal, Karachi', 'Burgers, broast and rolls for quick evening meals.', '03337654321', 'https://maps.google.com/?q=Karachi+Fast+Bites', '', '', 'pending', 1, 1, 120, 300, '20-35 min', null, null, null).lastInsertRowid);
  addMenu.run(id, 'Chicken Broast (2 pcs)', 'Crispy broast with fries', 480, 'Fast Food');
  id = Number(insV.run(mgr.pending2, 'Islamabad Chinese Corner', 'islamabad-chinese-corner', 'Chinese', 'Islamabad', 'G-9 Markaz', 'G-9 Markaz, Islamabad', 'Chinese rice, noodles and Manchurian with local taste.', '03119876543', 'https://maps.google.com/?q=Islamabad+Chinese+Corner', '', '', 'pending', 1, 1, 150, 500, '30-45 min', null, null, null).lastInsertRowid);
  addMenu.run(id, 'Chicken Chowmein', 'Chicken noodles with vegetables', 600, 'Chinese');
  audit({ id: adminId, role: 'owner' }, 'seed', 'system', null, 'Initial seed data');
  console.log('Seed complete. Admin: mhkh3200@gmail.com');
}
seed();

// ---------- HTTP ----------
function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  const safe = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  const full = path.join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    if (pathname.startsWith('/uploads/')) {
      const rel = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
      const uf = path.join(DATA_ROOT, rel);
      if (uf.startsWith(DATA_ROOT) && fs.existsSync(uf)) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        fs.createReadStream(uf).pipe(res); return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
  }
  const ext = path.extname(full);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const method = req.method;
    const ip = req.socket.remoteAddress || 'unknown';
    if (pathname.startsWith('/api/')) {
      // CSRF gate for mutations (except auth bootstrap)
      if (isMutation(method, pathname) && !CSRF_EXEMPT.has(pathname)) {
        const { session } = getSessionUser(req);
        if (!requireCsrf(req, res, session)) return;
      }
      const body = isMutation(method, pathname) ? await readBody(req) : {};
      // ---- meta ----
      if (method === 'GET' && pathname === '/api/health') return sendJSON(res, 200, { ok: true, service: 'foodscope', time: nowISO() });
      if (method === 'GET' && pathname === '/api/csrf') {
        const token = randToken(16);
        setCookie(res, 'fs_csrf', token);
        return sendJSON(res, 200, { csrfToken: token });
      }
      if (method === 'GET' && pathname === '/api/plans') return sendJSON(res, 200, { plans: PLANS, methods: PAYMENT_METHODS, categories: CATEGORIES });
      if (method === 'GET' && pathname === '/api/categories') return sendJSON(res, 200, { categories: CATEGORIES });
      // ---- auth ----
      if (method === 'POST' && pathname === '/api/auth/register-customer') {
        const { name, email, phone, password } = body;
        if (!name || !password || password.length < 8) return sendJSON(res, 400, { error: 'Name and a password of 8+ characters are required' });
        const hasEmail = !!email, hasPhone = !!phone;
        if (hasEmail === hasPhone) return sendJSON(res, 400, { error: 'Register with exactly ONE contact channel: email OR phone, never both' });
        if (hasEmail && !isEmail(email)) return sendJSON(res, 400, { error: 'Valid email required' });
        if (hasPhone && !isPhonePK(phone)) return sendJSON(res, 400, { error: 'Valid Pakistani phone required (03XXXXXXXXX)' });
        const code = randCode();
        const salt = randToken(16);
        try {
          const r = db.prepare('INSERT INTO users (name,email,phone,contact_type,role,password_hash,salt,verification_code_hash,verification_expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(name.trim(), hasEmail ? email.trim() : null, hasPhone ? phone.trim() : null, hasEmail ? 'email' : 'phone', 'customer', hashPassword(password, salt), salt, sha256(code), new Date(Date.now() + 15 * 60000).toISOString());
          const out = { ok: true, userId: Number(r.lastInsertRowid), message: 'Account created. Enter the verification code to activate it.' };
          if (DEV) out.dev_code = code; // DEVELOPMENT ONLY — no real SMS/email is sent
          return sendJSON(res, 201, out);
        } catch (e) { return sendJSON(res, 409, { error: 'That email or phone is already registered' }); }
      }
      if (method === 'POST' && pathname === '/api/auth/register-manager') {
        const { name, email, password } = body;
        if (!name || !isEmail(email) || !password || password.length < 8) return sendJSON(res, 400, { error: 'Name, valid email and 8+ character password are required' });
        const code = randCode();
        const salt = randToken(16);
        try {
          const r = db.prepare('INSERT INTO users (name,email,contact_type,role,password_hash,salt,verification_code_hash,verification_expires_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(name.trim(), email.trim(), 'email', 'manager', hashPassword(password, salt), salt, sha256(code), new Date(Date.now() + 15 * 60000).toISOString());
          const out = { ok: true, userId: Number(r.lastInsertRowid), message: 'Manager account created. Verify with the code to continue.' };
          if (DEV) out.dev_code = code;
          return sendJSON(res, 201, out);
        } catch (e) { return sendJSON(res, 409, { error: 'That email is already registered' }); }
      }
      if (method === 'POST' && pathname === '/api/auth/verify') {
        const { identifier, code } = body;
        if (!identifier || !code) return sendJSON(res, 400, { error: 'Identifier and code required' });
        const u = db.prepare('SELECT * FROM users WHERE email=? OR phone=?').get(identifier, identifier);
        if (!u) return sendJSON(res, 404, { error: 'Account not found' });
        if (u.verified) return sendJSON(res, 200, { ok: true, message: 'Already verified' });
        if (!u.verification_code_hash || u.verification_code_hash !== sha256(String(code)) || new Date(u.verification_expires_at).getTime() < Date.now())
          return sendJSON(res, 400, { error: 'Invalid or expired code' });
        db.prepare('UPDATE users SET verified=1, verification_code_hash=NULL WHERE id=?').run(u.id);
        audit(u, 'verify_account', 'user', u.id, null, null);
        return sendJSON(res, 200, { ok: true, message: 'Verified. You can now log in.' });
      }
      if (method === 'POST' && pathname === '/api/auth/request-code') {
        const { identifier } = body;
        const u = identifier ? db.prepare('SELECT * FROM users WHERE email=? OR phone=?').get(identifier, identifier) : null;
        if (!u) return sendJSON(res, 404, { error: 'Account not found' });
        const code = randCode();
        db.prepare('UPDATE users SET verification_code_hash=?, verification_expires_at=? WHERE id=?').run(sha256(code), new Date(Date.now() + 15 * 60000).toISOString(), u.id);
        const out = { ok: true, message: 'New code issued.' };
        if (DEV) out.dev_code = code;
        return sendJSON(res, 200, out);
      }
      if (method === 'POST' && pathname === '/api/auth/login') {
        const { identifier, password } = body;
        if (!identifier || !password) return sendJSON(res, 400, { error: 'Identifier and password required' });
        const u = db.prepare('SELECT * FROM users WHERE email=? OR phone=?').get(identifier, identifier);
        if (!u || u.password_hash !== hashPassword(password, u.salt)) return sendJSON(res, 401, { error: 'Invalid credentials' });
        if (u.status === 'suspended') return sendJSON(res, 403, { error: 'Account suspended' });
        if (!u.verified) return sendJSON(res, 403, { error: 'Account not verified. Enter the verification code first.', need_verification: true });
        if (u.role === 'manager') {
          // OTP-verified login for managers
          const code = randCode();
          const loginToken = randToken(24);
          loginOtpStore.set(loginToken, { userId: u.id, codeHash: sha256(code), expiresAt: Date.now() + 15 * 60000 });
          const out = { ok: true, otp_required: true, login_token: loginToken, message: 'Enter the login OTP code.' };
          if (DEV) out.dev_code = code;
          return sendJSON(res, 200, out);
        }
        const token = randToken(32), csrf = randToken(16);
        db.prepare('INSERT INTO sessions (user_id,token_hash,csrf_token,expires_at) VALUES (?,?,?,?)').run(u.id, sha256(token), csrf, addDaysISO(30));
        setCookie(res, 'fs_session', token, { httpOnly: true, maxAge: 30 * 24 * 3600 });
        setCookie(res, 'fs_csrf', csrf);
        return sendJSON(res, 200, { ok: true, user: publicUser(u), csrfToken: csrf });
      }
      if (method === 'POST' && pathname === '/api/auth/login-verify') {
        const { login_token, code } = body;
        const rec = login_token ? loginOtpStore.get(login_token) : null;
        if (!rec || rec.codeHash !== sha256(String(code || '')) || rec.expiresAt < Date.now()) return sendJSON(res, 400, { error: 'Invalid or expired login code' });
        loginOtpStore.delete(login_token);
        const u = db.prepare('SELECT * FROM users WHERE id=?').get(rec.userId);
        const token = randToken(32), csrf = randToken(16);
        db.prepare('INSERT INTO sessions (user_id,token_hash,csrf_token,expires_at) VALUES (?,?,?,?)').run(u.id, sha256(token), csrf, addDaysISO(30));
        setCookie(res, 'fs_session', token, { httpOnly: true, maxAge: 30 * 24 * 3600 });
        setCookie(res, 'fs_csrf', csrf);
        return sendJSON(res, 200, { ok: true, user: publicUser(u), csrfToken: csrf });
      }
      if (method === 'POST' && pathname === '/api/auth/logout') {
        const { session } = getSessionUser(req);
        if (session) db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
        setCookie(res, 'fs_session', '', { httpOnly: true, expires: 'Thu, 01 Jan 1970 00:00:00 GMT' });
        return sendJSON(res, 200, { ok: true });
      }
      if (method === 'POST' && pathname === '/api/auth/change-password') {
        const auth = requireAuth(req, res, null); if (!auth) return;
        const { old_password, new_password } = body;
        if (!old_password || !new_password || String(new_password).length < 8)
          return sendJSON(res, 400, { error: 'Old password and a new password of 8+ characters are required' });
        if (auth.user.password_hash !== hashPassword(old_password, auth.user.salt))
          return sendJSON(res, 401, { error: 'Old password is incorrect' });
        const salt = randToken(16);
        db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hashPassword(new_password, salt), salt, auth.user.id);
        // Keep the current session alive; revoke every other session for safety.
        if (auth.session) db.prepare('DELETE FROM sessions WHERE user_id=? AND id!=?').run(auth.user.id, auth.session.id);
        else db.prepare('DELETE FROM sessions WHERE user_id=?').run(auth.user.id);
        audit(auth.user, 'change_password', 'user', auth.user.id, null, null);
        return sendJSON(res, 200, { ok: true, message: 'Password changed. Use the new password next time you log in.' });
      }
      if (method === 'GET' && pathname === '/api/auth/me') {
        const { user, session } = getSessionUser(req);
        if (!user) return sendJSON(res, 200, { user: null });
        return sendJSON(res, 200, { user: publicUser(user), csrfToken: session.csrf_token });
      }
      // ---- public vendors ----
      if (method === 'GET' && pathname === '/api/vendors') {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const cat = url.searchParams.get('category') || '';
        const city = (url.searchParams.get('city') || '').toLowerCase();
        const all = db.prepare('SELECT * FROM vendors ORDER BY subscription_plan DESC, name').all();
        const list = all.filter(isPublicVendor).filter((v) => {
          if (cat && v.category !== cat) return false;
          if (city && !v.city.toLowerCase().includes(city)) return false;
          if (q && !(v.name.toLowerCase().includes(q) || (v.description || '').toLowerCase().includes(q) || v.city.toLowerCase().includes(q) || (v.area || '').toLowerCase().includes(q))) return false;
          return true;
        }).map(vendorPublic);
        return sendJSON(res, 200, { vendors: list });
      }
      const vendorIdMatch = pathname.match(/^\/api\/vendors\/(\d+)$/);
      if (method === 'GET' && vendorIdMatch) {
        const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(vendorIdMatch[1]));
        if (!v || !isPublicVendor(v)) return sendJSON(res, 404, { error: 'Vendor not found or not public' });
        return sendJSON(res, 200, { vendor: vendorDetail(v) });
      }
      // ---- contact / newsletter ----
      if (method === 'POST' && pathname === '/api/contact') {
        if (!rateLimit(ip, 'contact', 4, 30 * 60000)) return sendJSON(res, 429, { error: 'Too many messages. Please try again later.' });
        const { name, email, subject, message } = body;
        if (!name || !isEmail(email) || !subject || !message || String(message).trim().length < 10)
          return sendJSON(res, 400, { error: 'Name, valid email, subject and a message of 10+ characters are required' });
        db.prepare('INSERT INTO contact_messages (name,email,subject,message) VALUES (?,?,?,?)').run(name.trim(), email.trim(), subject.trim(), message.trim());
        return sendJSON(res, 201, { ok: true, message: 'Message received. We will reply soon.' });
      }
      if (method === 'POST' && pathname === '/api/newsletter') {
        if (!rateLimit(ip, 'newsletter', 5, 30 * 60000)) return sendJSON(res, 429, { error: 'Too many signups. Please try again later.' });
        const { email } = body;
        if (!isEmail(email)) return sendJSON(res, 400, { error: 'Valid email required' });
        try {
          db.prepare('INSERT INTO newsletter_subscribers (email) VALUES (?)').run(email.trim());
        } catch { return sendJSON(res, 200, { ok: true, message: 'You are subscribed.' }); }
        return sendJSON(res, 201, { ok: true, message: 'Subscribed to FoodScope updates.' });
      }
      // ---- customer reviews ----
      if (method === 'POST' && pathname === '/api/reviews') {
        const auth = requireAuth(req, res, ['customer']); if (!auth) return;
        const { vendor_id, food, hygiene, value, overall, delivery, comment } = body;
        const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(vendor_id));
        if (!v || !isPublicVendor(v)) return sendJSON(res, 404, { error: 'Vendor not public' });
        const nums = [food, hygiene, value, overall];
        if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 5)) return sendJSON(res, 400, { error: 'Food, hygiene, value and overall ratings (1-5) are required' });
        if (delivery != null && (!Number.isInteger(delivery) || delivery < 1 || delivery > 5)) return sendJSON(res, 400, { error: 'Delivery rating must be 1-5' });
        if (!v.delivery_enabled && delivery != null) return sendJSON(res, 400, { error: 'This vendor does not offer delivery, so no delivery rating applies' });
        if (!comment || String(comment).trim().length < 10) return sendJSON(res, 400, { error: 'Review comment of 10+ characters required' });
        const existing = db.prepare("SELECT * FROM reviews WHERE vendor_id=? AND customer_id=? AND status IN ('active','flagged')").get(v.id, auth.user.id);
        if (existing) return sendJSON(res, 409, { error: 'You already have an active review for this vendor' });
        const scan = scanReview(comment);
        const status = scan.score >= 40 ? 'flagged' : 'active';
        const r = db.prepare('INSERT INTO reviews (vendor_id,customer_id,food,hygiene,value_rating,overall,delivery,comment,status,flag_score,flag_reasons) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(v.id, auth.user.id, food, hygiene, value, overall, delivery || null, comment.trim(), status, scan.score, scan.reasons.join('; '));
        if (status === 'flagged') audit(auth.user, 'review_auto_flagged', 'review', Number(r.lastInsertRowid), 'Safety scan score ' + scan.score, { reasons: scan.reasons });
        return sendJSON(res, 201, { ok: true, reviewId: Number(r.lastInsertRowid), status, flag_score: scan.score, reasons: scan.reasons });
      }
      const flagMatch = pathname.match(/^\/api\/reviews\/(\d+)\/flag$/);
      if (method === 'POST' && flagMatch) {
        const { user } = getSessionUser(req);
        const r = db.prepare('SELECT * FROM reviews WHERE id=?').get(Number(flagMatch[1]));
        if (!r) return sendJSON(res, 404, { error: 'Review not found' });
        db.prepare('INSERT INTO review_flags (review_id,reporter_id,reason) VALUES (?,?,?)').run(r.id, user ? user.id : null, body.reason || 'flagged by visitor');
        if (r.status === 'active') db.prepare("UPDATE reviews SET status='flagged' WHERE id=?").run(r.id);
        return sendJSON(res, 200, { ok: true, message: 'Review flagged for moderation.' });
      }
      // ---- manager ----
      if (pathname.startsWith('/api/manager/')) {
        const auth = requireAuth(req, res, ['manager']); if (!auth) return;
        const myVendor = () => db.prepare('SELECT * FROM vendors WHERE manager_id=?').get(auth.user.id);
        if (method === 'GET' && pathname === '/api/manager/vendor') {
          const v = myVendor();
          if (!v) return sendJSON(res, 200, { vendor: null });
          const out = { ...v, open: !!v.open, delivery_enabled: !!v.delivery_enabled };
          out.menu = db.prepare('SELECT * FROM menu_items WHERE vendor_id=? ORDER BY id').all(v.id);
          out.gallery = db.prepare('SELECT * FROM gallery_items WHERE vendor_id=? ORDER BY id').all(v.id);
          out.update_requests = db.prepare('SELECT * FROM vendor_update_requests WHERE vendor_id=? ORDER BY id DESC').all(v.id);
          out.payments = db.prepare('SELECT * FROM payments WHERE manager_id=? ORDER BY id DESC').all(auth.user.id);
          out.certificates = db.prepare('SELECT * FROM certificates WHERE manager_id=? ORDER BY id DESC').all(auth.user.id);
          out.reviews = db.prepare("SELECT r.*, u.name AS customer_name FROM reviews r JOIN users u ON u.id=r.customer_id WHERE r.vendor_id=? ORDER BY r.created_at DESC").all(v.id);
          return sendJSON(res, 200, { vendor: out });
        }
        if (method === 'POST' && pathname === '/api/manager/vendors') {
          if (myVendor()) return sendJSON(res, 409, { error: 'You already have one vendor submission. Use update requests to change sensitive fields.' });
          const { name, category, city, area, address, description, delivery_phone, google_maps_url, primary_image_url, banner_url, delivery_enabled, delivery_fee_pkr, min_order_pkr, delivery_time } = body;
          if (!name || !CATEGORIES.includes(category) || !city) return sendJSON(res, 400, { error: 'Name, valid category and city are required' });
          let slug = slugify(body.slug || name);
          let base = slug, n = 2;
          while (db.prepare('SELECT id FROM vendors WHERE slug=?').get(slug)) slug = base + '-' + (n++);
          const r = db.prepare(`INSERT INTO vendors (manager_id,name,slug,category,city,area,address,description,delivery_phone,google_maps_url,primary_image_url,banner_url,status,delivery_enabled,delivery_fee_pkr,min_order_pkr,delivery_time)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(auth.user.id, name.trim(), slug, category, city.trim(), area || '', address || '', description || '', delivery_phone || '', google_maps_url || '', primary_image_url || '', banner_url || '', 'pending', delivery_enabled ? 1 : 0, Number(delivery_fee_pkr) || 0, Number(min_order_pkr) || 0, delivery_time || '');
          audit(auth.user, 'vendor_submit', 'vendor', Number(r.lastInsertRowid), null, { name });
          return sendJSON(res, 201, { ok: true, vendorId: Number(r.lastInsertRowid), slug, status: 'pending' });
        }
        const mvMatch = pathname.match(/^\/api\/manager\/vendors\/(\d+)$/);
        if (method === 'PATCH' && mvMatch) {
          const v = db.prepare('SELECT * FROM vendors WHERE id=? AND manager_id=?').get(Number(mvMatch[1]), auth.user.id);
          if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          if (v.status === 'suspended') return sendJSON(res, 403, { error: 'Suspended vendor is locked until admin review' });
          const bad = Object.keys(body).filter((k) => SENSITIVE_FIELDS.includes(k));
          if (bad.length) return sendJSON(res, 400, { error: 'Sensitive fields must go through an update request: ' + bad.join(', ') });
          const sets = [], vals = [];
          for (const k of NON_SENSITIVE_VENDOR_FIELDS) {
            if (body[k] !== undefined) { sets.push(k + '=?'); vals.push(k === 'open' || k === 'delivery_enabled' ? (body[k] ? 1 : 0) : body[k]); }
          }
          if (!sets.length) return sendJSON(res, 400, { error: 'No editable fields provided' });
          if (body.category && !CATEGORIES.includes(body.category)) return sendJSON(res, 400, { error: 'Invalid category' });
          db.prepare(`UPDATE vendors SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals, v.id);
          if (v.status === 'approved') db.prepare("UPDATE vendors SET status='pending_update' WHERE id=?").run(v.id);
          audit(auth.user, 'vendor_edit', 'vendor', v.id, null, { fields: Object.keys(body) });
          return sendJSON(res, 200, { ok: true });
        }
        const urMatch = pathname.match(/^\/api\/manager\/vendors\/(\d+)\/update-request$/);
        if (method === 'POST' && urMatch) {
          const v = db.prepare('SELECT * FROM vendors WHERE id=? AND manager_id=?').get(Number(urMatch[1]), auth.user.id);
          if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          const fields = {};
          for (const k of SENSITIVE_FIELDS) if (body[k] !== undefined) fields[k] = body[k];
          if (!Object.keys(fields).length) return sendJSON(res, 400, { error: 'Provide at least one sensitive field: ' + SENSITIVE_FIELDS.join(', ') });
          if (fields.slug) {
            const s = slugify(fields.slug);
            const clash = db.prepare('SELECT id FROM vendors WHERE slug=? AND id!=?').get(s, v.id);
            if (clash) return sendJSON(res, 400, { error: 'Slug already in use' });
            fields.slug = s;
          }
          const r = db.prepare('INSERT INTO vendor_update_requests (vendor_id,manager_id,fields_json) VALUES (?,?,?)').run(v.id, auth.user.id, JSON.stringify(fields));
          if (v.status === 'approved') db.prepare("UPDATE vendors SET status='pending_update' WHERE id=?").run(v.id);
          audit(auth.user, 'vendor_update_request', 'vendor', v.id, null, { fields });
          return sendJSON(res, 201, { ok: true, requestId: Number(r.lastInsertRowid) });
        }
        if (method === 'POST' && pathname === '/api/manager/payments') {
          const { plan, method, reference_text, vendor_id, proof_filename, proof_mimetype, proof_base64 } = body;
          if (!PLANS[plan]) return sendJSON(res, 400, { error: 'Plan must be Basic, Premium or Featured' });
          if (!PAYMENT_METHODS.includes(method)) return sendJSON(res, 400, { error: 'Invalid payment method' });
          let proof = null;
          if (proof_filename || proof_base64) {
            const saved = saveUpload({ filename: proof_filename, mimetype: proof_mimetype, base64: proof_base64 });
            if (saved.error) return sendJSON(res, 400, { error: saved.error });
            proof = saved;
          }
          const v = myVendor();
          const r = db.prepare('INSERT INTO payments (manager_id,vendor_id,plan,amount_pkr,method,reference_text,proof_path,proof_mimetype) VALUES (?,?,?,?,?,?,?,?)')
            .run(auth.user.id, vendor_id ? Number(vendor_id) : (v ? v.id : null), plan, PLANS[plan].price, method, reference_text || '', proof ? proof.path : null, proof ? proof.mimetype : null);
          audit(auth.user, 'payment_submit', 'payment', Number(r.lastInsertRowid), null, { plan, method });
          return sendJSON(res, 201, { ok: true, paymentId: Number(r.lastInsertRowid), amount_pkr: PLANS[plan].price, status: 'pending' });
        }
        if (method === 'POST' && pathname === '/api/manager/certificates') {
          const { cert_type, vendor_id, file_filename, file_mimetype, file_base64 } = body;
          if (!cert_type) return sendJSON(res, 400, { error: 'Certificate type required (e.g. Food Licence, FBR, Trade Licence)' });
          let saved = null;
          if (file_filename || file_base64) {
            saved = saveUpload({ filename: file_filename, mimetype: file_mimetype, base64: file_base64 });
            if (saved.error) return sendJSON(res, 400, { error: saved.error });
          }
          const v = myVendor();
          const r = db.prepare('INSERT INTO certificates (manager_id,vendor_id,cert_type,file_path,file_mimetype) VALUES (?,?,?,?,?)')
            .run(auth.user.id, vendor_id ? Number(vendor_id) : (v ? v.id : null), cert_type, saved ? saved.path : null, saved ? saved.mimetype : null);
          audit(auth.user, 'certificate_submit', 'certificate', Number(r.lastInsertRowid), null, { cert_type });
          return sendJSON(res, 201, { ok: true, certificateId: Number(r.lastInsertRowid), status: 'pending' });
        }
        if (method === 'POST' && pathname === '/api/manager/menu') {
          const v = myVendor(); if (!v) return sendJSON(res, 404, { error: 'Submit a vendor first' });
          const { name, description, price_pkr, category, image_url } = body;
          if (!name || price_pkr == null || Number(price_pkr) < 0) return sendJSON(res, 400, { error: 'Menu name and non-negative PKR price required' });
          const r = db.prepare('INSERT INTO menu_items (vendor_id,name,description,price_pkr,category,image_url) VALUES (?,?,?,?,?,?)').run(v.id, name, description || '', Number(price_pkr), category || '', image_url || '');
          return sendJSON(res, 201, { ok: true, menuId: Number(r.lastInsertRowid) });
        }
        const menuMatch = pathname.match(/^\/api\/manager\/menu\/(\d+)$/);
        if ((method === 'PATCH' || method === 'DELETE') && menuMatch) {
          const v = myVendor(); if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          const m = db.prepare('SELECT * FROM menu_items WHERE id=? AND vendor_id=?').get(Number(menuMatch[1]), v.id);
          if (!m) return sendJSON(res, 404, { error: 'Menu item not found' });
          if (method === 'DELETE') { db.prepare('DELETE FROM menu_items WHERE id=?').run(m.id); return sendJSON(res, 200, { ok: true }); }
          const sets = [], vals = [];
          for (const k of ['name', 'description', 'price_pkr', 'category', 'image_url', 'available']) {
            if (body[k] !== undefined) { sets.push(k + '=?'); vals.push(k === 'available' ? (body[k] ? 1 : 0) : body[k]); }
          }
          if (sets.length) db.prepare(`UPDATE menu_items SET ${sets.join(',')} WHERE id=?`).run(...vals, m.id);
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'POST' && pathname === '/api/manager/gallery') {
          const v = myVendor(); if (!v) return sendJSON(res, 404, { error: 'Submit a vendor first' });
          if (!body.url) return sendJSON(res, 400, { error: 'Image URL required' });
          const r = db.prepare('INSERT INTO gallery_items (vendor_id,url,caption) VALUES (?,?,?)').run(v.id, body.url, body.caption || '');
          return sendJSON(res, 201, { ok: true, galleryId: Number(r.lastInsertRowid), status: 'pending' });
        }
        if (method === 'POST' && pathname === '/api/manager/staff') {
          const v = myVendor(); if (!v) return sendJSON(res, 404, { error: 'Submit a vendor first' });
          const { name, email, password } = body;
          if (!name || !isEmail(email) || !password || password.length < 8) return sendJSON(res, 400, { error: 'Staff name, valid email and 8+ password required' });
          const salt = randToken(16);
          try {
            const r = db.prepare('INSERT INTO users (name,email,contact_type,role,password_hash,salt,verified) VALUES (?,?,?,?,?,?,1)').run(name, email, 'email', 'staff', hashPassword(password, salt), salt);
            db.prepare('INSERT INTO staff_assignments (staff_id,vendor_id) VALUES (?,?)').run(Number(r.lastInsertRowid), v.id);
            audit(auth.user, 'staff_create', 'user', Number(r.lastInsertRowid), null, { vendor_id: v.id });
            return sendJSON(res, 201, { ok: true, staffId: Number(r.lastInsertRowid) });
          } catch { return sendJSON(res, 409, { error: 'Email already registered' }); }
        }
        return sendJSON(res, 404, { error: 'Manager route not found' });
      }
      // ---- staff (assigned vendor, menu/availability only) ----
      if (pathname.startsWith('/api/staff/')) {
        const auth = requireAuth(req, res, ['staff']); if (!auth) return;
        const assignment = db.prepare('SELECT * FROM staff_assignments WHERE staff_id=?').get(auth.user.id);
        if (!assignment) return sendJSON(res, 403, { error: 'No vendor assigned to this staff account' });
        const vendorId = assignment.vendor_id;
        if (method === 'GET' && pathname === '/api/staff/vendor') {
          const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(vendorId);
          const menu = db.prepare('SELECT * FROM menu_items WHERE vendor_id=? ORDER BY id').all(vendorId);
          return sendJSON(res, 200, { vendor: v, menu });
        }
        if (method === 'POST' && pathname === '/api/staff/menu') {
          if (!body.name || body.price_pkr == null) return sendJSON(res, 400, { error: 'Name and price required' });
          const r = db.prepare('INSERT INTO menu_items (vendor_id,name,description,price_pkr,category,image_url) VALUES (?,?,?,?,?,?)').run(vendorId, body.name, body.description || '', Number(body.price_pkr), body.category || '', body.image_url || '');
          return sendJSON(res, 201, { ok: true, menuId: Number(r.lastInsertRowid) });
        }
        const sm = pathname.match(/^\/api\/staff\/menu\/(\d+)$/);
        if ((method === 'PATCH' || method === 'DELETE') && sm) {
          const m = db.prepare('SELECT * FROM menu_items WHERE id=? AND vendor_id=?').get(Number(sm[1]), vendorId);
          if (!m) return sendJSON(res, 404, { error: 'Menu item not found for assigned vendor' });
          if (method === 'DELETE') { db.prepare('DELETE FROM menu_items WHERE id=?').run(m.id); return sendJSON(res, 200, { ok: true }); }
          const sets = [], vals = [];
          for (const k of ['name', 'description', 'price_pkr', 'category', 'image_url', 'available']) {
            if (body[k] !== undefined) { sets.push(k + '=?'); vals.push(k === 'available' ? (body[k] ? 1 : 0) : body[k]); }
          }
          if (sets.length) db.prepare(`UPDATE menu_items SET ${sets.join(',')} WHERE id=?`).run(...vals, m.id);
          return sendJSON(res, 200, { ok: true });
        }
        return sendJSON(res, 403, { error: 'Staff accounts may only manage menu/availability for their assigned vendor' });
      }
      // ---- admin (owner only) ----
      if (pathname.startsWith('/api/admin/')) {
        const auth = requireAuth(req, res, ['owner']); if (!auth) return;
        if (method === 'GET' && pathname === '/api/admin/vendors') {
          const rows = db.prepare('SELECT v.*, u.name AS manager_name, u.email AS manager_email FROM vendors v JOIN users u ON u.id=v.manager_id ORDER BY v.created_at DESC').all();
          return sendJSON(res, 200, { vendors: rows.map((v) => ({ ...v, open: !!v.open, delivery_enabled: !!v.delivery_enabled, ratings: vendorRatings(v.id) })) });
        }
        const av = pathname.match(/^\/api\/admin\/vendors\/(\d+)\/(approve|reject|suspend|unsuspend)$/);
        if (method === 'POST' && av) {
          const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(av[1]));
          if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          const action = av[2];
          if (action === 'approve') {
            db.prepare("UPDATE vendors SET status='approved', approved_at=COALESCE(approved_at, datetime('now')), rejection_reason=NULL, suspension_reason=NULL WHERE id=?").run(v.id);
          } else if (action === 'reject') {
            if (!body.reason) return sendJSON(res, 400, { error: 'Rejection reason required' });
            db.prepare("UPDATE vendors SET status='rejected', rejection_reason=? WHERE id=?").run(body.reason, v.id);
          } else if (action === 'suspend') {
            if (!body.reason) return sendJSON(res, 400, { error: 'Suspension reason required' });
            db.prepare("UPDATE vendors SET status='suspended', suspension_reason=? WHERE id=?").run(body.reason, v.id);
          } else {
            db.prepare("UPDATE vendors SET status='approved', suspension_reason=NULL WHERE id=?").run(v.id);
          }
          audit(auth.user, 'vendor_' + action, 'vendor', v.id, body.reason || null, null);
          return sendJSON(res, 200, { ok: true });
        }
        const ee = pathname.match(/^\/api\/admin\/vendors\/(\d+)\/emergency-edit$/);
        if (method === 'POST' && ee) {
          const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(ee[1]));
          if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          if (!body.reason || String(body.reason).trim().length < 5) return sendJSON(res, 400, { error: 'Emergency edit requires a safety reason (5+ chars)' });
          const allowed = [...SENSITIVE_FIELDS, ...NON_SENSITIVE_VENDOR_FIELDS, 'status'];
          const sets = [], vals = [];
          for (const k of allowed) if (body.fields && body.fields[k] !== undefined) { sets.push(k + '=?'); vals.push(body.fields[k]); }
          if (!sets.length) return sendJSON(res, 400, { error: 'No fields to edit' });
          db.prepare(`UPDATE vendors SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals, v.id);
          audit(auth.user, 'vendor_emergency_edit', 'vendor', v.id, body.reason, { fields: body.fields });
          return sendJSON(res, 200, { ok: true });
        }
        const del = pathname.match(/^\/api\/admin\/vendors\/(\d+)$/);
        if (method === 'DELETE' && del) {
          const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(del[1]));
          if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          if (!body.reason || String(body.reason).trim().length < 5) return sendJSON(res, 400, { error: 'Emergency delete requires a safety reason (5+ chars)' });
          audit(auth.user, 'vendor_emergency_delete', 'vendor', v.id, body.reason, { name: v.name });
          db.prepare('DELETE FROM vendors WHERE id=?').run(v.id);
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/admin/payments') return sendJSON(res, 200, { payments: db.prepare('SELECT p.*, u.name AS manager_name FROM payments p JOIN users u ON u.id=p.manager_id ORDER BY p.created_at DESC').all() });
        const pay = pathname.match(/^\/api\/admin\/payments\/(\d+)\/(approve|reject)$/);
        if (method === 'POST' && pay) {
          const p = db.prepare('SELECT * FROM payments WHERE id=?').get(Number(pay[1]));
          if (!p) return sendJSON(res, 404, { error: 'Payment not found' });
          if (pay[2] === 'reject' && !body.reason) return sendJSON(res, 400, { error: 'Rejection reason required' });
          db.prepare('UPDATE payments SET status=?, admin_note=?, decided_at=datetime(\'now\') WHERE id=?').run(pay[2] === 'approve' ? 'approved' : 'rejected', body.reason || null, p.id);
          if (pay[2] === 'approve' && p.vendor_id) {
            const plan = PLANS[p.plan];
            const cur = db.prepare('SELECT subscription_expires_at FROM vendors WHERE id=?').get(p.vendor_id);
            const base = cur && cur.subscription_expires_at && new Date(cur.subscription_expires_at).getTime() > Date.now() ? new Date(cur.subscription_expires_at).getTime() : Date.now();
            db.prepare('UPDATE vendors SET subscription_plan=?, subscription_expires_at=? WHERE id=?').run(p.plan, new Date(base + plan.days * 86400000).toISOString(), p.vendor_id);
          }
          audit(auth.user, 'payment_' + pay[2], 'payment', p.id, body.reason || null, { plan: p.plan });
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/admin/certificates') return sendJSON(res, 200, { certificates: db.prepare('SELECT c.*, u.name AS manager_name FROM certificates c JOIN users u ON u.id=c.manager_id ORDER BY c.created_at DESC').all() });
        const cert = pathname.match(/^\/api\/admin\/certificates\/(\d+)\/(approve|reject)$/);
        if (method === 'POST' && cert) {
          const c = db.prepare('SELECT * FROM certificates WHERE id=?').get(Number(cert[1]));
          if (!c) return sendJSON(res, 404, { error: 'Certificate not found' });
          if (cert[2] === 'reject' && !body.reason) return sendJSON(res, 400, { error: 'Rejection reason required' });
          db.prepare('UPDATE certificates SET status=?, admin_note=?, decided_at=datetime(\'now\') WHERE id=?').run(cert[2] === 'approve' ? 'approved' : 'rejected', body.reason || null, c.id);
          audit(auth.user, 'certificate_' + cert[2], 'certificate', c.id, body.reason || null, null);
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/admin/update-requests') return sendJSON(res, 200, { requests: db.prepare('SELECT r.*, v.name AS vendor_name FROM vendor_update_requests r JOIN vendors v ON v.id=r.vendor_id ORDER BY r.created_at DESC').all() });
        const upd = pathname.match(/^\/api\/admin\/update-requests\/(\d+)\/(approve|reject)$/);
        if (method === 'POST' && upd) {
          const r = db.prepare('SELECT * FROM vendor_update_requests WHERE id=?').get(Number(upd[1]));
          if (!r) return sendJSON(res, 404, { error: 'Update request not found' });
          if (upd[2] === 'approve') {
            const fields = JSON.parse(r.fields_json);
            const sets = [], vals = [];
            for (const k of SENSITIVE_FIELDS) if (fields[k] !== undefined) { sets.push(k + '=?'); vals.push(fields[k]); }
            if (sets.length) db.prepare(`UPDATE vendors SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals, r.vendor_id);
            const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(r.vendor_id);
            if (v && v.status === 'pending_update' && v.approved_at) db.prepare("UPDATE vendors SET status='approved' WHERE id=?").run(v.id);
          } else if (!body.reason) return sendJSON(res, 400, { error: 'Rejection reason required' });
          db.prepare('UPDATE vendor_update_requests SET status=?, admin_note=?, decided_at=datetime(\'now\') WHERE id=?').run(upd[2] === 'approve' ? 'approved' : 'rejected', body.reason || null, r.id);
          audit(auth.user, 'update_request_' + upd[2], 'vendor_update_request', r.id, body.reason || null, null);
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/admin/gallery') return sendJSON(res, 200, { gallery: db.prepare('SELECT g.*, v.name AS vendor_name FROM gallery_items g JOIN vendors v ON v.id=g.vendor_id ORDER BY g.created_at DESC').all() });
        const gal = pathname.match(/^\/api\/admin\/gallery\/(\d+)\/(approve|reject)$/);
        if (method === 'POST' && gal) {
          const g = db.prepare('SELECT * FROM gallery_items WHERE id=?').get(Number(gal[1]));
          if (!g) return sendJSON(res, 404, { error: 'Image not found' });
          db.prepare('UPDATE gallery_items SET status=? WHERE id=?').run(gal[2] === 'approve' ? 'approved' : 'rejected', g.id);
          audit(auth.user, 'gallery_' + gal[2], 'gallery', g.id, null, null);
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/admin/reviews') return sendJSON(res, 200, { reviews: db.prepare('SELECT r.*, v.name AS vendor_name, u.name AS customer_name FROM reviews r JOIN vendors v ON v.id=r.vendor_id JOIN users u ON u.id=r.customer_id ORDER BY r.created_at DESC').all() });
        const rev = pathname.match(/^\/api\/admin\/reviews\/(\d+)\/(note|reply|delete|restore)$/);
        if (method === 'POST' && rev) {
          const r = db.prepare('SELECT * FROM reviews WHERE id=?').get(Number(rev[1]));
          if (!r) return sendJSON(res, 404, { error: 'Review not found' });
          const action = rev[2];
          if (action === 'note') {
            if (!body.note) return sendJSON(res, 400, { error: 'Note required' });
            db.prepare('INSERT INTO review_moderation (review_id,admin_id,action,note) VALUES (?,?,?,?)').run(r.id, auth.user.id, 'note', body.note);
          } else if (action === 'reply') {
            if (!body.reply) return sendJSON(res, 400, { error: 'Reply required' });
            db.prepare('UPDATE reviews SET admin_reply=? WHERE id=?').run(body.reply, r.id);
            db.prepare('INSERT INTO review_moderation (review_id,admin_id,action,note) VALUES (?,?,?,?)').run(r.id, auth.user.id, 'reply', body.reply);
          } else if (action === 'delete') {
            db.prepare("UPDATE reviews SET status='deleted' WHERE id=?").run(r.id);
            db.prepare('INSERT INTO review_moderation (review_id,admin_id,action,note) VALUES (?,?,?,?)').run(r.id, auth.user.id, 'soft_delete', body.reason || '');
          } else if (action === 'restore') {
            db.prepare("UPDATE reviews SET status='active' WHERE id=?").run(r.id);
            db.prepare('INSERT INTO review_moderation (review_id,admin_id,action,note) VALUES (?,?,?,?)').run(r.id, auth.user.id, 'restore', body.reason || '');
          }
          audit(auth.user, 'review_' + action, 'review', r.id, body.reason || body.note || null, null);
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/admin/reports') {
          const totals = {
            vendors_total: db.prepare('SELECT COUNT(*) c FROM vendors').get().c,
            vendors_approved: db.prepare("SELECT COUNT(*) c FROM vendors WHERE status='approved'").get().c,
            vendors_pending: db.prepare("SELECT COUNT(*) c FROM vendors WHERE status='pending'").get().c,
            vendors_suspended: db.prepare("SELECT COUNT(*) c FROM vendors WHERE status='suspended'").get().c,
            users_total: db.prepare('SELECT COUNT(*) c FROM users').get().c,
            managers: db.prepare("SELECT COUNT(*) c FROM users WHERE role='manager'").get().c,
            customers: db.prepare("SELECT COUNT(*) c FROM users WHERE role='customer'").get().c,
            reviews_total: db.prepare('SELECT COUNT(*) c FROM reviews').get().c,
            reviews_active: db.prepare("SELECT COUNT(*) c FROM reviews WHERE status='active'").get().c,
            payments_approved_total_pkr: db.prepare("SELECT COALESCE(SUM(amount_pkr),0) s FROM payments WHERE status='approved'").get().s,
            contacts: db.prepare('SELECT COUNT(*) c FROM contact_messages').get().c,
            newsletter: db.prepare('SELECT COUNT(*) c FROM newsletter_subscribers').get().c,
          };
          const topRating = db.prepare(`SELECT v.id, v.name, v.city, v.category, AVG(r.overall) avg_overall, COUNT(r.id) n FROM vendors v JOIN reviews r ON r.vendor_id=v.id WHERE r.status='active' GROUP BY v.id ORDER BY avg_overall DESC, n DESC LIMIT 5`).all()
            .map((x) => ({ ...x, avg_overall: Math.round(x.avg_overall * 10) / 10 }));
          const topCount = db.prepare(`SELECT v.id, v.name, v.city, v.category, COUNT(r.id) n, AVG(r.overall) avg_overall FROM vendors v JOIN reviews r ON r.vendor_id=v.id WHERE r.status='active' GROUP BY v.id ORDER BY n DESC LIMIT 5`).all()
            .map((x) => ({ ...x, avg_overall: Math.round(x.avg_overall * 10) / 10 }));
          const categoryTotals = db.prepare('SELECT category, COUNT(*) n FROM vendors GROUP BY category ORDER BY n DESC').all();
          return sendJSON(res, 200, { totals, top_by_rating: topRating, top_by_review_count: topCount, category_totals: categoryTotals });
        }
        if (method === 'GET' && pathname === '/api/admin/audit-log') return sendJSON(res, 200, { log: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all() });
        if (method === 'GET' && pathname === '/api/admin/users') return sendJSON(res, 200, { users: db.prepare('SELECT id,name,email,phone,role,verified,status,created_at FROM users ORDER BY created_at DESC').all() });
        const usr = pathname.match(/^\/api\/admin\/users\/(\d+)\/(suspend|activate)$/);
        if (method === 'POST' && usr) {
          const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(usr[1]));
          if (!u) return sendJSON(res, 404, { error: 'User not found' });
          if (u.role === 'owner') return sendJSON(res, 403, { error: 'Cannot suspend the Portal Admin' });
          db.prepare('UPDATE users SET status=? WHERE id=?').run(usr[2] === 'suspend' ? 'suspended' : 'active', u.id);
          if (usr[2] === 'suspend') db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
          audit(auth.user, 'user_' + usr[2], 'user', u.id, body.reason || null, null);
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/admin/contacts') return sendJSON(res, 200, { contacts: db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 100').all() });
        if (method === 'GET' && pathname === '/api/admin/activity') {
          const rows = db.prepare('SELECT substr(created_at,1,10) d, COUNT(*) n FROM reviews GROUP BY d ORDER BY d DESC LIMIT 14').all().reverse();
          return sendJSON(res, 200, { activity: rows });
        }
        return sendJSON(res, 404, { error: 'Admin route not found' });
      }
      return sendJSON(res, 404, { error: 'API route not found' });
    }
    // Static files (SPA fallback for hash routes is client-side; / serves index)
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJSON(res, 500, { error: 'Server error: ' + e.message });
    else res.end();
  }
}

const server = http.createServer(handle);
server.listen(PORT, () => {
  console.log(`FoodScope running at http://localhost:${PORT}`);
  console.log(`Admin: mhkh3200@gmail.com (demo password documented in README / handoff — change it after first login)`);
});
