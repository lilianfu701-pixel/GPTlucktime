/**
 * Structured logging.
 *
 * One JSON object per line, because the first thing anyone does with these is
 * grep them at three in the morning, and the second is load them into something
 * that expects a shape.
 *
 * The redaction below is deliberately aggressive. A log line is copied into
 * tickets, pasted into chat, and shipped to whichever vendor aggregates it, so
 * it is the wrong place to be clever about what might be sensitive. Doc 06
 * section 8 is explicit: no credential, and no contact detail, in an
 * operational record.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

/**
 * Key fragments whose values never appear in a log.
 *
 * Matched case-insensitively against the key with separators removed, so
 * `apiKey`, `API_KEY` and `x-api-key` are all caught. Contact details are here
 * alongside credentials: an address is how a person is found, and doc 06
 * section 8 treats it the same way.
 */
const REDACTED_KEY_FRAGMENTS = [
  "password",
  "passcode",
  "token",
  "secret",
  "authorization",
  "cookie",
  "apikey",
  "credential",
  "otp",
  "code",
  "email",
  "phone",
  "address",
  "signature",
  "privatekey",
];

const REDACTED = "[redacted]";

/** How deep redaction walks before giving up on a pathological structure. */
const MAX_DEPTH = 6;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  return REDACTED_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}

/**
 * Replaces sensitive values, in place of the structure, at any depth.
 *
 * Keys are what is inspected, never values: a value-based heuristic would both
 * miss the secret that does not look like one and mangle the ordinary text
 * that does.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return "[truncated]";
  }

  if (value instanceof Error) {
    // The stack is left out on purpose: it carries file paths, and often the
    // arguments that caused the failure.
    return { name: value.name, message: value.message };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? REDACTED : redact(entry, depth + 1);
    }
    return output;
  }

  return value;
}

export type Logger = {
  debug: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
  /** A logger carrying extra context, typically the correlation id. */
  child: (fields: LogFields) => Logger;
};

export type LoggerOptions = {
  service: string;
  write?: (line: string) => void;
  context?: LogFields;
  now?: () => Date;
};

function serialize(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    // A cyclic or otherwise unserializable field must not take down the
    // request that was only trying to describe itself.
    return JSON.stringify({
      time: record.time,
      level: record.level,
      service: record.service,
      event: record.event,
      fieldsOmitted: "unserializable",
    });
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const context = options.context ?? {};

  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    const merged = { ...context, ...(fields ?? {}) };
    const safe = redact(merged) as Record<string, unknown>;
    write(
      serialize({
        time: now().toISOString(),
        level,
        service: options.service,
        event,
        ...safe,
      }),
    );
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (fields) =>
      createLogger({
        ...options,
        // A child never writes back into its parent's context.
        context: { ...context, ...fields },
      }),
  };
}

let appLogger: Logger | null = null;

/** The process-wide logger. */
export function logger(service = "web"): Logger {
  appLogger ??= createLogger({ service });
  return appLogger;
}
