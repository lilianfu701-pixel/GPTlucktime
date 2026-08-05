import { describe, expect, it } from "vitest";

import { EncryptionKeyRing, StableHmac, parseEncryptionKeyRing } from "@/modules/auth/auth-crypto";

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
});
