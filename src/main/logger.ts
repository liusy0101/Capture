import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { format } from 'util';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB
const KEEP_DAYS = 14;

let logDir: string | null = null;
let logFilePath: string | null = null;
let writeStream: fs.WriteStream | null = null;
let initialized = false;
let consolePatched = false;

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
};

/** 安装目录：打包后为 exe 所在目录；开发时为项目根目录 */
export function getInstallDir(): string {
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }
  return path.resolve(__dirname, '../..');
}

export function getLogDir(): string {
  return logDir || path.join(getInstallDir(), 'logs');
}

export function getLogFilePath(): string | null {
  return logFilePath;
}

function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) {
        return a.stack || `${a.name}: ${a.message}`;
      }
      if (typeof a === 'string') return a;
      try {
        return format(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function ensureWritableDir(preferred: string): string {
  try {
    fs.mkdirSync(preferred, { recursive: true });
    const probe = path.join(preferred, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return preferred;
  } catch {
    // Program Files 等只读目录：回退到 userData/logs
    const fallback = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function openLogFile(): void {
  if (!logDir) return;
  const file = path.join(logDir, `capture-${todayStamp()}.log`);
  if (logFilePath === file && writeStream) return;

  try {
    writeStream?.end();
  } catch {
    /* ignore */
  }

  logFilePath = file;
  writeStream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
  writeStream.on('error', (err) => {
    originalConsole.error('[logger] write stream error:', err);
  });
}

function pruneOldLogs(): void {
  if (!logDir) return;
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(logDir)) {
      if (!/^capture-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const full = path.join(logDir, name);
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
      }
    }
  } catch {
    /* ignore */
  }
}

function rotateIfTooLarge(): void {
  if (!logFilePath) return;
  try {
    const st = fs.statSync(logFilePath);
    if (st.size < MAX_FILE_BYTES) return;
    const rotated = logFilePath.replace(/\.log$/, `.${Date.now()}.log`);
    writeStream?.end();
    writeStream = null;
    fs.renameSync(logFilePath, rotated);
    openLogFile();
  } catch {
    /* ignore */
  }
}

function writeLine(level: LogLevel, message: string): void {
  if (!initialized) return;
  try {
    // 跨日切换文件
    const expected = path.join(logDir!, `capture-${todayStamp()}.log`);
    if (logFilePath !== expected || !writeStream) {
      openLogFile();
    }
    rotateIfTooLarge();
    const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const line = `[${ts}] [${level}] ${message}\n`;
    writeStream?.write(line);
  } catch (err) {
    originalConsole.error('[logger] write failed:', err);
  }
}

export function logDebug(...args: unknown[]): void {
  writeLine('DEBUG', formatArgs(args));
  originalConsole.debug(...args);
}

export function logInfo(...args: unknown[]): void {
  writeLine('INFO', formatArgs(args));
  originalConsole.info(...args);
}

export function logWarn(...args: unknown[]): void {
  writeLine('WARN', formatArgs(args));
  originalConsole.warn(...args);
}

export function logError(...args: unknown[]): void {
  writeLine('ERROR', formatArgs(args));
  originalConsole.error(...args);
}

/** 仅写文件，不回显控制台（避免 patch 后递归） */
function writeOnly(level: LogLevel, args: unknown[]): void {
  writeLine(level, formatArgs(args));
}

function patchConsole(): void {
  if (consolePatched) return;
  consolePatched = true;

  console.log = (...args: unknown[]) => {
    writeOnly('INFO', args);
    originalConsole.log(...args);
  };
  console.info = (...args: unknown[]) => {
    writeOnly('INFO', args);
    originalConsole.info(...args);
  };
  console.warn = (...args: unknown[]) => {
    writeOnly('WARN', args);
    originalConsole.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    writeOnly('ERROR', args);
    originalConsole.error(...args);
  };
  console.debug = (...args: unknown[]) => {
    writeOnly('DEBUG', args);
    originalConsole.debug(...args);
  };
}

/**
 * 初始化文件日志。应在 app ready 后尽早调用。
 * 日志目录优先：安装目录/logs；不可写则回退到 userData/logs。
 */
export function initFileLogger(): { logDir: string; logFile: string } {
  if (initialized) {
    return { logDir: getLogDir(), logFile: logFilePath || '' };
  }

  const preferred = path.join(getInstallDir(), 'logs');
  logDir = ensureWritableDir(preferred);
  openLogFile();
  pruneOldLogs();
  patchConsole();
  initialized = true;

  const usingFallback = path.resolve(logDir) !== path.resolve(preferred);
  writeLine(
    'INFO',
    `Capture logger started. installDir=${getInstallDir()} logDir=${logDir}` +
      (usingFallback ? ' (fallback: install dir not writable)' : '')
  );
  writeLine('INFO', `version=${app.getVersion()} packaged=${app.isPackaged} platform=${process.platform} arch=${process.arch}`);

  return { logDir, logFile: logFilePath || '' };
}
