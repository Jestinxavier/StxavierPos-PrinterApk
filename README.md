# POS Bridge — Electron Local Bridge Service

A lightweight background Electron app that runs on `localhost:3000` and connects your **existing React POS web app** to a USB thermal printer and cash drawer — no QZ Tray, no changes to your React app architecture.

---

## Architecture

```
┌─────────────────────────┐          HTTP (localhost)        ┌───────────────────────────┐
│  Your React Web App     │  ──── POST /print ────────────▶  │  POS Bridge (Electron)    │
│  (runs in browser)      │  ◀─── { ok: true } ───────────   │  Express on :3000         │
└─────────────────────────┘                                   └──────────┬────────────────┘
                                                                         │ USB
                                                              ┌──────────▼────────────┐
                                                              │  Thermal Printer      │
                                                              │  + Cash Drawer        │
                                                              └───────────────────────┘
```

---

## Project Structure

```
pos-bridge/
├── src/
│   ├── main.js        ← Electron entry: tray, window, auto-launch
│   ├── server.js      ← Express HTTP server (POST /print, GET /status)
│   ├── printer.js     ← ESC/POS integration (receipt + cash drawer)
│   ├── logger.js      ← Winston file + console logger
│   ├── preload.js     ← IPC bridge for status window
│   ├── status.html    ← Status popup (tray double-click)
│   └── posbridge.js   ← Drop this into your React app!
├── assets/
│   └── icon.ico       ← Tray icon (place your own 16x16 or 32x32 .ico here)
├── package.json
└── README.md
```

---

## Setup

### 1. Install dependencies

```bash
cd pos-bridge
npm install
```

> **Windows**: You may need `windows-build-tools` for USB HID access:
> ```bash
> npm install --global --production windows-build-tools
> ```

### 2. Configure your shop details

Edit `src/printer.js` top section:

```js
const SHOP_NAME    = 'St Xavier Oils';
const SHOP_ADDRESS = '123 Main Street, City';
const SHOP_PHONE   = 'Phone: +91-9876543210';
const SHOP_GST     = 'GSTIN: 29XXXXX1234Z1';   // leave '' if not needed
```

### 3. Run in development

```bash
npm start
```

The app starts **silently** — look for the tray icon (bottom-right taskbar on Windows).  
Double-click the tray icon to open the status popup.

### 4. Build for production (Windows installer)

```bash
npm run build
```

Output: `dist/POS Bridge Setup.exe`

---

## API Reference

Default endpoints are on `http://localhost:3000`.
If you set `BRIDGE_PROTOCOL=https`, endpoints become `https://localhost:3000`.

### GET /status

Returns service and printer status.

```json
{
  "ok": true,
  "service": "POS Bridge",
  "printerConnected": true,
  "lastPrintAt": "2024-01-15T10:30:00.000Z",
  "printCount": 42
}
```

### POST /print

Send bill data and trigger print + cash drawer.

**Request body:**
```json
{
  "invoiceNo": "INV-001",
  "cashier": "John",
  "items": [
    { "name": "Coconut Oil 1L",  "qty": 2, "price": 220 },
    { "name": "Groundnut Oil 500ml", "qty": 1, "price": 135 }
  ],
  "subtotal": 575,
  "discount": 25,
  "tax": 0,
  "total": 550,
  "paymentMethod": "CASH",
  "amountPaid": 600,
  "change": 50,
  "openDrawer": true,
  "note": "Thank you! Come again."
}
```

**Response (success):**
```json
{ "ok": true, "message": "Receipt printed successfully", "drawerOpened": true }
```

**Response (error):**
```json
{ "ok": false, "error": "No USB thermal printer found", "hint": "Check USB cable" }
```

### POST /cashdrawer

Opens the cash drawer without printing.

```json
{ "ok": true, "message": "Cash drawer opened" }
```

---

## React Integration

Copy `src/posbridge.js` into your React project:

```js
import { printReceipt, getBridgeStatus } from './posbridge';

async function handleCheckout(bill) {
  const result = await printReceipt({
    invoiceNo:     bill.invoiceNo,
    items:         bill.items,        // [{ name, qty, price }]
    subtotal:      bill.subtotal,
    discount:      bill.discount,
    tax:           bill.tax,
    total:         bill.total,
    paymentMethod: 'CASH',
    amountPaid:    bill.amountPaid,
    change:        bill.change,
    openDrawer:    true,
  });

  if (result.ok) {
    toast.success('Receipt printed!');
  } else {
    toast.error(`Print failed: ${result.error}`);
  }
}
```

### Hosted React apps (Firebase/Netlify/Vercel/etc.)

This bridge now allows hosted origins and includes Private Network Access preflight support.

Environment variables for bridge runtime:

```bash
BRIDGE_PROTOCOL=http                # or https
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=3000
BRIDGE_SSL_KEY=../certs/key.pem    # used only when BRIDGE_PROTOCOL=https
BRIDGE_SSL_CERT=../certs/cert.pem  # used only when BRIDGE_PROTOCOL=https
```

For HTTPS bridge mode, generate local certs and trust `https://localhost:3000/status` once in Chrome.

---

## Network Printer Support (Optional)

To use a network printer instead of USB, edit `src/printer.js`:

```js
// Replace getUsbDevice() with:
function getNetworkDevice(escpos) {
  return new escpos.Network('192.168.1.100', 9100);  // ← your printer IP
}
```

Then call `getNetworkDevice(escpos)` instead of `getUsbDevice(escpos)` in `printReceipt` and `openCashDrawer`.

---

## Tray Icon

Place a `icon.ico` (16×16 or 32×32) in the `assets/` folder. If not found, the app falls back to a simple colored dot icon.

---

## Auto-Start on Windows Boot

Auto-launch is **enabled automatically** when the app first runs.  
To disable: open the status popup → Stop service, or remove from Windows startup via Task Manager.

---

## Logs

Log file location: `%APPDATA%\POS Bridge\pos-bridge.log`  
(Open via tray menu → **Open Log File**)

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `No USB thermal printer found` | Check USB cable, turn printer on, try different port |
| `Port 3000 already in use` | Another process is using port 3000; close it or change `PORT` in server.js |
| `CORS / private network` error in hosted React | Keep POS Bridge running, allow localhost private-network access in browser, or run bridge in `https` mode |
| Cash drawer doesn't open | Drawer must be connected via printer's RJ11 port; check `cashdraw(2)` vs `cashdraw(5)` pin |
| App doesn't start silently | Check Windows Task Scheduler or remove and re-install |
| `escpos-usb` install fails | Run `npm install --global --production windows-build-tools` first |

---

## Printer Compatibility

Tested with ESC/POS compatible printers:
- Epson TM-T20 / TM-T82 / TM-T88
- Star TSP100 / TSP650
- Xprinter XP-80 / XP-58
- Any generic 80mm USB thermal printer

Cash drawer must be connected to the printer's cash drawer port (RJ11/RJ12).
