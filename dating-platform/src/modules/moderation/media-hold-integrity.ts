import { createHash, timingSafeEqual } from "node:crypto";

export type MediaHoldSnapshot = {
  reportId: string;
  caseId: string;
  subjectUserId: string;
  photoId: string;
  objectKey: string;
  objectVersion: string;
  preserveUntil: Date;
};

const serializedSnapshot = (input: MediaHoldSnapshot) => JSON.stringify({
  reportId: input.reportId,
  caseId: input.caseId,
  subjectUserId: input.subjectUserId,
  photoId: input.photoId,
  objectKey: input.objectKey,
  objectVersion: input.objectVersion,
  preserveUntil: input.preserveUntil.toISOString(),
});

export const mediaHoldSnapshotSha256 = (input: MediaHoldSnapshot) => createHash("sha256")
  .update(serializedSnapshot(input)).digest("hex");

export const verifyMediaHoldSnapshot = (input: MediaHoldSnapshot, expectedHex: string) => {
  if (!/^[a-f0-9]{64}$/u.test(expectedHex)) return false;
  const calculated = Buffer.from(mediaHoldSnapshotSha256(input), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return calculated.length === expected.length && timingSafeEqual(calculated, expected);
};
