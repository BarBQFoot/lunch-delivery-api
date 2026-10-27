import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const line = { type: "LineString", coordinates: [[103.25, 16.25], [103.26, 16.26]] };
const points = [{ latitude: 16.25, longitude: 103.25 }, { latitude: 16.26, longitude: 103.26 }];
const fetchMock = vi.fn();
const response = () => new Response(JSON.stringify({ code: "Ok", routes: [{ geometry: line }] }));
beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset().mockImplementation(async () => response());
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OSRM_BASE_URL", "https://osrm.test");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Route geometry cache", () => {
  it("shares concurrent requests and reuses completed geometry", async () => {
    const { getRoute } = await import("../service/osrm.js");
    const results = await Promise.all([getRoute(points), getRoute(points), getRoute(points)]);
    expect(results).toEqual([line, line, line]);
    expect(await getRoute(points)).toEqual(line);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("keys by stop order and provider", async () => {
    const { getRoute } = await import("../service/osrm.js");
    await getRoute(points);
    await getRoute([...points].reverse());
    vi.stubEnv("OSRM_BASE_URL", "https://another-osrm.test");
    await getRoute(points);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("refreshes expired geometry", async () => {
    vi.useFakeTimers();
    const { getRoute } = await import("../service/osrm.js");
    await getRoute(points);
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await getRoute(points);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("does not cache failures or leave a rejected request in flight", async () => {
    const { getRoute, OsrmError } = await import("../service/osrm.js");
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(getRoute(points)).rejects.toBeInstanceOf(OsrmError);
    expect(await getRoute(points)).toEqual(line);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
