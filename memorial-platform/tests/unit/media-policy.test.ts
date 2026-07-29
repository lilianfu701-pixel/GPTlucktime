import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_TYPES,
  buildObjectKey,
  detectContentType,
  mayHavePublicUrl,
  safeDisplayFileName,
  signatureMatchesDeclared,
  validateDeclaredUpload,
} from "@/modules/media/policy";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00);
const WEBP = bytes(
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
);
const MP4 = bytes(
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
);
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00);
const MP3_ID3 = bytes(0x49, 0x44, 0x33, 0x03, 0x00);
const MP3_FRAME = bytes(0xff, 0xfb, 0x90, 0x00);

// Things people try to upload to an image field.
const WINDOWS_EXE = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03);
const ELF_BINARY = bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01);
const SHELL_SCRIPT = bytes(0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e);
const ZIP_ARCHIVE = bytes(0x50, 0x4b, 0x03, 0x04, 0x14);
const SVG_DOCUMENT = new TextEncoder().encode('<svg onload="alert(1)">');
const HTML_DOCUMENT = new TextEncoder().encode("<!DOCTYPE html><html>");
const PDF_DOCUMENT = bytes(0x25, 0x50, 0x44, 0x46, 0x2d);

describe("accepted types", () => {
  it("covers exactly the documented set", () => {
    expect(ALLOWED_TYPES.map((type) => type.contentType).sort()).toEqual([
      "audio/mpeg",
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
      "video/webm",
    ]);
  });

  it("does not accept SVG", () => {
    // An SVG is a document that can carry script. Accepting one would put an
    // XSS vector on a page families send to relatives.
    expect(ALLOWED_TYPES.map((type) => type.contentType)).not.toContain(
      "image/svg+xml",
    );
  });

  it("recognizes each accepted format from its own bytes", () => {
    expect(detectContentType(JPEG)).toBe("image/jpeg");
    expect(detectContentType(PNG)).toBe("image/png");
    expect(detectContentType(WEBP)).toBe("image/webp");
    expect(detectContentType(MP4)).toBe("video/mp4");
    expect(detectContentType(WEBM)).toBe("video/webm");
    expect(detectContentType(MP3_ID3)).toBe("audio/mpeg");
    expect(detectContentType(MP3_FRAME)).toBe("audio/mpeg");
  });
});

describe("rejected content", () => {
  it("refuses executables, scripts, archives and documents", () => {
    for (const candidate of [
      WINDOWS_EXE,
      ELF_BINARY,
      SHELL_SCRIPT,
      ZIP_ARCHIVE,
      SVG_DOCUMENT,
      HTML_DOCUMENT,
      PDF_DOCUMENT,
    ]) {
      expect(detectContentType(candidate)).toBeNull();
    }
  });

  it("refuses anything it does not recognize, rather than guessing", () => {
    // An allowlist: a deny list of known-bad formats always trails the next
    // polyglot, or the next format with a decoder bug.
    expect(detectContentType(bytes(0x01, 0x02, 0x03, 0x04))).toBeNull();
    expect(detectContentType(new Uint8Array())).toBeNull();
  });

  it("refuses a RIFF container that is not WebP", () => {
    // A WAV file also starts with RIFF.
    const wav = bytes(
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    );
    expect(detectContentType(wav)).toBeNull();
  });

  it("refuses a truncated header", () => {
    expect(detectContentType(bytes(0x89, 0x50))).toBeNull();
    expect(detectContentType(bytes(0xff))).toBeNull();
  });
});

describe("declared type must match the bytes", () => {
  it("accepts an honest declaration", () => {
    expect(signatureMatchesDeclared("image/jpeg", JPEG)).toBe(true);
    expect(signatureMatchesDeclared("IMAGE/JPEG", JPEG)).toBe(true);
  });

  it("refuses an executable announced as an image", () => {
    // Not a mislabelling to be tidied up. This is the attack.
    expect(signatureMatchesDeclared("image/jpeg", WINDOWS_EXE)).toBe(false);
    expect(signatureMatchesDeclared("image/png", ELF_BINARY)).toBe(false);
  });

  it("refuses one accepted format announced as another", () => {
    expect(signatureMatchesDeclared("image/png", JPEG)).toBe(false);
    expect(signatureMatchesDeclared("video/mp4", MP3_ID3)).toBe(false);
  });

  it("refuses an SVG announced as a PNG", () => {
    expect(signatureMatchesDeclared("image/png", SVG_DOCUMENT)).toBe(false);
  });
});

describe("declared size and type", () => {
  it("accepts a photograph within the limit", () => {
    const result = validateDeclaredUpload({
      contentType: "image/jpeg",
      size: 2_000_000,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.kind).toBe("image");
  });

  it("refuses an unsupported type before issuing a URL", () => {
    expect(
      validateDeclaredUpload({ contentType: "image/svg+xml", size: 1000 }),
    ).toEqual({ ok: false, error: "UNSUPPORTED_TYPE" });
    expect(
      validateDeclaredUpload({ contentType: "application/pdf", size: 1000 }),
    ).toEqual({ ok: false, error: "UNSUPPORTED_TYPE" });
  });

  it("refuses an empty file", () => {
    expect(validateDeclaredUpload({ contentType: "image/jpeg", size: 0 })).toEqual(
      { ok: false, error: "EMPTY_FILE" },
    );
    expect(
      validateDeclaredUpload({ contentType: "image/jpeg", size: -1 }),
    ).toEqual({ ok: false, error: "EMPTY_FILE" });
  });

  it("applies a different limit per kind", () => {
    const fortyMB = 40 * 1024 * 1024;
    // Too large for a photograph, fine for a recording.
    expect(
      validateDeclaredUpload({ contentType: "image/jpeg", size: fortyMB }),
    ).toEqual({ ok: false, error: "FILE_TOO_LARGE" });
    expect(
      validateDeclaredUpload({ contentType: "audio/mpeg", size: fortyMB }).ok,
    ).toBe(true);
  });

  it("refuses a video past the video limit", () => {
    expect(
      validateDeclaredUpload({
        contentType: "video/mp4",
        size: 501 * 1024 * 1024,
      }),
    ).toEqual({ ok: false, error: "FILE_TOO_LARGE" });
  });
});

describe("object keys", () => {
  const memorialId = randomUUID();
  const assetId = randomUUID();

  it("are built only from generated identifiers", () => {
    expect(
      buildObjectKey({
        memorialId,
        assetId,
        stage: "quarantine",
        extension: "jpg",
      }),
    ).toBe(`memorials/${memorialId}/quarantine/${assetId}/original.jpg`);
  });

  it("separate a quarantined upload from a ready one", () => {
    // Bytes that have not been scanned live somewhere nothing serves from.
    const quarantined = buildObjectKey({
      memorialId,
      assetId,
      stage: "quarantine",
      extension: "jpg",
    });
    const ready = buildObjectKey({
      memorialId,
      assetId,
      stage: "ready",
      extension: "jpg",
    });

    expect(quarantined).toContain("/quarantine/");
    expect(ready).toContain("/ready/");
    expect(quarantined).not.toBe(ready);
  });

  it("name each derived size separately", () => {
    for (const variant of ["thumb", "medium", "large"] as const) {
      expect(
        buildObjectKey({
          memorialId,
          assetId,
          stage: "ready",
          variant,
          extension: "webp",
        }),
      ).toContain(`/${variant}.webp`);
    }
  });

  it("refuse a path fragment where an identifier belongs", () => {
    // The client filename never reaches a key, but a future caller might pass
    // something through. That must fail loudly, not escape the prefix.
    for (const hostile of [
      "../../etc/passwd",
      "..",
      "a/b",
      `${memorialId}/../other`,
      "",
    ]) {
      expect(() =>
        buildObjectKey({
          memorialId: hostile,
          assetId,
          stage: "ready",
          extension: "jpg",
        }),
      ).toThrow();
      expect(() =>
        buildObjectKey({
          memorialId,
          assetId: hostile,
          stage: "ready",
          extension: "jpg",
        }),
      ).toThrow();
    }
  });

  it("refuse an extension that is not a plain suffix", () => {
    for (const hostile of ["../jpg", "jp g", "jpg/x", "", "PHP"]) {
      expect(() =>
        buildObjectKey({
          memorialId,
          assetId,
          stage: "ready",
          extension: hostile,
        }),
      ).toThrow();
    }
  });

  it("never contain a traversal sequence", () => {
    const key = buildObjectKey({
      memorialId,
      assetId,
      stage: "ready",
      extension: "jpg",
    });
    expect(key).not.toContain("..");
    expect(key.startsWith("memorials/")).toBe(true);
  });
});

describe("display filenames", () => {
  it("keep something readable", () => {
    expect(safeDisplayFileName("grandmother-1972.jpg")).toBe(
      "grandmother-1972.jpg",
    );
  });

  it("drop any directory part", () => {
    expect(safeDisplayFileName("../../etc/passwd")).toBe("passwd");
    expect(safeDisplayFileName("C:\\Users\\me\\photo.jpg")).toBe("photo.jpg");
    expect(safeDisplayFileName("/var/www/photo.png")).toBe("photo.png");
  });

  it("collapse repeated dots", () => {
    expect(safeDisplayFileName("photo..jpg")).toBe("photo.jpg");
    expect(safeDisplayFileName("...hidden")).toBe("hidden");
  });

  it("remove control characters", () => {
    const withNul = `photo${String.fromCharCode(0)}.jpg`;
    const withNewline = `photo${String.fromCharCode(10)}.jpg`;
    expect(safeDisplayFileName(withNul)).toBe("photo.jpg");
    expect(safeDisplayFileName(withNewline)).toBe("photo.jpg");
  });

  it("never return an empty label", () => {
    expect(safeDisplayFileName("")).toBe("upload");
    expect(safeDisplayFileName("///")).toBe("upload");
    expect(safeDisplayFileName("...")).toBe("upload");
  });

  it("bound the length", () => {
    expect(safeDisplayFileName("a".repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe("public addresses", () => {
  it("are allowed only for a ready asset on a public memorial", () => {
    expect(
      mayHavePublicUrl({ status: "ready", memorialVisibility: "public" }),
    ).toBe(true);
  });

  it("are never allowed for private media", () => {
    // Doc 06 section 4: private media must not have a permanent public URL, so
    // that revoking access does not depend on a CDN forgetting something.
    for (const visibility of ["unlisted", "invite_only"] as const) {
      expect(
        mayHavePublicUrl({ status: "ready", memorialVisibility: visibility }),
      ).toBe(false);
    }
  });

  it("are never allowed before the asset is ready", () => {
    for (const status of [
      "pending_upload",
      "scanning",
      "processing",
      "rejected",
      "deleted",
    ]) {
      expect(mayHavePublicUrl({ status, memorialVisibility: "public" })).toBe(
        false,
      );
    }
  });
});
