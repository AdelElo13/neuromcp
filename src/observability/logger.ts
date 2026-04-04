const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

export interface LoggerOptions {
  readonly level: Level;
  readonly format: 'text' | 'json';
}

export interface Logger {
  debug(component: string, message: string, metadata?: Record<string, unknown>, operationId?: string): void;
  info(component: string, message: string, metadata?: Record<string, unknown>, operationId?: string): void;
  warn(component: string, message: string, metadata?: Record<string, unknown>, operationId?: string): void;
  error(component: string, message: string, metadata?: Record<string, unknown>, operationId?: string): void;
}

interface LogEntry {
  readonly timestamp: string;
  readonly level: Level;
  readonly component: string;
  readonly message: string;
  readonly operation_id?: string;
  readonly duration_ms?: number;
  readonly [key: string]: unknown;
}

function formatText(entry: LogEntry): string {
  const parts = [
    entry.timestamp,
    entry.level.toUpperCase().padEnd(5),
    `[${entry.component}]`,
    entry.message,
  ];
  if (entry.operation_id !== undefined) {
    parts.push(`op=${entry.operation_id}`);
  }
  if (entry.duration_ms !== undefined) {
    parts.push(`${entry.duration_ms}ms`);
  }
  // Append remaining metadata keys (excluding the structured fields already shown)
  const skip = new Set(['timestamp', 'level', 'component', 'message', 'operation_id', 'duration_ms']);
  for (const [k, v] of Object.entries(entry)) {
    if (!skip.has(k)) {
      parts.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  return parts.join(' ');
}

function formatJson(entry: LogEntry): string {
  return JSON.stringify(entry);
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVELS[options.level];
  const format = options.format === 'json' ? formatJson : formatText;

  function log(
    level: Level,
    component: string,
    message: string,
    metadata?: Record<string, unknown>,
    operationId?: string,
  ): void {
    if (LEVELS[level] < threshold) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...(operationId !== undefined ? { operation_id: operationId } : {}),
      ...(metadata ?? {}),
    };

    process.stderr.write(format(entry) + '\n');
  }

  return {
    debug: (component, message, metadata, operationId) => log('debug', component, message, metadata, operationId),
    info: (component, message, metadata, operationId) => log('info', component, message, metadata, operationId),
    warn: (component, message, metadata, operationId) => log('warn', component, message, metadata, operationId),
    error: (component, message, metadata, operationId) => log('error', component, message, metadata, operationId),
  };
}
