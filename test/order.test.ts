import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app";
import { conn } from "../dbconnect";

type CustomerRow = {
  customer_id: number;
  latitude: number;
  longitude: number;
};

type OrderRow = {
  order_id: number;
  is_simulated: number;
};

const validOrder = (customer: CustomerRow) => ({
  customer_id: customer.customer_id,
  delivery_date: "2026-10-05",
  quantity: 2,
  unit_price: 65,
  unit_cost: 40,
  is_simulated: 0,
  status: "ACTIVE",
});

let customer: CustomerRow;

beforeAll(async () => {
  const [rows] = await conn.query(
    "SELECT customer_id, latitude, longitude FROM customers LIMIT 1",
  );
  const customers = rows as CustomerRow[];
  if (!customers[0]) {
    throw new Error("Automated test requires at least one customer");
  }
  customer = customers[0];
});

afterAll(async () => {
  await conn.end();
});

describe("Order API", () => {
  it("lists orders from the database", async () => {
    const response = await request(app).get("/orders");

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  it.each([0, -1, 4, 1.5])(
    "rejects invalid quantity %s when creating an order",
    async (quantity) => {
      const response = await request(app)
        .post("/orders")
        .send({ ...validOrder(customer), quantity });

      expect(response.status).toBe(400);
    },
  );

  it("creates, updates, and deletes an order", async () => {
    const createResponse = await request(app)
      .post("/orders")
      .send(validOrder(customer));

    expect(createResponse.status).toBe(201);
    const orderId = createResponse.body.last_idx as number;

    try {
      const updateResponse = await request(app)
        .put(`/orders/${orderId}`)
        .send({ ...validOrder(customer), quantity: 3 });

      expect(updateResponse.status).toBe(200);

      const [rows] = await conn.query(
        "SELECT quantity FROM orders WHERE order_id = ?",
        [orderId],
      );
      expect((rows as Array<{ quantity: number }>)[0]?.quantity).toBe(3);
    } finally {
      const deleteResponse = await request(app).delete(`/orders/${orderId}`);
      expect(deleteResponse.status).toBe(200);
    }
  });

  it("creates between 20 and 30 simulated orders", async () => {
    const [beforeRows] = await conn.query(
      "SELECT COALESCE(MAX(order_id), 0) AS last_id FROM orders",
    );
    const beforeId = (beforeRows as Array<{ last_id: number }>)[0]?.last_id ?? 0;

    const response = await request(app).post("/orders/simulated");

    expect(response.status).toBe(201);
    expect(response.body.affected_row).toBeGreaterThanOrEqual(20);
    expect(response.body.affected_row).toBeLessThanOrEqual(30);

    const [createdRows] = await conn.query(
      "SELECT order_id, is_simulated FROM orders WHERE order_id > ?",
      [beforeId],
    );
    const createdOrders = createdRows as OrderRow[];
    expect(createdOrders).toHaveLength(response.body.affected_row);
    expect(createdOrders.every((order) => order.is_simulated === 1)).toBe(true);

    for (const order of createdOrders) {
      await conn.query("DELETE FROM orders WHERE order_id = ?", [
        order.order_id,
      ]);
    }
  });

  it("requires coordinates for nearby orders", async () => {
    const response = await request(app).get("/orders/nearby");

    expect(response.status).toBe(400);
  });

  it("returns nearby orders sorted by distance", async () => {
    const response = await request(app)
      .get("/orders/nearby")
      .query({ lat: customer.latitude, lng: customer.longitude });

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);

    const distances = response.body.map((order: { distance_km: number }) =>
      Number(order.distance_km),
    );
    expect(distances.every((distance: number) => distance <= 3)).toBe(true);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });
});
