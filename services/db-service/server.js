const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3006;

if (!process.env.DATABASE_URL) {
  console.error('[db-service] FATAL: DATABASE_URL is not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id             SERIAL PRIMARY KEY,
      username       TEXT NOT NULL UNIQUE,
      password_hash  TEXT NOT NULL,
      api_id         INTEGER,
      api_hash       TEXT,
      phone          TEXT,
      session_string TEXT,
      created_at     BIGINT NOT NULL DEFAULT extract(epoch from now())
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS downloads (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id   TEXT NOT NULL,
      message_id TEXT NOT NULL,
      file_name  TEXT,
      file_size  BIGINT,
      ts         BIGINT NOT NULL DEFAULT extract(epoch from now()),
      UNIQUE(user_id, group_id, message_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS downloads_user_group ON downloads(user_id, group_id)`);
  console.log('[db-service] DB ready');
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'db-service' }));

app.post('/users', async (req, res) => {
  const { username, password_hash } = req.body;
  if (!username || !password_hash) {
    return res.status(400).json({ error: 'username and password_hash are required' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username, password_hash]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/users/by-username/:username', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [req.params.username]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/users/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/users/:id/setup', async (req, res) => {
  const id = parseInt(req.params.id);
  const { api_id, api_hash, phone } = req.body;
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  if (!api_id || !api_hash || !phone) {
    return res.status(400).json({ error: 'api_id, api_hash, and phone are required' });
  }
  try {
    await pool.query(
      'UPDATE users SET api_id=$1, api_hash=$2, phone=$3 WHERE id=$4',
      [api_id, api_hash, phone, id]
    );
    res.json({ message: 'Setup saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/users/:id/session', async (req, res) => {
  const id = parseInt(req.params.id);
  const { session_string } = req.body;
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  if (!session_string) return res.status(400).json({ error: 'session_string is required' });
  try {
    await pool.query('UPDATE users SET session_string=$1 WHERE id=$2', [session_string, id]);
    res.json({ message: 'Session saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Download log ──────────────────────────────────────────────────────────────

// Record a completed download (upsert — re-downloading updates ts)
app.post('/downloads', async (req, res) => {
  const { userId, groupId, messageId, fileName, fileSize } = req.body;
  if (!userId || !groupId || !messageId) {
    return res.status(400).json({ error: 'userId, groupId, messageId are required' });
  }
  try {
    await pool.query(
      `INSERT INTO downloads (user_id, group_id, message_id, file_name, file_size, ts)
       VALUES ($1, $2, $3, $4, $5, extract(epoch from now()))
       ON CONFLICT (user_id, group_id, message_id)
       DO UPDATE SET file_name=$4, file_size=$5, ts=extract(epoch from now())`,
      [userId, groupId, messageId, fileName ?? null, fileSize ?? null]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-group download counts for a user (for home screen badges)
app.get('/downloads/counts/:userId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT group_id, COUNT(*)::int AS count FROM downloads WHERE user_id=$1 GROUP BY group_id',
      [req.params.userId]
    );
    const counts = {};
    rows.forEach(r => { counts[r.group_id] = r.count; });
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All downloaded message IDs for a user+group
app.get('/downloads/:groupId', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  try {
    const { rows } = await pool.query(
      'SELECT message_id, file_name, file_size, ts FROM downloads WHERE user_id=$1 AND group_id=$2',
      [userId, req.params.groupId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`[db-service] running on port ${PORT}`)))
  .catch(err => { console.error('[db-service] DB init failed:', err.message); process.exit(1); });
