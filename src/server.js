// server.js — Express HTTP Server (runs inside Electron)
// Exposes: POST /print, GET /status, POST /cashdrawer

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const express = require('express');
const cors = require('cors');
const logger = require('./logger');
const { printReceipt, openCashDrawer, checkPrinterStatus } = require('./printer');

const app = express();
let httpServer = null;
const BRIDGE_HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || process.env.PORT || 3000);
const BRIDGE_PROTOCOL = (process.env.BRIDGE_PROTOCOL || 'http').toLowerCase() === 'https' ? 'https' : 'http';
const HTTPS_KEY_PATH = process.env.BRIDGE_SSL_KEY || path.join(__dirname, '../certs/key.pem');
const HTTPS_CERT_PATH = process.env.BRIDGE_SSL_CERT || path.join(__dirname, '../certs/cert.pem');

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  printerConnected: false,
  lastPrintAt: null,
  lastError: null,
  printCount: 0,
};

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
};
// Allow private-network preflight for hosted HTTPS POS frontends calling localhost.
app.use((req, res, next) => {
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Request logger
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// ─── GET /status ──────────────────────────────────────────────────────────────
app.get('/status', async (_req, res) => {
  try {
    state.printerConnected = await checkPrinterStatus();
  } catch {
    state.printerConnected = false;
  }

  res.json({
    ok: true,
    service: 'POS Bridge',
    version: '1.0.0',
    printerConnected: state.printerConnected,
    lastPrintAt: state.lastPrintAt,
    lastError: state.lastError,
    printCount: state.printCount,
  });
});

// ─── POST /print ──────────────────────────────────────────────────────────────
/**
 * Expected body:
 * {
 *   shopName?: string,           // override shop name
 *   invoiceNo?: string,
 *   cashier?: string,
 *   items: [
 *     { name: string, qty: number, price: number }
 *   ],
 *   subtotal?: number,
 *   discount?: number,
 *   tax?: number,
 *   total: number,
 *   paymentMethod?: string,
 *   amountPaid?: number,
 *   change?: number,
 *   openDrawer?: boolean,        // default true
 *   note?: string,
 * }
 */
app.post('/print', async (req, res) => {
  const data = req.body;

  // Validate required fields
  if (!data || !Array.isArray(data.items) || data.items.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid request: items array is required',
    });
  }
  if (data.total === undefined || data.total === null) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid request: total is required',
    });
  }

  try {
    logger.info(`Print job received — Invoice: ${data.invoiceNo || 'N/A'}, Total: ${data.total}`);

    await printReceipt(data);

    state.lastPrintAt = new Date().toISOString();
    state.lastError = null;
    state.printCount++;
    state.printerConnected = true;

    // Open cash drawer after successful print (default: true)
    if (data.openDrawer !== false) {
      await openCashDrawer();
      logger.info('Cash drawer opened');
    }

    logger.info(`Print job #${state.printCount} completed successfully`);

    return res.json({
      ok: true,
      message: 'Receipt printed successfully',
      drawerOpened: data.openDrawer !== false,
      printCount: state.printCount,
    });

  } catch (err) {
    state.lastError = err.message;
    state.printerConnected = false;
    logger.error('Print failed:', err.message);

    return res.status(500).json({
      ok: false,
      error: err.message || 'Print failed',
      hint: 'Check that printer is connected via USB and powered on',
    });
  }
});

// ─── POST /cashdrawer ─────────────────────────────────────────────────────────
app.post('/cashdrawer', async (_req, res) => {
  try {
    await openCashDrawer();
    logger.info('Cash drawer opened (manual trigger)');
    res.json({ ok: true, message: 'Cash drawer opened' });
  } catch (err) {
    logger.error('Cash drawer failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Endpoint not found' });
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error('Server error:', err.message);
  res.status(500).json({ ok: false, error: err.message });
});

// ─── Start / Stop ─────────────────────────────────────────────────────────────
function startServer(port = BRIDGE_PORT) {
  return new Promise((resolve, reject) => {
    if (httpServer) {
      return resolve();
    }

    if (BRIDGE_PROTOCOL === 'https') {
      if (!fs.existsSync(HTTPS_KEY_PATH) || !fs.existsSync(HTTPS_CERT_PATH)) {
        return reject(
          new Error(
            `HTTPS requested but certificate files were not found. ` +
            `Expected key: ${HTTPS_KEY_PATH}, cert: ${HTTPS_CERT_PATH}`
          )
        );
      }

      const sslOptions = {
        key: fs.readFileSync(HTTPS_KEY_PATH),
        cert: fs.readFileSync(HTTPS_CERT_PATH),
      };
      httpServer = https.createServer(sslOptions, app);
    } else {
      httpServer = http.createServer(app);
    }

    httpServer.listen(port, BRIDGE_HOST, () => {
      logger.info(`Express server listening on ${BRIDGE_PROTOCOL}://${BRIDGE_HOST}:${port}`);
      resolve();
    });

    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Is another POS Bridge running?`));
      } else {
        reject(err);
      }
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!httpServer) return resolve();
    httpServer.close(() => {
      httpServer = null;
      logger.info('Express server stopped');
      resolve();
    });
  });
}

function getServerStatus() {
  return { ...state };
}

function getBridgeConfig() {
  return {
    protocol: BRIDGE_PROTOCOL,
    host: BRIDGE_HOST,
    port: BRIDGE_PORT,
    url: `${BRIDGE_PROTOCOL}://${BRIDGE_HOST}:${BRIDGE_PORT}`,
  };
}

module.exports = { startServer, stopServer, getServerStatus, getBridgeConfig };
