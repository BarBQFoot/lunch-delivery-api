import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), matrix: vi.fn(), route: vi.fn(), randomCode: vi.fn() }));
vi.mock("node:crypto", async importOriginal => ({ ...await importOriginal<typeof import("node:crypto")>(), randomInt: mocks.randomCode }));
vi.mock("../dbconnect", () => ({ conn: { query: mocks.query, getConnection: async () => ({ query: mocks.query,
  beginTransaction: mocks.begin, commit: mocks.commit, rollback: mocks.rollback, release: mocks.release }) } }));
vi.mock("../service/osrm", async importOriginal => ({ ...await importOriginal<typeof import("../service/osrm")>(), getDistanceMatrix: mocks.matrix, getRoute: mocks.route }));

import { app } from "../app";
import { getPreview, rememberPreview } from "../service/job-store";
import { OsrmError } from "../service/osrm";

const settings = { delivery_date: "2026-10-05", origin: { latitude: 16.25, longitude: 103.25 } };
const rows = [1, 2].map(id => ({ order_id: id, customer_id: id, delivery_date: "2026-10-05", quantity: 1,
  unit_price: "65.00", unit_cost: "40.00", status: "ACTIVE", name: `Customer ${id}`, phone: "000",
  address: "test", latitude: "16.251", longitude: "103.25" }));
let currentRows = rows;
let assigned: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks(); currentRows = rows; assigned = [];
  mocks.randomCode.mockReset().mockReturnValue(482731);
  mocks.route.mockReset().mockResolvedValue({ type: "LineString", coordinates: [[103.25, 16.25], [103.25, 16.251]] });
  mocks.matrix.mockResolvedValue([[0, 1, 1], [1, 0, 1], [1, 1, 0]]);
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM orders o")) return [currentRows];
    if (sql.startsWith("SELECT order_id FROM job_stops")) return [assigned];
    if (sql.startsWith("INSERT INTO job_sheets")) return [{ insertId: 11 }];
    if (sql.includes("INSERT INTO job_stops")) return [{ insertId: 12 }];
    return [[]];
  });
});
afterEach(() => vi.restoreAllMocks());

async function preview() {
  const response = await request(app).post("/job-sheets/preview").send({ settings, order_ids: [1, 2] });
  expect(response.status).toBe(200);
  return response.body.preview_id as string;
}

describe("Job sheet API with mocked database", () => {
  it("persists server-generated geometry and returns it without OSRM on reads", async () => {
    const id = await preview();
    expect((await request(app).post("/job-sheets/confirm").send({ preview_id: id })).status).toBe(201);
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).startsWith("INSERT INTO job_sheets"))!;
    const data = JSON.parse(insert[1][7]);
    expect(data.route_geometry).toEqual(await mocks.route.mock.results[0]!.value);
    expect(mocks.route).toHaveBeenCalledWith([
      settings.origin, ...data.job.stops.map((stop: any) => ({ latitude: stop.order.latitude, longitude: stop.order.longitude })),
    ]);
    mocks.route.mockClear();
    mocks.query.mockImplementation(async (sql: string) => sql.includes("FROM job_sheets")
      ? [[{ job_id: 11, job_code: "482731", planning_data: JSON.stringify(data) }]] : [[]]);
    const opened = await request(app).get("/job-sheets/by-code/482731");
    expect(opened.status).toBe(200);
    expect(opened.body.route_geometry).toEqual(data.route_geometry);
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it("keeps the preview and performs no transaction when route generation fails", async () => {
    const id = await preview();
    mocks.route.mockRejectedValueOnce(new OsrmError("offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await request(app).post("/job-sheets/confirm").send({ preview_id: id })).status).toBe(502);
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(() => getPreview(id)).not.toThrow();
    expect((await request(app).post("/job-sheets/confirm").send({ preview_id: id })).status).toBe(201);
  });

  it("previews without writing, then atomically confirms and consumes the preview", async () => {
    const id = await preview();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.every(([sql]) => !String(sql).includes("INSERT"))).toBe(true);
    const response = await request(app).post("/job-sheets/confirm").send({ preview_id: id });
    expect(response.status).toBe(201);
    expect(response.body.jobs[0].job_code).toBe("482731");
    expect(mocks.randomCode).toHaveBeenCalledWith(100_000, 1_000_000);
    expect(mocks.commit).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("FOR UPDATE"))).toBe(true);
    expect((await request(app).post("/job-sheets/confirm").send({ preview_id: id })).status).toBe(409);
  });

  it("retries a duplicate job code before saving stops", async () => {
    const id = await preview();
    mocks.randomCode.mockReturnValueOnce(482731).mockReturnValueOnce(629845);
    const original = mocks.query.getMockImplementation()!;
    let inserts = 0;
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith("INSERT INTO job_sheets") && ++inserts === 1) throw { code: "ER_DUP_ENTRY" };
      return original(sql, params);
    });
    const response = await request(app).post("/job-sheets/confirm").send({ preview_id: id });
    expect(response.status).toBe(201);
    expect(response.body.jobs[0].job_code).toBe("629845");
    const issuedCodes = mocks.query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO job_sheets"))
      .map(([, params]) => params[0]);
    expect(issuedCodes).toEqual(["482731", "629845"]);
    expect(mocks.commit).toHaveBeenCalledOnce();
    expect(mocks.rollback).not.toHaveBeenCalled();
  });

  it("rolls back and retains the preview when code retries are exhausted", async () => {
    const id = await preview();
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith("INSERT INTO job_sheets")) throw { code: "ER_DUP_ENTRY" };
      return original(sql, params);
    });
    const response = await request(app).post("/job-sheets/confirm").send({ preview_id: id });
    expect(response.status).toBe(503);
    expect(mocks.randomCode).toHaveBeenCalledTimes(10);
    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO job_stops"))).toBe(false);
    mocks.query.mockImplementation(original);
    expect((await request(app).post("/job-sheets/confirm").send({ preview_id: id })).status).toBe(201);
  });

  it.each(["482731", "JOB-20261005-A1B2C3D4E5F6"])("opens both new and existing job code %s", async code => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM job_sheets")) return [[{ job_id: 11, job_code: code, planning_data: null }]];
      return [[]];
    });
    const response = await request(app).get(`/job-sheets/by-code/${code}`);
    expect(response.status).toBe(200);
    expect(response.body.job_code).toBe(code);
    expect(response.body.route_geometry).toBeNull();
    expect(mocks.query.mock.calls[0]![1]).toEqual([code]);
  });

  it("rejects edits after preview and rolls back", async () => {
    const id = await preview();
    currentRows = rows.map(row => ({ ...row, quantity: 2 }));
    const response = await request(app).post("/job-sheets/confirm").send({ preview_id: id });
    expect(response.status).toBe(409);
    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("rejects orders allocated by another request", async () => {
    const id = await preview(); assigned = [{ order_id: 1 }];
    expect((await request(app).post("/job-sheets/confirm").send({ preview_id: id })).status).toBe(409);
  });

  it("rolls back the complete batch when a stop insert fails", async () => {
    const id = await preview();
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO job_stops")) throw { code: "ER_DUP_ENTRY" };
      return original(sql);
    });
    expect((await request(app).post("/job-sheets/confirm").send({ preview_id: id })).status).toBe(409);
    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("does not call OSRM for invalid input or missing selected orders", async () => {
    expect((await request(app).post("/job-sheets/preview").send({ settings, order_ids: [1, 1] })).status).toBe(400);
    expect((await request(app).post("/job-sheets/preview").send({ settings, order_ids: [1, 99] })).status).toBe(409);
    expect(mocks.matrix).not.toHaveBeenCalled();
  });

  it("rejects marking a later stop before the earlier one", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM job_sheets")) return [[{ job_id: 1, status: "ISSUED", started_at: "2026-10-05 11:30:00" }]];
      if (sql.includes("FROM job_stops")) return [[{ stop_id: 1, stop_sequence: 1, delivered_at: null }, { stop_id: 2, stop_sequence: 2, delivered_at: null }]];
      return [[]];
    });
    const response = await request(app).post("/job-sheets/by-code/JOB-TEST/stops/2/deliver");
    expect(response.status).toBe(409);
    expect(mocks.rollback).toHaveBeenCalledOnce();
  });

  it("reports outside-area orders before any job is saved", async () => {
    mocks.matrix.mockResolvedValue([[0, 1, 3.1], [1, 0, 1], [3.1, 1, 0]]);
    const response = await request(app).post("/job-sheets/preview").send({ settings, order_ids: [1, 2] });
    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject([{ order_id: 2, distance_km: 3.1 }]);
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("replaces only the current preview, without a signature, and confirms the replacement", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const id = await preview();
    const otherUserId = await preview();
    const response = await request(app).post("/job-sheets/preview").send({
      settings, order_ids: [1, 2], previous_preview_id: id,
    });
    expect(response.status).toBe(200);
    expect(response.body.signature).toBeUndefined();
    expect(response.body.preview_id).not.toBe(id);
    expect(() => getPreview(id)).toThrow("ถูกแทนที่");
    expect(getPreview(otherUserId)).toBeDefined();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect((await request(app).post("/job-sheets/confirm").send({ preview_id: response.body.preview_id })).status).toBe(201);
  });

  it("keeps the current preview confirmable when no alternative is found", async () => {
    mocks.matrix.mockResolvedValue([[0, 1], [1, 0]]);
    const first = await request(app).post("/job-sheets/preview").send({ settings, order_ids: [1] });
    const id = first.body.preview_id;
    const response = await request(app).post("/job-sheets/preview").send({ settings, order_ids: [1], previous_preview_id: id });
    expect(response.status).toBe(422);
    expect(getPreview(id)).toBeDefined();
    currentRows = [rows[0]!];
    expect((await request(app).post("/job-sheets/confirm").send({ preview_id: id })).status).toBe(201);
  });

  it("keeps the current preview when OSRM fails", async () => {
    const id = await preview();
    mocks.matrix.mockRejectedValueOnce(new OsrmError("upstream failed"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await request(app).post("/job-sheets/preview").send({ settings, order_ids: [1, 2], previous_preview_id: id });
    expect(response.status).toBe(502);
    expect(getPreview(id)).toBeDefined();
  });

  it.each(["", 123, {}])("rejects an invalid previous preview id before requesting OSRM: %s", async previous_preview_id => {
    const response = await request(app).post("/job-sheets/preview").send({ settings, order_ids: [1, 2], previous_preview_id });
    expect(response.status).toBe(400);
    expect(mocks.matrix).not.toHaveBeenCalled();
  });

  it("rejects an expired previous preview before requesting OSRM", async () => {
    const id = await preview();
    const expires = getPreview(id).expires;
    mocks.matrix.mockClear();
    vi.spyOn(Date, "now").mockReturnValue(expires + 1);
    const response = await request(app).post("/job-sheets/preview").send({ settings, order_ids: [1, 2], previous_preview_id: id });
    expect(response.status).toBe(409);
    expect(mocks.matrix).not.toHaveBeenCalled();
  });

  it("replaces a draft after selection or settings change without demanding different routes", async () => {
    const id = await preview();
    mocks.matrix.mockResolvedValue([[0, 1], [1, 0]]);
    const edited = await request(app).post("/job-sheets/preview").send({ settings, order_ids: [1], previous_preview_id: id });
    expect(edited.status).toBe(200);
    expect(() => getPreview(id)).toThrow();
    const changedTime = await request(app).post("/job-sheets/preview").send({
      settings: { ...settings, departure_time: "11:00" }, order_ids: [1], previous_preview_id: edited.body.preview_id,
    });
    expect(changedTime.status).toBe(200);
  });

  it("rejects a late replacement after another request has already replaced the same preview", async () => {
    const id = await preview();
    const stored = getPreview(id);
    const next = rememberPreview(stored.plan, stored.orders, id);
    expect(() => rememberPreview(stored.plan, stored.orders, id)).toThrow("ถูกแทนที่");
    expect(getPreview(next.preview_id)).toBeDefined();
  });

  it("allows more than 20 plan changes without keeping a history", async () => {
    const random = vi.spyOn(Math, "random");
    let id = await preview();
    for (let index = 0; index < 22; index++) {
      random.mockReturnValue(index % 2 === 0 ? 0 : 0.99);
      const response = await request(app).post("/job-sheets/preview").send({
        settings, order_ids: [1, 2], previous_preview_id: id,
      });
      expect(response.status).toBe(200);
      expect(() => getPreview(id)).toThrow();
      id = response.body.preview_id;
    }
    expect((await request(app).post("/job-sheets/confirm").send({ preview_id: id })).status).toBe(201);
  });
});
