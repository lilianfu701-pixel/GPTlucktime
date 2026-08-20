import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
  type HeadObjectCommandOutput } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type PrivacyExportArtifact = { objectKey: string; body: Uint8Array; contentHash: string; schemaVersion: number;
  encryptionKeyId: string; expiresAt: Date };

function isNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NotFound" || candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}

export class S3PrivacyExportStorage {
  private readonly client: S3Client;
  constructor(private readonly configuration: { endpoint: string; region: string; bucket: string; accessKeyId: string;
    secretAccessKey: string; requestTimeoutMs?: number; client?: S3Client }) {
    this.client = configuration.client ?? new S3Client({ endpoint: configuration.endpoint, region: configuration.region,
      forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED",
      credentials: { accessKeyId: configuration.accessKeyId, secretAccessKey: configuration.secretAccessKey } });
  }
  async putEncrypted(artifact: PrivacyExportArtifact) {
    const checksum = Buffer.from(artifact.contentHash, "hex").toString("base64");
    try {
      const existing = await this.client.send(new HeadObjectCommand({ Bucket: this.configuration.bucket,
        Key: artifact.objectKey, ChecksumMode: "ENABLED" }),
      { abortSignal: AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000) });
      return this.verifyHead(existing, artifact, checksum);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const result = await this.client.send(new PutObjectCommand({ Bucket: this.configuration.bucket, Key: artifact.objectKey,
      Body: artifact.body, ContentLength: artifact.body.byteLength, ContentType: "application/octet-stream",
      ChecksumSHA256: checksum, ServerSideEncryption: "AES256", IfNoneMatch: "*", Metadata: { schema: "privacy-export",
        version: String(artifact.schemaVersion), contenthash: artifact.contentHash,
        encryptionkeyid: artifact.encryptionKeyId, expires: artifact.expiresAt.toISOString() } }),
    { abortSignal: AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000) });
    if (!result.VersionId) throw new Error("PRIVACY_EXPORT_STORAGE_VERSION_REQUIRED");
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.configuration.bucket, Key: artifact.objectKey,
      VersionId: result.VersionId, ChecksumMode: "ENABLED" }),
    { abortSignal: AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000) });
    return this.verifyHead(head, artifact, checksum, result.VersionId);
  }

  async findEncrypted(identity: { objectKey: string; encryptionKeyId: string; contentHash: string; expiresAt: Date }) {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.configuration.bucket,
        Key: identity.objectKey, ChecksumMode: "ENABLED" }),
      { abortSignal: AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000) });
      const checksum = Buffer.from(identity.contentHash, "hex").toString("base64");
      if (!head.VersionId || !head.ContentLength || head.ChecksumSHA256 !== checksum
        || head.Metadata?.contenthash !== identity.contentHash
        || head.ServerSideEncryption !== "AES256" || head.Metadata?.schema !== "privacy-export"
        || head.Metadata?.version !== "1" || head.Metadata?.encryptionkeyid !== identity.encryptionKeyId
        || head.Metadata?.expires !== identity.expiresAt.toISOString()) throw new Error("PRIVACY_EXPORT_STORAGE_CONFLICT");
      return { versionId: head.VersionId, contentHash: identity.contentHash, sizeBytes: head.ContentLength };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private verifyHead(head: HeadObjectCommandOutput, artifact: PrivacyExportArtifact, checksum: string,
    expectedVersion?: string) {
    if (!head.VersionId || (expectedVersion && head.VersionId !== expectedVersion)
      || head.ContentLength !== artifact.body.byteLength || head.ChecksumSHA256 !== checksum
      || head.ServerSideEncryption !== "AES256" || head.Metadata?.schema !== "privacy-export"
      || head.Metadata?.version !== String(artifact.schemaVersion) || head.Metadata?.contenthash !== artifact.contentHash
      || head.Metadata?.encryptionkeyid !== artifact.encryptionKeyId
      || head.Metadata?.expires !== artifact.expiresAt.toISOString()) throw new Error("PRIVACY_EXPORT_STORAGE_CONFLICT");
    return { versionId: head.VersionId, sizeBytes: head.ContentLength };
  }
  async createDownload(input: { objectKey: string; objectVersion: string; expiresInSeconds?: number }) {
    const expiresIn = Math.max(60, Math.min(600, input.expiresInSeconds ?? 300));
    const url = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.configuration.bucket,
      Key: input.objectKey, VersionId: input.objectVersion, ResponseContentDisposition: "attachment; filename=heartline-data-export.enc",
      ResponseCacheControl: "private, no-store" }), { expiresIn });
    return { url, expiresInSeconds: expiresIn };
  }
  async readEncrypted(input: { objectKey: string; objectVersion: string; integritySha256: string;
    maxBytes?: number }) {
    const maximum = Math.max(1, Math.min(25 * 1024 * 1024, input.maxBytes ?? 10 * 1024 * 1024));
    const abort = new AbortController();
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.configuration.bucket,
      Key: input.objectKey, VersionId: input.objectVersion, ChecksumMode: "ENABLED" }),
    { abortSignal: AbortSignal.any([abort.signal,
      AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000)]) });
    const checksum = Buffer.from(input.integritySha256, "hex").toString("base64");
    if (result.VersionId !== input.objectVersion || !result.ContentLength || result.ContentLength > maximum
      || result.ChecksumSHA256 !== checksum || result.ServerSideEncryption !== "AES256" || !result.Body) {
      throw new Error("PRIVACY_EXPORT_STORAGE_CONFLICT");
    }
    const stream = result.Body as unknown as AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void };
    if (typeof stream[Symbol.asyncIterator] !== "function") throw new Error("PRIVACY_EXPORT_STORAGE_CONFLICT");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const value of stream) {
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        size += chunk.byteLength;
        if (size > maximum) {
          const failure = new Error("PRIVACY_EXPORT_STORAGE_CONFLICT");
          abort.abort(failure); stream.destroy?.(failure); throw failure;
        }
        chunks.push(chunk);
      }
    } catch (failure) {
      abort.abort();
      if (failure instanceof Error && failure.message === "PRIVACY_EXPORT_STORAGE_CONFLICT") throw failure;
      throw new Error("PRIVACY_EXPORT_STORAGE_CONFLICT");
    }
    if (size !== result.ContentLength) throw new Error("PRIVACY_EXPORT_STORAGE_CONFLICT");
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
  }
  async deleteVersion(input: { objectKey: string; versionId: string }) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.configuration.bucket, Key: input.objectKey,
      VersionId: input.versionId }), { abortSignal: AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000) });
  }
  async versionExists(input: { objectKey: string; versionId: string }) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.configuration.bucket, Key: input.objectKey,
        VersionId: input.versionId }), { abortSignal: AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000) });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}
