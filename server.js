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
  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
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

app.listen(PORT, () => {
  console.log(`time-card listening on port ${PORT}`);
});
