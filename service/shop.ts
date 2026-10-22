import type { Coordinates } from "./osrm";

// พิกัดร้านเดียวกับ owner-layout และเงื่อนไข preview เริ่มต้นใน frontend
// ใช้ค่าฝั่ง server ตรวจสร้างออเดอร์ ไม่รับพิกัดร้านจาก request
export const SHOP_ORIGIN: Coordinates = {
  latitude: 16.246063,
  longitude: 103.252125,
};
