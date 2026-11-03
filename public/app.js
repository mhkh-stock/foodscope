// FoodScope SPA — yellow theme (warm dark surfaces, yellow accents), WebAudio clicks + voice tour.
let soundOn = localStorage.getItem('fs_sound') !== 'off';
let csrfToken = null, me = null, vendorsCache = [];
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function clickSound(){
  if(!soundOn) return;
  try{
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type='sine'; o.frequency.value=660; g.gain.value=0.06;
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime+0.07);
  }catch(e){}
}
document.addEventListener('click', e=>{ if(e.target.closest('button,a')) clickSound(); });
function updateSoundBtn(){ const b=document.getElementById('soundToggle'); if(b) b.textContent = soundOn ? '🔊 Sound: On' : '🔇 Sound: Off'; }
document.getElementById('soundToggle').onclick = ()=>{ soundOn=!soundOn; localStorage.setItem('fs_sound', soundOn?'on':'off'); updateSoundBtn(); clickSound(); };
updateSoundBtn();
function voiceTour(){
  const text = 'Welcome to FoodScope, the Pakistani food business directory. Browse approved vendors by city and category, open a vendor to see its menu, prices in rupees, delivery details and customer ratings, and leave a review. Managers run their own listing from the manager panel, and the portal admin approves vendors, payments and updates from the admin panel.';
  try{ const u=new SpeechSynthesisUtterance(text); u.rate=1; speechSynthesis.cancel(); speechSynthesis.speak(u); }
  catch(e){ alert('Voice tour is not supported in this browser.'); }
}
document.getElementById('tourBtn').onclick = voiceTour;
async function getCsrf(){
  const r = await fetch('/api/csrf', {credentials:'include'});
  const j = await r.json(); csrfToken = j.csrfToken; return csrfToken;
}
async function api(method, path, body){
  const opts = { method, credentials:'include', headers:{'Content-Type':'application/json'} };
  if(['POST','PATCH','PUT','DELETE'].includes(method)){
    const exempt = ['/api/auth/login','/api/auth/register-customer','/api/auth/register-manager','/api/auth/verify','/api/auth/request-code','/api/auth/login-verify'].includes(path);
    if(!exempt){ if(!csrfToken) await getCsrf(); opts.headers['X-CSRF-Token']=csrfToken; }
    if(body!==undefined) opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  const j = await r.json().catch(()=>({error:'Bad response'}));
  if(!r.ok) throw new Error(j.error || ('Request failed ('+r.status+')'));
  return j;
}
async function refreshMe(){
  try{ const j = await fetch('/api/auth/me',{credentials:'include'}).then(r=>r.json()); me=j.user; csrfToken=j.csrfToken||csrfToken; }catch(e){ me=null; }
  const box=document.getElementById('whoBox');
  box.innerHTML = me ? `Hi, ${esc(me.name)} (${esc(me.role)}) <a href="#/account">Change password</a> <button class="small ghost" onclick="logout()">Log out</button>` : '<span class="muted">Not logged in</span>';
}
async function logout(){ try{ await api('POST','/api/auth/logout',{}); }catch(e){} me=null; location.hash='#/'; render(); }
function animateCounters(){
  document.querySelectorAll('[data-count]').forEach(el=>{
    const target=Number(el.dataset.count)||0; let cur=0;
    const step=()=>{ cur+=Math.max(1,Math.round(target/25)); if(cur>=target) el.textContent=target; else { el.textContent=cur; requestAnimationFrame(step); } };
    step();
  });
}
function drawChart(canvas, labels, values){
  if(!canvas) return; const ctx=canvas.getContext('2d');
  const W=canvas.width=canvas.offsetWidth*2, H=canvas.height=440;
  ctx.clearRect(0,0,W,H); ctx.fillStyle='#fff7ed'; ctx.fillRect(0,0,W,H);
  const max=Math.max(1,...values); const bw=W/(values.length*1.6);
  values.forEach((v,i)=>{ const h=(v/max)*(H-90); const x=20+i*(bw*1.6)+10;
    ctx.fillStyle='#e11d2e'; ctx.fillRect(x,H-50-h,bw,h);
    ctx.fillStyle='#141414'; ctx.font='22px sans-serif'; ctx.fillText(String(v),x,H-60-h);
    ctx.fillStyle='#6b7280'; ctx.font='20px sans-serif'; ctx.fillText(String(labels[i]).slice(5),x,H-18);
  });
}
function stars(n){ if(n==null) return '<span class="muted">No ratings yet</span>'; return '★'.repeat(Math.round(n))+'☆'.repeat(5-Math.round(n))+' '+n+'/5'; }
const app=document.getElementById('app');
function setActiveNav(){
  document.querySelectorAll('[data-nav]').forEach(a=>{ a.classList.toggle('active', '#'+a.getAttribute('href').slice(1) === location.hash.split('?')[0] || (location.hash==='' && a.getAttribute('href')==='#/')); });
}
async function render(){
  setActiveNav(); await refreshMe();
  const hero=document.getElementById('homeHero');
  const hash0=location.hash.replace(/^#\//,'')||'';
  if(hero) hero.hidden = !(hash0==='' );
  const hash=location.hash.replace(/^#\//,'')||'';
  const [route, param] = hash.split('/');
  try{
    if(route==='' ) return renderHome();
    if(route==='vendor') return renderVendor(param);
    if(route==='about') return renderStatic('About FoodScope','<p>FoodScope is a public directory of Pakistani food businesses — from Peshawari chapli kabab houses to Burns Road nihari, Lahore karahi and sweet shops. Only approved vendors with a current subscription appear in the public directory.</p><p>Managers submit one vendor listing, pay for a subscription plan, and upload legal certificates. The Portal Admin reviews every payment, certificate, vendor and sensitive update before it goes live.</p>');
    if(route==='contact') return renderContact();
    if(route==='privacy') return renderStatic('Privacy Policy','<p>FoodScope stores only what the directory needs: account names, one contact channel per customer, vendor business details, reviews and messages. Passwords are stored as salted PBKDF2 hashes; session tokens are hashed. We do not sell personal data.</p>');
    if(route==='terms') return renderStatic('Terms of Use','<p>Listings must be real food businesses. Reviews must be honest and must not contain abuse, threats, spam or private contact details — flagged reviews are moderated. Vendors are responsible for their menu prices and delivery promises.</p>');
    if(route==='login') return renderLogin();
    if(route==='register') return renderRegister();
    if(route==='manager') return renderManager();
    if(route==='admin') return renderAdmin();
    if(route==='account') return renderAccount();
    app.innerHTML='<p>Page not found. <a href="#/">Back to directory</a></p>';
  }catch(e){ app.innerHTML=`<div class="err">${esc(e.message)}</div>`; }
}
async function loadVendors(){
  const q=document.getElementById('topSearch').value||'';
  const cat=document.getElementById('catFilter').value||'';
  const city=document.getElementById('cityFilter').value||'';
  const params=new URLSearchParams(); if(q)params.set('q',q); if(cat)params.set('category',cat); if(city)params.set('city',city);
  const j=await fetch('/api/vendors?'+params.toString()).then(r=>r.json());
  vendorsCache=j.vendors||[]; return vendorsCache;
}

window.scrollRail=(dir)=>{ const r=document.getElementById('catRail'); if(r) r.scrollBy({left:dir*320,behavior:'smooth'}); };
window.setCity=(city)=>{ const c=document.getElementById('cityFilter'); if(c) c.value=city; document.querySelectorAll('#cityPills button').forEach(b=>b.classList.toggle('active', b.textContent.trim()===city || (city==='' && b.textContent.trim()==='All cities'))); renderHome(); };
function priceRangeText(menu){
  const prices=(menu||[]).map(m=>Number(m.price_pkr)).filter(n=>Number.isFinite(n));
  if(!prices.length) return 'Prices on menu page';
  const lo=Math.min(...prices), hi=Math.max(...prices);
  return lo===hi ? ('PKR '+lo) : ('PKR '+lo+' – '+hi);
}
async function priceRangeFor(v){
  try{ const j=await fetch('/api/vendors/'+v.id).then(r=>r.json()); if(j.vendor && j.vendor.menu) return priceRangeText(j.vendor.menu); }catch(e){}
  return 'Prices on menu page';
}
function renderCatRail(cats){
  const rail=document.getElementById('catRail'); if(!rail) return;
  const sel=document.getElementById('catFilter') ? document.getElementById('catFilter').value : '';
  const chips=['', ...cats].map(c=>`<button type="button" class="chip${sel===c?' active':''}" onclick="setCategory(${JSON.stringify(c)})">${c===''?'All':esc(c)}</button>`).join('');
  rail.innerHTML=chips;
}
window.setCategory=(cat)=>{ const s=document.getElementById('catFilter'); if(s) s.value=cat; renderHome(); };
function vendorCard(v, priceText){
  const img=v.primary_image_url||'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=800';
  const del = v.delivery_enabled ? (v.delivery_time ? esc(v.delivery_time) : 'Delivery available') : 'Dine-in / takeaway';
  return `<div class="vendor"><a href="#/vendor/${v.id}"><img src="${esc(img)}" alt=""></a><div class="body">
    <h3><a href="#/vendor/${v.id}">${esc(v.name)}</a></h3>
    <div><span class="badge">${esc(v.category)}</span><span class="badge">${esc(v.city)}</span>${v.delivery_enabled?'<span class="badge">Delivery</span>':''}</div>
    <p class="muted">${esc(v.area||'')} · ${stars(v.ratings.overall)} (${v.ratings.count} reviews)</p>
    <p>${esc((v.description||'').slice(0,120))}</p>
    <p><span class="price">${esc(priceText||'Prices on menu page')}</span> <span class="muted">· ${del}</span></p></div></div>`;
}
async function renderHome(){
  const cats=await fetch('/api/categories').then(r=>r.json()).catch(()=>({categories:[]}));
  const sel=document.getElementById('catFilter');
  if(sel && sel.options.length<=1) cats.categories.forEach(c=>{ const o=document.createElement('option'); o.value=c; o.textContent=c; sel.appendChild(o); });
  renderCatRail(cats.categories||[]);
  const list=await loadVendors();
  const total=list.length;
  // Real PKR ranges from the existing vendor-detail endpoint (menu prices).
  // No figure is invented: a failed detail fetch keeps the honest fallback.
  const priceTexts = await Promise.all(list.map(v=>priceRangeFor(v)));
  const cards = list.map((v,i)=>vendorCard(v, priceTexts[i]));
  const top = cards.slice(0,5);
  app.innerHTML=`<div class="cards">
    <div class="card"><div class="num" data-count="${total}">0</div><div class="lbl">Approved vendors listed</div></div>
    <div class="card"><div class="num" data-count="${list.reduce((a,v)=>a+v.ratings.count,0)}">0</div><div class="lbl">Customer reviews</div></div>
    <div class="card"><div class="num" data-count="${new Set(list.map(v=>v.city)).size}">0</div><div class="lbl">Cities covered</div></div>
  </div>
  <h2 style="color:#fff">New on FoodScope</h2>
  <div class="rail-row">${top.length?top.join(''):'<p class="muted">No vendors match those filters yet.</p>'}</div>
  <h2 style="color:#fff">All places</h2>
  <div class="grid">${cards.length?cards.join(''):'<p class="muted">No vendors match those filters yet.</p>'}</div>
  <div class="panel"><h3 style="margin-top:0">Activity: reviews per vendor</h3><canvas id="chart"></canvas><p class="muted">Live counts from the public directory.</p></div>
  <div class="panel"><h3>📬 FoodScope newsletter</h3><form onsubmit="subscribe(event)"><label>Email</label><input name="email" type="email" required placeholder="you@example.com"><button style="margin-top:10px">Subscribe</button><span id="nlMsg" class="muted"></span></form>
  <p class="muted" style="font-size:13px">Verification codes in development are shown on screen after registration — no real email or SMS is sent. See the README.</p></div>`;
  animateCounters();
  drawChart(document.getElementById('chart'), list.map(v=>v.name), list.map(v=>v.ratings.count));
}
window.applyFilters=()=>renderHome();
document.getElementById('topSearch').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); renderHome(); } });
window.subscribe=async(e)=>{ e.preventDefault(); const email=e.target.email.value;
  try{ const j=await api('POST','/api/newsletter',{email}); document.getElementById('nlMsg').textContent=' ✓ '+j.message; }
  catch(err){ document.getElementById('nlMsg').textContent=' ✗ '+err.message; } };
async function renderVendor(id){
  const j=await fetch('/api/vendors/'+id).then(r=>r.json());
  if(j.error){ app.innerHTML=`<div class="err">${esc(j.error)}</div>`; return; }
  const v=j.vendor;
  const img=v.primary_image_url||'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=800';
  app.innerHTML=`<a href="#/">← Back to directory</a>
  <h1>${esc(v.name)}</h1><p><span class="badge">${esc(v.category)}</span><span class="badge">${esc(v.city)} · ${esc(v.area||'')}</span> ${v.open?'<span class="badge">Open</span>':'<span class="badge">Closed</span>'}</p>
  <img src="${esc(img)}" style="width:100%;max-height:340px;object-fit:cover;border-radius:16px" alt="">
  <p>${esc(v.description||'')}</p><p class="muted">${esc(v.address||'')}</p>
  <p>${v.google_maps_url?`<a class="btn" href="${esc(v.google_maps_url)}" target="_blank" rel="noopener">📍 Open in Google Maps</a>`:''} ${v.delivery_enabled?`Delivery: PKR ${v.delivery_fee_pkr} fee · min order PKR ${v.min_order_pkr} · ${esc(v.delivery_time||'')}`:'No delivery — dine-in / takeaway only.'}</p>
  <div class="cards">
    <div class="card"><div class="num">${v.ratings.overall??'—'}</div><div class="lbl">Overall (${v.ratings.count} reviews)</div></div>
    <div class="card"><div class="num">${v.ratings.food??'—'}</div><div class="lbl">Food</div></div>
    <div class="card"><div class="num">${v.ratings.hygiene??'—'}</div><div class="lbl">Hygiene</div></div>
    <div class="card"><div class="num">${v.ratings.value??'—'}</div><div class="lbl">Value</div></div>
  </div>
  <div class="panel"><h3>Menu (PKR)</h3>${v.menu.length?v.menu.map(m=>`<div class="menu-item"><span><b>${esc(m.name)}</b><br><span class="muted">${esc(m.description||'')}</span></span><span class="price">PKR ${m.price_pkr} ${m.available?'':'· unavailable'}</span></div>`).join(''):'<p class="muted">Menu coming soon.</p>'}</div>
  <div class="panel"><h3>Gallery</h3>${v.gallery.length?v.gallery.map(g=>`<img src="${esc(g.url)}" style="width:220px;height:150px;object-fit:cover;border-radius:12px;margin:4px" alt="">`).join(''):'<p class="muted">No gallery photos yet.</p>'}</div>
  <div class="panel"><h3>Reviews</h3>${v.reviews.length?v.reviews.map(r=>`<div style="border-bottom:1px solid var(--line);padding:10px 0"><b>${esc(r.customer_name)}</b> · ${stars(r.overall)} <span class="muted">${r.status==='flagged'?'(flagged for moderation)':''}</span><p>${esc(r.comment)}</p>${r.admin_reply?`<p class="muted">↩ Admin reply: ${esc(r.admin_reply)}</p>`:''}<button class="small ghost" onclick="flagReview(${r.id})">🚩 Flag this review</button></div>`).join(''):'<p class="muted">No reviews yet — be the first.</p>'}
  <h4>Write a review (customers only, one per vendor)</h4>
  <form onsubmit="postReview(event,${v.id},${v.delivery_enabled?1:0})">
    <div class="row"><div><label>Food (1-5)</label><input name="food" type="number" min="1" max="5" required></div>
    <div><label>Hygiene (1-5)</label><input name="hygiene" type="number" min="1" max="5" required></div>
    <div><label>Value (1-5)</label><input name="value" type="number" min="1" max="5" required></div>
    <div><label>Overall (1-5)</label><input name="overall" type="number" min="1" max="5" required></div>
    ${v.delivery_enabled?'<div><label>Delivery (1-5)</label><input name="delivery" type="number" min="1" max="5"></div>':''}</div>
    <label>Comment (10+ characters)</label><textarea name="comment" rows="3" required></textarea>
    <button style="margin-top:10px">Submit review</button><span id="revMsg" class="muted"></span></form></div>`;
}
window.flagReview=async(id)=>{ try{ await api('POST','/api/reviews/'+id+'/flag',{reason:'Flagged by visitor'}); alert('Review flagged for moderation.'); render(); }catch(e){ alert(e.message); } };
window.postReview=async(e,id,delEnabled)=>{ e.preventDefault(); const f=e.target;
  const body={vendor_id:id, food:+f.food.value, hygiene:+f.hygiene.value, value:+f.value.value, overall:+f.overall.value, comment:f.comment.value};
  if(delEnabled && f.delivery.value) body.delivery=+f.delivery.value;
  try{ const j=await api('POST','/api/reviews',body); document.getElementById('revMsg').textContent=' ✓ Review saved ('+j.status+').'; renderVendor(id); }
  catch(err){ document.getElementById('revMsg').textContent=' ✗ '+err.message; } };
async function fileToBase64(file){
  if(!file) return null;
  const buf = await file.arrayBuffer();
  let bin=''; const bytes=new Uint8Array(buf);
  for(let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function renderAccount(){
  if(!me){ app.innerHTML='<p>Please <a href="#/login">log in</a> first to change your password.</p>'; return; }
  app.innerHTML=`<h1>Account — Change password</h1><div class="panel"><p class="muted">Logged in as ${esc(me.name)} (${esc(me.role)}). Changing your password keeps this session and signs out your other sessions.</p>
  <form onsubmit="doChangePassword(event)"><label>Old password</label><input name="old_password" type="password" required>
  <label>New password (8+ characters)</label><input name="new_password" type="password" required>
  <button style="margin-top:10px">Change password</button><span id="cpMsg" class="muted"></span></form></div>`;
}
window.doChangePassword=async(e)=>{ e.preventDefault(); const f=e.target;
  try{ const j=await api('POST','/api/auth/change-password',{old_password:f.old_password.value,new_password:f.new_password.value}); document.getElementById('cpMsg').textContent=' ✓ '+j.message; f.reset(); }
  catch(err){ document.getElementById('cpMsg').textContent=' ✗ '+err.message; } };
function renderStatic(title, html){ app.innerHTML=`<h1>${title}</h1><div class="panel">${html}</div>`; }
function renderContact(){
  app.innerHTML=`<h1>Contact FoodScope</h1><div class="panel"><form onsubmit="sendContact(event)">
  <label>Name</label><input name="name" required><label>Email</label><input name="email" type="email" required>
  <label>Subject</label><input name="subject" required><label>Message (10+ characters)</label><textarea name="message" rows="4" required></textarea>
  <button style="margin-top:10px">Send message</button><span id="cMsg" class="muted"></span></form></div>`;
}
window.sendContact=async(e)=>{ e.preventDefault(); const f=e.target;
  try{ const j=await api('POST','/api/contact',{name:f.name.value,email:f.email.value,subject:f.subject.value,message:f.message.value}); document.getElementById('cMsg').textContent=' ✓ '+j.message; f.reset(); }
  catch(err){ document.getElementById('cMsg').textContent=' ✗ '+err.message; } };
function renderLogin(){
  app.innerHTML=`<h1>Log in</h1><div class="panel"><form onsubmit="doLogin(event)">
  <label>Email or phone</label><input name="identifier" required placeholder="mhkh3200@gmail.com for admin">
  <label>Password</label><input name="password" type="password" required>
  <button style="margin-top:10px">Log in</button><span id="lMsg" class="muted"></span></form>
  <div id="otpBox"></div><p class="muted">Managers: after your password you will be asked for a login OTP code (shown on screen in development mode).</p></div>`;
}
window.doLogin=async(e)=>{ e.preventDefault(); const f=e.target;
  try{ const j=await api('POST','/api/auth/login',{identifier:f.identifier.value,password:f.password.value});
    if(j.otp_required){ document.getElementById('otpBox').innerHTML=`<div class="ok">Login OTP (development only): <b>${esc(j.dev_code||'sent')}</b></div>
      <form onsubmit="doLoginVerify(event,'${j.login_token}')"><label>Login OTP code</label><input name="code" required><button style="margin-top:10px">Verify &amp; log in</button></form>`; return; }
    document.getElementById('lMsg').textContent=' ✓ Logged in as '+j.user.role; location.hash = j.user.role==='owner' ? '#/admin' : j.user.role==='manager' ? '#/manager' : '#/';
  }catch(err){ document.getElementById('lMsg').textContent=' ✗ '+err.message; } };
window.doLoginVerify=async(e,token)=>{ e.preventDefault();
  try{ const j=await api('POST','/api/auth/login-verify',{login_token:token,code:e.target.code.value}); location.hash='#/manager'; }
  catch(err){ alert(err.message); } };
function renderRegister(){
  app.innerHTML=`<h1>Register</h1>
  <div class="panel"><h3>Customer — exactly one contact channel</h3><form onsubmit="doRegCustomer(event)">
  <label>Name</label><input name="name" required>
  <label><input type="radio" name="ctype" value="email" checked style="width:auto"> Email</label>
  <label><input type="radio" name="ctype" value="phone" style="width:auto"> Phone</label>
  <label>Email (if email chosen)</label><input name="email" type="email">
  <label>Phone (if phone chosen, e.g. 03001234567)</label><input name="phone">
  <label>Password (8+ characters)</label><input name="password" type="password" required>
  <button style="margin-top:10px">Register as customer</button><span id="rcMsg" class="muted"></span></form><div id="rcCode"></div></div>
  <div class="panel"><h3>Manager — register a food business</h3><form onsubmit="doRegManager(event)">
  <label>Name</label><input name="name" required><label>Email</label><input name="email" type="email" required>
  <label>Password (8+ characters)</label><input name="password" type="password" required>
  <button style="margin-top:10px">Register as manager</button><span id="rmMsg" class="muted"></span></form><div id="rmCode"></div></div>
  <div class="panel"><h3>Verify your account</h3><form onsubmit="doVerify(event)">
  <label>Email or phone used at registration</label><input name="identifier" required>
  <label>6-digit code</label><input name="code" required>
  <button style="margin-top:10px">Verify</button><span id="vMsg" class="muted"></span></form></div>`;
}
window.doRegCustomer=async(e)=>{ e.preventDefault(); const f=e.target; const ct=f.ctype.value;
  const body={name:f.name.value,password:f.password.value}; if(ct==='email') body.email=f.email.value; else body.phone=f.phone.value;
  try{ const j=await api('POST','/api/auth/register-customer',body); document.getElementById('rcCode').innerHTML=`<div class="ok">Account created. Development verification code: <b>${esc(j.dev_code||'—')}</b> — enter it in the verify form below.</div>`; }
  catch(err){ document.getElementById('rcMsg').textContent=' ✗ '+err.message; } };
window.doRegManager=async(e)=>{ e.preventDefault(); const f=e.target;
  try{ const j=await api('POST','/api/auth/register-manager',{name:f.name.value,email:f.email.value,password:f.password.value}); document.getElementById('rmCode').innerHTML=`<div class="ok">Manager account created. Development verification code: <b>${esc(j.dev_code||'—')}</b> — enter it in the verify form below.</div>`; }
  catch(err){ document.getElementById('rmMsg').textContent=' ✗ '+err.message; } };
window.doVerify=async(e)=>{ e.preventDefault(); const f=e.target;
  try{ const j=await api('POST','/api/auth/verify',{identifier:f.identifier.value,code:f.code.value}); document.getElementById('vMsg').textContent=' ✓ '+j.message; }
  catch(err){ document.getElementById('vMsg').textContent=' ✗ '+err.message; } };
async function renderManager(){
  if(!me){ app.innerHTML='<p>Please <a href="#/login">log in</a> as a manager first.</p>'; return; }
  if(me.role==='staff'){
    const j=await api('GET','/api/staff/vendor').catch(e=>({error:e.message}));
    if(j.error){ app.innerHTML=`<div class="err">${esc(j.error)}</div>`; return; }
    app.innerHTML=`<h1>Staff Panel — ${esc(j.vendor.name)}</h1><p class="muted">You can manage menu and availability for your assigned vendor only.</p>
    <div class="panel"><h3>Menu</h3>${j.menu.map(m=>`<div class="menu-item"><span>${esc(m.name)} — PKR ${m.price_pkr}</span><span>${m.available?'Available':'Unavailable'} <button class="small" onclick="staffToggle(${m.id},${m.available?0:1})">Toggle availability</button></span></div>`).join('')}</div>`;
    window.staffToggle=async(id,avail)=>{ await api('PATCH','/api/staff/menu/'+id,{available:!!avail}); renderManager(); };
    return;
  }
  if(me.role!=='manager'){ app.innerHTML='<p>This panel is for managers. Admins use <a href="#/admin">Admin Panel</a>.</p>'; return; }
  const j=await api('GET','/api/manager/vendor');
  if(!j.vendor){
    app.innerHTML=`<h1>Manager Panel</h1><div class="panel"><h3>Submit your vendor (one only)</h3><form onsubmit="submitVendor(event)">
    <label>Business name</label><input name="name" required>
    <div class="row"><div><label>Category</label><select name="category"><option>Desi</option><option>BBQ</option><option>Karahi</option><option>Fast Food</option><option>Sweets</option><option>Chinese</option><option>Bakery</option><option>Beverages</option></select></div>
    <div><label>City</label><input name="city" required></div></div>
    <label>Area</label><input name="area"><label>Address</label><input name="address">
    <label>Description</label><textarea name="description" rows="3"></textarea>
    <label>Delivery phone</label><input name="delivery_phone"><label>Google Maps URL</label><input name="google_maps_url">
    <label>Primary image URL</label><input name="primary_image_url">
    <div class="row"><div><label><input type="checkbox" name="delivery_enabled" style="width:auto"> Delivery enabled</label></div>
    <div><label>Delivery fee (PKR)</label><input name="delivery_fee_pkr" type="number" value="0"></div>
    <div><label>Min order (PKR)</label><input name="min_order_pkr" type="number" value="0"></div></div>
    <button style="margin-top:10px">Submit for review</button><span id="svMsg" class="muted"></span></form></div>`;
    window.submitVendor=async(e)=>{ e.preventDefault(); const f=e.target;
      const body={name:f.name.value,category:f.category.value,city:f.city.value,area:f.area.value,address:f.address.value,description:f.description.value,delivery_phone:f.delivery_phone.value,google_maps_url:f.google_maps_url.value,primary_image_url:f.primary_image_url.value,delivery_enabled:f.delivery_enabled.checked,delivery_fee_pkr:+f.delivery_fee_pkr.value,min_order_pkr:+f.min_order_pkr.value};
      try{ await api('POST','/api/manager/vendors',body); renderManager(); }catch(err){ document.getElementById('svMsg').textContent=' ✗ '+err.message; } };
    return;
  }
  const v=j.vendor;
  app.innerHTML=`<h1>Manager Panel — ${esc(v.name)}</h1>
  <p><span class="badge">${esc(v.status)}</span> <span class="badge">${esc(v.subscription_plan||'No plan yet')}</span> ${v.subscription_expires_at?`<span class="badge">Subscription until ${esc(v.subscription_expires_at.slice(0,10))}</span>`:''}</p>
  <div class="cards"><div class="card"><div class="num">${v.menu.length}</div><div class="lbl">Menu items</div></div><div class="card"><div class="num">${v.reviews.length}</div><div class="lbl">Reviews</div></div><div class="card"><div class="num">${v.payments.filter(p=>p.status==='approved').reduce((a,p)=>a+p.amount_pkr,0)}</div><div class="lbl">PKR approved payments</div></div></div>
  <div class="panel"><h3>Subscription payment</h3><form onsubmit="payPlan(event,${v.id})">
    <div class="row"><div><label>Plan</label><select name="plan"><option>Basic</option><option>Premium</option><option>Featured</option></select></div>
    <div><label>Method</label><select name="method"><option>Bank Transfer</option><option>Easypaisa</option><option>JazzCash</option><option>Sadapay</option><option>Nayapay</option><option>Manual Reference</option></select></div>
    <div><label>Reference / transaction ID</label><input name="reference_text" required></div></div>
    <label>Payment proof file (PNG/JPEG/PDF, under 5 MB, optional)</label><input name="proof_file" type="file" accept=".png,.jpg,.jpeg,.pdf">
    <p class="muted">Basic 30 days PKR 1,500 · Premium 90 days PKR 4,500 · Featured 90 days PKR 9,000. Proof is checked by MIME type and file signature on the server.</p>
    <button>Submit payment</button><span id="payMsg" class="muted"></span></form>
    <h4>Payments</h4>${v.payments.map(p=>`<p>${esc(p.plan)} — PKR ${p.amount_pkr} — ${esc(p.method)} — ${esc(p.status)}</p>`).join('')||'<p class="muted">No payments yet.</p>'}</div>
  <div class="panel"><h3>Sensitive-field update request</h3><p class="muted">Name, Google Maps URL, delivery phone, image URLs and slug can only change after admin approval.</p>
  <form onsubmit="updateReq(event,${v.id})"><label>New business name (optional)</label><input name="name"><label>New Google Maps URL (optional)</label><input name="google_maps_url"><button style="margin-top:10px">Request update</button><span id="urMsg" class="muted"></span></form>
  <h4>Update requests</h4>${v.update_requests.map(r=>`<p>#${r.id} — ${esc(r.status)} — ${esc(r.fields_json)}</p>`).join('')||'<p class="muted">None yet.</p>'}</div>
  <div class="panel"><h3>Add menu item</h3><form onsubmit="addMenu(event)"><div class="row"><div><label>Name</label><input name="name" required></div><div><label>Price (PKR)</label><input name="price_pkr" type="number" required></div></div><button style="margin-top:10px">Add item</button></form>
  <h4>Menu</h4>${v.menu.map(m=>`<div class="menu-item"><span>${esc(m.name)} — PKR ${m.price_pkr}</span><span>${m.available?'Available':'Unavailable'} <button class="small" onclick="mgrToggle(${m.id},${m.available?0:1})">Toggle</button></span></div>`).join('')}</div>
  <div class="panel"><h3>Certificates</h3><form onsubmit="addCert(event,${v.id})"><label>Certificate type</label><input name="cert_type" required placeholder="e.g. Food Licence"><label>Certificate file (PNG/JPEG/PDF, under 5 MB, optional)</label><input name="cert_file" type="file" accept=".png,.jpg,.jpeg,.pdf"><button style="margin-top:10px">Submit certificate</button><span id="certMsg" class="muted"></span></form>
  ${v.certificates.map(c=>`<p>${esc(c.cert_type)} — ${esc(c.status)}</p>`).join('')||'<p class="muted">No certificates yet.</p>'}</div>
  <div class="panel"><h3>Gallery photo (needs admin approval before it shows publicly)</h3><form onsubmit="addGallery(event)"><label>Image URL</label><input name="url" required placeholder="https://…"><label>Caption</label><input name="caption"><button style="margin-top:10px">Submit gallery photo</button><span id="galMsg" class="muted"></span></form>
  <h4>Gallery</h4>${v.gallery.map(g=>`<p>${esc(g.url.slice(0,60))} — ${esc(g.status)}</p>`).join('')||'<p class="muted">No gallery photos yet.</p>'}</div>
  <div class="panel"><h3>Add staff (menu/availability only, for this vendor)</h3><form onsubmit="addStaff(event)"><label>Staff name</label><input name="name" required><label>Staff email</label><input name="email" type="email" required><label>Staff password (8+ characters)</label><input name="password" type="password" required><button style="margin-top:10px">Add staff</button><span id="staffMsg" class="muted"></span></form>
  <p class="muted">Staff can only manage menu and availability for this vendor — never vendor details, payments or admin routes.</p></div>`;
  window.payPlan=async(e,id)=>{ e.preventDefault(); const f=e.target;
    try{ const body={plan:f.plan.value,method:f.method.value,reference_text:f.reference_text.value,vendor_id:id};
      const file=f.proof_file.files[0];
      if(file){ body.proof_filename=file.name; body.proof_mimetype=file.type; body.proof_base64=await fileToBase64(file); }
      const j=await api('POST','/api/manager/payments',body); document.getElementById('payMsg').textContent=' ✓ Payment submitted (PKR '+j.amount_pkr+', pending admin approval).'; renderManager(); }
    catch(err){ document.getElementById('payMsg').textContent=' ✗ '+err.message; } };
  window.addGallery=async(e)=>{ e.preventDefault(); const f=e.target;
    try{ await api('POST','/api/manager/gallery',{url:f.url.value,caption:f.caption.value}); renderManager(); }catch(err){ document.getElementById('galMsg').textContent=' ✗ '+err.message; } };
  window.addStaff=async(e)=>{ e.preventDefault(); const f=e.target;
    try{ const j=await api('POST','/api/manager/staff',{name:f.name.value,email:f.email.value,password:f.password.value}); document.getElementById('staffMsg').textContent=' ✓ Staff added (id '+j.staffId+').'; f.reset(); }
    catch(err){ document.getElementById('staffMsg').textContent=' ✗ '+err.message; } };
  window.updateReq=async(e,id)=>{ e.preventDefault(); const f=e.target; const body={}; if(f.name.value) body.name=f.name.value; if(f.google_maps_url.value) body.google_maps_url=f.google_maps_url.value;
    try{ await api('POST','/api/manager/vendors/'+id+'/update-request',body); renderManager(); }catch(err){ document.getElementById('urMsg').textContent=' ✗ '+err.message; } };
  window.addMenu=async(e)=>{ e.preventDefault(); const f=e.target;
    try{ await api('POST','/api/manager/menu',{name:f.name.value,price_pkr:+f.price_pkr.value}); renderManager(); }catch(err){ alert(err.message); } };
  window.mgrToggle=async(id,avail)=>{ await api('PATCH','/api/manager/menu/'+id,{available:!!avail}); renderManager(); };
  window.addCert=async(e,id)=>{ e.preventDefault(); const f=e.target;
    try{ const body={cert_type:f.cert_type.value,vendor_id:id};
      const file=f.cert_file.files[0];
      if(file){ body.file_filename=file.name; body.file_mimetype=file.type; body.file_base64=await fileToBase64(file); }
      await api('POST','/api/manager/certificates',body); renderManager(); }catch(err){ document.getElementById('certMsg').textContent=' ✗ '+err.message; } };
}
async function renderAdmin(){
  if(!me){ app.innerHTML='<p>Please <a href="#/login">log in</a> as the Portal Admin first.</p>'; return; }
  if(me.role!=='owner'){ app.innerHTML='<div class="err">Admin panel is for the Portal Admin (owner) only. Your role: '+esc(me.role)+'</div>'; return; }
  const [rep, vendors, pays, reqs, reviews, auditLog, certs, gallery, users, contacts] = await Promise.all([
    api('GET','/api/admin/reports'), api('GET','/api/admin/vendors'), api('GET','/api/admin/payments'),
    api('GET','/api/admin/update-requests'), api('GET','/api/admin/reviews'), api('GET','/api/admin/audit-log'),
    api('GET','/api/admin/certificates'), api('GET','/api/admin/gallery'), api('GET','/api/admin/users'), api('GET','/api/admin/contacts'),
  ]).catch(e=>{ app.innerHTML=`<div class="err">${esc(e.message)}</div>`; return []; });
  if(!rep) return;
  const t=rep.totals;
  app.innerHTML=`<h1>Admin Dashboard — FoodScope</h1><p class="muted">Portal Admin overview. All approvals, suspensions and emergency edits are audit-logged.</p>
  <div class="cards">
    <div class="card"><div class="num" data-count="${t.vendors_total}">0</div><div class="lbl">Vendors total</div></div>
    <div class="card"><div class="num" data-count="${t.vendors_approved}">0</div><div class="lbl">Approved</div></div>
    <div class="card"><div class="num" data-count="${t.vendors_pending}">0</div><div class="lbl">Pending</div></div>
    <div class="card"><div class="num" data-count="${t.reviews_active}">0</div><div class="lbl">Active reviews</div></div>
    <div class="card"><div class="num" data-count="${t.payments_approved_total_pkr}">0</div><div class="lbl">PKR approved payments</div></div>
  </div>
  <div class="panel"><h3>Top 5 by rating</h3><table><tr><th>Vendor</th><th>City</th><th>Avg</th><th>Reviews</th></tr>${rep.top_by_rating.map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.city)}</td><td>${x.avg_overall}</td><td>${x.n}</td></tr>`).join('')||'<tr><td colspan="4">No rated vendors yet</td></tr>'}</table>
  <h3>Top 5 by review count</h3><table><tr><th>Vendor</th><th>City</th><th>Reviews</th><th>Avg</th></tr>${rep.top_by_review_count.map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.city)}</td><td>${x.n}</td><td>${x.avg_overall}</td></tr>`).join('')||'<tr><td colspan="4">None yet</td></tr>'}</table>
  <h3>Category totals</h3><p>${rep.category_totals.map(c=>`${esc(c.category)}: ${c.n}`).join(' · ')}</p></div>
  <div class="panel"><h3>Vendors — approve / reject / suspend</h3><table><tr><th>Name</th><th>City</th><th>Status</th><th>Plan</th><th>Actions</th></tr>${vendors.vendors.map(v=>`<tr><td>${esc(v.name)}</td><td>${esc(v.city)}</td><td>${esc(v.status)}</td><td>${esc(v.subscription_plan||'—')}</td><td>
    <button class="small" onclick="adminVendor(${v.id},'approve')">Approve</button>
    <button class="small ghost" onclick="adminVendorReason(${v.id},'reject')">Reject</button>
    <button class="small danger" onclick="adminVendorReason(${v.id},'suspend')">Suspend</button>
    <button class="small ghost" onclick="adminVendor(${v.id},'unsuspend')">Unsuspend</button>
    <button class="small ghost" onclick="adminEmergencyEdit(${v.id})">Emergency edit</button>
    <button class="small danger" onclick="adminEmergencyDelete(${v.id})">Emergency delete</button></td></tr>`).join('')}</table>
  <p class="muted">Emergency edit/delete both require a safety reason (5+ characters) and are audit-logged.</p></div>
  <div class="panel"><h3>Certificates</h3>${certs.certificates.map(c=>`<p>#${c.id} ${esc(c.manager_name)} — ${esc(c.cert_type)} — ${esc(c.status)} ${c.status==='pending'?`<button class="small" onclick="adminCert(${c.id},'approve')">Approve</button> <button class="small ghost" onclick="adminCert(${c.id},'reject')">Reject</button>`:''}</p>`).join('')||'<p class="muted">No certificates.</p>'}</div>
  <div class="panel"><h3>Gallery images (pending approval)</h3>${gallery.gallery.filter(g=>g.status==='pending').map(g=>`<p>#${g.id} ${esc(g.vendor_name)} — ${esc(g.url.slice(0,60))} <button class="small" onclick="adminGallery(${g.id},'approve')">Approve</button> <button class="small ghost" onclick="adminGallery(${g.id},'reject')">Reject</button></p>`).join('')||'<p class="muted">No pending gallery images.</p>'}</div>
  <div class="panel"><h3>Users — suspend / activate</h3>${users.users.map(u=>`<p>#${u.id} ${esc(u.name)} (${esc(u.email||u.phone||'')}) — ${esc(u.role)} — ${esc(u.status)} ${u.role!=='owner'?`<button class="small ghost" onclick="adminUser(${u.id},'suspend')">Suspend</button> <button class="small" onclick="adminUser(${u.id},'activate')">Activate</button>`:''}</p>`).join('')}</div>
  <div class="panel"><h3>Contact messages</h3>${contacts.contacts.slice(0,20).map(c=>`<p>${esc(c.name)} (${esc(c.email)}) — ${esc(c.subject)}: ${esc(c.message.slice(0,100))}</p>`).join('')||'<p class="muted">No contact messages.</p>'}</div>
  <div class="panel"><h3>Payments</h3>${pays.payments.map(p=>`<p>#${p.id} ${esc(p.manager_name)} — ${esc(p.plan)} PKR ${p.amount_pkr} — ${esc(p.method)} — ${esc(p.status)} ${p.status==='pending'?`<button class="small" onclick="adminPay(${p.id},'approve')">Approve</button> <button class="small ghost" onclick="adminPay(${p.id},'reject')">Reject</button>`:''}</p>`).join('')||'<p class="muted">No payments.</p>'}</div>
  <div class="panel"><h3>Update requests</h3>${reqs.requests.map(r=>`<p>#${r.id} ${esc(r.vendor_name)} — ${esc(r.status)} — ${esc(r.fields_json)} ${r.status==='pending'?`<button class="small" onclick="adminUpd(${r.id},'approve')">Approve</button> <button class="small ghost" onclick="adminUpd(${r.id},'reject')">Reject</button>`:''}</p>`).join('')||'<p class="muted">None.</p>'}</div>
  <div class="panel"><h3>Reviews — moderation</h3>${reviews.reviews.slice(0,20).map(r=>`<p>#${r.id} ${esc(r.vendor_name)} — ${esc(r.customer_name)} — ${esc(r.status)} — ${esc(r.comment.slice(0,80))} <button class="small ghost" onclick="adminReviewNote(${r.id})">Add note</button> <button class="small ghost" onclick="adminReviewReply(${r.id})">Reply</button> <button class="small ghost" onclick="adminReview(${r.id},'delete')">Soft-delete</button> <button class="small" onclick="adminReview(${r.id},'restore')">Restore (admin only)</button></p>`).join('')||'<p class="muted">No reviews.</p>'}</div>
  <div class="panel"><h3>Audit log (latest)</h3>${auditLog.log.slice(0,30).map(a=>`<p class="muted">${esc(a.created_at)} — ${esc(a.action)} — ${esc(a.target_type||'')} #${a.target_id??''} ${a.reason?esc('· '+a.reason):''}</p>`).join('')}</div>`;
  animateCounters();
  window.adminVendor=async(id,act)=>{ await api('POST',`/api/admin/vendors/${id}/${act}`,{}); renderAdmin(); };
  window.adminVendorReason=async(id,act)=>{ const reason=prompt('Reason for '+act+' (required):'); if(!reason) return; await api('POST',`/api/admin/vendors/${id}/${act}`,{reason}); renderAdmin(); };
  window.adminPay=async(id,act)=>{ const body={}; if(act==='reject'){ const r=prompt('Rejection reason:'); if(!r) return; body.reason=r; } await api('POST',`/api/admin/payments/${id}/${act}`,body); renderAdmin(); };
  window.adminUpd=async(id,act)=>{ const body={}; if(act==='reject'){ const r=prompt('Rejection reason:'); if(!r) return; body.reason=r; } await api('POST',`/api/admin/update-requests/${id}/${act}`,body); renderAdmin(); };
  window.adminReview=async(id,act)=>{ await api('POST',`/api/admin/reviews/${id}/${act}`,{reason:'Moderated from admin panel'}); renderAdmin(); };
  window.adminCert=async(id,act)=>{ const body={}; if(act==='reject'){ const r=prompt('Rejection reason:'); if(!r) return; body.reason=r; } await api('POST',`/api/admin/certificates/${id}/${act}`,body); renderAdmin(); };
  window.adminGallery=async(id,act)=>{ await api('POST',`/api/admin/gallery/${id}/${act}`,{}); renderAdmin(); };
  window.adminUser=async(id,act)=>{ await api('POST',`/api/admin/users/${id}/${act}`,{}); renderAdmin(); };
  window.adminReviewNote=async(id)=>{ const note=prompt('Admin note for this review:'); if(!note) return; await api('POST',`/api/admin/reviews/${id}/note`,{note}); renderAdmin(); };
  window.adminReviewReply=async(id)=>{ const reply=prompt('Admin reply to this review:'); if(!reply) return; await api('POST',`/api/admin/reviews/${id}/reply`,{reply}); renderAdmin(); };
  window.adminEmergencyEdit=async(id)=>{ const reason=prompt('Safety reason for emergency edit (5+ characters, required):'); if(!reason) return; const name=prompt('New vendor name (leave blank to keep current):'); const fields={}; if(name) fields.name=name; if(!Object.keys(fields).length){ alert('No field entered — nothing changed.'); return; } await api('POST',`/api/admin/vendors/${id}/emergency-edit`,{reason,fields}); renderAdmin(); };
  window.adminEmergencyDelete=async(id)=>{ const reason=prompt('Safety reason for emergency DELETE (5+ characters, required):'); if(!reason) return; if(!confirm('Delete this vendor permanently?')) return; await api('DELETE',`/api/admin/vendors/${id}`,{reason}); renderAdmin(); };
}
window.addEventListener('hashchange', render);
render();
