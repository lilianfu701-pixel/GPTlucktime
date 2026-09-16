import type {
  GenealogyDataset,
  GenealogySource,
  SourceDate,
  SourceGender,
  SourcePerson,
  SourceRelation,
} from "../types";

/**
 * A GEDCOM adapter — the universal way structured genealogy enters the platform.
 *
 * GEDCOM is the interchange format every family-tree tool speaks, so one adapter
 * accepts data from all of them: a family's own software export, a transcribed
 * 族谱, a public dataset. It parses to the same normalized {@link GenealogyDataset}
 * every other source produces, so nothing downstream knows it came from GEDCOM.
 *
 * A deliberately small subset is read — the parts a lineage is actually made of:
 * INDI records (name, sex, birth/death date and place) and FAM records (the
 * parent and spouse edges). Everything else in a GEDCOM file is skipped rather
 * than half-understood.
 */

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/** Date qualifiers we drop before reading the date itself. */
const DATE_QUALIFIERS = /\b(ABT|EST|CAL|BEF|AFT|FROM|TO|BET|AND|INT)\b/gi;

/**
 * A GEDCOM date to a source date, at whatever precision it carries.
 *
 * Handles "12 MAR 1946", "MAR 1946", "1946" and the common approximate forms
 * ("ABT 1946", "BET 1940 AND 1946"). Anything with no four-digit year — or a
 * year outside a plausible human range — yields nothing rather than a guess.
 */
export function parseGedcomDate(raw: string | undefined): SourceDate | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(DATE_QUALIFIERS, " ").trim().toUpperCase();
  const tokens = cleaned.split(/\s+/).filter(Boolean);

  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  for (const token of tokens) {
    if (/^\d{3,4}$/.test(token)) {
      // First year wins, so a range ("BET 1940 AND 1946") reads as its start.
      if (year === undefined) year = Number(token);
    } else if (token in MONTHS) {
      month = MONTHS[token];
    } else if (/^\d{1,2}$/.test(token)) {
      day = Number(token);
    }
  }

  if (year === undefined || year < 1 || year > 9999) return undefined;
  const out: SourceDate = { year };
  if (month !== undefined) out.month = month;
  if (month !== undefined && day !== undefined) out.day = day;
  return out;
}

function parseSex(value: string | undefined): SourceGender {
  if (value === "M") return "male";
  if (value === "F") return "female";
  return "unknown";
}

/** A GEDCOM NAME ("孔/Kong/" or "John /Smith/") to a plain display name. */
function parseName(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/\//g, " ").replace(/\s+/g, " ").trim();
}

type GedcomLine = { level: number; tag: string; xref?: string; value?: string };

function parseLine(line: string): GedcomLine | null {
  // `<level> [@xref@] <tag> [value]`
  const match = /^\s*(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s(.*))?$/.exec(line);
  if (!match) return null;
  const level = Number(match[1]);
  const xref = match[2] ? match[2].replace(/@/g, "") : undefined;
  const tag = match[3]!;
  const value = match[4];
  const out: GedcomLine = { level, tag };
  if (xref) out.xref = xref;
  if (value !== undefined) out.value = value;
  return out;
}

type ParsedPerson = {
  externalId: string;
  name: string;
  sex: SourceGender;
  birth?: SourceDate;
  death?: SourceDate;
  birthPlace?: string;
  deathPlace?: string;
};

type ParsedFamily = { husband?: string; wife?: string; children: string[] };

/** Parses GEDCOM text into its raw INDI and FAM records. */
export function parseGedcom(text: string): {
  people: ParsedPerson[];
  families: ParsedFamily[];
} {
  const people: ParsedPerson[] = [];
  const families: ParsedFamily[] = [];

  let person: ParsedPerson | null = null;
  let family: ParsedFamily | null = null;
  // Which INDI event a following level-2 DATE/PLAC belongs to.
  let event: "BIRT" | "DEAT" | null = null;

  const flush = (): void => {
    if (person) people.push(person);
    if (family) families.push(family);
    person = null;
    family = null;
    event = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const line = parseLine(rawLine);
    if (!line) continue;

    if (line.level === 0) {
      flush();
      if (line.tag === "INDI" && line.xref) {
        person = { externalId: line.xref, name: "", sex: "unknown" };
      } else if (line.tag === "FAM") {
        family = { children: [] };
      }
      continue;
    }

    if (person) {
      if (line.level === 1) {
        event = null;
        if (line.tag === "NAME") person.name = parseName(line.value);
        else if (line.tag === "SEX") person.sex = parseSex(line.value);
        else if (line.tag === "BIRT") event = "BIRT";
        else if (line.tag === "DEAT") event = "DEAT";
      } else if (line.level === 2 && event) {
        if (line.tag === "DATE") {
          const date = parseGedcomDate(line.value);
          if (date && event === "BIRT") person.birth = date;
          if (date && event === "DEAT") person.death = date;
        } else if (line.tag === "PLAC" && line.value) {
          if (event === "BIRT") person.birthPlace = line.value.trim();
          if (event === "DEAT") person.deathPlace = line.value.trim();
        }
      }
      continue;
    }

    if (family && line.level === 1 && line.value) {
      const ref = line.value.replace(/@/g, "");
      if (line.tag === "HUSB") family.husband = ref;
      else if (line.tag === "WIFE") family.wife = ref;
      else if (line.tag === "CHIL") family.children.push(ref);
    }
  }
  flush();

  return { people, families };
}

/** Turns parsed GEDCOM records into the normalized dataset. */
export function gedcomToDataset(
  text: string,
  options: { key: string; citation: string },
): GenealogyDataset {
  const { people, families } = parseGedcom(text);

  const sourcePeople: SourcePerson[] = people
    .filter((p) => p.name.length > 0)
    .map((p) => {
      const person: SourcePerson = {
        externalId: p.externalId,
        name: p.name,
        citation: options.citation,
      };
      if (p.sex !== "unknown") person.gender = p.sex;
      if (p.birth) person.birth = p.birth;
      if (p.death) person.death = p.death;
      if (p.birthPlace) person.birthPlace = { city: p.birthPlace };
      if (p.deathPlace) person.deathPlace = { city: p.deathPlace };
      return person;
    });

  const relations: SourceRelation[] = [];
  for (const fam of families) {
    if (fam.husband && fam.wife) {
      relations.push({ kind: "spouse", a: fam.husband, b: fam.wife });
    }
    for (const child of fam.children) {
      if (fam.husband) {
        relations.push({ kind: "parent", parent: fam.husband, child });
      }
      if (fam.wife) {
        relations.push({ kind: "parent", parent: fam.wife, child });
      }
    }
  }

  return { key: options.key, people: sourcePeople, relations };
}

/** A GEDCOM source backed by an in-memory string (a loaded file's contents). */
export function gedcomSource(
  text: string,
  options: { key: string; citation: string },
): GenealogySource {
  return {
    key: options.key,
    load: async () => gedcomToDataset(text, options),
  };
}
