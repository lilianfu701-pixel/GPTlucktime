import {
  bigint,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity";
import { memorials } from "./memorial";

/**
 * The lifecycle of an uploaded file.
 *
 * `ready` is the only state anything is served from. Bytes sit in a quarantine
 * prefix through `pending_upload`, `scanning` and `processing`, so an
 * unexamined file is never reachable, and a `rejected` one never becomes
 * reachable at all. See doc 06 section 4.
 */
export const mediaStatus = pgEnum("media_status", [
  "pending_upload",
  "scanning",
  "processing",
  "ready",
  "rejected",
  "deleted",
]);

export const mediaKind = pgEnum("media_kind", ["image", "video", "audio"]);

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memorialId: uuid("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: mediaKind("kind").notNull(),
    /** What the client declared, and what the bytes were later confirmed to be. */
    declaredContentType: text("declared_content_type").notNull(),
    detectedContentType: text("detected_content_type"),
    declaredBytes: bigint("declared_bytes", { mode: "number" }).notNull(),
    actualBytes: bigint("actual_bytes", { mode: "number" }),
    /** Sanitized label for display. Never used to build a storage key. */
    displayFileName: text("display_file_name").notNull(),
    status: mediaStatus("status").default("pending_upload").notNull(),
    /** Why it was refused. Shown to the family, never to a stranger. */
    rejectionReason: text("rejection_reason"),
    quarantineObjectKey: text("quarantine_object_key").notNull(),
    readyObjectKey: text("ready_object_key"),
    altText: text("alt_text"),
    /** Required for video and audio by doc 07 section 6. */
    captionText: text("caption_text"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("media_assets_memorial_idx").on(table.memorialId, table.status),
    index("media_assets_status_idx").on(table.status),
  ],
);

/** A derived size. The original is kept separately and never served directly. */
export const mediaVariants = pgTable(
  "media_variants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    variant: text("variant").notNull(),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("media_variants_asset_idx").on(table.assetId)],
);

export type MediaAsset = typeof mediaAssets.$inferSelect;
export type MediaVariantRow = typeof mediaVariants.$inferSelect;
