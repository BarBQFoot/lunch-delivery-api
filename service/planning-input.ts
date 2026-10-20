import { PlanningError, PlanningOrder, PlanningSettings, validDate } from "../model/delivery";
import { parseCoordinate } from "./osrm";

export function readSettings(value: unknown): PlanningSettings {
  if (!value || typeof value !== "object") throw new PlanningError("กรุณาระบุค่าจัดส่ง");
  const input = value as Record<string, unknown>;
  if (!validDate(input.delivery_date)) throw new PlanningError("วันที่จัดส่งไม่ถูกต้อง");
  const departure = input.departure_time ?? "11:30";
  const deadline = input.deadline_time ?? "12:30";
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof departure !== "string" || typeof deadline !== "string" ||
      !timePattern.test(departure) || !timePattern.test(deadline) || deadline <= departure) {
    throw new PlanningError("เวลาออกและกำหนดส่งต้องอยู่วันเดียวกัน และกำหนดส่งต้องหลังเวลาออก");
  }
  const origin = input.origin as Record<string, unknown> | undefined;
  const latitude = parseCoordinate(origin?.latitude, 90);
  const longitude = parseCoordinate(origin?.longitude, 180);
  if (latitude === null || longitude === null) throw new PlanningError("กรุณาระบุพิกัดร้านให้ถูกต้อง");
  const numeric = (name: string, fallback: number, min: number, max: number) => {
    const raw = input[name] ?? fallback;
    if ((typeof raw !== "number" && typeof raw !== "string") || String(raw).trim() === "") {
      throw new PlanningError(`ค่า ${name} ไม่ถูกต้อง`);
    }
    const number = Number(raw);
    if (!Number.isFinite(number) || number < min || number > max) throw new PlanningError(`ค่า ${name} ไม่ถูกต้อง`);
    return number;
  };
  if (input.return_to_shop !== undefined && typeof input.return_to_shop !== "boolean") {
    throw new PlanningError("return_to_shop ต้องเป็น boolean");
  }
  return {
    delivery_date: input.delivery_date, departure_time: departure, deadline_time: deadline,
    origin: { latitude, longitude }, speed_kmh: numeric("speed_kmh", 30, 1, 120),
    service_minutes: numeric("service_minutes", 2, 0, 60),
    fixed_cost: numeric("fixed_cost", 15, 0, 10000),
    cost_per_km_per_box: numeric("cost_per_km_per_box", 2, 0, 10000),
    return_to_shop: input.return_to_shop ?? false,
  };
}

export function readOrderIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30 ||
      value.some(id => !Number.isInteger(id) || id < 1) || new Set(value).size !== value.length) {
    throw new PlanningError("เลือกออเดอร์ 1–30 รายการโดยไม่ซ้ำกัน");
  }
  return [...value].sort((a, b) => a - b);
}

export function normalizeOrders(rows: Record<string, unknown>[]): PlanningOrder[] {
  const issues: { order_id: unknown; reason: string }[] = [];
  const result = rows.map(row => {
    const latitude = parseCoordinate(row.latitude, 90);
    const longitude = parseCoordinate(row.longitude, 180);
    const quantity = Number(row.quantity);
    const unit_price = Number(row.unit_price);
    const unit_cost = Number(row.unit_cost);
    if (latitude === null || longitude === null) issues.push({ order_id: row.order_id, reason: "พิกัดลูกค้าไม่ถูกต้อง" });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 3 ||
        row.unit_price == null || row.unit_cost == null || !Number.isFinite(unit_price) ||
        !Number.isFinite(unit_cost) || unit_price < 0 || unit_cost < 0) {
      issues.push({ order_id: row.order_id, reason: "จำนวนกล่องหรือราคาไม่ถูกต้อง" });
    }
    return {
      order_id: Number(row.order_id), customer_id: Number(row.customer_id),
      delivery_date: String(row.delivery_date), quantity, unit_price, unit_cost,
      status: String(row.status), name: String(row.name), phone: String(row.phone),
      address: String(row.address), latitude: latitude ?? 0, longitude: longitude ?? 0,
    };
  });
  if (issues.length) throw new PlanningError("มีออเดอร์ที่ต้องแก้ไขก่อนจัดงาน", 422, issues);
  return result;
}
