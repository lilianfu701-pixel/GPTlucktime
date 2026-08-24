export type FieldErrors = Readonly<Record<string, string>>;

export type AppErrorOptions = {
  code: string;
  status: number;
  messageKey: string;
  fieldErrors?: FieldErrors;
  retryable?: boolean;
  context?: Readonly<Record<string, unknown>>;
  cause?: unknown;
};

const STABLE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const MESSAGE_KEY = /^errors(?:\.[a-zA-Z0-9_-]+)+$/u;

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly messageKey: string;
  readonly fieldErrors?: FieldErrors;
  readonly retryable: boolean;
  readonly context?: Readonly<Record<string, unknown>>;

  constructor(options: AppErrorOptions) {
    if (!STABLE_CODE.test(options.code)) throw new TypeError("APP_ERROR_CODE_INVALID");
    if (!Number.isInteger(options.status) || options.status < 400 || options.status > 599) {
      throw new TypeError("APP_ERROR_STATUS_INVALID");
    }
    if (!MESSAGE_KEY.test(options.messageKey)) throw new TypeError("APP_ERROR_MESSAGE_KEY_INVALID");
    const fieldErrorEntries = options.fieldErrors ? Object.entries(options.fieldErrors) : undefined;
    if (fieldErrorEntries?.some(([, messageKey]) => !MESSAGE_KEY.test(messageKey))) {
      throw new TypeError("APP_ERROR_FIELD_MESSAGE_KEY_INVALID");
    }
    const fieldErrors = fieldErrorEntries
      ? Object.freeze(Object.fromEntries(fieldErrorEntries)) as FieldErrors
      : undefined;
    super(options.code, { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.status = options.status;
    this.messageKey = options.messageKey;
    this.fieldErrors = fieldErrors;
    this.retryable = options.retryable ?? options.status >= 500;
    this.context = options.context;
  }
}
