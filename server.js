const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
const db = require('./db');

const PORT = process.env.PORT || 80;
const PASSWORD = process.env.TIMECARD_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!PASSWORD || !SESSION_SECRET) {
  console.error('TIMECARD_PASSWORD and SESSION_SECRET must both be set.');
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
  cookieSession({
    name: 'timecard_session',
    keys: [SESSION_SECRET],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  })
);

// Parses an optional mileage field. Returns { value } on success (value is
// null if the field was omitted/empty) or { error } if it's a placeholder,
// not a number, or negative.
function parseMileage(raw) {
  if (raw === undefined || raw === '') return { value: null };
  if (/x/i.test(raw)) return { error: 'still has placeholder x characters' };
  const n = Number(raw);
  if (Number.isNaN(n)) return { error: 'is not a valid number' };
  if (n < 0) return { error: 'cannot be negative' };
  return { value: n };
}

const EXPENSE_CATEGORIES = ['toll', 'parking', 'bus', 'other'];

// Validates a required expense amount. Returns { value } on success or
// { error } if missing, not a number, or not positive.
function parseAmount(raw) {
  if (raw === undefined || raw === '') return { error: 'is required' };
  const n = Number(raw);
  if (Number.isNaN(n)) return { error: 'is not a valid number' };
  if (n <= 0) return { error: 'must be greater than zero' };
  return { value: n };
}

// ---- Billing helpers ----
// Billing cycles are 14-day windows ending on a Saturday. Each cycle's
// start is the day after the previous billing's end, so cycles chain
// automatically once the first one is generated.

function toDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

function mostRecentSaturday(d) {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day - 6 + 7) % 7;
  const result = new Date(d);
  result.setUTCDate(result.getUTCDate() - diff);
  return result;
}

function addDays(dateOnly, n) {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toDateOnly(d);
}

function isDateOnly(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime());
}

// Suggests the next cycle's start/end: end is the most recent Saturday,
// start continues from the last billing (or the earliest outstanding
// item, if this is the very first bill).
function suggestBillingRange() {
  const lastBilling = db.prepare('SELECT cycle_end FROM billings ORDER BY cycle_end DESC LIMIT 1').get();
  if (lastBilling) {
    // Cycles are always 14 days, so the next one ends exactly 14 days
    // after the last — that's guaranteed to land on a Saturday too.
    // (Not clamped to "today": if the next cycle hasn't finished yet,
    // the suggestion still shows the upcoming boundary; generating
    // early just yields whatever's outstanding so far.)
    return { cycle_start: addDays(lastBilling.cycle_end, 1), cycle_end: addDays(lastBilling.cycle_end, 14) };
  }
  const suggestedEnd = toDateOnly(mostRecentSaturday(new Date()));
  const earliestEntry = db
    .prepare("SELECT MIN(substr(clock_out, 1, 10)) AS d FROM entries WHERE clock_out IS NOT NULL AND billing_id IS NULL")
    .get().d;
  const earliestExpense = db.prepare('SELECT MIN(substr(date, 1, 10)) AS d FROM expenses WHERE billing_id IS NULL').get().d;
  const candidates = [earliestEntry, earliestExpense].filter(Boolean);
  const cycle_start = candidates.length ? candidates.sort()[0] : addDays(suggestedEnd, -13);
  return { cycle_start, cycle_end: suggestedEnd };
}

function gatherBillableItems(cycleStart, cycleEnd) {
  const entries = db
    .prepare(
      `SELECT * FROM entries
       WHERE clock_out IS NOT NULL AND billing_id IS NULL
         AND substr(clock_out, 1, 10) >= ? AND substr(clock_out, 1, 10) <= ?
       ORDER BY clock_in ASC`
    )
    .all(cycleStart, cycleEnd);
  const expenses = db
    .prepare(
      `SELECT * FROM expenses
       WHERE billing_id IS NULL
         AND substr(date, 1, 10) >= ? AND substr(date, 1, 10) <= ?
       ORDER BY date ASC`
    )
    .all(cycleStart, cycleEnd);
  return { entries, expenses };
}

function formatHoursMinutes(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function computeTotals(entries, expenses) {
  let totalMs = 0;
  let totalMileage = 0;
  for (const e of entries) {
    totalMs += new Date(e.clock_out) - new Date(e.clock_in);
    if (e.mileage_start != null && e.mileage_end != null) totalMileage += e.mileage_end - e.mileage_start;
  }
  const totalExpense = expenses.reduce((sum, x) => sum + x.amount, 0);
  return { totalMs, totalMileage, totalExpense };
}

function padRight(s, len) {
  s = String(s);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}
function fmtMoney(n) {
  return '$' + n.toFixed(2);
}
function fmtTime(iso) {
  const d = new Date(iso);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

const EXPENSE_LABELS = { toll: 'Toll', parking: 'Parking', bus: 'Bus fare', other: 'Other' };

function formatBillText(cycleStart, cycleEnd, entries, expenses) {
  const { totalMs, totalMileage, totalExpense } = computeTotals(entries, expenses);
  const rule = '-'.repeat(70);
  const lines = [];
  lines.push('TIME CARD BILLING STATEMENT');
  lines.push(`Cycle: ${cycleStart} to ${cycleEnd}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  lines.push('TIME ENTRIES');
  lines.push(rule);
  lines.push(
    padRight('Date', 12) + padRight('In', 7) + padRight('Out', 7) + padRight('Hours', 9) +
      padRight('Mileage', 18) + 'Description'
  );
  for (const e of entries) {
    const dateStr = e.clock_in.slice(0, 10);
    const hours = formatHoursMinutes(new Date(e.clock_out) - new Date(e.clock_in));
    const mileage =
      e.mileage_start != null && e.mileage_end != null
        ? `${e.mileage_start} -> ${e.mileage_end}`
        : '';
    lines.push(
      padRight(dateStr, 12) + padRight(fmtTime(e.clock_in), 7) + padRight(fmtTime(e.clock_out), 7) +
        padRight(hours, 9) + padRight(mileage, 18) + (e.note || '')
    );
  }
  if (!entries.length) lines.push('(none)');
  lines.push(rule);
  lines.push(`SUBTOTAL — Hours worked: ${formatHoursMinutes(totalMs)}`);
  if (totalMileage) lines.push(`SUBTOTAL — Mileage: ${totalMileage.toFixed(1)} mi`);
  lines.push('');

  lines.push('EXPENSES');
  lines.push(rule);
  lines.push(padRight('Date', 12) + padRight('Category', 12) + padRight('Amount', 10) + 'Note');
  for (const x of expenses) {
    lines.push(
      padRight(x.date.slice(0, 10), 12) + padRight(EXPENSE_LABELS[x.category] || x.category, 12) +
        padRight(fmtMoney(x.amount), 10) + (x.note || '')
    );
  }
  if (!expenses.length) lines.push('(none)');
  lines.push(rule);
  lines.push(`SUBTOTAL — Expenses: ${fmtMoney(totalExpense)}`);
  lines.push('');

  lines.push('='.repeat(70));
  lines.push(`TOTAL HOURS:    ${formatHoursMinutes(totalMs)}`);
  lines.push(`TOTAL EXPENSES: ${fmtMoney(totalExpense)}`);
  lines.push('='.repeat(70));

  return lines.join('\n') + '\n';
}
// ---- End billing helpers ----

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthenticated' });
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  if (req.body.password === PASSWORD) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

app.use(requireAuth);
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, cacheControl: false }));

app.get('/api/version', (req, res) => {
  res.json({ sha: (process.env.GIT_SHA || 'dev').slice(0, 7) });
});

app.get('/api/status', (req, res) => {
  const open = db.prepare('SELECT * FROM entries WHERE clock_out IS NULL ORDER BY id DESC LIMIT 1').get();
  res.json({ open: open || null });
});

app.post('/api/clock-in', (req, res) => {
  const open = db.prepare('SELECT * FROM entries WHERE clock_out IS NULL').get();
  if (open) return res.status(409).json({ error: 'already clocked in' });
  const mileageStart = parseMileage(req.body.mileage_start);
  if (mileageStart.error) return res.status(400).json({ error: `mileage_start ${mileageStart.error}` });
  const now = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO entries (clock_in, note, mileage_start) VALUES (?, ?, ?)')
    .run(now, req.body.note || null, mileageStart.value);
  res.json({ id: info.lastInsertRowid, clock_in: now });
});

app.post('/api/clock-out', (req, res) => {
  const open = db.prepare('SELECT * FROM entries WHERE clock_out IS NULL ORDER BY id DESC LIMIT 1').get();
  if (!open) return res.status(409).json({ error: 'not clocked in' });
  const mileageEnd = parseMileage(req.body.mileage_end);
  if (mileageEnd.error) return res.status(400).json({ error: `mileage_end ${mileageEnd.error}` });
  const now = new Date().toISOString();
  const note = req.body.note !== undefined ? req.body.note || null : open.note;
  db.prepare('UPDATE entries SET clock_out = ?, mileage_end = ?, note = ? WHERE id = ?').run(
    now,
    mileageEnd.value,
    note,
    open.id
  );
  res.json({ id: open.id, clock_out: now });
});

app.post('/api/entries/raw', (req, res) => {
  const { start_time, end_time, mileage_start, mileage_end, note } = req.body;

  const start = new Date(start_time);
  if (!start_time || Number.isNaN(start.getTime())) {
    return res.status(400).json({ error: 'invalid start_time' });
  }
  const end = new Date(end_time);
  if (!end_time || Number.isNaN(end.getTime())) {
    return res.status(400).json({ error: 'invalid end_time' });
  }
  if (end < start) {
    return res.status(400).json({ error: 'end_time cannot be before start_time' });
  }

  const mStart = parseMileage(mileage_start);
  if (mStart.error) return res.status(400).json({ error: `mileage_start ${mStart.error}` });
  const mEnd = parseMileage(mileage_end);
  if (mEnd.error) return res.status(400).json({ error: `mileage_end ${mEnd.error}` });
  if (mStart.value != null && mEnd.value != null && mEnd.value < mStart.value) {
    return res.status(400).json({ error: 'mileage_end cannot be less than mileage_start' });
  }

  const info = db
    .prepare('INSERT INTO entries (clock_in, clock_out, note, mileage_start, mileage_end) VALUES (?, ?, ?, ?, ?)')
    .run(start.toISOString(), end.toISOString(), note || null, mStart.value, mEnd.value);
  res.json({ id: info.lastInsertRowid });
});

app.get('/api/entries', (req, res) => {
  const rows = db.prepare('SELECT * FROM entries ORDER BY id DESC LIMIT 500').all();
  res.json(rows);
});

app.get('/api/entries/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.put('/api/entries/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM entries WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.billing_id != null) {
    return res.status(409).json({ error: 'already billed; cannot edit' });
  }

  const { start_time, end_time, mileage_start, mileage_end, note } = req.body;

  const start = new Date(start_time);
  if (!start_time || Number.isNaN(start.getTime())) {
    return res.status(400).json({ error: 'invalid start_time' });
  }
  const end = new Date(end_time);
  if (!end_time || Number.isNaN(end.getTime())) {
    return res.status(400).json({ error: 'invalid end_time' });
  }
  if (end < start) {
    return res.status(400).json({ error: 'end_time cannot be before start_time' });
  }

  const mStart = parseMileage(mileage_start);
  if (mStart.error) return res.status(400).json({ error: `mileage_start ${mStart.error}` });
  const mEnd = parseMileage(mileage_end);
  if (mEnd.error) return res.status(400).json({ error: `mileage_end ${mEnd.error}` });
  if (mStart.value != null && mEnd.value != null && mEnd.value < mStart.value) {
    return res.status(400).json({ error: 'mileage_end cannot be less than mileage_start' });
  }

  db.prepare(
    'UPDATE entries SET clock_in = ?, clock_out = ?, note = ?, mileage_start = ?, mileage_end = ? WHERE id = ?'
  ).run(start.toISOString(), end.toISOString(), note || null, mStart.value, mEnd.value, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/entries/:id', (req, res) => {
  const existing = db.prepare('SELECT billing_id FROM entries WHERE id = ?').get(req.params.id);
  if (existing && existing.billing_id != null) {
    return res.status(409).json({ error: 'already billed; cannot delete' });
  }
  db.prepare('DELETE FROM entries WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/expenses', (req, res) => {
  const { date, category, amount, note } = req.body;

  const d = new Date(date);
  if (!date || Number.isNaN(d.getTime())) {
    return res.status(400).json({ error: 'invalid date' });
  }
  if (!EXPENSE_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of ${EXPENSE_CATEGORIES.join(', ')}` });
  }
  const amt = parseAmount(amount);
  if (amt.error) return res.status(400).json({ error: `amount ${amt.error}` });

  const info = db
    .prepare('INSERT INTO expenses (date, category, amount, note) VALUES (?, ?, ?, ?)')
    .run(d.toISOString(), category, amt.value, note || null);
  res.json({ id: info.lastInsertRowid });
});

app.get('/api/expenses', (req, res) => {
  const rows = db.prepare('SELECT * FROM expenses ORDER BY date DESC, id DESC LIMIT 500').all();
  res.json(rows);
});

app.get('/api/expenses/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM expenses ORDER BY date ASC, id ASC').all();
  const lines = ['id,date,category,amount,description'];
  for (const r of rows) {
    const note = (r.note || '').replace(/"/g, '""');
    lines.push(`${r.id},${r.date},${r.category},${r.amount},"${note}"`);
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="timecard-expenses-export.csv"');
  res.send(lines.join('\n'));
});

app.get('/api/expenses/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.put('/api/expenses/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.billing_id != null) {
    return res.status(409).json({ error: 'already billed; cannot edit' });
  }

  const { date, category, amount, note } = req.body;

  const d = new Date(date);
  if (!date || Number.isNaN(d.getTime())) {
    return res.status(400).json({ error: 'invalid date' });
  }
  if (!EXPENSE_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of ${EXPENSE_CATEGORIES.join(', ')}` });
  }
  const amt = parseAmount(amount);
  if (amt.error) return res.status(400).json({ error: `amount ${amt.error}` });

  db.prepare('UPDATE expenses SET date = ?, category = ?, amount = ?, note = ? WHERE id = ?').run(
    d.toISOString(),
    category,
    amt.value,
    note || null,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/expenses/:id', (req, res) => {
  const existing = db.prepare('SELECT billing_id FROM expenses WHERE id = ?').get(req.params.id);
  if (existing && existing.billing_id != null) {
    return res.status(409).json({ error: 'already billed; cannot delete' });
  }
  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/billing/preview', (req, res) => {
  const suggested = suggestBillingRange();
  const cycle_start = req.query.cycle_start || suggested.cycle_start;
  const cycle_end = req.query.cycle_end || suggested.cycle_end;
  if (!isDateOnly(cycle_start) || !isDateOnly(cycle_end)) {
    return res.status(400).json({ error: 'cycle_start and cycle_end must be YYYY-MM-DD dates' });
  }
  if (cycle_end < cycle_start) {
    return res.status(400).json({ error: 'cycle_end cannot be before cycle_start' });
  }
  const { entries, expenses } = gatherBillableItems(cycle_start, cycle_end);
  const { totalMs, totalMileage, totalExpense } = computeTotals(entries, expenses);

  if (req.query.format === 'text') {
    // Draft only — same formatting as a real bill, but nothing is saved
    // and nothing is marked billed. Useful mid-cycle, before the period
    // is actually over.
    const content = formatBillText(cycle_start, cycle_end, entries, expenses).replace(
      'TIME CARD BILLING STATEMENT',
      'TIME CARD BILLING STATEMENT (DRAFT — not yet billed)'
    );
    res.setHeader('Content-Type', 'text/plain');
    return res.send(content);
  }

  res.json({
    cycle_start,
    cycle_end,
    suggested,
    entries,
    expenses,
    total_hours: formatHoursMinutes(totalMs),
    total_mileage: totalMileage,
    total_expense: totalExpense,
  });
});

app.post('/api/billing/generate', (req, res) => {
  const { cycle_start, cycle_end } = req.body;
  if (!isDateOnly(cycle_start) || !isDateOnly(cycle_end)) {
    return res.status(400).json({ error: 'cycle_start and cycle_end must be YYYY-MM-DD dates' });
  }
  if (cycle_end < cycle_start) {
    return res.status(400).json({ error: 'cycle_end cannot be before cycle_start' });
  }

  const { entries, expenses } = gatherBillableItems(cycle_start, cycle_end);
  if (!entries.length && !expenses.length) {
    return res.status(400).json({ error: 'nothing outstanding in that date range' });
  }

  const { totalMs, totalMileage, totalExpense } = computeTotals(entries, expenses);
  const content = formatBillText(cycle_start, cycle_end, entries, expenses);
  const generatedAt = new Date().toISOString();

  const commit = db.transaction(() => {
    const info = db
      .prepare(
        'INSERT INTO billings (cycle_start, cycle_end, generated_at, total_hours_ms, total_mileage, total_expense, content) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(cycle_start, cycle_end, generatedAt, totalMs, totalMileage, totalExpense, content);
    const billingId = info.lastInsertRowid;
    const markEntry = db.prepare('UPDATE entries SET billing_id = ? WHERE id = ?');
    for (const e of entries) markEntry.run(billingId, e.id);
    const markExpense = db.prepare('UPDATE expenses SET billing_id = ? WHERE id = ?');
    for (const x of expenses) markExpense.run(billingId, x.id);
    return billingId;
  });

  const id = commit();
  res.json({
    id,
    cycle_start,
    cycle_end,
    generated_at: generatedAt,
    entry_count: entries.length,
    expense_count: expenses.length,
    content,
  });
});

app.get('/api/billing/history', (req, res) => {
  const rows = db.prepare('SELECT id, cycle_start, cycle_end, generated_at, total_hours_ms, total_mileage, total_expense FROM billings ORDER BY cycle_end DESC, id DESC').all();
  res.json(rows);
});

app.get('/api/billing/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM billings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.get('/api/billing/:id/download', (req, res) => {
  const row = db.prepare('SELECT * FROM billings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="timecard-bill-${row.cycle_start}-to-${row.cycle_end}.txt"`);
  res.send(row.content);
});

// Undoes a bill: deletes the billing record and un-locks the entries and
// expenses it covered (clears their billing_id so they go back to
// outstanding and become editable/deletable again). For fixing a mistake
// — a wrong date range, generating too early — not for routine use.
app.delete('/api/billing/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM billings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const commit = db.transaction(() => {
    db.prepare('UPDATE entries SET billing_id = NULL WHERE billing_id = ?').run(row.id);
    db.prepare('UPDATE expenses SET billing_id = NULL WHERE billing_id = ?').run(row.id);
    db.prepare('DELETE FROM billings WHERE id = ?').run(row.id);
  });
  commit();

  res.json({ ok: true });
});

app.get('/api/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM entries ORDER BY id ASC').all();
  const lines = ['id,clock_in,clock_out,mileage_start,mileage_end,description'];
  for (const r of rows) {
    const note = (r.note || '').replace(/"/g, '""');
    lines.push(
      `${r.id},${r.clock_in},${r.clock_out || ''},${r.mileage_start ?? ''},${r.mileage_end ?? ''},"${note}"`
    );
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="timecard-export.csv"');
  res.send(lines.join('\n'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`time-card listening on port ${PORT}`);
  });
}

module.exports = app;
