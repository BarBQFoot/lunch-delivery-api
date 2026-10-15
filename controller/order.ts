import express from "express";
import { conn } from "../dbconnect";
import { Order } from "../model/order";
import { Customer } from "../model/customer";
import mysql from "mysql2"; // ใช้สำหรับการฟอร์แมตคำสั่ง SQL แบบปลอดภัย

export const router = express.Router();

router.get("/", async (req, res) => {
  const [rows] = await conn.query("SELECT * FROM `orders`");
  res.json(rows);
});

router.get("/with-customers", async (req, res) => {
  const [rows] = await conn.query(
    "SELECT * FROM `orders`, `customers` WHERE `orders`.`customer_id` = `customers`.`customer_id`",
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
    SELECT *
    FROM orders
    JOIN customers
      ON orders.customer_id = customers.customer_id
    WHERE customers.name LIKE ?
       OR CAST(customers.customer_id AS CHAR) LIKE ?
    `,
    [`%${keyword}%`, `%${keyword}%`],
  );
  res.json(rows);
});

router.get("/nearby", async (req, res) => {
  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({
      error: "lat และ lng จำเป็นต้องระบุ",
    });
  }

  const [rows] = await conn.query(
    `
    SELECT
      orders.*,
      customers.name,
      customers.phone,
      customers.address,
      customers.latitude,
      customers.longitude,

      (
        6371 * ACOS(
          COS(RADIANS(?))
          * COS(RADIANS(customers.latitude))
          * COS(RADIANS(customers.longitude) - RADIANS(?))
          + SIN(RADIANS(?))
          * SIN(RADIANS(customers.latitude))
        )
      ) AS distance_km

    FROM orders
    JOIN customers
      ON orders.customer_id = customers.customer_id

    HAVING distance_km <= 2
    ORDER BY distance_km ASC
    `,
    [lat, lng, lat],
  );

  res.json(rows);
});

router.post("/simulated", async (req, res) => {
  try {
    const [customers] = await conn.query("SELECT * FROM customers");
    let customersList = customers as Customer[];

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
        status
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
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    let order: Order = req.body;
    console.log(req.body);

    if (
      !Number.isInteger(order.quantity) ||
      order.quantity < 1 ||
      order.quantity > 3
    ) {
      return res.status(400).json({
        message: "1 order ต้องมีอย่างน้อย 1 กล่อง และสามารถมีได้ไม่เกิน 3 กล่อง",
      });
    }

    let sql =
      "INSERT INTO `orders`(`customer_id`, `delivery_date`, `quantity`, `unit_price`, `unit_cost`, `is_simulated`, `status`) VALUES (?,?,?,?,?,?,?)";
    const [result] = await conn.query(sql, [
      order.customer_id,
      order.delivery_date,
      order.quantity,
      order.unit_price,
      order.unit_cost,
      order.is_simulated,
      order.status,
    ]);

    const insertResult = result as any;
    res.status(201).json({
      affected_row: insertResult.affectedRows, // จำนวนแถวที่ได้รับผลกระทบ (สำเร็จ = 1)
      last_idx: insertResult.insertId, // รหัสไอดีล่าสุดที่ระบบสร้างขึ้นให้อัตโนมัติ (Auto increment id)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    let id = req.params.id;
    const [result] = await conn.query("DELETE FROM orders WHERE order_id = ?", [
      id,
    ]);
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

router.delete("/", async (req, res) => {
  try {
    const [result] = await conn.query(
      "DELETE FROM orders WHERE is_simulated = true",
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
    let id = req.params.id;

    const [resultCheck] = await conn.query(
      "SELECT * FROM orders WHERE order_id = ?",
      [id],
    );
    const existingOrder = resultCheck as any;

    if(existingOrder.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    let order: Order = req.body;

    if (
      !Number.isInteger(order.quantity) ||
      order.quantity < 1 ||
      order.quantity > 3
    ) {
      return res.status(400).json({
        message: "1 order ต้องมีอย่างน้อย 1 กล่อง และสามารถมีได้ไม่เกิน 3 กล่อง",
      });
    }

    let sql =
      "UPDATE `orders` SET `customer_id`=?, `delivery_date`=?, `quantity`=?, `unit_price`=?, `unit_cost`=?, `is_simulated`=?, `status`=? WHERE `order_id`=?";
    const [result] = await conn.query(sql, [
      order.customer_id,
      order.delivery_date,
      order.quantity,
      order.unit_price,
      order.unit_cost,
      order.is_simulated,
      order.status,
      id,
    ]);
    const updateResult = result as any;

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.status(200).json({ affected_row: updateResult.affectedRows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});
