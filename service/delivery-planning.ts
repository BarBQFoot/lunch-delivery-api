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

// เปรียบเทียบกลุ่มและลำดับส่งโดยตรง การสลับตำแหน่งการ์ดไม่นับเป็นแผนใหม่
export function sameDeliveryJobs(first: PlannedJob[], second: PlannedJob[]): boolean {
  return first.length === second.length && first.every(job =>
    second.some(other =>
      job.stops.length === other.stops.length &&
      job.stops.every((stop, index) => stop.order.order_id === other.stops[index]!.order.order_id)
    )
  );
}

function shuffledIndexes(indexes: number[]): number[] {
  const shuffled = [...indexes];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
  }
  return shuffled;
}

// จัดทีละใบ: เริ่มหนึ่งออเดอร์ แล้วลองเพื่อนที่ใกล้จุดส่งสุดท้ายก่อน
function buildGreedyJobs(
  orders: PlanningOrder[], settings: PlanningSettings, matrix: RoadMatrix, priority: number[],
): PlannedJob[] {
  const singleJobs = orders.map((_, index) => buildJob([index], orders, settings, matrix));
  const impossible = orders.filter((_, index) => !singleJobs[index]);
  if (impossible.length) {
    throw new PlanningError("บางออเดอร์ไม่มีเส้นทางหรือส่งไม่ทันกำหนด", 422,
      impossible.map(order => ({ order_id: order.order_id, reason: "หาเส้นทางที่ส่งทันกำหนดไม่ได้" })));
  }

  const remaining = [...priority];
  const jobs: PlannedJob[] = [];
  while (remaining.length > 0) {
    const first = remaining.shift()!;
    let group = [first];
    let currentJob = singleJobs[first]!;

    while (group.length < 3 && remaining.length > 0) {
      const last = group[group.length - 1]!;
      const nearby = [...remaining].sort((a, b) =>
        (matrix[last + 1]?.[a + 1] ?? Infinity) - (matrix[last + 1]?.[b + 1] ?? Infinity));

      let added = false;
      for (const next of nearby) {
        const separateCost = currentJob.delivery_cost + singleJobs[next]!.delivery_cost;
        let mergedJob: PlannedJob | null = null;
        let mergedSequence: number[] = [];

        // ลองแค่กลุ่มนี้ สูงสุด 3 ออเดอร์ / 6 ลำดับ ไม่สร้างทุกกลุ่มทั้งแผนล่วงหน้า
        for (const sequence of permutations([...group, next])) {
          const job = buildJob(sequence, orders, settings, matrix);
          if (!job || job.delivery_cost >= separateCost - 0.001) continue;
          if (!mergedJob || job.delivery_cost < mergedJob.delivery_cost - 0.001) {
            mergedJob = job;
            mergedSequence = sequence;
          }
        }
        if (!mergedJob) continue;

        currentJob = mergedJob;
        group = mergedSequence;
        remaining.splice(remaining.indexOf(next), 1);
        added = true;
        break;
      }
      // ไม่ฝืนรวมให้ครบ 3 ถ้าไม่มีออเดอร์ที่รวมแล้วคุ้มและส่งทัน
      if (!added) break;
    }
    jobs.push(currentJob);
  }
  return jobs;
}

export function createDeliveryPlan(
  orders: PlanningOrder[], settings: PlanningSettings, matrix: RoadMatrix, previousJobs?: PlannedJob[],
): DeliveryPlan {
  if (!orders.length || orders.length > 30) throw new PlanningError("จัดงานได้ครั้งละ 1–30 ออเดอร์");
  if (matrix.length !== orders.length + 1 || matrix.some(row => row.length !== matrix.length)) {
    throw new PlanningError("ตารางระยะทางไม่ตรงกับออเดอร์", 502);
  }
  validateServiceArea(orders, matrix);

  const indexes = orders.map((_, index) => index);
  // กดขอใหม่ได้เรื่อย ๆ แต่แต่ละคำขอลองไม่เกิน 10 ครั้ง เพื่อไม่วนไม่จบ
  const attempts = previousJobs ? 10 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const priority = previousJobs ? shuffledIndexes(indexes) : indexes;
    const jobs = buildGreedyJobs(orders, settings, matrix, priority);
    if (previousJobs && sameDeliveryJobs(jobs, previousJobs)) continue;

    jobs.sort((a, b) => a.stops[0]!.order.order_id - b.stops[0]!.order.order_id);
    const sum = (key: "total_boxes" | "total_distance_km" | "delivery_cost" | "revenue" | "food_cost" | "profit") =>
      round(jobs.reduce((total, job) => total + job[key], 0));
    return {
      settings, jobs,
      method: "Greedy: รวมออเดอร์ใกล้เคียงเมื่อคุ้มและส่งทัน ไม่รับประกันค่าส่งต่ำที่สุดทั้งแผน",
      summary: {
        total_orders: orders.length, total_boxes: sum("total_boxes"), riders: jobs.length,
        total_distance_km: sum("total_distance_km"), delivery_cost: sum("delivery_cost"),
        revenue: sum("revenue"), food_cost: sum("food_cost"), profit: sum("profit"),
      },
    };
  }
  throw new PlanningError("ไม่พบแผนที่ต่างจากแผนปัจจุบันในการลองครั้งนี้ ลองอีกครั้งหรือใช้แผนเดิม", 422);
}
