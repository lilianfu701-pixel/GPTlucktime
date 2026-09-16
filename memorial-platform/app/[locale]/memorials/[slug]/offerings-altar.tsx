"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { OfferingSummary } from "@/modules/offerings/display";

/* ────────────── Prop photos ────────────── */

/*
 * The three altar props are artwork (glowing dark-ground renders), shown as
 * rounded plaques so their dark backgrounds read as intentional. The context
 * (action button, censer stand, gallery card, modal) sizes each one in CSS.
 */
function IncensePhoto({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`altarPhoto altarPhotoIncense${className ? ` ${className}` : ""}`}
      src="/images/offerings/incense.webp"
      alt=""
      loading="lazy"
    />
  );
}

function CandlePhoto({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`altarPhoto altarPhotoCandle${className ? ` ${className}` : ""}`}
      src="/images/offerings/candle.webp"
      alt=""
      loading="lazy"
    />
  );
}

function WreathPhoto({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`altarPhoto altarPhotoWreath${className ? ` ${className}` : ""}`}
      src="/images/offerings/wreath.webp"
      alt=""
      loading="lazy"
    />
  );
}

/** A coin marked ¥ — the icon for the 捐款 action. */
function DonationIcon() {
  return (
    <svg
      className="altarDonateIcon"
      viewBox="0 0 48 48"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="24" cy="24" r="19" fill="#f3e6c4" stroke="#c5a35f" strokeWidth="2" />
      <circle cx="24" cy="24" r="14.5" fill="none" stroke="#d9c188" strokeWidth="1" />
      <text
        x="24"
        y="32"
        textAnchor="middle"
        fontFamily="Georgia, 'Songti SC', serif"
        fontSize="22"
        fontWeight="700"
        fill="#a8791f"
      >
        ¥
      </text>
    </svg>
  );
}

/**
 * A small bound bundle of lit incense sticks — the icon for the 上香 action,
 * so the button shows the incense itself rather than the censer.
 */
function IncenseBundle() {
  const n = 4;
  const centre = (n - 1) / 2;
  const sticks = Array.from({ length: n }, (_, i) => {
    const off = i - centre;
    const baseX = 26 + off * 1.6;
    const tipX = 26 + off * 7.4;
    const tipY = 13 + ((i * 5) % 9);
    return {
      baseX,
      tipX,
      tipY,
      ember: `${(i * 0.4).toFixed(1)}s`,
      smoke: `${(i * 0.7).toFixed(1)}s`,
    };
  });
  return (
    <svg
      className="altarBundle"
      viewBox="0 0 52 92"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <filter id="bundleSmoke" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="0.8" />
        </filter>
      </defs>
      {sticks.map((s, i) => {
        const redX = s.baseX + (s.tipX - s.baseX) * 0.28;
        const redY = 82 + (s.tipY - 82) * 0.28;
        return (
          <g key={i}>
            <line x1={s.baseX} y1={82} x2={s.tipX} y2={s.tipY} stroke="#c69a5c" strokeWidth="2" strokeLinecap="round" />
            <line x1={s.baseX} y1={82} x2={redX} y2={redY} stroke="#8f2016" strokeWidth="2.2" strokeLinecap="round" />
            <g transform={`translate(${s.tipX} ${s.tipY})`}>
              <path
                d="M0 0 q -4 -8 0 -16 q 4 -8 0 -14"
                stroke="#d2ccc0"
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
                filter="url(#bundleSmoke)"
                opacity="0"
              >
                <animate attributeName="opacity" values="0;0.4;0.28;0" keyTimes="0;0.3;0.72;1" dur="5s" begin={s.smoke} repeatCount="indefinite" />
                <animateTransform attributeName="transform" type="translate" values="0 0; -3 -14; 3 -30" keyTimes="0;0.5;1" dur="5s" begin={s.smoke} repeatCount="indefinite" />
              </path>
            </g>
            <circle cx={s.tipX} cy={s.tipY} r="2.3" fill="#ff7a2a">
              <animate attributeName="r" values="1.6;2.9;1.6" dur="1.8s" begin={s.ember} repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.75;1;0.75" dur="1.8s" begin={s.ember} repeatCount="indefinite" />
            </circle>
          </g>
        );
      })}
      {/* red binding paper near the base */}
      <rect x="17" y="77" width="18" height="8" rx="2.5" fill="#b23a2a" />
      <rect x="17" y="80" width="18" height="1.6" fill="#e6cf8f" opacity="0.85" />
    </svg>
  );
}

/**
 * Lit incense sticks planted in the censer's sand — one per offering. Rendered
 * over the censer photo (which ships with an empty sand bed), bases clustered
 * at the centre and tips fanning out, each with a glowing ember.
 */
function IncenseSticks({ count }: { count: number }) {
  const MAX = 12;
  const n = Math.min(count, MAX);
  const centre = (n - 1) / 2;
  const sticks = Array.from({ length: n }, (_, i) => {
    const off = i - centre;
    const baseX = 60 + off * 3.6; // bases a little more spread
    const tipX = 60 + off * 8.8; // tips fan wider
    const len = 108 + ((i * 13) % 22); // taller, so they clear the rim
    const tipY = 100 - len;
    return {
      baseX,
      tipX,
      tipY,
      ember: `${((i * 0.37) % 2.4).toFixed(2)}s`,
      smoke: `${((i * 0.73) % 3.2).toFixed(2)}s`,
    };
  });
  return (
    <svg
      className="censerSticks"
      viewBox="0 0 120 100"
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
    >
      <defs>
        <filter id="incenseSmoke" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="0.9" />
        </filter>
      </defs>
      {sticks.map((s, i) => {
        const redX = s.baseX + (s.tipX - s.baseX) * 0.3;
        const redY = 100 + (s.tipY - 100) * 0.3;
        return (
          <g key={i}>
            <line x1={s.baseX} y1={100} x2={s.tipX} y2={s.tipY} stroke="#c69a5c" strokeWidth="1.5" strokeLinecap="round" />
            <line x1={s.baseX} y1={100} x2={redX} y2={redY} stroke="#8f2016" strokeWidth="1.8" strokeLinecap="round" />
            {/* rising 青烟 */}
            <g transform={`translate(${s.tipX} ${s.tipY})`}>
              <path
                d="M0 0 q -5 -10 0 -20 q 5 -10 0 -18"
                stroke="#d2ccc0"
                strokeWidth="1.3"
                fill="none"
                strokeLinecap="round"
                filter="url(#incenseSmoke)"
                opacity="0"
              >
                <animate attributeName="opacity" values="0;0.36;0.26;0" keyTimes="0;0.28;0.72;1" dur="5.2s" begin={s.smoke} repeatCount="indefinite" />
                <animateTransform attributeName="transform" type="translate" values="0 0; -3 -16; 3 -34" keyTimes="0;0.5;1" dur="5.2s" begin={s.smoke} repeatCount="indefinite" />
              </path>
            </g>
            <circle cx={s.tipX} cy={s.tipY} r="2" fill="#ff7a2a">
              <animate attributeName="r" values="1.4;2.5;1.4" dur="1.8s" begin={s.ember} repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.72;1;0.72" dur="1.8s" begin={s.ember} repeatCount="indefinite" />
            </circle>
          </g>
        );
      })}
    </svg>
  );
}

/* ────────────── Display: 爱心捐款箱 ────────────── */

function DonationBox(props: {
  donors: {
    name: string | null;
    message: string | null;
    amountMinor: number;
    createdAt: Date;
  }[];
  total: number;
  totalAmount: number;
  t: (key: string, values?: Record<string, string | number | Date>) => string;
}) {
  if (props.total === 0) return null;

  const formatAmount = (amt: number) => `¥${(amt / 100).toFixed(0)}`;
  // Enough entries to be worth auto-scrolling; the list is duplicated so the
  // vertical loop is seamless.
  const shouldScroll = props.donors.length > 4;

  // Each donor is a compact pill (name · amount); the message rides along as a
  // tooltip so the row stays tight. Pills scroll horizontally as a ticker.
  const renderEntry = (
    d: (typeof props.donors)[number],
    i: number,
    prefix = "",
  ) => (
    <li
      key={`${prefix}${i}`}
      className="donationPill"
      title={d.message ?? undefined}
    >
      <span className="donationPillName">
        {d.name ? d.name : props.t("anonymousDonor")}
      </span>
      <span className="donationPillAmount">{formatAmount(d.amountMinor)}</span>
    </li>
  );

  return (
    <div className="donationBox">
      <div className="donationBoxHeader">
        <span className="donationBoxTitle">{props.t("donorWallTitle")}</span>
        <span className="donationBoxTotal">
          {props.t("donorWallTotal", {
            amount: (props.totalAmount / 100).toFixed(0),
          })}
        </span>
      </div>
      <div className="donationBoxViewport">
        <ul
          className={`donationBoxTrack${shouldScroll ? " donationBoxScrolling" : ""}`}
          style={
            shouldScroll
              ? ({
                  "--scroll-count": props.donors.length,
                } as React.CSSProperties)
              : undefined
          }
        >
          {props.donors.map((d, i) => renderEntry(d, i))}
          {shouldScroll
            ? props.donors.map((d, i) => renderEntry(d, i, "dup-"))
            : null}
        </ul>
      </div>
    </div>
  );
}

/* ────────────── Display: 蜡烛墙（三层螺旋） ────────────── */

type CandlePos = { layer: 1 | 2; side: "L" | "R"; slot: 1 | 2 | 3 | 4 | 5 };

/**
 * Where the n-th candle (oldest = index 0) sits. Slot 1 is nearest the censer,
 * slot 5 the outermost; layer 1 is the bottom row. Layer 1 fills inner→outer,
 * alternating sides; layer 2 then fills outer→inner. The 20th (newest when full)
 * lands at right-layer2-inner; a 21st pushes the oldest (left-layer1-inner) off.
 */
const CANDLE_SEQUENCE: CandlePos[] = [
  { layer: 1, side: "L", slot: 1 }, { layer: 1, side: "R", slot: 1 },
  { layer: 1, side: "L", slot: 2 }, { layer: 1, side: "R", slot: 2 },
  { layer: 1, side: "L", slot: 3 }, { layer: 1, side: "R", slot: 3 },
  { layer: 1, side: "L", slot: 4 }, { layer: 1, side: "R", slot: 4 },
  { layer: 1, side: "L", slot: 5 }, { layer: 1, side: "R", slot: 5 },
  { layer: 2, side: "L", slot: 5 }, { layer: 2, side: "R", slot: 5 },
  { layer: 2, side: "L", slot: 4 }, { layer: 2, side: "R", slot: 4 },
  { layer: 2, side: "L", slot: 3 }, { layer: 2, side: "R", slot: 3 },
  { layer: 2, side: "L", slot: 2 }, { layer: 2, side: "R", slot: 2 },
  { layer: 2, side: "L", slot: 1 }, { layer: 2, side: "R", slot: 1 },
];

const MAX_CANDLES = 20;

function CandleWall(props: {
  candles: { name: string | null; createdAt: Date }[];
  censer: React.ReactNode;
}) {
  // The summary is newest-first; keep the most recent 30 and lay them oldest-
  // first so each new candle takes the next position in the sequence.
  const recent = props.candles.slice(0, MAX_CANDLES).reverse();

  const left: React.ReactElement[] = [];
  const right: React.ReactElement[] = [];
  recent.forEach((candle, index) => {
    const pos = CANDLE_SEQUENCE[index];
    if (!pos) return;
    const gridRow = 3 - pos.layer; // layer 1 sits on the bottom row (of two)
    const gridColumn = pos.side === "L" ? 6 - pos.slot : pos.slot; // inner→censer
    const cell = (
      <div
        key={index}
        className="wallCandle"
        style={{ gridRow, gridColumn }}
        title={candle.name ?? undefined}
      >
        <span className="candleFlame" aria-hidden="true" />
        <CandlePhoto />
        {candle.name ? (
          <span className="wallCandleName">{candle.name}</span>
        ) : null}
      </div>
    );
    (pos.side === "L" ? left : right).push(cell);
  });

  return (
    <div className="altarPlatform">
      <div className="candleSide candleSideLeft">{left}</div>
      {props.censer}
      <div className="candleSide candleSideRight">{right}</div>
    </div>
  );
}

/* ────────────── Display: 花圈（带挽联飘带） ────────────── */

/** A wreath with its two hanging ribbons: the giver's name (left) and the
 * elegiac message (right), drawn over the wreath image. */
function AltarWreath(props: { name: string | null; message: string | null }) {
  const hasRibbons = Boolean(props.name || props.message);
  return (
    <div className="altarWreathFigure">
      <WreathPhoto className="altarWreathImg" />
      {hasRibbons ? (
        <div className="wreathRibbons" aria-hidden="true">
          {props.name ? (
            <span className="wreathRibbon wreathRibbonName">{props.name}</span>
          ) : null}
          {props.message ? (
            <span className="wreathRibbon wreathRibbonElegy">
              {props.message}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function WreathColumn(props: {
  side: "left" | "right";
  wreaths: { name: string | null; message: string | null }[];
}) {
  return (
    <div className={`altarWreathCol altarWreathCol-${props.side}`}>
      {props.wreaths.map((w, i) => (
        <AltarWreath key={i} name={w.name} message={w.message} />
      ))}
    </div>
  );
}

/** The overflow list: every wreath beyond the six shown flanking the portrait,
 * so all of them are recorded without crowding the altar. */
function WreathRoll(props: {
  wreaths: { name: string | null; message: string | null }[];
  total: number;
  t: (key: string, values?: Record<string, string | number | Date>) => string;
}) {
  if (props.wreaths.length === 0) return null;
  return (
    <div className="wreathRoll">
      <div className="wreathRollHeader">
        <span className="wreathRollTitle">{props.t("wreathRollTitle")}</span>
        <span className="wreathRollCount">（{props.total}）</span>
      </div>
      <ul className="wreathRollList">
        {props.wreaths.map((w, i) => (
          <li key={i} className="wreathRollEntry">
            <span className="wreathRollName">
              {w.name ? w.name : props.t("anonymousDonor")}
            </span>
            {w.message ? (
              <span className="wreathRollElegy">{w.message}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ────────────── Offering modal ────────────── */

type OfferKind = "candle" | "wreath" | "donation";

/* ────────────── Main ────────────── */

export function OfferingsAltar(props: {
  memorialId: string;
  summary: OfferingSummary;
  isLoggedIn: boolean;
  /** URL locale segment, so payment can route the visitor back here. */
  locale: string;
  /** The signed-in visitor's own profile name, prefilled when they offer. */
  viewerName?: string | null;
  /** The person's portrait, shown small at the centre of the altar tableau. */
  portrait?: string | null;
  /** A photo credit (author · licence · source), shown under an imported portrait. */
  portraitCredit?: string | null;
  /** The person's name, for the portrait's alt text. */
  personName: string;
  /** The details unit (name, dates, creator…), shown under the portrait. */
  details?: React.ReactNode;
  /**
   * Whether online payment is configured. When false (e.g. before PayPal keys
   * are set), a paid offering is recorded directly instead of failing, so the
   * after-offering page can be seen. It switches to real checkout automatically
   * once payment is enabled.
   */
  paymentEnabled: boolean;
  /**
   * The platform created this page and it is still waiting for a family to
   * claim it. While true, the paid offerings (candle/wreath/donation) are
   * closed; free incense stays open.
   */
  awaitingClaim?: boolean;
  /** Offering slugs the family has switched off (e.g. ["candle","donation"]). */
  disabledSlugs?: readonly string[];
}) {
  const t = useTranslations("offerings");
  const router = useRouter();
  const { summary } = props;

  const awaitingClaim = Boolean(props.awaitingClaim);
  const disabledSlugs = props.disabledSlugs ?? [];
  const PAID_SLUGS = ["candle", "wreath", "donation"];
  const isOff = (slug: string): boolean =>
    disabledSlugs.includes(slug) ||
    (awaitingClaim && PAID_SLUGS.includes(slug));

  const [modal, setModal] = useState<OfferKind | null>(null);
  const [name, setName] = useState("");
  const [masked, setMasked] = useState(true);
  const [message, setMessage] = useState("");
  const [amountYuan, setAmountYuan] = useState("");
  // A preset donation would lock its amount; a custom one stays editable. Kept
  // for the modal, though donations are custom-only now.
  const [amountFixed, setAmountFixed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<
    "ok" | "fail" | "unavailable" | "limited" | null
  >(null);
  const [wreathRollOpen, setWreathRollOpen] = useState(false);

  // Six wreaths flank the portrait (three a side); if there are more, a button
  // opens the full roll in a dialog.
  const flankingWreaths = summary.recentWreaths.slice(0, 6);
  const leftWreaths = flankingWreaths.slice(0, 3);
  const rightWreaths = flankingWreaths.slice(3, 6);

  async function post(payload: Record<string, unknown>, tag: string): Promise<boolean> {
    setPending(tag);
    setNotice(null);
    try {
      const res = await fetch(`/api/memorials/${props.memorialId}/offerings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const code = data?.error?.code;
        setNotice(
          code === "RATE_LIMITED"
            ? "limited"
            : code === "FEATURE_DISABLED"
              ? "unavailable"
              : "fail",
        );
        return false;
      }
      setNotice("ok");
      router.refresh();
      return true;
    } catch {
      setNotice("fail");
      return false;
    } finally {
      setPending(null);
    }
  }

  function openModal(
    kind: OfferKind,
    presetAmount?: number,
    fixed = false,
  ): void {
    // Prefill with the visitor's own name so lighting a candle (or any
    // offering) shows who it is from; they can edit, clear, or mask it.
    setName(props.viewerName ?? "");
    setMasked(false);
    setMessage(kind === "wreath" ? t("eulogyDefault") : "");
    if (kind === "donation") {
      setAmountYuan(presetAmount ? String(presetAmount) : "");
      setAmountFixed(fixed);
    }
    setNotice(null);
    setModal(kind);
  }

  async function offerIncense(): Promise<void> {
    // 上香 needs a signed-in identity so the one-per-day limit can apply.
    if (!props.isLoggedIn) {
      const next = encodeURIComponent(
        window.location.pathname + window.location.search,
      );
      window.location.href = `/${props.locale}/sign-in?next=${next}`;
      return;
    }
    await post({ slug: "incense" }, "incense");
  }

  /**
   * Sends a paid offering to PayPal. On success the browser leaves for PayPal;
   * the offering is only recorded once payment is captured, so nothing is
   * written here.
   *
   * When payment is not enabled yet, the offering is recorded directly through
   * the free path instead, so the after-offering page (altar + merit book) can
   * be tested without a real charge.
   */
  async function checkout(
    payload: Record<string, unknown>,
    tag: string,
  ): Promise<void> {
    if (!props.isLoggedIn) {
      // Come back to this memorial after signing in, not the home page.
      const next = encodeURIComponent(
        window.location.pathname + window.location.search,
      );
      window.location.href = `/${props.locale}/sign-in?next=${next}`;
      return;
    }

    if (!props.paymentEnabled) {
      const recorded = await post(payload, tag);
      if (recorded) setModal(null);
      return;
    }

    setPending(tag);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/memorials/${props.memorialId}/offerings/paypal`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, locale: props.locale }),
        },
      );
      const data = (await res.json().catch(() => null)) as {
        data?: { url?: string };
        error?: { code?: string };
      } | null;
      const url = data?.data?.url;
      if (res.ok && url) {
        window.location.href = url;
        return;
      }
      // FEATURE_DISABLED means online payment is not switched on for this
      // deployment yet; anything else is a genuine failure worth a retry.
      setNotice(data?.error?.code === "FEATURE_DISABLED" ? "unavailable" : "fail");
      setPending(null);
    } catch {
      setNotice("fail");
      setPending(null);
    }
  }

  async function submitModal(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!modal || pending) return;

    if (modal === "candle") {
      await checkout(
        { slug: "candle", name: name.trim() || undefined, masked },
        "candle",
      );
      return;
    }
    if (modal === "wreath") {
      await checkout(
        {
          slug: "wreath",
          name: name.trim() || undefined,
          message: message.trim() || undefined,
        },
        "wreath",
      );
      return;
    }
    // donation — minimum ¥99
    const yuan = Number(amountYuan);
    if (!Number.isFinite(yuan) || yuan < 99) {
      setNotice("fail");
      return;
    }
    await checkout(
      {
        slug: "donation",
        name: name.trim() || undefined,
        message: message.trim() || undefined,
        masked,
        amountMinor: Math.round(yuan * 100),
      },
      "donation",
    );
  }

  return (
    <section className="altarSection" aria-label={t("altarHeading")}>
      {/* Tableau: the portrait, small, flanked by up to three wreaths a side. */}
      <div className="altarStage">
        <WreathColumn side="left" wreaths={leftWreaths} />
        <div className="altarCentre">
          <div className="altarPortraitWrap">
            {props.portrait ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="altarPortrait"
                src={props.portrait}
                alt={props.personName}
                loading="lazy"
              />
            ) : (
              <div
                className="altarPortrait altarPortraitEmpty"
                aria-hidden="true"
              />
            )}
          </div>
          {props.portrait && props.portraitCredit ? (
            <p className="altarPortraitCredit">{props.portraitCredit}</p>
          ) : null}
          {props.details ? (
            <div className="altarDetails">{props.details}</div>
          ) : null}
        </div>
        <WreathColumn side="right" wreaths={rightWreaths} />
      </div>

      {/* Below the portrait: the censer, flanked by up to thirty candles. */}
      <CandleWall
        candles={summary.recentCandles}
        censer={
          <div className="altarCenserWrap">
            <div className="altarCenser">
              <IncensePhoto className="altarCenserPhoto" />
              {summary.incense > 0 ? (
                <IncenseSticks count={summary.incense} />
              ) : null}
            </div>
            {summary.incense > 0 ? (
              <span className="altarCenserCount">
                {t("incenseCount", { count: summary.incense })}
              </span>
            ) : null}
          </div>
        }
      />

      {summary.wreath > 6 ? (
        <div className="wreathRollActions">
          <button
            type="button"
            className="button buttonQuiet buttonCompact"
            onClick={() => setWreathRollOpen(true)}
          >
            {t("wreathRollTitle")}（{summary.wreath}）
          </button>
        </div>
      ) : null}

      <DonationBox
        donors={summary.recentDonations}
        total={summary.donation}
        totalAmount={summary.donationTotal}
        t={t}
      />

      {notice === "fail" ? (
        <p className="altarNoticeFail" role="alert">
          {t("offerFailed")}
        </p>
      ) : null}
      {notice === "unavailable" ? (
        <p className="altarNoticeFail" role="alert">
          {t("offerUnavailable")}
        </p>
      ) : null}
      {notice === "limited" ? (
        <p className="altarNoticeFail" role="alert">
          {t("incenseDailyLimit")}
        </p>
      ) : null}

      {/* Offering actions. When something is closed — a platform page awaiting a
       * family, or an offering the family switched off — the button stays
       * visible but greyed out and non-clickable, with the reason shown below. */}
      <div className="altarActions">
        <button
          type="button"
          className="altarActionBtn"
          onClick={offerIncense}
          disabled={pending === "incense" || isOff("incense")}
        >
          <IncenseBundle />
          <span className="altarActionLabel">{t("offerIncense")}</span>
          <span className="altarActionDesc">{t("descIncense")}</span>
        </button>

        <button
          type="button"
          className="altarActionBtn"
          onClick={() => openModal("candle")}
          disabled={isOff("candle")}
        >
          <CandlePhoto />
          <span className="altarActionLabel">{t("offerCandle")}</span>
          <span className="altarActionDesc">{t("descCandle")}</span>
        </button>

        <button
          type="button"
          className="altarActionBtn"
          onClick={() => openModal("wreath")}
          disabled={isOff("wreath")}
        >
          <WreathPhoto />
          <span className="altarActionLabel">{t("offerWreath")}</span>
          <span className="altarActionDesc">{t("descWreath")}</span>
        </button>

        <button
          type="button"
          className="altarActionBtn"
          onClick={() => openModal("donation")}
          disabled={isOff("donation")}
        >
          <DonationIcon />
          <span className="altarActionLabel">{t("donateTitle")}</span>
          <span className="altarActionDesc">{t("donateCustom")}</span>
        </button>
      </div>

      {/* Why some offerings above are greyed out. */}
      {awaitingClaim ? (
        <p className="altarNotice">{t("stewardNotice")}</p>
      ) : disabledSlugs.length > 0 ? (
        <p className="altarNotice">{t("ownerDisabledNotice")}</p>
      ) : null}

      {/* The "proceeds go to the family" note makes no sense on a page with no
       * family yet, so it yields to the stewardship notice. */}
      {awaitingClaim ? null : (
        <p className="altarFeeNote">{t("feeTransfer")}</p>
      )}

      {/* Modal */}
      {modal ? (
        <div
          className="altarModalOverlay"
          role="dialog"
          aria-modal="true"
          aria-label={t(
            modal === "candle"
              ? "modalCandleTitle"
              : modal === "wreath"
                ? "modalWreathTitle"
                : "modalDonateTitle",
          )}
          onClick={(e) => {
            if (e.target === e.currentTarget && !pending) setModal(null);
          }}
        >
          <form className="altarModalCard" onSubmit={submitModal}>
            <div className="altarModalIcon">
              {modal === "candle" ? <CandlePhoto /> : null}
              {modal === "wreath" ? <WreathPhoto /> : null}
            </div>
            <h3 className="altarModalTitle">
              {modal === "candle"
                ? t("modalCandleTitle")
                : modal === "wreath"
                  ? t("modalWreathTitle")
                  : t("modalDonateTitle")}
            </h3>

            {modal === "donation" ? (
              <div className="altarField">
                <span className="altarFieldLabel">{t("fieldAmount")}</span>
                {amountFixed ? (
                  <p className="altarAmountFixed">¥{amountYuan}</p>
                ) : (
                  <>
                    <input
                      className="altarInput"
                      type="number"
                      min="99"
                      step="1"
                      inputMode="numeric"
                      value={amountYuan}
                      onChange={(e) => setAmountYuan(e.target.value)}
                      placeholder="99"
                      required
                      autoFocus
                    />
                    <span className="altarFieldHint">{t("donateMin")}</span>
                  </>
                )}
              </div>
            ) : null}

            {modal === "wreath" ? (
              <label className="altarField">
                <span className="altarFieldLabel">{t("fieldEulogy")}</span>
                <textarea
                  className="altarInput"
                  rows={2}
                  maxLength={30}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={t("eulogyDefault")}
                  autoFocus
                />
                <span className="altarFieldHint">{message.length}/30</span>
              </label>
            ) : null}

            {/* Candle: the name is fixed to the signer's profile (not editable);
             * wreath and donation names can be typed/retyped. Both can be masked. */}
            <div className="altarField">
              <span className="altarFieldLabel">
                {modal === "candle" ? t("fieldNameLabel") : t("fieldNameOptional")}
              </span>
              {modal === "candle" ? (
                <p className="altarNameFixed">{name || t("anonymousDonor")}</p>
              ) : (
                <input
                  className="altarInput"
                  type="text"
                  maxLength={40}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </div>

            {modal === "donation" ? (
              <label className="altarField">
                <span className="altarFieldLabel">{t("fieldBlessing")}</span>
                <textarea
                  className="altarInput"
                  rows={2}
                  maxLength={200}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </label>
            ) : null}

            <label className="altarCheck">
              <input
                type="checkbox"
                checked={masked}
                onChange={(e) => setMasked(e.target.checked)}
              />
              <span>{t("maskOption")}</span>
            </label>

            {props.paymentEnabled ? (
              <p className="altarDevNote">{t("payNote")}</p>
            ) : null}

            {notice === "fail" ? (
              <p className="altarNoticeFail" role="alert">
                {t("offerFailed")}
              </p>
            ) : null}
            {notice === "unavailable" ? (
              <p className="altarNoticeFail" role="alert">
                {t("offerUnavailable")}
              </p>
            ) : null}

            <div className="altarModalActions">
              <button
                type="button"
                className="button buttonQuiet"
                onClick={() => setModal(null)}
                disabled={pending !== null}
              >
                {t("cancel")}
              </button>
              <button
                type="submit"
                className="button buttonPrimary"
                disabled={pending !== null}
              >
                {pending
                  ? t("lightingUp")
                  : modal === "donation"
                    ? t("submitDonate")
                    : t("submitOffer")}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* The full wreath roll, opened from the button above. */}
      {wreathRollOpen ? (
        <div
          className="altarModalOverlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("wreathRollTitle")}
          onClick={(e) => {
            if (e.target === e.currentTarget) setWreathRollOpen(false);
          }}
        >
          <div className="altarModalCard wreathRollCard">
            <WreathRoll
              wreaths={summary.recentWreaths}
              total={summary.wreath}
              t={t}
            />
            <div className="altarModalActions">
              <button
                type="button"
                className="button buttonQuiet"
                onClick={() => setWreathRollOpen(false)}
              >
                {t("close")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
