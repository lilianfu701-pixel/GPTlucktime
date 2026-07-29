import { defineRouting } from "next-intl/routing";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@/lib/locale";

export const routing = defineRouting({
  locales: SUPPORTED_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  // Every page carries its locale in the path, including English. A memorial
  // link shared into a family group chat should open in the same language for
  // everyone who follows it.
  localePrefix: "always",
  localeDetection: true,
});
