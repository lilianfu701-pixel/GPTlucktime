import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type AdminExportArtifact = {
  objectKey: string;
  body: Uint8Array;
  contentHash: string;
  schemaVersion: number;
  expiresAt: Date;
};

export interface AdminExportStorage {
  putEncrypted(artifact: AdminExportArtifact): Promise<{ versionId: string; sizeBytes: number }>;
  verifyEncrypted(artifact: AdminExportArtifact, expectedVersionId: string): Promise<{ versionId: string; sizeBytes: number }>;
  deleteVersion(input: { objectKey: string; versionId: string }): Promise<void>;
}

export class S3AdminExportStorage implements AdminExportStorage {
  private readonly client: S3Client;

  constructor(private readonly configuration: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    requestTimeoutMs?: number;
    client?: S3Client;
  }) {
    this.client = configuration.client ?? new S3Client({ endpoint: configuration.endpoint,
      region: configuration.region, forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED",
      credentials: { accessKeyId: configuration.accessKeyId, secretAccessKey: configuration.secretAccessKey } });
  }

  private async head(artifact: AdminExportArtifact, versionId?: string) {
    const existing = await this.client.send(new HeadObjectCommand({ Bucket: this.configuration.bucket,
      Key: artifact.objectKey, ...(versionId ? { VersionId: versionId } : {}), ChecksumMode: "ENABLED" }),
    { abortSignal: AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000) });
    const checksum = Buffer.from(artifact.contentHash, "hex").toString("base64");
    if (!existing.VersionId || existing.ContentLength !== artifact.body.byteLength
      || existing.Metadata?.contenthash !== artifact.contentHash
      || existing.Metadata?.schema !== "admin-sensitive-export"
      || existing.Metadata?.version !== String(artifact.schemaVersion)
      || existing.Metadata?.expires !== artifact.expiresAt.toISOString()
      || existing.ServerSideEncryption !== "AES256" || existing.ChecksumSHA256 !== checksum) {
      throw new Error("ADMIN_EXPORT_STORAGE_CONFLICT");
    }
    return { versionId: existing.VersionId, sizeBytes: existing.ContentLength };
  }

  async verifyEncrypted(artifact: AdminExportArtifact, expectedVersionId: string) {
    const existing = await this.head(artifact, expectedVersionId);
    if (existing.versionId !== expectedVersionId) throw new Error("ADMIN_EXPORT_STORAGE_CONFLICT");
    return existing;
  }

  async putEncrypted(artifact: AdminExportArtifact) {
    try {
      return await this.head(artifact);
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
    }
    const result = await this.client.send(new PutObjectCommand({ Bucket: this.configuration.bucket,
      Key: artifact.objectKey, Body: artifact.body, ContentType: "application/json",
      ContentLength: artifact.body.byteLength,
      ChecksumSHA256: Buffer.from(artifact.contentHash, "hex").toString("base64"),
      ServerSideEncryption: "AES256", IfNoneMatch: "*", Metadata: { schema: "admin-sensitive-export",
        contenthash: artifact.contentHash,
        version: String(artifact.schemaVersion), expires: artifact.expiresAt.toISOString() },
    }), { abortSignal: AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000) });
    if (!result.VersionId) throw new Error("ADMIN_EXPORT_STORAGE_VERSION_REQUIRED");
    return this.verifyEncrypted(artifact, result.VersionId);
  }

  async deleteVersion(input: { objectKey: string; versionId: string }) {
    const request = { Bucket: this.configuration.bucket, Key: input.objectKey, VersionId: input.versionId };
    await this.client.send(new DeleteObjectCommand(request),
      { abortSignal: AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000) });
    try {
      await this.client.send(new HeadObjectCommand(request),
        { abortSignal: AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 10_000) });
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return;
      throw error;
    }
    throw new Error("ADMIN_EXPORT_STORAGE_DELETE_UNCONFIRMED");
  }
}
