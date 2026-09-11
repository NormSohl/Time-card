// Full-stack tests against the real Express app + a throwaway SQLite file
// per run (set via DB_PATH below, before server.js/db.js are required).
// Run with `npm test` (node's built-in test runner + supertest).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_PATH = path.join(os.tmpdir(), `timecard-test-${process.pid}-${Date.now()}.db`);
process.env.TIMECARD_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DB_PATH = DB_PATH;

const request = require('supertest');
const app = require('../server');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
});

// Logged-in agent shared across tests in a suite — persists the session
// cookie the way a real browser would.
async function loginAgent() {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ password: 'test-password' });
  return agent;
}

test('unauthenticated requests are rejected', async () => {
  await request(app).get('/api/entries').expect(401);
  const res = await request(app).get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('wrong password does not authenticate', async () => {
  const agent = request.agent(app);
  const res = await agent.post('/login').type('form').send({ password: 'nope' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login?error=1');
  await agent.get('/api/entries').expect(401);
});

test('clock-in / clock-out lifecycle', async () => {
  const agent = await loginAgent();

  let status = await agent.get('/api/status').expect(200);
  assert.equal(status.body.open, null);

  // placeholder "xx" mileage is rejected
  await agent.post('/api/clock-in').send({ mileage_start: '42xx' }).expect(400);
  // negative mileage is rejected
  await agent.post('/api/clock-in').send({ mileage_start: '-5' }).expect(400);

  const clockIn = await agent
    .post('/api/clock-in')
    .send({ mileage_start: '100', note: 'shift 1' })
    .expect(200);
  const entryId = clockIn.body.id;

  // can't clock in twice
  await agent.post('/api/clock-in').send({}).expect(409);

  status = await agent.get('/api/status').expect(200);
  assert.equal(status.body.open.id, entryId);
  assert.equal(status.body.open.mileage_start, 100);

  await agent.post('/api/clock-out').send({ mileage_end: '90' }).expect(200); // would leave mileage_end<start but not checked at clock-out
  // (clock-out doesn't cross-check against mileage_start, only raw/edit do)

  status = await agent.get('/api/status').expect(200);
  assert.equal(status.body.open, null);

  const entries = await agent.get('/api/entries').expect(200);
  const entry = entries.body.find((e) => e.id === entryId);
  assert.equal(entry.mileage_end, 90);
  assert.equal(entry.note, 'shift 1');
});

test('clock-out with no open entry is rejected', async () => {
  const agent = await loginAgent();
  await agent.post('/api/clock-out').send({}).expect(409);
});

test('raw entry validation and creation', async () => {
  const agent = await loginAgent();

  await agent.post('/api/entries/raw').send({ end_time: '2026-01-02T00:00:00Z' }).expect(400);
  await agent
    .post('/api/entries/raw')
    .send({ start_time: '2026-01-02T00:00:00Z', end_time: '2026-01-01T00:00:00Z' })
    .expect(400);
  await agent
    .post('/api/entries/raw')
    .send({
      start_time: '2026-01-01T09:00:00Z',
      end_time: '2026-01-01T17:00:00Z',
      mileage_start: '10',
      mileage_end: '5',
    })
    .expect(400); // mileage_end < mileage_start

  const res = await agent
    .post('/api/entries/raw')
    .send({
      start_time: '2026-01-01T09:00:00Z',
      end_time: '2026-01-01T17:00:00Z',
      mileage_start: '10',
      mileage_end: '20',
      note: 'backfilled',
    })
    .expect(200);
  assert.ok(res.body.id);
});

test('entry get/edit/delete by id', async () => {
  const agent = await loginAgent();
  const created = await agent
    .post('/api/entries/raw')
    .send({ start_time: '2026-02-01T09:00:00Z', end_time: '2026-02-01T10:00:00Z' })
    .expect(200);
  const id = created.body.id;

  await agent.get(`/api/entries/${id}`).expect(200);
  await agent.get('/api/entries/999999').expect(404);

  await agent
    .put(`/api/entries/${id}`)
    .send({ start_time: '2026-02-01T09:00:00Z', end_time: '2026-02-01T11:00:00Z', note: 'edited' })
    .expect(200);
  const fetched = await agent.get(`/api/entries/${id}`).expect(200);
  assert.equal(fetched.body.note, 'edited');

  await agent.delete(`/api/entries/${id}`).expect(200);
  await agent.get(`/api/entries/${id}`).expect(404);
});

test('expense validation, CRUD, and the export.csv route-ordering fix', async () => {
  const agent = await loginAgent();

  await agent.post('/api/expenses').send({ date: '2026-03-01', category: 'taxi', amount: '5' }).expect(400);
  await agent.post('/api/expenses').send({ date: '2026-03-01', category: 'toll', amount: '-1' }).expect(400);
  await agent.post('/api/expenses').send({ date: '2026-03-01', category: 'toll', amount: '0' }).expect(400);

  const created = await agent
    .post('/api/expenses')
    .send({ date: '2026-03-01', category: 'parking', amount: '12.50', note: 'garage' })
    .expect(200);
  const id = created.body.id;

  // regression test: /api/expenses/export.csv must not be swallowed by
  // the /api/expenses/:id route (it was, briefly, before route reordering)
  const csv = await agent.get('/api/expenses/export.csv').expect(200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /id,date,category,amount,description/);

  await agent.get(`/api/expenses/${id}`).expect(200);
  await agent.get('/api/expenses/999999').expect(404);

  await agent
    .put(`/api/expenses/${id}`)
    .send({ date: '2026-03-01', category: 'parking', amount: '15.00', note: 'garage (corrected)' })
    .expect(200);
  const fetched = await agent.get(`/api/expenses/${id}`).expect(200);
  assert.equal(fetched.body.amount, 15);

  await agent.delete(`/api/expenses/${id}`).expect(200);
  await agent.get(`/api/expenses/${id}`).expect(404);
});

test('billing: preview, generate, lock, unbill, and cycle chaining', async () => {
  const agent = await loginAgent();

  // First outstanding entry — this is the only billing-relevant data
  // this suite has created so far in a fresh DB (test isolation is
  // per-process, not per-test, so order matters a little here; this
  // test creates its own clearly-dated data to stay independent of
  // exactly what earlier tests left behind).
  const entry = await agent
    .post('/api/entries/raw')
    .send({ start_time: '2026-08-25T13:00:00Z', end_time: '2026-08-25T17:00:00Z', note: 'billing test shift' })
    .expect(200);
  const expense = await agent
    .post('/api/expenses')
    .send({ date: '2026-08-26', category: 'toll', amount: '4.50' })
    .expect(200);

  // Draft preview must not mutate anything
  const draft = await agent
    .get('/api/billing/preview')
    .query({ cycle_start: '2026-08-24', cycle_end: '2026-09-05', format: 'text' })
    .expect(200);
  assert.match(draft.headers['content-type'], /text\/plain/);
  assert.match(draft.text, /DRAFT/);

  const stillUnbilled = await agent.get(`/api/entries/${entry.body.id}`).expect(200);
  assert.equal(stillUnbilled.body.billing_id, null);

  // Generate for real
  const gen = await agent
    .post('/api/billing/generate')
    .send({ cycle_start: '2026-08-24', cycle_end: '2026-09-05' })
    .expect(200);
  assert.equal(gen.body.entry_count >= 1, true);
  assert.match(gen.body.content, /TOTAL HOURS/);

  // Generating again for the same (now-empty) range fails
  await agent
    .post('/api/billing/generate')
    .send({ cycle_start: '2026-08-24', cycle_end: '2026-09-05' })
    .expect(400);

  // Included items are now locked
  await agent
    .put(`/api/entries/${entry.body.id}`)
    .send({ start_time: '2026-08-25T13:00:00Z', end_time: '2026-08-25T18:00:00Z' })
    .expect(409);
  await agent.delete(`/api/entries/${entry.body.id}`).expect(409);
  await agent
    .put(`/api/expenses/${expense.body.id}`)
    .send({ date: '2026-08-26', category: 'toll', amount: '9.99' })
    .expect(409);
  await agent.delete(`/api/expenses/${expense.body.id}`).expect(409);

  // Cycle chaining: next suggestion is exactly 14 days after, regardless
  // of "today" (the bug this regression test guards against: it used to
  // stay pinned to "most recent past Saturday", which could be *before*
  // the new cycle's start once one bill existed).
  const nextPreview = await agent.get('/api/billing/preview').expect(200);
  assert.equal(nextPreview.body.cycle_start, '2026-09-06');
  assert.equal(nextPreview.body.cycle_end, '2026-09-19');

  // History and view/download
  const history = await agent.get('/api/billing/history').expect(200);
  const billingId = history.body[0].id;
  await agent.get(`/api/billing/${billingId}`).expect(200);
  const download = await agent.get(`/api/billing/${billingId}/download`).expect(200);
  assert.match(download.headers['content-type'], /text\/plain/);
  assert.match(download.headers['content-disposition'], /attachment/);

  // Unbill: undoes the lock and removes the record
  await agent.delete(`/api/billing/${billingId}`).expect(200);
  await agent.delete('/api/billing/999999').expect(404);

  const unlockedEntry = await agent.get(`/api/entries/${entry.body.id}`).expect(200);
  assert.equal(unlockedEntry.body.billing_id, null);
  await agent.delete(`/api/entries/${entry.body.id}`).expect(200); // now deletable again

  const historyAfter = await agent.get('/api/billing/history').expect(200);
  assert.equal(historyAfter.body.find((b) => b.id === billingId), undefined);
});
