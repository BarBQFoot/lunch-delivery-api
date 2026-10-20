-- สำหรับฐานข้อมูลตาม CREATE.txt เดิม ให้รันครั้งเดียว
-- หรือใช้ npm run db:migrate ซึ่งตรวจคอลัมน์ก่อนเพิ่มและรันซ้ำได้
ALTER TABLE job_sheets
  ADD COLUMN planning_data JSON NULL,
  ADD COLUMN started_at DATETIME NULL,
  ADD COLUMN completed_at DATETIME NULL;

ALTER TABLE job_stops ADD COLUMN delivered_at DATETIME NULL;
