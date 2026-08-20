import { getRequestConfig } from "next-intl/server";

export type MessageLocale = "en" | "zh-CN";

export function resolveLocale(locale: string | undefined): MessageLocale {
  return locale === "zh" || locale?.toLowerCase() === "zh-cn" ? "zh-CN" : "en";
}

export default getRequestConfig(async ({ requestLocale }) => {
  const locale = resolveLocale(await requestLocale);
  const messages = locale === "zh-CN"
    ? (await import("../../messages/zh-CN.json")).default
    : (await import("../../messages/en.json")).default;
  return { locale, messages };
});
