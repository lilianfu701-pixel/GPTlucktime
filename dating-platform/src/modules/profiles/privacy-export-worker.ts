import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function decryptPrivacyExport(body: Uint8Array, encryption: { keyId: string; key: Uint8Array }) {
  if (body.byteLength < 32 || body.byteLength > 10 * 1024 * 1024 || encryption.key.byteLength !== 32) {
    throw new Error("PRIVACY_EXPORT_DECRYPTION_FAILED");
  }
  try {
    const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.alg !== "A256GCM" || parsed.kid !== encryption.keyId
      || typeof parsed.iv !== "string" || typeof parsed.tag !== "string" || typeof parsed.ciphertext !== "string") {
      throw new Error("invalid envelope");
    }
    const iv = Buffer.from(parsed.iv, "base64url"); const tag = Buffer.from(parsed.tag, "base64url");
    const ciphertext = Buffer.from(parsed.ciphertext, "base64url");
    if (iv.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength > 10 * 1024 * 1024) {
      throw new Error("invalid envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", encryption.key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    JSON.parse(plaintext.toString("utf8"));
    return new Uint8Array(plaintext);
  } catch {
    throw new Error("PRIVACY_EXPORT_DECRYPTION_FAILED");
  }
}

type ExportJob = { id: string; leaseId: string; userId: string; attempts: number };
type ArtifactIdentity = { objectKey: string; encryptionKeyId: string; expiresAt: Date;
  preparedArtifactEncrypted?: string; preparedIntegritySha256?: string };
type ExportArtifact = { objectKey: string; body: Uint8Array; contentHash: string; schemaVersion: number;
  encryptionKeyId: string; expiresAt: Date };
type ExportWorkerStore = {
  claim(): Promise<ExportJob | null>;
  prepareArtifact(job: ExportJob, input: ArtifactIdentity): Promise<ArtifactIdentity>;
  prepareEncryptedArtifact(job: ExportJob, input: { bodyBase64: string; integritySha256: string }): Promise<{
    bodyBase64: string; integritySha256: string;
  }>;
  complete(input: { id: string; leaseId: string; objectKey: string; objectVersion: string; integritySha256: string;
    encryptionKeyId: string; expiresAt: Date; completedAt: Date }): Promise<void>;
  retry(job: ExportJob, input: { errorCode: "EXPORT_FAILED"; availableAt: Date }): Promise<void>;
  manualReview(job: ExportJob, errorCode: "EXPORT_FAILED"): Promise<void>;
};
type ExportStorage = {
  findEncrypted(identity: ArtifactIdentity & { contentHash: string }): Promise<{
    versionId: string; contentHash: string; sizeBytes: number;
  } | null>;
  putEncrypted(artifact: ExportArtifact): Promise<{ versionId: string; sizeBytes: number }>;
  deleteVersion(input: { objectKey: string; versionId: string }): Promise<void>;
  versionExists(input: { objectKey: string; versionId: string }): Promise<boolean>;
};

type ExpiredExportJob = { id: string; leaseId: string; objectKey: string; objectVersion: string; attempts: number };
type ExportCleanupStore = {
  claimExpired(): Promise<ExpiredExportJob | null>;
  markExpired(job: ExpiredExportJob): Promise<void>;
  failExpiredCleanup(job: ExpiredExportJob, input: { attempts: number; availableAt: Date }): Promise<void>;
};

export class PrivacyExportWorker {
  constructor(private readonly dependencies: { store: ExportWorkerStore;
    collect(userId: string): Promise<Record<string, unknown>>; storage: ExportStorage;
    encryption: { keyId: string; key: Uint8Array }; clock?: () => Date }) {
    if (dependencies.encryption.key.byteLength !== 32) throw new Error("PRIVACY_EXPORT_KEY_INVALID");
  }

  async runOne() {
    const job = await this.dependencies.store.claim();
    if (!job) return false;
    const now = (this.dependencies.clock ?? (() => new Date()))();
    try {
      const identity = await this.dependencies.store.prepareArtifact(job, {
        objectKey: `privacy-exports/${job.userId}/${job.id}/v1.json.enc`,
        encryptionKeyId: this.dependencies.encryption.keyId,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      });
      let prepared = identity.preparedArtifactEncrypted && identity.preparedIntegritySha256 ? {
        bodyBase64: identity.preparedArtifactEncrypted, integritySha256: identity.preparedIntegritySha256,
      } : null;
      if (!prepared) {
        const data = await this.dependencies.collect(job.userId);
        const plaintext = Buffer.from(JSON.stringify({ schemaVersion: 1, generatedAt: now.toISOString(), data }), "utf8");
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.dependencies.encryption.key, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const body = Buffer.from(JSON.stringify({ v: 1, alg: "A256GCM", kid: identity.encryptionKeyId,
          iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"),
          ciphertext: ciphertext.toString("base64url") }), "utf8");
        prepared = await this.dependencies.store.prepareEncryptedArtifact(job, {
          bodyBase64: body.toString("base64"), integritySha256: createHash("sha256").update(body).digest("hex"),
        });
      }
      const body = Buffer.from(prepared.bodyBase64, "base64");
      if (createHash("sha256").update(body).digest("hex") !== prepared.integritySha256) {
        throw new Error("PRIVACY_EXPORT_PREPARED_ARTIFACT_INVALID");
      }
      const existing = await this.dependencies.storage.findEncrypted({ ...identity,
        contentHash: prepared.integritySha256 });
      let stored: { versionId: string; contentHash: string; sizeBytes: number };
      if (existing) stored = existing;
      else {
        const uploaded = await this.dependencies.storage.putEncrypted({ objectKey: identity.objectKey, body,
          contentHash: prepared.integritySha256,
          schemaVersion: 1, encryptionKeyId: identity.encryptionKeyId, expiresAt: identity.expiresAt });
        stored = { ...uploaded, contentHash: prepared.integritySha256 };
      }
      await this.dependencies.store.complete({ id: job.id, leaseId: job.leaseId, objectKey: identity.objectKey,
        objectVersion: stored.versionId, integritySha256: stored.contentHash,
        encryptionKeyId: identity.encryptionKeyId, expiresAt: identity.expiresAt, completedAt: now });
    } catch {
      if (job.attempts >= 5) await this.dependencies.store.manualReview(job, "EXPORT_FAILED");
      else await this.dependencies.store.retry(job, { errorCode: "EXPORT_FAILED",
        availableAt: new Date(now.getTime() + Math.min(3_600_000, 1_000 * (2 ** job.attempts))) });
    }
    return true;
  }
}

export class PrivacyExportCleanupWorker {
  constructor(private readonly dependencies: { store: ExportCleanupStore;
    storage: Pick<ExportStorage, "deleteVersion" | "versionExists">; clock?: () => Date }) {}

  async runOne() {
    const job = await this.dependencies.store.claimExpired();
    if (!job) return false;
    try {
      await this.dependencies.storage.deleteVersion({ objectKey: job.objectKey, versionId: job.objectVersion });
      if (await this.dependencies.storage.versionExists({ objectKey: job.objectKey, versionId: job.objectVersion })) {
        throw new Error("EXPORT_VERSION_STILL_PRESENT");
      }
      await this.dependencies.store.markExpired(job);
    } catch {
      const now = (this.dependencies.clock ?? (() => new Date()))();
      await this.dependencies.store.failExpiredCleanup(job, { attempts: job.attempts,
        availableAt: new Date(now.getTime() + Math.min(3_600_000, 1_000 * (2 ** Math.max(0, job.attempts - 1)))) });
    }
    return true;
  }
}
