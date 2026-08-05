import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  auditLogs,
  deceasedPeople,
  mediaAssets,
  memorialMembers,
  memorials,
  outboxEvents,
  users,
} from "@/db/schema";
import {
  addressFor,
  markUploadComplete,
  processUploadedAsset,
  signUpload,
} from "@/modules/media/service";
import {
  AlwaysCleanScanner,
  InMemoryMediaStorage,
  setMediaStorage,
} from "@/modules/media/storage";
import type { MalwareScanner } from "@/modules/media/storage";
import { changePrivacy } from "@/modules/memorials/privacy";
import { createMemorial } from "@/modules/memorials/service";
import type { Actor, MemorialRole } from "@/modules/permissions/types";

const createdUserIds: string[] = [];
let storage: InMemoryMediaStorage;

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const EXE_BYTES = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

class InfectedScanner implements MalwareScanner {
  async scan(): Promise<{ clean: boolean; signature: string }> {
    return Promise.resolve({ clean: false, signature: "Test.Eicar" });
  }
}

beforeAll(() => {
  expect(process.env.DATABASE_URL ?? "").toContain("_test");
});

beforeEach(() => {
  storage = new InMemoryMediaStorage();
  setMediaStorage(storage);
});

afterEach(async () => {
  setMediaStorage(null);

  const userIds = createdUserIds.splice(0);
  if (userIds.length === 0) return;

  const owned = await db()
    .select({ id: memorials.id, personId: memorials.deceasedPersonId })
    .from(memorials)
    .where(inArray(memorials.ownerUserId, userIds));
  const memorialIds = owned.map((row) => row.id);

  if (memorialIds.length > 0) {
    const assets = await db()
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(inArray(mediaAssets.memorialId, memorialIds));
    if (assets.length > 0) {
      await db()
        .delete(auditLogs)
        .where(inArray(auditLogs.resourceId, assets.map((row) => row.id)));
    }
    await db().delete(auditLogs).where(inArray(auditLogs.resourceId, memorialIds));
    await db()
      .delete(outboxEvents)
      .where(inArray(outboxEvents.aggregateId, memorialIds));
    await db().delete(memorials).where(inArray(memorials.id, memorialIds));
    await db()
      .delete(deceasedPeople)
      .where(inArray(deceasedPeople.id, owned.map((row) => row.personId)));
  }

  await db().delete(users).where(inArray(users.id, userIds));
});

afterAll(async () => {
  await closeDb();
});

async function makeActor(): Promise<Actor> {
  const [row] = await db()
    .insert(users)
    .values({ displayName: `Person ${randomUUID().slice(0, 8)}` })
    .returning({ id: users.id });
  if (!row) throw new Error("user insert returned no row");
  createdUserIds.push(row.id);
  return { userId: row.id, platformRole: "user" };
}

async function makeMemorial(
  owner: Actor,
  visibility: "public" | "unlisted" | "invite_only" = "public",
): Promise<string> {
  const result = await createMemorial(
    owner,
    {
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: `Subject ${randomUUID().slice(0, 6)}` },
      visibility,
    },
    randomUUID(),
    "req_setup",
  );
  if (!result.ok) throw new Error("memorial creation failed");
  await db()
    .update(memorials)
    .set({ status: "published", publishedAt: new Date() })
    .where(eq(memorials.id, result.value.memorialId));
  return result.value.memorialId;
}

async function addMember(
  memorialId: string,
  actor: Actor,
  role: MemorialRole,
): Promise<void> {
  await db().insert(memorialMembers).values({
    memorialId,
    userId: actor.userId ?? "",
    role,
    acceptedAt: new Date(),
  });
}

/** Signs, uploads the given bytes into the quarantine key, and marks complete. */
async function uploadTo(
  memorialId: string,
  actor: Actor,
  bytes: Uint8Array,
  declaredType = "image/jpeg",
): Promise<string> {
  const signed = await signUpload(
    actor,
    {
      memorialId,
      fileName: "photo.jpg",
      contentType: declaredType,
      size: bytes.length,
    },
    "req_sign",
  );
  if (!signed.ok) throw new Error(`sign failed: ${signed.error}`);

  const [asset] = await db()
    .select({ key: mediaAssets.quarantineObjectKey })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, signed.value.mediaAssetId));

  await storage.putObject(asset?.key ?? "", bytes, declaredType);
  await markUploadComplete(actor, signed.value.mediaAssetId, "req_complete");

  return signed.value.mediaAssetId;
}

describe("signing an upload", () => {
  it("creates the asset awaiting upload and returns a short-lived URL", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    const signed = await signUpload(
      owner,
      {
        memorialId,
        fileName: "grandmother.jpg",
        contentType: "image/jpeg",
        size: 2_000_000,
      },
      "req_1",
    );

    expect(signed.ok).toBe(true);
    if (!signed.ok) return;

    const [asset] = await db()
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, signed.value.mediaAssetId));

    expect(asset?.status).toBe("pending_upload");
    expect(asset?.quarantineObjectKey).toContain("/quarantine/");
    expect(asset?.readyObjectKey).toBeNull();
    // Fifteen minutes is enough to send a file, not enough to share the URL.
    expect(signed.value.expiresInSeconds).toBeLessThanOrEqual(15 * 60);
  });

  it("never puts the client's filename in the object key", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    const signed = await signUpload(
      owner,
      {
        memorialId,
        fileName: "../../../etc/passwd",
        contentType: "image/jpeg",
        size: 1000,
      },
      "req_1",
    );
    if (!signed.ok) throw new Error("sign failed");

    const [asset] = await db()
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, signed.value.mediaAssetId));

    expect(asset?.quarantineObjectKey).not.toContain("..");
    expect(asset?.quarantineObjectKey).not.toContain("passwd");
    expect(asset?.quarantineObjectKey).toBe(
      `memorials/${memorialId}/quarantine/${signed.value.mediaAssetId}/original.jpg`,
    );
    // The name survives only as a sanitized label.
    expect(asset?.displayFileName).toBe("passwd");
  });

  it("refuses an unsupported type before a URL exists", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    expect(
      await signUpload(
        owner,
        {
          memorialId,
          fileName: "drawing.svg",
          contentType: "image/svg+xml",
          size: 500,
        },
        "req_1",
      ),
    ).toEqual({ ok: false, error: "UNSUPPORTED_TYPE" });

    const assets = await db()
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.memorialId, memorialId));
    expect(assets).toHaveLength(0);
  });

  it("refuses a file past the limit for its kind", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    expect(
      await signUpload(
        owner,
        {
          memorialId,
          fileName: "huge.jpg",
          contentType: "image/jpeg",
          size: 40 * 1024 * 1024,
        },
        "req_1",
      ),
    ).toEqual({ ok: false, error: "FILE_TOO_LARGE" });
  });

  it("lets an editor upload but not a reviewer", async () => {
    const owner = await makeActor();
    const editor = await makeActor();
    const reviewer = await makeActor();
    const memorialId = await makeMemorial(owner);
    await addMember(memorialId, editor, "editor");
    await addMember(memorialId, reviewer, "reviewer");

    expect(
      (
        await signUpload(
          editor,
          { memorialId, fileName: "a.jpg", contentType: "image/jpeg", size: 100 },
          "r1",
        )
      ).ok,
    ).toBe(true);

    expect(
      await signUpload(
        reviewer,
        { memorialId, fileName: "a.jpg", contentType: "image/jpeg", size: 100 },
        "r2",
      ),
    ).toEqual({ ok: false, error: "MEMORIAL_FORBIDDEN" });
  });

  it("tells a stranger the memorial does not exist", async () => {
    const owner = await makeActor();
    const stranger = await makeActor();
    const memorialId = await makeMemorial(owner);

    expect(
      await signUpload(
        stranger,
        { memorialId, fileName: "a.jpg", contentType: "image/jpeg", size: 100 },
        "r1",
      ),
    ).toEqual({ ok: false, error: "MEMORIAL_NOT_FOUND" });
  });

  it("refuses an anonymous uploader", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    expect(
      await signUpload(
        { userId: null, platformRole: "user" },
        { memorialId, fileName: "a.jpg", contentType: "image/jpeg", size: 100 },
        "r1",
      ),
    ).toEqual({ ok: false, error: "AUTH_REQUIRED" });
  });
});

describe("the upload lifecycle", () => {
  it("queues processing rather than publishing straight away", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const assetId = await uploadTo(memorialId, owner, JPEG_BYTES);

    const [asset] = await db()
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId));

    // Uploaded is not available.
    expect(asset?.status).toBe("scanning");

    const events = await db()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, memorialId));
    expect(events.map((event) => event.topic)).toContain("media.process");
  });

  it("gives no address until the asset is ready", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const assetId = await uploadTo(memorialId, owner, JPEG_BYTES);

    expect(await addressFor(assetId)).toEqual({ kind: "unavailable" });
  });

  it("publishes into the ready prefix and clears quarantine", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const assetId = await uploadTo(memorialId, owner, JPEG_BYTES);

    const result = await processUploadedAsset(
      assetId,
      new AlwaysCleanScanner(),
      "req_process",
    );
    expect(result).toEqual({ ok: true, value: { status: "ready" } });

    const [asset] = await db()
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId));

    expect(asset?.status).toBe("ready");
    expect(asset?.readyObjectKey).toContain("/ready/");
    expect(asset?.actualBytes).toBe(JPEG_BYTES.length);
    expect(asset?.readyAt).toBeInstanceOf(Date);

    // Nothing is left in the unexamined prefix.
    expect(storage.keys().some((key) => key.includes("/quarantine/"))).toBe(false);
    expect(storage.keys().some((key) => key.includes("/ready/"))).toBe(true);
  });

  it("rejects bytes that are not what the upload declared", async () => {
    // A signed URL says what may be uploaded. It does not guarantee what was.
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const assetId = await uploadTo(memorialId, owner, EXE_BYTES, "image/jpeg");

    expect(
      await processUploadedAsset(assetId, new AlwaysCleanScanner(), "req_process"),
    ).toEqual({ ok: false, error: "CONTENT_MISMATCH" });

    const [asset] = await db()
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId));

    expect(asset?.status).toBe("rejected");
    expect(asset?.rejectionReason).toBe("CONTENT_MISMATCH");
    expect(asset?.readyObjectKey).toBeNull();
    // The file never reaches the prefix anything is served from.
    expect(storage.keys().some((key) => key.includes("/ready/"))).toBe(false);
  });

  it("rejects a file the scanner reports as infected", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const assetId = await uploadTo(memorialId, owner, JPEG_BYTES);

    expect(
      await processUploadedAsset(assetId, new InfectedScanner(), "req_process"),
    ).toEqual({ ok: false, error: "MALWARE_DETECTED" });

    const [asset] = await db()
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId));
    expect(asset?.status).toBe("rejected");
    // Both copies are gone.
    expect(storage.keys()).toHaveLength(0);
  });

  it("gives a rejected asset no address, ever", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const assetId = await uploadTo(memorialId, owner, EXE_BYTES, "image/jpeg");
    await processUploadedAsset(assetId, new AlwaysCleanScanner(), "req_process");

    expect(await addressFor(assetId)).toEqual({ kind: "unavailable" });
  });

  it("rejects an asset whose bytes never arrived", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);

    const signed = await signUpload(
      owner,
      { memorialId, fileName: "a.jpg", contentType: "image/jpeg", size: 100 },
      "r1",
    );
    if (!signed.ok) throw new Error("sign failed");
    await markUploadComplete(owner, signed.value.mediaAssetId, "r2");

    expect(
      await processUploadedAsset(
        signed.value.mediaAssetId,
        new AlwaysCleanScanner(),
        "r3",
      ),
    ).toEqual({ ok: false, error: "BYTES_MISSING" });
  });

  it("will not process the same asset twice", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const assetId = await uploadTo(memorialId, owner, JPEG_BYTES);

    await processUploadedAsset(assetId, new AlwaysCleanScanner(), "r1");
    expect(
      await processUploadedAsset(assetId, new AlwaysCleanScanner(), "r2"),
    ).toEqual({ ok: false, error: "NOT_AWAITING_PROCESSING" });
  });

  it("will not accept a completion notice twice", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner);
    const assetId = await uploadTo(memorialId, owner, JPEG_BYTES);

    expect(await markUploadComplete(owner, assetId, "r1")).toEqual({
      ok: false,
      error: "NOT_AWAITING_PROCESSING",
    });
  });
});

describe("addresses", () => {
  it("are signed and short-lived for a private memorial", async () => {
    // Doc 06 section 4: private media must never have a permanent public URL.
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner, "invite_only");
    const assetId = await uploadTo(memorialId, owner, JPEG_BYTES);
    await processUploadedAsset(assetId, new AlwaysCleanScanner(), "r1");

    const address = await addressFor(assetId);

    expect(address.kind).toBe("signed");
    if (address.kind !== "signed") return;
    expect(address.expiresInSeconds).toBeLessThanOrEqual(5 * 60);
  });

  it("are signed for an unlisted memorial too", async () => {
    const owner = await makeActor();
    const memorialId = await makeMemorial(owner, "unlisted");
    const assetId = await uploadTo(memorialId, owner, JPEG_BYTES);
    await processUploadedAsset(assetId, new AlwaysCleanScanner(), "r1");

    expect((await addressFor(assetId)).kind).toBe("signed");
  });

  it("stop being public the moment the memorial stops being public", async () => {
    // Revoking access must not depend on a CDN forgetting an address it was
    // already given.
    // Reassign the shared handle as well, so the upload helper writes into the
    // same adapter the service reads from.
    storage = new InMemoryMediaStorage("https://cdn.example.test");
    setMediaStorage(storage);

    const owner = await makeActor();
    const memorialId = await makeMemorial(owner, "public");
    const assetId = await uploadTo(memorialId, owner, JPEG_BYTES);
    await processUploadedAsset(assetId, new AlwaysCleanScanner(), "r1");

    expect((await addressFor(assetId)).kind).toBe("public");

    await changePrivacy(owner, memorialId, { visibility: "invite_only" }, "r2");

    expect((await addressFor(assetId)).kind).toBe("signed");
  });

  it("are unavailable for an asset that does not exist", async () => {
    expect(await addressFor(randomUUID())).toEqual({ kind: "unavailable" });
  });
});
