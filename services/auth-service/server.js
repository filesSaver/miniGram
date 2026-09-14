require('dotenv').config();
const express = require('express');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;

let client = null;
let phoneCodeHash = null;

function getSession() {
  return new StringSession(process.env.SESSION_STRING || '');
}

async function getClient() {
  if (!client) {
    client = new TelegramClient(getSession(), API_ID, API_HASH, {
      connectionRetries: 2,
      useWSS: true,
    });
    await client.connect();
  }
  return client;
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'auth-service' }));

app.get('/status', async (req, res) => {
  if (!process.env.SESSION_STRING) return res.json({ authorized: false });
  try {
    const c = await getClient();
    const authorized = await c.isUserAuthorized();
    res.json({ authorized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/send-code', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber is required' });
  try {
    const c = await getClient();
    const result = await c.sendCode({ apiId: API_ID, apiHash: API_HASH }, phoneNumber);
    phoneCodeHash = result.phoneCodeHash;
    res.json({ message: 'Code sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/sign-in', async (req, res) => {
  const { phoneNumber, code } = req.body;
  if (!phoneNumber || !code) return res.status(400).json({ error: 'phoneNumber and code are required' });
  try {
    const c = await getClient();
    await c.invoke(
      new (require('telegram/tl').Api.auth.SignIn)({ phoneNumber, phoneCodeHash, phoneCode: code })
    );
    const sessionString = c.session.save();
    process.env.SESSION_STRING = sessionString;
    res.json({ message: 'Signed in', sessionString });
  } catch (err) {
    if (err.message.includes('PASSWORD_HASH_INVALID') || err.message.includes('SESSION_PASSWORD_NEEDED')) {
      return res.status(403).json({ error: '2FA required', require2FA: true });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/2fa', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password is required' });
  try {
    const c = await getClient();
    await c.signInWithPassword({ apiId: API_ID, apiHash: API_HASH }, { password });
    const sessionString = c.session.save();
    process.env.SESSION_STRING = sessionString;
    res.json({ message: 'Signed in with 2FA', sessionString });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`[auth-service] running on port ${PORT}`));
