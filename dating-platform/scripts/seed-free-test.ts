import { randomBytes as nodeRandomBytes, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, stat, unlink, writeFile, chmod } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { hashPassword as betterAuthHashPassword, verifyPassword as betterAuthVerifyPassword } from "better-auth/crypto";
import type { Pool, PoolClient } from "pg";

import {
  parseExpectedDatabaseArguments,
  parseFreeTestDatabaseTarget,
  requireExactDatabaseTarget,
} from "./run-free-test-migration.mjs";

export const FREE_TEST_SEED_ERROR = "FREE_TEST_SEED_REJECTED";
const CONFIRMATION = "datecn-free-test";
const CREDENTIAL_VERSION = 1;
const CREDENTIAL_EMAILS = ["alice@datecn.test", "liam@datecn.test"] as const;
const FORBIDDEN_EXACT = new Set(["REALTIME_PUBLIC_URL"]);
const FORBIDDEN_PREFIXES = ["E2E_", "STRIPE_", "EMAIL_", "SMS_", "IDENTITY_"];
const CREATED_AT = "2026-08-24T12:00:00.000Z";
const SECOND_MESSAGE_AT = "2026-08-24T12:01:00.000Z";
const ADVISORY_LOCK_KEY = "-487642985260015191";
const APPLICATION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CREDENTIALS_PATH = resolve(APPLICATION_ROOT, ".artifacts", "free-test-credentials.json");

const rejected = () => new Error(FREE_TEST_SEED_ERROR);

type PasswordVerifier = (input: { hash: string; password: string }) => Promise<boolean>;
type RandomBytes = (size: number) => Buffer;

export type FreeTestCredentials = {
  version: 1;
  users: [
    { email: "alice@datecn.test"; password: string },
    { email: "liam@datecn.test"; password: string },
  ];
};

type UserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  phoneNumber: null;
  phoneNumberVerified: false;
  twoFactorEnabled: false;
  image: null;
  createdAt: string;
  updatedAt: string;
};

type AccountRow = {
  id: string;
  accountId: string;
  providerId: "credential";
  userId: string;
  accessToken: null;
  refreshToken: null;
  idToken: null;
  accessTokenExpiresAt: null;
  refreshTokenExpiresAt: null;
  scope: null;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
};

type InterestRow = {
  id: string;
  code: string;
  label: string;
  createdAt: string;
  updatedAt: string;
};

type ProfileInterestRow = {
  id: string;
  profileId: string;
  interestId: string;
  createdAt: string;
};

type PhotoRow = {
  id: string;
  userId: string;
  profileId: string;
  uploadId: null;
  objectKey: string;
  objectVersion: null;
  objectEtag: null;
  preservationStatus: "legacy_unversioned";
  position: 0;
  actualMimeType: null;
  actualSizeBytes: null;
  width: null;
  height: null;
  moderationStatus: "approved";
  moderationReasonCode: null;
  reviewProvider: "free-test-seed";
  reviewVersion: "1";
  reviewedAt: string;
  cleanupDueAt: null;
  objectDeletedAt: null;
  deletionStatus: "idle";
  deletionLeaseId: null;
  deletionLeaseExpiresAt: null;
  userRemovedAt: null;
  createdAt: string;
  updatedAt: string;
};

type ProfileRow = {
  id: string;
  userId: string;
  displayName: string;
  birthDate: string;
  genderCode: string;
  relationshipGoalCode: string;
  countryCode: string;
  timeZone: string;
  city: string;
  bio: string;
  publishRequested: true;
  discoverable: true;
  status: "active";
  createdAt: string;
  updatedAt: string;
};

type PreferenceRow = {
  id: string;
  userId: string;
  genderCodes: string[];
  minimumAge: number;
  maximumAge: number;
  preferredCountryCodes: string[];
  languageCodes: string[];
  relationshipGoalCodes: string[];
  createdAt: string;
  updatedAt: string;
};

type PrivacyRow = {
  id: string;
  userId: string;
  showOnlineStatus: true;
  showLastActive: true;
  showProfileVisitors: true;
  locationPrecision: "city";
  createdAt: string;
  updatedAt: string;
};

type MembershipRow = {
  id: string;
  userId: string;
  planRef: "free-test";
  version: 1;
  active: true;
  effectiveAt: string;
  expiresAt: null;
  createdAt: string;
};

type LikeRow = {
  id: string;
  actorUserId: string;
  targetUserId: string;
  active: true;
  createdAt: string;
  updatedAt: string;
  revokedAt: null;
};

type MatchRow = {
  id: string;
  lowUserId: string;
  highUserId: string;
  status: "active";
  createdAt: string;
  updatedAt: string;
  hiddenAt: null;
};

type ConversationRow = {
  id: string;
  lowUserId: string;
  highUserId: string;
  status: "active";
  nextSequence: 3;
  version: 1;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
};

type ConversationMemberRow = {
  conversationId: string;
  userId: string;
  lowUserId: string;
  highUserId: string;
  lastReadSequence: number;
  hiddenAt: null;
  version: 1;
  joinedAt: string;
  updatedAt: string;
};

type MessageRow = {
  id: string;
  conversationId: string;
  lowUserId: string;
  highUserId: string;
  sequence: number;
  senderUserId: string;
  clientId: string;
  body: string;
  createdAt: string;
};

export type FreeTestSeedGraph = {
  users: UserRow[];
  accounts: AccountRow[];
  profiles: ProfileRow[];
  profilePreferences: PreferenceRow[];
  privacySettings: PrivacyRow[];
  interests: InterestRow[];
  profileInterests: ProfileInterestRow[];
  photos: PhotoRow[];
  memberships: MembershipRow[];
  likes: LikeRow[];
  match: MatchRow;
  conversation: ConversationRow;
  conversationMembers: ConversationMemberRow[];
  messages: MessageRow[];
};

export type FreeTestSeedSnapshot = { graph: FreeTestSeedGraph | null };

export interface SeedTransaction {
  acquireSeedLock(): Promise<void>;
  insertMissing(graph: FreeTestSeedGraph): Promise<void>;
  readSeedSnapshot(): Promise<FreeTestSeedSnapshot>;
}

export interface SeedDatabase {
  transaction<T>(work: (transaction: SeedTransaction) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

const hasValue = (value: unknown) => typeof value === "string" && value.length > 0;

export function validateFreeTestSeedEnvironment(
  env: Partial<NodeJS.ProcessEnv>,
  argv: string[],
) {
  try {
    if (env.FREE_TEST_MODE !== "1" || env.FREE_TEST_SEED_CONFIRM !== CONFIRMATION) throw rejected();
    for (const [name, value] of Object.entries(env)) {
      if (hasValue(value) && (FORBIDDEN_EXACT.has(name)
        || FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix)))) throw rejected();
    }
    if (typeof env.APP_URL !== "string") throw rejected();
    const appUrl = new URL(env.APP_URL);
    const hostname = appUrl.hostname.toLowerCase();
    if (appUrl.protocol !== "https:" || appUrl.origin !== env.APP_URL
      || appUrl.username || appUrl.password || appUrl.pathname !== "/"
      || appUrl.search || appUrl.hash || hostname === "localhost"
      || hostname.endsWith(".localhost") || isIP(hostname) !== 0) throw rejected();
    const database = parseFreeTestDatabaseTarget(env);
    requireExactDatabaseTarget(database, parseExpectedDatabaseArguments(argv));
    return {
      appOrigin: appUrl.origin,
      database,
    };
  } catch {
    throw rejected();
  }
}

function validateCredentials(value: unknown): FreeTestCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw rejected();
  const record = value as Record<string, unknown>;
  if (!isDeepStrictEqual(Object.keys(record).sort(), ["users", "version"]) || record.version !== 1
    || !Array.isArray(record.users) || record.users.length !== 2) throw rejected();
  const users = record.users as Array<Record<string, unknown>>;
  for (let index = 0; index < users.length; index += 1) {
    const user = users[index];
    if (!user || !isDeepStrictEqual(Object.keys(user).sort(), ["email", "password"])
      || user.email !== CREDENTIAL_EMAILS[index]
      || typeof user.password !== "string"
      || !/^[A-Za-z0-9_-]{32}$/u.test(user.password)) throw rejected();
  }
  return value as FreeTestCredentials;
}

export function validateCredentialFileType(file: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}) {
  if (!file.isFile() || file.isSymbolicLink()) throw rejected();
}

export function validateCredentialDirectoryType(directory: {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}) {
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw rejected();
}

async function secureCredentialPermissions(path: string) {
  try {
    await chmod(path, 0o600);
    if (process.platform !== "win32" && ((await stat(path)).mode & 0o777) !== 0o600) throw rejected();
  } catch {
    if (process.platform !== "win32") throw rejected();
  }
}

async function readCredentials(path: string) {
  try {
    validateCredentialFileType(await lstat(path));
    const raw = await readFile(path, "utf8");
    const credentials = validateCredentials(JSON.parse(raw) as unknown);
    await secureCredentialPermissions(path);
    validateCredentialFileType(await lstat(path));
    return credentials;
  } catch {
    throw rejected();
  }
}

export async function createCredentialsFile({
  path,
  randomBytes = nodeRandomBytes,
}: {
  path: string;
  randomBytes?: RandomBytes;
}): Promise<FreeTestCredentials> {
  try {
    try {
      return await readCredentials(path);
    } catch {
      // The exclusive hard-link below distinguishes an absent destination from a conflict.
    }
    const credentials = validateCredentials({
      version: CREDENTIAL_VERSION,
      users: CREDENTIAL_EMAILS.map((email) => ({
        email,
        password: randomBytes(24).toString("base64url"),
      })),
    });
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    validateCredentialDirectoryType(await lstat(directory));
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await secureCredentialPermissions(temporaryPath);
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return await readCredentials(path);
  } catch {
    throw rejected();
  }
}

const ids = {
  aliceUser: "10000000-0000-4000-8000-000000000001",
  liamUser: "10000000-0000-4000-8000-000000000002",
  aliceAccount: "20000000-0000-4000-8000-000000000001",
  liamAccount: "20000000-0000-4000-8000-000000000002",
  aliceProfile: "30000000-0000-4000-8000-000000000001",
  liamProfile: "30000000-0000-4000-8000-000000000002",
  alicePreference: "40000000-0000-4000-8000-000000000001",
  liamPreference: "40000000-0000-4000-8000-000000000002",
  alicePrivacy: "50000000-0000-4000-8000-000000000001",
  liamPrivacy: "50000000-0000-4000-8000-000000000002",
  cookingInterest: "51000000-0000-4000-8000-000000000001",
  hikingInterest: "51000000-0000-4000-8000-000000000002",
  photographyInterest: "51000000-0000-4000-8000-000000000003",
  aliceCooking: "52000000-0000-4000-8000-000000000001",
  alicePhotography: "52000000-0000-4000-8000-000000000002",
  liamHiking: "52000000-0000-4000-8000-000000000003",
  liamPhotography: "52000000-0000-4000-8000-000000000004",
  alicePhoto: "53000000-0000-4000-8000-000000000001",
  liamPhoto: "53000000-0000-4000-8000-000000000002",
  aliceMembership: "60000000-0000-4000-8000-000000000001",
  liamMembership: "60000000-0000-4000-8000-000000000002",
  aliceLike: "70000000-0000-4000-8000-000000000001",
  liamLike: "70000000-0000-4000-8000-000000000002",
  match: "80000000-0000-4000-8000-000000000001",
  conversation: "90000000-0000-4000-8000-000000000001",
  aliceMessage: "a0000000-0000-4000-8000-000000000001",
  liamMessage: "a0000000-0000-4000-8000-000000000002",
  aliceClient: "b0000000-0000-4000-8000-000000000001",
  liamClient: "b0000000-0000-4000-8000-000000000002",
} as const;

function createGraph(passwordHashes: [string, string]): FreeTestSeedGraph {
  const pair = { lowUserId: ids.aliceUser, highUserId: ids.liamUser };
  return {
    users: [
      { id: ids.aliceUser, name: "Alice Chen", email: CREDENTIAL_EMAILS[0], emailVerified: true,
        phoneNumber: null, phoneNumberVerified: false, twoFactorEnabled: false, image: null,
        createdAt: CREATED_AT, updatedAt: CREATED_AT },
      { id: ids.liamUser, name: "Liam Wang", email: CREDENTIAL_EMAILS[1], emailVerified: true,
        phoneNumber: null, phoneNumberVerified: false, twoFactorEnabled: false, image: null,
        createdAt: CREATED_AT, updatedAt: CREATED_AT },
    ],
    accounts: [
      { id: ids.aliceAccount, accountId: ids.aliceUser, providerId: "credential", userId: ids.aliceUser,
        accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null, scope: null, passwordHash: passwordHashes[0],
        createdAt: CREATED_AT, updatedAt: CREATED_AT },
      { id: ids.liamAccount, accountId: ids.liamUser, providerId: "credential", userId: ids.liamUser,
        accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null, scope: null, passwordHash: passwordHashes[1],
        createdAt: CREATED_AT, updatedAt: CREATED_AT },
    ],
    profiles: [
      { id: ids.aliceProfile, userId: ids.aliceUser, displayName: "Alice", birthDate: "1992-04-18",
        genderCode: "woman", relationshipGoalCode: "long-term", countryCode: "US",
        timeZone: "America/Los_Angeles", city: "San Francisco",
        bio: "Fictional DateCN test member who enjoys museums, cooking, and coastal walks.",
        publishRequested: true, discoverable: true, status: "active", createdAt: CREATED_AT, updatedAt: CREATED_AT },
      { id: ids.liamProfile, userId: ids.liamUser, displayName: "Liam", birthDate: "1989-11-03",
        genderCode: "man", relationshipGoalCode: "long-term", countryCode: "CA",
        timeZone: "America/Vancouver", city: "Vancouver",
        bio: "Fictional DateCN test member who enjoys photography, hiking, and learning languages.",
        publishRequested: true, discoverable: true, status: "active", createdAt: CREATED_AT, updatedAt: CREATED_AT },
    ],
    profilePreferences: [
      { id: ids.alicePreference, userId: ids.aliceUser, genderCodes: ["man"], minimumAge: 28, maximumAge: 45,
        preferredCountryCodes: ["US", "CA"], languageCodes: ["en", "zh-CN"],
        relationshipGoalCodes: ["long-term"], createdAt: CREATED_AT, updatedAt: CREATED_AT },
      { id: ids.liamPreference, userId: ids.liamUser, genderCodes: ["woman"], minimumAge: 28, maximumAge: 45,
        preferredCountryCodes: ["US", "CA"], languageCodes: ["en", "zh-CN"],
        relationshipGoalCodes: ["long-term"], createdAt: CREATED_AT, updatedAt: CREATED_AT },
    ],
    privacySettings: [
      { id: ids.alicePrivacy, userId: ids.aliceUser, showOnlineStatus: true, showLastActive: true,
        showProfileVisitors: true, locationPrecision: "city", createdAt: CREATED_AT, updatedAt: CREATED_AT },
      { id: ids.liamPrivacy, userId: ids.liamUser, showOnlineStatus: true, showLastActive: true,
        showProfileVisitors: true, locationPrecision: "city", createdAt: CREATED_AT, updatedAt: CREATED_AT },
    ],
    interests: [
      { id: ids.cookingInterest, code: "cooking", label: "Cooking", createdAt: CREATED_AT, updatedAt: CREATED_AT },
      { id: ids.hikingInterest, code: "hiking", label: "Hiking", createdAt: CREATED_AT, updatedAt: CREATED_AT },
      { id: ids.photographyInterest, code: "photography", label: "Photography",
        createdAt: CREATED_AT, updatedAt: CREATED_AT },
    ],
    profileInterests: [
      { id: ids.aliceCooking, profileId: ids.aliceProfile, interestId: ids.cookingInterest,
        createdAt: CREATED_AT },
      { id: ids.alicePhotography, profileId: ids.aliceProfile, interestId: ids.photographyInterest,
        createdAt: CREATED_AT },
      { id: ids.liamHiking, profileId: ids.liamProfile, interestId: ids.hikingInterest,
        createdAt: CREATED_AT },
      { id: ids.liamPhotography, profileId: ids.liamProfile, interestId: ids.photographyInterest,
        createdAt: CREATED_AT },
    ],
    photos: [
      { id: ids.alicePhoto, userId: ids.aliceUser, profileId: ids.aliceProfile, uploadId: null,
        objectKey: "free-test-placeholder/alice.profile", objectVersion: null, objectEtag: null,
        preservationStatus: "legacy_unversioned", position: 0, actualMimeType: null, actualSizeBytes: null,
        width: null, height: null, moderationStatus: "approved", moderationReasonCode: null,
        reviewProvider: "free-test-seed", reviewVersion: "1", reviewedAt: CREATED_AT, cleanupDueAt: null,
        objectDeletedAt: null, deletionStatus: "idle", deletionLeaseId: null, deletionLeaseExpiresAt: null,
        userRemovedAt: null, createdAt: CREATED_AT, updatedAt: CREATED_AT },
      { id: ids.liamPhoto, userId: ids.liamUser, profileId: ids.liamProfile, uploadId: null,
        objectKey: "free-test-placeholder/liam.profile", objectVersion: null, objectEtag: null,
        preservationStatus: "legacy_unversioned", position: 0, actualMimeType: null, actualSizeBytes: null,
        width: null, height: null, moderationStatus: "approved", moderationReasonCode: null,
        reviewProvider: "free-test-seed", reviewVersion: "1", reviewedAt: CREATED_AT, cleanupDueAt: null,
        objectDeletedAt: null, deletionStatus: "idle", deletionLeaseId: null, deletionLeaseExpiresAt: null,
        userRemovedAt: null, createdAt: CREATED_AT, updatedAt: CREATED_AT },
    ],
    memberships: [
      { id: ids.aliceMembership, userId: ids.aliceUser, planRef: "free-test", version: 1, active: true,
        effectiveAt: CREATED_AT, expiresAt: null, createdAt: CREATED_AT },
      { id: ids.liamMembership, userId: ids.liamUser, planRef: "free-test", version: 1, active: true,
        effectiveAt: CREATED_AT, expiresAt: null, createdAt: CREATED_AT },
    ],
    likes: [
      { id: ids.aliceLike, actorUserId: ids.aliceUser, targetUserId: ids.liamUser, active: true,
        createdAt: CREATED_AT, updatedAt: CREATED_AT, revokedAt: null },
      { id: ids.liamLike, actorUserId: ids.liamUser, targetUserId: ids.aliceUser, active: true,
        createdAt: CREATED_AT, updatedAt: CREATED_AT, revokedAt: null },
    ],
    match: { id: ids.match, ...pair, status: "active", createdAt: CREATED_AT,
      updatedAt: CREATED_AT, hiddenAt: null },
    conversation: { id: ids.conversation, ...pair, status: "active", nextSequence: 3, version: 1,
      lastMessageAt: SECOND_MESSAGE_AT, createdAt: CREATED_AT, updatedAt: SECOND_MESSAGE_AT },
    conversationMembers: [
      { conversationId: ids.conversation, userId: ids.aliceUser, ...pair, lastReadSequence: 2,
        hiddenAt: null, version: 1, joinedAt: CREATED_AT, updatedAt: SECOND_MESSAGE_AT },
      { conversationId: ids.conversation, userId: ids.liamUser, ...pair, lastReadSequence: 1,
        hiddenAt: null, version: 1, joinedAt: CREATED_AT, updatedAt: SECOND_MESSAGE_AT },
    ],
    messages: [
      { id: ids.aliceMessage, conversationId: ids.conversation, ...pair, sequence: 1,
        senderUserId: ids.aliceUser, clientId: ids.aliceClient,
        body: "Hi Liam — this is a fictional DateCN test message.", createdAt: CREATED_AT },
      { id: ids.liamMessage, conversationId: ids.conversation, ...pair, sequence: 2,
        senderUserId: ids.liamUser, clientId: ids.liamClient,
        body: "Hi Alice — the free-test conversation is working.", createdAt: SECOND_MESSAGE_AT },
    ],
  };
}

async function validateSnapshot(
  snapshot: FreeTestSeedSnapshot,
  expected: FreeTestSeedGraph,
  credentials: FreeTestCredentials,
  verifyPassword: PasswordVerifier,
) {
  if (!snapshot.graph || snapshot.graph.accounts.length !== 2) throw rejected();
  for (let index = 0; index < snapshot.graph.accounts.length; index += 1) {
    const actual = snapshot.graph.accounts[index];
    if (!actual || !await verifyPassword({
      hash: actual.passwordHash,
      password: credentials.users[index]!.password,
    })) throw rejected();
  }
  const comparableExpected = structuredClone(expected);
  comparableExpected.accounts.forEach((account, index) => {
    account.passwordHash = snapshot.graph!.accounts[index]!.passwordHash;
  });
  if (!isDeepStrictEqual(snapshot.graph, comparableExpected)) throw rejected();
}

export async function seedFreeTest({
  env,
  argv,
  database,
  credentialsPath,
  randomBytes = nodeRandomBytes,
  hashPassword = betterAuthHashPassword,
  verifyPassword = betterAuthVerifyPassword,
}: {
  env: Partial<NodeJS.ProcessEnv>;
  argv: string[];
  database: SeedDatabase;
  credentialsPath: string;
  randomBytes?: RandomBytes;
  hashPassword?: (password: string) => Promise<string>;
  verifyPassword?: PasswordVerifier;
}) {
  try {
    validateFreeTestSeedEnvironment(env, argv);
    const credentials = await createCredentialsFile({ path: credentialsPath, randomBytes });
    const hashes = await Promise.all(credentials.users.map(({ password }) => hashPassword(password))) as [string, string];
    const graph = createGraph(hashes);
    await database.transaction(async (transaction) => {
      await transaction.acquireSeedLock();
      await transaction.insertMissing(graph);
      await validateSnapshot(await transaction.readSeedSnapshot(), graph, credentials, verifyPassword);
    });
    return { users: 2, profiles: 2, matches: 1, conversations: 1, messages: 2 } as const;
  } catch {
    throw rejected();
  }
}

type Queryable = Pick<PoolClient, "query">;

class PgSeedTransaction implements SeedTransaction {
  constructor(private readonly client: Queryable) {}

  async acquireSeedLock() {
    await this.client.query("SELECT pg_advisory_xact_lock($1::bigint)", [ADVISORY_LOCK_KEY]);
  }

  private async insert(table: string, columns: string[], values: unknown[]) {
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
    await this.client.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      values,
    );
  }

  async insertMissing(graph: FreeTestSeedGraph) {
    for (const row of graph.users) await this.insert("users", [
      "id", "name", "email", "email_verified", "phone_number", "phone_number_verified",
      "two_factor_enabled", "image", "created_at", "updated_at",
    ], [row.id, row.name, row.email, row.emailVerified, row.phoneNumber, row.phoneNumberVerified,
      row.twoFactorEnabled, row.image, row.createdAt, row.updatedAt]);
    for (const row of graph.accounts) await this.insert("accounts", [
      "id", "account_id", "provider_id", "user_id", "access_token", "refresh_token", "id_token",
      "access_token_expires_at", "refresh_token_expires_at", "scope", "password", "created_at", "updated_at",
    ], [row.id, row.accountId, row.providerId, row.userId, row.accessToken, row.refreshToken, row.idToken,
      row.accessTokenExpiresAt, row.refreshTokenExpiresAt, row.scope, row.passwordHash, row.createdAt, row.updatedAt]);
    for (const row of graph.profiles) await this.insert("profiles", [
      "id", "user_id", "display_name", "birth_date", "gender_code", "relationship_goal_code", "country_code",
      "time_zone", "city", "bio", "publish_requested", "discoverable", "status", "created_at", "updated_at",
    ], [row.id, row.userId, row.displayName, row.birthDate, row.genderCode, row.relationshipGoalCode,
      row.countryCode, row.timeZone, row.city, row.bio, row.publishRequested, row.discoverable,
      row.status, row.createdAt, row.updatedAt]);
    for (const row of graph.profilePreferences) await this.insert("profile_preferences", [
      "id", "user_id", "gender_codes", "minimum_age", "maximum_age", "preferred_country_codes",
      "language_codes", "relationship_goal_codes", "created_at", "updated_at",
    ], [row.id, row.userId, row.genderCodes, row.minimumAge, row.maximumAge, row.preferredCountryCodes,
      row.languageCodes, row.relationshipGoalCodes, row.createdAt, row.updatedAt]);
    for (const row of graph.privacySettings) await this.insert("privacy_settings", [
      "id", "user_id", "show_online_status", "show_last_active", "show_profile_visitors", "location_precision",
      "created_at", "updated_at",
    ], [row.id, row.userId, row.showOnlineStatus, row.showLastActive, row.showProfileVisitors,
      row.locationPrecision, row.createdAt, row.updatedAt]);
    for (const row of graph.interests) await this.insert("interests", [
      "id", "code", "label", "created_at", "updated_at",
    ], [row.id, row.code, row.label, row.createdAt, row.updatedAt]);
    for (const row of graph.profileInterests) await this.insert("profile_interests", [
      "id", "profile_id", "interest_id", "created_at",
    ], [row.id, row.profileId, row.interestId, row.createdAt]);
    for (const row of graph.photos) await this.insert("profile_photos", [
      "id", "user_id", "profile_id", "upload_id", "object_key", "object_version", "object_etag",
      "preservation_status", "position", "actual_mime_type", "actual_size_bytes", "width", "height",
      "moderation_status", "moderation_reason_code", "review_provider", "review_version", "reviewed_at",
      "cleanup_due_at", "object_deleted_at", "deletion_status", "deletion_lease_id", "deletion_lease_expires_at",
      "user_removed_at", "created_at", "updated_at",
    ], [row.id, row.userId, row.profileId, row.uploadId, row.objectKey, row.objectVersion, row.objectEtag,
      row.preservationStatus, row.position, row.actualMimeType, row.actualSizeBytes, row.width, row.height,
      row.moderationStatus, row.moderationReasonCode, row.reviewProvider, row.reviewVersion, row.reviewedAt,
      row.cleanupDueAt, row.objectDeletedAt, row.deletionStatus, row.deletionLeaseId, row.deletionLeaseExpiresAt,
      row.userRemovedAt, row.createdAt, row.updatedAt]);
    for (const row of graph.memberships) await this.insert("entitlement_user_plan_assignments", [
      "id", "user_id", "plan_ref", "version", "active", "effective_at", "expires_at", "created_at",
    ], [row.id, row.userId, row.planRef, row.version, row.active, row.effectiveAt, row.expiresAt, row.createdAt]);
    for (const row of graph.likes) await this.insert("social_likes", [
      "id", "actor_user_id", "target_user_id", "active", "created_at", "updated_at", "revoked_at",
    ], [row.id, row.actorUserId, row.targetUserId, row.active, row.createdAt, row.updatedAt, row.revokedAt]);
    await this.insert("social_matches", [
      "id", "low_user_id", "high_user_id", "status", "created_at", "updated_at", "hidden_at",
    ], [graph.match.id, graph.match.lowUserId, graph.match.highUserId, graph.match.status,
      graph.match.createdAt, graph.match.updatedAt, graph.match.hiddenAt]);
    await this.insert("conversations", [
      "id", "low_user_id", "high_user_id", "status", "next_sequence", "version", "last_message_at",
      "created_at", "updated_at",
    ], [graph.conversation.id, graph.conversation.lowUserId, graph.conversation.highUserId,
      graph.conversation.status, graph.conversation.nextSequence, graph.conversation.version,
      graph.conversation.lastMessageAt, graph.conversation.createdAt, graph.conversation.updatedAt]);
    for (const row of graph.conversationMembers) await this.insert("conversation_members", [
      "conversation_id", "user_id", "low_user_id", "high_user_id", "last_read_sequence", "hidden_at",
      "version", "joined_at", "updated_at",
    ], [row.conversationId, row.userId, row.lowUserId, row.highUserId, row.lastReadSequence,
      row.hiddenAt, row.version, row.joinedAt, row.updatedAt]);
    for (const row of graph.messages) await this.insert("messages", [
      "id", "conversation_id", "low_user_id", "high_user_id", "sequence", "sender_user_id", "client_id",
      "body", "created_at",
    ], [row.id, row.conversationId, row.lowUserId, row.highUserId, row.sequence, row.senderUserId,
      row.clientId, row.body, row.createdAt]);
  }

  private async rows<T>(query: string, values: unknown[]): Promise<T[]> {
    const result = await this.client.query(query, values);
    return result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]))) as T[];
  }

  async readSeedSnapshot(): Promise<FreeTestSeedSnapshot> {
    const userIds = [ids.aliceUser, ids.liamUser];
    const [users, accounts, profiles, profilePreferences, privacySettings, interests, profileInterests, photos,
      memberships, likes,
      matches, conversations, conversationMembers, messages] = await Promise.all([
      this.rows<UserRow>(`SELECT id, name, email, email_verified AS "emailVerified", phone_number AS "phoneNumber",
        phone_number_verified AS "phoneNumberVerified", two_factor_enabled AS "twoFactorEnabled", image,
        created_at AS "createdAt", updated_at AS "updatedAt" FROM users WHERE id = ANY($1::uuid[]) ORDER BY id`, [userIds]),
      this.rows<AccountRow>(`SELECT id, account_id AS "accountId", provider_id AS "providerId", user_id AS "userId",
        access_token AS "accessToken", refresh_token AS "refreshToken", id_token AS "idToken",
        access_token_expires_at AS "accessTokenExpiresAt", refresh_token_expires_at AS "refreshTokenExpiresAt",
        scope, password AS "passwordHash", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id`, [[ids.aliceAccount, ids.liamAccount]]),
      this.rows<ProfileRow>(`SELECT id, user_id AS "userId", display_name AS "displayName", birth_date::text AS "birthDate",
        gender_code AS "genderCode", relationship_goal_code AS "relationshipGoalCode", country_code AS "countryCode",
        time_zone AS "timeZone", city, bio, publish_requested AS "publishRequested", discoverable, status,
        created_at AS "createdAt", updated_at AS "updatedAt" FROM profiles
        WHERE id = ANY($1::uuid[]) ORDER BY id`, [[ids.aliceProfile, ids.liamProfile]]),
      this.rows<PreferenceRow>(`SELECT id, user_id AS "userId", gender_codes AS "genderCodes", minimum_age AS "minimumAge",
        maximum_age AS "maximumAge", preferred_country_codes AS "preferredCountryCodes", language_codes AS "languageCodes",
        relationship_goal_codes AS "relationshipGoalCodes", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM profile_preferences WHERE id = ANY($1::uuid[]) ORDER BY id`, [[ids.alicePreference, ids.liamPreference]]),
      this.rows<PrivacyRow>(`SELECT id, user_id AS "userId", show_online_status AS "showOnlineStatus",
        show_last_active AS "showLastActive", show_profile_visitors AS "showProfileVisitors",
        location_precision AS "locationPrecision", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM privacy_settings WHERE id = ANY($1::uuid[]) ORDER BY id`, [[ids.alicePrivacy, ids.liamPrivacy]]),
      this.rows<InterestRow>(`SELECT id, code, label, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM interests WHERE id = ANY($1::uuid[]) ORDER BY code`,
      [[ids.cookingInterest, ids.hikingInterest, ids.photographyInterest]]),
      this.rows<ProfileInterestRow>(`SELECT id, profile_id AS "profileId", interest_id AS "interestId",
        created_at AS "createdAt" FROM profile_interests WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[ids.aliceCooking, ids.alicePhotography, ids.liamHiking, ids.liamPhotography]]),
      this.rows<PhotoRow>(`SELECT id, user_id AS "userId", profile_id AS "profileId", upload_id AS "uploadId",
        object_key AS "objectKey", object_version AS "objectVersion", object_etag AS "objectEtag",
        preservation_status AS "preservationStatus", position, actual_mime_type AS "actualMimeType",
        actual_size_bytes AS "actualSizeBytes", width, height, moderation_status AS "moderationStatus",
        moderation_reason_code AS "moderationReasonCode", review_provider AS "reviewProvider",
        review_version AS "reviewVersion", reviewed_at AS "reviewedAt", cleanup_due_at AS "cleanupDueAt",
        object_deleted_at AS "objectDeletedAt", deletion_status AS "deletionStatus",
        deletion_lease_id AS "deletionLeaseId", deletion_lease_expires_at AS "deletionLeaseExpiresAt",
        user_removed_at AS "userRemovedAt", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM profile_photos WHERE id = ANY($1::uuid[]) ORDER BY id`, [[ids.alicePhoto, ids.liamPhoto]]),
      this.rows<MembershipRow>(`SELECT id, user_id AS "userId", plan_ref AS "planRef", version, active,
        effective_at AS "effectiveAt", expires_at AS "expiresAt", created_at AS "createdAt"
        FROM entitlement_user_plan_assignments WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[ids.aliceMembership, ids.liamMembership]]),
      this.rows<LikeRow>(`SELECT id, actor_user_id AS "actorUserId", target_user_id AS "targetUserId", active,
        created_at AS "createdAt", updated_at AS "updatedAt", revoked_at AS "revokedAt"
        FROM social_likes WHERE id = ANY($1::uuid[]) ORDER BY id`, [[ids.aliceLike, ids.liamLike]]),
      this.rows<MatchRow>(`SELECT id, low_user_id AS "lowUserId", high_user_id AS "highUserId", status,
        created_at AS "createdAt", updated_at AS "updatedAt", hidden_at AS "hiddenAt"
        FROM social_matches WHERE id = $1`, [ids.match]),
      this.rows<ConversationRow>(`SELECT id, low_user_id AS "lowUserId", high_user_id AS "highUserId", status,
        next_sequence::int AS "nextSequence", version, last_message_at AS "lastMessageAt",
        created_at AS "createdAt", updated_at AS "updatedAt" FROM conversations WHERE id = $1`, [ids.conversation]),
      this.rows<ConversationMemberRow>(`SELECT conversation_id AS "conversationId", user_id AS "userId",
        low_user_id AS "lowUserId", high_user_id AS "highUserId", last_read_sequence::int AS "lastReadSequence",
        hidden_at AS "hiddenAt", version, joined_at AS "joinedAt", updated_at AS "updatedAt"
        FROM conversation_members WHERE conversation_id = $1 ORDER BY user_id`, [ids.conversation]),
      this.rows<MessageRow>(`SELECT id, conversation_id AS "conversationId", low_user_id AS "lowUserId",
        high_user_id AS "highUserId", sequence::int AS sequence, sender_user_id AS "senderUserId",
        client_id AS "clientId", body, created_at AS "createdAt" FROM messages
        WHERE id = ANY($1::uuid[]) ORDER BY sequence`, [[ids.aliceMessage, ids.liamMessage]]),
    ]);
    return { graph: {
      users, accounts, profiles, profilePreferences, privacySettings, interests, profileInterests, photos,
      memberships, likes,
      match: matches[0] as MatchRow,
      conversation: conversations[0] as ConversationRow,
      conversationMembers, messages,
    } };
  }
}

export class PgSeedDatabase implements SeedDatabase {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(work: (transaction: SeedTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
      const result = await work(new PgSeedTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

async function createPgDatabase(databaseUrl: string): Promise<SeedDatabase> {
  const { Pool: NodePostgresPool } = await import("pg");
  return new PgSeedDatabase(new NodePostgresPool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
  }));
}

export async function executeFreeTestSeed({
  argv = process.argv.slice(2),
  env = process.env,
  databaseFactory = (databaseUrl: string) => createPgDatabase(databaseUrl),
  credentialsPath = DEFAULT_CREDENTIALS_PATH,
  randomBytes = nodeRandomBytes,
  hashPassword = betterAuthHashPassword,
  verifyPassword = betterAuthVerifyPassword,
  writeStdout = (message: string) => process.stdout.write(message),
  writeStderr = (message: string) => process.stderr.write(message),
}: {
  argv?: string[];
  env?: Partial<NodeJS.ProcessEnv>;
  databaseFactory?: (databaseUrl: string) => Promise<SeedDatabase>;
  credentialsPath?: string;
  randomBytes?: RandomBytes;
  hashPassword?: (password: string) => Promise<string>;
  verifyPassword?: PasswordVerifier;
  writeStdout?: (message: string) => unknown;
  writeStderr?: (message: string) => unknown;
} = {}) {
  let database: SeedDatabase | undefined;
  try {
    validateFreeTestSeedEnvironment(env, argv);
    database = await databaseFactory(env.DATABASE_URL!);
    const result = await seedFreeTest({
      env, argv, database, credentialsPath, randomBytes, hashPassword, verifyPassword,
    });
    writeStdout(`Free-test seed ready: users=${result.users}; profiles=${result.profiles}; conversations=${result.conversations}\n`);
    return 0;
  } catch {
    writeStderr(`${FREE_TEST_SEED_ERROR}\n`);
    return 1;
  } finally {
    await database?.close?.().catch(() => undefined);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exitCode = await executeFreeTestSeed();
