import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity";
import { deceasedPeople } from "./memorial";

export const lifeStatus = pgEnum("life_status", [
  "living",
  "deceased",
  /** Recorded by a family who does not know. Never guessed on their behalf. */
  "unknown",
]);

/**
 * How a parent relationship came about.
 *
 * Optional, and it stays optional. A tree that requires this field forces every
 * adoptive family to either declare themselves or misrepresent themselves, and
 * it turns the system into something that can tell a person they were adopted
 * before their family chose to. The matching engine never reads it.
 */
export const parentNature = pgEnum("parent_nature", [
  "unspecified",
  "birth",
  "adoptive",
  "step",
  "foster",
]);

export const familyLinkKind = pgEnum("family_link_kind", [
  /** personA is a parent of personB. Direction matters. */
  "parent",
  /** Spouses or partners. Symmetric; stored once, in a canonical order. */
  "partner",
]);

export const familyLinkStatus = pgEnum("family_link_status", [
  "proposed",
  "confirmed",
  "rejected",
  "withdrawn",
]);

export const familyLinkSource = pgEnum("family_link_source", [
  /** Someone stated it. */
  "declared",
  /** Both sides accepted a suggestion. The score is not the reason it is true. */
  "suggestion",
]);

/**
 * A person in a family tree.
 *
 * Two kinds of row, and the difference matters more than it looks.
 *
 * A row with `deceasedPersonId` is somebody the system already knows: the
 * subject of a memorial, with names, dates and a family who manage them. The
 * tree node is a pointer, not a copy — so a name corrected on the memorial is
 * corrected in the tree, and privacy stays decided in one place.
 *
 * A row without one is a living relative recorded by somebody else. That person
 * has not signed up, has not agreed, and may not know this row exists, so it
 * holds the least that still makes a tree: a name, a rough birth year, nothing
 * else. No contact details, no full dates, no biography. Doc 06 section 5.
 */
export const familyPeople = pgTable(
  "family_people",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Set when this node is a person the platform already has a record for. */
    deceasedPersonId: uuid("deceased_person_id").references(
      () => deceasedPeople.id,
      { onDelete: "cascade" },
    ),
    /**
     * The name shown for a node that has no memorial behind it.
     *
     * Null when `deceasedPersonId` is set: the names live on the memorial, and
     * copying them here would let the tree keep displaying a name a family has
     * since corrected or made unsearchable.
     */
    displayName: text("display_name"),
    lifeStatus: lifeStatus("life_status").default("unknown").notNull(),
    /**
     * Years only, never full dates, for a living person recorded by someone
     * else. Enough to tell two cousins apart, not enough to be an identity
     * document.
     */
    birthYear: integer("birth_year"),
    deathYear: integer("death_year"),
    /**
     * The account this node *is*, when someone puts themselves in their own
     * tree. Nobody else may claim a node on a living person's behalf.
     */
    selfUserId: uuid("self_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // One tree node per person the system knows about. Without this, two
    // relatives independently adding the same grandmother produce two nodes
    // and the graph quietly splits in half.
    uniqueIndex("family_people_deceased_key").on(table.deceasedPersonId),
    uniqueIndex("family_people_self_key").on(table.selfUserId),
    index("family_people_creator_idx").on(table.createdByUserId),
    index("family_people_name_idx").on(table.displayName),
    check(
      "family_people_identity_ck",
      // Either it points at a person we have, or it carries its own name.
      sql`(${table.deceasedPersonId} is not null and ${table.displayName} is null)
          or (${table.deceasedPersonId} is null and ${table.displayName} is not null)`,
    ),
    check(
      "family_people_self_is_living_ck",
      // A claimed node is a living person speaking for themselves.
      sql`${table.selfUserId} is null or ${table.lifeStatus} = 'living'`,
    ),
  ],
);

/**
 * An edge between two people.
 *
 * Only two kinds are stored: parent and partner. Siblings are derived from a
 * shared parent rather than recorded, because a stored sibling edge can
 * contradict the parent edges around it, and a tree that contradicts itself is
 * worse than a tree with a gap — it makes every other edge suspect.
 *
 * An edge is a claim until both sides accept it. `proposed` is what one family
 * believes; `confirmed` is what two families agree on. Only confirmed edges are
 * traversed, so one person cannot attach themselves to a family that has not
 * agreed and then read their way through it.
 */
export const familyLinks = pgTable(
  "family_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: familyLinkKind("kind").notNull(),
    /** For `parent`, the parent. For `partner`, the lower of the two ids. */
    personAId: uuid("person_a_id")
      .notNull()
      .references(() => familyPeople.id, { onDelete: "cascade" }),
    /** For `parent`, the child. For `partner`, the higher of the two ids. */
    personBId: uuid("person_b_id")
      .notNull()
      .references(() => familyPeople.id, { onDelete: "cascade" }),
    nature: parentNature("nature").default("unspecified").notNull(),
    status: familyLinkStatus("status").default("proposed").notNull(),
    source: familyLinkSource("source").default("declared").notNull(),
    proposedByUserId: uuid("proposed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Who accepted on the other side. Null until somebody has. */
    confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("family_links_pair_key").on(
      table.kind,
      table.personAId,
      table.personBId,
    ),
    index("family_links_a_idx").on(table.personAId, table.status),
    index("family_links_b_idx").on(table.personBId, table.status),
    check("family_links_distinct_ck", sql`${table.personAId} <> ${table.personBId}`),
    check(
      "family_links_partner_order_ck",
      // A partner edge stored in both directions would be two edges for one
      // marriage, and one of them would eventually be confirmed alone.
      sql`${table.kind} <> 'partner' or ${table.personAId} < ${table.personBId}`,
    ),
    check(
      "family_links_nature_ck",
      sql`${table.kind} = 'parent' or ${table.nature} = 'unspecified'`,
    ),
  ],
);

export type FamilyPerson = typeof familyPeople.$inferSelect;
export type NewFamilyPerson = typeof familyPeople.$inferInsert;
export type FamilyLink = typeof familyLinks.$inferSelect;
export type NewFamilyLink = typeof familyLinks.$inferInsert;
