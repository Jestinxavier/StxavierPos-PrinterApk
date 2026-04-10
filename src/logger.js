// logger.js — Winston logger (console + rotating file)

const path = require('path');
const { app } = require('electron');

// Use Electron's userData path so logs persist across app installs
function getLogDir() {
  try {
    return app.getPath('userData');
  } catch {
    return path.join(process.cwd(), 'logs');
  }
}

let _logger = null;
let _logFilePath = null;

function getLogger() {
  if (_logger) return _logger;

  // Lazy-require winston to avoid issues before app is ready
  const winston = require('winston');
  const logDir  = getLogDir();
  _logFilePath  = path.join(logDir, 'pos-bridge.log');

  _logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const extras = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        return `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}${extras}`;
      })
    ),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({
        filename: _logFilePath,
        maxsize: 2 * 1024 * 1024,   // 2 MB
        maxFiles: 3,
        tailable: true,
      }),
    ],
  });

  return _logger;
}

// Proxy object — calls through to lazy-initialized logger
const logger = {
  get logFilePath() { return _logFilePath || path.join(getLogDir(), 'pos-bridge.log'); },
  info:  (...args) => getLogger().info(...args),
  warn:  (...args) => getLogger().warn(...args),
  error: (...args) => getLogger().error(...args),
  debug: (...args) => getLogger().debug(...args),
};

module.exports = logger;
