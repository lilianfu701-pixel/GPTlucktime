"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

type Plan = { planRef: string; nameKey: string; descriptionKey: string; price: {
  currency: string; unitAmount: number; interval: "monthly" | "quarterly" | "yearly";
  intervalCount: number; taxMode: "inclusive" | "exclusive";
} };
type Subscription = { planRef: string; status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean };
const markets = {
  en: { country: "US", currency: "USD", intlLocale: "en-US" },
  zh: { country: "CN", currency: "CNY", intlLocale: "zh-CN" },
} as const;

const trustedCheckoutUrl = (url: URL) => (url.protocol === "https:"
  && (url.hostname === "stripe.com" || url.hostname.endsWith(".stripe.com")))
  || (url.origin === window.location.origin && url.pathname === "/api/e2e/stripe-checkout");

export function MembershipSettings({ locale, navigate = (url) => window.location.assign(url) }: {
  locale: "en" | "zh";
  navigate?: (url: string) => void;
}) {
  const t = useTranslations("membershipSettings");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "working" | "cancel-requested" | "error">("loading");
  const market = markets[locale];

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch(`/api/v1/plans?country=${market.country}&currency=${market.currency}&limit=20`, { method: "GET" }),
      fetch("/api/v1/me/subscription", { method: "GET" }),
    ]).then(async ([plansResponse, subscriptionResponse]) => {
      if (!plansResponse.ok || !subscriptionResponse.ok) throw new Error();
      const planBody = await plansResponse.json() as { plans?: Plan[] };
      const subscriptionBody = await subscriptionResponse.json() as { subscription?: Subscription | null };
      if (active) { setPlans(Array.isArray(planBody.plans) ? planBody.plans : []);
        setSubscription(subscriptionBody.subscription ?? null); setState("ready"); }
    }).catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [market.country, market.currency]);

  const planName = (planRef: string) => t.has(`planNames.${planRef}`) ? t(`planNames.${planRef}`) : planRef;
  const formatPrice = (plan: Plan) => new Intl.NumberFormat(market.intlLocale, {
    style: "currency", currency: plan.price.currency,
  }).format(plan.price.unitAmount / 100);

  async function checkout(plan: Plan) {
    setState("working");
    try {
      const response = await fetch("/api/v1/checkout-sessions", { method: "POST", headers: {
        "content-type": "application/json", "idempotency-key": `checkout-${crypto.randomUUID()}`,
      }, body: JSON.stringify({ planRef: plan.planRef, currency: plan.price.currency }) });
      const result = await response.json() as { checkoutUrl?: string };
      if (!response.ok || !result.checkoutUrl) throw new Error();
      const url = new URL(result.checkoutUrl);
      if (!trustedCheckoutUrl(url) || url.username || url.password) throw new Error();
      navigate(url.toString());
    } catch { setState("error"); }
  }

  async function cancelRenewal() {
    setState("working");
    try {
      const response = await fetch("/api/v1/me/subscription", { method: "PATCH", headers: {
        "content-type": "application/json", "idempotency-key": `subscription-${crypto.randomUUID()}`,
      }, body: JSON.stringify({ action: "cancel_at_period_end" }) });
      if (!response.ok) throw new Error();
      setSubscription((current) => current ? { ...current, cancelAtPeriodEnd: true } : current);
      setState("cancel-requested");
    } catch { setState("error"); }
  }

  return <div className="mt-8 space-y-8">
    <section aria-labelledby="current-membership">
      <h2 className="text-2xl font-semibold" id="current-membership">{t("current")}</h2>
      {state === "loading" ? <p aria-live="polite" className="mt-3">{t("loading")}</p>
        : subscription ? <div className="mt-3 rounded-2xl bg-rose-50 p-5">
          <p className="font-semibold">{planName(subscription.planRef)} · {t(`statuses.${subscription.status}`)}</p>
          {subscription.currentPeriodEnd && <p className="mt-1 text-sm text-stone-600">{t("periodEnd", { date: new Intl.DateTimeFormat(market.intlLocale, { dateStyle: "medium" }).format(new Date(subscription.currentPeriodEnd)) })}</p>}
          {subscription.cancelAtPeriodEnd ? <p className="mt-3 text-sm text-stone-700">{t("renewalCanceled")}</p>
            : <button className="datecn-ghost-button mt-4" disabled={state === "working"} onClick={cancelRenewal} type="button">{t("cancelRenewal")}</button>}
        </div> : <p className="mt-3 text-stone-600">{t("freeStatus")}</p>}
    </section>
    <section aria-labelledby="available-plans">
      <h2 className="text-2xl font-semibold" id="available-plans">{t("plans")}</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{plans.map((plan) => <article className="rounded-2xl border border-rose-100 p-5" key={plan.planRef}>
        <h3 className="text-xl font-bold capitalize">{planName(plan.planRef)}</h3>
        <p className="mt-2 text-lg font-semibold">{formatPrice(plan)} {t(`intervals.${plan.price.interval}`)}</p>
        <p className="mt-2 text-sm text-stone-600">{plan.price.taxMode === "inclusive" ? t("taxIncluded") : t("taxCalculated")}</p>
        <button className="datecn-primary-button mt-5 text-sm" disabled={state === "working" || subscription?.status === "active"} onClick={() => checkout(plan)} type="button">{t("choose", { plan: planName(plan.planRef) })}</button>
      </article>)}</div>
      {state === "ready" && plans.length === 0 && <p className="mt-4 text-stone-600">{t("noPlans")}</p>}
    </section>
    <p aria-live="polite" className={`min-h-6 text-sm ${state === "error" ? "text-red-700" : "text-emerald-800"}`} role={state === "error" ? "alert" : "status"}>{state === "cancel-requested" ? t("cancelRequested") : state === "error" ? t("error") : ""}</p>
  </div>;
}
