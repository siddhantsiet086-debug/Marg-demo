/* =====================================================================
   Smart Billing & Stock Hub  -  Multi-Store Edition
   Run:  npm install express multer tesseract.js xlsx
         node server.js
   ===================================================================== */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 5000;
const SUPER_USER = (process.env.SUPER_USER || 'admin').toLowerCase();   // aapka (owner) login
const SUPER_PASS = process.env.SUPER_PASS || 'admin@123';               // IMPORTANT: change karein

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');   // hosting par DATA_DIR ko pakke (persistent) disk par rakhein
const STORES_FILE = path.join(DATA_DIR, 'stores.json');
const OLD_DB = path.join(__dirname, 'marg_data.json');                  // purana single-store data (auto migrate)

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
const upload = multer({ dest: 'uploads/', limits: { fileSize: 15 * 1024 * 1024 } });

/* ------------------------------ helpers ------------------------------ */
const esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
};
const inr = function (n) { return '\u20B9' + Number(n || 0).toFixed(2); };
const enc = encodeURIComponent;

function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function isExpired(exp) {
    if (!exp) return false;
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return new Date(exp) < t;
}
function isExpiringSoon(exp) {
    if (!exp) return false;
    return (new Date(exp) - new Date()) / 86400000 <= 30;
}
function counterName(req) {
    const ip = (req.ip || '').replace('::ffff:', '');
    if (!ip || ip === '127.0.0.1' || ip === '::1') return 'System-1 (Main)';
    return 'Counter-' + (ip.split('.').pop() || 'LAN');
}
function waLink(phone, text) {
    let d = String(phone || '').replace(/\D/g, '');
    if (d.length === 10) d = '91' + d;
    return 'https://wa.me/' + d + '?text=' + enc(text);
}
function go(res, tab, msg, extra) {
    res.redirect('/?tab=' + tab + (msg ? '&msg=' + enc(msg) : '') + (extra || ''));
}

/* ---------------------------- security utils ---------------------------- */
const sha = function (s) { return crypto.createHash('sha256').update(String(s)).digest(); };
const safeEq = function (a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); };
const newSalt = function () { return crypto.randomBytes(12).toString('hex'); };
const hashPass = function (pass, salt) { return crypto.scryptSync(String(pass), salt, 32).toString('hex'); };
const checkPass = function (pass, salt, hash) { return safeEq(hashPass(pass, salt), hash); };

/* ----------------------------- file storage ----------------------------- */
function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
}
const storeFile = function (id) { return path.join(DATA_DIR, 'store_' + id + '.json'); };
const saveStores = function (reg) { writeJson(STORES_FILE, reg); };
function loadData(id) {
    const d = readJson(storeFile(id), {});
    if (!d.products) d.products = [];
    if (!d.bills) d.bills = [];
    if (!d.purchaseOrders) d.purchaseOrders = [];
    if (!d.incoming) d.incoming = [];
    d.products.forEach(function (p) { if (!p.packSize) p.packSize = 1; });
    return d;
}
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');

/* ------------------------- subscription (dates) helpers ------------------------- */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = function (iso) { return iso ? parseInt(iso.slice(8, 10)) + ' ' + MON[parseInt(iso.slice(5, 7)) - 1] + ' ' + iso.slice(0, 4) : ''; };
const isoDate = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); };
function addDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function addMonths(iso, n) {
    const p = iso.split('-').map(Number);
    let y = p[0], m = p[1] - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return y + '-' + pad2(m + 1) + '-' + pad2(Math.min(p[2], dim));
}
const planEnd = function (from, months) { return addDays(addMonths(from, months), -1); };      // 22 Nov + 3 mahine = 21 Feb (inclusive)
const daysBetween = function (a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); };
function subState(st) {
    if (!st.active) return { code: 'disabled', label: 'Blocked', msg: 'Ye account band hai. Owner se sampark karein.' };
    const t = todayStr();
    if (st.subFrom && t < st.subFrom) return { code: 'upcoming', label: 'Not started', msg: 'Aapka subscription ' + fmtDate(st.subFrom) + ' se shuru hoga.' };
    if (st.subTo) {
        if (t > st.subTo) return { code: 'expired', label: 'Expired', msg: 'Aapka subscription ' + fmtDate(st.subTo) + ' ko khatam ho gaya. Renew ke liye owner se sampark karein.' };
        const left = daysBetween(t, st.subTo);
        if (left <= 7) return { code: 'expiring', label: 'Expiring', left: left };
        return { code: 'active', label: 'Active', left: left };
    }
    return { code: 'active', label: 'Active', left: null };
}
const BLOCKED = ['disabled', 'expired', 'upcoming'];

/* ------------------------------- stores & owner ------------------------------- */
function loadStores() {
    const reg = readJson(STORES_FILE, { stores: [] });
    reg.stores.forEach(function (s) {
        if (!s.suppliers) s.suppliers = [];
        if (!s.subs) s.subs = [];
        if (s.otpPhone === undefined) s.otpPhone = '';
        s.suppliers.forEach(function (x) { if (x.otpPhone === undefined) x.otpPhone = ''; });
        if (s.subFrom === undefined) { s.subFrom = ''; s.subTo = ''; }          // purane store = lifetime (lock nahi hoga)
    });
    return reg;
}
function usernameTaken(reg, u) {
    u = String(u).toLowerCase();
    if (u === SUPER_USER) return true;
    return reg.stores.some(function (s) { return s.username === u || (s.suppliers || []).some(function (x) { return x.username === u; }); });
}
function adminOk(u, p) {
    const a = readJson(ADMIN_FILE, null);
    return !!a && u === SUPER_USER && checkPass(p, a.salt, a.hash);
}
function makeStore(reg, f) {
    const salt = newSalt();
    const id = String(reg.stores.reduce(function (m, s) { return Math.max(m, parseInt(s.id) || 0); }, 0) + 1);
    const custom = String(f.months) === 'custom';                       // calendar se khud ki dates
    const months = custom ? 0 : (parseInt(f.months) || 0), from = isoDate(f.from) ? f.from : todayStr();
    const to = custom ? f.to : (months > 0 ? planEnd(from, months) : '');
    return {
        id: id, name: f.name, username: f.username.toLowerCase(), phone: f.phone || '', address: f.address || '', gstin: f.gstin || '',
        salt: salt, hash: hashPass(f.password, salt), pinHash: hashPass(f.pin || '1234', salt),
        active: true, createdAt: new Date().toLocaleString('en-IN'),
        subFrom: from, subTo: to,
        subs: [{ from: from, to: to, months: months, amount: parseFloat(f.amount) || 0, note: custom ? 'New account (custom dates)' : 'New account', at: todayStr() }],
        suppliers: [], otpPhone: normPhone(f.otpPhone)
    };
}
function initStores() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
    if (!fs.existsSync(ADMIN_FILE)) {
        const salt = newSalt();
        writeJson(ADMIN_FILE, { salt: salt, hash: hashPass(SUPER_PASS, salt), phone: normPhone(process.env.OWNER_PHONE) });
    }
    if (process.env.RESET_OWNER_PASS) {                // owner password bhool jayein to: RESET_OWNER_PASS=naya_password ke saath ek baar chalayein
        const a = readJson(ADMIN_FILE, {}), salt = newSalt();
        a.salt = salt; a.hash = hashPass(process.env.RESET_OWNER_PASS, salt); writeJson(ADMIN_FILE, a);
        console.log('*** Owner password RESET ho gaya. Ab RESET_OWNER_PASS wali setting hata dein. ***');
    }
    if (fs.existsSync(STORES_FILE)) return;
    const reg = { stores: [] };
    if (fs.existsSync(OLD_DB)) {                       // purana single-store data -> pehla store (lifetime)
        const s = makeStore(reg, { name: 'My Medical Store', username: 'store1', password: 'store1234', months: 0 });
        reg.stores.push(s);
        fs.copyFileSync(OLD_DB, storeFile(s.id));
    }
    saveStores(reg);
}

/* ------------------------------- sessions ------------------------------- */
/* ======================= MOBILE OTP (2-step login) =======================
   Login ID + password sahi hone ke baad registered mobile par 6 digit OTP jata hai.
   Settings (environment variables, start.bat mein):
     SMS_PROVIDER=fast2sms   FAST2SMS_KEY=...   (optional DLT: FAST2SMS_SENDER_ID, FAST2SMS_TEMPLATE_ID)
     SMS_PROVIDER=msg91      MSG91_KEY=...      MSG91_TEMPLATE_ID=...
     OTP_MODE=on | off | test    (test = OTP sirf server console mein aata hai, sirf jaanch ke liye)
     OWNER_PHONE=98XXXXXXXX      (owner ka mobile, pehli baar)                                    */
const SMS_PROVIDER = (process.env.SMS_PROVIDER || '').toLowerCase();
const OTP_MODE = (process.env.OTP_MODE || (SMS_PROVIDER ? 'on' : 'off')).toLowerCase();
const otpOn = function () { return OTP_MODE === 'on' || OTP_MODE === 'test'; };
const OTP_TTL = 5 * 60 * 1000, OTP_MAX_TRIES = 5, OTP_RESEND_WAIT = 30 * 1000, OTP_MAX_RESEND = 3, OTP_HOURLY = 6;
const pending = new Map();           // pid -> {data, phone, salt, hash, exp, tries, resends, last}
const otpSent = new Map();           // phone -> [bheje gaye samay]

function normPhone(x) {
    let d = String(x || '').replace(/\D/g, '');
    if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2); else if (d.length === 11 && d[0] === '0') d = d.slice(1);
    return /^[6-9]\d{9}$/.test(d) ? d : '';
}
const maskPhone = function (p) { return 'XXXXXX' + String(p).slice(-4); };
const genOtp = function () { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); };
const hashOtp = function (otp, salt) { return crypto.createHash('sha256').update(salt + otp).digest('hex'); };
const otpInfo = function (phone) {
    if (!otpOn()) return '';
    return phone ? 'OTP: ' + maskPhone(phone) : '<span style="color:#b91c1c;font-weight:700">OTP mobile missing</span>';
};

async function sendSms(phone, otp) {
    if (OTP_MODE === 'test') { console.log('[TEST OTP] ' + maskPhone(phone) + ' -> ' + otp); return; }
    const sig = AbortSignal.timeout(12000);
    if (SMS_PROVIDER === 'fast2sms') {
        const dlt = process.env.FAST2SMS_SENDER_ID && process.env.FAST2SMS_TEMPLATE_ID;
        const body = dlt ? { route: 'dlt', sender_id: process.env.FAST2SMS_SENDER_ID, message: process.env.FAST2SMS_TEMPLATE_ID, variables_values: otp, numbers: phone }
            : { route: 'otp', variables_values: otp, numbers: phone };
        const r = await fetch(process.env.FAST2SMS_URL || 'https://www.fast2sms.com/dev/bulkV2', {
            method: 'POST', headers: { authorization: process.env.FAST2SMS_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: sig
        });
        const j = await r.json().catch(function () { return {}; });
        if (!r.ok || j.return !== true) throw new Error('fast2sms: ' + (j.message || r.status));
    } else if (SMS_PROVIDER === 'msg91') {
        const q = new URLSearchParams({ template_id: process.env.MSG91_TEMPLATE_ID, mobile: '91' + phone, authkey: process.env.MSG91_KEY, otp: otp });
        const r = await fetch((process.env.MSG91_URL || 'https://control.msg91.com/api/v5/otp') + '?' + q.toString(), { method: 'POST', headers: { 'content-type': 'application/json' }, signal: sig });
        const j = await r.json().catch(function () { return {}; });
        if (!r.ok || j.type !== 'success') throw new Error('msg91: ' + (j.message || r.status));
    } else throw new Error('SMS provider set nahi hai');
}
function checkOtpConfig() {
    if (OTP_MODE === 'on') {
        const ok = (SMS_PROVIDER === 'fast2sms' && process.env.FAST2SMS_KEY) || (SMS_PROVIDER === 'msg91' && process.env.MSG91_KEY && process.env.MSG91_TEMPLATE_ID);
        if (!ok) {
            console.error('GALAT SETTINGS: OTP chalu hai par SMS provider ki settings poori nahi hain.');
            console.error('fast2sms ke liye FAST2SMS_KEY, ya msg91 ke liye MSG91_KEY aur MSG91_TEMPLATE_ID set karein (start.bat dekhein).');
            process.exit(1);
        }
        console.log('Mobile OTP: CHALU (' + SMS_PROVIDER + ')');
    } else if (OTP_MODE === 'test') console.log('WARNING: OTP TEST MODE - OTP sirf yahan console mein dikhega. Asli istemaal ke liye mat chalayein.');
    else console.log('Mobile OTP: BAND (SMS provider set nahi hai). Surakshit login ke liye start.bat mein SMS_PROVIDER set karein.');
}
setInterval(function () { const n = Date.now(); pending.forEach(function (v, k) { if (v.exp < n) pending.delete(k); }); }, 60000).unref();

async function beginOtp(req, res, data, phone) {
    const now = Date.now();
    const hist = (otpSent.get(phone) || []).filter(function (t) { return now - t < 3600000; });
    if (hist.length >= OTP_HOURLY) return res.redirect('/login?err=' + enc('Is number par bahut OTP bheje ja chuke hain. 1 ghante baad try karein.'));
    const otp = genOtp(), salt = newSalt();
    try { await sendSms(phone, otp); }
    catch (e) { console.error('OTP bhejne mein error:', e.message); return res.redirect('/login?err=' + enc('OTP bhejne mein dikkat aayi. Thodi der baad dobara try karein.')); }
    hist.push(now); otpSent.set(phone, hist);
    const pid = crypto.randomBytes(24).toString('hex');
    pending.set(pid, { data: data, phone: phone, salt: salt, hash: hashOtp(otp, salt), exp: now + OTP_TTL, tries: 0, resends: 0, last: now });
    res.append('Set-Cookie', 'pid=' + pid + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=600');
    res.redirect('/verify-otp');
}
const landing = function (d) { return d.type === 'admin' ? '/admin' : (d.type === 'supplier' ? '/supplier' : '/'); };

app.get('/verify-otp', function (req, res) {
    const p = pending.get(cookieOf(req, 'pid'));
    if (!p || p.exp < Date.now()) return res.redirect('/login?err=' + enc('OTP expire ho gaya. Dobara login karein.'));
    const wait = Math.max(0, Math.ceil((p.last + OTP_RESEND_WAIT - Date.now()) / 1000));
    const msg = req.query.err ? '<div class="alert">' + esc(req.query.err) + '</div>' : (req.query.ok ? '<div class="alert" style="background:#dcfce7;border-left-color:#16a34a;color:#14532d">' + esc(req.query.ok) + '</div>' : '');
    res.send(page('OTP Verify',
        '<div class="auth"><div class="auth-brand"><div class="logo" style="width:48px;height:48px;font-size:28px">+</div>' +
        '<h1>Ek aur kadam: OTP se verify karein</h1><p>Surakshit login ke liye aapke registered mobile par 6 digit ka OTP bheja gaya hai. Ye 5 minute tak chalega.</p></div>' +
        '<div class="auth-form"><div class="auth-box"><h2>OTP daalein</h2><p class="sub">' + esc(maskPhone(p.phone)) + ' par bheja gaya</p>' + msg +
        '<form method="POST" action="/verify-otp"><label for="o">6 digit OTP</label>' +
        '<input id="o" name="otp" class="w100" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus style="font-size:22px;letter-spacing:8px;text-align:center">' +
        '<button class="btn btn-primary w100" style="margin-top:14px;padding:12px">Verify &amp; Login</button></form>' +
        '<form method="POST" action="/resend-otp" style="margin-top:12px;text-align:center"><button id="rs" class="btn btn-gray btn-sm" disabled>OTP dobara bhejein</button></form>' +
        '<p style="text-align:center;margin:14px 0 0"><a href="/login" style="color:var(--muted);font-size:13px">&larr; Wapas login par</a></p></div></div></div>' +
        '<script>var w=' + wait + ',b=document.getElementById("rs");function t(){if(w>0){b.textContent="Dobara bhejein ("+w+"s)";w--;setTimeout(t,1000);}else{b.textContent="OTP dobara bhejein";b.disabled=false;}}t();</script>'));
});
app.post('/verify-otp', function (req, res) {
    const pid = cookieOf(req, 'pid'), p = pending.get(pid);
    if (!p || p.exp < Date.now()) { pending.delete(pid); return res.redirect('/login?err=' + enc('OTP expire ho gaya. Dobara login karein.')); }
    const code = String(req.body.otp || '').replace(/\D/g, '');
    if (code.length === 6 && safeEq(hashOtp(code, p.salt), p.hash)) {
        pending.delete(pid);
        res.append('Set-Cookie', 'pid=; Path=/; Max-Age=0');
        startSession(res, Object.assign({}, p.data));
        return res.redirect(landing(p.data));
    }
    p.tries++;
    if (p.tries >= OTP_MAX_TRIES) { pending.delete(pid); return res.redirect('/login?err=' + enc('Bahut zyada galat OTP. Dobara login karein.')); }
    res.redirect('/verify-otp?err=' + enc('Galat OTP. ' + (OTP_MAX_TRIES - p.tries) + ' koshish baaki.'));
});
app.post('/resend-otp', async function (req, res) {
    const pid = cookieOf(req, 'pid'), p = pending.get(pid), now = Date.now();
    if (!p || p.exp < now) return res.redirect('/login?err=' + enc('OTP expire ho gaya. Dobara login karein.'));
    const back = function (m) { res.redirect('/verify-otp?err=' + enc(m)); };
    if (now - p.last < OTP_RESEND_WAIT) return back('Thoda ruko, 30 second baad dobara bhej sakte hain.');
    if (p.resends >= OTP_MAX_RESEND) { pending.delete(pid); return res.redirect('/login?err=' + enc('Resend ki limit poori ho gayi. Dobara login karein.')); }
    const hist = (otpSent.get(p.phone) || []).filter(function (t) { return now - t < 3600000; });
    if (hist.length >= OTP_HOURLY) return back('Is number par bahut OTP bheje ja chuke hain. 1 ghante baad try karein.');
    const otp = genOtp(), salt = newSalt();
    try { await sendSms(p.phone, otp); } catch (e) { console.error('OTP resend error:', e.message); return back('OTP bhejne mein dikkat aayi. Thodi der baad try karein.'); }
    hist.push(now); otpSent.set(p.phone, hist);
    p.salt = salt; p.hash = hashOtp(otp, salt); p.exp = now + OTP_TTL; p.last = now; p.resends++; p.tries = 0;
    res.redirect('/verify-otp?ok=' + enc('Naya OTP bhej diya gaya.'));
});

const sessions = new Map();
const SESSION_MS = 12 * 3600 * 1000;
function cookieOf(req, name) {
    const m = (req.headers.cookie || '').split(';').map(function (c) { return c.trim(); })
        .find(function (c) { return c.indexOf(name + '=') === 0; });
    return m ? m.slice(name.length + 1) : '';
}
function startSession(res, data) {
    const sid = crypto.randomBytes(24).toString('hex');
    data.created = Date.now();
    sessions.set(sid, data);
    res.append('Set-Cookie', 'sid=' + sid + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=' + (SESSION_MS / 1000));
}
app.use(function (req, res, next) {
    const sid = cookieOf(req, 'sid');
    let s = sid ? sessions.get(sid) : null;
    if (s && Date.now() - s.created > SESSION_MS) { sessions.delete(sid); s = null; }
    req.session = s; req.sid = sid;
    next();
});
function toLogin(req, res) {                           // purani cookie hai par session nahi = server restart / 12 ghante
    res.redirect('/login' + (req.sid ? '?err=' + enc('Session khatam ho gaya (server dobara chalne ya 12 ghante ke baad). Dobara login karein.') : ''));
}
function gate(req, res, store) {                      // account block / subscription khatam hone par turant bahar
    const sc = subState(store);
    if (BLOCKED.indexOf(sc.code) > -1) {
        sessions.delete(req.sid);
        res.redirect('/login?err=' + enc(sc.msg));
        return false;
    }
    return true;
}
function requireStore(req, res, next) {
    const s = req.session;
    if (!s) return toLogin(req, res);
    if (s.type === 'admin') return res.redirect('/admin');
    if (s.type === 'supplier') return res.redirect('/supplier');
    const store = loadStores().stores.find(function (x) { return x.id === s.storeId; });
    if (!store) { sessions.delete(req.sid); return res.redirect('/login'); }
    if (!gate(req, res, store)) return;
    req.store = store;
    req.sub = subState(store);
    req.data = loadData(store.id);
    req.save = function () { writeJson(storeFile(store.id), req.data); };
    next();
}
function requireSupplier(req, res, next) {
    const s = req.session;
    if (!s) return toLogin(req, res);
    if (s.type === 'admin') return res.redirect('/admin');
    if (s.type === 'store') return res.redirect('/');
    const store = loadStores().stores.find(function (x) { return x.id === s.storeId; });
    if (!store) { sessions.delete(req.sid); return res.redirect('/login'); }
    if (!gate(req, res, store)) return;
    const sup = (store.suppliers || []).find(function (x) { return x.id === s.supplierId; });
    if (!sup || !sup.active) { sessions.delete(req.sid); return res.redirect('/login?err=' + enc('Ye supplier account band hai. Store se sampark karein.')); }
    req.store = store; req.supplier = sup;
    req.data = loadData(store.id);
    req.save = function () { writeJson(storeFile(store.id), req.data); };
    next();
}
function requireAdmin(req, res, next) {
    if (!req.session || req.session.type !== 'admin') return toLogin(req, res);
    next();
}
const fails = new Map();
const tooMany = function (ip) { const f = fails.get(ip); return f && f.count >= 6 && Date.now() - f.t < 600000; };
function noteFail(ip) {
    const f = fails.get(ip) || { count: 0, t: 0 };
    if (Date.now() - f.t > 600000) f.count = 0;
    f.count++; f.t = Date.now(); fails.set(ip, f);
}

/* ----------------- supplier bill text -> items (OCR parser) ----------------- */
const BILL_SKIP = /\b(total|sub\s*total|invoice|bill\s*no|date|gstin|gst\s*no|phone|mobile|mob|address|cgst|sgst|igst|discount|round|amount|signature|thank|licen[cs]e|d\.?l\.?\s*no|item\s*name|particulars|description|batch|hsn|page)\b/i;
const tIsNum = function (t) { return /^\d+(?:[.,]\d+)?$/.test(t); };
const tIsInt = function (t) { return /^\d+$/.test(t); };
const tIsDec = function (t) { return /^\d+[.,]\d{1,2}$/.test(t); };
const tIsExp = function (t) { return /^\d{1,2}[\/\-]\d{2,4}$/.test(t); };
const tIsBatch = function (t) {
    return /^[A-Za-z0-9\-\/]{3,12}$/.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t) &&
        !/(mg|ml|gm|g|mcg|iu|tab|tabs|cap|syp|inj|s)$/i.test(t) && !/^\d+x\d+$/i.test(t);
};
function parseBillText(text) {
    const out = [];
    String(text || '').split(/\r?\n/).forEach(function (raw) {
        let line = raw.replace(/[|_\t]/g, ' ').replace(/\s+/g, ' ').trim();
        if (line.length < 5 || BILL_SKIP.test(line)) return;
        line = line.replace(/^\d{1,3}\s*[.):\-]?\s+(?=[A-Za-z])/, '');          // serial number hatao
        const tk = line.split(' ');
        let i = 0;
        const name = [];
        while (i < tk.length && !tIsNum(tk[i]) && !tIsExp(tk[i])) { name.push(tk[i]); i++; }
        const rest = tk.slice(i);
        let batch = '', expiry = '';
        if (name.length > 1 && tIsBatch(name[name.length - 1]) && rest.some(tIsInt)) batch = name.pop();
        if (name.length && rest.length > 1 && tIsInt(rest[0]) && (tIsInt(rest[1]) || tIsBatch(rest[1]) || tIsExp(rest[1]))) name.push(rest.shift());   // Dolo 650
        while (rest.length && (tIsBatch(rest[0]) || tIsExp(rest[0]))) {
            const t = rest.shift();
            if (tIsExp(t)) expiry = t; else batch = t;
        }
        const qi = rest.findIndex(tIsInt);
        const nm = name.join(' ').replace(/[^A-Za-z0-9 .+%'\/\-]/g, '').trim();
        if (qi < 0 || (nm.match(/[A-Za-z]/g) || []).length < 3) return;
        const qty = parseInt(rest[qi]);
        if (!(qty > 0) || qty > 99999) return;
        const dec = rest.slice(qi + 1).find(tIsDec) || rest.find(tIsDec);
        out.push({ name: nm, batch: batch, expiry: expiry, qty: qty, rate: dec ? parseFloat(dec.replace(',', '.')) : 0 });
    });
    return out;
}

/* ---------- units: strip / pack + loose tablet ----------
   Stock hamesha sabse chhoti unit (tablet) mein store hota hai.
   packSize = ek strip/pack mein kitni tablet (syrup, injection = 1). */
const packOf = function (p) { return Math.max(1, parseInt(p.packSize) || 1); };
function fmtQty(base, pack) {
    pack = Math.max(1, pack || 1);
    if (pack === 1) return String(base);
    const s = Math.floor(base / pack), t = base % pack, out = [];
    if (s) out.push(s + (s === 1 ? ' Strip' : ' Strips'));
    if (t || !s) out.push(t + (t === 1 ? ' Tab' : ' Tabs'));
    return out.join(' + ');
}
const isLow = function (p) { return p.stock < 10 * packOf(p); };          // 10 strip se kam = low stock
function lineAmt(rate, pack, qty, gst) {
    const b = rate / pack * qty;
    return Math.round((b + b * gst / 100) * 100) / 100;
}

/* ---------- purana data / dusre software ki Excel import ----------
   Marg, Busy, Gofrugal ya kisi bhi software ki stock Excel ke alag-alag column naam pehchante hain. */
const ALIASES = {
    name: ['name', 'itemname', 'item', 'product', 'productname', 'medicine', 'medicinename', 'particulars', 'description'],
    batch: ['batch', 'batchno', 'batchnumber'],
    expiry: ['expiry', 'exp', 'expirydate', 'expdate', 'expiredate'],
    mrp: ['mrp', 'maxretailprice'],
    rate: ['rate', 'salerate', 'srate', 'salesrate', 'price', 'sellingprice', 'sprice'],
    gst: ['gst', 'gstpercent', 'gstrate', 'tax', 'taxpercent'],
    pack: ['packsize', 'pack', 'packing', 'tabletsperstrip', 'tabsperstrip', 'unitspack', 'qtyperpack', 'conversion'],
    stock: ['stock', 'qty', 'quantity', 'closingstock', 'closing', 'balance', 'currentstock', 'clqty', 'bal']
};
function mapRow(row) {
    const norm = {}, out = {};
    Object.keys(row).forEach(function (k) { norm[String(k).toLowerCase().replace(/[^a-z0-9]/g, '')] = row[k]; });
    Object.keys(ALIASES).forEach(function (f) {
        for (let i = 0; i < ALIASES[f].length; i++) {
            const v = norm[ALIASES[f][i]];
            if (v !== undefined && v !== '') { out[f] = v; break; }
        }
    });
    return out;
}
function parsePack(v) {
    const n = String(v == null ? '' : v).match(/\d+/g);
    return n ? Math.max(1, parseInt(n[n.length - 1])) : 1;               // "1x10" ya "10's" -> 10
}
function readSheetRows(file) {
    const wb = XLSX.readFile(file, { cellDates: true, raw: true });   // raw: CSV ki expiry '08/27' ko date na bana de
    try { fs.unlinkSync(file); } catch (e) { }
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
}
function importRows(d, rows) {
    let added = 0, skipped = 0;
    rows.forEach(function (row, idx) {
        const r = mapRow(row);
        const name = String(r.name || '').trim();
        const pack = parsePack(r.pack);
        const strips = parseFloat(r.stock);
        if (!name || !(strips > 0)) { skipped++; return; }
        const gst = parseFloat(r.gst);
        addOrMerge(d, {
            name: name, batch: String(r.batch || 'B01').trim(), expiry: normExpiry(r.expiry), mrp: parseFloat(r.mrp) || 0,
            rate: parseFloat(r.rate) || 0, gst: isNaN(gst) ? 12 : gst, packSize: pack, stock: Math.round(strips * pack)
        }, idx);
        added++;
    });
    return { added: added, skipped: skipped };
}

/* ---------- bill photo OCR (internet ke bina bhi chalta hai) ----------
   Language file ./tessdata/eng.traineddata local rehti hai. Na ho aur internet ho to ek baar apne aap download. */
const TESS_DIR = path.join(__dirname, 'tessdata');
const TESS_FILE = path.join(TESS_DIR, 'eng.traineddata');
function ensureTessdata() {
    if (fs.existsSync(TESS_FILE)) return;
    try {
        if (!fs.existsSync(TESS_DIR)) fs.mkdirSync(TESS_DIR);
        require('https').get('https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata', function (r) {
            if (r.statusCode !== 200) { r.resume(); return; }
            const tmp = TESS_FILE + '.part', ws = fs.createWriteStream(tmp);
            r.pipe(ws);
            ws.on('finish', function () { try { fs.renameSync(tmp, TESS_FILE); console.log('OCR language data download ho gaya - ab photo scan offline bhi chalega.'); } catch (e) { } });
        }).on('error', function () { });
    } catch (e) { }
}
async function ocrText(file) {
    const worker = await Tesseract.createWorker('eng', 1, { langPath: TESS_DIR, gzip: false, cacheMethod: 'none' });
    try {
        await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
        const r = await worker.recognize(file);
        return r.data.text || '';
    } finally { await worker.terminate(); }
}

/* ---------------------------------- CSS ---------------------------------- */
const CSS = `
*{box-sizing:border-box}
:root{--ink:#10282a;--muted:#5b7270;--line:#dbe6e4;--bg:#eaf1f0;--card:#fff;--pine:#0b2b29;--teal:#0f766e;--teal-d:#0b5c56;--mint:#d9f2ee;--amber:#b45309;--amber-bg:#fef3c7;--red:#b91c1c;--red-bg:#fee2e2;--blue:#1d4ed8;--blue-bg:#dbeafe}
html,body{margin:0}
body{font-family:'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:var(--ink);font-size:14px;min-height:100vh;
background:radial-gradient(1100px 520px at 88% -8%,rgba(15,118,110,.16),transparent 60%),radial-gradient(900px 520px at -8% 112%,rgba(14,165,233,.12),transparent 55%),var(--bg);background-attachment:fixed}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Cpath d='M32 25v14M25 32h14' stroke='%230f766e' stroke-width='2.2' stroke-linecap='round' opacity='.08'/%3E%3C/svg%3E")}
.topbar{position:sticky;top:0;z-index:20;display:flex;justify-content:space-between;align-items:center;padding:11px 26px;background:rgba(255,255,255,.9);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(145deg,#14b8a6,var(--teal-d));display:grid;place-items:center;color:#fff;font-weight:800;font-size:22px;box-shadow:0 4px 10px rgba(15,118,110,.35)}
.brand b{font-size:16px;display:block;line-height:1.2}.brand small{color:var(--muted);font-size:12px}
.top-right{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:13px}
.pill{background:var(--mint);color:var(--teal-d);padding:5px 12px;border-radius:999px;font-weight:600;font-size:12px}
.workspace{display:flex;position:relative;z-index:1;min-height:calc(100vh - 62px)}
.sidebar{width:236px;flex-shrink:0;background:linear-gradient(180deg,var(--pine),#081d1b);padding:20px 12px;display:flex;flex-direction:column;gap:4px}
.nav-label{color:#6f9a95;font-size:12px;font-weight:600;padding:0 14px 8px}
.nav-item{display:block;padding:11px 14px;border-radius:8px;color:#b8d0cd;text-decoration:none;font-weight:600;border-left:3px solid transparent;transition:background .15s}
.nav-item:hover{background:rgba(255,255,255,.07);color:#fff}
.nav-item.active{background:rgba(255,255,255,.12);color:#fff;border-left-color:#5eead4}
.side-foot{margin-top:auto;padding:12px 14px;border-radius:8px;background:rgba(255,255,255,.06);color:#8fb3ae;font-size:12px;line-height:1.5}
.main{flex:1;min-width:0;max-width:1320px;padding:24px 28px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:15px 18px;box-shadow:0 1px 2px rgba(16,40,42,.04)}
.stat span{font-size:12px;color:var(--muted);font-weight:600}
.stat b{display:block;font-size:23px;margin-top:6px;font-variant-numeric:tabular-nums}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px;margin-bottom:20px;box-shadow:0 1px 2px rgba(16,40,42,.04),0 10px 28px rgba(16,40,42,.05)}
.card-title{margin:0 0 16px;font-size:18px;padding-bottom:12px;border-bottom:1px solid var(--line)}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:10px}
th{background:#f3f8f7;color:#35504d;font-weight:700;text-align:left;padding:10px 12px;border-bottom:2px solid var(--line);white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid #eef3f2;vertical-align:middle}
tbody tr:hover td{background:#f8fbfa}
input,select{padding:9px 12px;margin:3px 0;border:1px solid #c5d6d3;border-radius:7px;font-size:14px;font-family:inherit;background:#fff;color:var(--ink);outline:none}
input:focus,select:focus{border-color:var(--teal);box-shadow:0 0 0 3px rgba(15,118,110,.15)}
label{font-weight:600;font-size:13px;display:block;margin-top:6px}
.w100{width:100%}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.row>*{flex:1;min-width:120px}
.btn{padding:9px 16px;border:none;border-radius:7px;cursor:pointer;font-weight:600;font-size:13.5px;font-family:inherit;text-decoration:none;display:inline-block;color:#fff;transition:filter .15s}
.btn:hover{filter:brightness(1.08)}
.btn:focus-visible,.nav-item:focus-visible{outline:3px solid #5eead4;outline-offset:2px}
.btn-primary{background:var(--teal)}.btn-success{background:#15803d}.btn-warning{background:#d97706}.btn-danger{background:#dc2626}.btn-gray{background:#64748b}.btn-wa{background:#22a559}
.btn-sm{padding:6px 11px;font-size:12px}
.alert{background:var(--amber-bg);color:#78350f;padding:12px 16px;border-left:4px solid #f59e0b;border-radius:7px;margin-bottom:16px;font-weight:600}
.badge{display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;margin-left:6px}
.b-red{background:var(--red-bg);color:var(--red)}.b-yellow{background:var(--amber-bg);color:var(--amber)}.b-blue{background:var(--blue-bg);color:var(--blue);margin-left:0}.b-green{background:#dcfce7;color:#166534}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.panel{background:#f5faf9;border:1px solid var(--line);border-radius:9px;padding:16px}
.empty{text-align:center;color:var(--muted);padding:26px}
.total-bar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;background:var(--mint);padding:14px 18px;border-radius:9px;margin-top:16px}
.total-bar b{font-size:21px;color:var(--teal-d)}
.modal{position:fixed;inset:0;background:rgba(8,29,27,.6);display:flex;justify-content:center;align-items:center;z-index:99}
.modal>div{background:#fff;padding:28px;border-radius:12px;width:380px;max-width:92vw;text-align:center;border-top:6px solid #dc2626}
.auth{min-height:100vh;display:grid;grid-template-columns:1.1fr 1fr;position:relative;z-index:1}
.auth-brand{background:linear-gradient(155deg,#0b2b29 0%,#0f766e 100%);color:#fff;padding:56px;display:flex;flex-direction:column;justify-content:center;gap:18px;position:relative;overflow:hidden}
.auth-brand::after{content:"";position:absolute;right:-90px;bottom:-90px;width:340px;height:340px;border-radius:50%;background:rgba(255,255,255,.06)}
.auth-brand h1{font-size:34px;line-height:1.2;margin:0;max-width:440px}
.auth-brand p{color:#b8e4de;max-width:420px;line-height:1.6;margin:0}
.auth-brand ul{margin:6px 0 0;padding:0;list-style:none;color:#d6f2ee;line-height:2}
.auth-brand li::before{content:"\\2713";margin-right:10px;color:#5eead4;font-weight:800}
.auth-form{display:flex;align-items:center;justify-content:center;padding:32px}
.auth-box{width:100%;max-width:380px;background:#fff;border:1px solid var(--line);border-radius:14px;padding:32px;box-shadow:0 20px 50px rgba(16,40,42,.12)}
.auth-box h2{margin:0 0 4px;font-size:22px}.auth-box .sub{color:var(--muted);margin:0 0 18px}
@media(max-width:900px){.auth{grid-template-columns:1fr}.auth-brand{padding:32px}.workspace{flex-direction:column}.sidebar{width:auto;flex-direction:row;overflow-x:auto;padding:10px}.side-foot,.nav-label{display:none}.nav-item{white-space:nowrap}.stats{grid-template-columns:1fr 1fr}.grid-2{grid-template-columns:1fr}.main{padding:16px}.topbar{padding:10px 14px}}
@media print{body::before,.topbar,.sidebar,.stats,.no-print{display:none!important}.main{padding:0;max-width:100%}body{background:#fff}.card{box-shadow:none;border:none}}
`;

function page(title, body) {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>' + esc(title) + '</title>' +
        '<style>' + CSS + '</style></head><body>' + body + '</body></html>';
}
function tbl(headers, rows, id) {
    return '<div class="tw"><table' + (id ? ' id="' + id + '"' : '') + '><thead><tr>' +
        headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}
function emptyRow(cols, text) { return '<tr><td colspan="' + cols + '" class="empty">' + text + '</td></tr>'; }

/* ------------------------------ app layout ------------------------------ */
function layout(req, tab, content, extra) {
    const d = req.data, st = req.store, today = todayStr();
    let total = 0, cash = 0, upi = 0, alerts = 0;
    d.bills.forEach(function (b) {
        if ((b.isoDate || today) === today) {
            total += b.total;
            if (b.paymentMode === 'UPI') upi += b.total; else if (b.paymentMode === 'Cash') cash += b.total;
        }
    });
    d.products.forEach(function (p) { if (isLow(p) || isExpiringSoon(p.expiry)) alerts++; });
    const pend = d.incoming.filter(function (x) { return x.status === 'pending'; }).length;

    const nav = [['billing', 'Sale Bill'], ['add-stock', 'Add Stock'], ['supplier-bills', 'Supplier Bills'], ['current-stock', 'Current Stock'],
        ['reports', 'Bills &amp; Reports'], ['purchase-order', 'Purchase Orders'], ['settings', 'Store Settings']]
        .map(function (n) {
            return '<a href="/?tab=' + n[0] + '" class="nav-item' + (tab === n[0] ? ' active' : '') + '">' + n[1] +
                (n[0] === 'supplier-bills' && pend ? '<span class="badge b-red">' + pend + ' new</span>' : '') + '</a>';
        }).join('');
    const banner = req.sub && req.sub.code === 'expiring'
        ? '<div class="alert no-print" style="margin:0;border-radius:0">Aapka subscription ' + (req.sub.left === 0 ? 'aaj' : req.sub.left + ' din mein') + ' khatam ho raha hai (' + fmtDate(st.subTo) + '). Renew ke liye owner se sampark karein.</div>' : '';

    return page(st.name + ' - Billing',
        '<div class="topbar"><div class="brand"><div class="logo">+</div><div><b>' + esc(st.name) + '</b><small>Smart Billing &amp; Stock Hub</small></div></div>' +
        '<div class="top-right"><span class="pill">' + esc(counterName(req)) + '</span><a href="/logout" class="btn btn-gray btn-sm">Logout</a></div></div>' +
        banner + (extra || '') +
        '<div class="workspace"><div class="sidebar"><div class="nav-label">Main Menu</div>' + nav +
        '<div class="side-foot">Login: <b style="color:#fff">' + esc(st.username) + '</b><br>Is store ka data bilkul alag aur surakshit hai.</div></div>' +
        '<div class="main"><div class="stats">' +
        '<div class="stat"><span>Today\'s Total Sale</span><b style="color:var(--teal)">' + inr(total) + '</b></div>' +
        '<div class="stat"><span>Today\'s Cash</span><b style="color:#15803d">' + inr(cash) + '</b></div>' +
        '<div class="stat"><span>Today\'s UPI / Online</span><b style="color:var(--blue)">' + inr(upi) + '</b></div>' +
        '<div class="stat"><span>Stock &amp; Expiry Alerts</span><b style="color:var(--red)">' + alerts + ' Items</b></div>' +
        '</div>' + content + '</div></div>');
}

/* ------------------------------ login / logout ------------------------------ */
app.get('/login', function (req, res) {
    if (req.session) return res.redirect(req.session.type === 'admin' ? '/admin' : (req.session.type === 'supplier' ? '/supplier' : '/'));
    const err = req.query.err ? '<div class="alert">' + esc(req.query.err) + '</div>' : '';
    res.send(page('Login - Smart Billing & Stock Hub',
        '<div class="auth"><div class="auth-brand"><div class="logo" style="width:48px;height:48px;font-size:28px">+</div>' +
        '<h1>Medical store billing, stock aur expiry - sab ek jagah.</h1>' +
        '<p>Har store ka apna login aur apna alag data. Kisi doosre store ke bills ya stock kabhi nahi dikhte.</p>' +
        '<ul><li>Fast GST billing aur WhatsApp bill</li><li>Strip aur loose tablet dono ki billing</li><li>Supplier ka bill seedha confirm karke stock mein</li></ul></div>' +
        '<div class="auth-form"><form class="auth-box" method="POST" action="/login"><h2>Welcome back</h2><p class="sub">Apna login ID aur password daalein</p>' + err +
        '<label for="u">Login ID</label><input id="u" name="username" class="w100" required autofocus autocomplete="username">' +
        '<label for="p">Password</label><input id="p" type="password" name="password" class="w100" required autocomplete="current-password">' +
        '<button type="submit" class="btn btn-primary w100" style="margin-top:18px;padding:12px">Login</button></form></div></div>'));
});
app.post('/login', async function (req, res) {
    const ip = req.ip;
    const bad = function (m, why) { noteFail(ip); console.log('[login fail] ' + new Date().toLocaleString('en-IN') + ' | ID=' + String(req.body.username || '').trim() + ' | ' + (why || m)); res.redirect('/login?err=' + enc(m)); };
    if (tooMany(ip)) return res.redirect('/login?err=' + enc('Bahut zyada galat koshish. 10 minute baad try karein.'));
    const u = String(req.body.username || '').trim().toLowerCase();
    const p = String(req.body.password || '');
    if (adminOk(u, p)) {
        fails.delete(ip);
        const ap = otpOn() ? normPhone((readJson(ADMIN_FILE, {}) || {}).phone) : '';
        if (ap) return beginOtp(req, res, { type: 'admin' }, ap);          // owner ka mobile set hai to OTP lagega
        startSession(res, { type: 'admin' });
        return res.redirect('/admin');
    }
    const reg = loadStores();
    let st = reg.stores.find(function (x) { return x.username === u; }), sup = null;
    if (st) {
        if (!checkPass(p, st.salt, st.hash)) return bad('Login ID ya password galat hai.', 'store mila par PASSWORD galat (owner panel se naya password set kar sakte hain)');
    } else {
        reg.stores.forEach(function (x) { const y = (x.suppliers || []).find(function (z) { return z.username === u; }); if (y) { st = x; sup = y; } });
        if (!sup && u === SUPER_USER) return bad('Login ID ya password galat hai.', 'OWNER password galat (yaad rahe: SUPER_PASS sirf pehli baar chalta hai; badalna ho to RESET_OWNER_PASS use karein)');
        if (!sup) return bad('Login ID ya password galat hai.', 'ye Login ID is data folder mein hai hi nahi (data folder: ' + DATA_DIR + ')');
        if (!checkPass(p, sup.salt, sup.hash)) return bad('Login ID ya password galat hai.', 'supplier mila par PASSWORD galat');
        if (!sup.active) return res.redirect('/login?err=' + enc('Ye supplier account band hai. Store se sampark karein.'));
    }
    const sc = subState(st);
    if (BLOCKED.indexOf(sc.code) > -1) { console.log('[login roka gaya] ' + new Date().toLocaleString('en-IN') + ' | ID=' + u + ' | karan: ' + sc.code + ' (' + sc.msg + ')'); return res.redirect('/login?err=' + enc(sc.msg)); }
    fails.delete(ip);
    const sess = sup ? { type: 'supplier', storeId: st.id, supplierId: sup.id } : { type: 'store', storeId: st.id, cart: [], scan: [] };
    if (otpOn()) {
        const phone = normPhone(sup ? sup.otpPhone : st.otpPhone);
        if (!phone) return res.redirect('/login?err=' + enc('Is account par OTP mobile number set nahi hai. ' + (sup ? 'Store' : 'Owner') + ' se sampark karein.'));
        return beginOtp(req, res, sess, phone);
    }
    startSession(res, sess);
    res.redirect(sup ? '/supplier' : '/');
});
app.get('/logout', function (req, res) {
    if (req.sid) sessions.delete(req.sid);
    res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
    res.redirect('/login');
});

/* ------------------------------ SUPER ADMIN PANEL ------------------------------
   Yahan kisi bhi store/supplier ka password kabhi nahi dikhta (sab hash hain). Sirf naya password set kar sakte hain. */
const PLAN_BASE = '<option value="1">1 Month</option><option value="3">3 Months</option><option value="6">6 Months</option><option value="12" selected>12 Months</option><option value="24">24 Months</option><option value="0">Lifetime</option>';
const PLAN_OPTS = PLAN_BASE + '<option value="custom">Custom dates (calendar se)</option>';
const PLAN_JS = `<script>
(function(){
var M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function pad(n){return ('0'+n).slice(-2);}
function addDays(i,n){var d=new Date(i+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function addMonths(i,n){var p=i.split('-').map(Number),y=p[0],m=p[1]-1+n;y+=Math.floor(m/12);m=((m%12)+12)%12;var dim=new Date(Date.UTC(y,m+1,0)).getUTCDate();return y+'-'+pad(m+1)+'-'+pad(Math.min(p[2],dim));}
function fmt(i){return +i.slice(8)+' '+M[+i.slice(5,7)-1]+' '+i.slice(0,4);}
function span(a,b){return Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/864e5)+1;}
function upd(f){
 var sel=f.querySelector('[name=months]'),from=f.querySelector('[name=from]'),to=f.querySelector('[name=to]'),cust=f.querySelector('.cust'),pv=f.querySelector('.prev');
 var c=sel.value==='custom';
 cust.style.display=c?'':'none'; to.required=c; if(cust.contains(from)){from.required=c;}
 var start=c?from.value:(f.dataset.base||from.value),end='';
 if(c){end=to.value;}else if(sel.value!=='0'&&start){end=addDays(addMonths(start,+sel.value),-1);}
 pv.style.color='var(--teal-d)';
 if(sel.value==='0'){pv.textContent='Plan: Lifetime (kabhi expire nahi hoga)';}
 else if(!start||!end){pv.textContent=c?'Calendar se start aur end date chunein':'';}
 else if(end<start){pv.textContent='End date start se pehle hai!';pv.style.color='#b91c1c';}
 else{pv.textContent='Plan: '+fmt(start)+' se '+fmt(end)+' tak ('+span(start,end)+' din)';}
}
document.querySelectorAll('form.planform').forEach(function(f){['input','change'].forEach(function(e){f.addEventListener(e,function(){upd(f);});});upd(f);});
})();
</script>`;
function planBadge(st) {
    const sc = subState(st);
    const cls = { active: 'b-green', expiring: 'b-yellow', expired: 'b-red', disabled: 'b-red', upcoming: 'b-blue' }[sc.code];
    return '<span class="badge ' + cls + '" style="margin-left:0">' + sc.label + '</span>';
}
function planText(st) {
    if (!st.subTo) return '<b>Lifetime</b>' + (st.subFrom ? '<br><small>Since ' + fmtDate(st.subFrom) + '</small>' : '');
    const left = daysBetween(todayStr(), st.subTo);
    const txt = left > 0 ? left + ' din baaki' : (left === 0 ? 'Aaj aakhri din' : 'Expired ' + (-left) + ' din pehle');
    return '<b>' + fmtDate(st.subFrom) + ' &rarr; ' + fmtDate(st.subTo) + '</b><br><small>' + txt + ' | total ' + (daysBetween(st.subFrom, st.subTo) + 1) + ' din</small>';
}
app.get('/admin', requireAdmin, function (req, res) {
    const reg = loadStores(), today = todayStr();
    const msg = req.query.msg ? '<div class="alert">' + esc(req.query.msg) + '</div>' : '';
    let active = 0, need = 0, money = 0;
    const alertList = [];
    const urgency = function (x) { return x.subTo ? daysBetween(today, x.subTo) : 99999; };      // jo pehle khatam ho wo upar, lifetime sabse neeche
    const rows = reg.stores.slice().sort(function (a, b) { return urgency(a) - urgency(b); }).map(function (s) {
        const d = loadData(s.id), sc = subState(s);
        let t = 0, n = 0;
        d.bills.forEach(function (b) { if ((b.isoDate || today) === today) { t += b.total; n++; } });
        if (sc.code === 'active' || sc.code === 'expiring') active++;
        const leftD = s.subTo ? daysBetween(today, s.subTo) : null;
        if (s.active && leftD !== null && leftD <= 15) {                    // 15 din ke andar ya expire = renewal alert
            need++;
            const wa = waLink(s.phone, 'Namaste, ' + s.name + ' ka Smart Billing subscription ' + fmtDate(s.subTo) + ' ko khatam ' + (leftD < 0 ? 'ho chuka hai' : 'ho raha hai') + '. Renew karne ke liye kripya sampark karein.');
            const left = leftD < 0 ? '<span class="badge b-red" style="margin-left:0">Expired ' + (-leftD) + ' din pehle</span>' :
                (leftD === 0 ? '<span class="badge b-red" style="margin-left:0">Aaj aakhri din</span>' : '<span class="badge b-yellow" style="margin-left:0">' + leftD + ' din baaki</span>');
            alertList.push({ left: leftD, html: '<tr><td><b>' + esc(s.name) + '</b><br><small>' + esc(s.phone || 'Phone nahi diya') + '</small></td><td>' + fmtDate(s.subTo) + '</td><td>' + left + '</td>' +
                '<td style="white-space:nowrap"><form method="POST" action="/admin/renew" style="display:inline-flex;gap:6px;align-items:center;margin:0"><input type="hidden" name="id" value="' + s.id + '">' +
                '<select name="months" style="margin:0;padding:6px">' + PLAN_BASE + '</select><input type="number" name="amount" min="0" step="0.01" placeholder="Rs." style="width:80px;margin:0;padding:6px"><button class="btn btn-success btn-sm">Renew</button></form> ' +
                '<a class="btn btn-wa btn-sm" target="_blank" href="' + esc(wa) + '">WhatsApp Reminder</a></td></tr>' });
        }
        (s.subs || []).forEach(function (x) { money += x.amount || 0; });
        const hist = (s.subs || []).slice().reverse().map(function (x) {
            return '<li>' + fmtDate(x.from) + ' &rarr; ' + (x.to ? fmtDate(x.to) : 'Lifetime') + (x.amount ? ' | ' + inr(x.amount) : '') + (x.note ? ' | ' + esc(x.note) : '') + '</li>';
        }).join('');
        const hid = '<input type="hidden" name="id" value="' + s.id + '">';
        const delForm = '<details style="border-top:1px solid var(--line);padding-top:10px"><summary style="cursor:pointer;color:var(--red);font-weight:700">Delete store permanently</summary>' +
            '<div style="margin-top:8px;font-size:13px;line-height:1.6;color:#7f1d1d">Is store ka <b>poora data (items, bills, suppliers, logins)</b> hamesha ke liye hat jayega. Ye wapas nahi aayega.</div>' +
            '<a href="/admin/store-backup/' + s.id + '" class="btn btn-gray btn-sm" style="margin:8px 0;display:inline-block">Pehle Backup Download karein (optional)</a>' +
            '<form method="POST" action="/admin/delete-store" autocomplete="off" onsubmit="return confirm(\'Pakka delete karna hai? Ye wapas nahi hoga.\')">' + hid +
            '<input class="w100" name="confirmName" placeholder="Confirm ke liye Login ID likhein: ' + esc(s.username) + '" required autocomplete="off">' +
            '<input class="w100" type="password" name="password" placeholder="Aapka Owner password" required autocomplete="current-password">' +
            '<button class="btn btn-danger btn-sm" style="margin-top:6px">Delete Permanently</button></form></details>';
        const manage = '<details><summary class="btn btn-primary btn-sm" style="list-style:none;display:inline-block">Manage</summary>' +
            '<div class="panel" style="margin-top:8px;min-width:340px;display:grid;gap:14px">' +
            '<form method="POST" action="/admin/renew" class="planform" data-base="' + ((s.subTo && s.subTo >= today) ? addDays(s.subTo, 1) : today) + '">' + hid + '<b>Renew / Extend</b>' +
            '<div class="row"><select name="months">' + PLAN_OPTS + '</select><input type="number" name="amount" min="0" step="0.01" placeholder="Amount (optional)"></div>' +
            '<div class="row cust" style="display:none"><div><label>From (start)</label><input type="date" name="from" value="' + ((s.subTo && s.subTo >= today) ? addDays(s.subTo, 1) : today) + '" class="w100"></div><div><label>To (end)</label><input type="date" name="to" class="w100"></div></div>' +
            '<div class="prev" style="font-size:13px;font-weight:600;margin:4px 0"></div><button class="btn btn-success btn-sm">Renew</button></form>' +
            '<form method="POST" action="/admin/set-dates">' + hid + '<b>Exact dates badlein</b><div class="row"><input type="date" name="from" value="' + esc(s.subFrom || today) + '" required><input type="date" name="to" value="' + esc(s.subTo || '') + '"></div><small>"To" khali = Lifetime</small><br><button class="btn btn-warning btn-sm">Save Dates</button></form>' +
            '<form method="POST" action="/admin/set-store-phone" autocomplete="off">' + hid + '<b>OTP Mobile number</b><input name="otpPhone" class="w100" placeholder="10 digit mobile" pattern="[6-9][0-9]{9}" inputmode="numeric" value="' + esc(s.otpPhone || '') + '" required><button class="btn btn-gray btn-sm">Save Mobile</button></form>' +
            '<form method="POST" action="/admin/reset-password" autocomplete="off">' + hid + '<b>Naya password set karein</b><input type="password" name="password" class="w100" placeholder="Naya password (min 6)" minlength="6" required autocomplete="new-password"><button class="btn btn-gray btn-sm">Set Password</button></form>' +
            '<form method="POST" action="/admin/toggle-store">' + hid + '<button class="btn btn-sm ' + (s.active ? 'btn-danger' : 'btn-success') + '">' + (s.active ? 'Block this store' : 'Unblock this store') + '</button></form>' +
            '<div><b>Subscription history</b><ul style="margin:6px 0 0;padding-left:18px;font-size:13px;line-height:1.7">' + (hist || '<li>-</li>') + '</ul></div>' + delForm + '</div></details>';
        return '<tr data-status="' + sc.code + '" data-q="' + esc((s.name + ' ' + s.username + ' ' + s.phone).toLowerCase()) + '">' +
            '<td><b>' + esc(s.name) + '</b><br><small>Login ID: ' + esc(s.username) + (s.phone ? ' | ' + esc(s.phone) : '') + '</small><br><small>' + otpInfo(s.otpPhone) + '</small></td>' +
            '<td>' + planText(s) + '</td><td>' + planBadge(s) + '</td>' +
            '<td>' + inr(t) + '<br><small>' + n + ' bills today | ' + (s.suppliers || []).length + ' suppliers</small></td><td>' + manage + '</td></tr>';
    }).join('');
    alertList.sort(function (a, b) { return a.left - b.left; });
    const alertCard = alertList.length
        ? '<div class="card" style="border-left:5px solid #dc2626"><h2 class="card-title" style="color:var(--red)">Renewal Alerts (' + alertList.length + ' store) - 15 din ke andar expire / expire ho chuke</h2>' +
          tbl(['Store', 'Plan End', 'Status', 'Action'], alertList.map(function (x) { return x.html; }).join('')) + '</div>'
        : (reg.stores.length ? '<div class="alert" style="background:#dcfce7;border-left-color:#16a34a;color:#14532d">Sab stores ka subscription theek hai. Agle 15 din mein koi expire nahi ho raha.</div>' : '');
    const filter = '<div class="row" style="margin:6px 0 4px"><input id="sq" placeholder="Search store, login ID, phone..." style="flex:3">' +
        '<select id="sf" style="flex:1"><option value="">All status</option><option value="active">Active</option><option value="expiring">Expiring</option><option value="expired">Expired</option><option value="disabled">Blocked</option><option value="upcoming">Not started</option></select></div>' +
        '<script>function ff(){var q=document.getElementById("sq").value.toLowerCase(),f=document.getElementById("sf").value;document.querySelectorAll("#stores tbody tr").forEach(function(r){r.style.display=(r.dataset.q.indexOf(q)>-1&&(!f||r.dataset.status===f))?"":"none"})}document.getElementById("sq").oninput=ff;document.getElementById("sf").onchange=ff;</script>';
    const addForm = '<form method="POST" action="/admin/add-store" autocomplete="off" class="planform"><div class="row">' +
        '<input name="name" placeholder="Medical store ka naam" required><input name="phone" placeholder="Business phone (optional)"></div>' +
        '<div class="row"><input name="otpPhone" placeholder="OTP Mobile (10 digit) - login ka OTP yahin aayega" pattern="[6-9][0-9]{9}" inputmode="numeric"' + (otpOn() ? ' required' : '') + '></div>' +
        '<div class="row"><input name="username" placeholder="Login ID (a-z, 0-9)" pattern="[a-zA-Z0-9_.\\-]{3,20}" required autocomplete="off"><input type="password" name="password" placeholder="Password (min 6)" minlength="6" required autocomplete="new-password"></div>' +
        '<div class="row"><div><label>Subscription start</label><input type="date" name="from" value="' + today + '" class="w100" required></div>' +
        '<div><label>Plan / Kitne mahine</label><select name="months" class="w100">' + PLAN_OPTS + '</select></div>' +
        '<div class="cust" style="display:none"><label>End date (calendar se)</label><input type="date" name="to" class="w100"></div>' +
        '<div><label>Amount (optional)</label><input type="number" name="amount" min="0" step="0.01" class="w100"></div>' +
        '<div><label>Admin PIN (optional)</label><input type="password" name="pin" pattern="[0-9]{4,8}" placeholder="4-8 digit, khali = default" class="w100" autocomplete="new-password"></div></div>' +
        '<div class="prev" style="font-size:13px;font-weight:600;margin:8px 0 0"></div><button class="btn btn-success" style="margin-top:10px">+ Create Store Account</button></form>';
    const importForm = '<form method="POST" action="/admin/import-stock" enctype="multipart/form-data"><div class="row"><select name="id" required>' +
        reg.stores.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + '</option>'; }).join('') +
        '</select><input type="file" name="bulkFile" accept=".csv,.xlsx,.xls" required></div>' +
        '<p style="font-size:13px;color:var(--muted);margin:6px 0">Customer ke purane software ki stock Excel/CSV uske store mein daal dein. Columns: Name, Batch, Expiry, MRP, Rate, GST, PackSize, Stock.</p>' +
        '<button class="btn btn-primary">Import Stock into Store</button></form>';
    const ownerPw = '<form method="POST" action="/admin/change-owner-password" autocomplete="off"><div class="row"><input type="password" name="oldPass" placeholder="Purana password" required autocomplete="current-password"><input type="password" name="newPass" placeholder="Naya password (min 8)" minlength="8" required autocomplete="new-password"></div><button class="btn btn-warning" style="margin-top:8px">Change Owner Password</button></form>';
    const aph = normPhone((readJson(ADMIN_FILE, {}) || {}).phone);
    const otpStatus = OTP_MODE === 'on'
        ? (aph ? '<div class="alert" style="background:#dcfce7;border-left-color:#16a34a;color:#14532d">Mobile OTP chalu hai (' + esc(SMS_PROVIDER) + '). Sabhi logins par OTP lagega.</div>'
            : '<div class="alert" style="background:var(--red-bg);border-left-color:#dc2626;color:#7f1d1d">OTP chalu hai par <b>aapka (owner) mobile number set nahi hai</b>, isliye aap par abhi OTP nahi lag raha. Neeche "Owner Mobile" se number set karein.</div>')
        : (OTP_MODE === 'test' ? '<div class="alert" style="background:var(--red-bg);border-left-color:#dc2626;color:#7f1d1d">TEST MODE: OTP sirf server console mein aa raha hai. Asli istemaal ke liye SMS_PROVIDER set karein.</div>'
            : '<div class="alert">Mobile OTP abhi <b>band</b> hai (SMS provider set nahi). Surakshit login ke liye start.bat mein SMS_PROVIDER set karein.</div>');
    const otpCard = '<div class="card"><h2 class="card-title">Owner Mobile (OTP)</h2><p style="margin-top:0">Abhi: <b>' + (aph ? maskPhone(aph) : 'set nahi hai') + '</b></p>' +
        '<form method="POST" action="/admin/set-owner-phone" autocomplete="off"><input class="w100" name="phone" placeholder="Naya mobile (10 digit)" pattern="[6-9][0-9]{9}" inputmode="numeric" required>' +
        '<input class="w100" type="password" name="password" placeholder="Owner password (confirm ke liye)" required autocomplete="current-password"><button class="btn btn-warning" style="margin-top:8px">Save Mobile</button></form></div>';
    res.send(page('Owner Panel',
        '<div class="topbar"><div class="brand"><div class="logo">+</div><div><b>Super Admin</b><small>Smart Billing &amp; Stock Hub</small></div></div>' +
        '<div class="top-right"><a href="/logout" class="btn btn-gray btn-sm">Logout</a></div></div>' +
        '<div class="main" style="margin:0 auto;position:relative;z-index:1">' + msg + otpStatus +
        '<div class="stats"><div class="stat"><span>Total Stores</span><b>' + reg.stores.length + '</b></div><div class="stat"><span>Active</span><b style="color:#15803d">' + active + '</b></div>' +
        '<div class="stat"><span>Renewal Chahiye (15 din / Expired)</span><b style="color:var(--red)">' + need + '</b></div><div class="stat"><span>Total Collected</span><b style="color:var(--teal)">' + inr(money) + '</b></div></div>' +
        alertCard + '<div class="card"><h2 class="card-title">All Stores &amp; Subscriptions</h2>' + filter +
        tbl(['Store / Login ID', 'Subscription', 'Status', 'Today', 'Manage'], rows || emptyRow(5, 'Abhi koi store nahi hai. Niche se pehla store banayein.'), 'stores') +
        '<p style="color:var(--muted);font-size:13px;margin-bottom:0">Privacy: yahan sirf summary dikhti hai. Kisi ka password kabhi nahi dikhta, sirf naya set kar sakte hain.</p></div>' +
        '<div class="grid-2"><div class="card"><h2 class="card-title">Naya Store Account Banayein</h2>' + addForm + '</div>' +
        '<div><div class="card"><h2 class="card-title">Customer ka Purana Data Import</h2>' + importForm + '</div>' +
        otpCard + '<div class="card"><h2 class="card-title">Owner Password</h2>' + ownerPw + '</div></div></div>' + PLAN_JS + '</div>'));
});
app.post('/admin/add-store', requireAdmin, function (req, res) {
    const reg = loadStores();
    const name = String(req.body.name || '').trim();
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const pin = String(req.body.pin || '').trim();
    const back = function (m) { res.redirect('/admin?msg=' + enc(m)); };
    if (!name || !/^[a-z0-9_.\-]{3,20}$/.test(username) || password.length < 6) return back('Naam, valid Login ID aur 6+ character password zaroori hai.');
    if (pin && !/^[0-9]{4,8}$/.test(pin)) return back('Admin PIN 4 se 8 digit ka hona chahiye.');
    if (usernameTaken(reg, username)) return back('Ye Login ID pehle se kisi aur ke paas hai.');
    if (req.body.months === 'custom' && (!isoDate(req.body.from) || !isoDate(req.body.to) || req.body.to < req.body.from)) return back('Custom plan ke liye sahi start aur end date chunein (end date start se pehle nahi ho sakti).');
    const otpPhone = normPhone(req.body.otpPhone);
    if (req.body.otpPhone && !otpPhone) return back('OTP mobile number sahi nahi hai (10 digit, 6-9 se shuru).');
    if (otpOn() && !otpPhone) return back('OTP chalu hai, isliye OTP mobile number zaroori hai.');
    const s = makeStore(reg, { name: name, username: username, password: password, phone: req.body.phone, otpPhone: otpPhone, from: req.body.from, to: req.body.to, months: req.body.months, amount: req.body.amount, pin: pin });
    reg.stores.push(s); saveStores(reg);
    writeJson(storeFile(s.id), { products: [], bills: [], purchaseOrders: [], incoming: [] });
    back('Store "' + name + '" ban gaya. Login ID: ' + username + (s.subTo ? ' | Subscription: ' + fmtDate(s.subFrom) + ' se ' + fmtDate(s.subTo) + ' tak' : ' | Lifetime'));
});
app.post('/admin/renew', requireAdmin, function (req, res) {
    const reg = loadStores(), s = reg.stores.find(function (x) { return x.id === req.body.id; });
    const months = parseInt(req.body.months) || 0, amount = parseFloat(req.body.amount) || 0, t = todayStr();
    if (!s) return res.redirect('/admin?msg=' + enc('Store nahi mila.'));
    if (req.body.months === 'custom') {                                  // calendar se khud ki dates
        const from = req.body.from, to = req.body.to;
        if (!isoDate(from) || !isoDate(to) || to < from) return res.redirect('/admin?msg=' + enc('Custom dates sahi nahi hain (end date start se pehle nahi ho sakti).'));
        const running = s.subTo && s.subTo >= t;
        if (!(running && from <= addDays(s.subTo, 1))) s.subFrom = from;   // chalu plan se judta ho to purani start date rahegi
        s.subTo = to;
        s.subs.push({ from: from, to: to, months: 0, amount: amount, note: 'Custom dates', at: t });
        saveStores(reg);
        return res.redirect('/admin?msg=' + enc(s.name + ': plan ' + fmtDate(from) + ' se ' + fmtDate(to) + ' tak set ho gaya.'));
    }
    if (months === 0) {
        if (!s.subFrom) s.subFrom = t;
        s.subTo = '';
        s.subs.push({ from: s.subFrom, to: '', months: 0, amount: amount, note: 'Lifetime', at: t });
    } else {
        const running = s.subTo && s.subTo >= t;
        const base = running ? addDays(s.subTo, 1) : t;               // chalu plan ke baad se, expired ho to aaj se
        if (!running) s.subFrom = base;
        s.subTo = planEnd(base, months);
        s.subs.push({ from: base, to: s.subTo, months: months, amount: amount, note: 'Renewal', at: t });
    }
    saveStores(reg);
    res.redirect('/admin?msg=' + enc(s.name + ': subscription ' + (s.subTo ? fmtDate(s.subTo) + ' tak' : 'Lifetime') + ' ho gaya.'));
});
app.post('/admin/set-dates', requireAdmin, function (req, res) {
    const reg = loadStores(), s = reg.stores.find(function (x) { return x.id === req.body.id; });
    const from = req.body.from, to = req.body.to || '';
    if (!s || !isoDate(from) || (to && !isoDate(to)) || (to && to < from)) return res.redirect('/admin?msg=' + enc('Dates sahi nahi hain (To date From se pehle nahi ho sakti).'));
    s.subFrom = from; s.subTo = to;
    s.subs.push({ from: from, to: to, months: 0, amount: 0, note: 'Dates edited', at: todayStr() });
    saveStores(reg);
    res.redirect('/admin?msg=' + enc(s.name + ': dates update ho gayi.'));
});
app.post('/admin/toggle-store', requireAdmin, function (req, res) {
    const reg = loadStores(), s = reg.stores.find(function (x) { return x.id === req.body.id; });
    if (s) { s.active = !s.active; saveStores(reg); }
    res.redirect('/admin?msg=' + enc(s ? s.name + (s.active ? ': unblock ho gaya.' : ': block ho gaya.') : 'Store nahi mila.'));
});
app.post('/admin/reset-password', requireAdmin, function (req, res) {
    const reg = loadStores(), s = reg.stores.find(function (x) { return x.id === req.body.id; });
    const pw = String(req.body.password || '');
    if (s && pw.length >= 6) {
        s.hash = hashPass(pw, s.salt); saveStores(reg);
        return res.redirect('/admin?msg=' + enc(s.name + ': naya password set ho gaya.'));
    }
    res.redirect('/admin?msg=' + enc('Password kam se kam 6 character ka ho.'));
});
app.post('/admin/set-store-phone', requireAdmin, function (req, res) {
    const reg = loadStores(), s = reg.stores.find(function (x) { return x.id === req.body.id; }), ph = normPhone(req.body.otpPhone);
    if (!s || !ph) return res.redirect('/admin?msg=' + enc('Sahi 10 digit mobile number daalein.'));
    s.otpPhone = ph; saveStores(reg);
    res.redirect('/admin?msg=' + enc(s.name + ': OTP mobile ' + maskPhone(ph) + ' set ho gaya.'));
});
app.post('/admin/set-owner-phone', requireAdmin, function (req, res) {
    const a = readJson(ADMIN_FILE, null), ph = normPhone(req.body.phone);
    if (!a || !adminOk(SUPER_USER, String(req.body.password || ''))) { noteFail(req.ip); return res.redirect('/admin?msg=' + enc('Owner password galat hai.')); }
    if (!ph) return res.redirect('/admin?msg=' + enc('Sahi 10 digit mobile number daalein.'));
    a.phone = ph; writeJson(ADMIN_FILE, a);
    res.redirect('/admin?msg=' + enc('Owner mobile ' + maskPhone(ph) + ' set ho gaya.'));
});
app.get('/admin/store-backup/:id', requireAdmin, function (req, res) {
    const s = loadStores().stores.find(function (x) { return x.id === req.params.id; });
    if (!s) return res.redirect('/admin?msg=' + enc('Store nahi mila.'));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=backup_' + s.username + '_' + todayStr() + '.json');
    res.send(JSON.stringify(loadData(s.id), null, 2));
});
app.post('/admin/delete-store', requireAdmin, function (req, res) {
    const reg = loadStores(), s = reg.stores.find(function (x) { return x.id === req.body.id; });
    const back = function (m) { res.redirect('/admin?msg=' + enc(m)); };
    if (!s) return back('Store nahi mila.');
    if (tooMany(req.ip)) return back('Bahut zyada galat koshish. 10 minute baad try karein.');
    if (String(req.body.confirmName || '').trim().toLowerCase() !== s.username) return back('Login ID sahi nahi likha, store delete nahi hua.');
    if (!adminOk(SUPER_USER, String(req.body.password || ''))) { noteFail(req.ip); return back('Owner password galat hai, store delete nahi hua.'); }
    reg.stores = reg.stores.filter(function (x) { return x.id !== s.id; });
    saveStores(reg);                                                        // store + uske suppliers ke logins hat gaye
    [storeFile(s.id), storeFile(s.id) + '.before_restore', storeFile(s.id) + '.tmp'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) { } });   // data file
    sessions.forEach(function (v, k) { if (v.storeId === s.id) sessions.delete(k); });                                                                   // chalu login bhi band
    back('Store "' + s.name + '" aur uska poora data hamesha ke liye delete ho gaya.');
});
app.post('/admin/change-owner-password', requireAdmin, function (req, res) {
    const a = readJson(ADMIN_FILE, null), np = String(req.body.newPass || '');
    if (!a || !adminOk(SUPER_USER, String(req.body.oldPass || ''))) return res.redirect('/admin?msg=' + enc('Purana password galat hai.'));
    if (np.length < 8) return res.redirect('/admin?msg=' + enc('Naya password kam se kam 8 character ka ho.'));
    a.salt = newSalt(); a.hash = hashPass(np, a.salt); writeJson(ADMIN_FILE, a);
    res.redirect('/admin?msg=' + enc('Owner password badal gaya.'));
});

/* ------------------------------ main tabs ------------------------------ */
function tabBilling(req) {
    const d = req.data, cart = req.session.cart;
    const opts = d.products.filter(function (p) { return p.stock > 0 && !isExpired(p.expiry); }).map(function (p) {
        const pk = packOf(p);
        const price = pk > 1 ? inr(p.rate) + '/strip (' + pk + ' tab) = ' + inr(p.rate / pk) + '/tab' : inr(p.rate);
        return '<option value="' + p.id + '">' + esc(p.name) + ' | Batch ' + esc(p.batch) + ' | ' + price + ' | GST ' + p.gst + '% | Avl ' + fmtQty(p.stock, pk) + '</option>';
    }).join('');
    let sub = 0;
    const rows = cart.map(function (it, i) {
        const tot = lineAmt(it.rate, it.pack, it.qty, it.gst);
        sub += tot;
        return '<tr><td><b>' + esc(it.name) + '</b></td><td>' + esc(it.batch) + '</td><td><b>' + fmtQty(it.qty, it.pack) + '</b></td><td>' + inr(it.rate) + (it.pack > 1 ? '<small>/strip</small>' : '') + '</td><td>' + it.gst + '%</td><td><b>' + inr(tot) + '</b></td>' +
            '<td><form method="POST" action="/remove-from-cart" style="margin:0"><input type="hidden" name="index" value="' + i + '"><button class="btn btn-danger btn-sm">X</button></form></td></tr>';
    }).join('');
    const addForm = '<form method="POST" action="/add-to-cart" class="panel row"><select name="productId" style="flex:3;min-width:250px" required>' + opts + '</select>' +
        '<input type="number" name="qty" min="1" value="1" style="max-width:90px" required>' +
        '<select name="unit" style="max-width:170px"><option value="strip">Strip / Pack</option><option value="tab">Loose Tablet / Piece</option></select>' +
        '<button class="btn btn-primary" style="flex:0 0 auto">+ Add to Bill</button></form>';
    const saveForm = '<form method="POST" action="/save-bill" style="margin-top:18px"><div class="row">' +
        '<div><label>Customer / Party Name</label><input class="w100" name="customer" value="Cash Customer" required></div>' +
        '<div><label>Mobile (WhatsApp ke liye)</label><input class="w100" name="phone" placeholder="9876543210"></div>' +
        '<div><label>Discount (%)</label><input class="w100" type="number" step="0.1" min="0" max="100" name="discount" value="0"></div>' +
        '<div><label>Payment Mode</label><select class="w100" name="paymentMode"><option value="Cash">Cash</option><option value="UPI">UPI / Online</option><option value="Credit">Credit (Udhaar)</option></select></div></div>' +
        '<div class="total-bar"><div>Sub-Total (discount se pehle): <b>' + inr(sub) + '</b></div><button class="btn btn-success" style="font-size:15px;padding:12px 26px">SAVE &amp; GENERATE BILL</button></div></form>';
    return '<div class="card"><h2 class="card-title">Generate Sale Bill</h2>' + addForm +
        '<div style="font-size:12.5px;color:var(--muted);margin-top:6px">Tip: 2 tablet chahiye to Qty = 2 aur "Loose Tablet" chunein. Poori patti ke liye "Strip / Pack".</div>' +
        tbl(['Item Name', 'Batch', 'Qty', 'Rate', 'GST', 'Total', 'Remove'], rows || emptyRow(7, 'Abhi bill mein koi item nahi hai. Upar se item chunkar "+ Add to Bill" dabayein.')) + saveForm + '</div>';
}

function scanRow(i, it) {
    return '<td><input name="name_' + i + '" value="' + esc(it.name) + '" class="w100" style="min-width:150px"></td>' +
        '<td><input name="batch_' + i + '" value="' + esc(it.batch || 'SCAN01') + '" style="width:90px"></td>' +
        '<td><input type="date" name="expiry_' + i + '" value="' + esc(it.expiry || '2027-12-31') + '"></td>' +
        '<td><input type="number" min="1" name="pack_' + i + '" value="' + (it.pack || 10) + '" style="width:70px"></td>' +
        '<td><input type="number" step="0.01" name="rate_' + i + '" value="' + (it.rate || 0) + '" style="width:90px"></td>' +
        '<td><input type="number" min="0" name="qty_' + i + '" value="' + (it.qty || 0) + '" style="width:80px"></td>';
}

function tabAddStock(req) {
    const scan = req.session.scan || [], raw = req.session.scanRaw;
    let preview = '';
    if (scan.length || raw) {
        const list = scan.length ? scan : [{ name: '', batch: '', expiry: '', pack: 10, rate: 0, qty: 0 }];
        const rows = list.map(function (it, i) { return '<tr>' + scanRow(i, it) + '</tr>'; }).join('');
        const blank = JSON.stringify(scanRow('__I__', { name: '', batch: '', expiry: '', pack: 10, rate: 0, qty: 0 })).slice(1, -1);
        preview = '<div class="card" style="border:2px solid #15803d;background:#f0fdf4"><h3 style="margin-top:0;color:#166534">Bill photo se ' + scan.length + ' item mile - verify karke stock mein jodein</h3>' +
            '<div style="font-size:13px;margin-bottom:8px">Dhyan dein: bill ka rate <b>purchase rate</b> hota hai. <b>Sale Rate (per strip)</b> apne hisaab se (MRP ke andar) zaroor badlein. <b>Tab/Strip</b> = ek patti mein kitni tablet (syrup/injection = 1). Qty = kitne strip/pack aaye.</div>' +
            '<form method="POST" action="/confirm-scanned-stock"><input type="hidden" name="count" id="scancount" value="' + list.length + '">' +
            tbl(['Item', 'Batch', 'Expiry', 'Tab/Strip', 'Sale Rate (strip)', 'Qty (strips)'], rows, 'scantbl') +
            '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-gray" onclick="addScanRow()">+ Add Row</button><button class="btn btn-success">Confirm &amp; Add All to Stock</button> <a href="/clear-scan" class="btn btn-gray">Cancel</a></div></form>' +
            '<details style="margin-top:14px"><summary style="cursor:pointer;font-weight:600">Photo se padha gaya poora text dekhein</summary><pre style="white-space:pre-wrap;background:#fff;border:1px solid var(--line);padding:10px;border-radius:7px;font-size:12px">' + esc(raw || '') + '</pre></details>' +
            '<script>var ROWHTML="' + blank + '";function addScanRow(){var c=document.getElementById("scancount"),i=parseInt(c.value),tr=document.createElement("tr");tr.innerHTML=ROWHTML.split("__I__").join(i);document.querySelector("#scantbl tbody").appendChild(tr);c.value=i+1;}</script></div>';
    }
    const manual = '<form method="POST" action="/add-product"><input name="name" class="w100" placeholder="Item Name (e.g. Pan-D)" required>' +
        '<div class="row"><input name="batch" placeholder="Batch No." required><input type="date" name="expiry" title="Expiry Date" required></div>' +
        '<div class="row"><input type="number" step="0.01" name="mrp" placeholder="MRP (per strip/pack)" required><input type="number" step="0.01" name="rate" placeholder="Sale Rate (per strip/pack)" required></div>' +
        '<div class="row"><input type="number" step="0.01" name="gst" placeholder="GST %" value="12" required><input type="number" min="1" name="pack" value="10" title="Ek strip mein kitni tablet (syrup/injection = 1)" placeholder="Tablets per strip" required></div>' +
        '<input type="number" min="0" name="stock" class="w100" placeholder="Stock (kitne strip / pack)" required>' +
        '<div style="font-size:12px;color:var(--muted);margin:4px 0">Tablets per strip: patti mein kitni tablet (10 / 15 / 30 / 50). Syrup, injection, cream ke liye 1 rakhein.</div>' +
        '<button class="btn btn-success w100" style="margin-top:6px">+ Save Single Item</button></form>';
    const bulk = '<form method="POST" action="/bulk-upload" enctype="multipart/form-data" style="padding-bottom:18px;margin-bottom:18px;border-bottom:1px solid var(--line)">' +
        '<b>Option 2: Bulk Excel (.xlsx) / CSV Upload</b><div style="margin:6px 0 10px;font-size:13px;line-height:1.6">Purane software (Marg, Busy etc.) ki stock Excel bhi chalti hai. Stock = strips mein, PackSize = tablets per strip, Expiry = 2027-08-31 format mein.<br><a href="/sample-excel" style="color:#15803d;font-weight:700">Sample Excel</a> &nbsp;|&nbsp; <a href="/sample-csv" style="color:#d97706;font-weight:700">Sample CSV</a></div>' +
        '<input type="file" name="bulkFile" accept=".csv,.xlsx,.xls" required class="w100"><button class="btn btn-primary w100" style="margin-top:8px">Upload File</button></form>';
    const snap = '<form method="POST" action="/scan-purchase-bill" enctype="multipart/form-data"><b>Option 3: Supplier Bill Photo Scan (OCR)</b>' +
        '<div style="font-size:13px;color:var(--muted);margin:6px 0 10px">Bill ki saaf, seedhi photo upload karein. Sabhi item lines (serial number ke saath bhi) padhi jati hain. Internet ki zarurat nahi.</div>' +
        '<input type="file" name="billImage" accept="image/*" required class="w100"><button class="btn btn-warning w100" style="margin-top:8px">Scan Bill Photo</button></form>';
    return preview + '<div class="grid-2"><div class="card"><h3 class="card-title">Option 1: Manual Item Entry</h3>' + manual +
        '</div><div class="card"><h3 class="card-title">Fast Stock Upload</h3>' + bulk + snap + '</div></div>';
}

function tabCurrentStock(req) {
    const rows = req.data.products.map(function (p) {
        const pk = packOf(p);
        const low = p.stock === 0 ? '<span class="badge b-red">OUT OF STOCK</span>' : (isLow(p) ? '<span class="badge b-yellow">LOW STOCK</span>' : '');
        const exp = isExpired(p.expiry) ? '<span class="badge b-red">EXPIRED</span>' : (isExpiringSoon(p.expiry) ? '<span class="badge b-yellow">EXPIRING</span>' : '');
        return '<tr><td><b>' + esc(p.name) + '</b>' + low + '</td><td>' + esc(p.batch) + '</td><td>' + esc(p.expiry || 'N/A') + exp + '</td>' +
            '<td>' + inr(p.rate) + (pk > 1 ? '<br><small>' + inr(p.rate / pk) + '/tab</small>' : '') + '</td><td>' + p.gst + '%</td>' +
            '<td><span class="badge b-blue" style="font-size:13px">' + fmtQty(p.stock, pk) + '</span></td>' +
            '<td><form method="POST" action="/set-pack" style="display:inline-flex;gap:5px;align-items:center;margin:0"><input type="hidden" name="id" value="' + p.id + '"><input type="number" name="pack" min="1" value="' + pk + '" title="Tablets per strip" style="width:58px;margin:0;padding:6px"><button class="btn btn-gray btn-sm">Set</button></form></td>' +
            '<td style="white-space:nowrap"><form method="POST" action="/add-stock" style="display:inline-flex;gap:6px;align-items:center;margin:0 8px 0 0"><input type="hidden" name="id" value="' + p.id + '">' +
            '<input type="number" name="qty" value="10" min="1" title="Kitne strip / pack jodne hain" style="width:70px;margin:0;padding:6px"><button class="btn btn-success btn-sm">+ Strips</button></form>' +
            '<a href="/?tab=current-stock&confirmDel=' + p.id + '" class="btn btn-danger btn-sm">Delete</a></td></tr>';
    }).join('');
    const search = '<input class="w100" placeholder="Search item ya batch..." oninput="var v=this.value.toLowerCase();document.querySelectorAll(\'#stk tbody tr\').forEach(function(r){r.style.display=r.textContent.toLowerCase().indexOf(v)>-1?\'\':\'none\'})">';
    return '<div class="card"><h2 class="card-title">Current Stock, Low Stock &amp; Expiry Alerts</h2>' + search +
        tbl(['Item Name', 'Batch', 'Expiry', 'Strip Rate', 'GST', 'Stock', 'Tab / Strip', 'Quick Actions'], rows || emptyRow(8, 'Abhi koi item nahi hai. "Add Stock" se items jodein.'), 'stk') + '</div>';
}

function tabReports(req) {
    const today = todayStr();
    const from = req.query.fromDate || '', to = req.query.toDate || '';
    let list = req.data.bills.slice().reverse();
    if (from && to) list = list.filter(function (b) { const x = b.isoDate || today; return x >= from && x <= to; });
    let total = 0;
    const rows = list.map(function (b) {
        total += b.total;
        const wa = waLink(b.phone, 'Hello ' + b.customer + ', thank you for shopping at ' + req.store.name + '! Bill #' + b.billNo + ' | Items: ' + b.details + ' | Total Paid: Rs.' + b.total.toFixed(2));
        return '<tr><td><b>#' + b.billNo + '</b><br><span class="badge b-blue">' + esc(b.counter || 'System-1') + '</span></td><td>' + esc(b.date) + '</td>' +
            '<td><b>' + esc(b.customer) + '</b>' + (b.phone ? '<br>' + esc(b.phone) : '') + '</td><td>' + esc(b.details) + (b.discount ? ' (Disc: ' + b.discount + '%)' : '') + '</td>' +
            '<td><b>' + esc(b.paymentMode || 'Cash') + '</b></td><td><b>' + inr(b.total) + '</b></td><td style="white-space:nowrap">' +
            '<a href="/print-bill/' + b.billNo + '" target="_blank" class="btn btn-primary btn-sm">Print</a> <a href="' + esc(wa) + '" target="_blank" class="btn btn-wa btn-sm">WhatsApp</a></td></tr>';
    }).join('');
    const f = from || '2000-01-01', t = to || '2099-12-31';
    const bar = '<div class="panel row" style="justify-content:space-between"><form method="GET" action="/" class="row" style="flex:3"><input type="hidden" name="tab" value="reports">' +
        '<span><b>From</b> <input type="date" name="fromDate" value="' + (from || today) + '" required></span><span><b>To</b> <input type="date" name="toDate" value="' + (to || today) + '" required></span>' +
        '<button class="btn btn-primary" style="flex:0 0 auto">Filter</button><a href="/?tab=reports" class="btn btn-gray" style="flex:0 0 auto">Show All</a></form>' +
        '<div style="flex:2;text-align:right"><a class="btn btn-success" href="/download-excel?fromDate=' + f + '&toDate=' + t + '">Excel (.xlsx)</a> <a class="btn btn-warning" href="/download-csv?fromDate=' + f + '&toDate=' + t + '">CSV</a></div></div>';
    return '<div class="card"><h2 class="card-title">Bills, WhatsApp Share &amp; Date Reports</h2>' + bar +
        '<h3 style="text-align:right;color:#15803d;margin:16px 0 4px">Total Sales (Filtered): ' + inr(total) + '</h3>' +
        tbl(['Bill / System', 'Date &amp; Time', 'Customer', 'Items', 'Mode', 'Grand Total', 'Actions'], rows || emptyRow(7, 'Is date range mein koi bill nahi mila.')) + '</div>';
}

function tabPurchase(req) {
    const d = req.data, today = todayStr();
    const short = d.products.filter(isLow);
    const addForm = '<form method="POST" action="/add-purchase-order" class="panel row" style="margin-bottom:18px">' +
        '<input name="itemName" placeholder="Item Name (e.g. Dolo 650mg)" required style="flex:2">' +
        '<input name="supplier" placeholder="Supplier / Wholesaler (optional)" style="flex:2"><input type="number" name="orderQty" min="1" value="50" required style="max-width:110px">' +
        '<button class="btn btn-primary" style="flex:0 0 auto">+ Add to Order List</button></form>';
    const lines = ['SUPPLIER ORDER LIST - ' + req.store.name + ' (' + today + ')'];
    const poRows = d.purchaseOrders.map(function (po, i) {
        lines.push((i + 1) + '. ' + po.itemName + ' - Qty: ' + po.orderQty + (po.supplier ? ' (' + po.supplier + ')' : ''));
        return '<tr><td><b>' + esc(po.itemName) + '</b></td><td>' + esc(po.supplier || 'General Supplier') + '</td><td><span class="badge b-blue" style="font-size:13px">' + po.orderQty + ' strip/pack</span></td><td>' + esc(po.date) + '</td>' +
            '<td style="white-space:nowrap"><form method="POST" action="/receive-purchase-order" style="display:inline"><input type="hidden" name="poId" value="' + po.id + '"><button class="btn btn-success btn-sm">Mark Received (+Stock)</button></form> ' +
            '<form method="POST" action="/delete-purchase-order" style="display:inline"><input type="hidden" name="poId" value="' + po.id + '"><button class="btn btn-danger btn-sm">Remove</button></form></td></tr>';
    }).join('');
    const actions = '<div class="row" style="justify-content:space-between;margin-bottom:6px"><h3 style="margin:0">Final Supplier Order List (' + d.purchaseOrders.length + ' Items)</h3><div style="flex:0 0 auto;display:flex;gap:8px;flex-wrap:wrap">' +
        '<a href="/download-po-excel" class="btn btn-success">Excel (.xlsx)</a><a href="/download-po-csv" class="btn btn-warning">CSV</a>' +
        '<a href="' + esc(waLink('', lines.join('\n'))) + '" target="_blank" class="btn btn-wa">Send on WhatsApp</a></div></div>';
    const main = '<div class="card"><h2 class="card-title">Purchase Order &amp; Out-of-Stock List</h2>' + addForm + actions +
        tbl(['Item Name', 'Supplier', 'Order Qty', 'Added', 'Actions'], poRows || emptyRow(5, 'Final Order List abhi khali hai.')) + '</div>';
    let auto = '';
    if (short.length) {
        const rows = short.map(function (p) {
            const q = p.stock === 0 ? 100 : 50;
            return '<tr><td><b>' + esc(p.name) + '</b>' + (p.stock === 0 ? '<span class="badge b-red">OUT OF STOCK</span>' : '<span class="badge b-yellow">LOW</span>') + '</td><td>' + esc(p.batch) + '</td><td>' + fmtQty(p.stock, packOf(p)) + ' left</td>' +
                '<td><form method="POST" action="/add-purchase-order" style="display:inline-flex;gap:6px"><input type="hidden" name="itemName" value="' + esc(p.name) + '"><input type="hidden" name="supplier" value="Main Wholesaler">' +
                '<input type="number" name="orderQty" value="' + q + '" min="1" style="width:80px;margin:0;padding:6px"><button class="btn btn-warning btn-sm">Add to Final List</button></form></td></tr>';
        }).join('');
        auto = '<div class="card" style="border-left:5px solid #dc2626"><h3 class="card-title" style="color:var(--red)">Auto-Detected Low / Out-of-Stock Items (10 strip/pack se kam)</h3>' +
            tbl(['Item', 'Batch', 'Current Stock', 'Add to Supplier List'], rows) + '</div>';
    }
    return main + auto;
}

function tabSettings(req) {
    const st = req.store;
    const profile = '<form method="POST" action="/save-settings"><label>Store Name</label><input class="w100" name="name" value="' + esc(st.name) + '" required>' +
        '<label>Address</label><input class="w100" name="address" value="' + esc(st.address) + '"><div class="row"><div><label>Phone</label><input class="w100" name="phone" value="' + esc(st.phone) + '"></div>' +
        '<div><label>GSTIN / DL No.</label><input class="w100" name="gstin" value="' + esc(st.gstin) + '"></div></div>' +
        '<button class="btn btn-primary" style="margin-top:12px">Save Details</button><p style="color:var(--muted);font-size:13px">Ye details bill print par dikhengi.</p></form>';
    const subCard = '<div class="card"><h2 class="card-title">Subscription</h2><p style="margin:0;line-height:1.9">Plan: ' + planText(st) + '<br>Status: ' + planBadge(st) + (otpOn() ? '<br>OTP Mobile: <b>' + (st.otpPhone ? maskPhone(st.otpPhone) : 'set nahi hai') + '</b> <small>(badalne ke liye owner se kahein)</small>' : '') + '</p></div>';
    const sec = '<form method="POST" action="/change-pin" style="margin-bottom:22px"><b>Admin PIN badlein (delete lock)</b>' +
        '<input type="password" class="w100" name="oldPin" placeholder="Purana PIN" required autocomplete="off"><input type="password" class="w100" name="newPin" placeholder="Naya PIN (4-8 digit)" pattern="[0-9]{4,8}" required autocomplete="off">' +
        '<button class="btn btn-warning" style="margin-top:8px">Change PIN</button></form>' +
        '<form method="POST" action="/change-password"><b>Login password badlein</b><input type="password" class="w100" name="oldPass" placeholder="Purana password" required autocomplete="current-password">' +
        '<input type="password" class="w100" name="newPass" placeholder="Naya password (min 6)" minlength="6" required autocomplete="new-password"><button class="btn btn-warning" style="margin-top:8px">Change Password</button></form>';
    const sups = (st.suppliers || []).map(function (x) {
        return '<tr><td><b>' + esc(x.name) + '</b></td><td>' + esc(x.username) + '<br><small>' + otpInfo(x.otpPhone) + '</small></td><td>' + (x.active ? '<span class="badge b-green" style="margin-left:0">Active</span>' : '<span class="badge b-red" style="margin-left:0">Blocked</span>') + '</td>' +
            '<td style="white-space:nowrap"><form method="POST" action="/toggle-supplier" style="display:inline"><input type="hidden" name="id" value="' + x.id + '"><button class="btn btn-sm ' + (x.active ? 'btn-danger' : 'btn-success') + '">' + (x.active ? 'Block' : 'Unblock') + '</button></form> ' +
            '<form method="POST" action="/set-supplier-phone" style="display:inline-flex;gap:5px"><input type="hidden" name="id" value="' + x.id + '"><input name="otpPhone" placeholder="Mobile" pattern="[6-9][0-9]{9}" required style="width:105px;margin:0;padding:6px"><button class="btn btn-gray btn-sm">Mobile</button></form> ' +
            '<form method="POST" action="/reset-supplier-password" style="display:inline-flex;gap:5px"><input type="hidden" name="id" value="' + x.id + '"><input type="password" name="password" placeholder="Naya password" minlength="6" required autocomplete="new-password" style="width:120px;margin:0;padding:6px"><button class="btn btn-gray btn-sm">Set</button></form></td></tr>';
    }).join('');
    const addSup = '<form method="POST" action="/add-supplier" autocomplete="off" style="margin-top:12px"><b>Naya Supplier / Wholesaler jodein</b><div class="row"><input name="name" placeholder="Supplier ka naam" required><input name="username" placeholder="Login ID" pattern="[a-zA-Z0-9_.\\-]{3,20}" required autocomplete="off"></div>' +
        '<input name="otpPhone" class="w100" placeholder="Supplier ka OTP mobile (10 digit)" pattern="[6-9][0-9]{9}" inputmode="numeric"' + (otpOn() ? ' required' : '') + '>' +
        '<input type="password" name="password" class="w100" placeholder="Password (min 6)" minlength="6" required autocomplete="new-password"><button class="btn btn-success" style="margin-top:8px">+ Add Supplier</button></form>';
    const supCard = '<div class="card"><h2 class="card-title">Suppliers (Bill Upload Access)</h2>' +
        '<p style="margin-top:0;line-height:1.6;color:var(--muted)">Supplier apne login se jo maal bhejega wo <b>Supplier Bills</b> tab mein aayega. Aap check karke confirm karenge tabhi stock mein judega.</p>' +
        (sups ? tbl(['Supplier', 'Login ID', 'Status', 'Actions'], sups) : '') + addSup + '</div>';
    const backup = '<div class="card"><h3 class="card-title">Backup &amp; Restore (purana data lana)</h3>' +
        '<p style="line-height:1.6;margin-top:0">Roz dukaan band karte waqt backup download karke pendrive ya Drive mein rakhein. Naye computer par ya purana data wapas lane ke liye niche se restore karein (purani <b>marg_data.json</b> file bhi chalti hai).</p>' +
        '<a href="/download-backup" class="btn btn-success">Download Backup (.json)</a>' +
        '<form method="POST" action="/restore-backup" enctype="multipart/form-data" style="margin-top:16px"><input type="file" name="backupFile" accept=".json" required class="w100">' +
        '<input type="password" name="pin" placeholder="Admin PIN" required class="w100" autocomplete="off"><button class="btn btn-warning" style="margin-top:8px">Restore Backup</button>' +
        '<div style="font-size:12px;color:var(--muted);margin-top:6px">Dhyan dein: restore karne par abhi ka data is backup se badal jayega.</div></form></div>';
    return '<div class="grid-2"><div><div class="card"><h2 class="card-title">Store Profile</h2>' + profile + '</div>' + subCard + backup + '</div>' +
        '<div><div class="card"><h2 class="card-title">Security</h2>' + sec + '</div>' + supCard + '</div></div>';
}

/* ------------------- Supplier Bills: supplier ne bheja, aap confirm karein ------------------- */
function incTotal(items) { return items.reduce(function (a, i) { return a + i.rate * i.qty * (1 + i.gst / 100); }, 0); }
function tabIncoming(req) {
    const inc = req.data.incoming;
    const pend = inc.filter(function (x) { return x.status === 'pending'; }).slice().reverse();
    const done = inc.filter(function (x) { return x.status !== 'pending'; }).slice().reverse().slice(0, 30);
    const cards = pend.map(function (b) {
        const rows = b.items.map(function (it, i) {
            return '<tr><td><input type="checkbox" name="inc_' + i + '" value="1" checked title="Is item ko lena hai"></td>' +
                '<td><input name="name_' + i + '" value="' + esc(it.name) + '" class="w100" style="min-width:150px"></td>' +
                '<td><input name="batch_' + i + '" value="' + esc(it.batch) + '" style="width:90px"></td>' +
                '<td><input type="date" name="expiry_' + i + '" value="' + esc(it.expiry) + '"></td>' +
                '<td><input type="number" min="1" name="pack_' + i + '" value="' + it.pack + '" style="width:65px"></td>' +
                '<td><input type="number" min="0" name="qty_' + i + '" value="' + it.qty + '" style="width:75px"></td>' +
                '<td>' + inr(it.rate) + '</td><td>' + inr(it.mrp) + '<input type="hidden" name="mrp_' + i + '" value="' + it.mrp + '"></td>' +
                '<td><input type="number" step="0.01" min="0" name="sale_' + i + '" value="' + (it.mrp > 0 ? it.mrp : it.rate) + '" style="width:90px"></td>' +
                '<td><input type="number" step="0.01" min="0" name="gst_' + i + '" value="' + it.gst + '" style="width:62px"></td></tr>';
        }).join('');
        return '<div class="card" style="border-left:5px solid var(--teal)"><h3 style="margin:0 0 4px">' + esc(b.supplierName) + (b.invoiceNo ? ' - Bill #' + esc(b.invoiceNo) : '') + '</h3>' +
            '<div style="color:var(--muted);font-size:13px;margin-bottom:6px">' + esc(b.invoiceDate) + ' | ' + b.items.length + ' items | Value approx ' + inr(incTotal(b.items)) + (b.note ? ' | Note: ' + esc(b.note) : '') + ' | Bheja: ' + esc(b.createdAt) + '</div>' +
            '<form method="POST" action="/supplier-bill/confirm"><input type="hidden" name="id" value="' + b.id + '"><input type="hidden" name="count" value="' + b.items.length + '">' +
            tbl(['Lein', 'Item', 'Batch', 'Expiry', 'Tab/Strip', 'Qty (strips)', 'Purchase Rate', 'MRP', 'Sale Rate (strip)', 'GST %'], rows) +
            '<div style="font-size:12.5px;color:var(--muted);margin-top:6px">Jo item nahi chahiye uska tick hata dein. Sale Rate apne hisaab se badal sakte hain (default = MRP).</div>' +
            '<div style="margin-top:12px"><button class="btn btn-success">Confirm &amp; Add to My Stock</button></div></form>' +
            '<form method="POST" action="/supplier-bill/reject" class="row" style="margin-top:10px"><input type="hidden" name="id" value="' + b.id + '"><input name="reason" placeholder="Reject karne ka karan (optional)" style="flex:3"><button class="btn btn-danger" style="flex:0 0 auto">Reject Bill</button></form></div>';
    }).join('');
    const hist = done.map(function (b) {
        const badge = b.status === 'accepted' ? '<span class="badge b-green" style="margin-left:0">Stock mein add (' + (b.acceptedItems || 0) + ' items)</span>' : '<span class="badge b-red" style="margin-left:0">Rejected</span>' + (b.reason ? ' <small>' + esc(b.reason) + '</small>' : '');
        return '<tr><td>' + esc(b.decidedAt || b.createdAt) + '</td><td><b>' + esc(b.supplierName) + '</b></td><td>' + esc(b.invoiceNo || '-') + '</td><td>' + b.items.length + '</td><td>' + inr(incTotal(b.items)) + '</td><td>' + badge + '</td></tr>';
    }).join('');
    return '<div class="card"><h2 class="card-title">Supplier Bills (Confirm karke stock mein jodein)</h2>' +
        '<p style="margin:0;line-height:1.6;color:var(--muted)">Aapke suppliers jo maal bhejte hain wo yahan aata hai. Check karke <b>Confirm</b> dabayein, item seedha Current Stock mein jud jayega. Supplier ka login <b>Store Settings &rarr; Suppliers</b> se banayein.</p></div>' +
        (cards || '<div class="card empty">Abhi koi naya supplier bill nahi hai.</div>') +
        (hist ? '<div class="card"><h3 class="card-title">Purane Supplier Bills</h3>' + tbl(['Date', 'Supplier', 'Bill No', 'Items', 'Value', 'Status'], hist) + '</div>' : '');
}

app.get('/', requireStore, function (req, res) {
    const tab = req.query.tab || 'billing';
    let alertHtml = '';
    if (req.query.msg) {
        const pb = req.query.pb ? ' <a href="/print-bill/' + esc(req.query.pb) + '" target="_blank" class="btn btn-primary btn-sm" style="margin-left:10px">Print Bill</a>' : '';
        alertHtml = '<div class="alert">' + esc(req.query.msg) + pb + '</div>';
    }
    let modal = '';
    const delId = req.query.confirmDel;
    if (delId) {
        const p = req.data.products.find(function (x) { return x.id == delId; });
        if (p) {
            modal = '<div class="modal"><div><h3 style="color:#dc2626;margin-top:0">Admin Lock: Confirm Delete</h3><p>Kya aap sach mein <b>' + esc(p.name) + '</b> ko delete karna chahte hain?</p>' +
                '<form method="POST" action="/delete-product"><input type="hidden" name="id" value="' + p.id + '"><input type="password" name="adminPin" placeholder="Admin PIN" required autofocus style="width:85%;text-align:center"><br>' +
                '<div style="margin-top:14px"><a href="/?tab=current-stock" class="btn btn-gray">Cancel</a> <button class="btn btn-danger">Yes, Delete</button></div></form></div></div>';
        }
    }
    const views = { 'billing': tabBilling, 'add-stock': tabAddStock, 'current-stock': tabCurrentStock, 'reports': tabReports, 'purchase-order': tabPurchase, 'settings': tabSettings, 'supplier-bills': tabIncoming };
    const view = views[tab] ? tab : 'billing';
    let body = views[view](req);
    if (alertHtml) body = body.replace('<div class="card">', '<div class="card">' + alertHtml);
    res.send(layout(req, view, body, modal));
});

/* --------------------------- settings routes --------------------------- */
app.post('/save-settings', requireStore, function (req, res) {
    const reg = loadStores(), s = reg.stores.find(function (x) { return x.id === req.store.id; });
    s.name = String(req.body.name || s.name).trim(); s.address = String(req.body.address || '').trim();
    s.phone = String(req.body.phone || '').trim(); s.gstin = String(req.body.gstin || '').trim();
    saveStores(reg); go(res, 'settings', 'Store details save ho gayi.');
});
app.post('/change-pin', requireStore, function (req, res) {
    const reg = loadStores(), s = reg.stores.find(function (x) { return x.id === req.store.id; });
    if (!checkPass(req.body.oldPin || '', s.salt, s.pinHash)) return go(res, 'settings', 'Purana PIN galat hai.');
    if (!/^[0-9]{4,8}$/.test(req.body.newPin || '')) return go(res, 'settings', 'Naya PIN 4 se 8 digit ka hona chahiye.');
    s.pinHash = hashPass(req.body.newPin, s.salt); saveStores(reg); go(res, 'settings', 'Admin PIN badal gaya.');
});
app.post('/change-password', requireStore, function (req, res) {
    const reg = loadStores(), s = reg.stores.find(function (x) { return x.id === req.store.id; });
    if (!checkPass(req.body.oldPass || '', s.salt, s.hash)) return go(res, 'settings', 'Purana password galat hai.');
    if (String(req.body.newPass || '').length < 6) return go(res, 'settings', 'Naya password kam se kam 6 character ka ho.');
    s.hash = hashPass(req.body.newPass, s.salt); saveStores(reg); go(res, 'settings', 'Password badal gaya.');
});

/* --------------------------- download helpers --------------------------- */
function sendExcel(res, rows, sheet, filename) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheet);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=' + filename + '.xlsx');
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
function sendCsv(res, rows, filename) {
    const cell = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    const keys = rows.length ? Object.keys(rows[0]) : [];
    const csv = [keys.map(cell).join(',')].concat(rows.map(function (r) { return keys.map(function (k) { return cell(r[k]); }).join(','); })).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=' + filename + '.csv');
    res.send(csv);
}
function billRows(req) {
    const from = req.query.fromDate || '2000-01-01', to = req.query.toDate || '2099-12-31';
    return req.data.bills.filter(function (b) { const x = b.isoDate || todayStr(); return x >= from && x <= to; }).map(function (b) {
        return { 'Bill No': b.billNo, 'System Counter': b.counter || 'System-1', 'Date & Time': b.date, 'Customer Name': b.customer, 'Mobile': b.phone || '',
            'Items Details': b.details, 'Payment Mode': b.paymentMode || 'Cash', 'Grand Total (Rs)': parseFloat(b.total.toFixed(2)) };
    });
}
function poRows(req) {
    return req.data.purchaseOrders.map(function (po, i) {
        return { 'S.No': i + 1, 'Item Name': po.itemName, 'Supplier': po.supplier || 'Main Wholesaler', 'Order Quantity': po.orderQty, 'Date': po.date };
    });
}
const SAMPLE = [
    { Name: 'Crocin 500', Batch: 'C102', Expiry: '2027-06-30', MRP: 20, Rate: 16, GST: 12, PackSize: 10, Stock: 20 },
    { Name: 'Azithromycin 500', Batch: 'AZ99', Expiry: '2027-09-15', MRP: 110, Rate: 85, GST: 12, PackSize: 3, Stock: 15 },
    { Name: 'Cough Syrup 100ml', Batch: 'CS10', Expiry: '2027-12-01', MRP: 95, Rate: 78, GST: 12, PackSize: 1, Stock: 30 }
];
app.get('/download-excel', requireStore, function (req, res) { sendExcel(res, billRows(req), 'BillsReport', 'Bills_' + todayStr()); });
app.get('/download-csv', requireStore, function (req, res) { sendCsv(res, billRows(req), 'Bills_' + todayStr()); });
app.get('/download-po-excel', requireStore, function (req, res) { sendExcel(res, poRows(req), 'PurchaseOrder', 'Supplier_Order_List_' + todayStr()); });
app.get('/download-po-csv', requireStore, function (req, res) { sendCsv(res, poRows(req), 'Supplier_Order_List_' + todayStr()); });
app.get('/sample-excel', requireStore, function (req, res) { sendExcel(res, SAMPLE, 'StockSample', 'Bulk_Stock_Sample'); });
app.get('/sample-csv', requireStore, function (req, res) { sendCsv(res, SAMPLE, 'Bulk_Stock_Sample'); });

/* --------------------------- purchase order routes --------------------------- */
app.post('/add-purchase-order', requireStore, function (req, res) {
    const d = req.data;
    const itemName = String(req.body.itemName || '').trim();
    const supplier = String(req.body.supplier || 'Main Wholesaler').trim();
    const qty = parseInt(req.body.orderQty) || 50;
    if (itemName) {
        const ex = d.purchaseOrders.find(function (po) { return po.itemName.toLowerCase() === itemName.toLowerCase(); });
        if (ex) ex.orderQty += qty;
        else d.purchaseOrders.push({ id: Date.now(), itemName: itemName, supplier: supplier, orderQty: qty, date: todayStr() });
        req.save();
    }
    go(res, 'purchase-order', 'Item Supplier Order List mein add ho gaya!');
});
app.post('/delete-purchase-order', requireStore, function (req, res) {
    req.data.purchaseOrders = req.data.purchaseOrders.filter(function (po) { return po.id != req.body.poId; });
    req.save(); go(res, 'purchase-order', 'Order list se item hata diya gaya.');
});
app.post('/receive-purchase-order', requireStore, function (req, res) {
    const d = req.data;
    const po = d.purchaseOrders.find(function (x) { return x.id == req.body.poId; });
    if (po) {
        const prod = d.products.find(function (p) { return p.name.toLowerCase() === po.itemName.toLowerCase(); });
        if (prod) prod.stock += po.orderQty * packOf(prod);
        else d.products.push({ id: Date.now(), name: po.itemName, batch: 'NEW01', expiry: '2027-12-31', mrp: 50, rate: 40, gst: 12, packSize: 1, stock: po.orderQty });
        d.purchaseOrders = d.purchaseOrders.filter(function (x) { return x.id != req.body.poId; });
        req.save();
    }
    go(res, 'purchase-order', 'Maal receive ho gaya aur Current Stock mein jud gaya hai!');
});

/* --------------------------- stock routes --------------------------- */
const pad2 = function (n) { return String(n).padStart(2, '0'); };
function normExpiry(v) {
    if (v instanceof Date) return new Date(v.getTime() + 12 * 3600 * 1000).toISOString().slice(0, 10);
    const s = String(v == null ? '' : v).trim();
    if (!s) return '2027-12-31';
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);                 // dd/mm/yyyy
    if (m) { let y = +m[3]; if (y < 100) y += 2000; return y + '-' + pad2(m[2]) + '-' + pad2(m[1]); }
    m = s.match(/^(\d{1,2})[\/\-.](\d{2,4})$/);                                  // mm/yy (month ka aakhri din)
    if (m) { let y = +m[2]; if (y < 100) y += 2000; return y + '-' + pad2(m[1]) + '-' + pad2(new Date(y, +m[1], 0).getDate()); }
    return isNaN(new Date(s)) ? '2027-12-31' : s;
}
function addOrMerge(d, item, idx) {
    const ex = d.products.find(function (p) { return p.name.toLowerCase() === item.name.toLowerCase() && String(p.batch) === String(item.batch) && packOf(p) === packOf(item); });
    if (ex) ex.stock += item.stock;
    else { item.id = Date.now() + idx; d.products.push(item); }
}
app.post('/bulk-upload', requireStore, upload.single('bulkFile'), function (req, res) {
    if (!req.file) return go(res, 'add-stock', 'Please select a valid Excel or CSV file!');
    try {
        const r = importRows(req.data, readSheetRows(req.file.path));
        req.save();
        go(res, 'current-stock', 'Upload Success! ' + r.added + ' items add hue' + (r.skipped ? ', ' + r.skipped + ' rows skip hui (naam ya stock khali).' : '.'));
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        go(res, 'add-stock', 'File padhne mein error aaya, kripya Sample format check karein.');
    }
});
app.post('/scan-purchase-bill', requireStore, upload.single('billImage'), async function (req, res) {
    if (!req.file) return go(res, 'add-stock', 'Please upload a bill photo!');
    if (!fs.existsSync(TESS_FILE)) {
        fs.unlinkSync(req.file.path);
        return go(res, 'add-stock', 'Photo scan ke liye tessdata/eng.traineddata file chahiye (ek baar internet par apne aap download hogi). Tab tak Manual ya Excel se stock jodein.');
    }
    try {
        const text = await ocrText(req.file.path);
        fs.unlinkSync(req.file.path);
        const items = parseBillText(text).map(function (x) {
            return { name: x.name, batch: x.batch, expiry: x.expiry ? normExpiry(x.expiry) : '', qty: x.qty, rate: x.rate, pack: 10 };
        });
        req.session.scan = items; req.session.scanRaw = text;
        go(res, 'add-stock', items.length ? 'Bill scan complete: ' + items.length + ' item mile. Niche verify karein.' : 'Koi item auto nahi mila. Niche padha hua text dekhein aur "+ Add Row" se khud bharein.');
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        go(res, 'add-stock', 'Photo scan karne mein samasya aayi, kripya clear photo dalein.');
    }
});
app.post('/confirm-scanned-stock', requireStore, function (req, res) {
    const count = parseInt(req.body.count) || 0;
    let n = 0;
    for (let i = 0; i < count; i++) {
        const name = String(req.body['name_' + i] || '').trim();
        const qty = parseInt(req.body['qty_' + i]) || 0;
        const pack = Math.max(1, parseInt(req.body['pack_' + i]) || 1);
        const rate = parseFloat(req.body['rate_' + i]) || 0;
        if (!name || qty <= 0) continue;
        addOrMerge(req.data, {
            name: name, batch: String(req.body['batch_' + i] || 'SCAN01').trim(), expiry: normExpiry(req.body['expiry_' + i]),
            mrp: rate, rate: rate, gst: 12, packSize: pack, stock: qty * pack
        }, i);
        n++;
    }
    req.save(); req.session.scan = []; req.session.scanRaw = '';
    go(res, 'current-stock', 'Scanned bill ke ' + n + ' items stock mein add ho gaye!');
});
app.get('/clear-scan', requireStore, function (req, res) { req.session.scan = []; req.session.scanRaw = ''; res.redirect('/?tab=add-stock'); });

app.post('/add-product', requireStore, function (req, res) {
    const b = req.body;
    const pack = Math.max(1, parseInt(b.pack) || 1);
    req.data.products.push({
        id: Date.now(), name: String(b.name || '').trim(), batch: String(b.batch || '').trim(), expiry: b.expiry || '2027-12-31',
        mrp: parseFloat(b.mrp) || 0, rate: parseFloat(b.rate) || 0, gst: parseFloat(b.gst) || 0, packSize: pack, stock: (parseInt(b.stock) || 0) * pack
    });
    req.save(); go(res, 'current-stock', 'Naya item successfully add ho gaya!');
});
app.post('/add-stock', requireStore, function (req, res) {
    const p = req.data.products.find(function (x) { return x.id == req.body.id; });
    const q = parseInt(req.body.qty);
    if (p && q > 0) { p.stock += q * packOf(p); req.save(); }
    go(res, 'current-stock', 'Stock update ho gaya!');
});
app.post('/set-pack', requireStore, function (req, res) {
    const p = req.data.products.find(function (x) { return x.id == req.body.id; });
    const np = Math.max(1, parseInt(req.body.pack) || 1);
    if (!p) return go(res, 'current-stock', 'Item nahi mila.');
    const op = packOf(p);
    if (np === op) return go(res, 'current-stock', 'Pack size pehle se ' + op + ' hai.');
    if (p.stock % op !== 0) return go(res, 'current-stock', 'Is item ki loose tablets bachi hain, isliye pack size abhi nahi badal sakte.');
    p.stock = (p.stock / op) * np; p.packSize = np;            // strips ki ginti wahi rehti hai
    req.save();
    go(res, 'current-stock', p.name + ': ab 1 strip = ' + np + ' tablet. Stock: ' + fmtQty(p.stock, np));
});
app.post('/delete-product', requireStore, function (req, res) {
    if (!checkPass(req.body.adminPin || '', req.store.salt, req.store.pinHash)) return go(res, 'current-stock', 'Galat Admin PIN! Item delete nahi hua.');
    req.data.products = req.data.products.filter(function (p) { return p.id != req.body.id; });
    req.save(); go(res, 'current-stock', 'Admin verified: Item delete kar diya gaya!');
});

/* ----------------------- backup / restore (store level) ----------------------- */
app.get('/download-backup', requireStore, function (req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=backup_' + req.store.username + '_' + todayStr() + '.json');
    res.send(JSON.stringify(req.data, null, 2));
});
app.post('/restore-backup', requireStore, upload.single('backupFile'), function (req, res) {
    if (!req.file) return go(res, 'settings', 'Backup file chunein.');
    const drop = function () { try { fs.unlinkSync(req.file.path); } catch (e) { } };
    if (!checkPass(req.body.pin || '', req.store.salt, req.store.pinHash)) { drop(); return go(res, 'settings', 'Galat Admin PIN! Restore nahi hua.'); }
    try {
        const j = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
        drop();
        if (!j || !Array.isArray(j.products) || !Array.isArray(j.bills)) throw new Error('bad');
        fs.copyFileSync(storeFile(req.store.id), storeFile(req.store.id) + '.before_restore');
        req.data = { products: j.products, bills: j.bills, purchaseOrders: Array.isArray(j.purchaseOrders) ? j.purchaseOrders : [] };
        req.save();
        go(res, 'settings', 'Backup restore ho gaya: ' + j.products.length + ' items, ' + j.bills.length + ' bills.');
    } catch (e) { drop(); go(res, 'settings', 'Ye valid backup file nahi hai.'); }
});

/* ----------------- owner: customer ka purana stock import karna ----------------- */
app.post('/admin/import-stock', requireAdmin, upload.single('bulkFile'), function (req, res) {
    const s = loadStores().stores.find(function (x) { return x.id === req.body.id; });
    const back = function (m) { res.redirect('/admin?msg=' + enc(m)); };
    if (!s || !req.file) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) { } return back('Store aur file dono chunein.'); }
    try {
        const d = loadData(s.id);
        const r = importRows(d, readSheetRows(req.file.path));
        writeJson(storeFile(s.id), d);
        back(s.name + ': ' + r.added + ' items import hue' + (r.skipped ? ', ' + r.skipped + ' rows skip.' : '.'));
    } catch (e) { try { fs.unlinkSync(req.file.path); } catch (x) { } back('File padhne mein error aaya. Sample format dekhein.'); }
});

/* --------------------------- billing routes --------------------------- */
app.post('/add-to-cart', requireStore, function (req, res) {
    const id = parseInt(req.body.productId), qty = parseInt(req.body.qty), cart = req.session.cart;
    const p = req.data.products.find(function (x) { return x.id === id; });
    if (!p || isNaN(qty) || qty <= 0) return go(res, 'billing', 'Sahi item aur quantity chunein!');
    const pk = packOf(p), base = req.body.unit === 'tab' ? qty : qty * pk;
    const ex = cart.find(function (i) { return i.id === id; });
    if ((ex ? ex.qty : 0) + base > p.stock) return go(res, 'billing', 'Utna stock available nahi hai! (Available: ' + fmtQty(p.stock, pk) + ')');
    if (ex) ex.qty += base; else cart.push({ id: p.id, name: p.name, batch: p.batch, pack: pk, rate: p.rate, gst: p.gst, qty: base });
    res.redirect('/?tab=billing');
});
app.post('/remove-from-cart', requireStore, function (req, res) {
    const i = parseInt(req.body.index);
    if (!isNaN(i) && i >= 0 && i < req.session.cart.length) req.session.cart.splice(i, 1);
    res.redirect('/?tab=billing');
});
app.post('/save-bill', requireStore, function (req, res) {
    const cart = req.session.cart;
    if (!cart.length) return go(res, 'billing', 'Pehle bill mein kam se kam ek item add karein!');
    const d = req.data;
    const discount = Math.min(100, Math.max(0, parseFloat(req.body.discount) || 0));
    const mode = ['Cash', 'UPI', 'Credit'].indexOf(req.body.paymentMode) > -1 ? req.body.paymentMode : 'Cash';
    let sub = 0;
    const items = [];
    cart.forEach(function (it) {
        const p = d.products.find(function (x) { return x.id === it.id; });
        if (p && p.stock >= it.qty) {
            const pk = packOf(p);
            p.stock -= it.qty;
            const amt = lineAmt(p.rate, pk, it.qty, p.gst);
            sub += amt;
            items.push({ name: p.name, batch: p.batch, qty: it.qty, pack: pk, rate: p.rate, gst: p.gst, amount: amt });
        }
    });
    if (!items.length) { req.session.cart = []; return go(res, 'billing', 'Stock khatam ho gaya, bill nahi bana.'); }
    const discountAmt = sub * discount / 100, total = sub - discountAmt;
    const billNo = d.bills.reduce(function (m, b) { return Math.max(m, b.billNo); }, 0) + 1;
    d.bills.push({
        billNo: billNo, counter: counterName(req), isoDate: todayStr(), date: new Date().toLocaleString('en-IN'),
        customer: String(req.body.customer || 'Cash Customer').trim() || 'Cash Customer', phone: String(req.body.phone || '').trim(),
        discount: discount, discountAmt: discountAmt, subTotal: sub, paymentMode: mode, items: items,
        details: items.map(function (i) { return i.name + ' x' + fmtQty(i.qty, i.pack); }).join(', '), total: total
    });
    req.save(); req.session.cart = [];
    go(res, 'billing', 'Bill #' + billNo + ' (' + mode + ') saved! Total: Rs.' + total.toFixed(2), '&pb=' + billNo);
});

app.get('/print-bill/:billNo', requireStore, function (req, res) {
    const b = req.data.bills.find(function (x) { return x.billNo == req.params.billNo; });
    if (!b) return res.status(404).send('Bill not found!');
    const st = req.store;
    const lines = b.items ? b.items.map(function (i, n) {
        return '<tr><td>' + (n + 1) + '</td><td>' + esc(i.name) + '<br><small>Batch ' + esc(i.batch) + '</small></td><td>' + esc(fmtQty(i.qty, i.pack || 1)) + '</td><td>' + i.rate.toFixed(2) + '</td><td>' + i.gst + '%</td><td style="text-align:right">' + i.amount.toFixed(2) + '</td></tr>';
    }).join('') : '<tr><td colspan="6">' + esc(b.details) + '</td></tr>';
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bill #' + b.billNo + '</title><style>' +
        'body{font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:20px auto;padding:24px;border:1px solid #222;color:#111;font-size:13px}' +
        'h2{margin:0;text-align:center}.c{text-align:center;color:#555;margin:2px 0}table{width:100%;border-collapse:collapse;margin:12px 0}' +
        'th,td{padding:6px 4px;border-bottom:1px solid #ddd;text-align:left}th{border-bottom:2px solid #222}hr{border:0;border-top:1px dashed #888;margin:10px 0}' +
        '.r{text-align:right}.big{font-size:18px;font-weight:800}button{width:100%;padding:10px;background:#0f766e;color:#fff;border:0;border-radius:6px;font-weight:700;cursor:pointer;margin-top:14px}' +
        '@media print{button{display:none}body{border:0;margin:0}}</style></head><body>' +
        '<h2>' + esc(st.name) + '</h2>' + (st.address ? '<p class="c">' + esc(st.address) + '</p>' : '') +
        '<p class="c">' + (st.phone ? 'Ph: ' + esc(st.phone) : '') + (st.gstin ? ' &nbsp; GSTIN/DL: ' + esc(st.gstin) : '') + '</p><hr>' +
        '<p style="margin:4px 0"><b>TAX INVOICE / CASH MEMO</b><br>Bill No: <b>#' + b.billNo + '</b> &nbsp; Date: ' + esc(b.date) + '<br>Party: <b>' + esc(b.customer) + '</b>' + (b.phone ? ' (' + esc(b.phone) + ')' : '') +
        '<br>Payment: ' + esc(b.paymentMode || 'Cash') + '</p>' +
        '<table><tr><th>#</th><th>Item</th><th>Qty</th><th>Rate (strip)</th><th>GST</th><th class="r">Amount</th></tr>' + lines + '</table>' +
        (b.discount ? '<p class="r" style="margin:2px 0">Sub-Total: ' + inr(b.subTotal != null ? b.subTotal : b.total) + '<br>Discount (' + b.discount + '%): -' + inr(b.discountAmt || 0) + '</p>' : '') +
        '<p class="r big">Grand Total: ' + inr(b.total) + '</p><hr><p class="c">Thank you! Get well soon.</p>' +
        '<button onclick="window.print()">Print / Save PDF</button></body></html>');
});

/* ------------------------- store: supplier accounts manage ------------------------- */
app.post('/add-supplier', requireStore, function (req, res) {
    const reg = loadStores(), s = reg.stores.find(function (x) { return x.id === req.store.id; });
    const name = String(req.body.name || '').trim(), username = String(req.body.username || '').trim().toLowerCase(), password = String(req.body.password || '');
    if (!name || !/^[a-z0-9_.\-]{3,20}$/.test(username) || password.length < 6) return go(res, 'settings', 'Naam, valid Login ID aur 6+ character password zaroori hai.');
    if (usernameTaken(reg, username)) return go(res, 'settings', 'Ye Login ID pehle se kisi aur ke paas hai, doosri chunein.');
    const otpPhone = normPhone(req.body.otpPhone);
    if (req.body.otpPhone && !otpPhone) return go(res, 'settings', 'OTP mobile number sahi nahi hai (10 digit, 6-9 se shuru).');
    if (otpOn() && !otpPhone) return go(res, 'settings', 'OTP chalu hai, isliye supplier ka mobile number zaroori hai.');
    const salt = newSalt();
    s.suppliers.push({ id: String(Date.now()), name: name, username: username, salt: salt, hash: hashPass(password, salt), active: true, otpPhone: otpPhone, createdAt: todayStr() });
    saveStores(reg);
    go(res, 'settings', 'Supplier "' + name + '" ban gaya. Login ID: ' + username);
});
app.post('/set-supplier-phone', requireStore, function (req, res) {
    const reg = loadStores(), s = reg.stores.find(function (x) { return x.id === req.store.id; });
    const x = s.suppliers.find(function (y) { return y.id === req.body.id; }), ph = normPhone(req.body.otpPhone);
    if (!x || !ph) return go(res, 'settings', 'Sahi 10 digit mobile number daalein.');
    x.otpPhone = ph; saveStores(reg);
    go(res, 'settings', x.name + ': OTP mobile ' + maskPhone(ph) + ' set ho gaya.');
});
app.post('/toggle-supplier', requireStore, function (req, res) {
    const reg = loadStores(), s = reg.stores.find(function (x) { return x.id === req.store.id; });
    const x = s.suppliers.find(function (y) { return y.id === req.body.id; });
    if (x) { x.active = !x.active; saveStores(reg); }
    go(res, 'settings', x ? x.name + (x.active ? ' unblock ho gaya.' : ' block ho gaya.') : 'Supplier nahi mila.');
});
app.post('/reset-supplier-password', requireStore, function (req, res) {
    const reg = loadStores(), s = reg.stores.find(function (x) { return x.id === req.store.id; });
    const x = s.suppliers.find(function (y) { return y.id === req.body.id; }), pw = String(req.body.password || '');
    if (!x || pw.length < 6) return go(res, 'settings', 'Password kam se kam 6 character ka ho.');
    x.hash = hashPass(pw, x.salt); saveStores(reg);
    go(res, 'settings', x.name + ' ka naya password set ho gaya.');
});

/* ------------------------- store: supplier bill confirm / reject ------------------------- */
app.post('/supplier-bill/confirm', requireStore, function (req, res) {
    const d = req.data, b = d.incoming.find(function (x) { return x.id == req.body.id && x.status === 'pending'; });
    if (!b) return go(res, 'supplier-bills', 'Ye bill pehle hi process ho chuka hai.');
    const rows = [];
    for (let i = 0; i < b.items.length; i++) {
        if (!req.body['inc_' + i]) continue;
        const r = {
            name: String(req.body['name_' + i] || '').trim(), batch: String(req.body['batch_' + i] || '').trim(),
            expiryRaw: String(req.body['expiry_' + i] || '').trim(), pack: Math.max(1, parseInt(req.body['pack_' + i]) || 1),
            qty: parseInt(req.body['qty_' + i]) || 0, sale: parseFloat(req.body['sale_' + i]) || 0, mrp: parseFloat(req.body['mrp_' + i]) || 0,
            gst: parseFloat(req.body['gst_' + i])
        };
        if (!r.name || r.qty <= 0) continue;
        if (!r.expiryRaw) return go(res, 'supplier-bills', '"' + r.name + '" ki expiry date bharein (dawa ke liye zaroori hai).');
        rows.push(r);
    }
    if (!rows.length) return go(res, 'supplier-bills', 'Koi item select nahi hua. Kam se kam ek item ka tick rakhein.');
    rows.forEach(function (r, i) {
        addOrMerge(d, { name: r.name, batch: r.batch || 'B01', expiry: normExpiry(r.expiryRaw), mrp: r.mrp || r.sale, rate: r.sale, gst: isNaN(r.gst) ? 12 : r.gst, packSize: r.pack, stock: r.qty * r.pack }, i);
    });
    b.status = 'accepted'; b.acceptedItems = rows.length; b.decidedAt = new Date().toLocaleString('en-IN');
    req.save();
    go(res, 'current-stock', rows.length + ' items stock mein add ho gaye (' + b.supplierName + ').');
});
app.post('/supplier-bill/reject', requireStore, function (req, res) {
    const b = req.data.incoming.find(function (x) { return x.id == req.body.id && x.status === 'pending'; });
    if (b) {
        b.status = 'rejected'; b.reason = String(req.body.reason || '').trim().slice(0, 200); b.decidedAt = new Date().toLocaleString('en-IN');
        req.save();
    }
    go(res, 'supplier-bills', 'Bill reject kar diya gaya.');
});

/* ------------------------------ SUPPLIER PORTAL ------------------------------ */
function incRow(i, it) {
    const v = function (x, dflt) { return x === undefined || x === null || x === '' ? dflt : x; };
    return '<td><input name="name_' + i + '" value="' + esc(v(it.name, '')) + '" class="w100" style="min-width:150px"></td>' +
        '<td><input name="batch_' + i + '" value="' + esc(v(it.batch, '')) + '" style="width:90px"></td>' +
        '<td><input type="date" name="expiry_' + i + '" value="' + esc(v(it.expiry, '')) + '"></td>' +
        '<td><input type="number" step="0.01" min="0" name="mrp_' + i + '" value="' + v(it.mrp, '') + '" style="width:80px"></td>' +
        '<td><input type="number" step="0.01" min="0" name="rate_' + i + '" value="' + v(it.rate, '') + '" style="width:80px"></td>' +
        '<td><input type="number" step="0.01" min="0" name="gst_' + i + '" value="' + v(it.gst, 12) + '" style="width:60px"></td>' +
        '<td><input type="number" min="1" name="pack_' + i + '" value="' + v(it.pack, 10) + '" style="width:65px"></td>' +
        '<td><input type="number" min="0" name="qty_' + i + '" value="' + v(it.qty, '') + '" style="width:75px"></td>';
}
function collectItems(b) {
    const items = [], n = Math.min(parseInt(b.count) || 0, 500);
    for (let i = 0; i < n; i++) {
        const name = String(b['name_' + i] || '').trim(), qty = parseInt(b['qty_' + i]) || 0;
        if (!name || qty <= 0) continue;
        const gst = parseFloat(b['gst_' + i]);
        items.push({
            name: name, batch: String(b['batch_' + i] || 'B01').trim(), expiry: b['expiry_' + i] ? normExpiry(b['expiry_' + i]) : '',
            mrp: parseFloat(b['mrp_' + i]) || 0, rate: parseFloat(b['rate_' + i]) || 0, gst: isNaN(gst) ? 12 : gst,
            pack: Math.max(1, parseInt(b['pack_' + i]) || 1), qty: qty
        });
    }
    return items;
}
function rowsToItems(rows) {
    const items = [];
    rows.slice(0, 500).forEach(function (row) {
        const r = mapRow(row), name = String(r.name || '').trim(), qty = parseInt(r.stock);
        if (!name || !(qty > 0)) return;
        const gst = parseFloat(r.gst);
        items.push({
            name: name, batch: String(r.batch || 'B01').trim(), expiry: r.expiry ? normExpiry(r.expiry) : '', mrp: parseFloat(r.mrp) || 0,
            rate: parseFloat(r.rate) || 0, gst: isNaN(gst) ? 12 : gst, pack: parsePack(r.pack), qty: qty
        });
    });
    return items;
}
function pushIncoming(req, items) {
    const b = req.body;
    req.data.incoming.push({
        id: Date.now(), supplierId: req.supplier.id, supplierName: req.supplier.name, invoiceNo: String(b.invoiceNo || '').trim().slice(0, 40),
        invoiceDate: isoDate(b.invoiceDate) ? b.invoiceDate : todayStr(), note: String(b.note || '').trim().slice(0, 200),
        items: items, status: 'pending', createdAt: new Date().toLocaleString('en-IN')
    });
    req.save();
}
const supBack = function (res, m) { res.redirect('/supplier?msg=' + enc(m)); };

app.get('/supplier', requireSupplier, function (req, res) {
    const msg = req.query.msg ? '<div class="alert">' + esc(req.query.msg) + '</div>' : '';
    const mine = req.data.incoming.filter(function (x) { return x.supplierId === req.supplier.id; }).slice().reverse().slice(0, 40);
    const rows = [0, 1, 2].map(function (i) { return '<tr>' + incRow(i, {}) + '</tr>'; }).join('');
    const blank = JSON.stringify(incRow('__I__', {})).slice(1, -1);
    const head = '<div class="row"><div><label>Bill / Challan No.</label><input class="w100" name="invoiceNo" placeholder="e.g. 4521"></div>' +
        '<div><label>Bill Date</label><input class="w100" type="date" name="invoiceDate" value="' + todayStr() + '" required></div>' +
        '<div><label>Note (optional)</label><input class="w100" name="note"></div></div>';
    const manual = '<div class="card"><h2 class="card-title">Naya Bill / Maal ki List Bhejein</h2>' +
        '<p style="margin-top:0;color:var(--muted);line-height:1.6">Jo items aap <b>' + esc(req.store.name) + '</b> ko de rahe hain unki list bharein. Store confirm karega tabhi unke stock mein judega. Qty = kitne strip/pack, Tab/Strip = ek patti mein kitni tablet (syrup/injection = 1).</p>' +
        '<form method="POST" action="/supplier/submit">' + head + '<input type="hidden" name="count" id="cnt" value="3">' +
        tbl(['Item Name', 'Batch', 'Expiry', 'MRP', 'Your Rate (strip)', 'GST %', 'Tab/Strip', 'Qty (strips)'], rows, 'itm') +
        '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-gray" onclick="addR()">+ Add Row</button><button class="btn btn-success">Send to Store</button></div></form>' +
        '<script>var RH="' + blank + '";function addR(){var c=document.getElementById("cnt"),i=parseInt(c.value),tr=document.createElement("tr");tr.innerHTML=RH.split("__I__").join(i);document.querySelector("#itm tbody").appendChild(tr);c.value=i+1;}</script></div>';
    const upload = '<div class="card"><h2 class="card-title">Ya Excel / CSV se bhejein</h2>' +
        '<form method="POST" action="/supplier/upload" enctype="multipart/form-data">' + head +
        '<input type="file" name="bulkFile" accept=".csv,.xlsx,.xls" required class="w100" style="margin-top:10px">' +
        '<div style="margin:8px 0;font-size:13px"><a href="/supplier/sample" style="color:#15803d;font-weight:700">Sample Excel download karein</a> (columns: Name, Batch, Expiry, MRP, Rate, GST, PackSize, Qty)</div>' +
        '<button class="btn btn-primary">Upload &amp; Send to Store</button></form></div>';
    const hist = mine.map(function (b) {
        const badge = b.status === 'pending' ? '<span class="badge b-yellow" style="margin-left:0">Store ke confirm ka intezaar</span>' :
            (b.status === 'accepted' ? '<span class="badge b-green" style="margin-left:0">Stock mein add ho gaya</span>' : '<span class="badge b-red" style="margin-left:0">Rejected</span>' + (b.reason ? ' <small>' + esc(b.reason) + '</small>' : ''));
        return '<tr><td>' + esc(b.createdAt) + '</td><td>' + esc(b.invoiceNo || '-') + '</td><td>' + b.items.length + '</td><td>' + inr(incTotal(b.items)) + '</td><td>' + badge + '</td></tr>';
    }).join('');
    res.send(page('Supplier Portal',
        '<div class="topbar"><div class="brand"><div class="logo">+</div><div><b>' + esc(req.supplier.name) + '</b><small>Supplier Portal | ' + esc(req.store.name) + '</small></div></div>' +
        '<div class="top-right"><a href="/logout" class="btn btn-gray btn-sm">Logout</a></div></div>' +
        '<div class="main" style="margin:0 auto;position:relative;z-index:1">' + msg + manual + upload +
        '<div class="card"><h3 class="card-title">Aapke Bheje Hue Bills</h3>' + tbl(['Date', 'Bill No', 'Items', 'Value', 'Status'], hist || emptyRow(5, 'Abhi tak koi bill nahi bheja.')) + '</div></div>'));
});
app.post('/supplier/submit', requireSupplier, function (req, res) {
    const items = collectItems(req.body);
    if (!items.length) return supBack(res, 'Kam se kam ek item (naam aur qty ke saath) bharein.');
    pushIncoming(req, items);
    supBack(res, 'Bill bhej diya gaya (' + items.length + ' items). Store confirm karega tab stock mein judega.');
});
app.post('/supplier/upload', requireSupplier, upload.single('bulkFile'), function (req, res) {
    if (!req.file) return supBack(res, 'Excel ya CSV file chunein.');
    try {
        const items = rowsToItems(readSheetRows(req.file.path));
        if (!items.length) return supBack(res, 'File mein koi valid item nahi mila. Sample format dekhein.');
        pushIncoming(req, items);
        supBack(res, 'File se ' + items.length + ' items store ko bhej diye gaye.');
    } catch (e) {
        try { fs.unlinkSync(req.file.path); } catch (x) { }
        supBack(res, 'File padhne mein error aaya. Sample format dekhein.');
    }
});
app.get('/supplier/sample', requireSupplier, function (req, res) {
    sendExcel(res, SAMPLE.map(function (r) { return { Name: r.Name, Batch: r.Batch, Expiry: r.Expiry, MRP: r.MRP, Rate: r.Rate, GST: r.GST, PackSize: r.PackSize, Qty: r.Stock }; }), 'SupplierBill', 'Supplier_Bill_Sample');
});

/* ------------------------------ start ------------------------------ */
initStores();
ensureTessdata();
checkOtpConfig();
app.listen(PORT, '0.0.0.0', function () {
    console.log('Smart Billing & Stock Hub (Multi-Store) chalu hai: http://localhost:' + PORT);
    const nStores = loadStores().stores.length;
    console.log('Data folder: ' + DATA_DIR + '   | stores mile: ' + nStores + (nStores === 0 ? '   <-- KHALI! Agar pehle stores bane the to ye galat/naya folder hai, ya purana data hat gaya.' : ''));
    console.log('Super Admin panel: http://localhost:' + PORT + '/admin  (Login ID: ' + SUPER_USER + ')');
    console.log('Pehli baar SUPER_PASS set karke chalayein, ya turant Owner Password section se badal dein.');
});
