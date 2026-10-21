import { conn } from "../dbconnect";
import type { RowDataPacket } from "mysql2/promise";

// Adds nullable columns only. Existing job status CHECK constraints remain intact.
export async function migrate() {
  const additions: Record<string, Record<string, string>> = {
    // เปลี่ยน: เพิ่มสำเนาจุดส่งใน orders แบบ nullable เพื่อรองรับข้อมูลเดิมก่อน backfill
    orders: { delivery_address: "TEXT NULL", delivery_latitude: "DECIMAL(10,7) NULL", delivery_longitude: "DECIMAL(10,7) NULL" },
    job_sheets: { planning_data: "JSON NULL", started_at: "DATETIME NULL", completed_at: "DATETIME NULL" },
    job_stops: { delivered_at: "DATETIME NULL" },
  };
  for (const [table, fields] of Object.entries(additions)) {
    const [columns] = await conn.query<RowDataPacket[]>(`SHOW COLUMNS FROM ${table}`);
    const existing = new Set(columns.map(column => column.Field));
    const missing = Object.entries(fields).filter(([field]) => !existing.has(field));
    if (!missing.length) { console.log(`${table}: already up to date`); continue; }
    await conn.query(`ALTER TABLE ${table} ${missing.map(([field, type]) => `ADD COLUMN ${field} ${type}`).join(", ")}`);
    console.log(`${table}: added ${missing.map(([field]) => field).join(", ")}`);
  }
  // เปลี่ยน: เติมเฉพาะช่องว่างจากลูกค้าปัจจุบัน รันซ้ำแล้วไม่ทับจุดส่งที่เก็บไว้
  await conn.query(`UPDATE orders o JOIN customers c ON c.customer_id = o.customer_id
    SET o.delivery_address = COALESCE(o.delivery_address, c.address),
        o.delivery_latitude = COALESCE(o.delivery_latitude, c.latitude),
        o.delivery_longitude = COALESCE(o.delivery_longitude, c.longitude)
    WHERE o.delivery_address IS NULL OR o.delivery_latitude IS NULL OR o.delivery_longitude IS NULL`);
  console.log("orders: filled missing delivery locations");
}

// เปลี่ยน: แยกการเรียก CLI เพื่อให้ทดสอบ migration โดยไม่แตะฐานข้อมูลจริงได้
if (require.main === module) {
  migrate().catch(error => { console.error("Migration failed:", error.code ?? error.message); process.exitCode = 1; })
    .finally(() => conn.end());
}
