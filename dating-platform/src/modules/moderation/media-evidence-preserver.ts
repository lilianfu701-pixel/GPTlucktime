import type { StorageAdapter } from "@/modules/profiles/media-service";

import type { ImmutableMediaSource } from "./media-hold-policy";

export type PreservedMediaObject = {
  objectKey: string;
  objectVersion: string;
  objectEtag: string;
};

export interface MediaEvidencePreserver {
  preserve(
    source: ImmutableMediaSource,
    destinationObjectKey: string,
  ): Promise<PreservedMediaObject>;
}

export const unavailableMediaEvidencePreserver: MediaEvidencePreserver = {
  preserve: async () => { throw new Error("MEDIA_EVIDENCE_STORAGE_NOT_CONFIGURED"); },
};

export class StorageMediaEvidencePreserver implements MediaEvidencePreserver {
  constructor(private readonly storage: Pick<StorageAdapter, "copyObject" | "headObject"> | null) {}

  async preserve(source: ImmutableMediaSource, destinationObjectKey: string) {
    if (!this.storage) throw new Error("MEDIA_EVIDENCE_STORAGE_NOT_CONFIGURED");
    await this.storage.copyObject(source.objectKey, destinationObjectKey, {
      sourceETag: source.objectEtag,
      sourceVersionId: source.objectVersion,
    });
    const copied = await this.storage.headObject(destinationObjectKey);
    if (!copied?.versionId || !copied.etag) throw new Error("MEDIA_EVIDENCE_COPY_NOT_AVAILABLE");
    return {
      objectKey: destinationObjectKey,
      objectVersion: copied.versionId,
      objectEtag: copied.etag,
    };
  }
}
