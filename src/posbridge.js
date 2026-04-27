// posbridge.js
// ─────────────────────────────────────────────────────────────────────────────
// Drop this file into your existing React POS app.
// It provides a simple API to talk to the POS Bridge Electron service.
//
// Usage:
//   import { printReceipt, openCashDrawer, getBridgeStatus } from './posbridge';
//
//   const result = await printReceipt({ items, total, invoiceNo, ... });
//   if (result.ok) console.log('Printed!');
//   else console.error(result.error);
// ─────────────────────────────────────────────────────────────────────────────

const BRIDGE_URLS = ['https://localhost:3000', 'http://localhost:3000'];
const TIMEOUT_MS = 10000; // 10 seconds
let preferredBridgeUrl = null;

// ─── Internal fetch helper with timeout ──────────────────────────────────────
async function bridgeFetch(path, options = {}) {
  const candidates = preferredBridgeUrl
    ? [preferredBridgeUrl, ...BRIDGE_URLS.filter((url) => url !== preferredBridgeUrl)]
    : BRIDGE_URLS;

  let lastError = 'POS Bridge not running. Please start the POS Bridge app.';

  for (const baseUrl of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(`${baseUrl}${path}`, {
        ...options,
        mode: 'cors',
        signal: controller.signal,
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
      });

      clearTimeout(timer);
      const data = await res.json();
      if (data && data.ok) preferredBridgeUrl = baseUrl;
      return data;

    } catch (err) {
      clearTimeout(timer);

      if (err.name === 'AbortError') {
        lastError = 'POS Bridge request timed out';
      } else if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
        lastError = 'POS Bridge not running. Please start the POS Bridge app.';
      } else {
        lastError = err.message;
      }
    }
  }

  return { ok: false, error: lastError };
}

// ─── Get bridge / printer status ─────────────────────────────────────────────
/**
 * @returns {{ ok: boolean, printerConnected: boolean, lastPrintAt: string|null, printCount: number }}
 */
export async function getBridgeStatus() {
  return bridgeFetch('/status');
}

// ─── Print a receipt ─────────────────────────────────────────────────────────
/**
 * @param {Object} data
 * @param {Array}  data.items          - [{ name, qty, price, amount? }]
 * @param {number} data.total          - Grand total (required)
 * @param {string} [data.invoiceNo]    - Invoice / bill number
 * @param {string} [data.cashier]      - Cashier name
 * @param {number} [data.subtotal]     - Subtotal before tax/discount
 * @param {number} [data.discount]     - Discount amount
 * @param {number} [data.tax]          - Tax / GST amount
 * @param {string} [data.paymentMethod]- 'CASH' | 'CARD' | 'UPI' etc.
 * @param {number} [data.amountPaid]   - Amount tendered
 * @param {number} [data.change]       - Change returned
 * @param {boolean}[data.openDrawer]   - Open cash drawer after print (default: true)
 * @param {string} [data.note]         - Footer note
 * @param {string} [data.shopName]     - Override shop name
 * @returns {{ ok: boolean, message?: string, error?: string }}
 */
export async function printReceipt(data) {
  if (!data || !Array.isArray(data.items) || data.items.length === 0) {
    return { ok: false, error: 'items array is required' };
  }
  if (data.total === undefined || data.total === null) {
    return { ok: false, error: 'total is required' };
  }

  return bridgeFetch('/print', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ─── Open cash drawer only (no print) ────────────────────────────────────────
/**
 * @returns {{ ok: boolean, message?: string, error?: string }}
 */
export async function openCashDrawer() {
  return bridgeFetch('/cashdrawer', { method: 'POST' });
}

// ─── Example usage in a React component ──────────────────────────────────────
/*
import { printReceipt, getBridgeStatus } from './posbridge';

async function handleCheckout(bill) {
  // Optional: check printer before attempting print
  const status = await getBridgeStatus();
  if (!status.ok) {
    alert('POS Bridge is not running. Please start the bridge app.');
    return;
  }
  if (!status.printerConnected) {
    alert('Printer not connected. Check USB cable and power.');
    return;
  }

  const result = await printReceipt({
    invoiceNo:     bill.invoiceNo,
    cashier:       'John',
    items:         bill.items,        // [{ name, qty, price }]
    subtotal:      bill.subtotal,
    discount:      bill.discount,
    tax:           bill.tax,
    total:         bill.total,
    paymentMethod: 'CASH',
    amountPaid:    bill.amountPaid,
    change:        bill.change,
    openDrawer:    true,              // open cash drawer after print
  });

  if (result.ok) {
    console.log('Receipt printed and cash drawer opened!');
  } else {
    alert(`Print failed: ${result.error}`);
  }
}
*/
