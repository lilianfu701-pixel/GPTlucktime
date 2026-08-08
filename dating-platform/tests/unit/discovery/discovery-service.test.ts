import { describe, expect, it, vi } from "vitest";

import { createDiscoverHandler, createSavedSearchHandler } from "@/modules/discovery/discovery-service";

describe("discovery route handlers", () => {
  it("requires authentication without leaking account details", async () => {
    const handler = createDiscoverHandler({
      getSession: async () => null,
      repository: { discover: vi.fn() },
    });
    const response = await handler(new Request("http://localhost/api/v1/discover"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ code: "UNAUTHORIZED", message: "UNAUTHORIZED" });
  });

  it("strictly validates bounded query filters and does not call the repository", async () => {
    const discover = vi.fn();
    const handler = createDiscoverHandler({
      getSession: async () => ({ user: { id: crypto.randomUUID() } }),
      repository: { discover },
    });
    const response = await handler(new Request("http://localhost/api/v1/discover?latitude=1&pageSize=51"));
    expect(response.status).toBe(400);
    expect(discover).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ code: "INVALID_DISCOVERY", message: "INVALID_DISCOVERY" });

    const duplicateScalar = await handler(new Request(
      "http://localhost/api/v1/discover?mode=nearby&mode=online",
    ));
    expect(duplicateScalar.status).toBe(400);
    expect(discover).not.toHaveBeenCalled();
  });

  it("parses repeated filters and returns the repository public envelope", async () => {
    const discover = vi.fn().mockResolvedValue({ items: [], nextCursor: null, rankingVersion: "discovery-v1" });
    const userId = crypto.randomUUID();
    const authorizeEntitlement = vi.fn().mockResolvedValue(false);
    const handler = createDiscoverHandler({
      getSession: async () => ({ user: { id: userId } }),
      authorizeEntitlement,
      repository: { discover },
    });
    const response = await handler(new Request(
      "http://localhost/api/v1/discover?mode=nearby&minimumAge=25&genderCodes=woman&genderCodes=nonbinary",
    ));
    expect(response.status).toBe(200);
    expect(discover).toHaveBeenCalledWith(userId, expect.objectContaining({
      mode: "nearby", minimumAge: 25, genderCodes: ["woman", "nonbinary"],
    }));
    expect(authorizeEntitlement).not.toHaveBeenCalled();
  });

  it("keeps basic discovery open without an entitlement lookup", async () => {
    const discover = vi.fn().mockResolvedValue({ items: [], nextCursor: null, rankingVersion: "discovery-v1" });
    const authorizeEntitlement = vi.fn();
    const handler = createDiscoverHandler({
      getSession: async () => ({ user: { id: "owner-id" } }),
      authorizeEntitlement,
      repository: { discover },
    });
    const response = await handler(new Request("http://localhost/api/v1/discover?mode=nearby&pageSize=10"));
    expect(response.status).toBe(200);
    expect(authorizeEntitlement).not.toHaveBeenCalled();
    expect(discover).toHaveBeenCalledOnce();
  });

  it("does not reclassify any current discovery mode as paid advanced search", async () => {
    const discover = vi.fn().mockResolvedValue({ items: [], nextCursor: null, rankingVersion: "discovery-v1" });
    const authorizeEntitlement = vi.fn().mockResolvedValue(false);
    const handler = createDiscoverHandler({
      getSession: async () => ({ user: { id: "owner-id" } }),
      authorizeEntitlement,
      repository: { discover },
    });
    for (const mode of ["recommended", "new", "nearby", "online", "verified"]) {
      expect((await handler(new Request(`http://localhost/api/v1/discover?mode=${mode}`))).status).toBe(200);
    }
    expect(authorizeEntitlement).not.toHaveBeenCalled();
    expect(discover).toHaveBeenCalledTimes(5);
  });

  it("treats age, gender, country, language, and relationship goal as basic filters", async () => {
    const discover = vi.fn().mockResolvedValue({ items: [], nextCursor: null, rankingVersion: "discovery-v1" });
    const authorizeEntitlement = vi.fn().mockResolvedValue(false);
    const handler = createDiscoverHandler({
      getSession: async () => ({ user: { id: "owner-id" } }),
      authorizeEntitlement,
      repository: { discover },
    });
    const response = await handler(new Request(
      "http://localhost/api/v1/discover?minimumAge=25&maximumAge=50&genderCodes=woman&countryCodes=US&languageCodes=en&relationshipGoalCodes=long_term",
    ));
    expect(response.status).toBe(200);
    expect(authorizeEntitlement).not.toHaveBeenCalled();
    expect(discover).toHaveBeenCalledOnce();
  });

});

describe("saved-search route handler", () => {
  it("uses strict shared filters and owner-scoped repository calls", async () => {
    const createSavedSearch = vi.fn();
    const handler = createSavedSearchHandler({
      getSession: async () => ({ user: { id: "owner-id" } }),
      repository: {
        listSavedSearches: vi.fn(), createSavedSearch, renameSavedSearch: vi.fn(), deleteSavedSearch: vi.fn(),
      },
    });
    const invalid = await handler(new Request("http://localhost/api/v1/saved-searches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Unsafe", filters: { mode: "nearby", latitude: 47.6, longitude: -122.3 } }),
    }));
    expect(invalid.status).toBe(400);
    expect(createSavedSearch).not.toHaveBeenCalled();

    createSavedSearch.mockResolvedValue({
      id: crypto.randomUUID(), name: "Safe", schemaVersion: 1, filters: { mode: "nearby" },
    });
    const valid = await handler(new Request("http://localhost/api/v1/saved-searches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Safe", filters: { mode: "nearby" } }),
    }));
    expect(valid.status).toBe(201);
    expect(createSavedSearch).toHaveBeenCalledWith("owner-id", "Safe", expect.objectContaining({ mode: "nearby" }));
    expect(await valid.json()).not.toHaveProperty("savedSearch.userId");
  });

  it("omits unsupported and invalid stored filters at the API boundary", async () => {
    const validId = crypto.randomUUID();
    const handler = createSavedSearchHandler({
      getSession: async () => ({ user: { id: "owner-id" } }),
      repository: {
        listSavedSearches: vi.fn().mockResolvedValue([
          { id: validId, name: "Valid", schemaVersion: 1, filters: { mode: "nearby" } },
          {
            id: crypto.randomUUID(),
            name: "Legacy coordinates",
            schemaVersion: 1,
            filters: { mode: "nearby", latitude: 47.6, longitude: -122.3 },
          },
          { id: crypto.randomUUID(), name: "Future", schemaVersion: 99, filters: { mode: "recommended" } },
        ]),
        createSavedSearch: vi.fn(), renameSavedSearch: vi.fn(), deleteSavedSearch: vi.fn(),
      },
    });

    const response = await handler(new Request("http://localhost/api/v1/saved-searches"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      savedSearches: [{ id: validId, name: "Valid", filters: expect.objectContaining({ mode: "nearby" }) }],
    });
  });

  it("does not reclassify current saved-search modes as paid advanced search", async () => {
    const createSavedSearch = vi.fn().mockResolvedValue({
      id: crypto.randomUUID(), name: "Verified", schemaVersion: 1, filters: { mode: "verified" },
    });
    const authorizeEntitlement = vi.fn().mockResolvedValue(false);
    const handler = createSavedSearchHandler({
      getSession: async () => ({ user: { id: "owner-id" } }),
      authorizeEntitlement,
      repository: {
        listSavedSearches: vi.fn(), createSavedSearch, renameSavedSearch: vi.fn(), deleteSavedSearch: vi.fn(),
      },
    });
    for (const mode of ["recommended", "new", "nearby", "online", "verified"]) {
      const response = await handler(new Request("http://localhost/api/v1/saved-searches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Verified", filters: { mode } }),
      }));
      expect(response.status).toBe(201);
    }
    expect(authorizeEntitlement).not.toHaveBeenCalled();
    expect(createSavedSearch).toHaveBeenCalledTimes(5);
  });

  it("saves all basic filter fields without advanced-search entitlement", async () => {
    const createSavedSearch = vi.fn().mockResolvedValue({
      id: crypto.randomUUID(), name: "Basics", schemaVersion: 1, filters: { mode: "nearby" },
    });
    const authorizeEntitlement = vi.fn().mockResolvedValue(false);
    const handler = createSavedSearchHandler({
      getSession: async () => ({ user: { id: "owner-id" } }),
      authorizeEntitlement,
      repository: {
        listSavedSearches: vi.fn(), createSavedSearch, renameSavedSearch: vi.fn(), deleteSavedSearch: vi.fn(),
      },
    });
    const response = await handler(new Request("http://localhost/api/v1/saved-searches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Basics",
        filters: {
          mode: "nearby", minimumAge: 25, maximumAge: 50, genderCodes: ["woman"],
          countryCodes: ["US"], languageCodes: ["en"], relationshipGoalCodes: ["long_term"],
        },
      }),
    }));
    expect(response.status).toBe(201);
    expect(authorizeEntitlement).not.toHaveBeenCalled();
    expect(createSavedSearch).toHaveBeenCalledOnce();
  });
});
