import type { Coordinates } from "../service/osrm";

export class PlanningError extends Error {
  constructor(message: string, public status = 400, public details: unknown = undefined) {
    super(message);
  }
}

// เปลี่ยน: address และ Coordinates ในแผนมาจากสำเนาจุดส่งของ orders
export interface PlanningOrder extends Coordinates {
  order_id: number;
  customer_id: number;
  delivery_date: string;
  quantity: number;
  unit_price: number;
  unit_cost: number;
  status: string;
  name: string;
  phone: string;
  address: string;
  latitude: number;
  longitude: number;
}

export interface PlanningSettings {
  delivery_date: string;
  departure_time: string;
  deadline_time: string;
  origin: Coordinates;
  speed_kmh: number;
  service_minutes: number;
  fixed_cost: number;
  cost_per_km_per_box: number;
  return_to_shop: boolean;
}

export interface PlannedStop {
  order: PlanningOrder;
  stop_sequence: number;
  distance_from_previous_km: number;
  estimated_arrival_at: string;
  estimated_departure_at: string;
}

export interface PlannedJob {
  stops: PlannedStop[];
  total_boxes: number;
  total_distance_km: number;
  total_duration_minutes: number;
  delivery_cost: number;
  revenue: number;
  food_cost: number;
  profit: number;
}

export interface DeliveryPlan {
  settings: PlanningSettings;
  jobs: PlannedJob[];
  summary: {
    total_orders: number;
    total_boxes: number;
    riders: number;
    total_distance_km: number;
    delivery_cost: number;
    revenue: number;
    food_cost: number;
    profit: number;
  };
  method: string;
}

export interface StoredPlanningData {
  settings: PlanningSettings;
  job: PlannedJob;
}

export function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function localDateTime(date: string, time: string): string {
  return `${date} ${time}:00`;
}

export function bangkokTime(milliseconds: number): string {
  return new Date(milliseconds + 7 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export function timestamp(value: string): number {
  return Date.parse(value.replace(" ", "T") + "+07:00");
}

export const round = (value: number, digits = 2) => Number(value.toFixed(digits));
