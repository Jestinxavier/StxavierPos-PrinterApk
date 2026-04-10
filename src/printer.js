// printer.js — ESC/POS Printer & Cash Drawer Integration

const logger = require('./logger');

// ─── Config ───────────────────────────────────────────────────────────────────
const SHOP_NAME    = 'St Xavier Oils';
const SHOP_ADDRESS = 'Your Address Here';
const SHOP_PHONE   = 'Phone: +91-XXXXXXXXXX';
const SHOP_GST     = '';                  // Set GST number if needed, e.g. 'GSTIN: 29XXXXX'
const PAPER_WIDTH  = 48;                  // characters per line on 80mm paper
const CURRENCY     = '₹';

// ─── Lazy-load escpos so Electron doesn't crash if module is missing ──────────
function loadEscpos() {
  try {
    const escpos = require('escpos');
    escpos.USB    = require('escpos-usb');
    escpos.Network = require('escpos-network');
    return escpos;
  } catch (err) {
    throw new Error(
      `escpos library not found. Run: npm install escpos escpos-usb escpos-network\n(${err.message})`
    );
  }
}

// ─── Get USB Device ───────────────────────────────────────────────────────────
function getUsbDevice(escpos) {
  const devices = escpos.USB.findPrinter();
  if (!devices || devices.length === 0) {
    throw new Error('No USB thermal printer found. Check USB connection and power.');
  }
  // Use first found device; pass vendorId/productId to target a specific printer
  return new escpos.USB(devices[0].deviceDescriptor.idVendor, devices[0].deviceDescriptor.idProduct);
}

// ─── Check Printer Status ─────────────────────────────────────────────────────
async function checkPrinterStatus() {
  return new Promise((resolve) => {
    try {
      const escpos  = loadEscpos();
      const devices = escpos.USB.findPrinter();
      resolve(Array.isArray(devices) && devices.length > 0);
    } catch {
      resolve(false);
    }
  });
}

// ─── Formatting Helpers ───────────────────────────────────────────────────────
function repeat(char, n) {
  return char.repeat(Math.max(0, n));
}

function center(text, width) {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return repeat(' ', pad) + text;
}

function lineItem(label, value, width) {
  const valStr = String(value);
  const labelWidth = width - valStr.length;
  const truncated = label.length > labelWidth - 1
    ? label.slice(0, labelWidth - 2) + '…'
    : label;
  return truncated + repeat(' ', labelWidth - truncated.length) + valStr;
}

function formatCurrency(amount) {
  return `${CURRENCY}${parseFloat(amount || 0).toFixed(2)}`;
}

function formatDate(d) {
  d = d ? new Date(d) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Print Receipt ────────────────────────────────────────────────────────────
function printReceipt(data) {
  return new Promise((resolve, reject) => {
    let escpos;
    try {
      escpos = loadEscpos();
    } catch (err) {
      return reject(err);
    }

    let device;
    try {
      device = getUsbDevice(escpos);
    } catch (err) {
      return reject(err);
    }

    const printer = new escpos.Printer(device);
    const sep     = repeat('─', PAPER_WIDTH);
    const sepDash = repeat('-', PAPER_WIDTH);

    const shopName    = data.shopName    || SHOP_NAME;
    const invoiceNo   = data.invoiceNo   || `INV-${Date.now()}`;
    const cashier     = data.cashier     || '';
    const items       = data.items       || [];
    const subtotal    = data.subtotal    !== undefined ? data.subtotal : data.total;
    const discount    = data.discount    || 0;
    const tax         = data.tax         || 0;
    const total       = data.total       || 0;
    const payMethod   = data.paymentMethod || 'CASH';
    const amountPaid  = data.amountPaid  || total;
    const change      = data.change      !== undefined ? data.change : (amountPaid - total);
    const note        = data.note        || '';

    device.open((err) => {
      if (err) {
        logger.error('Cannot open USB device:', err.message);
        return reject(new Error(`Cannot open printer: ${err.message}`));
      }

      try {
        printer
          // ── Header ──
          .align('ct')
          .style('b')
          .size(1, 1)
          .text(shopName)
          .style('normal')
          .size(0, 0);

        if (SHOP_ADDRESS) printer.text(SHOP_ADDRESS);
        if (SHOP_PHONE)   printer.text(SHOP_PHONE);
        if (SHOP_GST)     printer.text(SHOP_GST);

        printer
          .text(sep)

          // ── Invoice meta ──
          .align('lt')
          .text(`Invoice : ${invoiceNo}`)
          .text(`Date    : ${formatDate(data.date)}`)

        if (cashier) printer.text(`Cashier : ${cashier}`);

        printer
          .text(sep)

          // ── Column headers ──
          .style('b')
          .text(
            'ITEM'.padEnd(24) +
            'QTY'.padStart(6) +
            'PRICE'.padStart(9) +
            'AMT'.padStart(9)
          )
          .style('normal')
          .text(sepDash);

        // ── Line items ──
        for (const item of items) {
          const qty   = parseFloat(item.qty   || item.quantity || 1);
          const price = parseFloat(item.price || item.rate     || 0);
          const amt   = parseFloat(item.amount || (qty * price));
          const name  = String(item.name || item.item || 'Item');

          // Wrap long names
          if (name.length <= 24) {
            printer.text(
              name.padEnd(24) +
              String(qty).padStart(6) +
              formatCurrency(price).padStart(9) +
              formatCurrency(amt).padStart(9)
            );
          } else {
            // First line: name (truncated) + values
            printer.text(
              name.slice(0, 23).padEnd(24) +
              String(qty).padStart(6) +
              formatCurrency(price).padStart(9) +
              formatCurrency(amt).padStart(9)
            );
            // Continuation lines for long names
            let remaining = name.slice(23);
            while (remaining.length > 0) {
              printer.text('  ' + remaining.slice(0, 46));
              remaining = remaining.slice(46);
            }
          }
        }

        printer.text(sepDash);

        // ── Totals ──
        printer
          .align('rt')
          .text(lineItem('Subtotal', formatCurrency(subtotal), PAPER_WIDTH));

        if (discount > 0) {
          printer.text(lineItem('Discount', `-${formatCurrency(discount)}`, PAPER_WIDTH));
        }
        if (tax > 0) {
          printer.text(lineItem('Tax/GST', formatCurrency(tax), PAPER_WIDTH));
        }

        printer
          .text(sep)
          .style('b')
          .size(1, 1)
          .text(lineItem('TOTAL', formatCurrency(total), PAPER_WIDTH))
          .size(0, 0)
          .style('normal')
          .text(sep)

          // ── Payment ──
          .text(lineItem('Payment', payMethod,              PAPER_WIDTH))
          .text(lineItem('Paid',    formatCurrency(amountPaid), PAPER_WIDTH))
          .text(lineItem('Change',  formatCurrency(change),    PAPER_WIDTH))
          .text(sep);

        // ── Note ──
        if (note) {
          printer
            .align('ct')
            .text(note)
            .text(sep);
        }

        // ── Footer ──
        printer
          .align('ct')
          .text('Thank you for your purchase!')
          .text('Visit us again')
          .text('')
          .text('')

          // ── Cut ──
          .cut('full')
          .close(() => resolve());

      } catch (printErr) {
        logger.error('ESC/POS printing error:', printErr.message);
        try { printer.close(); } catch {}
        reject(new Error(`Printing failed: ${printErr.message}`));
      }
    });
  });
}

// ─── Open Cash Drawer ─────────────────────────────────────────────────────────
function openCashDrawer() {
  return new Promise((resolve, reject) => {
    let escpos;
    try {
      escpos = loadEscpos();
    } catch (err) {
      return reject(err);
    }

    let device;
    try {
      device = getUsbDevice(escpos);
    } catch (err) {
      return reject(err);
    }

    const printer = new escpos.Printer(device);

    device.open((err) => {
      if (err) return reject(new Error(`Cannot open printer for drawer: ${err.message}`));

      try {
        printer
          .cashdraw(2)   // Pin 2 (most common)
          .close(() => resolve());
      } catch (e) {
        try { printer.close(); } catch {}
        reject(new Error(`Cash drawer error: ${e.message}`));
      }
    });
  });
}

module.exports = { printReceipt, openCashDrawer, checkPrinterStatus };
