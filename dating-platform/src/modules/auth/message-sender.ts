export const NOTIFICATION_PROVIDER_UNAVAILABLE = "NOTIFICATION_PROVIDER_UNAVAILABLE";
export const NOTIFICATION_DELIVERY_FAILED = "NOTIFICATION_DELIVERY_FAILED";
export const NOTIFICATION_OUTBOX_UNAVAILABLE = "NOTIFICATION_OUTBOX_UNAVAILABLE";

export class NotificationNotConfiguredError extends Error {
  readonly code = NOTIFICATION_PROVIDER_UNAVAILABLE;

  constructor(readonly channel: "email" | "sms") {
    super(NOTIFICATION_PROVIDER_UNAVAILABLE);
    this.name = "NotificationNotConfiguredError";
  }
}

export class NotificationDeliveryError extends Error {
  readonly code = NOTIFICATION_DELIVERY_FAILED;

  constructor() {
    super(NOTIFICATION_DELIVERY_FAILED);
    this.name = "NotificationDeliveryError";
  }
}

export type EmailVerificationMessage = { to: string; verificationUrl: string };
export type PasswordResetMessage = { to: string; resetUrl: string };
export type SmsOtpMessage = { to: string; code: string };
export type DeliveryContext = { deliveryKey: string };
export type EnqueueEmailVerificationMessage = EmailVerificationMessage & { validUntil: Date };
export type EnqueuePasswordResetMessage = PasswordResetMessage & { validUntil: Date };
export type EnqueueSmsOtpMessage = SmsOtpMessage & { validUntil: Date };

export interface MessageSender {
  assertAvailable(channel: "email" | "sms"): void;
  sendEmailVerification(message: EmailVerificationMessage, context: DeliveryContext): Promise<void>;
  sendPasswordReset(message: PasswordResetMessage, context: DeliveryContext): Promise<void>;
  sendSmsOtp(message: SmsOtpMessage, context: DeliveryContext): Promise<void>;
}

type WebhookProvider = { endpoint: string; token: string };
type HttpMessageSenderOptions = {
  email?: WebhookProvider;
  sms?: WebhookProvider;
  fetch?: typeof globalThis.fetch;
};

function requireHttps(endpoint: string): void {
  if (new URL(endpoint).protocol !== "https:") {
    throw new Error("PROVIDER_ENDPOINT_MUST_USE_HTTPS");
  }
}

export class HttpMessageSender implements MessageSender {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: HttpMessageSenderOptions) {
    if (options.email) requireHttps(options.email.endpoint);
    if (options.sms) requireHttps(options.sms.endpoint);
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  sendEmailVerification(message: EmailVerificationMessage, context: DeliveryContext): Promise<void> {
    return this.send("email", this.options.email, message, context);
  }

  assertAvailable(channel: "email" | "sms"): void {
    if (!this.options[channel]) throw new NotificationNotConfiguredError(channel);
  }

  sendSmsOtp(message: SmsOtpMessage, context: DeliveryContext): Promise<void> {
    return this.send("sms", this.options.sms, message, context);
  }

  private async send(
    channel: "email" | "sms",
    provider: WebhookProvider | undefined,
    payload: EmailVerificationMessage | PasswordResetMessage | SmsOtpMessage,
    context: DeliveryContext,
  ): Promise<void> {
    if (!provider) throw new NotificationNotConfiguredError(channel);

    try {
      const response = await this.fetch(provider.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${provider.token}`,
          "content-type": "application/json",
          "idempotency-key": context.deliveryKey,
        },
        body: JSON.stringify({ channel, ...payload }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new NotificationDeliveryError();
    } catch (error) {
      if (error instanceof NotificationDeliveryError) throw error;
      throw new NotificationDeliveryError();
    }
  }

  sendPasswordReset(message: PasswordResetMessage, context: DeliveryContext): Promise<void> {
    return this.send("email", this.options.email, message, context);
  }
}

export class InMemoryMessageSender implements MessageSender {
  readonly emails: EmailVerificationMessage[] = [];
  readonly passwordResets: PasswordResetMessage[] = [];
  readonly sms: SmsOtpMessage[] = [];

  assertAvailable(): void {}

  async sendEmailVerification(message: EmailVerificationMessage, context: DeliveryContext): Promise<void> {
    void context;
    this.emails.push(message);
  }

  async sendPasswordReset(message: PasswordResetMessage, context: DeliveryContext): Promise<void> {
    void context;
    this.passwordResets.push(message);
  }

  async sendSmsOtp(message: SmsOtpMessage, context: DeliveryContext): Promise<void> {
    void context;
    this.sms.push(message);
  }
}

export interface MessageDispatcher {
  assertHealthy(): Promise<void>;
  enqueueEmailVerification(message: EnqueueEmailVerificationMessage): Promise<void>;
  enqueuePasswordReset(message: EnqueuePasswordResetMessage): Promise<void>;
  enqueueSmsOtp(message: EnqueueSmsOtpMessage): Promise<void>;
}
