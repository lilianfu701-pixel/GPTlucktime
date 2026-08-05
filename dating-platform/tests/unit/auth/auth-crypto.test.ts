import { describe, expect, it } from "vitest";

import {
  EncryptionKeyRing,
  StableHmac,
  parseEncryptionKeyRing,
  parseLegacyEncryptionKeys,
} from "@/modules/auth/auth-crypto";

const key = (byte: number) => Buffer.alloc(32, byte).toString("base64");

describe("authentication crypto key rotation", () => {
  it("parses an active-first key ring and rejects duplicate key ids", () => {
    expect(parseEncryptionKeyRing(`current:${key(1)},previous:${key(2)}`))
      .toEqual([{ id: "current", key: key(1) }, { id: "previous", key: key(2) }]);
    expect(() => parseEncryptionKeyRing(`same:${key(1)},same:${key(2)}`))
      .toThrow("AUTH_ENCRYPTION_KEY_ID_DUPLICATE");
  });

  it("writes with the active key and keeps old ciphertext readable during rotation", () => {
    const oldRing = new EncryptionKeyRing([{ id: "old", key: key(2) }]);
    const oldPayload = oldRing.encrypt("old-secret");
    const rotated = new EncryptionKeyRing([
      { id: "new", key: key(3) },
      { id: "old", key: key(2) },
    ]);
    expect(rotated.decrypt(oldPayload)).toBe("old-secret");
    expect(rotated.encrypt("new-secret").keyId).toBe("new");
  });

  it("fails observably when a ciphertext read key has been removed", () => {
    const encrypted = new EncryptionKeyRing([{ id: "old", key: key(2) }]).encrypt("secret");
    expect(() => new EncryptionKeyRing([{ id: "new", key: key(3) }]).decrypt(encrypted))
      .toThrow("AUTH_ENCRYPTION_KEY_UNAVAILABLE");
  });

  it("uses a stable HMAC key independent of encryption rotation", () => {
    const hmac = new StableHmac("stable-hmac-secret-at-least-32-characters");
    expect(hmac.digest("delivery", "recipient", "payload"))
      .toBe(hmac.digest("delivery", "recipient", "payload"));
    expect(hmac.digest("delivery", "recipient", "payload"))
      .not.toBe(new StableHmac("other-stable-hmac-secret-at-least-32-chars").digest("delivery", "recipient", "payload"));
  });

  it("decrypts null-key-id legacy ciphertext only with an explicit legacy key", () => {
    const legacyKey = key(5);
    const legacyWriter = new EncryptionKeyRing([{ id: "legacy-writer", key: legacyKey }]);
    const legacy = legacyWriter.encrypt("legacy secret");
    const upgraded = new EncryptionKeyRing(
      [{ id: "current", key: key(6) }],
      { legacyKey },
    );

    expect(upgraded.decrypt({ keyId: null, ciphertext: legacy.ciphertext })).toBe("legacy secret");
    expect(() => new EncryptionKeyRing([{ id: "current", key: key(6) }])
      .decrypt({ keyId: null, ciphertext: legacy.ciphertext }))
      .toThrow("AUTH_LEGACY_ENCRYPTION_KEY_UNAVAILABLE");
  });

  it("maps distinct legacy email, SMS, and identity keys without guessing", () => {
    const email = new EncryptionKeyRing([{ id: "email-writer", key: key(7) }])
      .encrypt("legacy email");
    const sms = new EncryptionKeyRing([{ id: "sms-writer", key: key(8) }])
      .encrypt("legacy sms");
    const upgraded = new EncryptionKeyRing([{ id: "current", key: key(9) }], {
      legacyKeys: parseLegacyEncryptionKeys(
        `email:${key(7)},sms:${key(8)},identity:${key(10)}`,
      ),
    });

    expect(upgraded.decrypt({ ...email, keyId: null, legacyPurpose: "email" }))
      .toBe("legacy email");
    expect(upgraded.decrypt({ ...sms, keyId: null, legacyPurpose: "sms" }))
      .toBe("legacy sms");
    expect(() => upgraded.decrypt({ ...email, keyId: null }))
      .toThrow("AUTH_LEGACY_ENCRYPTION_KEY_UNAVAILABLE");
  });
});
