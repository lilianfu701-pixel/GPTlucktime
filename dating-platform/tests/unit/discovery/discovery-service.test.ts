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
    const handler = createDiscoverHandler({
      getSession: async () => ({ user: { id: userId } }),
      repository: { discover },
    });
    const response = await handler(new Request(
      "http://localhost/api/v1/discover?mode=nearby&minimumAge=25&genderCodes=woman&genderCodes=nonbinary",
    ));
    expect(response.status).toBe(200);
    expect(discover).toHaveBeenCalledWith(userId, expect.objectContaining({
      mode: "nearby", minimumAge: 25, genderCodes: ["woman", "nonbinary"],
    }));
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

    createSavedSearch.mockResolvedValue({ id: crypto.randomUUID(), name: "Safe", filters: { mode: "nearby" } });
    const valid = await handler(new Request("http://localhost/api/v1/saved-searches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Safe", filters: { mode: "nearby" } }),
    }));
    expect(valid.status).toBe(201);
    expect(createSavedSearch).toHaveBeenCalledWith("owner-id", "Safe", expect.objectContaining({ mode: "nearby" }));
    expect(await valid.json()).not.toHaveProperty("savedSearch.userId");
  });
});
