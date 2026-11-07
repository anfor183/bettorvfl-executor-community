/**
 * Centralized Structured Logging System
 * 
 * Provides unified, structured, and persistent logging across all BettorVFL Executor
 * subsystems (Bet Executor, Signal Collector, Dashboard Main Process, and Scrapers).
 * 
 * Features:
 * - Persistent disk storage in `logs/` directory.
 * - Subsystem-specific routing (executor.log, collector.log, system.log).
 * - Master timeline log (all.log) and aggregated error log (error.log).
 * - Automatic size-based rotation (default 5MB max, 5 rotation archives).
 * - Machine-parseable format with timestamps, levels, subsystem tags, and structured JSON metadata.
 * - Historical log reading & directory opener helper APIs.
 */

const fs = require('fs');
const path = require('path');

// Prevent unhandled EPIPE errors when process runs as a daemon/PM2 or stdout/stderr pipe closes
if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) return;
  });
}
if (process.stderr && typeof process.stderr.on === 'function') {
  process.stderr.on('error', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) return;
  });
}
if (typeof process.on === 'function') {
  process.on('uncaughtException', (err) => {
    if (err && (err.code === 'EPIPE' || (err.message && err.message.includes('EPIPE')))) {
      return; // Gracefully swallow broken pipe error
    }
  });
}

// Determine root directory (handles being called from root or from dashboard/out/main)
const ROOT_DIR = (() => {
  const candidate1 = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(candidate1, 'package.json')) || fs.existsSync(path.join(candidate1, 'bot_settings.json'))) {
    return candidate1;
  }
  const candidate2 = path.resolve(__dirname, '../../..');
  if (fs.existsSync(path.join(candidate2, 'package.json')) || fs.existsSync(path.join(candidate2, 'bot_settings.json'))) {
    return candidate2;
  }
  return process.cwd();
})();

const LOGS_DIR = path.join(ROOT_DIR, 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  } catch (err) {
    console.error('[Logger] Failed to create logs directory:', err.message);
  }
}

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_BACKUP_FILES = 5;

// Rotate file if it exceeds MAX_FILE_SIZE_BYTES
function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stats = fs.statSync(filePath);
    if (stats.size < MAX_FILE_SIZE_BYTES) return;

    // Shift existing backups (.4 -> .5, .3 -> .4, etc.)
    for (let i = MAX_BACKUP_FILES - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dest = `${filePath}.${i + 1}`;
      if (fs.existsSync(src)) {
        try {
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
          fs.renameSync(src, dest);
        } catch (e) {}
      }
    }

    // Shift main file to .1
    const backup1 = `${filePath}.1`;
    if (fs.existsSync(backup1)) {
      try { fs.unlinkSync(backup1); } catch (e) {}
    }
    fs.renameSync(filePath, backup1);
  } catch (err) {
    console.warn(`[Logger] Log rotation warning for ${filePath}:`, err.message);
  }
}

// Append line to file with safety and rotation check
function appendToFile(fileName, line) {
  try {
    const filePath = path.join(LOGS_DIR, fileName);
    rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, line + '\n', 'utf8');
  } catch (err) {
    console.error(`[Logger] Failed to write to ${fileName}:`, err.message);
  }
}

// Format timestamp: YYYY-MM-DD HH:mm:ss.SSS
function getTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const millis = String(now.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}`;
}

// Map subsystem name to log file name
function getSubsystemFile(subsystem) {
  const sub = String(subsystem || 'system').toLowerCase();
  if (sub.includes('executor') || sub.includes('1xbet')) return 'executor.log';
  if (sub.includes('collector') || sub.includes('signal') || sub.includes('predictor')) return 'collector.log';
  if (sub.includes('scraper') || sub.includes('parser') || sub.includes('db')) return 'scraper.log';
  return 'system.log';
}

class Logger {
  constructor() {
    this.logsDir = LOGS_DIR;
  }

  getLogsDir() {
    return this.logsDir;
  }

  write(level, subsystem, message, meta = null) {
    const timestamp = getTimestamp();
    const cleanSubsystem = (subsystem || 'System').trim();
    
    let metaString = '';
    if (meta !== null && meta !== undefined) {
      if (meta instanceof Error) {
        metaString = ` | Stack: ${meta.stack || meta.message}`;
      } else if (typeof meta === 'object') {
        try {
          metaString = ` | Meta: ${JSON.stringify(meta)}`;
        } catch (e) {
          metaString = ` | Meta: [Unserializable]`;
        }
      } else {
        metaString = ` | Meta: ${meta}`;
      }
    }

    const logLine = `[${timestamp}] [${level.toUpperCase()}] [${cleanSubsystem}] ${message}${metaString}`;

    // 1. Output to stdout / stderr for process monitoring
    try {
      if (level === 'ERROR') {
        console.error(logLine);
      } else if (level === 'WARN') {
        console.warn(logLine);
      } else {
        console.log(logLine);
      }
    } catch (_) {
      // Ignore EPIPE when stdout is closed
    }

    // 2. Write to specific subsystem log file
    const subFile = getSubsystemFile(cleanSubsystem);
    appendToFile(subFile, logLine);

    // 3. Write to master timeline
    appendToFile('all.log', logLine);

    // 4. If error or warn, write to aggregated error log
    if (level === 'ERROR' || level === 'WARN') {
      appendToFile('error.log', logLine);
    }
  }

  info(subsystem, message, meta = null) {
    this.write('INFO', subsystem, message, meta);
  }

  warn(subsystem, message, meta = null) {
    this.write('WARN', subsystem, message, meta);
  }

  error(subsystem, message, errorOrMeta = null) {
    this.write('ERROR', subsystem, message, errorOrMeta);
  }

  debug(subsystem, message, meta = null) {
    this.write('DEBUG', subsystem, message, meta);
  }

  bet(message, meta = null) {
    this.write('BET', 'Executor', message, meta);
  }

  /**
   * Reads recent log lines from a specific subsystem log file.
   * Useful for dashboard initial history hydration.
   */
  getRecentLogs(subsystem = 'executor', maxLines = 200) {
    try {
      const fileName = subsystem === 'all' ? 'all.log' : getSubsystemFile(subsystem);
      const filePath = path.join(this.logsDir, fileName);

      if (!fs.existsSync(filePath)) {
        return [];
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      return lines.slice(-maxLines);
    } catch (err) {
      console.error(`[Logger] Failed to read recent logs for ${subsystem}:`, err.message);
      return [];
    }
  }

  /**
   * Clears a subsystem log or all logs
   */
  clearLogs(subsystem = 'executor') {
    try {
      if (subsystem === 'all') {
        const files = fs.readdirSync(this.logsDir).filter(f => f.endsWith('.log') || /\.log\.\d+$/.test(f));
        for (const file of files) {
          try { fs.unlinkSync(path.join(this.logsDir, file)); } catch (e) {}
        }
        return { success: true, message: 'All logs cleared.' };
      }

      const fileName = getSubsystemFile(subsystem);
      const filePath = path.join(this.logsDir, fileName);
      if (fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '', 'utf8');
      }
      return { success: true, message: `${fileName} cleared.` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

const loggerInstance = new Logger();

module.exports = loggerInstance;
module.exports.Logger = Logger;
