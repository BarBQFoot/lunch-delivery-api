-- เปลี่ยน: สำเนาที่อยู่และพิกัดจัดส่ง ณ ตอนสร้างออเดอร์
-- SQL นี้รันครั้งเดียว; ใช้ npm run db:migrate หากต้องการตรวจคอลัมน์และรันซ้ำได้
ALTER TABLE orders
  ADD COLUMN delivery_address TEXT NULL,
  ADD COLUMN delivery_latitude DECIMAL(10,7) NULL,
  ADD COLUMN delivery_longitude DECIMAL(10,7) NULL;

-- ออเดอร์เก่าเติมจากลูกค้าปัจจุบันเฉพาะช่องว่าง จึงไม่ทับสำเนาที่มีอยู่แล้ว
-- ไม่สามารถย้อนหาที่อยู่เดิมตอนสร้างออเดอร์ได้ หากลูกค้าเคยแก้ไขและไม่มีประวัติเก็บไว้
UPDATE orders o JOIN customers c ON c.customer_id = o.customer_id
SET o.delivery_address = COALESCE(o.delivery_address, c.address),
    o.delivery_latitude = COALESCE(o.delivery_latitude, c.latitude),
    o.delivery_longitude = COALESCE(o.delivery_longitude, c.longitude)
WHERE o.delivery_address IS NULL OR o.delivery_latitude IS NULL OR o.delivery_longitude IS NULL;
