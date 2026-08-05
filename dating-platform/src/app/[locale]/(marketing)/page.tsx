import Link from "next/link";

const copy = {
  en: {
    eyebrow: "Meet beyond borders",
    title: "Start a conversation that could go somewhere meaningful.",
    description:
      "Heartline is a welcoming place to discover people, share your story, and build genuine international connections at your own pace.",
    primary: "Create your profile",
    secondary: "Explore how it works",
    language: "简体中文",
  },
  zh: {
    eyebrow: "跨越距离，遇见彼此",
    title: "从一次真诚的交流开始，认识值得了解的人。",
    description:
      "Heartline 为期待认真关系的人提供友好空间，让你按照自己的节奏展示自我、认识新朋友，并建立真实的跨国连接。",
    primary: "创建个人资料",
    secondary: "了解使用方式",
    language: "English",
  },
} as const;

type MarketingPageProps = {
  params: Promise<{ locale: string }>;
};

export default async function MarketingPage({ params }: MarketingPageProps) {
  const { locale } = await params;
  const currentLocale = locale === "zh" ? "zh" : "en";
  const content = copy[currentLocale];
  const alternateLocale = currentLocale === "zh" ? "en" : "zh";

  return (
    <main className="min-h-screen bg-rose-50 text-stone-900">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <span className="text-xl font-semibold tracking-tight">Heartline</span>
        <Link
          className="rounded-full border border-rose-200 bg-white px-4 py-2 text-sm font-medium hover:border-rose-300"
          href={`/${alternateLocale}`}
        >
          {content.language}
        </Link>
      </nav>

      <section className="mx-auto flex max-w-6xl flex-col items-start px-6 py-24 sm:py-32">
        <p className="mb-5 text-sm font-semibold uppercase tracking-[0.2em] text-rose-700">
          {content.eyebrow}
        </p>
        <h1 className="max-w-4xl text-5xl font-semibold leading-tight tracking-tight sm:text-7xl">
          {content.title}
        </h1>
        <p className="mt-8 max-w-2xl text-lg leading-8 text-stone-600">
          {content.description}
        </p>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <a className="rounded-full bg-rose-700 px-6 py-3 font-semibold text-white hover:bg-rose-800" href="#join">
            {content.primary}
          </a>
          <a className="rounded-full bg-white px-6 py-3 font-semibold text-stone-800 hover:bg-rose-100" href="#how-it-works">
            {content.secondary}
          </a>
        </div>
      </section>
    </main>
  );
}
