import { Resend } from "resend";

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

const subjectByLocale: Record<string, string> = {
  en: "Your sign-in code",
  "zh-CN": "您的登录验证码",
  "zh-TW": "您的登入驗證碼",
  "zh-HK": "您的登入驗證碼",
  es: "Tu código de inicio de sesión",
  "pt-BR": "Seu código de acesso",
  "pt-PT": "O seu código de acesso",
  fr: "Votre code de connexion",
  de: "Ihr Anmeldecode",
  ar: "رمز تسجيل الدخول",
  ja: "ログインコード",
  ru: "Ваш код для входа",
  id: "Kode masuk Anda",
  vi: "Mã đăng nhập của bạn",
  ko: "로그인 코드",
};

export class ResendEmailProvider implements EmailProvider {
  private readonly client: Resend;
  private readonly from: string;

  constructor() {
    const config = env();
    const apiKey = config.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error(
        "RESEND_API_KEY is required when EMAIL_PROVIDER=resend",
      );
    }
    this.client = new Resend(apiKey);
    this.from = config.RESEND_FROM_ADDRESS ?? "noreply@missingu.org";
  }

  async sendLoginCode(input: {
    to: string;
    code: string;
    locale: string;
  }): Promise<void> {
    const subject =
      subjectByLocale[input.locale] ?? subjectByLocale["en"] ?? "Your sign-in code";
    const { error } = await this.client.emails.send({
      from: this.from,
      to: input.to,
      subject,
      html: this.renderHtml(input.code, input.locale),
    });
    if (error) {
      throw new Error(`Resend send failed: ${error.message}`);
    }
  }

  private renderHtml(code: string, locale: string): string {
    const dir = locale === "ar" ? "rtl" : "ltr";
    return [
      `<!doctype html>`,
      `<html lang="${locale}" dir="${dir}">`,
      `<head><meta charset="utf-8"></head>`,
      `<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fbf6eb;color:#253027;padding:40px 20px;margin:0">`,
      `<div style="max-width:420px;margin:0 auto">`,
      `<p style="font-size:15px;line-height:1.6;margin:0 0 24px">${subject(locale)}</p>`,
      `<div style="font-size:32px;letter-spacing:0.3em;font-weight:600;text-align:center;padding:20px;background:#fff;border-radius:8px;border:1px solid #e5dfd4">${code}</div>`,
      `<p style="font-size:13px;color:#6b6b5e;margin:24px 0 0">${expiry(locale)}</p>`,
      `</div>`,
      `</body></html>`,
    ].join("");
  }
}

function subject(locale: string): string {
  const map: Record<string, string> = {
    en: "Enter this code to sign in:",
    "zh-CN": "请输入以下验证码登录：",
    "zh-TW": "請輸入以下驗證碼登入：",
    "zh-HK": "請輸入以下驗證碼登入：",
    es: "Ingresa este código para iniciar sesión:",
    "pt-BR": "Digite este código para entrar:",
    "pt-PT": "Introduza este código para entrar:",
    fr: "Entrez ce code pour vous connecter :",
    de: "Geben Sie diesen Code ein, um sich anzumelden:",
    ar: "أدخل هذا الرمز لتسجيل الدخول:",
    ja: "このコードを入力してログインしてください：",
    ru: "Введите этот код для входа:",
    id: "Masukkan kode ini untuk masuk:",
    vi: "Nhập mã này để đăng nhập:",
    ko: "이 코드를 입력하여 로그인하세요:",
  };
  return map[locale] ?? map["en"] ?? "Enter this code to sign in:";
}

function expiry(locale: string): string {
  const map: Record<string, string> = {
    en: "This code expires in 10 minutes.",
    "zh-CN": "验证码 10 分钟内有效。",
    "zh-TW": "驗證碼 10 分鐘內有效。",
    "zh-HK": "驗證碼 10 分鐘內有效。",
    es: "Este código caduca en 10 minutos.",
    "pt-BR": "Este código expira em 10 minutos.",
    "pt-PT": "Este código expira em 10 minutos.",
    fr: "Ce code expire dans 10 minutes.",
    de: "Dieser Code ist 10 Minuten gültig.",
    ar: "تنتهي صلاحية هذا الرمز خلال 10 دقائق.",
    ja: "このコードは 10 分間有効です。",
    ru: "Код действителен 10 минут.",
    id: "Kode ini berlaku selama 10 menit.",
    vi: "Mã này có hiệu lực trong 10 phút.",
    ko: "이 코드는 10분 동안 유효합니다.",
  };
  return map[locale] ?? map["en"] ?? "This code expires in 10 minutes.";
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
    case "resend":
      configured = new ResendEmailProvider();
      return configured;
    default:
      throw new Error(`Unsupported EMAIL_PROVIDER: ${name}`);
  }
}

/** Test seam. Replaces the configured adapter. */
export function setEmailProvider(provider: EmailProvider | null): void {
  configured = provider;
}
