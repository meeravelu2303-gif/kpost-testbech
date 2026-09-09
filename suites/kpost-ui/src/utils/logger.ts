/**
 * Minimal, dependency-free structured logger.
 *
 * Playwright captures stdout/stderr per test and attaches it to the HTML
 * report, so a lightweight console-based logger is sufficient and avoids
 * pulling in a heavy logging dependency. Levels are gated by LOG_LEVEL.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const activeLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';
const threshold = LEVEL_ORDER[activeLevel] ?? LEVEL_ORDER.info;

function emit(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  const line = meta !== undefined ? `${prefix} ${message} ${JSON.stringify(meta)}` : `${prefix} ${message}`;

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.info(line);
  }
}

export const logger = {
  debug: (message: string, meta?: unknown) => emit('debug', message, meta),
  info: (message: string, meta?: unknown) => emit('info', message, meta),
  warn: (message: string, meta?: unknown) => emit('warn', message, meta),
  error: (message: string, meta?: unknown) => emit('error', message, meta),
};
