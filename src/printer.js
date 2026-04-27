// printer.js — Windows Native Printing (no native .node modules)
// Uses PowerShell + Win32 winspool.drv to send raw ESC/POS bytes to any
// Windows-registered printer (USB, network, virtual, etc.)

const { execSync, spawn }  = require('child_process');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const logger        = require('./logger');

// ─── Settings: persist the selected printer ────────────────────────────────────
function getSettingsPath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'printer-settings.json');
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8')); }
  catch { return {}; }
}

function saveSettings(settings) {
  try { fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2)); }
  catch (err) { logger.error('Failed to save settings:', err.message); }
}

function getSelectedPrinter() {
  return loadSettings().selectedPrinter || null;
}

function setSelectedPrinter(name) {
  const settings = loadSettings();
  settings.selectedPrinter = name;
  saveSettings(settings);
  logger.info(`Printer selection saved: "${name}"`);
}

// ─── List all Windows printers (friendly names) ────────────────────────────────
let printerCache = { list: [], ts: 0 };
const CACHE_TTL = 30000; // 30 seconds

function listWindowsPrinters() {
  try {
    if (Date.now() - printerCache.ts < CACHE_TTL) return printerCache.list;
    const out = execSync(
      'powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"',
      { timeout: 8000, encoding: 'utf-8' }
    );
    const list = out.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    printerCache = { list, ts: Date.now() };
    return list;
  } catch (err) {
    logger.error('listWindowsPrinters failed:', err.message);
    return [];
  }
}

// ─── Check if selected printer is available ────────────────────────────────────
async function checkPrinterStatus() {
  try {
    const selected  = getSelectedPrinter();
    const available = listWindowsPrinters();
    if (selected) return available.includes(selected);
    return available.length > 0;
  } catch { return false; }
}

// ─── Config ────────────────────────────────────────────────────────────────────
const SHOP_NAME    = 'St Xavier Oils';
const SHOP_ADDRESS = 'Your Address Here';
const SHOP_PHONE   = 'Phone: +91-XXXXXXXXXX';
const SHOP_GST     = '';           // e.g. 'GSTIN: 29XXXXX'
const PAPER_WIDTH  = 48;          // characters per line on 80mm paper
const CURRENCY     = 'Rs.';       // ASCII-safe (₹ not in CP437)

// ─── Formatting Helpers ────────────────────────────────────────────────────────
function rep(ch, n) { return ch.repeat(Math.max(0, n)); }

function lineItem(label, value, width) {
  const val = String(value);
  const room = width - val.length;
  const lbl  = label.length > room - 1 ? label.slice(0, room - 2) + '~' : label;
  return lbl + rep(' ', room - lbl.length) + val;
}

function fmtCurrency(amount) {
  return `${CURRENCY}${parseFloat(amount || 0).toFixed(2)}`;
}

function fmtDate(d) {
  d = d ? new Date(d) : new Date();
  const z = n => String(n).padStart(2, '0');
  return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()}  ${z(d.getHours())}:${z(d.getMinutes())}`;
}

// ─── Pure-JS ESC/POS document builder (no external library) ───────────────────
const ESC = 0x1B;
const GS  = 0x1D;
const LF  = 0x0A;

function encodeText(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 128) bytes.push(c);
    else bytes.push(0x3F); // '?' fallback for chars outside ASCII
  }
  return bytes;
}

class EscPos {
  constructor() { this.buf = []; }

  init()          { this.buf.push(ESC, 0x40);        return this; }
  left()          { this.buf.push(ESC, 0x61, 0);     return this; }
  center()        { this.buf.push(ESC, 0x61, 1);     return this; }
  right()         { this.buf.push(ESC, 0x61, 2);     return this; }
  boldOn()        { this.buf.push(ESC, 0x45, 1);     return this; }
  boldOff()       { this.buf.push(ESC, 0x45, 0);     return this; }
  doubleOn()      { this.buf.push(GS,  0x21, 0x11);  return this; } // 2× width+height
  doubleOff()     { this.buf.push(GS,  0x21, 0x00);  return this; }
  lf()            { this.buf.push(LF);               return this; }
  text(s)         { this.buf.push(...encodeText(s));  return this; }
  line(s)         { return this.text(s).lf(); }

  cut() {
    // Feed a few lines then full cut
    this.buf.push(LF, LF, LF, GS, 0x56, 0x41, 0x00);
    return this;
  }

  cashDrawer() {
    // ESC p 0 <on-time> <off-time> — pin 2 pulse
    this.buf.push(ESC, 0x70, 0x00, 0x3C, 0x78);
    return this;
  }

  toBuffer() { return Buffer.from(this.buf); }
}

// ─── Build receipt ESC/POS buffer ─────────────────────────────────────────────
function buildReceiptBuffer(data) {
  const doc  = new EscPos();
  const sep  = rep('-', PAPER_WIDTH);
  const sep2 = rep('=', PAPER_WIDTH);

  const shopName   = data.shopName       || SHOP_NAME;
  const invoiceNo  = data.invoiceNo      || `INV-${Date.now()}`;
  const cashier    = data.cashier        || '';
  const items      = data.items          || [];
  const subtotal   = data.subtotal       !== undefined ? data.subtotal : data.total;
  const discount   = data.discount       || 0;
  const tax        = data.tax            || 0;
  const total      = data.total          || 0;
  const payMethod  = data.paymentMethod  || 'CASH';
  const amountPaid = data.amountPaid     || total;
  const change     = data.change         !== undefined ? data.change : (amountPaid - total);
  const note       = data.note           || '';

  // ── Header ──
  doc.init()
     .center().boldOn().doubleOn()
     .line(shopName)
     .doubleOff().boldOff();

  if (SHOP_ADDRESS) doc.line(SHOP_ADDRESS);
  if (SHOP_PHONE)   doc.line(SHOP_PHONE);
  if (SHOP_GST)     doc.line(SHOP_GST);

  doc.line(sep)
     .left()
     .line(`Invoice : ${invoiceNo}`)
     .line(`Date    : ${fmtDate(data.date)}`);

  if (cashier) doc.line(`Cashier : ${cashier}`);

  // ── Column headers ──
  doc.line(sep)
     .boldOn()
     .line('ITEM'.padEnd(24) + 'QTY'.padStart(6) + 'PRICE'.padStart(9) + 'AMT'.padStart(9))
     .boldOff()
     .line(sep);

  // ── Line items ──
  for (const item of items) {
    const qty   = parseFloat(item.qty   || item.quantity || 1);
    const price = parseFloat(item.price || item.rate     || 0);
    const amt   = parseFloat(item.amount || (qty * price));
    const name  = String(item.name || item.item || 'Item');

    if (name.length <= 24) {
      doc.line(
        name.padEnd(24) +
        String(qty).padStart(6) +
        fmtCurrency(price).padStart(9) +
        fmtCurrency(amt).padStart(9)
      );
    } else {
      doc.line(
        name.slice(0, 23).padEnd(24) +
        String(qty).padStart(6) +
        fmtCurrency(price).padStart(9) +
        fmtCurrency(amt).padStart(9)
      );
      let rest = name.slice(23);
      while (rest.length > 0) {
        doc.line('  ' + rest.slice(0, 46));
        rest = rest.slice(46);
      }
    }
  }

  doc.line(sep);

  // ── Totals ──
  doc.right().line(lineItem('Subtotal', fmtCurrency(subtotal), PAPER_WIDTH));
  if (discount > 0) doc.line(lineItem('Discount', `-${fmtCurrency(discount)}`, PAPER_WIDTH));
  if (tax > 0)      doc.line(lineItem('Tax/GST',  fmtCurrency(tax),            PAPER_WIDTH));

  doc.line(sep2)
     .boldOn().doubleOn()
     .line(lineItem('TOTAL', fmtCurrency(total), PAPER_WIDTH))
     .doubleOff().boldOff()
     .line(sep2)
     .line(lineItem('Payment', payMethod,              PAPER_WIDTH))
     .line(lineItem('Paid',    fmtCurrency(amountPaid), PAPER_WIDTH))
     .line(lineItem('Change',  fmtCurrency(change),    PAPER_WIDTH))
     .line(sep);

  // ── Note / Footer ──
  if (note) doc.center().line(note).line(sep);

  doc.center()
     .lf()
     .line('Thank you for your purchase!')
     .line('Visit us again')
     .lf().lf()
     .cut();

  return doc.toBuffer();
}

// ─── PowerShell raw-print script (inline, no external .ps1 file at rest) ──────
// Uses Win32 winspool.drv via P/Invoke — works with ANY Windows-registered printer
function buildPs1InMemory(printerName) {
  // Escape backslashes in paths for PowerShell double-quoted strings
  const pn = printerName.replace(/'/g, "''");

  return `
$ErrorActionPreference = 'Stop'

# Read all bytes from stdin (until EOF)
$stdin = [System.Console]::OpenStandardInput()
$ms = New-Object System.IO.MemoryStream
$stdin.CopyTo($ms)
$bytes = $ms.ToArray()

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RawPrint {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
    public class DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }
    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool StartDocPrinter(IntPtr h, int lv, [In,MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr h);
    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr h, IntPtr p, int c, out int w);
    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr h);
    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr h);
    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr h);
}
'@

if ($bytes.Length -eq 0) { exit 0 }

$h = [IntPtr]::Zero
if (-not [RawPrint]::OpenPrinter('${pn}', [ref]$h, [IntPtr]::Zero)) {
    throw "Cannot open printer '${pn}'. Check it is installed in Windows."
}
$di = New-Object RawPrint+DOCINFOA
$di.pDocName  = 'POS-Receipt'
$di.pDataType = 'RAW'
[RawPrint]::StartDocPrinter($h, 1, $di) | Out-Null
[RawPrint]::StartPagePrinter($h)        | Out-Null
$ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
$w = 0
[RawPrint]::WritePrinter($h, $ptr, $bytes.Length, [ref]$w) | Out-Null
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
[RawPrint]::EndPagePrinter($h)  | Out-Null
[RawPrint]::EndDocPrinter($h)   | Out-Null
[RawPrint]::ClosePrinter($h)    | Out-Null
`;
}

// ─── Send a buffer to a Windows printer via PowerShell ────────────────────────
function rawPrint(printerName, buffer) {
  const pn = printerName.replace(/'/g, "''");
  const ps1 = buildPs1InMemory(pn); // version that reads from stdin
  
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps1]);
    proc.stdin.write(buffer);
    proc.stdin.end();
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`PS exited ${code}`)));
  });
}

// ─── Public: Print Receipt ────────────────────────────────────────────────────
async function printReceipt(data) {
  const printerName = getSelectedPrinter();
  if (!printerName) {
    throw new Error('No printer selected. Open POS Bridge status window and select a printer.');
  }
  logger.info(`Print job → printer: "${printerName}"`);
  
  const buf = buildReceiptBuffer(data);
  
  // Append drawer pulse into the same buffer if needed
  if (data.openDrawer !== false) {
    const drawer = new EscPos();
    const combined = Buffer.concat([buf, drawer.init().cashDrawer().toBuffer()]);
    await rawPrint(printerName, combined);
  } else {
    await rawPrint(printerName, buf);
  }
  
  logger.info('Receipt sent to printer successfully.');
}

// ─── Public: Open Cash Drawer ─────────────────────────────────────────────────
async function openCashDrawer() {
  const printerName = getSelectedPrinter();
  if (!printerName) {
    throw new Error('No printer selected. Open POS Bridge status window and select a printer.');
  }
  logger.info(`Cash drawer → printer: "${printerName}"`);
  const doc = new EscPos();
  await rawPrint(printerName, doc.init().cashDrawer().toBuffer());
  logger.info('Cash drawer pulse sent.');
}

module.exports = {
  printReceipt,
  openCashDrawer,
  checkPrinterStatus,
  listWindowsPrinters,
  getSelectedPrinter,
  setSelectedPrinter,
};
