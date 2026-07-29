import { env } from "@/lib/env";

export interface SmsProvider {
  sendLoginCode(input: {
    toE164: string;
    code: string;
    locale: string;
  }): Promise<void>;
}

/** Development adapter. Refuses to run in production, as with mail. */
export class ConsoleSmsProvider implements SmsProvider {
  async sendLoginCode(input: {
    toE164: string;
    code: string;
    locale: string;
  }): Promise<void> {
    if (env().NODE_ENV === "production") {
      throw new Error(
        "SMS_PROVIDER=console is not permitted in production. " +
          "Configure a real SMS provider.",
      );
    }
    process.stdout.write(
      `[sms:console] login code for ${input.toE164} (${input.locale}): ${input.code}\n`,
    );
    return Promise.resolve();
  }
}

export class InMemorySmsProvider implements SmsProvider {
  readonly sent: { toE164: string; code: string; locale: string }[] = [];

  async sendLoginCode(input: {
    toE164: string;
    code: string;
    locale: string;
  }): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }

  lastCodeFor(toE164: string): string | undefined {
    return this.sent.filter((entry) => entry.toE164 === toE164).at(-1)?.code;
  }
}

let configured: SmsProvider | null = null;

export function smsProvider(): SmsProvider {
  if (configured) {
    return configured;
  }

  const name = env().SMS_PROVIDER;
  switch (name) {
    case "console":
      configured = new ConsoleSmsProvider();
      return configured;
    case "memory":
      configured = new InMemorySmsProvider();
      return configured;
    default:
      throw new Error(`Unsupported SMS_PROVIDER: ${name}`);
  }
}

export function setSmsProvider(provider: SmsProvider | null): void {
  configured = provider;
}
