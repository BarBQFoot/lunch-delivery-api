import { randomInt, randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { conn } from "../dbconnect";
import { DeliveryPlan, PlanningError, PlanningOrder, StoredPlanningData, bangkokTime, localDateTime, validDate } from "../model/delivery";
import { normalizeOrders } from "./planning-input";

export const ORDER_FIELDS = `o.*, DATE_FORMAT(o.delivery_date, '%Y-%m-%d') AS delivery_date,
  c.name, c.phone, c.address, c.latitude, c.longitude`;
const previews = new Map<string, { plan: DeliveryPlan; orders: PlanningOrder[]; expires: number }>();

export function rememberPreview(plan: DeliveryPlan, orders: PlanningOrder[]) {
  for (const [key, preview] of previews) if (preview.expires < Date.now()) previews.delete(key);
  if (previews.size >= 50) previews.delete(previews.keys().next().value!);
  const id = randomUUID();
  const expires = Date.now() + 30 * 60_000;
  previews.set(id, { plan, orders, expires });
  return { preview_id: id, expires_at: new Date(expires).toISOString(), ...plan };
}

export async function eligibleOrders(date: string) {
  if (!validDate(date)) throw new PlanningError("วันที่จัดส่งไม่ถูกต้อง");
  const [rows] = await conn.query<RowDataPacket[]>(`SELECT ${ORDER_FIELDS}
    FROM orders o JOIN customers c ON c.customer_id = o.customer_id
    WHERE o.delivery_date = ? AND o.status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM job_stops s WHERE s.order_id = o.order_id)
    ORDER BY o.order_id`, [date]);
  return rows;
}

export async function selectedOrders(ids: number[], date: string): Promise<PlanningOrder[]> {
  const rows = await eligibleOrders(date);
  const selected = rows.filter(row => ids.includes(Number(row.order_id)));
  if (selected.length !== ids.length) throw new PlanningError("บางออเดอร์ไม่พร้อมจัดงาน วันที่ไม่ตรง หรือถูกจัดงานแล้ว กรุณาโหลดรายการใหม่", 409);
  return normalizeOrders(selected);
}

async function transaction<T>(work: (db: PoolConnection) => Promise<T>): Promise<T> {
  const db = await conn.getConnection();
  try {
    await db.beginTransaction();
    const result = await work(db);
    await db.commit();
    return result;
  } catch (error) {
    await db.rollback();
    throw error;
  } finally { db.release(); }
}

export async function confirmPreview(id: string) {
  const preview = previews.get(id);
  if (!preview || preview.expires < Date.now()) throw new PlanningError("แผนหมดอายุหรือยืนยันแล้ว กรุณาคำนวณแผนใหม่", 409);
  const issued = await transaction(async db => {
    const ids = preview.orders.map(order => order.order_id).sort((a, b) => a - b);
    const [rows] = await db.query<RowDataPacket[]>(`SELECT ${ORDER_FIELDS}
      FROM orders o JOIN customers c ON c.customer_id = o.customer_id
      WHERE o.order_id IN (?) ORDER BY o.order_id FOR UPDATE`, [ids]);
    const current = normalizeOrders(rows);
    const [assigned] = await db.query<RowDataPacket[]>("SELECT order_id FROM job_stops WHERE order_id IN (?)", [ids]);
    if (assigned.length || JSON.stringify(current) !== JSON.stringify(preview.orders)) {
      throw new PlanningError("ข้อมูลออเดอร์หรือลูกค้าเปลี่ยนไป หรือมีการจัดงานแล้ว กรุณาคำนวณแผนใหม่", 409);
    }
    const result: { job_id: number; job_code: string }[] = [];
    for (const job of preview.plan.jobs) {
      const settings = preview.plan.settings;
      if (job.delivery_cost > 99_999_999.99 || job.total_distance_km > 99_999_999.99) {
        throw new PlanningError("ระยะทางหรือค่าใช้จ่ายเกินขนาดที่ฐานข้อมูลรองรับ", 422);
      }
      const planningData: StoredPlanningData = { settings, job };
      let issuedJob: { job_id: number; job_code: string } | undefined;
      for (let attempt = 0; attempt < 10; attempt++) {
        const code = String(randomInt(100_000, 1_000_000));
        try {
          const [insert] = await db.query<ResultSetHeader>(`INSERT INTO job_sheets
            (job_code, delivery_date, departure_at, deadline_at, total_distance_km,
             total_duration_minutes, delivery_cost, is_locked, status, planning_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'ISSUED', ?)`, [code, settings.delivery_date,
            localDateTime(settings.delivery_date, settings.departure_time), localDateTime(settings.delivery_date, settings.deadline_time),
            job.total_distance_km, job.total_duration_minutes, job.delivery_cost, JSON.stringify(planningData)]);
          issuedJob = { job_id: insert.insertId, job_code: code };
          break;
        } catch (error) {
          // The UNIQUE job_code constraint also protects concurrent confirmations.
          if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
        }
      }
      if (!issuedJob) throw new PlanningError("ยังสร้างรหัสใบงานที่ไม่ซ้ำไม่ได้ กรุณากดยืนยันอีกครั้ง", 503);
      for (const stop of job.stops) {
        await db.query(`INSERT INTO job_stops (job_id, order_id, stop_sequence, estimated_arrival_at)
          VALUES (?, ?, ?, ?)`, [issuedJob.job_id, stop.order.order_id, stop.stop_sequence, stop.estimated_arrival_at]);
      }
      result.push(issuedJob);
    }
    return result;
  });
  previews.delete(id);
  return issued;
}

const JOB_FIELDS = `j.*, DATE_FORMAT(j.delivery_date, '%Y-%m-%d') AS delivery_date,
  DATE_FORMAT(j.departure_at, '%Y-%m-%d %H:%i:%s') AS departure_at,
  DATE_FORMAT(j.deadline_at, '%Y-%m-%d %H:%i:%s') AS deadline_at,
  DATE_FORMAT(j.started_at, '%Y-%m-%d %H:%i:%s') AS started_at,
  DATE_FORMAT(j.completed_at, '%Y-%m-%d %H:%i:%s') AS completed_at`;

export async function listJobs(date: string) {
  if (!validDate(date)) throw new PlanningError("วันที่จัดส่งไม่ถูกต้อง");
  const [rows] = await conn.query<RowDataPacket[]>(`SELECT ${JOB_FIELDS},
    (SELECT COUNT(*) FROM job_stops s WHERE s.job_id = j.job_id) AS total_orders,
    (SELECT COUNT(*) FROM job_stops s WHERE s.job_id = j.job_id AND s.delivered_at IS NOT NULL) AS delivered_orders
    FROM job_sheets j WHERE j.delivery_date = ? ORDER BY j.job_id`, [date]);
  return rows.map(row => {
    const data = readPlanningData(row.planning_data);
    return { ...row, planning_data: undefined, total_boxes: data?.job.total_boxes ?? null,
      profit: data?.job.profit ?? null };
  });
}

function readPlanningData(value: unknown): StoredPlanningData | null {
  if (!value) return null;
  return (typeof value === "string" ? JSON.parse(value) : value) as StoredPlanningData;
}

export async function getJob(code: string) {
  const [jobs] = await conn.query<RowDataPacket[]>(`SELECT ${JOB_FIELDS} FROM job_sheets j WHERE j.job_code = ?`, [code]);
  const job = jobs[0];
  if (!job) throw new PlanningError("ไม่พบเลขใบงานนี้", 404);
  const data = readPlanningData(job.planning_data);
  const [stops] = await conn.query<RowDataPacket[]>(`SELECT s.*,
    DATE_FORMAT(s.estimated_arrival_at, '%Y-%m-%d %H:%i:%s') AS estimated_arrival_at,
    DATE_FORMAT(s.delivered_at, '%Y-%m-%d %H:%i:%s') AS delivered_at,
    ${ORDER_FIELDS}
    FROM job_stops s JOIN orders o ON o.order_id = s.order_id
    JOIN customers c ON c.customer_id = o.customer_id
    WHERE s.job_id = ? ORDER BY s.stop_sequence`, [job.job_id]);
  return { ...job, planning_data: undefined, settings: data?.settings ?? null,
    totals: data?.job ? { ...data.job, stops: undefined } : null,
    stops: stops.map(stop => ({ ...stop,
      order: data?.job.stops.find(item => item.order.order_id === stop.order_id)?.order ?? null,
      late: Boolean(stop.delivered_at && String(stop.delivered_at) > String(job.deadline_at)) })) };
}

export async function startJob(code: string) {
  await transaction(async db => {
    const [jobs] = await db.query<RowDataPacket[]>("SELECT * FROM job_sheets WHERE job_code = ? FOR UPDATE", [code]);
    const job = jobs[0];
    if (!job) throw new PlanningError("ไม่พบใบงาน", 404);
    if (job.status !== "ISSUED" || !job.is_locked || job.completed_at) throw new PlanningError("ใบงานไม่อยู่ในสถานะที่เริ่มได้", 409);
    if (!job.started_at) await db.query("UPDATE job_sheets SET started_at = ? WHERE job_id = ?", [bangkokTime(Date.now()), job.job_id]);
  });
  return getJob(code);
}

export async function deliverStop(code: string, stopId: number) {
  await transaction(async db => {
    const [jobs] = await db.query<RowDataPacket[]>("SELECT * FROM job_sheets WHERE job_code = ? FOR UPDATE", [code]);
    const job = jobs[0];
    if (!job) throw new PlanningError("ไม่พบใบงาน", 404);
    if (job.status !== "ISSUED" || !job.started_at) throw new PlanningError("กรุณาเริ่มงานก่อนส่งอาหาร", 409);
    const [stops] = await db.query<RowDataPacket[]>("SELECT * FROM job_stops WHERE job_id = ? ORDER BY stop_sequence FOR UPDATE", [job.job_id]);
    const stop = stops.find(item => item.stop_id === stopId);
    if (!stop) throw new PlanningError("ไม่พบจุดส่งในใบงานนี้", 404);
    if (stop.delivered_at) return; // Retry is idempotent.
    if (stops.some(item => item.stop_sequence < stop.stop_sequence && !item.delivered_at)) {
      throw new PlanningError("กรุณาส่งตามลำดับในใบงาน", 409);
    }
    const now = bangkokTime(Date.now());
    await db.query("UPDATE job_stops SET delivered_at = ? WHERE stop_id = ?", [now, stopId]);
    if (stops.every(item => item.stop_id === stopId || item.delivered_at)) {
      await db.query("UPDATE job_sheets SET completed_at = ? WHERE job_id = ?", [now, job.job_id]);
    }
  });
  return getJob(code);
}
