/**
 * Resolves a curated list of clan-patriarch names to Wikidata QIDs, printing the
 * top human match with its description so the ids can be eyeballed before any
 * fetch. Not part of the app — a one-off authoring aid.
 *
 *   npx tsx scripts/resolve-family-qids.ts
 */
const API = "https://www.wikidata.org/w/api.php";
const UA = "missingu-genealogy/1.0 (https://missingu.org)";

/** key → the most-connected member of the clan (usually the patriarch). */
const CANDIDATES: { key: string; name: string; era: string }[] = [
  // 古代 / 中古
  { key: "caocao", name: "曹操", era: "汉末三国" },
  { key: "simaguang", name: "司马光", era: "北宋" },
  { key: "wangxizhi", name: "王羲之", era: "东晋·琅琊王氏" },
  { key: "sushi", name: "苏轼", era: "北宋·眉山苏氏" },
  { key: "ouyangxiu", name: "欧阳修", era: "北宋" },
  { key: "zhuxi", name: "朱熹", era: "南宋" },
  { key: "wangyangming", name: "王守仁", era: "明·余姚王氏" },
  { key: "zhugeliang", name: "诸葛亮", era: "三国" },
  { key: "dufu", name: "杜甫", era: "唐" },
  { key: "kongzi", name: "孔丘", era: "春秋·孔子世家" },
  { key: "mingimperial", name: "朱元璋", era: "明皇室" },
  { key: "tangimperial", name: "李世民", era: "唐皇室·陇西李氏" },
  // 近代
  { key: "linzexu", name: "林则徐", era: "清" },
  { key: "zuozongtang", name: "左宗棠", era: "清" },
  { key: "zhangzhidong", name: "张之洞", era: "清" },
  { key: "wengtonghe", name: "翁同龢", era: "清·常熟翁氏" },
  { key: "kangyouwei", name: "康有为", era: "清末" },
  { key: "yanfu", name: "严复", era: "清末" },
  { key: "tansitong", name: "谭嗣同", era: "清末" },
  { key: "caiyuanpei", name: "蔡元培", era: "清末民初" },
  { key: "zhangtaiyan", name: "章太炎", era: "清末民初" },
  { key: "chenbaozhen", name: "陈宝箴", era: "清末·义宁陈氏" },
  { key: "zhangjian", name: "张謇", era: "清末实业" },
  { key: "chenjiageng", name: "陈嘉庚", era: "近代华侨" },
  // 现代
  { key: "hushi", name: "胡适", era: "民国" },
  { key: "guomoruo", name: "郭沫若", era: "现代" },
  { key: "bajin", name: "巴金", era: "现代" },
  { key: "hualuogeng", name: "华罗庚", era: "现代科学" },
  { key: "zhaoyuanren", name: "赵元任", era: "现代·常州赵氏" },
];

type SearchHit = { id: string; label?: string; description?: string };

async function resolve(name: string): Promise<SearchHit[]> {
  const url = `${API}?action=wbsearchentities&search=${encodeURIComponent(
    name,
  )}&language=zh&uselang=zh&type=item&limit=3&format=json`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const json = (await res.json()) as { search?: SearchHit[] };
  return json.search ?? [];
}

async function main(): Promise<void> {
  for (const c of CANDIDATES) {
    const hits = await resolve(c.name);
    const top = hits[0];
    const line = top
      ? `${top.id}\t${c.key}\t${c.name}（${c.era}）\t${top.description ?? ""}`
      : `??\t${c.key}\t${c.name}（${c.era}）\t未找到`;
    process.stdout.write(line + "\n");
    await new Promise((r) => setTimeout(r, 300));
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`resolve failed: ${String(e)}\n`);
  process.exitCode = 1;
});
