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
  // 波次8 — 近现代艺术家
  { key: "qibaishi", name: "齐白石", era: "近现代·画家" },
  { key: "zhangdaqian", name: "张大千", era: "近现代·画家" },
  { key: "fubaoshi", name: "傅抱石", era: "近现代·画家" },
  { key: "wuchangshuo", name: "吴昌硕", era: "近现代·书画篆刻" },
  { key: "laoshe", name: "老舍", era: "现代·小说家" },
  { key: "maodun", name: "茅盾", era: "现代·文学家" },
  { key: "bajin", name: "巴金", era: "现代·文学家" },
  // 近现代科学家/学者
  { key: "hualuogeng", name: "华罗庚", era: "现代·数学家" },
  { key: "zhukezhen", name: "竺可桢", era: "现代·气象学家" },
  { key: "lisiguang", name: "李四光", era: "现代·地质学家" },
  { key: "maoyisheng", name: "茅以升", era: "现代·桥梁工程师" },
  { key: "lianyuying", name: "钱穆", era: "现代·历史学家" },
  { key: "hushi", name: "胡适", era: "民国·学者" },
  // 清末民初实业/教育
  { key: "caiyuanpei", name: "蔡元培", era: "清末民初·教育家" },
  { key: "zhangjian", name: "张謇", era: "清末·南通实业家" },
  { key: "yanxiu", name: "严修", era: "清末·教育家" },
  // 明清文人/艺术家
  { key: "zhengbanqiao", name: "郑燮", era: "清·扬州八怪" },
  { key: "psongling", name: "蒲松龄", era: "清·聊斋志异" },
  { key: "mifu", name: "米芾", era: "北宋·书画家" },
  // 近代军政
  { key: "yanxishan", name: "阎锡山", era: "民国·山西督军" },
  { key: "liyuanhong", name: "黎元洪", era: "民国·大总统" },
  { key: "caie", name: "蔡锷", era: "民国·护国" },
  // 古代重要学者
  { key: "zhengxuan", name: "郑玄", era: "汉·经学家" },
  { key: "xielingyun", name: "谢灵运", era: "南朝·山水诗" },
  { key: "yuxin", name: "庾信", era: "南北朝·诗人" },
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
