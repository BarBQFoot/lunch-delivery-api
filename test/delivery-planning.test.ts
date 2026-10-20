import { describe, expect, it } from "vitest";
import { createDeliveryPlan, buildJob } from "../service/delivery-planning";
import { readSettings, readOrderIds, normalizeOrders } from "../service/planning-input";
import type { PlanningOrder } from "../model/delivery";

const settings = readSettings({ delivery_date: "2026-10-05", origin: { latitude: 16.25, longitude: 103.25 } });
const order = (id: number, quantity = 1): PlanningOrder => ({ order_id: id, customer_id: id,
  delivery_date: "2026-10-05", quantity, unit_price: 65, unit_cost: 40, status: "ACTIVE",
  name: `Customer ${id}`, phone: "000", address: "test", latitude: 16.25 + id / 10000, longitude: 103.25 });
const matrix = (n: number) => Array.from({ length: n + 1 }, (_, a) => Array.from({ length: n + 1 }, (_, b) => a === b ? 0 : 1));

describe("Delivery planning", () => {
  it("covers every order exactly once, with at most 3 orders per job and consistent totals", () => {
    const orders = Array.from({ length: 7 }, (_, i) => order(i + 1));
    const plan = createDeliveryPlan(orders, settings, matrix(7));
    expect(plan.jobs.every(job => job.stops.length >= 1 && job.stops.length <= 3)).toBe(true);
    expect(plan.jobs.flatMap(job => job.stops.map(stop => stop.order.order_id)).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(plan.summary.delivery_cost).toBeCloseTo(plan.jobs.reduce((sum, job) => sum + job.delivery_cost, 0));
    expect(plan.summary.profit).toBeCloseTo(7 * 25 - plan.summary.delivery_cost);
  });

  it("allows 9 boxes in 3 orders and calculates all-box delivery cost", () => {
    const job = buildJob([0, 1, 2], [order(1, 3), order(2, 3), order(3, 3)], settings, matrix(3))!;
    expect(job.total_boxes).toBe(9);
    expect(job.delivery_cost).toBe(15 + 2 * 9 * 3);
    expect(job.total_duration_minutes).toBe(12);
    expect(job.stops.map(stop => stop.estimated_arrival_at.slice(11))).toEqual(["11:32:00", "11:36:00", "11:40:00"]);
  });

  it("minimizes cost instead of always using the fewest riders", () => {
    const distances = [[0, 1, 1], [1, 0, 10], [1, 10, 0]];
    const plan = createDeliveryPlan([order(1, 3), order(2, 3)], settings, distances);
    expect(plan.jobs).toHaveLength(2);
    expect(plan.summary.delivery_cost).toBe(42);
  });

  it("uses directional distances and chooses the cheaper stop order", () => {
    const distances = [[0, 1, 2], [1, 0, 1], [2, 8, 0]];
    const plan = createDeliveryPlan([order(1), order(2)], settings, distances);
    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0]!.stops.map(stop => stop.order.order_id)).toEqual([1, 2]);
    expect(plan.jobs[0]!.total_distance_km).toBe(2);
  });

  it("rejects unreachable orders instead of dropping them", () => {
    expect(() => createDeliveryPlan([order(1)], settings, [[0, null], [null, 0]])).toThrow("บางออเดอร์");
  });

  it("accepts customers exactly 3 km from the shop", () => {
    const plan = createDeliveryPlan([order(1)], settings, [[0, 3], [3, 0]]);
    expect(plan.summary.total_orders).toBe(1);
  });

  it("rejects a selected customer beyond 3 km even if a grouped route could reach it", () => {
    const distances = [[0, 1, 3.0001], [1, 0, 0.5], [3, 0.5, 0]];
    try {
      createDeliveryPlan([order(1), order(2)], settings, distances);
      expect.fail("Expected outside-service-area rejection");
    } catch (error) {
      expect(error).toMatchObject({ status: 422, details: [{ order_id: 2, distance_km: 3.0001 }] });
    }
  });

  it("does not apply the 3 km customer limit to the whole job or the return leg", () => {
    const plan = createDeliveryPlan([order(1), order(2)], { ...settings, fixed_cost: 100 }, [[0, 2, 2], [2, 0, 2], [2, 2, 0]]);
    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0]!.total_distance_km).toBe(4);
    const returning = createDeliveryPlan([order(1)], { ...settings, return_to_shop: true }, [[0, 3], [3, 0]]);
    expect(returning.jobs[0]!.total_distance_km).toBe(6);
  });

  it("includes handover time in deadline checks and allows exact completion", () => {
    const short = { ...settings, deadline_time: "11:34" };
    expect(buildJob([0], [order(1)], short, matrix(1))).not.toBeNull();
    expect(buildJob([0], [order(1)], { ...short, deadline_time: "11:33" }, matrix(1))).toBeNull();
  });

  it("adds the return leg to distance and cost without imposing the delivery deadline on returning", () => {
    const job = buildJob([0], [order(1)], { ...settings, return_to_shop: true, deadline_time: "11:34" }, [[0, 1], [10, 0]])!;
    expect(job.total_distance_km).toBe(11);
    expect(job.total_duration_minutes).toBe(24);
    expect(job.delivery_cost).toBe(37);
  });

  it("produces a genuinely different alternative and reports exhaustion", () => {
    const orders = [order(1), order(2)];
    const first = createDeliveryPlan(orders, settings, matrix(2));
    const second = createDeliveryPlan(orders, settings, matrix(2), [first.signature]);
    expect(second.signature).not.toBe(first.signature);
    const one = createDeliveryPlan([order(1)], settings, matrix(1));
    expect(() => createDeliveryPlan([order(1)], settings, matrix(1), [one.signature])).toThrow("ไม่พบแผนทางเลือก");
  });

  it("handles 30 orders within the bounded search budget", () => {
    const plan = createDeliveryPlan(Array.from({ length: 30 }, (_, i) => order(i + 1)), settings, matrix(30));
    expect(plan.summary.total_orders).toBe(30);
    expect(new Set(plan.jobs.flatMap(job => job.stops.map(stop => stop.order.order_id))).size).toBe(30);
  });
});

describe("Planning input validation", () => {
  it.each(["2026-02-30", "not-a-date", "2026-2-1"])("rejects invalid date %s", delivery_date => {
    expect(() => readSettings({ ...settings, delivery_date })).toThrow("วันที่");
  });
  it("rejects null origin, duplicate IDs, invalid quantities and zero speed", () => {
    expect(() => readSettings({ ...settings, origin: { latitude: null, longitude: 103 } })).toThrow("พิกัด");
    expect(() => readSettings({ ...settings, speed_kmh: 0 })).toThrow("speed_kmh");
    expect(() => readOrderIds([1, 1])).toThrow();
    expect(() => normalizeOrders([{ ...order(1), quantity: 4 }])).toThrow("แก้ไข");
  });
});
