import { env } from "@/lib/env";

export interface EmailProvider {
  sendLoginCode(input: {
    to: string;
    code: string;
    locale: string;
  }): Promise<void>;
}

/**
 * Development adapter. Prints the code instead of sending mail.
 *
 * Refuses to run in production: a misconfigured provider must stop sign-in
 * rather than quietly write every login code to the server log.
 */
export class ConsoleEmailProvider implements EmailProvider {
  async sendLoginCode(input: {
    to: string;
    code: string;
    locale: string;
  }): Promise<void> {
    if (env().NODE_ENV === "production") {
      throw new Error(
        "EMAIL_PROVIDER=console is not permitted in production. " +
          "Configure a real mail provider.",
      );
    }
    process.stdout.write(
      `[email:console] login code for ${input.to} (${input.locale}): ${input.code}\n`,
    );
    return Promise.resolve();
  }
}

/** Collects codes in memory. Tests read the last one instead of parsing output. */
export class InMemoryEmailProvider implements EmailProvider {
  readonly sent: { to: string; code: string; locale: string }[] = [];

  async sendLoginCode(input: {
    to: string;
    code: string;
    locale: string;
  }): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }

  lastCodeFor(to: string): string | undefined {
    return this.sent.filter((entry) => entry.to === to).at(-1)?.code;
  }
}

let configured: EmailProvider | null = null;

export function emailProvider(): EmailProvider {
  if (configured) {
    return configured;
  }

  const name = env().EMAIL_PROVIDER;
  switch (name) {
    case "console":
      configured = new ConsoleEmailProvider();
      return configured;
    case "memory":
      configured = new InMemoryEmailProvider();
      return configured;
    default:
      throw new Error(`Unsupported EMAIL_PROVIDER: ${name}`);
  }
}

/** Test seam. Replaces the configured adapter. */
export function setEmailProvider(provider: EmailProvider | null): void {
  configured = provider;
}
