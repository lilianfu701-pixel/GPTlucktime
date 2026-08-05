import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export type EncryptionKeyConfig = { id: string; key: string };
export type LegacyEncryptionPurpose = "email" | "sms" | "identity";
export type LegacyEncryptionKeys = Partial<Record<LegacyEncryptionPurpose, string>>;
export type EncryptedValue = {
  keyId: string | null;
  ciphertext: string;
  legacyPurpose?: LegacyEncryptionPurpose;
};

function decodeKey(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error("AUTH_ENCRYPTION_KEY_INVALID");
  }
  return decoded;
}

export function parseEncryptionKeyRing(value: string): EncryptionKeyConfig[] {
  const seen = new Set<string>();
  return value.split(",").map((entry) => {
    const separator = entry.indexOf(":");
    const id = entry.slice(0, separator);
    const key = entry.slice(separator + 1);
    if (separator < 1 || !/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      throw new Error("AUTH_ENCRYPTION_KEY_ID_INVALID");
    }
    if (seen.has(id)) throw new Error("AUTH_ENCRYPTION_KEY_ID_DUPLICATE");
    seen.add(id);
    decodeKey(key);
    return { id, key };
  });
}

export function parseLegacyEncryptionKeys(value: string): LegacyEncryptionKeys {
  if (!value.includes(":")) {
    decodeKey(value);
    return { email: value, sms: value, identity: value };
  }
  const keys: LegacyEncryptionKeys = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf(":");
    const purpose = entry.slice(0, separator) as LegacyEncryptionPurpose;
    const key = entry.slice(separator + 1);
    if (!["email", "sms", "identity"].includes(purpose) || keys[purpose]) {
      throw new Error("AUTH_LEGACY_ENCRYPTION_KEY_MAPPING_INVALID");
    }
    decodeKey(key);
    keys[purpose] = key;
  }
  if (Object.keys(keys).length === 0) throw new Error("AUTH_LEGACY_ENCRYPTION_KEY_MAPPING_INVALID");
  return keys;
}

export class EncryptionKeyRing {
  private readonly active: { id: string; key: Buffer };
  private readonly keys: Map<string, Buffer>;
  private readonly legacyKey?: Buffer;
  private readonly legacyKeys: Partial<Record<LegacyEncryptionPurpose, Buffer>>;

  constructor(config: EncryptionKeyConfig[], options: {
    legacyKey?: string;
    legacyKeys?: LegacyEncryptionKeys;
  } = {}) {
    if (config.length === 0) throw new Error("AUTH_ENCRYPTION_KEY_RING_EMPTY");
    this.keys = new Map(config.map(({ id, key }) => [id, decodeKey(key)]));
    if (this.keys.size !== config.length) throw new Error("AUTH_ENCRYPTION_KEY_ID_DUPLICATE");
    this.active = { id: config[0].id, key: decodeKey(config[0].key) };
    this.legacyKey = options.legacyKey ? decodeKey(options.legacyKey) : undefined;
    this.legacyKeys = Object.fromEntries(
      Object.entries(options.legacyKeys ?? {}).map(([purpose, key]) => [purpose, decodeKey(key)]),
    );
  }

  encrypt(value: string): EncryptedValue {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.active.key, nonce);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      keyId: this.active.id,
      ciphertext: [
        "v1",
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
      ].join("."),
    };
  }

  decrypt(value: EncryptedValue): string {
    const key = value.keyId === null
      ? (value.legacyPurpose
          ? (this.legacyKeys[value.legacyPurpose] ?? this.legacyKey)
          : this.legacyKey)
      : this.keys.get(value.keyId);
    if (!key) {
      throw new Error(value.keyId === null
        ? "AUTH_LEGACY_ENCRYPTION_KEY_UNAVAILABLE"
        : "AUTH_ENCRYPTION_KEY_UNAVAILABLE");
    }
    const [version, nonce, tag, ciphertext] = value.ciphertext.split(".");
    if (version !== "v1" || !nonce || !tag || !ciphertext) {
      throw new Error("AUTH_ENCRYPTED_PAYLOAD_INVALID");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("AUTH_ENCRYPTED_PAYLOAD_INVALID");
    }
  }
}

export class StableHmac {
  private readonly key: Buffer;

  constructor(value: string) {
    if (Buffer.byteLength(value, "utf8") < 32) throw new Error("AUTH_HMAC_KEY_INVALID");
    this.key = Buffer.from(value, "utf8");
  }

  digest(...parts: string[]): string {
    const hmac = createHmac("sha256", this.key);
    for (const part of parts) hmac.update(part).update("\0");
    return hmac.digest("base64url");
  }
}
