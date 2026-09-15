const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3002;
const JWT_SECRET = process.env.JWT_SECRET;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:3001';

if (!JWT_SECRET) {
  console.error('[telegram-read-service] FATAL: JWT_SECRET is not set');
  process.exit(1);
}

app.use(express.json());

async function getUserConfig(userId) {
  const res = await fetch(`${AUTH_SERVICE_URL}/internal/user-config?userId=${userId}`);
  if (!res.ok) throw Object.assign(new Error(`user-config fetch failed: ${res.status}`), { code: 503 });
  return res.json();
}

async function getClientForUser(userId) {
  const config = await getUserConfig(userId);
  if (!config.api_id || !config.api_hash || !config.session_string) {
    throw Object.assign(new Error('Telegram not configured or not logged in'), { code: 428 });
  }
  const client = new TelegramClient(
    new StringSession(config.session_string),
    parseInt(config.api_id),
    config.api_hash,
    { connectionRetries: 2, useWSS: true }
  );
  await client.connect();
  return client;
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAuthSSE(req, res, next) {
  const header = req.headers['authorization'];
  const token = (header && header.startsWith('Bearer ')) ? header.slice(7) : req.query.token;
  if (!token) { res.status(401).end(); return; }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).end();
  }
}

function buildGroupInfo(e) {
  return {
    id: e.id.toString(),
    name: e.title,
    type: e instanceof Api.Channel && !e.megagroup ? 'channel' : 'group',
    memberCount: e.participantsCount ?? null,
    adminCount: e.adminsCount ?? null,
    createdAt: e.date ? new Date(e.date * 1000).toISOString() : null,
    username: e.username || null,
    scam: e.scam ?? false,
    fake: e.fake ?? false,
    restricted: e.restricted ?? false,
    verified: e.verified ?? false,
    broadcast: e.broadcast ?? false,
    megagroup: e.megagroup ?? false,
    gigagroup: e.gigagroup ?? false,
    forum: e.forum ?? false,
    hasLink: e.hasLink ?? false,
    hasGeo: e.hasGeo ?? false,
    slowmodeEnabled: e.slowmodeEnabled ?? false,
    noforwards: e.noforwards ?? false,
    joinToSend: e.joinToSend ?? false,
    joinRequest: e.joinRequest ?? false,
    about: null,
  };
}

function categorize(msg) {
  const media = msg.media;
  if (!media) return 'chat';
  if (media.className === 'MessageMediaPhoto') return 'image';
  if (media.className === 'MessageMediaDocument') {
    const mime = media.document?.mimeType || '';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf') return 'pdf';
    if (mime.startsWith('image/')) return 'image';
    return 'other';
  }
  return 'other';
}

function getFileName(msg) {
  const attrs = msg.media?.document?.attributes || [];
  const a = attrs.find(x => x.className === 'DocumentAttributeFilename');
  return a?.fileName || null;
}

function mapMessage(msg) {
  return {
    id: msg.id.toString(),
    type: categorize(msg),
    text: msg.message || '',
    date: msg.date ? new Date(msg.date * 1000).toISOString() : null,
    fileName: getFileName(msg),
    fileSize: msg.media?.document?.size ? Number(msg.media.document.size) : null,
    mimeType: msg.media?.document?.mimeType || (msg.media?.className === 'MessageMediaPhoto' ? 'image/jpeg' : null),
  };
}

// groupId → { items: ContentItem[], ts: number }
const messageCache = new Map();
// groupId → Promise (dedupe concurrent scan requests)
const scanInProgress = new Map();

async function getOrScanMessages(groupId, entity, client) {
  if (messageCache.has(groupId)) return messageCache.get(groupId).items;
  if (scanInProgress.has(groupId)) return scanInProgress.get(groupId);

  const promise = (async () => {
    const items = [];
    for await (const msg of client.iterMessages(entity, { limit: undefined })) {
      if (msg.message === undefined) continue;
      items.push(mapMessage(msg));
    }
    messageCache.set(groupId, { items, ts: Date.now() });
    scanInProgress.delete(groupId);
    return items;
  })();

  scanInProgress.set(groupId, promise);
  return promise;
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'telegram-read-service' }));

app.get('/groups/:id/topics', requireAuth, async (req, res) => {
  let c;
  try {
    c = await getClientForUser(req.userId);
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) return res.status(404).json({ error: 'Group not found' });
    if (!dialog.entity.forum) return res.json({ topics: [] });

    const result = await c.invoke(new Api.channels.GetForumTopics({
      channel: dialog.entity,
      limit: 100,
      offsetDate: 0,
      offsetId: 0,
      offsetTopic: 0,
    }));

    const topics = (result.topics || []).map(t => ({
      id: t.id,
      title: t.title,
      topMessage: t.topMessage,
      unreadCount: t.unreadCount ?? 0,
      closed: t.closed ?? false,
      pinned: t.pinned ?? false,
      iconEmoji: t.iconEmoji ? t.iconEmoji.toString() : null,
    }));

    res.json({ topics });
  } catch (err) {
    res.status(err.code || 500).json({ error: err.message });
  } finally {
    c?.disconnect().catch(() => {});
  }
});

app.get('/groups/:id/topics/:topicId/breakdown/stream', requireAuthSSE, async (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const cacheKey = `${req.params.id}:${req.params.topicId}`;

  let c;
  try {
    c = await getClientForUser(req.userId);
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) { send({ error: 'Group not found' }); return res.end(); }

    if (messageCache.has(cacheKey)) {
      const cached = messageCache.get(cacheKey).items;
      const counts = { video: 0, audio: 0, image: 0, pdf: 0, chat: 0, other: 0 };
      for (const item of cached) counts[item.type] = (counts[item.type] || 0) + 1;
      send({ processed: cached.length, total: cached.length, counts, done: true });
      return res.end();
    }

    const topicId = Number.parseInt(req.params.topicId);
    const counts = { video: 0, audio: 0, image: 0, pdf: 0, chat: 0, other: 0 };
    const items = [];
    let processed = 0;

    for await (const msg of c.iterMessages(dialog.entity, { limit: undefined, replyTo: topicId })) {
      if (msg.message === undefined) continue;
      const item = mapMessage(msg);
      items.push(item);
      counts[item.type] = (counts[item.type] || 0) + 1;
      processed++;
      if (processed % 100 === 0) send({ processed, total: null, counts, done: false });
    }

    messageCache.set(cacheKey, { items, ts: Date.now() });
    send({ processed, total: processed, counts, done: true });
  } catch (err) {
    send({ error: err.message });
  } finally {
    c?.disconnect().catch(() => {});
  }
  res.end();
});

app.get('/groups/:id/topics/:topicId/content', requireAuth, async (req, res) => {
  let c;
  try {
    const cacheKey = `${req.params.id}:${req.params.topicId}`;
    if (messageCache.has(cacheKey)) {
      const all = messageCache.get(cacheKey).items;
      const type = req.query.type || 'all';
      const filtered = type === 'all' ? all : all.filter(m => m.type === type);
      return res.json({ items: filtered, total: filtered.length });
    }

    c = await getClientForUser(req.userId);
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) return res.status(404).json({ error: 'Group not found' });

    const topicId = Number.parseInt(req.params.topicId);
    const items = [];
    for await (const msg of c.iterMessages(dialog.entity, { limit: undefined, replyTo: topicId })) {
      if (msg.message === undefined) continue;
      items.push(mapMessage(msg));
    }
    messageCache.set(`${req.params.id}:${topicId}`, { items, ts: Date.now() });

    const type = req.query.type || 'all';
    const filtered = type === 'all' ? items : items.filter(m => m.type === type);
    res.json({ items: filtered, total: filtered.length });
  } catch (err) {
    res.status(err.code || 500).json({ error: err.message });
  } finally {
    c?.disconnect().catch(() => {});
  }
});

app.get('/groups', requireAuth, async (req, res) => {
  let c;
  try {
    const limit = Number.parseInt(req.query.limit) || 10;
    const offset = Number.parseInt(req.query.offset) || 0;
    c = await getClientForUser(req.userId);
    const dialogs = await c.getDialogs({});

    const all = dialogs
      .filter(d => d.entity instanceof Api.Chat || d.entity instanceof Api.Channel)
      .map(d => buildGroupInfo(d.entity));

    const groupCount = all.filter(g => g.type === 'group').length;
    const channelCount = all.filter(g => g.type === 'channel').length;

    res.json({
      groups: all.slice(offset, offset + limit),
      total: all.length,
      groupCount,
      channelCount,
      offset,
      limit,
    });
  } catch (err) {
    res.status(err.code || 500).json({ error: err.message });
  } finally {
    c?.disconnect().catch(() => {});
  }
});

app.get('/groups/:id', requireAuth, async (req, res) => {
  let c;
  try {
    c = await getClientForUser(req.userId);
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) return res.status(404).json({ error: 'Group not found' });
    const info = buildGroupInfo(dialog.entity);

    try {
      if (dialog.entity instanceof Api.Channel) {
        const full = await c.invoke(new Api.channels.GetFullChannel({ channel: dialog.entity }));
        info.about = full.fullChat?.about || null;
      } else {
        const full = await c.invoke(new Api.messages.GetFullChat({ chatId: dialog.entity.id }));
        info.about = full.fullChat?.about || null;
      }
    } catch {
      // about stays null — non-fatal
    }

    res.json(info);
  } catch (err) {
    res.status(err.code || 500).json({ error: err.message });
  } finally {
    c?.disconnect().catch(() => {});
  }
});

app.get('/groups/:id/photo', requireAuth, async (req, res) => {
  let c;
  try {
    c = await getClientForUser(req.userId);
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) return res.status(404).end();
    const buffer = await c.downloadProfilePhoto(dialog.entity);
    if (!buffer || buffer.length === 0) return res.status(404).end();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    res.status(err.code || 500).json({ error: err.message });
  } finally {
    c?.disconnect().catch(() => {});
  }
});

app.get('/groups/:id/stats', requireAuth, async (req, res) => {
  let c;
  try {
    c = await getClientForUser(req.userId);
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) return res.status(404).json({ error: 'Group not found' });

    const result = await c.invoke(new Api.messages.GetHistory({
      peer: dialog.entity,
      limit: 1,
      offsetId: 0,
      offsetDate: 0,
      addOffset: 0,
      maxId: 0,
      minId: 0,
      hash: BigInt(0),
    }));

    const total = result.count ?? result.messages?.length ?? 0;
    res.json({ total });
  } catch (err) {
    res.status(err.code || 500).json({ error: err.message });
  } finally {
    c?.disconnect().catch(() => {});
  }
});

app.get('/groups/:id/breakdown/stream', requireAuthSSE, async (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  let c;

  try {
    c = await getClientForUser(req.userId);
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) { send({ error: 'Group not found' }); return res.end(); }

    if (messageCache.has(req.params.id)) {
      const cached = messageCache.get(req.params.id).items;
      const counts = { video: 0, audio: 0, image: 0, pdf: 0, chat: 0, other: 0 };
      for (const item of cached) counts[item.type] = (counts[item.type] || 0) + 1;
      send({ processed: cached.length, total: cached.length, counts, done: true });
      return res.end();
    }

    const histResult = await c.invoke(new Api.messages.GetHistory({
      peer: dialog.entity, limit: 1,
      offsetId: 0, offsetDate: 0, addOffset: 0, maxId: 0, minId: 0, hash: BigInt(0),
    }));
    const total = histResult.count ?? 0;

    const counts = { video: 0, audio: 0, image: 0, pdf: 0, chat: 0, other: 0 };
    const items = [];
    let processed = 0;

    for await (const msg of c.iterMessages(dialog.entity, { limit: undefined })) {
      if (msg.message === undefined) continue;
      const item = mapMessage(msg);
      items.push(item);
      counts[item.type] = (counts[item.type] || 0) + 1;
      processed++;
      if (processed % 100 === 0) {
        send({ processed, total, counts, done: false });
      }
    }

    messageCache.set(req.params.id, { items, ts: Date.now() });
    scanInProgress.delete(req.params.id);
    send({ processed, total: processed, counts, done: true });
  } catch (err) {
    send({ error: err.message });
  } finally {
    c?.disconnect().catch(() => {});
  }
  res.end();
});

app.get('/groups/:id/breakdown', requireAuth, async (req, res) => {
  let c;
  try {
    c = await getClientForUser(req.userId);
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) return res.status(404).json({ error: 'Group not found' });

    const items = await getOrScanMessages(req.params.id, dialog.entity, c);
    const counts = { video: 0, audio: 0, image: 0, pdf: 0, chat: 0, other: 0 };
    for (const item of items) counts[item.type] = (counts[item.type] || 0) + 1;
    res.json(counts);
  } catch (err) {
    res.status(err.code || 500).json({ error: err.message });
  } finally {
    c?.disconnect().catch(() => {});
  }
});

app.get('/groups/:id/content/range', requireAuth, async (req, res) => {
  let c;
  try {
    const fromId = Number.parseInt(req.query.from);
    const toId   = Number.parseInt(req.query.to);
    if (!fromId || !toId || fromId > toId) {
      return res.status(400).json({ error: 'Invalid range: provide from and to as integers with from <= to' });
    }

    c = await getClientForUser(req.userId);
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) return res.status(404).json({ error: 'Group not found' });

    const items = [];
    for await (const msg of c.iterMessages(dialog.entity, {
      minId: fromId - 1,
      maxId: toId + 1,
      limit: undefined,
    })) {
      if (msg.message === undefined) continue;
      items.push(mapMessage(msg));
    }

    res.json({ items, total: items.length });
  } catch (err) {
    res.status(err.code || 500).json({ error: err.message });
  } finally {
    c?.disconnect().catch(() => {});
  }
});

app.get('/groups/:id/topics/:topicId/content/range', requireAuth, async (req, res) => {
  let c;
  try {
    const fromId = Number.parseInt(req.query.from);
    const toId   = Number.parseInt(req.query.to);
    if (!fromId || !toId || fromId > toId) {
      return res.status(400).json({ error: 'Invalid range: provide from and to as integers with from <= to' });
    }

    c = await getClientForUser(req.userId);
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) return res.status(404).json({ error: 'Group not found' });

    const topicId = Number.parseInt(req.params.topicId);
    const items = [];
    for await (const msg of c.iterMessages(dialog.entity, {
      minId: fromId - 1,
      maxId: toId + 1,
      replyTo: topicId,
      limit: undefined,
    })) {
      if (msg.message === undefined) continue;
      items.push(mapMessage(msg));
    }

    res.json({ items, total: items.length });
  } catch (err) {
    res.status(err.code || 500).json({ error: err.message });
  } finally {
    c?.disconnect().catch(() => {});
  }
});

app.get('/groups/:id/content', requireAuth, async (req, res) => {
  let c;
  try {
    const type = req.query.type || 'all';
    const limit = Number.parseInt(req.query.limit) || 10;
    const offset = Number.parseInt(req.query.offset) || 0;
    c = await getClientForUser(req.userId);
    const dialogs = await c.getDialogs({});

    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) return res.status(404).json({ error: 'Group not found' });

    const all = await getOrScanMessages(req.params.id, dialog.entity, c);
    const filtered = type === 'all' ? all : all.filter(m => m.type === type);
    res.json({ items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit });
  } catch (err) {
    res.status(err.code || 500).json({ error: err.message });
  } finally {
    c?.disconnect().catch(() => {});
  }
});

app.listen(PORT, () => console.log(`[telegram-read-service] running on port ${PORT}`));
