import { describe, expect, it, vi } from "vitest";

import {
  executeMigrationCli,
  MIGRATION_GATE_ERROR,
  parseFreeTestDatabaseTarget,
  parseMigrationArguments,
  runFreeTestMigration,
  selectNpmCommand,
} from "../../../scripts/run-free-test-migration.mjs";

const HOST = "ep-datecn-123.us-east-2.aws.neon.tech";
const DATABASE = "datecn_free_test";
const DATABASE_URL = `postgresql://datecn_user:fictional-password@${HOST}/${DATABASE}?sslmode=require`;
const expectedArguments = (mode: "--check" | "--confirm=datecn-free-test") => [
  "--expected-host", HOST,
  "--expected-database", DATABASE,
  mode,
];

describe("free-test migration gate", () => {
  it("parses a TLS-required Neon target and normalizes hostname case", () => {
    expect(parseFreeTestDatabaseTarget({
      DATABASE_URL: DATABASE_URL.replace(HOST, HOST.toUpperCase()),
    })).toEqual({ host: HOST, database: DATABASE });
  });

  it("runs CHECK without spawning and prints only the confirmed host and database", () => {
    const spawn = vi.fn();
    const stdout = vi.fn();

    expect(runFreeTestMigration({
      argv: expectedArguments("--check"),
      env: { DATABASE_URL },
      platform: "linux",
      spawn,
      writeStdout: stdout,
    })).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(`Database target: host=${HOST}; db=${DATABASE}\n`);
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("fictional-password");
  });

  it("redacts malformed URLs and credentials from CLI stderr", () => {
    const stderr = vi.fn();
    const leakedSecret = "fictional-secret-never-print";

    expect(executeMigrationCli({
      argv: expectedArguments("--check"),
      env: { ...process.env, DATABASE_URL: `postgresql://fictional-user:${leakedSecret}@[` },
      spawn: vi.fn(),
      writeStderr: stderr,
      writeStdout: vi.fn(),
    })).toBe(1);
    expect(stderr).toHaveBeenCalledWith(`${MIGRATION_GATE_ERROR}\n`);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(leakedSecret);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("fictional-user");
  });

  it("redacts malformed percent-encoding in the database path", () => {
    expect(() => parseFreeTestDatabaseTarget({
      DATABASE_URL: `postgresql://user:fictional-secret@${HOST}/datecn%ZZ?sslmode=require`,
    })).toThrow(MIGRATION_GATE_ERROR);
  });

  it("rejects malformed percent-encoding in credentials with the fixed error", () => {
    expect(() => parseFreeTestDatabaseTarget({
      DATABASE_URL: `postgresql://user%ZZ:fictional-secret@${HOST}/${DATABASE}?sslmode=require`,
    })).toThrow(MIGRATION_GATE_ERROR);
  });

  it("rejects encoded control characters before they can reach stdout", () => {
    expect(() => parseFreeTestDatabaseTarget({
      DATABASE_URL: `postgresql://user:fictional-secret@${HOST}/datecn%1Bcontrol?sslmode=require`,
    })).toThrow(MIGRATION_GATE_ERROR);
  });

  it.each([
    "127.1",
    "127.0.0.2",
    "0.0.0.0",
    "[::ffff:127.0.0.1]",
    "localhost",
    "app.localhost",
    "database.example.com",
    "neon.tech",
    "ep-datecn.neon.tech.",
  ])("rejects a non-canonical non-Neon hostname: %s", (host) => {
    expect(() => parseFreeTestDatabaseTarget({
      DATABASE_URL: `postgresql://user:fictional-secret@${host}/${DATABASE}?sslmode=require`,
    })).toThrow(MIGRATION_GATE_ERROR);
  });

  it.each([
    `postgres://user:fictional-secret@${HOST}/${DATABASE}?sslmode=require`,
    `postgresql://user:fictional-secret@${HOST}/${DATABASE}`,
    `postgresql://user:fictional-secret@${HOST}/${DATABASE}?sslmode=disable`,
  ])("rejects a non-PostgreSQL or non-TLS target", (databaseUrl) => {
    expect(() => parseFreeTestDatabaseTarget({ DATABASE_URL: databaseUrl }))
      .toThrow(MIGRATION_GATE_ERROR);
  });

  it.each([
    `postgresql://user:fictional-secret@${HOST}/${DATABASE}?sslmode=require&host=evil.example.com`,
    `postgresql://user:fictional-secret@${HOST}/${DATABASE}?sslmode=require&port=5433`,
    `postgresql://user:fictional-secret@${HOST}/${DATABASE}?sslmode=require&user=other-user`,
    `postgresql://user:fictional-secret@${HOST}/${DATABASE}?sslmode=require&password=other-password`,
    `postgresql://user:fictional-secret@${HOST}/${DATABASE}?sslmode=require&options=-c%20search_path%3Devil`,
    `postgresql://user:fictional-secret@${HOST}/${DATABASE}?sslmode=require&sslmode=require`,
    `postgresql://user:fictional-secret@${HOST}/${DATABASE}?sslmode=require&channel_binding=prefer`,
  ])("rejects connection query overrides with a redacted error", (databaseUrl) => {
    expect(() => parseFreeTestDatabaseTarget({ DATABASE_URL: databaseUrl }))
      .toThrow(MIGRATION_GATE_ERROR);
  });

  it("allows only one optional strict Neon channel-binding parameter", () => {
    expect(parseFreeTestDatabaseTarget({
      DATABASE_URL: `${DATABASE_URL}&channel_binding=require`,
    })).toEqual({ host: HOST, database: DATABASE });
  });

  it.each(["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGOPTIONS", "PGSERVICE"])(
    "rejects ambient %s before printing or spawning",
    (name) => {
      const spawn = vi.fn();
      const stdout = vi.fn();
      expect(() => runFreeTestMigration({
        argv: expectedArguments("--check"),
        env: { DATABASE_URL, [name]: "fictional-override" },
        spawn,
        writeStdout: stdout,
      })).toThrow(MIGRATION_GATE_ERROR);
      expect(stdout).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("rejects expected target mismatch before printing or spawning", () => {
    const spawn = vi.fn();
    const stdout = vi.fn();

    expect(() => runFreeTestMigration({
      argv: ["--expected-host", HOST, "--expected-database", "wrong_database", "--check"],
      env: { DATABASE_URL },
      spawn,
      writeStdout: stdout,
    })).toThrow(MIGRATION_GATE_ERROR);
    expect(stdout).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("accepts only the documented argument array", () => {
    expect(parseMigrationArguments(expectedArguments("--check"))).toEqual({
      expectedHost: HOST,
      expectedDatabase: DATABASE,
      mode: "check",
    });
    expect(() => parseMigrationArguments([
      "--expected-host", HOST,
      "--expected-database", DATABASE,
      "--confirm", "datecn-free-test",
    ])).toThrow(MIGRATION_GATE_ERROR);
  });

  it("selects npm.cmd only on Windows", () => {
    expect(selectNpmCommand("win32")).toBe("npm.cmd");
    expect(selectNpmCommand("linux")).toBe("npm");
    expect(selectNpmCommand("darwin")).toBe("npm");
  });

  it("spawns the fixed npm migration command only after exact confirmation", () => {
    const spawnMock = vi.fn(() => ({ status: 0 }));
    const spawn = spawnMock as unknown as typeof import("node:child_process").spawnSync;
    const env = { DATABASE_URL };

    expect(runFreeTestMigration({
      argv: expectedArguments("--confirm=datecn-free-test"),
      env,
      platform: "win32",
      spawn,
      writeStdout: vi.fn(),
    })).toBe(0);
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith("npm.cmd", ["run", "db:migrate"], {
      env,
      shell: false,
      stdio: "inherit",
    });
  });
});
