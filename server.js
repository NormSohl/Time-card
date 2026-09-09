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
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  const open = db.prepare('SELECT * FROM entries WHERE clock_out IS NULL ORDER BY id DESC LIMIT 1').get();
  res.json({ open: open || null });
});

app.post('/api/clock-in', (req, res) => {
  const open = db.prepare('SELECT * FROM entries WHERE clock_out IS NULL').get();
  if (open) return res.status(409).json({ error: 'already clocked in' });
  const now = new Date().toISOString();
  const mileageStart = req.body.mileage_start !== undefined && req.body.mileage_start !== '' ? Number(req.body.mileage_start) : null;
  const info = db
    .prepare('INSERT INTO entries (clock_in, note, mileage_start) VALUES (?, ?, ?)')
    .run(now, req.body.note || null, mileageStart);
  res.json({ id: info.lastInsertRowid, clock_in: now });
});

app.post('/api/clock-out', (req, res) => {
  const open = db.prepare('SELECT * FROM entries WHERE clock_out IS NULL ORDER BY id DESC LIMIT 1').get();
  if (!open) return res.status(409).json({ error: 'not clocked in' });
  const now = new Date().toISOString();
  const mileageEnd = req.body.mileage_end !== undefined && req.body.mileage_end !== '' ? Number(req.body.mileage_end) : null;
  db.prepare('UPDATE entries SET clock_out = ?, mileage_end = ? WHERE id = ?').run(now, mileageEnd, open.id);
  res.json({ id: open.id, clock_out: now });
});

// Comment can be added/edited any time while clocked in; the open entry
// (clock_out IS NULL) is the only one this can touch, so it's locked the
// moment clock-out runs.
app.post('/api/note', (req, res) => {
  const open = db.prepare('SELECT * FROM entries WHERE clock_out IS NULL ORDER BY id DESC LIMIT 1').get();
  if (!open) return res.status(409).json({ error: 'not clocked in' });
  db.prepare('UPDATE entries SET note = ? WHERE id = ?').run(req.body.note || null, open.id);
  res.json({ id: open.id, note: req.body.note || null });
});

app.post('/api/entries/raw', (req, res) => {
  const { start_time, mileage_start, duration_minutes, miles_driven, note } = req.body;

  const start = new Date(start_time);
  if (!start_time || Number.isNaN(start.getTime())) {
    return res.status(400).json({ error: 'invalid start_time' });
  }
  const minutes = Number(duration_minutes);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return res.status(400).json({ error: 'invalid duration_minutes' });
  }
  const end = new Date(start.getTime() + minutes * 60000);

  const mStart = mileage_start !== undefined && mileage_start !== '' ? Number(mileage_start) : null;
  const driven = miles_driven !== undefined && miles_driven !== '' ? Number(miles_driven) : null;
  const mEnd = mStart != null && driven != null ? mStart + driven : null;

  const info = db
    .prepare('INSERT INTO entries (clock_in, clock_out, note, mileage_start, mileage_end) VALUES (?, ?, ?, ?, ?)')
    .run(start.toISOString(), end.toISOString(), note || null, mStart, mEnd);
  res.json({ id: info.lastInsertRowid });
});

app.get('/api/entries', (req, res) => {
  const rows = db.prepare('SELECT * FROM entries ORDER BY id DESC LIMIT 500').all();
  res.json(rows);
});

app.delete('/api/entries/:id', (req, res) => {
  db.prepare('DELETE FROM entries WHERE id = ?').run(req.params.id);
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
