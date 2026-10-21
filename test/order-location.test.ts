import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../dbconnect", () => ({ conn: { query } }));
import { app } from "../app";

const input = { customer_id: 7, delivery_date: "2026-10-21", quantity: 2,
  unit_price: 65, unit_cost: 40, is_simulated: 0, status: "ACTIVE" };

beforeEach(() => query.mockReset());

// เปลี่ยน: ตรวจการคัดลอกจุดส่งฝั่ง server โดยไม่เชื่อพิกัดที่ client ส่งมา
describe("Order delivery location snapshots (mocked database)", () => {
  it("copies the customer's location in the same INSERT and ignores client location fields", async () => {
    query.mockResolvedValue([{ affectedRows: 1, insertId: 31 }]);
    const response = await request(app).post("/orders").send({ ...input,
      delivery_address: "spoofed", delivery_latitude: 0, delivery_longitude: 0 });
    expect(response.status).toBe(201);
    expect(response.body.last_idx).toBe(31);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("delivery_address, delivery_latitude, delivery_longitude");
    expect(sql).toMatch(/SELECT customer_id, \?, \?, \?, \?, \?, \?, address, latitude, longitude\s+FROM customers WHERE customer_id = \?/);
    expect(params).toEqual([input.delivery_date, 2, 65, 40, 0, "ACTIVE", 7]);
  });

  it("returns 404 if the customer no longer exists", async () => {
    query.mockResolvedValue([{ affectedRows: 0, insertId: 0 }]);
    expect((await request(app).post("/orders").send(input)).status).toBe(404);
  });

  it("rejects a missing body without writing an order", async () => {
    expect((await request(app).post("/orders")).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
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
