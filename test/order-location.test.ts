import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../dbconnect", () => ({ conn: { query } }));
import { app } from "../app";
import { SHOP_ORIGIN } from "../service/shop";

const input = { customer_id: 7, delivery_date: "2026-10-21", quantity: 2,
  unit_price: 65, unit_cost: 40, is_simulated: 0, status: "ACTIVE" };

const customer = { customer_id: 7, address: "Original address",
  latitude: "16.2500000", longitude: "103.2500000" };
const fetchMock = vi.fn();
const table = (distance: number | null) => new Response(JSON.stringify({ code: "Ok", distances: [[distance]] }));

beforeEach(() => {
  query.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(table(1000));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OSRM_BASE_URL", "https://osrm.test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// เปลี่ยน: ตรวจการคัดลอกจุดส่งฝั่ง server โดยไม่เชื่อพิกัดที่ client ส่งมา
describe("Order delivery location snapshots (mocked database)", () => {
  it("checks the saved customer location and copies it atomically, ignoring client location fields", async () => {
    query.mockResolvedValueOnce([[customer]]);
    query.mockResolvedValueOnce([{ affectedRows: 1, insertId: 31 }]);
    const response = await request(app).post("/orders").send({ ...input,
      delivery_address: "spoofed", delivery_latitude: 0, delivery_longitude: 0 });
    expect(response.status).toBe(201);
    expect(response.body.last_idx).toBe(31);
    const [sql, params] = query.mock.calls[1]!;
    expect(sql).toContain("delivery_address, delivery_latitude, delivery_longitude");
    expect(sql).toMatch(/SELECT customer_id, \?, \?, \?, \?, \?, \?, address, latitude, longitude\s+FROM customers WHERE customer_id = \?/);
    expect(sql).toContain("AND latitude <=> ? AND longitude <=> ? AND address <=> ?");
    expect(params).toEqual([input.delivery_date, 2, 65, 40, 0, "ACTIVE", 7,
      customer.latitude, customer.longitude, customer.address]);
    const url = fetchMock.mock.calls[0]![0] as URL;
    expect(url.pathname).toBe(`/table/v1/driving/${SHOP_ORIGIN.longitude},${SHOP_ORIGIN.latitude};103.25,16.25`);
    expect(url.searchParams.get("annotations")).toBe("distance");
    expect(url.searchParams.get("sources")).toBe("0");
    expect(url.searchParams.get("destinations")).toBe("1");
  });

  it("returns 404 if the customer no longer exists", async () => {
    query.mockResolvedValue([[]]);
    expect((await request(app).post("/orders").send(input)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing body without writing an order", async () => {
    expect((await request(app).post("/orders")).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([0, 3000])("accepts a road distance of %s metres", async distance => {
    query.mockResolvedValueOnce([[customer]]);
    query.mockResolvedValueOnce([{ affectedRows: 1, insertId: 31 }]);
    fetchMock.mockResolvedValue(table(distance));
    expect((await request(app).post("/orders").send(input)).status).toBe(201);
  });

  it("rejects even a distance just beyond 3 km before rounding or inserting", async () => {
    query.mockResolvedValueOnce([[customer]]);
    fetchMock.mockResolvedValue(table(3000.1));
    const response = await request(app).post("/orders").send({ ...input,
      latitude: SHOP_ORIGIN.latitude, longitude: SHOP_ORIGIN.longitude, origin: SHOP_ORIGIN });
    expect(response.status).toBe(422);
    expect(response.body.distance_km).toBeCloseTo(3.0001);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects an unreachable customer without inserting", async () => {
    query.mockResolvedValueOnce([[customer]]);
    fetchMock.mockResolvedValue(table(null));
    const response = await request(app).post("/orders").send(input);
    expect(response.status).toBe(422);
    expect(response.body.error).toContain("ไม่พบเส้นทาง");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([null, "", "invalid", "91"])("rejects invalid customer latitude %s without OSRM or INSERT", async latitude => {
    query.mockResolvedValueOnce([[{ ...customer, latitude }]]);
    expect((await request(app).post("/orders").send(input)).status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, "7"])("rejects an invalid customer id %s", async customer_id => {
    expect((await request(app).post("/orders").send({ ...input, customer_id })).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 without inserting when OSRM is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    query.mockResolvedValueOnce([[customer]]);
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));
    expect((await request(app).post("/orders").send(input)).status).toBe(502);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns 502 without inserting when OSRM times out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    query.mockResolvedValueOnce([[customer]]);
    fetchMock.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    expect((await request(app).post("/orders").send(input)).status).toBe(502);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns 409 if the customer changes while OSRM is running", async () => {
    query.mockResolvedValueOnce([[customer]]);
    query.mockResolvedValueOnce([{ affectedRows: 0, insertId: 0 }]);
    query.mockResolvedValueOnce([[{ customer_id: 7 }]]);
    const response = await request(app).post("/orders").send(input);
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("ข้อมูลลูกค้าเปลี่ยน");
  });

  it("returns 404 if the customer is deleted while OSRM is running", async () => {
    query.mockResolvedValueOnce([[customer]]);
    query.mockResolvedValueOnce([{ affectedRows: 0, insertId: 0 }]);
    query.mockResolvedValueOnce([[]]);
    expect((await request(app).post("/orders").send(input)).status).toBe(404);
  });

  it("stores delivery locations for every simulated order", async () => {
    query.mockResolvedValueOnce([[{ customer_id: 7, name: "Test", phone: "000",
      address: "Original address", latitude: "16.2500000", longitude: "103.2500000" }]]);
    query.mockResolvedValueOnce([{ affectedRows: 20, insertId: 32 }]);
    const response = await request(app).post("/orders/simulated");
    expect(response.status).toBe(201);
    const [sql, [orders]] = query.mock.calls[1]!;
    expect(sql).toContain("delivery_address");
    expect(sql).toContain("delivery_latitude");
    expect(sql).toContain("delivery_longitude");
    expect(orders.length).toBeGreaterThanOrEqual(20);
    expect(orders.length).toBeLessThanOrEqual(30);
    for (const order of orders) expect(order.slice(7)).toEqual(["Original address", "16.2500000", "103.2500000"]);
  });

  it.each([0, 0.9999])("simulates only eligible customers, including the 3 km boundary (random %s)", async random => {
    vi.spyOn(Math, "random").mockReturnValue(random);
    const customers = [
      { ...customer, customer_id: 1, latitude: "16.251" },
      { ...customer, customer_id: 2, latitude: "16.252" },
      { ...customer, customer_id: 3, latitude: "16.253" },
      { ...customer, customer_id: 4, latitude: "16.254" },
      { ...customer, customer_id: 5, latitude: "" },
    ];
    query.mockResolvedValueOnce([customers]);
    query.mockResolvedValueOnce([{ affectedRows: random === 0 ? 20 : 30, insertId: 32 }]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: "Ok", distances: [[1000, 3000, 3000.1, null]] })));
    const response = await request(app).post("/orders/simulated").send({ origin: { latitude: 0, longitude: 0 } });
    expect(response.status).toBe(201);
    const expected = customers[random === 0 ? 0 : 1]!;
    const orders = query.mock.calls[1]![1][0];
    expect(orders).toHaveLength(random === 0 ? 20 : 30);
    for (const order of orders) {
      expect(order[0]).toBe(expected.customer_id);
      expect(order[2]).toBeGreaterThanOrEqual(1);
      expect(order[2]).toBeLessThanOrEqual(3);
      expect(order.slice(3)).toEqual([65, 40, true, "ACTIVE", expected.address, expected.latitude, expected.longitude]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as URL;
    expect(url.pathname).toBe(`/table/v1/driving/${SHOP_ORIGIN.longitude},${SHOP_ORIGIN.latitude};103.25,16.251;103.25,16.252;103.25,16.253;103.25,16.254`);
  });

  it.each([{ customers: [] }, { customers: [{ ...customer, latitude: null }] }])("does not simulate or call OSRM when no valid customer coordinates exist", async ({ customers }) => {
    query.mockResolvedValueOnce([customers]);
    const response = await request(app).post("/orders/simulated");
    expect(response.status).toBe(422);
    expect(response.body.error).toContain("ไม่มีลูกค้า");
    expect(query).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not insert simulated orders if all customers are outside the area or unreachable", async () => {
    query.mockResolvedValueOnce([[customer, { ...customer, customer_id: 8, latitude: "16.251" }]]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: "Ok", distances: [[3000.1, null]] })));
    const response = await request(app).post("/orders/simulated");
    expect(response.status).toBe(422);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(["unavailable", "timeout"])("does not insert simulated orders when OSRM is %s", async failure => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    query.mockResolvedValueOnce([[customer]]);
    if (failure === "timeout") fetchMock.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    else fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));
    expect((await request(app).post("/orders/simulated")).status).toBe(502);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(["/orders", "/orders/with-customers", "/orders/with-customers/search?keyword=Test",
    "/orders/nearby?lat=16.25&lng=103.25"])("reads the frozen location using the existing UI field names: %s", async endpoint => {
    query.mockResolvedValue([[]]);
    expect((await request(app).get(endpoint)).status).toBe(200);
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("orders.delivery_address AS address");
    expect(sql).toContain("orders.delivery_latitude AS latitude");
    expect(sql).toContain("orders.delivery_longitude AS longitude");
    expect(sql).not.toMatch(/customers\.(address|latitude|longitude)/);
  });
});
