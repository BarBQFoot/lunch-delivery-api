// Run manually: node scripts/smoke-planning.cjs
// Exercises real MySQL + OSRM in one outer transaction; all inserts are rolled back.
require('ts-node/register');
const assert = require('node:assert/strict');
const request = require('supertest');
const { conn } = require('../dbconnect');
const { app } = require('../app');

async function main() {
  const db = await conn.getConnection();
  const originalQuery = conn.query;
  const originalGetConnection = conn.getConnection;
  try {
    await db.beginTransaction();
    conn.query = db.query.bind(db);
    conn.getConnection = async () => ({
      query: db.query.bind(db), beginTransaction: async () => {},
      commit: async () => {}, rollback: async () => {}, release: () => {},
    });
    const dates = await request(app).get('/job-sheets/dates');
    assert.equal(dates.status, 200, JSON.stringify(dates.body));
    const date = dates.body.find(item => Number(item.eligible_orders) > 0)?.delivery_date;
    assert.ok(date, 'Requires at least one unassigned ACTIVE order');
    const eligible = await request(app).get('/job-sheets/eligible-orders').query({ date });
    assert.equal(eligible.status, 200);
    const chosen = eligible.body.slice(0, 3);
    const first = chosen[0];
    // Use an existing destination as the origin for this technical smoke check.
    const settings = { delivery_date: date, origin: { latitude: Number(first.latitude), longitude: Number(first.longitude) } };
    const preview = await request(app).post('/job-sheets/preview').send({ settings, order_ids: chosen.map(order => order.order_id) });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.summary.total_orders, chosen.length);
    const confirmed = await request(app).post('/job-sheets/confirm').send({ preview_id: preview.body.preview_id });
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
    for (const issued of confirmed.body.jobs) {
      const path = '/job-sheets/by-code/' + issued.job_code;
      const opened = await request(app).get(path);
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      assert.ok(opened.body.settings);
      const points = [opened.body.settings.origin, ...opened.body.stops.map(stop => ({
        latitude: Number(stop.order.latitude), longitude: Number(stop.order.longitude),
      }))];
      const route = await request(app).post('/job-sheets/route').send({ points });
      assert.equal(route.status, 200, JSON.stringify(route.body));
      assert.equal(route.body.type, 'LineString');
      const started = await request(app).post(path + '/start');
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.ok(started.body.started_at);
      let completed;
      for (const stop of opened.body.stops) {
        completed = await request(app).post(path + '/stops/' + stop.stop_id + '/deliver');
        assert.equal(completed.status, 200, JSON.stringify(completed.body));
      }
      assert.ok(completed.body.completed_at);
      assert.ok(completed.body.stops.every(stop => stop.delivered_at));
    }
    const remaining = await request(app).get('/job-sheets/eligible-orders').query({ date });
    assert.ok(chosen.every(order => !remaining.body.some(row => row.order_id === order.order_id)));
    const issuedOrder = chosen[0];
    const locked = await request(app).put('/orders/' + issuedOrder.order_id).send({ quantity: 2 });
    assert.equal(locked.status, 409);
    const jobList = await request(app).get('/job-sheets').query({ date });
    assert.equal(jobList.status, 200, JSON.stringify(jobList.body));
    console.log(JSON.stringify({ result: 'PASS', date, orders: chosen.length, jobs: confirmed.body.jobs.length,
      flow: 'preview → confirm → open → start → deliver all → locked order', rollback: true }));
  } finally {
    conn.query = originalQuery;
    conn.getConnection = originalGetConnection;
    await db.rollback();
    db.release();
    await conn.end();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
