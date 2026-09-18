#!/usr/bin/env python3
"""Extract a family lineage from CBDB (中国历代人物传记资料库) via the
person.php JSON API, into the missingu.org GenealogyDataset shape.

Directed BFS from a seed person:
  seed      -> up via F/M, down via S*/D*, spouse leaf via W*/H*
  ancestor  -> up via F/M only  (+ spouse leaf)
  descendant-> down via S*/D*    (+ spouse leaf)
  spouse    -> leaf, no expansion
Collateral / skip-generation codes (FF, FB, BS, SSS, BG, WxF, ...) are ignored;
the kinship engine downstream derives siblings/uncles from shared parents.

Cross-source note: CBDB ids live in namespace "cbdb"; a person already imported
from Wikidata (a QID) will NOT auto-dedup. The script reports name-overlap with
the existing corpus so fragmentation risk is visible before anything is written.
"""
import json, re, sys, time, urllib.parse, urllib.request, os, glob, tempfile

API = "https://cbdb.fas.harvard.edu/cbdbapi/person.php"
UA = "missingu-genealogy/1.0 (https://missingu.org)"
THROTTLE = 0.7
LIVING_CUTOFF = 1940
# Keep a family small enough to import within the serverless time budget: the
# admin seed builds every person's node (pass one) before any edge (pass two)
# in one 60s request, so a >~50-person family can leave the 族谱图 unwired even
# though the pages exist. Split a deep lineage into OVERLAPPING chunks (seed the
# top and the bottom); shared people dedup by CBDB id and the graph reconnects.
MAX_PEOPLE = int(os.environ.get("CBDB_MAX_PEOPLE", "45"))
# Default: this script lives in scripts/cbdb/, sources are two levels up.
SOURCES_DIR = os.path.normpath(os.path.join(
    os.path.dirname(__file__), "..", "..",
    "modules", "genealogy", "import", "sources"))
# Override with an absolute path if run from elsewhere.
SOURCES_DIR = os.environ.get("CBDB_SOURCES_DIR", SOURCES_DIR)

RE = {
    "F": re.compile(r"^F$"), "M": re.compile(r"^M$"),
    "S": re.compile(r"^S\d*$"), "D": re.compile(r"^D\d*$"),
    "W": re.compile(r"^W\d*$"), "H": re.compile(r"^H\d*$"),
}

def fetch(params):
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            if attempt < 4:
                time.sleep(2 ** attempt)
            else:
                print("  ! fetch failed:", e, file=sys.stderr)
                return None
    return None

def person_by_id(pid):
    d = fetch({"id": str(pid), "o": "json"})
    return dig(d)

def person_by_name(name):
    d = fetch({"name": name, "o": "json"})
    return dig(d)

def dig(d):
    try:
        return d["Package"]["PersonAuthority"]["PersonInfo"]["Person"]
    except (TypeError, KeyError):
        return None

def kin_list(person):
    node = person.get("PersonKinshipInfo")
    if not isinstance(node, dict):
        return []
    k = node.get("Kinship")
    if isinstance(k, list):
        return k
    if isinstance(k, dict):
        return [k]
    return []

def year(v):
    try:
        n = int(v)
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None

def to_person(basic):
    pid = str(basic.get("PersonId"))
    name = basic.get("ChName") or basic.get("EngName") or pid
    obj = {"externalId": pid, "name": name,
           "citation": f"CBDB 中国历代人物传记资料库 person {pid}"}
    g = basic.get("Gender")
    if g == "0": obj["gender"] = "male"
    elif g == "1": obj["gender"] = "female"
    yb, yd = year(basic.get("YearBirth")), year(basic.get("YearDeath"))
    if yb: obj["birth"] = {"year": yb}
    if yd: obj["death"] = {"year": yd}
    if yb and not yd and yb >= LIVING_CUTOFF:
        obj["living"] = True
    return obj, yb, yd

def classify(kinrel):
    for tag, rx in RE.items():
        if rx.match(kinrel):
            return tag
    return None

def extract(seed_ids, key):
    people = {}          # pid -> person obj
    relations = []
    rel_seen = set()
    visited = set()
    queue = [(str(s), "seed") for s in seed_ids]

    def add_person(person):
        basic = person["BasicInfo"]
        pid = str(basic.get("PersonId"))
        if pid not in people:
            obj, yb, yd = to_person(basic)
            people[pid] = obj
        return pid

    def add_rel(r):
        sig = json.dumps(r, sort_keys=True, ensure_ascii=False)
        if sig not in rel_seen:
            rel_seen.add(sig)
            relations.append(r)

    while queue and len(people) < MAX_PEOPLE:
        pid, mode = queue.pop(0)
        if pid in visited:
            continue
        visited.add(pid)
        person = person_by_id(pid)
        time.sleep(THROTTLE)
        if not person or "BasicInfo" not in person:
            continue
        add_person(person)
        for kin in kin_list(person):
            kid = str(kin.get("KinPersonId") or "")
            rel = (kin.get("KinRel") or "").strip()
            if not kid or kid == "0":
                continue
            tag = classify(rel)
            if not tag:
                continue
            go_up = mode in ("seed", "up")
            go_down = mode in ("seed", "down")
            if tag == "F" or tag == "M":
                if not go_up:
                    continue
                add_rel({"kind": "parent", "parent": kid, "child": pid})
                if kid not in visited:
                    queue.append((kid, "up"))
            elif tag == "S" or tag == "D":
                if not go_down:
                    continue
                add_rel({"kind": "parent", "parent": pid, "child": kid})
                if kid not in visited:
                    queue.append((kid, "down"))
            elif tag == "W" or tag == "H":
                a, b = sorted([pid, kid])
                add_rel({"kind": "spouse", "a": a, "b": b})
                # spouse is a leaf: fetch once to get their dates, don't expand
                if kid not in visited and kid not in people:
                    sp = person_by_id(kid)
                    time.sleep(THROTTLE)
                    if sp and "BasicInfo" in sp:
                        add_person(sp)
                    visited.add(kid)

    # keep only relations whose endpoints both survived
    ids = set(people)
    relations = [r for r in relations
                 if (r["kind"] == "parent" and r["parent"] in ids and r["child"] in ids)
                 or (r["kind"] == "spouse" and r["a"] in ids and r["b"] in ids)]
    return {"key": f"cbdb:{key}", "namespace": "cbdb",
            "people": list(people.values()), "relations": relations}

def existing_names():
    names = {}
    for p in glob.glob(os.path.join(SOURCES_DIR, "*.data.json")):
        try:
            d = json.load(open(p, encoding="utf-8"))
        except Exception:
            continue
        for per in d.get("people", []):
            nm = per.get("name")
            if nm:
                names.setdefault(nm, os.path.basename(p))
    return names

def main():
    # Windows consoles default to GBK and raise on '✓'/CJK in prints; force
    # utf-8 so the script never dies on output after the data is already written.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if len(sys.argv) < 3:
        print("usage: extract_cbdb.py <key> <seed_id_or_name> [more_seeds...]")
        sys.exit(1)
    key = sys.argv[1]
    seeds = []
    for arg in sys.argv[2:]:
        if arg.startswith("--"):
            continue
        if arg.isdigit():
            seeds.append(arg)
        else:
            p = person_by_name(arg)
            time.sleep(THROTTLE)
            if p and "BasicInfo" in p:
                pid = str(p["BasicInfo"]["PersonId"])
                print(f"  seed '{arg}' -> {p['BasicInfo'].get('ChName')} ({pid})")
                seeds.append(pid)
            else:
                print(f"  ! seed '{arg}' not found")
    if not seeds:
        print("no valid seeds"); sys.exit(1)

    ds = extract(seeds, key)
    exist = existing_names()
    overlap = [p["name"] for p in ds["people"] if p["name"] in exist]

    print(f"\n=== {key} ===")
    print(f"成员 {len(ds['people'])} · 关系 {len(ds['relations'])}")
    for p in ds["people"]:
        yb = p.get("birth", {}).get("year", "?")
        yd = p.get("death", {}).get("year", "?")
        liv = " [在世]" if p.get("living") else ""
        print(f"  {p['name']} ({yb}-{yd}) {p.get('gender','?')}{liv}")
    print(f"\n名字与现有库重叠: {len(overlap)}/{len(ds['people'])}", overlap if overlap else "")

    out = os.path.join(SOURCES_DIR, f"{key}.data.json")
    if "--write" in sys.argv:
        json.dump(ds, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print("✓ 写入", out)
    else:
        # dry-run: dump to the system temp dir (never the repo) for inspection.
        tmp = os.path.join(tempfile.gettempdir(), f"cbdb_{key}.preview.json")
        json.dump(ds, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print("（dry-run，预览写入", tmp, "；加 --write 才写入源目录）")

if __name__ == "__main__":
    main()
