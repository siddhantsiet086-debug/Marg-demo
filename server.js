const express = require('express');
const fs = require('fs');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 5000;
const ADMIN_PIN = '1234';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
if (!fs.existsSync('./shops_data')) fs.mkdirSync('./shops_data');
const upload = multer({ dest: 'uploads/' });

// =========================================================
// YAHAN APNE CUSTOMERS (SHOPS) KE ID AUR PASSWORD ADD KAREIN
// =========================================================
const SHOPS = {
    'admin': { pass: '1234', shopName: 'Smart Billing & Stock Hub' },
    'shop1': { pass: '1111', shopName: 'Sharma Medical Store' },
    'shop2': { pass: '2222', shopName: 'Gupta General Store' }
};

let shopSessions = {};

const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
function tag(name, attrs, content) {
    return LT + name + (attrs ? ' ' + attrs : '') + GT + (content || '') + LT + '/' + name + GT;
}
function singleTag(name, attrs) {
    return LT + name + (attrs ? ' ' + attrs : '') + GT;
}

// INDIA TIMEZONE (IST) DATE & TIME FUNCTIONS
function getTodayDate() {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
}

function getIndianDateTime() {
    return new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });
}

function isExpiringSoon(expiryStr) {
    if (!expiryStr) return false;
    const today = new Date(getTodayDate());
    const exp = new Date(expiryStr);
    const diffDays = (exp - today) / (1000 * 60 * 60 * 24);
    return diffDays <= 30;
}

// COOKIE SE LOGGED-IN SHOP NIKALNA
function getLoggedShop(req) {
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(/shopId=([a-zA-Z0-9_-]+)/);
    if (match && SHOPS[match[1]]) {
        return match[1];
    }
    return null;
}

function getSession(shopId) {
    if (!shopSessions[shopId]) {
        shopSessions[shopId] = { activeCart: [], scannedItemsPreview: [] };
    }
    return shopSessions[shopId];
}

// HAR SHOP KI ALAG DATA FILE LOAD KARNA
function loadData(shopId) {
    const dbFile = './shops_data/data_' + shopId + '.json';
    if (!fs.existsSync(dbFile)) {
        const initialData = {
            products: [
                { id: 1, name: "Dolo 650mg", batch: "B101", expiry: "2027-08-15", mrp: 30, rate: 25, gst: 12, stock: 100 },
                { id: 2, name: "Amoxicillin 500", batch: "A205", expiry: "2026-12-10", mrp: 85, rate: 70, gst: 12, stock: 8 }
            ],
            bills: [],
            purchaseOrders: []
        };
        fs.writeFileSync(dbFile, JSON.stringify(initialData, null, 2));
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(dbFile));
        if (!parsed.purchaseOrders) parsed.purchaseOrders = [];
        return parsed;
    } catch (e) {
        return { products: [], bills: [], purchaseOrders: [] };
    }
}

function saveData(shopId, data) {
    const dbFile = './shops_data/data_' + shopId + '.json';
    fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
}

// LOGIN PAGE
function renderLoginPage(errorMsg) {
    const css =
        'body { font-family: "Segoe UI", Arial, sans-serif; background: linear-gradient(135deg, #1e1b4b, #3730a3); height: 100vh; display: flex; justify-content: center; align-items: center; margin: 0; }' +
        '.login-box { background: white; padding: 34px; border-radius: 14px; width: 360px; box-shadow: 0 12px 30px rgba(0,0,0,0.3); text-align: center; }' +
        'input { width: 100%; padding: 11px; margin: 8px 0 14px 0; border: 1px solid #cbd5e1; border-radius: 8px; box-sizing: border-box; font-size: 14px; }' +
        '.btn { width: 100%; padding: 12px; background: #4f46e5; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer; }';

    const errHtml = errorMsg ? tag('div', 'style="background:#fee2e2;color:#b91c1c;padding:10px;border-radius:6px;margin-bottom:12px;font-size:13px;font-weight:600;"', errorMsg) : '';

    const form = tag('form', 'method="POST" action="/login"',
        singleTag('input', 'type="text" name="shopId" placeholder="Shop ID / Username (e.g. shop1)" required') +
        singleTag('input', 'type="password" name="password" placeholder="Password" required') +
        tag('button', 'type="submit" class="btn"', 'Login to Billing Panel')
    );

    return singleTag('!DOCTYPE html') + tag('html', '',
        tag('head', '', singleTag('meta', 'charset="UTF-8"') + singleTag('meta', 'name="viewport" content="width=device-width, initial-scale=1.0"') + tag('title', '', 'Shop Login') + tag('style', '', css)) +
        tag('body', '', tag('div', 'class="login-box"',
            tag('h2', 'style="color:#1e1b4b;margin-top:0;"', 'Smart Billing Login') +
            tag('p', 'style="color:#64748b;font-size:13px;"', 'Apni Shop ID aur Password daal kar login karein') +
            errHtml + form
        ))
    );
}

app.post('/login', function(req, res) {
    const shopId = (req.body.shopId || '').trim().toLowerCase();
    const password = (req.body.password || '').trim();
    if (SHOPS[shopId] && SHOPS[shopId].pass === password) {
        res.setHeader('Set-Cookie', 'shopId=' + shopId + '; Path=/; HttpOnly');
        return res.redirect('/');
    }
    res.send(renderLoginPage('Galat Shop ID ya Password! Dobara try karein.'));
});

app.get('/logout', function(req, res) {
    res.setHeader('Set-Cookie', 'shopId=; Path=/; Max-Age=0');
    res.redirect('/');
});

function renderLayout(shopId, activeTab, mainContent, extraHtml, data) {
    const shopInfo = SHOPS[shopId];
    const today = getTodayDate();
    let todayTotal = 0;
    let todayCash = 0;
    let todayUpi = 0;

    (data.bills || []).forEach(function(b) {
        if ((b.isoDate || today) === today) {
            todayTotal += b.total;
            if (b.paymentMode === 'UPI') todayUpi += b.total;
            else if (b.paymentMode === 'Cash') todayCash += b.total;
        }
    });

    let alertCount = 0;
    (data.products || []).forEach(function(p) {
        if (p.stock < 10 || isExpiringSoon(p.expiry)) alertCount++;
    });

    const css =
        '* { box-sizing: border-box; }' +
        'body { font-family: "Segoe UI", Arial, sans-serif; background-color: #eef2ff; margin: 0; color: #1e293b; }' +
        '.topbar { background: linear-gradient(135deg, #1e1b4b 0%, #3730a3 100%); color: white; padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 3px 12px rgba(30,27,75,0.25); }' +
        '.brand-title { font-size: 20px; font-weight: 700; }' +
        '.brand-badge { background: linear-gradient(90deg, #10b981, #059669); color: #fff; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; text-decoration: none; }' +
        '.workspace { display: flex; min-height: calc(100vh - 58px); }' +
        '.sidebar { width: 255px; background: #0f172a; padding: 22px 14px; display: flex; flex-direction: column; gap: 10px; }' +
        '.nav-label { color: #64748b; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; padding: 0 12px; margin-bottom: 4px; }' +
        '.nav-item { display: block; padding: 12px 16px; border-radius: 8px; text-decoration: none; color: #cbd5e1; font-weight: 600; font-size: 14px; }' +
        '.nav-item:hover { background: #1e293b; color: #ffffff; }' +
        '.nav-item.active { background: linear-gradient(90deg, #4f46e5, #6366f1); color: #ffffff; }' +
        '.main-area { flex: 1; padding: 22px 26px; max-width: 1280px; }' +
        '.stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 22px; }' +
        '.stat-card { background: white; padding: 16px 20px; border-radius: 12px; border: 1px solid #e0e7ff; }' +
        '.stat-title { font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; }' +
        '.stat-val { font-size: 22px; font-weight: 800; margin-top: 6px; }' +
        '.card { background: #ffffff; padding: 22px; border-radius: 12px; border: 1px solid #e0e7ff; margin-bottom: 20px; }' +
        '.card-title { margin: 0 0 16px 0; font-size: 18px; color: #1e1b4b; border-bottom: 2px solid #eef2ff; padding-bottom: 10px; }' +
        'table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13.5px; }' +
        'th { background-color: #f8fafc; color: #334155; font-weight: 700; text-align: left; padding: 11px 12px; border-bottom: 2px solid #e2e8f0; }' +
        'td { padding: 11px 12px; border-bottom: 1px solid #f1f5f9; text-align: left; }' +
        'input, select { padding: 9px 12px; margin: 4px 0; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 14px; }' +
        '.btn { padding: 9px 16px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13.5px; text-decoration: none; display: inline-block; }' +
        '.btn-primary { background: #4f46e5; color: white; }' +
        '.btn-success { background: #10b981; color: white; }' +
        '.btn-warning { background: #f59e0b; color: white; }' +
        '.btn-danger { background: #ef4444; color: white; }' +
        '.btn-whatsapp { background: #25d366; color: white; }' +
        '.btn-gray { background: #64748b; color: white; }' +
'.alert { background: #fef3c7; color: #92400e; padding: 12px 16px; border-left: 4px solid #f59e0b; border-radius: 6px; margin-bottom: 16px; font-weight: 600; font-size: 14px; }' +
'.badge-red { background: #fee2e2; color: #b91c1c; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; margin-left: 5px; }' +
'.badge-yellow { background: #fef3c7; color: #b45309; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; margin-left: 5px; }' +
'.badge-blue { background: #e0e7ff; color: #3730a3; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; }' +
'.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }';
const topbar = tag('div', 'class="topbar"',
tag('div', 'class="brand-title"', shopInfo.shopName + ' (' + shopId.toUpperCase() + ')') +
tag('div', '',
tag('span', 'class="brand-badge" style="margin-right:10px;"', 'IST: ' + today) +
tag('a', 'href="/logout" class="btn btn-danger" style="padding:6px 12px;font-size:12px;"', 'Logout')
)
);
const statsBar = tag('div', 'class="stats-grid"',
tag('div', 'class="stat-card" style="border-top:4px solid #4f46e5;"',
tag('div', 'class="stat-title"', 'Todays Total Sale') +
tag('div', 'class="stat-val" style="color:#4f46e5;"', 'Rs.' + todayTotal.toFixed(2))
) +
tag('div', 'class="stat-card" style="border-top:4px solid #10b981;"',
tag('div', 'class="stat-title"', 'Todays Cash') +
tag('div', 'class="stat-val" style="color:#059669;"', 'Rs.' + todayCash.toFixed(2))
) +
tag('div', 'class="stat-card" style="border-top:4px solid #0ea5e9;"',
tag('div', 'class="stat-title"', 'Todays UPI / Online') +
tag('div', 'class="stat-val" style="color:#0284c7;"', 'Rs.' + todayUpi.toFixed(2))
) +
tag('div', 'class="stat-card" style="border-top:4px solid #ef4444;"',
tag('div', 'class="stat-title"', 'Stock & Expiry Alerts') +
tag('div', 'class="stat-val" style="color:#dc2626;"', alertCount + ' Items Alert')
)
);
const sidebar = tag('div', 'class="sidebar"',
tag('div', 'class="nav-label"', 'Main Menu') +
tag('a', 'href="/?tab=billing" class="nav-item' + (activeTab === 'billing' ? ' active' : '') + '"', '1. Generate Sale Bill') +
tag('a', 'href="/?tab=add-stock" class="nav-item' + (activeTab === 'add-stock' ? ' active' : '') + '"', '2. Add Stock') +
tag('a', 'href="/?tab=current-stock" class="nav-item' + (activeTab === 'current-stock' ? ' active' : '') + '"', '3. Current Stock') +
tag('a', 'href="/?tab=reports" class="nav-item' + (activeTab === 'reports' ? ' active' : '') + '"', '4. Bills & Download') +
tag('a', 'href="/?tab=purchase-order" class="nav-item' + (activeTab === 'purchase-order' ? ' active' : '') + '"', '5. Purchase Order List') +
tag('div', 'style="margin-top:auto;padding:12px;background:#1e293b;border-radius:8px;color:#94a3b8;font-size:12px;"',
tag('b', 'style="color:#fff;"', 'Shop ID: ') + shopId + singleTag('br') +
tag('b', 'style="color:#fff;"', 'Admin PIN: ') + ADMIN_PIN
)
);
const workspace = tag('div', 'class="workspace"',
sidebar + tag('div', 'class="main-area"', statsBar + mainContent)
);
return singleTag('!DOCTYPE html') + tag('html', '',
tag('head', '', singleTag('meta', 'charset="UTF-8"') + tag('title', '', shopInfo.shopName) + tag('style', '', css)) +
tag('body', '', topbar + (extraHtml || '') + workspace)
);
}
// MAIN ROUTE HANDLER (5 TABS - USER MANUAL REMOVED)
app.get('/', function(req, res) {
const shopId = getLoggedShop(req);
if (!shopId) return res.send(renderLoginPage(''));
const session = getSession(shopId);
const data = loadData(shopId);
const tab = req.query.tab || 'billing';
const msg = req.query.msg || '';
const confirmDelId = req.query.confirmDel || '';
const today = getTodayDate();
const alertHtml = msg ? tag('div', 'class="alert"', msg) : '';
let confirmPopupHtml = '';
if (confirmDelId) {
const delProd = data.products.find(function(p) { return p.id == confirmDelId; });
if (delProd) {
const delForm = tag('form', 'method="POST" action="/delete-product" style="margin-top:14px;"',
singleTag('input', 'type="hidden" name="id" value="' + delProd.id + '"') +
singleTag('input', 'type="password" name="adminPin" placeholder="Enter Admin PIN (1234)" required style="width:85%;margin-bottom:14px;text-align:center;"') + singleTag('br') +
tag('a', 'href="/?tab=current-stock" class="btn btn-gray" style="margin-right:8px;"', 'Cancel') +
tag('button', 'type="submit" class="btn btn-danger"', 'Yes, Delete Item')
);
confirmPopupHtml = tag('div', 'style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.65);display:flex;justify-content:center;align-items:center;z-index:999;"',
tag('div', 'style="background:white;padding:28px;border-radius:12px;width:380px;text-align:center;border-top:6px solid #ef4444;"',
tag('h3', 'style="color:#ef4444;margin-top:0;"', 'Admin Lock: Confirm Delete') +
tag('p', 'style="font-size:14px;color:#334155;"', 'Kya aap sach mein ' + tag('b', '', delProd.name) + ' ko delete karna chahte hain?') +
delForm
)
);
}
}
// TAB 1: GENERATE SALE BILL
if (tab === 'billing') {
const productOptions = data.products
.filter(function(p) { return p.stock > 0; })
.map(function(p) {
return tag('option', 'value="' + p.id + '"', p.name + ' (Batch: ' + p.batch + ' | Rate: Rs.' + p.rate + ' | GST: ' + p.gst + '% | Avl: ' + p.stock + ')');
}).join('');
let subTotal = 0;
let cartRows = session.activeCart.map(function(item, index) {
const base = item.rate * item.qty;
const total = base + (base * item.gst / 100);
subTotal += total;
const remForm = tag('form', 'method="POST" action="/remove-from-cart" style="margin:0;"',
singleTag('input', 'type="hidden" name="index" value="' + index + '"') +
tag('button', 'type="submit" class="btn btn-danger" style="padding:4px 10px;"', 'X')
);
return tag('tr', '',
tag('td', '', tag('b', '', item.name)) +
tag('td', '', item.batch) +
tag('td', '', 'Rs.' + item.rate) +
tag('td', '', item.qty) +
tag('td', '', item.gst + '%') +
tag('td', '', tag('b', '', 'Rs.' + total.toFixed(2))) +
tag('td', '', remForm)
);
}).join('');
if (session.activeCart.length === 0) {
cartRows = tag('tr', '', tag('td', 'colspan="7" style="text-align:center;color:#64748b;padding:24px;"', 'Abhi bill mein koi item nahi hai. Upar se item select karke "+ Add to Bill" par click karein.'));
}
const addToBillForm = tag('form', 'method="POST" action="/add-to-cart" style="background:#f8fafc;padding:16px;border:1px solid #e2e8f0;border-radius:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;"',
tag('select', 'name="productId" style="flex:1;min-width:250px;" required', productOptions) +
singleTag('input', 'type="number" name="qty" min="1" value="1" style="width:90px;" required') +
tag('button', 'type="submit" class="btn btn-primary"', '+ Add to Bill')
);
const cartTable = tag('table', '',
tag('tr', '', tag('th', '', 'Item Name') + tag('th', '', 'Batch') + tag('th', '', 'Rate') + tag('th', '', 'Qty') + tag('th', '', 'GST%') + tag('th', '', 'Total') + tag('th', '', 'Remove')) +
cartRows
);
const paymentOptions = tag('option', 'value="Cash"', 'Cash') + tag('option', 'value="UPI"', 'UPI / Online') + tag('option', 'value="Credit"', 'Credit (Udhaar)');
const saveBillForm = tag('form', 'method="POST" action="/save-bill" style="margin-top:20px;border-top:2px solid #eef2ff;padding-top:16px;"',
tag('div', 'style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-bottom:16px;"',
tag('div', '', tag('label', 'style="font-weight:600;font-size:13px;"', 'Customer / Party Name:') + singleTag('input', 'type="text" name="customer" value="Cash Customer" required style="width:100%;"')) +
tag('div', '', tag('label', 'style="font-weight:600;font-size:13px;"', 'Mobile (for WhatsApp):') + singleTag('input', 'type="text" name="phone" placeholder="e.g. 9876543210" style="width:100%;"')) +
tag('div', '', tag('label', 'style="font-weight:600;font-size:13px;"', 'Discount (%):') + singleTag('input', 'type="number" step="0.1" min="0" max="100" name="discount" value="0" style="width:100%;"')) +
tag('div', '', tag('label', 'style="font-weight:600;font-size:13px;"', 'Payment Mode:') + tag('select', 'name="paymentMode" style="width:100%;"', paymentOptions))
) +
tag('div', 'style="display:flex;justify-content:space-between;align-items:center;background:#eef2ff;padding:14px 18px;border-radius:8px;"',
tag('div', 'style="font-size:22px;font-weight:800;color:#1e1b4b;"', 'Sub-Total (Before Discount): Rs.' + subTotal.toFixed(2)) +
tag('button', 'type="submit" class="btn btn-success" style="font-size:16px;padding:12px 28px;"', 'SAVE & GENERATE BILL')
)
);
const card = tag('div', 'class="card"', tag('h2', 'class="card-title"', 'Generate Sale Bill (Multiple Items)') + alertHtml + addToBillForm + cartTable + saveBillForm);
return res.send(renderLayout(shopId, 'billing', card, confirmPopupHtml, data));
}
// TAB 2: ADD STOCK
if (tab === 'add-stock') {
let scanPreviewHtml = '';
if (session.scannedItemsPreview.length > 0) {
let previewRows = session.scannedItemsPreview.map(function(item, idx) {
return tag('tr', '',
tag('td', '', singleTag('input', 'type="text" name="name_' + idx + '" value="' + item.name + '" style="width:95%;"')) +
tag('td', '', singleTag('input', 'type="text" name="batch_' + idx + '" value="SCAN01" style="width:90px;"')) +
tag('td', '', singleTag('input', 'type="number" step="0.01" name="rate_' + idx + '" value="' + item.rate + '" style="width:80px;"')) +
tag('td', '', singleTag('input', 'type="number" name="qty_' + idx + '" value="' + item.qty + '" style="width:75px;"'))
);
}).join('');
const confirmScanForm = tag('form', 'method="POST" action="/confirm-scanned-stock"',
singleTag('input', 'type="hidden" name="count" value="' + session.scannedItemsPreview.length + '"') +
tag('table', '', tag('tr', '', tag('th', '', 'Detected Item') + tag('th', '', 'Batch') + tag('th', '', 'Rate') + tag('th', '', 'Qty')) + previewRows) + singleTag('br') +
tag('button', 'type="submit" class="btn btn-success"', '+ Confirm & Add All to Stock') + ' ' +
tag('a', 'href="/clear-scan" class="btn btn-gray"', 'Cancel')
);
scanPreviewHtml = tag('div', 'class="card" style="border:2px solid #10b981;background:#ecfdf5;"', tag('h3', 'style="margin-top:0;color:#065f46;"', 'Bill Photo se ye Items mile hain:') + confirmScanForm);
}
const manualForm = tag('form', 'method="POST" action="/add-product"',
singleTag('input', 'type="text" name="name" placeholder="Item Name (e.g. Pan-D)" required style="width:100%;"') +
tag('div', 'style="display:flex;gap:10px;"', singleTag('input', 'type="text" name="batch" placeholder="Batch No." required style="width:50%;"') + singleTag('input', 'type="date" name="expiry" required style="width:50%;"')) +
tag('div', 'style="display:flex;gap:10px;"', singleTag('input', 'type="number" step="0.01" name="mrp" placeholder="MRP" required style="width:50%;"') + singleTag('input', 'type="number" step="0.01" name="rate" placeholder="Sale Rate" required style="width:50%;"')) +
tag('div', 'style="display:flex;gap:10px;"', singleTag('input', 'type="number" step="0.01" name="gst" placeholder="GST %" value="12" required style="width:50%;"') + singleTag('input', 'type="number" name="stock" placeholder="Opening Stock Qty" required style="width:50%;"')) + singleTag('br') +
tag('button', 'type="submit" class="btn btn-success" style="width:100%;"', '+ Save Single Item')
);
const leftCard = tag('div', 'class="card"', tag('h3', 'class="card-title"', 'Option 1: Manual Item Entry (with Expiry)') + manualForm);
const sampleLinks = tag('a', 'href="/sample-excel" style="color:#10b981;font-weight:bold;text-decoration:none;"', '[Download Sample Excel .xlsx]') + '  |  ' + tag('a', 'href="/sample-csv" style="color:#f59e0b;font-weight:bold;text-decoration:none;"', '[Download Sample .csv]');
const bulkForm = tag('form', 'method="POST" action="/bulk-upload" enctype="multipart/form-data" style="margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid #e2e8f0;"',
tag('div', 'style="font-weight:600;margin-bottom:6px;"', 'Option 2: Bulk Excel (.xlsx) / CSV Upload') +
tag('div', 'style="font-size:13px;margin-bottom:10px;"', sampleLinks) +
singleTag('input', 'type="file" name="bulkFile" accept=".csv,.xlsx,.xls" required style="width:100%;margin-bottom:8px;"') +
tag('button', 'type="submit" class="btn btn-primary" style="width:100%;"', 'Upload Excel / CSV File')
);
const snapForm = tag('form', 'method="POST" action="/scan-purchase-bill" enctype="multipart/form-data"',
tag('div', 'style="font-weight:600;margin-bottom:6px;"', 'Option 3: Supplier Bill Photo Scan (AI OCR)') +
singleTag('input', 'type="file" name="billImage" accept="image/*" required style="width:100%;margin-bottom:8px;"') +
tag('button', 'type="submit" class="btn btn-warning" style="width:100%;"', 'Scan Bill Photo')
);
const rightCard = tag('div', 'class="card"', tag('h3', 'class="card-title"', 'Fast Stock Upload (Bulk & Photo Scan)') + bulkForm + snapForm);
return res.send(renderLayout(shopId, 'add-stock', alertHtml + scanPreviewHtml + tag('div', 'class="grid-2"', leftCard + rightCard), confirmPopupHtml, data));
}
// TAB 3: CURRENT STOCK
if (tab === 'current-stock') {
const productRows = data.products.map(function(p) {
const lowStockBadge = p.stock === 0 ? tag('span', 'class="badge-red"', 'OUT OF STOCK') : (p.stock < 10 ? tag('span', 'class="badge-yellow"', 'LOW STOCK') : '');
const expBadge = isExpiringSoon(p.expiry) ? tag('span', 'class="badge-red"', 'EXPIRING') : '';
const addForm = tag('form', 'method="POST" action="/add-stock" style="display:inline-flex;gap:6px;align-items:center;margin-right:8px;"',
singleTag('input', 'type="hidden" name="id" value="' + p.id + '"') +
singleTag('input', 'type="number" name="qty" value="10" min="1" style="width:65px;padding:5px;"') +
tag('button', 'type="submit" class="btn btn-success" style="padding:6px 10px;font-size:12px;"', '+ Add')
);
const delLink = tag('a', 'href="/?tab=current-stock&confirmDel=' + p.id + '" class="btn btn-danger" style="padding:6px 10px;font-size:12px;"', 'Delete');
return tag('tr', '',
tag('td', '', tag('b', '', p.name) + lowStockBadge) +
tag('td', '', p.batch) +
tag('td', '', (p.expiry || 'N/A') + expBadge) +
tag('td', '', 'Rs.' + p.rate) +
tag('td', '', p.gst + '%') +
tag('td', '', tag('span', 'style="background:#e0e7ff;color:#3730a3;padding:4px 10px;border-radius:12px;font-weight:700;"', p.stock)) +
tag('td', 'style="white-space:nowrap;"', addForm + delLink)
);
}).join('');
const stockTable = tag('table', '', tag('tr', '', tag('th', '', 'Item Name') + tag('th', '', 'Batch') + tag('th', '', 'Expiry Date') + tag('th', '', 'Sale Rate') + tag('th', '', 'GST') + tag('th', '', 'Stock') + tag('th', '', 'Quick Actions')) + productRows);
const card = tag('div', 'class="card"', tag('h2', 'class="card-title"', 'Current Stock, Low Stock & Expiry Alerts') + alertHtml + stockTable);
return res.send(renderLayout(shopId, 'current-stock', card, confirmPopupHtml, data));
}
// TAB 4: BILLS & DOWNLOAD
if (tab === 'reports') {
const fromDate = req.query.fromDate || '';
const toDate = req.query.toDate || '';
let filteredBills = data.bills.slice().reverse();
if (fromDate && toDate) {
filteredBills = filteredBills.filter(function(b) {
const bDate = b.isoDate || today;
return bDate >= fromDate && bDate <= toDate;
});
}
let totalSales = 0;
let billRows = filteredBills.map(function(b) {
totalSales += b.total;
const waText = encodeURIComponent('Hello ' + b.customer + ', Thank you for shopping at ' + SHOPS[shopId].shopName + '! Bill #' + b.billNo + ' | Items: ' + b.details + ' | Total Paid: Rs.' + b.total.toFixed(2));
const cleanPhone = (b.phone || '').replace(/\D/g, '');
const waUrl = cleanPhone ? 'wa.me' + cleanPhone + '?text=' + waText : 'wa.me' + waText;
const printBtn = tag('a', 'href="/print-bill/' + b.billNo + '" target="_blank" class="btn btn-primary" style="padding:5px 10px;font-size:12px;margin-right:5px;"', 'Print');
const waBtn = tag('a', 'href="' + waUrl + '" target="_blank" class="btn btn-whatsapp" style="padding:5px 10px;font-size:12px;"', 'WhatsApp');
return tag('tr', '',
tag('td', '', tag('b', '', '#' + b.billNo)) +
tag('td', '', b.date) +
tag('td', '', tag('b', '', b.customer) + (b.phone ? singleTag('br') + b.phone : '')) +
tag('td', '', b.details + (b.discount ? ' (Disc: ' + b.discount + '%)' : '')) +
tag('td', '', tag('b', '', b.paymentMode || 'Cash')) +
tag('td', '', tag('b', '', 'Rs.' + b.total.toFixed(2))) +
tag('td', 'style="white-space:nowrap;"', printBtn + waBtn)
);
}).join('');
if (filteredBills.length === 0) {
billRows = tag('tr', '', tag('td', 'colspan="7" style="text-align:center;padding:20px;color:#64748b;"', 'Is date range mein koi bill nahi mila.'));
}
const filterForm = tag('form', 'method="GET" action="/" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;"',
singleTag('input', 'type="hidden" name="tab" value="reports"') +
tag('span', '', tag('b', '', 'From: ') + singleTag('input', 'type="date" name="fromDate" value="' + (fromDate || today) + '" required')) +
tag('span', '', tag('b', '', 'To: ') + singleTag('input', 'type="date" name="toDate" value="' + (toDate || today) + '" required')) +
tag('button', 'type="submit" class="btn btn-primary"', 'Filter Bills') +
tag('a', 'href="/?tab=reports" class="btn btn-gray"', 'Show All')
);
const downloadExcelForm = tag('form', 'method="GET" action="/download-excel" style="display:inline-block;margin-right:8px;"',
singleTag('input', 'type="hidden" name="fromDate" value="' + (fromDate || '2000-01-01') + '"') +
singleTag('input', 'type="hidden" name="toDate" value="' + (toDate || '2099-12-31') + '"') +
tag('button', 'type="submit" class="btn btn-success"', 'Download Excel (.xlsx)')
);
const downloadCsvForm = tag('form', 'method="GET" action="/download-csv" style="display:inline-block;"',
singleTag('input', 'type="hidden" name="fromDate" value="' + (fromDate || '2000-01-01') + '"') +
singleTag('input', 'type="hidden" name="toDate" value="' + (toDate || '2099-12-31') + '"') +
tag('button', 'type="submit" class="btn btn-warning"', 'Download CSV')
);
const filterBar = tag('div', 'style="background:#f8fafc;border:1px solid #e2e8f0;padding:16px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:15px;"', filterForm + tag('div', '', downloadExcelForm + downloadCsvForm));
const billsTable = tag('table', '', tag('tr', '', tag('th', '', 'Bill No') + tag('th', '', 'Date & Time (IST)') + tag('th', '', 'Customer') + tag('th', '', 'Items Details') + tag('th', '', 'Mode') + tag('th', '', 'Grand Total') + tag('th', '', 'Actions')) + billRows);
const card = tag('div', 'class="card"', tag('h2', 'class="card-title"', 'Bills, WhatsApp Share & Custom Date Reports') + filterBar + tag('h3', 'style="text-align:right;color:#10b981;margin:16px 0 6px 0;"', 'Total Sales (Filtered): Rs.' + totalSales.toFixed(2)) + billsTable);
return res.send(renderLayout(shopId, 'reports', card, confirmPopupHtml, data));
}
// TAB 5: PURCHASE ORDER LIST
if (tab === 'purchase-order') {
const autoShortItems = data.products.filter(function(p) { return p.stock < 10; });
const addPoForm = tag('form', 'method="POST" action="/add-purchase-order" style="background:#f8fafc;padding:16px;border:1px solid #e2e8f0;border-radius:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px;"',
singleTag('input', 'type="text" name="itemName" placeholder="Item Name" required style="flex:2;min-width:200px;"') +
singleTag('input', 'type="text" name="supplier" placeholder="Supplier Name" style="flex:1;min-width:180px;"') +
singleTag('input', 'type="number" name="orderQty" value="50" min="1" required style="width:110px;"') +
tag('button', 'type="submit" class="btn btn-primary"', '+ Add to Order List')
);
const autoRows = autoShortItems.map(function(p) {
const suggestedQty = p.stock === 0 ? 100 : 50;
const statusBadge = p.stock === 0 ? tag('span', 'class="badge-red"', 'OUT OF STOCK (0)') : tag('span', 'class="badge-yellow"', 'LOW STOCK (' + p.stock + ')');
const moveForm = tag('form', 'method="POST" action="/add-purchase-order" style="display:inline-flex;gap:6px;align-items:center;"',
singleTag('input', 'type="hidden" name="itemName" value="' + p.name + '"') +
singleTag('input', 'type="hidden" name="supplier" value="Main Wholesaler"') +
singleTag('input', 'type="number" name="orderQty" value="' + suggestedQty + '" min="1" style="width:70px;padding:5px;"') +
tag('button', 'type="submit" class="btn btn-warning" style="padding:6px 10px;font-size:12px;"', 'Add to Final List')
);
return tag('tr', '', tag('td', '', tag('b', '', p.name) + statusBadge) + tag('td', '', p.batch) + tag('td', '', p.stock + ' left') + tag('td', '', moveForm));
}).join('');
let poWaLines = ['SUPPLIER ORDER LIST (' + today + ')'];
const poRows = (data.purchaseOrders || []).map(function(po, idx) {
poWaLines.push((idx + 1) + '. ' + po.itemName + ' - Qty: ' + po.orderQty);
const recvForm = tag('form', 'method="POST" action="/receive-purchase-order" style="display:inline-block;margin-right:6px;"',
singleTag('input', 'type="hidden" name="poId" value="' + po.id + '"') +
tag('button', 'type="submit" class="btn btn-success" style="padding:5px 10px;font-size:12px;"', 'Mark Received (+Stock)')
);
const delPoForm = tag('form', 'method="POST" action="/delete-purchase-order" style="display:inline-block;"',
singleTag('input', 'type="hidden" name="poId" value="' + po.id + '"') +
tag('button', 'type="submit" class="btn btn-danger" style="padding:5px 10px;font-size:12px;"', 'Remove')
);
return tag('tr', '', tag('td', '', tag('b', '', po.itemName)) + tag('td', '', po.supplier || 'General') + tag('td', '', tag('span', 'class="badge-blue"', po.orderQty + ' pcs')) + tag('td', '', po.date) + tag('td', '', recvForm + delPoForm));
}).join('');
const emptyPoRow = tag('tr', '', tag('td', 'colspan="5" style="text-align:center;padding:20px;color:#64748b;"', 'Final Order List khali hai.'));
const finalWaUrl = 'wa.me' + encodeURIComponent(poWaLines.join('\n'));
const actionBar = tag('div', 'style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;"',
tag('h3', 'style="margin:0;color:#1e1b4b;"', 'Final Supplier Order List (' + (data.purchaseOrders || []).length + ' Items)') +
tag('div', 'style="display:flex;gap:8px;flex-wrap:wrap;"',
tag('a', 'href="/download-po-excel" class="btn btn-success"', 'Download Excel (.xlsx)') +
tag('a', 'href="/download-po-csv" class="btn btn-warning"', 'Download CSV') +
tag('a', 'href="' + finalWaUrl + '" target="_blank" class="btn btn-whatsapp"', 'Send List on WhatsApp')
)
);
const mainPoCard = tag('div', 'class="card"', tag('h2', 'class="card-title"', 'Purchase Order & Out-of-Stock List') + alertHtml + addPoForm + actionBar + tag('table', '', tag('tr', '', tag('th', '', 'Item Name') + tag('th', '', 'Supplier') + tag('th', '', 'Order Qty') + tag('th', '', 'Added Date') + tag('th', '', 'Actions')) + (poRows || emptyPoRow)));
let autoAlertCard = autoShortItems.length > 0 ? tag('div', 'class="card" style="border-left:5px solid #ef4444;"', tag('h3', 'class="card-title" style="color:#b91c1c;"', 'Auto-Detected Low / Out-of-Stock Items (Stock < 10)') + tag('table', '', tag('tr', '', tag('th', '', 'Item Name') + tag('th', '', 'Batch') + tag('th', '', 'Current Stock') + tag('th', '', 'Action')) + autoRows)) : '';
return res.send(renderLayout(shopId, 'purchase-order', mainPoCard + autoAlertCard, confirmPopupHtml, data));
}
});
// ALL ACTION ROUTES (PROTECTED BY SHOP LOGIN)
app.post('/add-purchase-order', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
const data = loadData(shopId);
const itemName = (req.body.itemName || '').trim();
const supplier = (req.body.supplier || 'Main Wholesaler').trim();
const orderQty = parseInt(req.body.orderQty) || 50;
if (itemName) {
const existing = data.purchaseOrders.find(function(po) { return po.itemName.toLowerCase() === itemName.toLowerCase(); });
if (existing) existing.orderQty += orderQty;
else data.purchaseOrders.push({ id: Date.now(), itemName: itemName, supplier: supplier, orderQty: orderQty, date: getTodayDate() });
saveData(shopId, data);
}
res.redirect('/?tab=purchase-order&msg=Item Supplier Order List mein add ho gaya!');
});
app.post('/delete-purchase-order', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
const data = loadData(shopId);
data.purchaseOrders = data.purchaseOrders.filter(function(po) { return po.id != req.body.poId; });
saveData(shopId, data);
res.redirect('/?tab=purchase-order&msg=Order list se item hata diya gaya.');
});
app.post('/receive-purchase-order', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
const data = loadData(shopId);
const po = data.purchaseOrders.find(function(item) { return item.id == req.body.poId; });
if (po) {
const prod = data.products.find(function(p) { return p.name.toLowerCase() === po.itemName.toLowerCase(); });
if (prod) prod.stock += po.orderQty;
else data.products.push({ id: Date.now(), name: po.itemName, batch: 'NEW01', expiry: '2027-12-31', mrp: 50, rate: 40, gst: 12, stock: po.orderQty });
data.purchaseOrders = data.purchaseOrders.filter(function(item) { return item.id != req.body.poId; });
saveData(shopId, data);
}
res.redirect('/?tab=purchase-order&msg=Maal receive ho gaya aur Current Stock mein jud gaya hai!');
});
app.get('/download-po-csv', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
const data = loadData(shopId);
let csv = 'S.No,Item Name,Supplier,Order Quantity,Date\n';
(data.purchaseOrders || []).forEach(function(po, idx) {
csv += (idx + 1) + ',"' + po.itemName + '","' + (po.supplier || '') + '",' + po.orderQty + ',"' + po.date + '"\n';
});
res.setHeader('Content-Type', 'text/csv');
res.setHeader('Content-Disposition', 'attachment; filename=Supplier_Order_' + shopId + '_' + getTodayDate() + '.csv');
res.send(csv);
});
app.get('/download-po-excel', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
const data = loadData(shopId);
const rows = (data.purchaseOrders || []).map(function(po, idx) {
return { 'S.No': idx + 1, 'Item Name': po.itemName, 'Supplier': po.supplier || 'Main Wholesaler', 'Order Quantity': po.orderQty, 'Date': po.date };
});
const ws = XLSX.utils.json_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'PurchaseOrder');
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
res.setHeader('Content-Disposition', 'attachment; filename=Supplier_Order_' + shopId + '_' + getTodayDate() + '.xlsx');
res.send(buf);
});
app.get('/sample-csv', function(req, res) {
const sample = 'Name,Batch,Expiry,MRP,Rate,GST,Stock\nCrocin 500,C102,2027-06-30,20,16,12,200\nAzithromycin 500,AZ99,2027-09-15,110,85,12,150\n';
res.setHeader('Content-Type', 'text/csv');
res.setHeader('Content-Disposition', 'attachment; filename=Bulk_Stock_Sample.csv');
res.send(sample);
});
app.get('/sample-excel', function(req, res) {
const rows = [
{ Name: 'Crocin 500', Batch: 'C102', Expiry: '2027-06-30', MRP: 20, Rate: 16, GST: 12, Stock: 200 },
{ Name: 'Azithromycin 500', Batch: 'AZ99', Expiry: '2027-09-15', MRP: 110, Rate: 85, GST: 12, Stock: 150 }
];
const ws = XLSX.utils.json_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'StockSample');
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
res.setHeader('Content-Disposition', 'attachment; filename=Bulk_Stock_Sample.xlsx');
res.send(buf);
});
app.post('/bulk-upload', upload.single('bulkFile'), function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
if (!req.file) return res.redirect('/?tab=add-stock&msg=Please select a valid Excel or CSV file!');
try {
const workbook = XLSX.readFile(req.file.path);
fs.unlinkSync(req.file.path);
const sheetName = workbook.SheetNames[0];
const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
const data = loadData(shopId);
let addedCount = 0;
rows.forEach(function(row, idx) {
const name = String(row.Name || row.name || '').trim();
const batch = String(row.Batch || row.batch || 'B01').trim();
const expiry = String(row.Expiry || row.expiry || '2027-12-31').trim();
const mrp = parseFloat(row.MRP || row.mrp) || 0;
const rate = parseFloat(row.Rate || row.rate) || 0;
const gst = parseFloat(row.GST || row.gst) || 12;
const stock = parseInt(row.Stock || row.stock) || 0;
if (name && stock > 0) {
const existing = data.products.find(function(p) { return p.name.toLowerCase() === name.toLowerCase(); });
if (existing) existing.stock += stock;
else data.products.push({ id: Date.now() + idx, name: name, batch: batch, expiry: expiry, mrp: mrp, rate: rate, gst: gst, stock: stock });
addedCount++;
}
});
saveData(shopId, data);
res.redirect('/?tab=current-stock&msg=Bulk Upload Success! ' + addedCount + ' items stock mein add ho gaye.');
} catch (err) {
if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
res.redirect('/?tab=add-stock&msg=File padhne mein error aaya.');
}
});
app.post('/scan-purchase-bill', upload.single('billImage'), async function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
if (!req.file) return res.redirect('/?tab=add-stock&msg=Please upload a bill photo!');
const session = getSession(shopId);
try {
const result = await Tesseract.recognize(req.file.path, 'eng');
fs.unlinkSync(req.file.path);
const lines = (result.data.text || '').split(/\r?\n/);
const extracted = [];
lines.forEach(function(line) {
const match = line.trim().match(/^([A-Za-z][A-Za-z0-9\s-]{2,25})\s+(\d{1,5})/);
if (match) {
const itemName = match[1].trim();
const qty = parseInt(match[2]);
if (qty > 0 && !itemName.toLowerCase().includes('total')) {
extracted.push({ name: itemName, rate: 20, qty: qty });
}
}
});
if (extracted.length === 0) extracted.push({ name: "Paracetamol 500mg", rate: 25, qty: 100 });
session.scannedItemsPreview = extracted;
res.redirect('/?tab=add-stock&msg=Bill Photo Scan Complete!');
} catch (err) {
if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
res.redirect('/?tab=add-stock&msg=Photo scan karne mein samasya aayi.');
}
});
app.post('/confirm-scanned-stock', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
const session = getSession(shopId);
const count = parseInt(req.body.count) || 0;
const data = loadData(shopId);
for (let i = 0; i < count; i++) {
const name = (req.body['name_' + i] || '').trim();
const batch = (req.body['batch_' + i] || 'SCAN01').trim();
const rate = parseFloat(req.body['rate_' + i]) || 20;
const qty = parseInt(req.body['qty_' + i]) || 0;
if (name && qty > 0) {
const existing = data.products.find(function(p) { return p.name.toLowerCase() === name.toLowerCase(); });
if (existing) existing.stock += qty;
else data.products.push({ id: Date.now() + i, name: name, batch: batch, expiry: '2027-12-31', mrp: rate + 5, rate: rate, gst: 12, stock: qty });
}
}
saveData(shopId, data);
session.scannedItemsPreview = [];
res.redirect('/?tab=current-stock&msg=Scanned Bill ka saara stock add ho gaya!');
});
app.get('/clear-scan', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
getSession(shopId).scannedItemsPreview = [];
res.redirect('/?tab=add-stock');
});
app.get('/download-csv', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
const data = loadData(shopId);
const fromDate = req.query.fromDate;
const toDate = req.query.toDate;
const filteredBills = data.bills.filter(function(b) {
const bDate = b.isoDate || getTodayDate();
return bDate >= fromDate && bDate <= toDate;
});
let csv = 'Bill No,Date & Time (IST),Customer Name,Mobile,Items Details,Payment Mode,Grand Total (Rs)\n';
filteredBills.forEach(function(b) {
csv += b.billNo + ',"' + b.date + '","' + b.customer + '","' + (b.phone || '') + '","' + b.details + '","' + (b.paymentMode || 'Cash') + '",' + b.total.toFixed(2) + '\n';
});
res.setHeader('Content-Type', 'text/csv');
res.setHeader('Content-Disposition', 'attachment; filename=Bills_' + shopId + '_' + fromDate + 'to' + toDate + '.csv');
res.send(csv);
});
app.get('/download-excel', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
const data = loadData(shopId);
const fromDate = req.query.fromDate;
const toDate = req.query.toDate;
const filteredBills = data.bills.filter(function(b) {
const bDate = b.isoDate || getTodayDate();
return bDate >= fromDate && bDate <= toDate;
});
const excelRows = filteredBills.map(function(b) {
return { 'Bill No': b.billNo, 'Date & Time (IST)': b.date, 'Customer Name': b.customer, 'Mobile': b.phone || '', 'Items Details': b.details, 'Payment Mode': b.paymentMode || 'Cash', 'Grand Total (Rs)': parseFloat(b.total.toFixed(2)) };
});
const ws = XLSX.utils.json_to_sheet(excelRows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'BillsReport');
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
res.setHeader('Content-Disposition', 'attachment; filename=Bills_' + shopId + '_' + fromDate + 'to' + toDate + '.xlsx');
res.send(buf);
});
app.post('/add-product', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
const data = loadData(shopId);
const { name, batch, expiry, mrp, rate, gst, stock } = req.body;
data.products.push({ id: Date.now(), name: name, batch: batch, expiry: expiry || '2027-12-31', mrp: parseFloat(mrp), rate: parseFloat(rate), gst: parseFloat(gst), stock: parseInt(stock) });
saveData(shopId, data);
res.redirect('/?tab=current-stock&msg=Naya item successfully add ho gaya!');
});
app.post('/add-stock', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
const data = loadData(shopId);
const prod = data.products.find(function(p) { return p.id == req.body.id; });
if (prod) { prod.stock += parseInt(req.body.qty); saveData(shopId, data); }
res.redirect('/?tab=current-stock&msg=Stock update ho gaya!');
});
app.post('/delete-product', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
if (req.body.adminPin !== ADMIN_PIN) return res.redirect('/?tab=current-stock&msg=Galat Admin PIN! Item delete nahi hua.');
const data = loadData(shopId);
data.products = data.products.filter(function(p) { return p.id != req.body.id; });
saveData(shopId, data);
res.redirect('/?tab=current-stock&msg=Admin verified: Item delete kar diya gaya!');
});
app.post('/add-to-cart', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
const session = getSession(shopId);
const data = loadData(shopId);
const prodId = parseInt(req.body.productId);
const qty = parseInt(req.body.qty);
const prod = data.products.find(function(p) { return p.id === prodId; });
if (!prod || isNaN(qty) || qty <= 0) return res.redirect('/?tab=billing&msg=Sahi item aur quantity chunein!');
const existing = session.activeCart.find(function(item) { return item.id === prodId; });
const currentQty = existing ? existing.qty : 0;
if (currentQty + qty > prod.stock) return res.redirect('/?tab=billing&msg=Utna stock available nahi hai!');
if (existing) existing.qty += qty;
else session.activeCart.push({ id: prod.id, name: prod.name, batch: prod.batch, rate: prod.rate, gst: prod.gst, qty: qty });
res.redirect('/?tab=billing');
});
app.post('/remove-from-cart', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
const session = getSession(shopId);
const index = parseInt(req.body.index);
if (!isNaN(index) && index >= 0 && index < session.activeCart.length) session.activeCart.splice(index, 1);
res.redirect('/?tab=billing');
});
app.post('/save-bill', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
const session = getSession(shopId);
if (session.activeCart.length === 0) return res.redirect('/?tab=billing&msg=Pehle bill mein kam se kam ek item add karein!');
const data = loadData(shopId);
const customer = req.body.customer || 'Cash Customer';
const phone = (req.body.phone || '').trim();
const discount = parseFloat(req.body.discount) || 0;
const paymentMode = req.body.paymentMode || 'Cash';
let subTotal = 0;
let detailList = [];
session.activeCart.forEach(function(item) {
const prod = data.products.find(function(p) { return p.id === item.id; });
if (prod && prod.stock >= item.qty) {
prod.stock -= item.qty;
const base = prod.rate * item.qty;
const total = base + (base * prod.gst / 100);
subTotal += total;
detailList.push(prod.name + ' x' + item.qty);
}
});
const discountAmt = subTotal * (discount / 100);
const finalTotal = subTotal - discountAmt;
const billNo = data.bills.length + 1;
data.bills.push({
billNo: billNo,
isoDate: getTodayDate(),
date: getIndianDateTime(),
customer: customer,
phone: phone,
discount: discount,
paymentMode: paymentMode,
details: detailList.join(', '),
total: finalTotal
});
saveData(shopId, data);
session.activeCart = [];
res.redirect('/?tab=billing&msg=Bill %23' + billNo + ' (' + paymentMode + ') Saved! Total: Rs.' + finalTotal.toFixed(2));
});
app.get('/print-bill/:billNo', function(req, res) {
const shopId = getLoggedShop(req); if (!shopId) return res.redirect('/');
const data = loadData(shopId);
const bill = data.bills.find(function(b) { return b.billNo == req.params.billNo; });
if (!bill) return res.send('Bill not found!');
const printBody =
tag('h2', 'style="text-align:center;margin-bottom:4px;"', SHOPS[shopId].shopName) +
tag('p', 'style="text-align:center;margin-top:0;color:#555;"', 'TAX INVOICE / CASH MEMO') +
singleTag('hr') +
tag('p', '',
tag('b', '', 'Bill No: ') + '#' + bill.billNo + singleTag('br') +
tag('b', '', 'Date (IST): ') + bill.date + singleTag('br') +
tag('b', '', 'Party: ') + bill.customer + (bill.phone ? ' (' + bill.phone + ')' : '') + singleTag('br') +
tag('b', '', 'Payment Mode: ') + (bill.paymentMode || 'Cash')
) + singleTag('hr') +
tag('p', '', tag('b', '', 'Items:') + singleTag('br') + bill.details) +
(bill.discount ? tag('p', '', tag('b', '', 'Discount Applied: ') + bill.discount + '%') : '') +
singleTag('hr') +
tag('h3', 'style="text-align:right;"', 'Grand Total: Rs.' + bill.total.toFixed(2)) +
tag('button', 'onclick="window.print()" style="width:100%;padding:10px;background:#4f46e5;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;"', 'Print / Save PDF');
res.send(singleTag('!DOCTYPE html') + tag('html', '', tag('body', 'style="font-family:Arial;padding:30px;max-width:450px;margin:auto;border:1px solid #000;"', printBody)));
});
app.listen(PORT, '0.0.0.0', function() {
console.log('Multi-Shop Billing Hub chalu hai port: ' + PORT);
});