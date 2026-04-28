// server.js — Express HTTP Server (runs inside Electron)
// Exposes: POST /print, GET /status, POST /cashdrawer

const fs      = require('fs');
const http    = require('http');
const https   = require('https');
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const logger  = require('./logger');
const { printReceipt, openCashDrawer, checkPrinterStatus } = require('./printer');

const BRIDGE_HOST     = process.env.BRIDGE_HOST || '127.0.0.1';
const BRIDGE_PORT     = Number(process.env.BRIDGE_PORT || process.env.PORT || 3000);
const BRIDGE_PROTOCOL = (process.env.BRIDGE_PROTOCOL || 'http').toLowerCase() === 'https' ? 'https' : 'http';

// ─── Auto-generate self-signed cert (stored in Electron userData) ─────────────
// Called only when BRIDGE_PROTOCOL=https. Cert is generated ONCE and reused.
// Stored in: %APPDATA%\POS Bridge\certs\  (Windows)
function getOrCreateCerts() {
  const { app: electronApp } = require('electron');
  const certDir  = path.join(electronApp.getPath('userData'), 'certs');
  const keyPath  = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    logger.info('Generating self-signed SSL certificate for localhost...');
    fs.mkdirSync(certDir, { recursive: true });

    const selfsigned = require('selfsigned');
    const pems = selfsigned.generate(
      [{ name: 'commonName', value: 'localhost' }],
      {
        days:      3650,       // 10 years — no renewal headache
        keySize:   2048,
        algorithm: 'sha256',
        extensions: [
          { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] },
        ],
      }
    );

    fs.writeFileSync(keyPath,  pems.private);
    fs.writeFileSync(certPath, pems.cert);
    logger.info(`SSL cert saved to: ${certDir}`);
  }

  return {
    key:  fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    path: certDir,
  };
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
let httpServer = null;

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  printerConnected: false,
  lastPrintAt:      null,
  lastError:        null,
  printCount:       0,
};

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

const corsOptions = {
  origin:               '*',
  methods:              ['GET', 'POST', 'OPTIONS'],
  allowedHeaders:       ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
};

// Required for hosted HTTPS React apps calling localhost (Chrome private network access check)
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
    ok:               true,
    service:          'POS Bridge',
    version:          '1.1.0',
    protocol:         BRIDGE_PROTOCOL,
    printerConnected: state.printerConnected,
    lastPrintAt:      state.lastPrintAt,
    lastError:        state.lastError,
    printCount:       state.printCount,
  });
});

// ─── POST /print ──────────────────────────────────────────────────────────────
app.post('/print', async (req, res) => {
  const data = req.body;

  if (!data || !Array.isArray(data.items) || data.items.length === 0) {
    return res.status(400).json({ ok: false, error: 'Invalid request: items array is required' });
  }
  if (data.total === undefined || data.total === null) {
    return res.status(400).json({ ok: false, error: 'Invalid request: total is required' });
  }

  try {
    logger.info(`Print job received — Invoice: ${data.invoiceNo || 'N/A'}, Total: ${data.total}`);

    await printReceipt(data);

    state.lastPrintAt      = new Date().toISOString();
    state.lastError        = null;
    state.printCount++;
    state.printerConnected = true;

    logger.info(`Print job #${state.printCount} completed successfully`);

    return res.json({
      ok:           true,
      message:      'Receipt printed successfully',
      drawerOpened: data.openDrawer !== false,
      printCount:   state.printCount,
    });

  } catch (err) {
    state.lastError        = err.message;
    state.printerConnected = false;
    logger.error('Print failed:', err.message);

    return res.status(500).json({
      ok:    false,
      error: err.message || 'Print failed',
      hint:  'Check that printer is connected via USB and powered on',
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

// ─── 404 ─────────────────────────────────────────────────────────────────────
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
    if (httpServer) return resolve();

    if (BRIDGE_PROTOCOL === 'https') {
      // Auto-generates cert on first run — no OpenSSL or manual steps needed
      let sslOptions;
      try {
        sslOptions = getOrCreateCerts();
        logger.info(`HTTPS mode — cert stored at: ${sslOptions.path}`);
      } catch (err) {
        return reject(new Error(`Failed to generate SSL cert: ${err.message}`));
      }
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
    host:     BRIDGE_HOST,
    port:     BRIDGE_PORT,
    url:      `${BRIDGE_PROTOCOL}://${BRIDGE_HOST}:${BRIDGE_PORT}`,
  };
}

module.exports = { startServer, stopServer, getServerStatus, getBridgeConfig };
