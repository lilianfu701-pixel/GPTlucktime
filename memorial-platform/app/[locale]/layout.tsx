import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { Geist, Lora } from "next/font/google";
import Link from "next/link";
import Script from "next/script";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { routing } from "@/i18n/routing";
import { textDirection } from "@/lib/locale";
import type { Locale } from "@/lib/locale";
import { siteUrl } from "@/lib/env";
import { NavSession } from "./nav-session";
import "../globals.css";

/**
 * Friendly links (友情链接) shown only in the Simplified-Chinese footer:
 * mainland government and sector bodies relevant to bereavement, ageing, law
 * and public records — outbound reference links, not affiliations.
 */
const CN_AGENCIES: readonly { name: string; url: string }[] = [
  { name: "中华人民共和国民政部", url: "https://www.mca.gov.cn" },
  { name: "中国政府网", url: "https://www.gov.cn" },
  { name: "国家统计局", url: "https://www.stats.gov.cn" },
  { name: "国家卫健委", url: "https://www.nhc.gov.cn" },
  { name: "退役军人事务部", url: "https://www.mva.gov.cn" },
  { name: "司法部", url: "https://www.moj.gov.cn" },
  { name: "人社部", url: "https://www.mohrss.gov.cn" },
  { name: "国家医保局", url: "https://www.nhsa.gov.cn" },
  { name: "财政部", url: "https://www.mof.gov.cn" },
  { name: "市场监管总局", url: "https://www.samr.gov.cn" },
  { name: "中华英烈网", url: "https://www.chinamartyrs.gov.cn" },
  { name: "中国殡葬协会", url: "https://www.chce.org.cn" },
  { name: "中国红十字会", url: "https://www.redcross.org.cn" },
  { name: "中华慈善总会", url: "https://www.chinacharityfederation.org" },
  { name: "中国残联", url: "https://www.cdpf.org.cn" },
  { name: "中国老龄协会", url: "https://www.cncaprc.gov.cn" },
  { name: "中国人口与发展研究中心", url: "https://www.cpdrc.org.cn" },
  { name: "中国疾控中心", url: "https://www.chinacdc.cn" },
  { name: "中国老龄科学研究中心", url: "https://www.crca.cn" },
  { name: "最高人民法院", url: "https://www.court.gov.cn" },
  { name: "中国法律服务网", url: "https://www.12348.gov.cn" },
  { name: "国家档案局", url: "https://www.saac.gov.cn" },
];

/** The site's ICP filing, shown only in the Simplified-Chinese footer. */
const CN_ICP = "京ICP备150395100号";

/**
 * SEO keywords for the Simplified-Chinese site. Led by 讣告 / 讣告格式 (obituary
 * and obituary format) alongside the core memorial terms. Applied site-wide via
 * the layout; other locales carry no keywords.
 */
const CN_KEYWORDS =
  "讣告, 讣告格式, 讣告范文, 网上追思, 网上纪念, 纪念网站, 追思网";

/*
 * Two families, both subset by next/font and self-hosted at build time. No
 * request leaves for a font provider: doc 06 keeps a visitor's presence on a
 * memorial page from being announced to a third party.
 */
const sans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const serif = Lora({
  subsets: ["latin", "cyrillic"],
  variable: "--font-serif",
  display: "swap",
});

export function generateStaticParams(): { locale: Locale }[] {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata(props: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await props.params;
  const t = await getTranslations({ locale, namespace: "common" });

  return {
    // Resolves every relative OG image / canonical / alternate to an absolute
    // URL, which Google requires.
    metadataBase: new URL(siteUrl()),
    title: t("appName"),
    // Keywords only for the Simplified-Chinese site; inherited by every zh-CN
    // page that doesn't set its own.
    ...(locale === "zh-CN" ? { keywords: CN_KEYWORDS } : {}),
  };
}

export default async function LocaleLayout(props: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;

  // The segment comes straight from the URL. Anything we do not serve is a 404
  // rather than a fallback, so a bad path cannot masquerade as a real page.
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);
  const messages = await getMessages();
  const nav = await getTranslations("nav");
  const a11y = await getTranslations("a11y");

  // Cloudflare Web Analytics beacon token (public value, injected at build).
  const cfBeaconToken = process.env.NEXT_PUBLIC_CF_BEACON_TOKEN;

  return (
    <html
      lang={locale}
      dir={textDirection(locale)}
      className={`${sans.variable} ${serif.variable}`}
    >
      <body>
        {cfBeaconToken ? (
          // Cloudflare Web Analytics — privacy-first, cookieless page-view and
          // referrer stats, visible in the Cloudflare dashboard. Public token.
          <Script
            src="https://static.cloudflareinsights.com/beacon.min.js"
            strategy="afterInteractive"
            data-cf-beacon={JSON.stringify({ token: cfBeaconToken })}
          />
        ) : null}
        <NextIntlClientProvider messages={messages}>
          <div className="shell">
            <a className="skipLink" href="#main">
              {a11y("skipToContent")}
            </a>

            <header className="siteHeader">
              <Link className="brand" href={`/${locale}`}>
                <img
                  className="brandLogo"
                  src="/images/logo.png"
                  alt="missingu.org"
                  width={360}
                  height={121}
                />
              </Link>

              <nav className="siteNav" aria-label={a11y("mainNavigation")}>
                <Link href={`/${locale}/search`}>{nav("search")}</Link>
                <NavSession locale={locale} />
              </nav>
            </header>

            {props.children}

            <footer className="siteFooter">
              <div className="footerTop">
                <span className="brand" aria-hidden="true">
                  <img
                    className="brandMark"
                    src="/icon.png"
                    alt=""
                    width={24}
                    height={24}
                  />
                  <span className="brandName">
                    missing<span className="brandAccent">u</span>
                  </span>
                </span>
                <span className="footerLinks">
                  <Link href={`/${locale}/support`}>{nav("support")}</Link>
                  <Link href={`/${locale}/help`}>{nav("help")}</Link>
                  <Link href={`/${locale}/contact`}>{nav("contact")}</Link>
                </span>
              </div>

              {locale === "zh-CN" ? (
                <>
                  <div className="footerAgencies">
                    <span className="footerAgenciesLabel">友情链接</span>
                    <span className="footerAgencyLinks">
                      {CN_AGENCIES.map((a, i) => (
                        <span key={a.url} className="footerAgencyItem">
                          <a
                            href={a.url}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                          >
                            {a.name}
                          </a>
                          {i < CN_AGENCIES.length - 1 ? (
                            <span className="footerSep" aria-hidden="true">
                              ｜
                            </span>
                          ) : null}
                        </span>
                      ))}
                    </span>
                  </div>
                  <div className="footerBeian">
                    <a
                      href="https://beian.miit.gov.cn/"
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                    >
                      {CN_ICP}
                    </a>
                  </div>
                </>
              ) : null}

              <div className="footerCopyright">
                © {new Date().getFullYear()} missingu.org
              </div>
            </footer>
          </div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
