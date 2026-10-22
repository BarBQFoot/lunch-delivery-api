import express from "express";
import { conn } from "../dbconnect";
import { Order } from "../model/order";
import { Customer } from "../model/customer";
import mysql from "mysql2"; // ใช้สำหรับการฟอร์แมตคำสั่ง SQL แบบปลอดภัย
import { getRoadDistances, OsrmError, parseCoordinate } from "../service/osrm";
import { SHOP_ORIGIN } from "../service/shop";
import { SERVICE_AREA_KM } from "../service/delivery-planning";

export const router = express.Router();

// เปลี่ยน: อ่านจุดส่งจากสำเนาในออเดอร์ แต่คงชื่อฟิลด์เดิมให้ UI ใช้ต่อได้
const ORDER_LOCATION_FIELDS = `orders.delivery_address AS address,
  orders.delivery_latitude AS latitude, orders.delivery_longitude AS longitude`;
const ORDER_CUSTOMER_FIELDS = `orders.*, customers.name, customers.phone, ${ORDER_LOCATION_FIELDS}`;

router.get("/", async (req, res) => {
  const [rows] = await conn.query(
    `SELECT orders.*, ${ORDER_LOCATION_FIELDS} FROM orders ORDER BY orders.order_id ASC`,
  );
  res.json(rows);
});

router.get("/with-customers", async (req, res) => {
  const [rows] = await conn.query(
    `SELECT ${ORDER_CUSTOMER_FIELDS} FROM orders
     JOIN customers ON orders.customer_id = customers.customer_id ORDER BY orders.order_id ASC`,
  );
  res.json(rows);
});

router.get("/with-customers/search", async (req, res) => {
  const { keyword } = req.query;

  if (!keyword || typeof keyword !== "string") {
    return res.status(400).json({
      error: "keyword จำเป็นต้องระบุและต้องเป็น string",
    });
  }

  const [rows] = await conn.query(
    `
    SELECT ${ORDER_CUSTOMER_FIELDS}
    FROM orders
    JOIN customers
      ON orders.customer_id = customers.customer_id
    WHERE customers.name LIKE ?
       OR CAST(customers.customer_id AS CHAR) LIKE ?
    ORDER BY orders.order_id ASC
    `,
    [`%${keyword}%`, `%${keyword}%`],
  );
  res.json(rows);
});

router.get("/nearby", async (req, res) => {
  const latitude = parseCoordinate(req.query.lat, 90);
  const longitude = parseCoordinate(req.query.lng, 180);

  if (latitude === null || longitude === null) {
    return res.status(400).json({
      error: "lat และ lng ต้องเป็นพิกัดที่ถูกต้อง",
    });
  }

  try {
    const [rows] = await conn.query(`
      SELECT ${ORDER_CUSTOMER_FIELDS}
      FROM orders
      JOIN customers ON orders.customer_id = customers.customer_id
      ORDER BY orders.order_id ASC
    `);
    type OrderWithLocation = Order & {
      name: string;
      phone: string;
      address: string;
      latitude: number | string | null;
      longitude: number | string | null;
    };
    const candidates = (rows as OrderWithLocation[]).flatMap((order) => {
      const lat = parseCoordinate(order.latitude, 90);
      const lng = parseCoordinate(order.longitude, 180);
      return lat === null || lng === null
        ? []
        : [{ order, coordinates: { latitude: lat, longitude: lng } }];
    });

    const distances = await getRoadDistances(
      { latitude, longitude },
      candidates.map((candidate) => candidate.coordinates),
    );
    const nearby = candidates.flatMap(({ order }, index) => {
      const distance = distances[index];
      return distance != null && distance <= 3
        ? [{ ...order, distance_km: distance }]
        : [];
    });
    nearby.sort((first, second) => first.distance_km - second.distance_km);
    return res.json(nearby);
  } catch (error) {
    console.error(error);
    if (error instanceof OsrmError) {
      return res.status(502).json({ error: "ไม่สามารถคำนวณระยะทางจาก OSRM ได้ กรุณาลองใหม่" });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/simulated", async (req, res) => {
  try {
    const [customers] = await conn.query("SELECT * FROM customers");
    // เปลี่ยน: ตรวจพิกัดและขอระยะตามถนนก่อนสุ่ม ไม่สุ่มลูกค้านอกพื้นที่บริการ
    const candidates = (customers as Customer[]).flatMap((customer) => {
      const latitude = parseCoordinate(customer.latitude, 90);
      const longitude = parseCoordinate(customer.longitude, 180);
      return latitude === null || longitude === null
        ? []
        : [{ customer, coordinates: { latitude, longitude } }];
    });
    const distances = await getRoadDistances(
      SHOP_ORIGIN, candidates.map((candidate) => candidate.coordinates),
    );
    const customersList = candidates.flatMap(({ customer }, index) => {
      const distance = distances[index];
      return distance != null && distance <= SERVICE_AREA_KM ? [customer] : [];
    });
    if (!customersList.length) {
      return res.status(422).json({
        error: `ไม่มีลูกค้าที่มีพิกัดและเส้นทางตามถนนจากร้านไม่เกิน ${SERVICE_AREA_KM} กม. สำหรับจำลองออเดอร์`,
      });
    }

    const orders = [];
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Bangkok",
    });
    const counter = Math.floor(Math.random() * 11) + 20;
    // สุ่มจำนวนคำสั่งซื้อ 20 - 30

    for (let i = 1; i <= counter; i++) {
      const randomCustomer =
        customersList[Math.floor(Math.random() * customersList.length)];

      if (!randomCustomer) {
        throw new Error("ไม่พบข้อมูลลูกค้า");
      }

      orders.push([
        randomCustomer.customer_id,
        today,
        Math.floor(Math.random() * 3) + 1,
        65,
        40,
        true,
        "ACTIVE",
        // เปลี่ยน: ออเดอร์จำลองเก็บที่อยู่และพิกัดขณะสร้างชุดข้อมูลด้วย
        randomCustomer.address,
        randomCustomer.latitude,
        randomCustomer.longitude,
      ]);
    }

    const [result] = await conn.query(
      `
      INSERT INTO orders
      (
        customer_id,
        delivery_date,
        quantity,
        unit_price,
        unit_cost,
        is_simulated,
        status,
        delivery_address,
        delivery_latitude,
        delivery_longitude
      )
      VALUES ?
      `,
      [orders],
    );

    const insertResult = result as any;
    res.status(201).json({
      affected_row: insertResult.affectedRows, // จำนวนแถวที่ได้รับผลกระทบ (สำเร็จ = 1)
      last_idx: insertResult.insertId, // รหัสไอดีล่าสุดที่ระบบสร้างขึ้นให้อัตโนมัติ (Auto increment id)
    });
  } catch (error) {
    console.error(error);
    if (error instanceof OsrmError) {
      return res.status(502).json({ error: "ไม่สามารถคำนวณระยะทางจาก OSRM ได้ กรุณาลองใหม่" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const order: Order | undefined = req.body;

    if (
      !order || !Number.isInteger(order.quantity) ||
      order.quantity < 1 ||
      order.quantity > 3
    ) {
      return res.status(400).json({
        message: "1 order ต้องมีอย่างน้อย 1 กล่อง และสามารถมีได้ไม่เกิน 3 กล่อง",
      });
    }

    if (!Number.isInteger(order.customer_id) || order.customer_id < 1) {
      return res.status(400).json({ error: "customer_id ต้องเป็นจำนวนเต็มบวก" });
    }

    // เปลี่ยน: ใช้พิกัดลูกค้าในฐานข้อมูลตรวจระยะตามถนนก่อนสร้างออเดอร์
    const [customers] = await conn.query(
      "SELECT customer_id, address, latitude, longitude FROM customers WHERE customer_id = ?",
      [order.customer_id],
    );
    const customer = (customers as Customer[])[0];
    if (!customer) {
      return res.status(404).json({ error: "ไม่พบลูกค้าสำหรับสร้างออเดอร์" });
    }
    const latitude = parseCoordinate(customer.latitude, 90);
    const longitude = parseCoordinate(customer.longitude, 180);
    if (latitude === null || longitude === null) {
      return res.status(422).json({ error: "พิกัดลูกค้าไม่ถูกต้อง กรุณาแก้ไขก่อนสร้างออเดอร์" });
    }

    const [distance] = await getRoadDistances(SHOP_ORIGIN, [{ latitude, longitude }]);
    if (distance == null) {
      return res.status(422).json({ error: "ไม่พบเส้นทางตามถนนจากร้านถึงลูกค้า" });
    }
    if (distance > SERVICE_AREA_KM) {
      return res.status(422).json({
        error: `ลูกค้าอยู่นอกพื้นที่บริการ ${SERVICE_AREA_KM} กม. ตามถนนจากร้าน`,
        distance_km: distance,
      });
    }

    // เปลี่ยน: INSERT เฉพาะเมื่อจุดส่งยังตรงกับที่ผ่านการตรวจระยะทาง
    // ถ้าลูกค้าถูกแก้พิกัดระหว่างรอ OSRM จะไม่บันทึกพิกัดใหม่ที่ยังไม่ได้ตรวจ
    const sql = `INSERT INTO orders
      (customer_id, delivery_date, quantity, unit_price, unit_cost, is_simulated, status,
       delivery_address, delivery_latitude, delivery_longitude)
      SELECT customer_id, ?, ?, ?, ?, ?, ?, address, latitude, longitude
      FROM customers WHERE customer_id = ?
        AND latitude <=> ? AND longitude <=> ? AND address <=> ?`;
    const [result] = await conn.query(sql, [
      order.delivery_date,
      order.quantity,
      order.unit_price,
      order.unit_cost,
      order.is_simulated,
      order.status,
      order.customer_id,
      customer.latitude,
      customer.longitude,
      customer.address,
    ]);

    const insertResult = result as any;
    if (insertResult.affectedRows === 0) {
      const [remaining] = await conn.query(
        "SELECT customer_id FROM customers WHERE customer_id = ?", [order.customer_id],
      );
      if (!(remaining as Customer[]).length) {
        return res.status(404).json({ error: "ไม่พบลูกค้าสำหรับสร้างออเดอร์" });
      }
      return res.status(409).json({ error: "ข้อมูลลูกค้าเปลี่ยนระหว่างตรวจระยะทาง กรุณาลองสร้างออเดอร์อีกครั้ง" });
    }
    res.status(201).json({
      affected_row: insertResult.affectedRows, // จำนวนแถวที่ได้รับผลกระทบ (สำเร็จ = 1)
      last_idx: insertResult.insertId, // รหัสไอดีล่าสุดที่ระบบสร้างขึ้นให้อัตโนมัติ (Auto increment id)
    });
  } catch (error) {
    console.error(error);
    if (error instanceof OsrmError) {
      return res.status(502).json({ error: "ไม่สามารถคำนวณระยะทางจาก OSRM ได้ กรุณาลองใหม่" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    let id = req.params.id;
    const [result] = await conn.query("DELETE FROM orders WHERE order_id = ? AND NOT EXISTS (SELECT 1 FROM job_stops s WHERE s.order_id = orders.order_id)", [
      id,
    ]);
    const deleteResult = result as any;

    if (deleteResult.affectedRows === 0) {
      const [assigned] = await conn.query("SELECT order_id FROM job_stops WHERE order_id = ?", [id]);
      if ((assigned as unknown[]).length) return res.status(409).json({ error: "ออเดอร์นี้มีใบงานแล้ว ไม่สามารถลบได้" });
      return res.status(404).json({ error: "Order not found" });
    }

    res.status(200).json({ affected_row: deleteResult.affectedRows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/", async (req, res) => {
  try {
    const [result] = await conn.query(
      "DELETE FROM orders WHERE is_simulated = true AND NOT EXISTS (SELECT 1 FROM job_stops s WHERE s.order_id = orders.order_id)",
    );
    const deleteResult = result as any;

    if (deleteResult.affectedRows === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.status(200).json({ affected_row: deleteResult.affectedRows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const quantity = Number(req.body.quantity);

    if (
      !Number.isInteger(id) ||
      id < 1 ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 3
    ) {
      return res.status(400).json({
        message: "order id ต้องถูกต้อง และจำนวนกล่องต้องเป็นจำนวนเต็มระหว่าง 1 ถึง 3",
      });
    }

    const [result] = await conn.query(
      "UPDATE orders SET quantity = ? WHERE order_id = ? AND NOT EXISTS (SELECT 1 FROM job_stops s WHERE s.order_id = orders.order_id)",
      [quantity, id],
    );
    const updateResult = result as any;

    if (updateResult.affectedRows === 0) {
      const [assigned] = await conn.query("SELECT order_id FROM job_stops WHERE order_id = ?", [id]);
      if ((assigned as unknown[]).length) return res.status(409).json({ error: "ออเดอร์นี้มีใบงานแล้ว ไม่สามารถแก้จำนวนกล่องได้" });
      return res.status(404).json({ error: "Order not found" });
    }
    res.status(200).json({ affected_row: updateResult.affectedRows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});
