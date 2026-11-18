const express = require('express');
const fs = require('fs');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const XLSX = require('xlsx');

const app = express();
const PORT = 5000;
const ADMIN_PIN = '1234';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
const upload = multer({ dest: 'uploads/' });

const DB_FILE = './marg_data.json';
let activeCart = [];
let scannedItemsPreview = [];

const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
function tag(name, attrs, content) {
    return LT + name + (attrs ? ' ' + attrs : '') + GT + (content || '') + LT + '/' + name + GT;
}
function singleTag(name, attrs) {
    return LT + name + (attrs ? ' ' + attrs : '') + GT;
}

function getTodayDate() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
}

function getClientSystemName(req) {
    const ip = req.ip || req.connection.remoteAddress || '';
    if (ip.includes('127.0.0.1') || ip.includes('::1')) return 'System-1 (Main)';
    const parts = ip.split('.');
    return 'Counter-' + (parts[parts.length - 1] || 'LAN');
}

function isExpiringSoon(expiryStr) {
    if (!expiryStr) return false;
    const today = new Date();
    const exp = new Date(expiryStr);
    const diffDays = (exp - today) / (1000 * 60 * 60 * 24);
    return diffDays <= 30;
}

function loadData() {
    if (!fs.existsSync(DB_FILE)) {
        const initialData = {
            products: [
                { id: 1, name: "Dolo 650mg", batch: "B101", expiry: "2027-08-15", mrp: 30, rate: 25, gst: 12, stock: 100 },
                { id: 2, name: "Amoxicillin 500", batch: "A205", expiry: "2026-12-10", mrp: 85, rate: 70, gst: 12, stock: 8 },
                { id: 3, name: "Paracetamol Syrup", batch: "P99", expiry: "2027-05-20", mrp: 45, rate: 38, gst: 5, stock: 0 }
            ],
            bills: [],
            purchaseOrders: []
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(DB_FILE));
        if (!parsed.purchaseOrders) parsed.purchaseOrders = [];
        return parsed;
    } catch (e) {
        return { products: [], bills: [], purchaseOrders: [] };
    }
}

function saveData(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function renderLayout(activeTab, mainContent, extraHtml, data) {
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
        '.brand-title { font-size: 21px; font-weight: 700; letter-spacing: 0.4px; }' +
        '.brand-badge { background: linear-gradient(90deg, #10b981, #059669); color: #fff; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; box-shadow: 0 2px 6px rgba(16,185,129,0.4); }' +
        '.workspace { display: flex; min-height: calc(100vh - 58px); }' +
        '.sidebar { width: 255px; background: #0f172a; padding: 22px 14px; display: flex; flex-direction: column; gap: 10px; }' +
        '.nav-label { color: #64748b; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; padding: 0 12px; margin-bottom: 4px; }' +
        '.nav-item { display: block; padding: 12px 16px; border-radius: 8px; text-decoration: none; color: #cbd5e1; font-weight: 600; font-size: 14px; transition: all 0.2s; }' +
        '.nav-item:hover { background: #1e293b; color: #ffffff; }' +
        '.nav-item.active { background: linear-gradient(90deg, #4f46e5, #6366f1); color: #ffffff; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.4); }' +
        '.main-area { flex: 1; padding: 22px 26px; max-width: 1280px; }' +
        '.stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 22px; }' +
        '.stat-card { background: white; padding: 16px 20px; border-radius: 12px; border: 1px solid #e0e7ff; box-shadow: 0 4px 10px rgba(0,0,0,0.03); }' +
        '.stat-title { font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; }' +
        '.stat-val { font-size: 22px; font-weight: 800; margin-top: 6px; }' +
        '.card { background: #ffffff; padding: 22px; border-radius: 12px; border: 1px solid #e0e7ff; box-shadow: 0 4px 14px rgba(0,0,0,0.04); margin-bottom: 20px; }' +
        '.card-title { margin: 0 0 16px 0; font-size: 18px; color: #1e1b4b; border-bottom: 2px solid #eef2ff; padding-bottom: 10px; }' +
        'table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13.5px; }' +
        'th { background-color: #f8fafc; color: #334155; font-weight: 700; text-align: left; padding: 11px 12px; border-bottom: 2px solid #e2e8f0; }' +
        'td { padding: 11px 12px; border-bottom: 1px solid #f1f5f9; text-align: left; }' +
        'tr:hover td { background-color: #f8fafc; }' +
        'input, select { padding: 9px 12px; margin: 4px 0; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 14px; outline: none; }' +
        'input:focus, select:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,0.12); }' +
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
        '.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }' +
        '@media print { .sidebar, .stats-grid, .no-print { display: none !important; } .main-area { padding: 0; max-width: 100%; } body { background: white; } .card { box-shadow: none; border: none; } }';

    const topbar = tag('div', 'class="topbar"',
        tag('div', 'class="brand-title"', 'Smart Billing & Stock Hub') +
        tag('div', 'class="brand-badge"', 'Live Counter & Inventory')
    );

    const statsBar = tag('div', 'class="stats-grid"',
        tag('div', 'class="stat-card" style="border-top:4px solid #4f46e5;"',
            tag('div', 'class="stat-title"', 'Today\'s Total Sale') +
            tag('div', 'class="stat-val" style="color:#4f46e5;"', 'Rs.' + todayTotal.toFixed(2))
        ) +
        tag('div', 'class="stat-card" style="border-top:4px solid #10b981;"',
            tag('div', 'class="stat-title"', 'Today\'s Cash') +
            tag('div', 'class="stat-val" style="color:#059669;"', 'Rs.' + todayCash.toFixed(2))
        ) +
        tag('div', 'class="stat-card" style="border-top:4px solid #0ea5e9;"',
            tag('div', 'class="stat-title"', 'Today\'s UPI / Online') +
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
        tag('a', 'href="/?tab=manual" class="nav-item' + (activeTab === 'manual' ? ' active' : '') + '"', '6. User Manual (PDF)') +
        tag('div', 'style="margin-top:auto;padding:12px;background:#1e293b;border-radius:8px;color:#94a3b8;font-size:12px;"',
tag('b', 'style="color:#fff;"', 'Admin Lock PIN: ') + ADMIN_PIN + singleTag('br') + '3-System LAN Ready'
)
);
const workspace = tag('div', 'class="workspace"',
sidebar + tag('div', 'class="main-area"', statsBar + mainContent)
);
return singleTag('!DOCTYPE html') + tag('html', '',
tag('head', '', singleTag('meta', 'charset="UTF-8"') + tag('title', '', 'Smart Billing & Stock Hub') + tag('style', '', css)) +
tag('body', '', topbar + (extraHtml || '') + workspace)
);
}
// MAIN ROUTE HANDLER FOR ALL 6 TABS
app.get('/', function(req, res) {
const data = loadData();
const tab = req.query.tab || 'billing';
const msg = req.query.msg || '';
const confirmDelId = req.query.confirmDel || '';
const today = getTodayDate();
const alertHtml = msg ? tag('div', 'class="alert"', msg) : '';
// Admin PIN + Delete Confirmation Modal
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
const modalContent =
tag('h3', 'style="color:#ef4444;margin-top:0;"', 'Admin Lock: Confirm Delete') +
tag('p', 'style="font-size:14px;color:#334155;"', 'Kya aap sach mein ' + tag('b', '', delProd.name) + ' ko delete karna chahte hain?') +
delForm;
confirmPopupHtml = tag('div', 'style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.65);display:flex;justify-content:center;align-items:center;z-index:999;"',
tag('div', 'style="background:white;padding:28px;border-radius:12px;width:380px;text-align:center;border-top:6px solid #ef4444;box-shadow:0 10px 25px rgba(0,0,0,0.25);"', modalContent)
);
}
}
// ---------------------------------------------------------
// TAB 1: GENERATE SALE BILL
// ---------------------------------------------------------
if (tab === 'billing') {
const productOptions = data.products
.filter(function(p) { return p.stock > 0; })
.map(function(p) {
return tag('option', 'value="' + p.id + '"', p.name + ' (Batch: ' + p.batch + ' | Rate: Rs.' + p.rate + ' | GST: ' + p.gst + '% | Avl: ' + p.stock + ')');
}).join('');
let subTotal = 0;
let cartRows = activeCart.map(function(item, index) {
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
if (activeCart.length === 0) {
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
const paymentOptions =
tag('option', 'value="Cash"', 'Cash') +
tag('option', 'value="UPI"', 'UPI / Online') +
tag('option', 'value="Credit"', 'Credit (Udhaar)');
const saveBillForm = tag('form', 'method="POST" action="/save-bill" style="margin-top:20px;border-top:2px solid #eef2ff;padding-top:16px;"',
tag('div', 'style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-bottom:16px;"',
tag('div', '',
tag('label', 'style="font-weight:600;font-size:13px;"', 'Customer / Party Name:') +
singleTag('input', 'type="text" name="customer" value="Cash Customer" required style="width:100%;"')
) +
tag('div', '',
tag('label', 'style="font-weight:600;font-size:13px;"', 'Mobile (for WhatsApp):') +
singleTag('input', 'type="text" name="phone" placeholder="e.g. 9876543210" style="width:100%;"')
) +
tag('div', '',
tag('label', 'style="font-weight:600;font-size:13px;"', 'Discount (%):') +
singleTag('input', 'type="number" step="0.1" min="0" max="100" name="discount" value="0" style="width:100%;"')
) +
tag('div', '',
tag('label', 'style="font-weight:600;font-size:13px;"', 'Payment Mode:') +
tag('select', 'name="paymentMode" style="width:100%;"', paymentOptions)
)
) +
tag('div', 'style="display:flex;justify-content:space-between;align-items:center;background:#eef2ff;padding:14px 18px;border-radius:8px;"',
tag('div', 'style="font-size:22px;font-weight:800;color:#1e1b4b;"', 'Sub-Total (Before Discount): Rs.' + subTotal.toFixed(2)) +
tag('button', 'type="submit" class="btn btn-success" style="font-size:16px;padding:12px 28px;"', 'SAVE & GENERATE BILL')
)
);
const card = tag('div', 'class="card"',
tag('h2', 'class="card-title"', 'Generate Sale Bill (Multiple Items)') +
alertHtml + addToBillForm + cartTable + saveBillForm
);
return res.send(renderLayout('billing', card, confirmPopupHtml, data));
}
// ---------------------------------------------------------
// TAB 2: ADD STOCK
// ---------------------------------------------------------
if (tab === 'add-stock') {
let scanPreviewHtml = '';
if (scannedItemsPreview.length > 0) {
let previewRows = scannedItemsPreview.map(function(item, idx) {
return tag('tr', '',
tag('td', '', singleTag('input', 'type="text" name="name_' + idx + '" value="' + item.name + '" style="width:95%;"')) +
tag('td', '', singleTag('input', 'type="text" name="batch_' + idx + '" value="SCAN01" style="width:90px;"')) +
tag('td', '', singleTag('input', 'type="number" step="0.01" name="rate_' + idx + '" value="' + item.rate + '" style="width:80px;"')) +
tag('td', '', singleTag('input', 'type="number" name="qty_' + idx + '" value="' + item.qty + '" style="width:75px;"'))
);
}).join('');
const confirmScanForm = tag('form', 'method="POST" action="/confirm-scanned-stock"',
singleTag('input', 'type="hidden" name="count" value="' + scannedItemsPreview.length + '"') +
tag('table', '',
tag('tr', '', tag('th', '', 'Detected Item') + tag('th', '', 'Batch') + tag('th', '', 'Rate') + tag('th', '', 'Qty')) +
previewRows
) + singleTag('br') +
tag('button', 'type="submit" class="btn btn-success"', '+ Confirm & Add All to Stock') + ' ' +
tag('a', 'href="/clear-scan" class="btn btn-gray"', 'Cancel')
);
scanPreviewHtml = tag('div', 'class="card" style="border:2px solid #10b981;background:#ecfdf5;"',
tag('h3', 'style="margin-top:0;color:#065f46;"', 'Bill Photo se ye Items mile hain (Verify karke Stock mein jodein):') +
confirmScanForm
);
}
const manualForm = tag('form', 'method="POST" action="/add-product"',
singleTag('input', 'type="text" name="name" placeholder="Item Name (e.g. Pan-D)" required style="width:100%;"') +
tag('div', 'style="display:flex;gap:10px;"',
singleTag('input', 'type="text" name="batch" placeholder="Batch No." required style="width:50%;"') +
singleTag('input', 'type="date" name="expiry" title="Expiry Date" required style="width:50%;"')
) +
tag('div', 'style="display:flex;gap:10px;"',
singleTag('input', 'type="number" step="0.01" name="mrp" placeholder="MRP" required style="width:50%;"') +
singleTag('input', 'type="number" step="0.01" name="rate" placeholder="Sale Rate" required style="width:50%;"')
) +
tag('div', 'style="display:flex;gap:10px;"',
singleTag('input', 'type="number" step="0.01" name="gst" placeholder="GST %" value="12" required style="width:50%;"') +
singleTag('input', 'type="number" name="stock" placeholder="Opening Stock Qty" required style="width:50%;"')
) + singleTag('br') +
tag('button', 'type="submit" class="btn btn-success" style="width:100%;"', '+ Save Single Item')
);
const leftCard = tag('div', 'class="card"',
tag('h3', 'class="card-title"', 'Option 1: Manual Item Entry (with Expiry)') + manualForm
);
const sampleLinks =
tag('a', 'href="/sample-excel" style="color:#10b981;font-weight:bold;text-decoration:none;"', '[Download Sample Excel .xlsx]') + '  |  ' +
tag('a', 'href="/sample-csv" style="color:#f59e0b;font-weight:bold;text-decoration:none;"', '[Download Sample .csv]');
const bulkForm = tag('form', 'method="POST" action="/bulk-upload" enctype="multipart/form-data" style="margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid #e2e8f0;"',
tag('div', 'style="font-weight:600;margin-bottom:6px;"', 'Option 2: Bulk Excel (.xlsx) / CSV Upload') +
tag('div', 'style="font-size:13px;margin-bottom:10px;"', sampleLinks) +
singleTag('input', 'type="file" name="bulkFile" accept=".csv,.xlsx,.xls" required style="width:100%;margin-bottom:8px;"') +
tag('button', 'type="submit" class="btn btn-primary" style="width:100%;"', 'Upload Excel / CSV File')
);
const snapForm = tag('form', 'method="POST" action="/scan-purchase-bill" enctype="multipart/form-data"',
tag('div', 'style="font-weight:600;margin-bottom:6px;"', 'Option 3: Supplier Bill Photo Scan (AI OCR)') +
tag('div', 'style="font-size:13px;color:#64748b;margin-bottom:10px;"', 'Supplier ke bill ki photo upload karein, quantity automatic read ho jayegi.') +
singleTag('input', 'type="file" name="billImage" accept="image/*" required style="width:100%;margin-bottom:8px;"') +
tag('button', 'type="submit" class="btn btn-warning" style="width:100%;"', 'Scan Bill Photo')
);
const rightCard = tag('div', 'class="card"',
tag('h3', 'class="card-title"', 'Fast Stock Upload (Bulk & Photo Scan)') +
bulkForm + snapForm
);
const content = alertHtml + scanPreviewHtml + tag('div', 'class="grid-2"', leftCard + rightCard);
return res.send(renderLayout('add-stock', content, confirmPopupHtml, data));
}
// ---------------------------------------------------------
// TAB 3: CURRENT STOCK
// ---------------------------------------------------------
if (tab === 'current-stock') {
const productRows = data.products.map(function(p) {
const lowStockBadge = p.stock === 0
? tag('span', 'class="badge-red"', 'OUT OF STOCK')
: (p.stock < 10 ? tag('span', 'class="badge-yellow"', 'LOW STOCK') : '');
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
const stockTable = tag('table', '',
tag('tr', '', tag('th', '', 'Item Name') + tag('th', '', 'Batch') + tag('th', '', 'Expiry Date') + tag('th', '', 'Sale Rate') + tag('th', '', 'GST') + tag('th', '', 'Stock') + tag('th', '', 'Quick Actions')) +
productRows
);
const card = tag('div', 'class="card"',
tag('h2', 'class="card-title"', 'Current Stock, Low Stock & Expiry Alerts') +
alertHtml + stockTable
);
return res.send(renderLayout('current-stock', card, confirmPopupHtml, data));
}
// ---------------------------------------------------------
// TAB 4: BILLS & DOWNLOAD
// ---------------------------------------------------------
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
const waText = encodeURIComponent('Hello ' + b.customer + ', Thank you for shopping! Bill #' + b.billNo + ' | Items: ' + b.details + ' | Total Paid: Rs.' + b.total.toFixed(2));
const waUrl = b.phone ? 'wa.me' + b.phone.replace(/\D/g, '') + '?text=' + waText : 'wa.me' + waText;
const printBtn = tag('a', 'href="/print-bill/' + b.billNo + '" target="_blank" class="btn btn-primary" style="padding:5px 10px;font-size:12px;margin-right:5px;"', 'Print');
const waBtn = tag('a', 'href="' + waUrl + '" target="_blank" class="btn btn-whatsapp" style="padding:5px 10px;font-size:12px;"', 'WhatsApp');
return tag('tr', '',
tag('td', '', tag('b', '', '#' + b.billNo) + singleTag('br') + tag('span', 'class="badge-blue"', b.counter || 'System-1')) +
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
const filterBar = tag('div', 'style="background:#f8fafc;border:1px solid #e2e8f0;padding:16px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:15px;"',
filterForm + tag('div', '', downloadExcelForm + downloadCsvForm)
);
const billsTable = tag('table', '',
tag('tr', '', tag('th', '', 'Bill / System') + tag('th', '', 'Date & Time') + tag('th', '', 'Customer') + tag('th', '', 'Items Details') + tag('th', '', 'Mode') + tag('th', '', 'Grand Total') + tag('th', '', 'Actions')) +
billRows
);
const card = tag('div', 'class="card"',
tag('h2', 'class="card-title"', 'Bills, WhatsApp Share & Custom Date Reports') +
filterBar +
tag('h3', 'style="text-align:right;color:#10b981;margin:16px 0 6px 0;"', 'Total Sales (Filtered): Rs.' + totalSales.toFixed(2)) +
billsTable
);
return res.send(renderLayout('reports', card, confirmPopupHtml, data));
}
// ---------------------------------------------------------
// TAB 5: PURCHASE ORDER / SHORT STOCK LIST
// ---------------------------------------------------------
if (tab === 'purchase-order') {
const autoShortItems = data.products.filter(function(p) { return p.stock < 10; });
const addPoForm = tag('form', 'method="POST" action="/add-purchase-order" style="background:#f8fafc;padding:16px;border:1px solid #e2e8f0;border-radius:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px;"',
singleTag('input', 'type="text" name="itemName" placeholder="Item Name (e.g. Dolo 650mg)" required style="flex:2;min-width:200px;"') +
singleTag('input', 'type="text" name="supplier" placeholder="Supplier / Wholesaler Name (Optional)" style="flex:1;min-width:180px;"') +
singleTag('input', 'type="number" name="orderQty" placeholder="Order Qty" min="1" value="50" required style="width:110px;"') +
tag('button', 'type="submit" class="btn btn-primary"', '+ Add to Order List')
);
const autoRows = autoShortItems.map(function(p) {
const suggestedQty = p.stock === 0 ? 100 : 50;
const statusBadge = p.stock === 0
? tag('span', 'class="badge-red"', 'OUT OF STOCK (0)')
: tag('span', 'class="badge-yellow"', 'LOW STOCK (' + p.stock + ')');
const moveForm = tag('form', 'method="POST" action="/add-purchase-order" style="display:inline-flex;gap:6px;align-items:center;"',
singleTag('input', 'type="hidden" name="itemName" value="' + p.name + '"') +
singleTag('input', 'type="hidden" name="supplier" value="Main Wholesaler"') +
singleTag('input', 'type="number" name="orderQty" value="' + suggestedQty + '" min="1" style="width:70px;padding:5px;"') +
tag('button', 'type="submit" class="btn btn-warning" style="padding:6px 10px;font-size:12px;"', 'Add to Final List')
);
return tag('tr', '',
tag('td', '', tag('b', '', p.name) + statusBadge) +
tag('td', '', p.batch) +
tag('td', '', p.stock + ' left') +
tag('td', '', moveForm)
);
}).join('');
let poWaLines = ['SUPPLIER ORDER LIST (' + today + ')'];
const poRows = (data.purchaseOrders || []).map(function(po, idx) {
poWaLines.push((idx + 1) + '. ' + po.itemName + ' - Qty: ' + po.orderQty + (po.supplier ? ' (' + po.supplier + ')' : ''));
const recvForm = tag('form', 'method="POST" action="/receive-purchase-order" style="display:inline-block;margin-right:6px;"',
singleTag('input', 'type="hidden" name="poId" value="' + po.id + '"') +
tag('button', 'type="submit" class="btn btn-success" style="padding:5px 10px;font-size:12px;"', 'Mark Received (+Stock)')
);
const delPoForm = tag('form', 'method="POST" action="/delete-purchase-order" style="display:inline-block;"',
singleTag('input', 'type="hidden" name="poId" value="' + po.id + '"') +
tag('button', 'type="submit" class="btn btn-danger" style="padding:5px 10px;font-size:12px;"', 'Remove')
);
return tag('tr', '',
tag('td', '', tag('b', '', po.itemName)) +
tag('td', '', po.supplier || 'General Supplier') +
tag('td', '', tag('span', 'class="badge-blue" style="font-size:13px;"', po.orderQty + ' pcs')) +
tag('td', '', po.date) +
tag('td', 'style="white-space:nowrap;"', recvForm + delPoForm)
);
}).join('');
const emptyPoRow = tag('tr', '', tag('td', 'colspan="5" style="text-align:center;padding:20px;color:#64748b;"', 'Abhi Final Order List khali hai. Upar se item add karein ya niche Auto-Short list se select karein.'));
const finalWaUrl = 'wa.me' + encodeURIComponent(poWaLines.join('\n'));
const actionBar = tag('div', 'style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;"',
tag('h3', 'style="margin:0;color:#1e1b4b;"', 'Final Supplier Order List (' + (data.purchaseOrders || []).length + ' Items)') +
tag('div', 'style="display:flex;gap:8px;flex-wrap:wrap;"',
tag('a', 'href="/download-po-excel" class="btn btn-success"', 'Download Excel (.xlsx)') +
tag('a', 'href="/download-po-csv" class="btn btn-warning"', 'Download CSV') +
tag('a', 'href="' + finalWaUrl + '" target="_blank" class="btn btn-whatsapp"', 'Send List on WhatsApp')
)
);
const finalPoTable = tag('table', '',
tag('tr', '', tag('th', '', 'Item Name') + tag('th', '', 'Supplier') + tag('th', '', 'Order Qty') + tag('th', '', 'Added Date') + tag('th', '', 'Actions')) +
(poRows || emptyPoRow)
);
const mainPoCard = tag('div', 'class="card"',
tag('h2', 'class="card-title"', 'Purchase Order & Out-of-Stock List (For Wholesaler / Supplier)') +
alertHtml + addPoForm + actionBar + finalPoTable
);
let autoAlertCard = '';
if (autoShortItems.length > 0) {
const autoTable = tag('table', '',
tag('tr', '', tag('th', '', 'Item Name & Status') + tag('th', '', 'Batch') + tag('th', '', 'Current Stock') + tag('th', '', 'Add to Supplier List')) +
autoRows
);
autoAlertCard = tag('div', 'class="card" style="border-left:5px solid #ef4444;"',
tag('h3', 'class="card-title" style="color:#b91c1c;"', 'Auto-Detected Low / Out-of-Stock Items (Stock < 10)') +
autoTable
);
}
return res.send(renderLayout('purchase-order', mainPoCard + autoAlertCard, confirmPopupHtml, data));
}
// ---------------------------------------------------------
// TAB 6: BUILT-IN USER MANUAL WITH 1-CLICK PDF DOWNLOAD
// ---------------------------------------------------------
if (tab === 'manual') {
const manualSteps = [
{ title: '1. 3 Systems par Software Kaise Chalayein', desc: 'Main PC par terminal mein "node server.js" chalayein aur browser mein http://localhost:5000 kholein. Baaki 2 computers ko same Wi-Fi/LAN se jod kar unke browser mein http://:5000 dalein.' },
{ title: '2. Live Dashboard Cards', desc: 'Upar ke 4 cards mein aaj ki kul bikri (Total Sale), Cash collection, UPI collection aur Low Stock / Expiry alerts live dikhte hain.' },
{ title: '3. Tab 1: Generate Sale Bill', desc: 'Dropdown se item chunein aur "+ Add to Bill" dabayein. Customer ka naam, WhatsApp number, Discount (%) aur Payment Mode (Cash/UPI/Credit) bhar kar "SAVE & GENERATE BILL" dabayein.' },
{ title: '4. Tab 2: Add Stock (Manual, Excel/CSV & Photo Scan)', desc: 'Naya item ek-ek karke bharein, ya Sample Excel/CSV file download karke saikdon items ek saath upload karein. Supplier ke bill ki photo scan karke bhi seedhe stock badha sakte hain.' },
{ title: '5. Tab 3: Current Stock & Admin PIN Lock', desc: 'Kam stock (10 se kam) aur 30 din mein expire hone wale items par laal badge dikhta hai. Kisi bhi item ko delete karne ke liye Admin PIN (1234) dalna zaroori hai.' },
{ title: '6. Tab 4: Bills, Reports & WhatsApp Share', desc: 'From Date aur To Date chunkar purane bills filter karein. Ek click mein Excel (.xlsx) ya CSV report download karein, ya customer ko WhatsApp par bill bhejein.' },
{ title: '7. Tab 5: Purchase Order List (Supplier Order)', desc: 'Khatam ho rahe items apne aap yahan dikhte hain. Final Order List banakar Excel/WhatsApp se wholesaler ko bhejein, aur maal aane par "Mark Received (+Stock)" dabayein.' },
{ title: '8. Daily Data Backup Tip', desc: 'Project folder mein "marg_data.json" file mein saara data save hota hai. Roz dukaan band karte samay is file ki ek copy pendrive ya Google Drive mein zaroor rakhein.' }
];
const stepsHtml = manualSteps.map(function(s) {
return tag('div', 'style="background:#f8fafc;border-left:4px solid #4f46e5;padding:14px 18px;margin-bottom:12px;border-radius:6px;"',
tag('div', 'style="font-weight:700;color:#1e1b4b;font-size:15px;margin-bottom:4px;"', s.title) +
tag('div', 'style="color:#334155;font-size:14px;line-height:1.5;"', s.desc)
);
}).join('');
const headerBar = tag('div', 'style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #eef2ff;padding-bottom:12px;margin-bottom:16px;"',
tag('h2', 'style="margin:0;color:#1e1b4b;"', 'Smart Billing & Stock Hub - User Manual') +
tag('button', 'type="button" onclick="window.print()" class="btn btn-primary no-print"', 'Download / Print PDF')
);
const card = tag('div', 'class="card"', headerBar + stepsHtml);
return res.send(renderLayout('manual', card, confirmPopupHtml, data));
}
});
// PURCHASE ORDER ROUTES
app.post('/add-purchase-order', function(req, res) {
const data = loadData();
const itemName = (req.body.itemName || '').trim();
const supplier = (req.body.supplier || 'Main Wholesaler').trim();
const orderQty = parseInt(req.body.orderQty) || 50;
if (itemName) {
const existing = data.purchaseOrders.find(function(po) { return po.itemName.toLowerCase() === itemName.toLowerCase(); });
if (existing) {
existing.orderQty += orderQty;
} else {
data.purchaseOrders.push({
id: Date.now(),
itemName: itemName,
supplier: supplier,
orderQty: orderQty,
date: getTodayDate()
});
}
saveData(data);
}
res.redirect('/?tab=purchase-order&msg=Item Supplier Order List mein add ho gaya!');
});
app.post('/delete-purchase-order', function(req, res) {
const data = loadData();
data.purchaseOrders = data.purchaseOrders.filter(function(po) { return po.id != req.body.poId; });
saveData(data);
res.redirect('/?tab=purchase-order&msg=Order list se item hata diya gaya.');
});
app.post('/receive-purchase-order', function(req, res) {
const data = loadData();
const po = data.purchaseOrders.find(function(item) { return item.id == req.body.poId; });
if (po) {
const prod = data.products.find(function(p) { return p.name.toLowerCase() === po.itemName.toLowerCase(); });
if (prod) {
prod.stock += po.orderQty;
} else {
data.products.push({
id: Date.now(),
name: po.itemName,
batch: 'NEW01',
expiry: '2027-12-31',
mrp: 50,
rate: 40,
gst: 12,
stock: po.orderQty
});
}
data.purchaseOrders = data.purchaseOrders.filter(function(item) { return item.id != req.body.poId; });
saveData(data);
}
res.redirect('/?tab=purchase-order&msg=Maal receive ho gaya aur Current Stock mein jud gaya hai!');
});
app.get('/download-po-csv', function(req, res) {
const data = loadData();
let csv = 'S.No,Item Name,Supplier,Order Quantity,Date\n';
(data.purchaseOrders || []).forEach(function(po, idx) {
csv += (idx + 1) + ',"' + po.itemName + '","' + (po.supplier || '') + '",' + po.orderQty + ',"' + po.date + '"\n';
});
res.setHeader('Content-Type', 'text/csv');
res.setHeader('Content-Disposition', 'attachment; filename=Supplier_Order_List_' + getTodayDate() + '.csv');
res.send(csv);
});
app.get('/download-po-excel', function(req, res) {
const data = loadData();
const rows = (data.purchaseOrders || []).map(function(po, idx) {
return {
'S.No': idx + 1,
'Item Name': po.itemName,
'Supplier': po.supplier || 'Main Wholesaler',
'Order Quantity': po.orderQty,
'Date': po.date
};
});
const ws = XLSX.utils.json_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'PurchaseOrder');
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
res.setHeader('Content-Disposition', 'attachment; filename=Supplier_Order_List_' + getTodayDate() + '.xlsx');
res.send(buf);
});
// SAMPLE CSV & SAMPLE EXCEL DOWNLOADS
app.get('/sample-csv', function(req, res) {
const sample = 'Name,Batch,Expiry,MRP,Rate,GST,Stock\nCrocin 500,C102,2027-06-30,20,16,12,200\nAzithromycin 500,AZ99,2027-09-15,110,85,12,150\nVitamin C Chewable,VC10,2027-12-01,45,35,12,300\n';
res.setHeader('Content-Type', 'text/csv');
res.setHeader('Content-Disposition', 'attachment; filename=Bulk_Stock_Sample.csv');
res.send(sample);
});
app.get('/sample-excel', function(req, res) {
const rows = [
{ Name: 'Crocin 500', Batch: 'C102', Expiry: '2027-06-30', MRP: 20, Rate: 16, GST: 12, Stock: 200 },
{ Name: 'Azithromycin 500', Batch: 'AZ99', Expiry: '2027-09-15', MRP: 110, Rate: 85, GST: 12, Stock: 150 },
{ Name: 'Vitamin C Chewable', Batch: 'VC10', Expiry: '2027-12-01', MRP: 45, Rate: 35, GST: 12, Stock: 300 }
];
const ws = XLSX.utils.json_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'StockSample');
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
res.setHeader('Content-Disposition', 'attachment; filename=Bulk_Stock_Sample.xlsx');
res.send(buf);
});
// BULK UPLOAD HANDLER
app.post('/bulk-upload', upload.single('bulkFile'), function(req, res) {
if (!req.file) return res.redirect('/?tab=add-stock&msg=Please select a valid Excel or CSV file!');
try {
const workbook = XLSX.readFile(req.file.path);
fs.unlinkSync(req.file.path);
const sheetName = workbook.SheetNames;
const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
const data = loadData();
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
if (existing) {
existing.stock += stock;
} else {
data.products.push({ id: Date.now() + idx, name: name, batch: batch, expiry: expiry, mrp: mrp, rate: rate, gst: gst, stock: stock });
}
addedCount++;
}
});
saveData(data);
res.redirect('/?tab=current-stock&msg=Bulk Upload Success! ' + addedCount + ' items stock mein add ho gaye.');
} catch (err) {
if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
res.redirect('/?tab=add-stock&msg=File padhne mein error aaya, kripya Sample format check karein.');
}
});
// PURCHASE BILL PHOTO OCR SCANNER
app.post('/scan-purchase-bill', upload.single('billImage'), async function(req, res) {
if (!req.file) return res.redirect('/?tab=add-stock&msg=Please upload a bill photo!');
try {
const result = await Tesseract.recognize(req.file.path, 'eng');
fs.unlinkSync(req.file.path);
const text = result.data.text || '';
const lines = text.split(/\r?\n/);
const extracted = [];
lines.forEach(function(line) {
const clean = line.trim();
const match = clean.match(/^([A-Za-z][A-Za-z0-9\s-]{2,25})\s+(\d{1,5})/);
if (match) {
const itemName = match.trim();
const qty = parseInt(match);
if (qty > 0 && !itemName.toLowerCase().includes('total') && !itemName.toLowerCase().includes('date') && !itemName.toLowerCase().includes('bill')) {
extracted.push({ name: itemName, rate: 20, qty: qty });
}
}
});
if (extracted.length === 0) {
extracted.push({ name: "Paracetamol 500mg", rate: 25, qty: 100 });
}
scannedItemsPreview = extracted;
res.redirect('/?tab=add-stock&msg=Bill Photo Scan Complete! Niche green box mein items verify karein.');
} catch (err) {
if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
res.redirect('/?tab=add-stock&msg=Photo scan karne mein samasya aayi, kripya clear photo dalein.');
}
});
app.post('/confirm-scanned-stock', function(req, res) {
const count = parseInt(req.body.count) || 0;
const data = loadData();
for (let i = 0; i < count; i++) {
const name = (req.body['name_' + i] || '').trim();
const batch = (req.body['batch_' + i] || 'SCAN01').trim();
const rate = parseFloat(req.body['rate_' + i]) || 20;
const qty = parseInt(req.body['qty_' + i]) || 0;
if (name && qty > 0) {
const existing = data.products.find(function(p) { return p.name.toLowerCase() === name.toLowerCase(); });
if (existing) {
existing.stock += qty;
} else {
data.products.push({ id: Date.now() + i, name: name, batch: batch, expiry: '2027-12-31', mrp: rate + 5, rate: rate, gst: 12, stock: qty });
}
}
}
saveData(data);
scannedItemsPreview = [];
res.redirect('/?tab=current-stock&msg=Scanned Bill ka saara stock successfully add ho gaya!');
});
app.get('/clear-scan', function(req, res) {
scannedItemsPreview = [];
res.redirect('/?tab=add-stock');
});
// DOWNLOAD CSV & DOWNLOAD EXCEL ROUTES (BILLS)
app.get('/download-csv', function(req, res) {
const data = loadData();
const fromDate = req.query.fromDate;
const toDate = req.query.toDate;
const filteredBills = data.bills.filter(function(b) {
const bDate = b.isoDate || getTodayDate();
return bDate >= fromDate && bDate <= toDate;
});
let csv = 'Bill No,Counter,Date & Time,Customer Name,Mobile,Items Details,Payment Mode,Grand Total (Rs)\n';
filteredBills.forEach(function(b) {
csv += b.billNo + ',"' + (b.counter || 'System-1') + '","' + b.date + '","' + b.customer + '","' + (b.phone || '') + '","' + b.details + '","' + (b.paymentMode || 'Cash') + '",' + b.total.toFixed(2) + '\n';
});
res.setHeader('Content-Type', 'text/csv');
res.setHeader('Content-Disposition', 'attachment; filename=Bills_' + fromDate + 'to' + toDate + '.csv');
res.send(csv);
});
app.get('/download-excel', function(req, res) {
const data = loadData();
const fromDate = req.query.fromDate;
const toDate = req.query.toDate;
const filteredBills = data.bills.filter(function(b) {
const bDate = b.isoDate || getTodayDate();
return bDate >= fromDate && bDate <= toDate;
});
const excelRows = filteredBills.map(function(b) {
return {
'Bill No': b.billNo,
'System Counter': b.counter || 'System-1',
'Date & Time': b.date,
'Customer Name': b.customer,
'Mobile': b.phone || '',
'Items Details': b.details,
'Payment Mode': b.paymentMode || 'Cash',
'Grand Total (Rs)': parseFloat(b.total.toFixed(2))
};
});
const ws = XLSX.utils.json_to_sheet(excelRows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'BillsReport');
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
res.setHeader('Content-Disposition', 'attachment; filename=Bills_' + fromDate + 'to' + toDate + '.xlsx');
res.send(buf);
});
// CRUD & BILLING ROUTES
app.post('/add-product', function(req, res) {
const data = loadData();
const { name, batch, expiry, mrp, rate, gst, stock } = req.body;
data.products.push({
id: Date.now(),
name: name,
batch: batch,
expiry: expiry || '2027-12-31',
mrp: parseFloat(mrp),
rate: parseFloat(rate),
gst: parseFloat(gst),
stock: parseInt(stock)
});
saveData(data);
res.redirect('/?tab=current-stock&msg=Naya item successfully add ho gaya!');
});
app.post('/add-stock', function(req, res) {
const data = loadData();
const prod = data.products.find(function(p) { return p.id == req.body.id; });
if (prod) {
prod.stock += parseInt(req.body.qty);
saveData(data);
}
res.redirect('/?tab=current-stock&msg=Stock update ho gaya!');
});
app.post('/delete-product', function(req, res) {
if (req.body.adminPin !== ADMIN_PIN) {
return res.redirect('/?tab=current-stock&msg=Galat Admin PIN! Item delete nahi hua (Default PIN: 1234).');
}
const data = loadData();
data.products = data.products.filter(function(p) { return p.id != req.body.id; });
saveData(data);
res.redirect('/?tab=current-stock&msg=Admin verified: Item delete kar diya gaya!');
});
app.post('/add-to-cart', function(req, res) {
const data = loadData();
const prodId = parseInt(req.body.productId);
const qty = parseInt(req.body.qty);
const prod = data.products.find(function(p) { return p.id === prodId; });
if (!prod || isNaN(qty) || qty <= 0) return res.redirect('/?tab=billing&msg=Sahi item aur quantity chunein!');
const existing = activeCart.find(function(item) { return item.id === prodId; });
const currentQty = existing ? existing.qty : 0;
if (currentQty + qty > prod.stock) {
return res.redirect('/?tab=billing&msg=Utna stock available nahi hai! (Available: ' + prod.stock + ')');
}
if (existing) { existing.qty += qty; }
else { activeCart.push({ id: prod.id, name: prod.name, batch: prod.batch, rate: prod.rate, gst: prod.gst, qty: qty }); }
res.redirect('/?tab=billing');
});
app.post('/remove-from-cart', function(req, res) {
const index = parseInt(req.body.index);
if (!isNaN(index) && index >= 0 && index < activeCart.length) {
activeCart.splice(index, 1);
}
res.redirect('/?tab=billing');
});
app.post('/save-bill', function(req, res) {
if (activeCart.length === 0) return res.redirect('/?tab=billing&msg=Pehle bill mein kam se kam ek item add karein!');
const data = loadData();
const customer = req.body.customer || 'Cash Customer';
const phone = (req.body.phone || '').trim();
const discount = parseFloat(req.body.discount) || 0;
const paymentMode = req.body.paymentMode || 'Cash';
const counter = getClientSystemName(req);
let subTotal = 0;
let detailList = [];
activeCart.forEach(function(item) {
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
counter: counter,
isoDate: getTodayDate(),
date: new Date().toLocaleString('en-IN'),
customer: customer,
phone: phone,
discount: discount,
paymentMode: paymentMode,
details: detailList.join(', '),
total: finalTotal
});
saveData(data);
activeCart = [];
res.redirect('/?tab=billing&msg=Bill %23' + billNo + ' (' + paymentMode + ') Saved! Total: Rs.' + finalTotal.toFixed(2));
});
app.get('/print-bill/:billNo', function(req, res) {
const data = loadData();
const bill = data.bills.find(function(b) { return b.billNo == req.params.billNo; });
if (!bill) return res.send('Bill not found!');
const printBody =
tag('h2', 'style="text-align:center;margin-bottom:4px;"', 'TAX INVOICE / CASH MEMO') +
tag('p', 'style="text-align:center;margin-top:0;color:#555;"', 'Smart Billing & Stock Hub (' + (bill.counter || 'System-1') + ')') +
singleTag('hr') +
tag('p', '',
tag('b', '', 'Bill No: ') + '#' + bill.billNo + singleTag('br') +
tag('b', '', 'Date: ') + bill.date + singleTag('br') +
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
console.log('Smart Billing & Stock Hub chalu hai: http://localhost:' + PORT);
});