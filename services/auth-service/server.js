const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || '/data/app.db';
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '7d';

if (!JWT_SECRET) {
  console.error('[auth-service] FATAL: JWT_SECRET is not set');
  process.exit(1);
}

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    api_id         INTEGER,
    api_hash       TEXT,
    phone          TEXT,
    session_string TEXT,
    created_at     INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

const stmts = {
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findById:       db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser:     db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)'),
  updateSetup:    db.prepare('UPDATE users SET api_id = ?, api_hash = ?, phone = ? WHERE id = ?'),
  updateSession:  db.prepare('UPDATE users SET session_string = ? WHERE id = ?'),
};

// userId → { phoneCodeHash, phone }
const pendingAuth = new Map();

function makeClient(apiId, apiHash, sessionString = '') {
  return new TelegramClient(new StringSession(sessionString), parseInt(apiId), apiHash, {
    connectionRetries: 2,
    useWSS: true,
  });
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = payload.sub;
    req.username = payload.username;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Public routes ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'auth-service' }));

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–30 alphanumeric characters or underscores' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (stmts.findByUsername.get(username)) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  const hash = await bcrypt.hash(password, 12);
  stmts.insertUser.run(username, hash);
  res.status(201).json({ message: 'User created' });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const user = stmts.findByUsername.get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.json({ token, username: user.username });
});

// ── Internal endpoint (Docker network only — not proxied by api-gateway) ──────

app.get('/internal/user-config', (req, res) => {
  const userId = parseInt(req.query.userId);
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const user = stmts.findById.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    api_id: user.api_id,
    api_hash: user.api_hash,
    session_string: user.session_string,
  });
});

// ── Protected routes ──────────────────────────────────────────────────────────

app.get('/status', requireAuth, async (req, res) => {
  const user = stmts.findById.get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const hasSetup = !!(user.api_id && user.api_hash && user.phone);
  if (!user.session_string) return res.json({ authorized: false, hasSetup });
  try {
    const c = makeClient(user.api_id, user.api_hash, user.session_string);
    await c.connect();
    const authorized = await c.isUserAuthorized();
    await c.disconnect();
    res.json({ authorized, hasSetup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/setup', requireAuth, (req, res) => {
  const { api_id, api_hash, phone } = req.body;
  if (!api_id || !api_hash || !phone) {
    return res.status(400).json({ error: 'api_id, api_hash, and phone are required' });
  }
  const parsedId = parseInt(api_id);
  if (!parsedId || parsedId <= 0) {
    return res.status(400).json({ error: 'api_id must be a positive integer' });
  }
  stmts.updateSetup.run(parsedId, api_hash, phone, req.userId);
  res.json({ message: 'Setup saved' });
});

app.post('/send-code', requireAuth, async (req, res) => {
  const user = stmts.findById.get(req.userId);
  if (!user || !user.api_id || !user.api_hash || !user.phone) {
    return res.status(428).json({ error: 'Setup required', setupRequired: true });
  }
  // Disconnect any previous pending client for this user
  const prev = pendingAuth.get(req.userId);
  if (prev?.client) prev.client.disconnect().catch(() => {});

  try {
    const c = makeClient(user.api_id, user.api_hash);
    await c.connect();
    const result = await c.sendCode({ apiId: user.api_id, apiHash: user.api_hash }, user.phone);
    // Keep the client alive — sign-in must reuse the same connection
    pendingAuth.set(req.userId, { client: c, phoneCodeHash: result.phoneCodeHash, phone: user.phone });
    res.json({ message: 'Code sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/sign-in', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  const pending = pendingAuth.get(req.userId);
  if (!pending) return res.status(400).json({ error: 'No pending login — call send-code first' });
  const user = stmts.findById.get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    const c = pending.client;
    await c.invoke(
      new Api.auth.SignIn({
        phoneNumber: pending.phone,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode: code,
      })
    );
    const sessionString = c.session.save();
    await c.disconnect();
    stmts.updateSession.run(sessionString, req.userId);
    pendingAuth.delete(req.userId);
    res.json({ message: 'Signed in' });
  } catch (err) {
    if (err.message.includes('SESSION_PASSWORD_NEEDED')) {
      return res.status(403).json({ error: '2FA required', require2FA: true });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/2fa', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password is required' });
  const pending = pendingAuth.get(req.userId);
  if (!pending) return res.status(400).json({ error: 'No pending login — call send-code first' });
  const user = stmts.findById.get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    const c = pending.client;
    await c.signInWithPassword({ apiId: user.api_id, apiHash: user.api_hash }, { password });
    const sessionString = c.session.save();
    await c.disconnect();
    stmts.updateSession.run(sessionString, req.userId);
    pendingAuth.delete(req.userId);
    res.json({ message: 'Signed in with 2FA' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`[auth-service] running on port ${PORT}`));
