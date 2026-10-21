// เปลี่ยน: ตรวจพิกัดออเดอร์กับ MySQL จริงใน transaction เดียว และ rollback ข้อมูลทดสอบทั้งหมด
// Run after npm run db:migrate: node scripts/smoke-order-location.cjs
require('ts-node/register');
const assert = require('node:assert/strict');
const request = require('supertest');
const { conn } = require('../dbconnect');
const { app } = require('../app');
const { selectedOrders, rememberPreview } = require('../service/job-store');
const { createDeliveryPlan } = require('../service/delivery-planning');
const { readSettings } = require('../service/planning-input');
const { migrate } = require('./migrate');

async function main() {
  const db = await conn.getConnection();
  const originalQuery = conn.query;
  const originalGetConnection = conn.getConnection;
  try {
    await db.beginTransaction();
    conn.query = db.query.bind(db);
    conn.getConnection = async () => ({ query: db.query.bind(db),
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} });

    const name = `OrderLocationSmoke-${Date.now()}`;
    const oldLocation = { address: 'Original location', latitude: 16.25, longitude: 103.25 };
    const newLocation = { address: 'Updated location', latitude: 16.26, longitude: 103.26 };
    const [customer] = await db.query(`INSERT INTO customers (name, phone, address, latitude, longitude)
      VALUES (?, '000', ?, ?, ?)`, [name, oldLocation.address, oldLocation.latitude, oldLocation.longitude]);
    const input = { customer_id: customer.insertId, delivery_date: '2099-10-21', quantity: 1,
      unit_price: 65, unit_cost: 40, is_simulated: 0, status: 'ACTIVE' };
    const first = await request(app).post('/orders').send({ ...input, delivery_latitude: 0, delivery_longitude: 0 });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const firstId = first.body.last_idx;
    const settings = readSettings({ delivery_date: input.delivery_date, origin: oldLocation });
    const before = await selectedOrders([firstId], input.delivery_date);
    assert.equal(before[0].latitude, oldLocation.latitude);
    const preview = rememberPreview(createDeliveryPlan(before, settings, [[0, 0], [0, 0]]), before);

    await db.query('UPDATE customers SET address = ?, latitude = ?, longitude = ? WHERE customer_id = ?',
      [newLocation.address, newLocation.latitude, newLocation.longitude, customer.insertId]);
    // เปลี่ยน: รัน migration ซ้ำหลังย้ายลูกค้า ต้องไม่เขียนทับสำเนาของออเดอร์เดิม
    await migrate();
    const second = await request(app).post('/orders').send(input);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const secondId = second.body.last_idx;

    const after = await selectedOrders([firstId, secondId], input.delivery_date);
    assert.equal(after.find(order => order.order_id === firstId).address, oldLocation.address);
    assert.equal(after.find(order => order.order_id === firstId).latitude, oldLocation.latitude);
    assert.equal(after.find(order => order.order_id === firstId).longitude, oldLocation.longitude);
    assert.equal(after.find(order => order.order_id === secondId).address, newLocation.address);
    assert.equal(after.find(order => order.order_id === secondId).latitude, newLocation.latitude);
    assert.equal(after.find(order => order.order_id === secondId).longitude, newLocation.longitude);
    const listed = await request(app).get('/orders/with-customers/search').query({ keyword: name });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.find(order => order.order_id === firstId).address, oldLocation.address);

    // เปลี่ยนพิกัดลูกค้าหลัง preview ต้องไม่ทำให้จุดส่งของออเดอร์เดิมเปลี่ยนหรือยืนยันไม่ได้
    const confirmed = await request(app).post('/job-sheets/confirm').send({ preview_id: preview.preview_id });
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
    const opened = await request(app).get('/job-sheets/by-code/' + confirmed.body.jobs[0].job_code);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.stops[0].order.address, oldLocation.address);
    assert.equal(opened.body.stops[0].order.latitude, oldLocation.latitude);
    console.log(JSON.stringify({ result: 'PASS',
      checks: ['old order unchanged', 'new order uses updated location', 'client coordinates ignored',
        'repeated migration preserves location', 'list and planning use order location',
        'confirm and open job preserve location'], rollback: true }));
  } finally {
    conn.query = originalQuery;
    conn.getConnection = originalGetConnection;
    await db.rollback();
    db.release();
    await conn.end();
  }
}
main().catch(error => { console.error('Order location smoke failed:', error.code ?? error.message); process.exitCode = 1; });
