import type {
  EmailVerificationMessage,
  EnqueueEmailVerificationMessage,
  EnqueuePasswordResetMessage,
  EnqueueSmsOtpMessage,
  MessageDispatcher,
  MessageSender,
  PasswordResetMessage,
  SmsOtpMessage,
} from "@/modules/auth/message-sender";

export type E2eDelivery =
  | { channel: "email"; kind: "verification"; to: string; verificationUrl: string }
  | { channel: "email"; kind: "password-reset"; to: string; resetUrl: string }
  | { channel: "sms"; kind: "otp"; to: string; code: string };

const state = globalThis as typeof globalThis & { __datingPlatformE2eDeliveries?: E2eDelivery[] };
state.__datingPlatformE2eDeliveries ??= [];

export function resetE2eDeliveries(): void {
  state.__datingPlatformE2eDeliveries = [];
}

export function listE2eDeliveries(): readonly E2eDelivery[] {
  return [...(state.__datingPlatformE2eDeliveries ?? [])];
}

export class E2eNotificationAdapter implements MessageSender, MessageDispatcher {
  assertAvailable(): void {}
  async assertHealthy(): Promise<void> {}

  async enqueueEmailVerification(message: EnqueueEmailVerificationMessage): Promise<void> {
    state.__datingPlatformE2eDeliveries?.push({ channel: "email", kind: "verification",
      to: message.to, verificationUrl: message.verificationUrl });
  }

  async enqueuePasswordReset(message: EnqueuePasswordResetMessage): Promise<void> {
    state.__datingPlatformE2eDeliveries?.push({ channel: "email", kind: "password-reset",
      to: message.to, resetUrl: message.resetUrl });
  }

  async enqueueSmsOtp(message: EnqueueSmsOtpMessage): Promise<void> {
    state.__datingPlatformE2eDeliveries?.push({ channel: "sms", kind: "otp", to: message.to, code: message.code });
  }

  async sendEmailVerification(message: EmailVerificationMessage): Promise<void> {
    state.__datingPlatformE2eDeliveries?.push({ channel: "email", kind: "verification", ...message });
  }

  async sendPasswordReset(message: PasswordResetMessage): Promise<void> {
    state.__datingPlatformE2eDeliveries?.push({ channel: "email", kind: "password-reset", ...message });
  }

  async sendSmsOtp(message: SmsOtpMessage): Promise<void> {
    state.__datingPlatformE2eDeliveries?.push({ channel: "sms", kind: "otp", ...message });
  }

  async sendTemplateNotification(): Promise<void> {}
}
