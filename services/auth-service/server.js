const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '7d';
const DB_URL = process.env.DB_SERVICE_URL || 'http://db-service:3006';

if (!JWT_SECRET) {
  console.error('[auth-service] FATAL: JWT_SECRET is not set');
  process.exit(1);
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function dbGet(path) {
  const res = await fetch(`${DB_URL}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`db-service ${path} → ${res.status}`);
  return res.json();
}

async function dbPost(path, body) {
  const res = await fetch(`${DB_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const e = new Error(err.error || res.statusText);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

async function dbPatch(path, body) {
  const res = await fetch(`${DB_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`db-service PATCH ${path} → ${res.status}`);
  return res.json();
}

// ── State ─────────────────────────────────────────────────────────────────────

// userId → { client, phoneCodeHash, phone }
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
  try {
    const hash = await bcrypt.hash(password, 12);
    await dbPost('/users', { username, password_hash: hash });
    res.status(201).json({ message: 'User created' });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  try {
    const user = await dbGet(`/users/by-username/${encodeURIComponent(username)}`);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.json({ token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Protected routes ──────────────────────────────────────────────────────────

app.get('/status', requireAuth, async (req, res) => {
  try {
    const user = await dbGet(`/users/${req.userId}`);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const hasSetup = !!(user.api_id && user.api_hash && user.phone);
    if (!user.session_string) return res.json({ authorized: false, hasSetup });
    const c = makeClient(user.api_id, user.api_hash, user.session_string);
    await c.connect();
    const authorized = await c.isUserAuthorized();
    await c.disconnect();
    res.json({ authorized, hasSetup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/setup', requireAuth, async (req, res) => {
  const { api_id, api_hash, phone } = req.body;
  if (!api_id || !api_hash || !phone) {
    return res.status(400).json({ error: 'api_id, api_hash, and phone are required' });
  }
  const parsedId = parseInt(api_id);
  if (!parsedId || parsedId <= 0) {
    return res.status(400).json({ error: 'api_id must be a positive integer' });
  }
  try {
    await dbPatch(`/users/${req.userId}/setup`, { api_id: parsedId, api_hash, phone });
    res.json({ message: 'Setup saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/send-code', requireAuth, async (req, res) => {
  try {
    const user = await dbGet(`/users/${req.userId}`);
    if (!user || !user.api_id || !user.api_hash || !user.phone) {
      return res.status(428).json({ error: 'Setup required', setupRequired: true });
    }
    const prev = pendingAuth.get(req.userId);
    if (prev?.client) prev.client.disconnect().catch(() => {});

    const c = makeClient(user.api_id, user.api_hash);
    await c.connect();
    const result = await c.sendCode({ apiId: user.api_id, apiHash: user.api_hash }, user.phone);
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
    await dbPatch(`/users/${req.userId}/session`, { session_string: sessionString });
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
  try {
    const user = await dbGet(`/users/${req.userId}`);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const c = pending.client;
    await c.signInWithPassword({ apiId: user.api_id, apiHash: user.api_hash }, { password });
    const sessionString = c.session.save();
    await c.disconnect();
    await dbPatch(`/users/${req.userId}/session`, { session_string: sessionString });
    pendingAuth.delete(req.userId);
    res.json({ message: 'Signed in with 2FA' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`[auth-service] running on port ${PORT}`));
