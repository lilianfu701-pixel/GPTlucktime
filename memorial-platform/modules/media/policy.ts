import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";

export type MediaKind = "image" | "video" | "audio";

/**
 * What the platform accepts.
 *
 * An allowlist, matched against the file's own leading bytes. Anything not
 * recognized is refused: a deny list of known-bad formats always trails the
 * next polyglot or the next format someone finds a decoder bug in.
 *
 * SVG is deliberately absent. It is a document that can carry script, so
 * accepting it would put an XSS vector on a page families send to relatives.
 *
 * Byte limits are engineering defaults. The free quota is a product decision
 * still open in doc 11 section 6.
 */
export type AllowedType = {
  contentType: string;
  kind: MediaKind;
  extension: string;
  maxBytes: number;
  /** Leading-byte patterns; `null` means any byte at that offset. */
  signatures: (number | null)[][];
  /** Extra patterns checked at a fixed offset, for container formats. */
  offsetSignatures?: { offset: number; bytes: number[] }[];
};

const MB = 1024 * 1024;

export const ALLOWED_TYPES: readonly AllowedType[] = [
  {
    contentType: "image/jpeg",
    kind: "image",
    extension: "jpg",
    maxBytes: 15 * MB,
    signatures: [[0xff, 0xd8, 0xff]],
  },
  {
    contentType: "image/png",
    kind: "image",
    extension: "png",
    maxBytes: 15 * MB,
    signatures: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  },
  {
    contentType: "image/webp",
    kind: "image",
    extension: "webp",
    maxBytes: 15 * MB,
    // "RIFF" then four size bytes then "WEBP".
    signatures: [[0x52, 0x49, 0x46, 0x46]],
    offsetSignatures: [{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }],
  },
  {
    contentType: "video/mp4",
    kind: "video",
    extension: "mp4",
    maxBytes: 500 * MB,
    // The first four bytes are a box length, then "ftyp".
    signatures: [[null, null, null, null, 0x66, 0x74, 0x79, 0x70]],
  },
  {
    contentType: "video/webm",
    kind: "video",
    extension: "webm",
    maxBytes: 500 * MB,
    signatures: [[0x1a, 0x45, 0xdf, 0xa3]],
  },
  {
    contentType: "audio/mpeg",
    kind: "audio",
    extension: "mp3",
    maxBytes: 50 * MB,
    signatures: [
      // An ID3 tag, or a bare frame header.
      [0x49, 0x44, 0x33],
      [0xff, 0xfb],
      [0xff, 0xf3],
      [0xff, 0xf2],
      [0xff, 0xfa],
    ],
  },
];

export type UploadPolicyError =
  | "UNSUPPORTED_TYPE"
  | "FILE_TOO_LARGE"
  | "EMPTY_FILE";

/**
 * Checks what the client says it is about to upload.
 *
 * A declaration is only a claim. It is worth checking early so an obviously
 * unacceptable upload is refused before a URL is issued, but the bytes are
 * checked again once they arrive.
 */
export function validateDeclaredUpload(input: {
  contentType: string;
  size: number;
}): Result<AllowedType, UploadPolicyError> {
  const allowed = ALLOWED_TYPES.find(
    (type) => type.contentType === input.contentType.toLowerCase().trim(),
  );

  if (!allowed) {
    return err("UNSUPPORTED_TYPE");
  }

  if (input.size <= 0) {
    return err("EMPTY_FILE");
  }

  if (input.size > allowed.maxBytes) {
    return err("FILE_TOO_LARGE");
  }

  return ok(allowed);
}

function matchesPattern(bytes: Uint8Array, pattern: (number | null)[]): boolean {
  if (bytes.length < pattern.length) {
    return false;
  }

  return pattern.every(
    (expected, index) => expected === null || bytes[index] === expected,
  );
}

function matchesType(bytes: Uint8Array, type: AllowedType): boolean {
  const leadingMatch = type.signatures.some((pattern) =>
    matchesPattern(bytes, pattern),
  );
  if (!leadingMatch) {
    return false;
  }

  for (const extra of type.offsetSignatures ?? []) {
    const slice = bytes.subarray(extra.offset, extra.offset + extra.bytes.length);
    if (slice.length < extra.bytes.length) {
      return false;
    }
    if (!extra.bytes.every((expected, index) => slice[index] === expected)) {
      return false;
    }
  }

  return true;
}

/** The type the bytes actually are, or null when they are not one we accept. */
export function detectContentType(bytes: Uint8Array): string | null {
  const match = ALLOWED_TYPES.find((type) => matchesType(bytes, type));
  return match?.contentType ?? null;
}

/**
 * Confirms the bytes are what the upload claimed.
 *
 * A mismatch is refused rather than corrected. An executable announced as a
 * JPEG is not a mislabelling to be tidied up; it is the attack.
 */
export function signatureMatchesDeclared(
  declaredContentType: string,
  bytes: Uint8Array,
): boolean {
  const detected = detectContentType(bytes);
  return detected !== null && detected === declaredContentType.toLowerCase().trim();
}

const SPACE_CODE_POINT = 0x20;
const DELETE_CODE_POINT = 0x7f;

/**
 * Drops control characters.
 *
 * Written as a code-point filter rather than a regular expression on purpose:
 * a literal control character inside a pattern is invisible in review and is
 * easy for an editor or a shell to mangle.
 */
function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= SPACE_CODE_POINT && code !== DELETE_CODE_POINT;
    })
    .join("");
}

/**
 * Reduces a client-supplied filename to something safe to store as a label.
 *
 * The result is never used to build a storage key. Directory separators,
 * traversal sequences and control characters are removed regardless, because a
 * value that only travels through display today has a way of ending up in a
 * path tomorrow.
 */
export function safeDisplayFileName(input: string): string {
  const withoutPath = stripControlCharacters(input).split(/[/\\]/).pop() ?? "";
  const cleaned = withoutPath
    .replace(/\.{2,}/g, ".")
    .replace(/[^\w.\- ]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);

  return cleaned.length > 0 ? cleaned : "upload";
}

export const QUARANTINE_PREFIX = "quarantine";
export const READY_PREFIX = "ready";

export type MediaVariant = "original" | "thumb" | "medium" | "large";

/**
 * Builds the storage key.
 *
 * Composed entirely from server-side values: the memorial id, the asset id we
 * generated, and a variant name from a fixed set. The client's filename never
 * appears, so there is no path for `../` to travel down. Both identifiers are
 * re-checked here rather than trusted, so a caller that forwards a raw path
 * fragment fails loudly instead of producing a key outside the prefix.
 */
export function buildObjectKey(input: {
  memorialId: string;
  assetId: string;
  stage: "quarantine" | "ready";
  variant?: MediaVariant | undefined;
  extension: string;
}): string {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(input.memorialId) || !uuid.test(input.assetId)) {
    throw new Error("object keys are built from generated identifiers only");
  }

  if (!/^[a-z0-9]{2,5}$/.test(input.extension)) {
    throw new Error("object keys use an extension from the allowed type list");
  }

  const prefix = input.stage === "quarantine" ? QUARANTINE_PREFIX : READY_PREFIX;
  const variant = input.variant ?? "original";

  return `memorials/${input.memorialId}/${prefix}/${input.assetId}/${variant}.${input.extension}`;
}

/**
 * Whether an object may ever be served from a permanently public address.
 *
 * Only a ready asset on a public memorial. Everything else is reached through a
 * short-lived signed URL, so revoking access does not depend on a CDN forgetting
 * something. See doc 06 section 4.
 */
export function mayHavePublicUrl(input: {
  status: string;
  memorialVisibility: "public" | "unlisted" | "invite_only";
}): boolean {
  return input.status === "ready" && input.memorialVisibility === "public";
}
