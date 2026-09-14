/**
 * Long-tail content guides — evergreen articles that target searches around the
 * memorial domain (eulogy, condolence message, funeral couplets) and lead the
 * reader on to creating a memorial or publishing an obituary.
 *
 * Content lives here as plain data (not next-intl namespaces) so a growing set
 * of articles doesn't force a full 15-locale translation of every one: each
 * guide is authored in the languages that matter for the topic, and the route
 * falls back to English, then Simplified Chinese. These topics are specific to
 * Chinese funeral custom, so the Chinese variants carry the real content.
 */
export type GuideSection = { heading: string; body: string };

export type GuideContent = {
  title: string;
  description: string;
  intro: string;
  sections: GuideSection[];
  /** An optional worked example / template block, newline-separated. */
  examplesTitle?: string;
  examplesNote?: string;
  examples?: string;
  ctaTitle: string;
  ctaButton: string;
  /** Relative path (no leading slash) the CTA links to, after `/{locale}/`. */
  ctaHref: string;
};

export type Guide = {
  slug: string;
  /** Keyed by locale. Not every locale need be present — see `guideContent`. */
  content: Record<string, GuideContent>;
};

// ── 悼词 / eulogy ──────────────────────────────────────────────────────────
const EULOGY_CN: GuideContent = {
  title: "悼词怎么写：结构、要点与范文",
  description: "悼词（追悼词）的写法与范文：基本结构、撰写要点，附一篇可套用的悼词模板。",
  intro:
    "悼词，也称追悼词，是在追悼会或告别仪式上宣读、缅怀逝者的文章。本文说明悼词的基本结构与撰写要点，并附一篇可直接套用的范文。",
  sections: [
    {
      heading: "什么是悼词",
      body:
        "悼词是在追悼会上代表家属或单位宣读的缅怀文章，回顾逝者生平、追述其品格与贡献，寄托哀思、告慰亲属。语气庄重恳切，篇幅一般控制在三到五分钟。",
    },
    {
      heading: "悼词的基本结构",
      body:
        "通常分三部分：开头，交代宣读者身份、场合与逝者姓名、逝世时间；主体，回顾逝者生平经历、品德与感人事迹，是全篇重点；结尾，表达哀悼与不舍、告慰家属，并寄语生者。",
    },
    {
      heading: "撰写要点",
      body:
        "以事显情、真挚具体，避免空话套话；姓名、时间、称谓务必准确；语气庄重、克制；写好后请家人一起核对。",
    },
  ],
  examplesTitle: "悼词范文（节选）",
  examplesNote: "把范文中的信息替换成实际内容即可：",
  examples: [
    "各位亲友：",
    "今天，我们怀着极其沉痛的心情，深切悼念 ×××先生。",
    "×××先生于二〇××年××月××日不幸辞世，享年××岁。他勤恳一生、待人宽厚，……（回顾生平与事迹）。",
    "斯人已逝，风范长存。愿逝者安息，愿家属节哀。",
  ].join("\n"),
  ctaTitle: "在追思网免费为逝者建立追思页",
  ctaButton: "建立追思页",
  ctaHref: "memorials/new",
};

const EULOGY_HANT: GuideContent = {
  title: "悼詞怎麼寫：結構、要點與範文",
  description: "悼詞（追悼詞）的寫法與範文：基本結構、撰寫要點，附一篇可套用的悼詞模板。",
  intro:
    "悼詞，也稱追悼詞，是在追悼會或告別儀式上宣讀、緬懷逝者的文章。本文說明悼詞的基本結構與撰寫要點，並附一篇可直接套用的範文。",
  sections: [
    {
      heading: "什麼是悼詞",
      body:
        "悼詞是在追悼會上代表家屬或單位宣讀的緬懷文章，回顧逝者生平、追述其品格與貢獻，寄託哀思、告慰親屬。語氣莊重懇切，篇幅一般控制在三到五分鐘。",
    },
    {
      heading: "悼詞的基本結構",
      body:
        "通常分三部分：開頭，交代宣讀者身份、場合與逝者姓名、逝世時間；主體，回顧逝者生平經歷、品德與感人事蹟，是全篇重點；結尾，表達哀悼與不捨、告慰家屬，並寄語生者。",
    },
    {
      heading: "撰寫要點",
      body:
        "以事顯情、真摯具體，避免空話套話；姓名、時間、稱謂務必準確；語氣莊重、克制；寫好後請家人一起核對。",
    },
  ],
  examplesTitle: "悼詞範文（節選）",
  examplesNote: "把範文中的資訊替換成實際內容即可：",
  examples: [
    "各位親友：",
    "今天，我們懷著極其沉痛的心情，深切悼念 ×××先生。",
    "×××先生於二〇××年××月××日不幸辭世，享年××歲。他勤懇一生、待人寬厚，……（回顧生平與事蹟）。",
    "斯人已逝，風範長存。願逝者安息，願家屬節哀。",
  ].join("\n"),
  ctaTitle: "在追思網免費為逝者建立追思頁",
  ctaButton: "建立追思頁",
  ctaHref: "memorials/new",
};

const EULOGY_EN: GuideContent = {
  title: "How to write a eulogy: structure, tips and an example",
  description:
    "How to write a eulogy: the basic structure, what to include, and a short example you can adapt.",
  intro:
    "A eulogy is a tribute read at a memorial or funeral service that remembers the person and honours their life. This guide covers its structure and the points to keep in mind, with a short example.",
  sections: [
    {
      heading: "What is a eulogy?",
      body:
        "A eulogy is a spoken tribute that looks back on the person's life, character and the things they were loved for, offering comfort to the family. Keep the tone sincere and the length to a few minutes.",
    },
    {
      heading: "A simple structure",
      body:
        "Open by saying who you are and naming the person; in the middle, tell their story through a few real memories and qualities; close with words of farewell and comfort for the family.",
    },
    {
      heading: "Tips",
      body:
        "Show, don't tell — use specific memories. Get names and dates right, keep the tone dignified, and read it aloud once before the day.",
    },
  ],
  ctaTitle: "Create a free memorial page on missingu.org",
  ctaButton: "Create a memorial",
  ctaHref: "memorials/new",
};

// ── 唁电 / condolence message ──────────────────────────────────────────────
const CONDOLENCE_CN: GuideContent = {
  title: "唁电怎么写：格式与范文",
  description: "唁电（吊唁电文）的格式与范文：称谓、正文、落款怎么写，附可套用的唁电模板。",
  intro:
    "唁电是得知噩耗后，向治丧家属发去的简短吊唁文字，表达沉痛哀悼与慰问。本文说明唁电的格式与写法，并附范文。",
  sections: [
    {
      heading: "什么是唁电",
      body:
        "唁电（也称吊唁电、唁函）是向逝者家属发送的简短吊唁通讯，用于因故不能亲往吊唁时，及时表达哀悼与对家属的宽慰。",
    },
    {
      heading: "唁电的格式",
      body:
        "一般包含：称谓，写明致某某及其家属；正文，惊悉某某逝世表示沉痛哀悼，简述对逝者的敬意或情谊，并宽慰家属；落款，署发唁人姓名与日期。",
    },
    {
      heading: "撰写要点",
      body:
        "简短庄重、情真意切；措辞得体、避免口语；及时发送；核对逝者姓名与家属称谓。",
    },
  ],
  examplesTitle: "唁电范文",
  examplesNote: "替换其中的信息即可：",
  examples: [
    "×××先生暨家属：",
    "惊悉 ×××先生不幸逝世，我们深感悲痛，谨致以沉痛的哀悼，并向家属表示诚挚的慰问。",
    "×××先生生前……（简述情谊或评价）。望家属节哀顺变，保重身体。",
    "×××（单位/个人）　敬唁",
    "二〇××年××月××日",
  ].join("\n"),
  ctaTitle: "在追思页在线献花、留言吊唁",
  ctaButton: "查找追思页",
  ctaHref: "search",
};

const CONDOLENCE_HANT: GuideContent = {
  title: "唁電怎麼寫：格式與範文",
  description: "唁電（弔唁電文）的格式與範文：稱謂、正文、落款怎麼寫，附可套用的唁電模板。",
  intro:
    "唁電是得知噩耗後，向治喪家屬發去的簡短弔唁文字，表達沉痛哀悼與慰問。本文說明唁電的格式與寫法，並附範文。",
  sections: [
    {
      heading: "什麼是唁電",
      body:
        "唁電（也稱弔唁電、唁函）是向逝者家屬發送的簡短弔唁通訊，用於因故不能親往弔唁時，及時表達哀悼與對家屬的寬慰。",
    },
    {
      heading: "唁電的格式",
      body:
        "一般包含：稱謂，寫明致某某及其家屬；正文，驚悉某某逝世表示沉痛哀悼，簡述對逝者的敬意或情誼，並寬慰家屬；落款，署發唁人姓名與日期。",
    },
    {
      heading: "撰寫要點",
      body:
        "簡短莊重、情真意切；措辭得體、避免口語；及時發送；核對逝者姓名與家屬稱謂。",
    },
  ],
  examplesTitle: "唁電範文",
  examplesNote: "替換其中的資訊即可：",
  examples: [
    "×××先生暨家屬：",
    "驚悉 ×××先生不幸逝世，我們深感悲痛，謹致以沉痛的哀悼，並向家屬表示誠摯的慰問。",
    "×××先生生前……（簡述情誼或評價）。望家屬節哀順變，保重身體。",
    "×××（單位/個人）　敬唁",
    "二〇××年××月××日",
  ].join("\n"),
  ctaTitle: "在追思頁在線獻花、留言弔唁",
  ctaButton: "查找追思頁",
  ctaHref: "search",
};

const CONDOLENCE_EN: GuideContent = {
  title: "How to write a condolence message",
  description:
    "How to write a short, heartfelt condolence message to a grieving family, with an example.",
  intro:
    "A condolence message is a short note of sympathy sent to the bereaved family. This guide covers what to say and how to say it, with an example.",
  sections: [
    {
      heading: "What to include",
      body:
        "Address the family, express your sorrow at the loss, say a kind word about the person, and offer comfort and support. Keep it short and sincere.",
    },
    {
      heading: "Tips",
      body:
        "Send it promptly, use the person's name, avoid clichés, and don't try to explain the loss — presence and warmth matter more than words.",
    },
  ],
  examplesTitle: "Example",
  examplesNote: "Adapt the details:",
  examples: [
    "Dear [family],",
    "We were deeply saddened to hear of [name]'s passing. Please accept our heartfelt condolences.",
    "[Name] will be remembered for [a quality or memory]. Our thoughts are with you at this difficult time.",
    "With sympathy, [your name]",
  ].join("\n"),
  ctaTitle: "Leave flowers and a message on a memorial page",
  ctaButton: "Find a memorial",
  ctaHref: "search",
};

// ── 挽联 / funeral couplets ────────────────────────────────────────────────
const COUPLETS_CN: GuideContent = {
  title: "挽联怎么写：格式、对仗与大全",
  description: "挽联的写法与大全：上下联对仗、横批，附通用挽联与挽父母、挽长辈的范例。",
  intro:
    "挽联是哀悼逝者的对联，由上联、下联和横批组成，讲究对仗工整。本文说明挽联的格式与写法，并附常用挽联与横批范例。",
  sections: [
    {
      heading: "什么是挽联",
      body:
        "挽联是用于丧礼、哀悼逝者的对联，悬于灵堂两侧或花圈之上，多写逝者的德行、生平，或挽者与逝者的情谊，表达哀思。",
    },
    {
      heading: "挽联的格式与对仗",
      body:
        "上联与下联字数相等、词性相对、平仄相协；上联末字多为仄声，下联末字多为平声。内容庄重贴切，横批点明主题，如「永垂不朽」「音容宛在」「德泽长存」。",
    },
  ],
  examplesTitle: "常用挽联与横批（大全）",
  examplesNote: "可按与逝者的关系选用，×处填姓名或事迹：",
  examples: [
    "【通用】上联：音容宛在　下联：风范长存　横批：永垂不朽",
    "【通用】上联：一生俭朴留典范　下联：半世勤劳传家风　横批：德泽长存",
    "【挽父】上联：严父一生勤与俭　下联：儿孙满堂孝而思　横批：音容宛在",
    "【挽母】上联：慈母一生垂典范　下联：儿女千行念养恩　横批：懿德长存",
    "【横批常用】永垂不朽　音容宛在　浩气长存　德泽长存　鹤驾西归",
  ].join("\n"),
  ctaTitle: "在追思网免费建立追思页",
  ctaButton: "建立追思页",
  ctaHref: "memorials/new",
};

const COUPLETS_HANT: GuideContent = {
  title: "輓聯怎麼寫：格式、對仗與大全",
  description: "輓聯的寫法與大全：上下聯對仗、橫批，附通用輓聯與輓父母、輓長輩的範例。",
  intro:
    "輓聯是哀悼逝者的對聯，由上聯、下聯和橫批組成，講究對仗工整。本文說明輓聯的格式與寫法，並附常用輓聯與橫批範例。",
  sections: [
    {
      heading: "什麼是輓聯",
      body:
        "輓聯是用於喪禮、哀悼逝者的對聯，懸於靈堂兩側或花圈之上，多寫逝者的德行、生平，或輓者與逝者的情誼，表達哀思。",
    },
    {
      heading: "輓聯的格式與對仗",
      body:
        "上聯與下聯字數相等、詞性相對、平仄相協；上聯末字多為仄聲，下聯末字多為平聲。內容莊重貼切，橫批點明主題，如「永垂不朽」「音容宛在」「德澤長存」。",
    },
  ],
  examplesTitle: "常用輓聯與橫批（大全）",
  examplesNote: "可按與逝者的關係選用，×處填姓名或事蹟：",
  examples: [
    "【通用】上聯：音容宛在　下聯：風範長存　橫批：永垂不朽",
    "【通用】上聯：一生儉樸留典範　下聯：半世勤勞傳家風　橫批：德澤長存",
    "【輓父】上聯：嚴父一生勤與儉　下聯：兒孫滿堂孝而思　橫批：音容宛在",
    "【輓母】上聯：慈母一生垂典範　下聯：兒女千行念養恩　橫批：懿德長存",
    "【橫批常用】永垂不朽　音容宛在　浩氣長存　德澤長存　鶴駕西歸",
  ].join("\n"),
  ctaTitle: "在追思網免費建立追思頁",
  ctaButton: "建立追思頁",
  ctaHref: "memorials/new",
};

const COUPLETS_EN: GuideContent = {
  title: "Chinese funeral couplets (wǎnlián): format and examples",
  description:
    "Chinese funeral couplets (wǎnlián): how the paired lines and header work, with common examples.",
  intro:
    "A funeral couplet (wǎnlián) is a pair of mourning lines with a header, hung in the memorial hall. This guide explains the form and gives common examples.",
  sections: [
    {
      heading: "What is a funeral couplet?",
      body:
        "Two matched lines — equal in length, parallel in structure and balanced in tone — praising the person's character or life, topped by a short header such as 永垂不朽 (“forever remembered”).",
    },
  ],
  examplesTitle: "Common examples",
  examplesNote: "Header, then the paired lines:",
  examples: [
    "永垂不朽 — 音容宛在 / 风范长存",
    "德泽长存 — 一生俭朴留典范 / 半世勤劳传家风",
  ].join("\n"),
  ctaTitle: "Create a free memorial page on missingu.org",
  ctaButton: "Create a memorial",
  ctaHref: "memorials/new",
};

export const GUIDES: Guide[] = [
  {
    slug: "eulogy",
    content: {
      "zh-CN": EULOGY_CN,
      "zh-TW": EULOGY_HANT,
      "zh-HK": EULOGY_HANT,
      en: EULOGY_EN,
    },
  },
  {
    slug: "condolence-message",
    content: {
      "zh-CN": CONDOLENCE_CN,
      "zh-TW": CONDOLENCE_HANT,
      "zh-HK": CONDOLENCE_HANT,
      en: CONDOLENCE_EN,
    },
  },
  {
    slug: "funeral-couplets",
    content: {
      "zh-CN": COUPLETS_CN,
      "zh-TW": COUPLETS_HANT,
      "zh-HK": COUPLETS_HANT,
      en: COUPLETS_EN,
    },
  },
];

/** "See also" heading per locale; falls back to English. */
export const RELATED_LABEL: Record<string, string> = {
  "zh-CN": "相关内容",
  "zh-TW": "相關內容",
  "zh-HK": "相關內容",
  en: "See also",
  es: "Ver también",
  "pt-BR": "Veja também",
  "pt-PT": "Ver também",
  fr: "À voir aussi",
  de: "Siehe auch",
  ar: "انظر أيضًا",
  ja: "関連記事",
  ru: "См. также",
  id: "Lihat juga",
  vi: "Xem thêm",
  ko: "함께 보기",
};

export function findGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

/** The content for a locale, falling back to English then Simplified Chinese. */
export function guideContent(guide: Guide, locale: string): GuideContent {
  return (
    guide.content[locale] ??
    guide.content.en ??
    guide.content["zh-CN"] ??
    Object.values(guide.content)[0]!
  );
}

/** The title to show for a guide in a given locale (for cross-links). */
export function guideTitle(guide: Guide, locale: string): string {
  return guideContent(guide, locale).title;
}
