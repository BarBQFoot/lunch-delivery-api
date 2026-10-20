import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../dbconnect", () => ({ conn: { query } }));

import { app } from "../app";
import { getRoadDistances, OsrmError } from "../service/osrm";

const fetchMock = vi.fn();
const origin = { latitude: 13.7563, longitude: 100.5018 };
const endpoint = "/orders/nearby?lat=13.7563&lng=100.5018";
const order = (id: number, lat: unknown = "13.757", lng: unknown = "100.502") => ({
  order_id: id,
  customer_id: id,
  quantity: 2,
  name: `Customer ${id}`,
  latitude: lat,
  longitude: lng,
});
const table = (distances: (number | null)[]) =>
  new Response(JSON.stringify({ code: "Ok", distances: [distances] }));

beforeEach(() => {
  query.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OSRM_BASE_URL", "https://osrm.test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("GET /orders/nearby road distances (no real database or network)", () => {
  it("filters and sorts by road distance, preserves duplicate customer orders, excludes unreachable points", async () => {
    query.mockResolvedValue([[
      order(1), order(2, "13.758"), order(3, "13.759"),
      order(4, "13.760"), order(5), order(6, "13.761"),
    ]]);
    fetchMock.mockResolvedValue(table([1800, 2000.1, 500, null, 2000]));

    const response = await request(app).get(endpoint);

    expect(response.status).toBe(200);
    expect(response.body.map((row: { order_id: number }) => row.order_id)).toEqual([3, 1, 5, 6]);
    expect(response.body.map((row: { distance_km: number }) => row.distance_km)).toEqual([0.5, 1.8, 1.8, 2]);
    expect(response.body[0]).toMatchObject({ name: "Customer 3", quantity: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as URL;
    expect(url.pathname).toBe("/table/v1/driving/100.5018,13.7563;100.502,13.757;100.502,13.758;100.502,13.759;100.502,13.76;100.502,13.761");
    expect(url.searchParams.get("sources")).toBe("0");
    expect(url.searchParams.get("destinations")).toBe("1;2;3;4;5");
    expect(url.searchParams.get("annotations")).toBe("distance");
    expect(url.searchParams.has("fallback_speed")).toBe(false);
  });

  it.each([
    "", "?lat=&lng=100", "?lat=abc&lng=100", "?lat=91&lng=100",
    "?lat=13&lng=181", "?lat=13&lat=14&lng=100", "?lat=Infinity&lng=100",
  ])("rejects invalid coordinates: %s", async (suffix) => {
    const response = await request(app).get(`/orders/nearby${suffix}`);
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts zero coordinates and a zero road distance", async () => {
    query.mockResolvedValue([[order(1, "0", "0")]]);
    fetchMock.mockResolvedValue(table([0]));
    const response = await request(app).get("/orders/nearby?lat=0&lng=0");
    expect(response.status).toBe(200);
    expect(response.body[0].distance_km).toBe(0);
  });

  it.each([
    { rows: [] },
    { rows: [order(1, null), order(2, ""), order(3, "bad"), order(4, 95)] },
  ])(
    "returns an empty list without OSRM when no usable locations exist",
    async ({ rows }) => {
      query.mockResolvedValue([rows]);
      const response = await request(app).get(endpoint);
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    () => new Response("unavailable", { status: 503 }),
    () => new Response(JSON.stringify({ code: "NoTable" })),
    () => new Response(JSON.stringify({ code: "Ok", distances: [[]] })),
    () => table([-1]),
    () => new Response("invalid JSON"),
  ])("returns 502 for OSRM failures without falling back to a straight line", async (response) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    query.mockResolvedValue([[order(1)]]);
    fetchMock.mockResolvedValue(response());
    const result = await request(app).get(endpoint);
    expect(result.status).toBe(502);
    expect(result.body.error).toContain("OSRM");
  });

  it("returns 502 on timeout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    query.mockResolvedValue([[order(1)]]);
    fetchMock.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    expect((await request(app).get(endpoint)).status).toBe(502);
  });

  it("returns 500 for database failures without calling OSRM", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    query.mockRejectedValue(new Error("database unavailable"));
    expect((await request(app).get(endpoint)).status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("OSRM request handling", () => {
  it("batches more than 99 destinations and keeps distance mapping intact", async () => {
    const destinations = Array.from({ length: 101 }, (_, index) => ({
      latitude: 13 + index / 1000, longitude: 100,
    }));
    fetchMock.mockResolvedValueOnce(table(Array(99).fill(1000)));
    fetchMock.mockResolvedValueOnce(table([2000, null]));
    const distances = await getRoadDistances(origin, destinations);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(distances).toEqual([...Array(99).fill(1), 2, null]);
  });

  it("spaces demo requests across concurrent callers and recovers after failure", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OSRM_BASE_URL", "https://router.project-osrm.org");
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fetchMock.mockResolvedValueOnce(table([1000]));
    const failed = getRoadDistances(origin, [origin]).catch((error: unknown) => error);
    const next = getRoadDistances(origin, [origin]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await failed).toBeInstanceOf(OsrmError);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await next).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
