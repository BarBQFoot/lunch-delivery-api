import { createHash } from "node:crypto";
import { DeliveryPlan, PlannedJob, PlannedStop, PlanningError, PlanningOrder, PlanningSettings,
  bangkokTime, localDateTime, round, timestamp } from "../model/delivery";
import type { RoadMatrix } from "./osrm";

export const SERVICE_AREA_KM = 3;

/** The limit is shop -> each customer, not the sum of all legs in a job. */
export function validateServiceArea(orders: PlanningOrder[], matrix: RoadMatrix): void {
  const issues = orders.flatMap((order, index) => {
    const distance = matrix[0]?.[index + 1];
    if (distance == null || !Number.isFinite(distance) || distance < 0) {
      return [{ order_id: order.order_id, distance_km: null as number | null,
        reason: "ไม่มีเส้นทางจากร้านถึงลูกค้า" }];
    }
    if (distance > SERVICE_AREA_KM) {
      return [{ order_id: order.order_id, distance_km: distance,
        reason: `ระยะทางตามถนนจากร้าน ${distance.toFixed(4)} กม. เกินพื้นที่บริการ ${SERVICE_AREA_KM} กม.` }];
    }
    return [];
  });
  if (issues.length) throw new PlanningError("บางออเดอร์อยู่นอกพื้นที่บริการ 3 กม. หรือไม่มีเส้นทางจากร้าน", 422, issues);
}

export function planSignature(jobs: PlannedJob[]): string {
  const routes = jobs.map(job => job.stops.map(stop => stop.order.order_id).join(",")).sort();
  return createHash("sha256").update(routes.join("|")).digest("hex");
}

export function buildJob(sequence: number[], orders: PlanningOrder[], settings: PlanningSettings, matrix: RoadMatrix): PlannedJob | null {
  let distance = 0;
  let minutes = 0;
  let previous = 0;
  const stops: PlannedStop[] = [];
  const start = timestamp(localDateTime(settings.delivery_date, settings.departure_time));
  const deadline = timestamp(localDateTime(settings.delivery_date, settings.deadline_time));
  for (const index of sequence) {
    const leg = matrix[previous]?.[index + 1];
    if (leg == null || !Number.isFinite(leg) || leg < 0) return null;
    distance += leg;
    minutes += leg / settings.speed_kmh * 60;
    const arrival = start + Math.ceil(minutes * 60) * 1000;
    minutes += settings.service_minutes;
    // Completion of the handover must also be inside the deadline.
    if (start + Math.ceil(minutes * 60) * 1000 > deadline) return null;
    stops.push({ order: orders[index]!, stop_sequence: stops.length + 1,
      distance_from_previous_km: round(leg, 4), estimated_arrival_at: bangkokTime(arrival),
      estimated_departure_at: bangkokTime(start + Math.ceil(minutes * 60) * 1000) });
    previous = index + 1;
  }
  // if (settings.return_to_shop) {
  //   const back = matrix[previous]?.[0];
  //   if (back == null || !Number.isFinite(back) || back < 0) return null;
  //   distance += back;
  //   minutes += back / settings.speed_kmh * 60;
  //   // The deadline applies to deliveries; returning to the shop can be later.
  // }
  const boxes = stops.reduce((sum, stop) => sum + stop.order.quantity, 0);
  const revenue = round(stops.reduce((sum, stop) => sum + stop.order.quantity * stop.order.unit_price, 0));
  const foodCost = round(stops.reduce((sum, stop) => sum + stop.order.quantity * stop.order.unit_cost, 0));
  const cost = round(settings.fixed_cost + settings.cost_per_km_per_box * boxes * distance);
  return { stops, total_boxes: boxes, total_distance_km: round(distance, 4),
    total_duration_minutes: round(minutes, 2), delivery_cost: cost, revenue,
    food_cost: foodCost, profit: round(revenue - foodCost - cost) };
}

function permutations(values: number[]): number[][] {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest]));
}

/** Enumerate groups of at most 3, then search disjoint groups under a bounded budget. */
export function createDeliveryPlan(orders: PlanningOrder[], settings: PlanningSettings, matrix: RoadMatrix, excluded: string[] = []): DeliveryPlan {
  if (!orders.length || orders.length > 30) throw new PlanningError("จัดงานได้ครั้งละ 1–30 ออเดอร์");
  if (matrix.length !== orders.length + 1 || matrix.some(row => row.length !== matrix.length)) {
    throw new PlanningError("ตารางระยะทางไม่ตรงกับออเดอร์", 502);
  }
  validateServiceArea(orders, matrix);
  type Candidate = { mask: number; job: PlannedJob; saving: number };
  const candidates: Candidate[] = [];
  const singles = orders.map((_, index) => buildJob([index], orders, settings, matrix)?.delivery_cost ?? 1e9);
  const addGroup = (group: number[]) => {
    // Retain different stop orders so an alternative can differ even with one group.
    for (const sequence of permutations(group)) {
      const job = buildJob(sequence, orders, settings, matrix);
      if (!job) continue;
      candidates.push({ mask: group.reduce((mask, index) => mask | (1 << index), 0), job,
        saving: group.reduce((sum, index) => sum + singles[index]!, 0) - job.delivery_cost });
    }
  };
  for (let a = 0; a < orders.length; a++) {
    addGroup([a]);
    for (let b = a + 1; b < orders.length; b++) {
      addGroup([a, b]);
      for (let c = b + 1; c < orders.length; c++) addGroup([a, b, c]);
    }
  }
  const byOrder = orders.map((_, index) => candidates.filter(candidate => candidate.mask & (1 << index))
    .sort((a, b) => b.saving - a.saving || a.job.delivery_cost - b.job.delivery_cost));
  const impossible = orders.filter((_, index) => !byOrder[index]!.length);
  if (impossible.length) throw new PlanningError("บางออเดอร์ไม่มีเส้นทางหรือส่งไม่ทันกำหนด", 422,
    impossible.map(order => ({ order_id: order.order_id, reason: "หาเส้นทางที่ส่งทันกำหนดไม่ได้" })));
  const lowerShare = byOrder.map(list => Math.min(...list.map(item => item.job.delivery_cost / item.job.stops.length)));
  const all = (1 << orders.length) - 1;
  const excludedSet = new Set(excluded);
  let bestJobs: PlannedJob[] | null = null;
  let bestCost = Infinity;
  let visited = 0;
  let exhausted = true;
  const end = Date.now() + 1500;
  const search = (used: number, jobs: PlannedJob[], cost: number) => {
    if (++visited > 40_000 || Date.now() > end) { exhausted = false; return; }
    if (used === all) {
      if (cost < bestCost - 0.001 && !excludedSet.has(planSignature(jobs))) {
        bestCost = cost;
        bestJobs = [...jobs];
      }
      return;
    }
    let bound = cost;
    let first = -1;
    for (let index = 0; index < orders.length; index++) if (!(used & (1 << index))) {
      bound += lowerShare[index]!;
      if (first < 0) first = index;
    }
    if (bound >= bestCost - 0.001) return;
    for (const candidate of byOrder[first]!) {
      if (candidate.mask & used) continue;
      search(used | candidate.mask, [...jobs, candidate.job], cost + candidate.job.delivery_cost);
      if (!exhausted) return;
    }
  };
  search(0, [], 0);
  if (!bestJobs) throw new PlanningError(excluded.length
    ? "ไม่พบแผนทางเลือกเพิ่มเติมภายในเวลาค้นหา เลือกใช้แผนเดิมหรือปรับเงื่อนไข"
    : "ยังจัดแผนที่ครอบคลุมทุกออเดอร์ไม่ได้ กรุณาปรับเวลาออกหรือกำหนดส่ง", 422);
  const jobs = bestJobs as PlannedJob[];
  jobs.sort((a, b) => a.stops[0]!.order.order_id - b.stops[0]!.order.order_id);
  const sum = (key: "total_boxes" | "total_distance_km" | "delivery_cost" | "revenue" | "food_cost" | "profit") =>
    round(jobs.reduce((total, job) => total + job[key], 0));
  return { settings, jobs, signature: planSignature(jobs),
    method: exhausted ? "ค้นหาครบภายใต้เส้นทางและเงื่อนไขที่กำหนด" : "แผนต้นทุนต่ำจากการค้นหาแบบจำกัดเวลา ไม่รับประกันค่าต่ำสุดทั้งหมด",
    summary: { total_orders: orders.length, total_boxes: sum("total_boxes"), riders: jobs.length,
      total_distance_km: sum("total_distance_km"), delivery_cost: sum("delivery_cost"),
      revenue: sum("revenue"), food_cost: sum("food_cost"), profit: sum("profit") } };
}
