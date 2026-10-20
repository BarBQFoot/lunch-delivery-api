import { conn } from "../dbconnect";
import type { RowDataPacket } from "mysql2/promise";

// Adds nullable columns only. Existing job status CHECK constraints remain intact.
async function migrate() {
  const additions: Record<string, Record<string, string>> = {
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
}

migrate().catch(error => { console.error("Migration failed:", error.code ?? error.message); process.exitCode = 1; })
  .finally(() => conn.end());
