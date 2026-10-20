import express, { type RequestHandler } from "express";
import { conn } from "../dbconnect";
import { PlanningError } from "../model/delivery";
import { createDeliveryPlan } from "../service/delivery-planning";
import { confirmPreview, deliverStop, eligibleOrders, getJob, listJobs, rememberPreview, selectedOrders, startJob } from "../service/job-store";
import { getDistanceMatrix, getRoute, OsrmError, parseCoordinate } from "../service/osrm";
import { readOrderIds, readSettings } from "../service/planning-input";

export const router = express.Router();

const handle = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
  try { await handler(req, res, next); }
  catch (error) {
    if (error instanceof PlanningError) return void res.status(error.status).json({ error: error.message, details: error.details });
    if (error instanceof OsrmError) return void res.status(502).json({ error: "ติดต่อ OSRM ไม่สำเร็จ กรุณาลองใหม่" });
    const code = (error as { code?: string }).code;
    if (code === "ER_DUP_ENTRY") return void res.status(409).json({ error: "มีออเดอร์ถูกจัดงานแล้ว กรุณาคำนวณแผนใหม่" });
    if (code === "ER_BAD_FIELD_ERROR") return void res.status(503).json({ error: "ฐานข้อมูลยังไม่มีคอลัมน์สำหรับระบบใบงาน กรุณารัน npm run db:migrate ที่ Backend" });
    console.error("Job sheet API failed", error);
    res.status(500).json({ error: "ไม่สามารถดำเนินการกับใบงานได้" });
  }
};

router.get("/dates", handle(async (_req, res) => {
  const [rows] = await conn.query(`SELECT DATE_FORMAT(o.delivery_date, '%Y-%m-%d') AS delivery_date,
    COUNT(*) AS total_orders,
    SUM(o.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM job_stops s WHERE s.order_id = o.order_id)) AS eligible_orders
    FROM orders o GROUP BY o.delivery_date ORDER BY o.delivery_date DESC LIMIT 365`);
  res.json(rows);
}));

router.get("/eligible-orders", handle(async (req, res) => {
  res.json(await eligibleOrders(String(req.query.date ?? "")));
}));

router.post("/preview", handle(async (req, res) => {
  const settings = readSettings(req.body?.settings);
  const ids = readOrderIds(req.body?.order_ids);
  const excluded = req.body?.exclude_signatures ?? [];
  if (!Array.isArray(excluded) || excluded.length > 20 ||
      excluded.some(item => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item))) {
    throw new PlanningError("รายการแผนที่ขอข้ามไม่ถูกต้อง");
  }
  const orders = await selectedOrders(ids, settings.delivery_date);
  const matrix = await getDistanceMatrix([settings.origin, ...orders]);
  const plan = createDeliveryPlan(orders, settings, matrix, excluded);
  res.json(rememberPreview(plan, orders));
}));

router.post("/confirm", handle(async (req, res) => {
  if (typeof req.body?.preview_id !== "string") throw new PlanningError("กรุณาระบุรหัสแผนตัวอย่าง");
  const jobs = await confirmPreview(req.body.preview_id);
  res.status(201).json({ jobs });
}));

router.post("/route", handle(async (req, res) => {
  const points = req.body?.points;
  if (!Array.isArray(points) || points.length < 2 || points.length > 5) throw new PlanningError("ระบุพิกัด 2–5 จุดสำหรับเส้นทาง");
  const coordinates = points.map(point => {
    const latitude = parseCoordinate(point?.latitude, 90);
    const longitude = parseCoordinate(point?.longitude, 180);
    if (latitude === null || longitude === null) throw new PlanningError("พิกัดเส้นทางไม่ถูกต้อง");
    return { latitude, longitude };
  });
  res.json(await getRoute(coordinates));
}));

router.get("/by-code/:code", handle(async (req, res) => {
  res.json(await getJob(String(req.params.code)));
}));

router.post("/by-code/:code/start", handle(async (req, res) => {
  res.json(await startJob(String(req.params.code)));
}));

router.post("/by-code/:code/stops/:stopId/deliver", handle(async (req, res) => {
  const id = Number(req.params.stopId);
  if (!Number.isInteger(id) || id < 1) throw new PlanningError("เลขจุดส่งไม่ถูกต้อง");
  res.json(await deliverStop(String(req.params.code), id));
}));

router.get("/", handle(async (req, res) => { res.json(await listJobs(String(req.query.date ?? ""))); }));
