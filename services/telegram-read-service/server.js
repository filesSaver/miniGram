require('dotenv').config();
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

const API_ID = Number.parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;

let client = null;

async function getClient() {
  if (!client) {
    client = new TelegramClient(new StringSession(process.env.SESSION_STRING || ''), API_ID, API_HASH, {
      connectionRetries: 2,
      useWSS: true,
    });
    await client.connect();
  }
  return client;
}

function buildGroupInfo(e) {
  return {
    id: e.id.toString(),
    name: e.title,
    type: e instanceof Api.Channel && !e.megagroup ? 'channel' : 'group',
    // Counts
    memberCount: e.participantsCount ?? null,
    adminCount: e.adminsCount ?? null,
    // Dates
    createdAt: e.date ? new Date(e.date * 1000).toISOString() : null,
    // Identity
    username: e.username || null,
    // Flags
    scam: e.scam ?? false,
    fake: e.fake ?? false,
    restricted: e.restricted ?? false,
    verified: e.verified ?? false,
    broadcast: e.broadcast ?? false,
    megagroup: e.megagroup ?? false,
    gigagroup: e.gigagroup ?? false,
    forum: e.forum ?? false,
    // Channel/group specific
    hasLink: e.hasLink ?? false,
    hasGeo: e.hasGeo ?? false,
    slowmodeEnabled: e.slowmodeEnabled ?? false,
    noforwards: e.noforwards ?? false,
    joinToSend: e.joinToSend ?? false,
    joinRequest: e.joinRequest ?? false,
    // Description is fetched separately via full info
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

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'telegram-read-service' }));

// ── Forum topics ──────────────────────────────────────────────────────────────
app.get('/groups/:id/topics', async (req, res) => {
  try {
    const c = await getClient();
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
    res.status(500).json({ error: err.message });
  }
});

// SSE stream for a single topic inside a forum group
app.get('/groups/:id/topics/:topicId/breakdown/stream', async (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const cacheKey = `${req.params.id}:${req.params.topicId}`;

  try {
    const c = await getClient();
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

    for await (const msg of c.iterMessages(dialog.entity, {
      limit: undefined,
      replyTo: topicId,
    })) {
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
  }
  res.end();
});

// Content for a specific topic (served from cache after stream)
app.get('/groups/:id/topics/:topicId/content', async (req, res) => {
  try {
    const cacheKey = `${req.params.id}:${req.params.topicId}`;
    if (messageCache.has(cacheKey)) {
      const all = messageCache.get(cacheKey).items;
      const type = req.query.type || 'all';
      const filtered = type === 'all' ? all : all.filter(m => m.type === type);
      return res.json({ items: filtered, total: filtered.length });
    }

    const c = await getClient();
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
    messageCache.set(cacheKey, { items, ts: Date.now() });

    const type = req.query.type || 'all';
    const filtered = type === 'all' ? items : items.filter(m => m.type === type);
    res.json({ items: filtered, total: filtered.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/groups', async (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit) || 10;
    const offset = Number.parseInt(req.query.offset) || 0;
    const c = await getClient();
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/groups/:id', async (req, res) => {
  try {
    const c = await getClient();
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) return res.status(404).json({ error: 'Group not found' });
    const info = buildGroupInfo(dialog.entity);

    // Try to fetch the 'about' description from full channel/chat info
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/groups/:id/photo', async (req, res) => {
  try {
    const c = await getClient();
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
    res.status(500).json({ error: err.message });
  }
});

// ── Per-group message cache ───────────────────────────────────────────────────
// groupId → { items: ContentItem[], ts: number }
const messageCache = new Map();
// groupId → Promise (dedupe concurrent scan requests)
const scanInProgress = new Map();

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

// Returns cached items or runs a full scan, deduplicating concurrent calls
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

// Fetches every message from a dialog by paginating with iterMessages
async function getAllMessages(client, entity) {
  const messages = [];
  for await (const msg of client.iterMessages(entity, { limit: undefined })) {
    messages.push(msg);
  }
  return messages;
}

// Returns per-type message counts for a group (used by the All tab)
app.get('/groups/:id/stats', async (req, res) => {
  try {
    const c = await getClient();
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) return res.status(404).json({ error: 'Group not found' });

    // Single API call — Telegram returns total count in history metadata
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
    res.status(500).json({ error: err.message });
  }
});

// SSE stream — emits progress as messages are scanned, then final counts
app.get('/groups/:id/breakdown/stream', async (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const c = await getClient();
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) { send({ error: 'Group not found' }); return res.end(); }

    // If already cached, emit done immediately
    if (messageCache.has(req.params.id)) {
      const cached = messageCache.get(req.params.id).items;
      const counts = { video: 0, audio: 0, image: 0, pdf: 0, chat: 0, other: 0 };
      for (const item of cached) counts[item.type] = (counts[item.type] || 0) + 1;
      send({ processed: cached.length, total: cached.length, counts, done: true });
      return res.end();
    }

    // Get total first so we can show %
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
      // Emit progress every 100 messages
      if (processed % 100 === 0) {
        send({ processed, total, counts, done: false });
      }
    }

    messageCache.set(req.params.id, { items, ts: Date.now() });
    scanInProgress.delete(req.params.id);
    send({ processed, total: processed, counts, done: true });
  } catch (err) {
    send({ error: err.message });
  }
  res.end();
});

// Slow endpoint — scans every message to produce per-type breakdown.
// Result is cached so /content tabs are instant afterwards.
app.get('/groups/:id/breakdown', async (req, res) => {
  try {
    const c = await getClient();
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
    res.status(500).json({ error: err.message });
  }
});

// Range fetch — returns items whose message ID is between from and to (inclusive)
app.get('/groups/:id/content/range', async (req, res) => {
  try {
    const fromId = Number.parseInt(req.query.from);
    const toId   = Number.parseInt(req.query.to);
    if (!fromId || !toId || fromId > toId) {
      return res.status(400).json({ error: 'Invalid range: provide from and to as integers with from <= to' });
    }

    const c = await getClient();
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === req.params.id
    );
    if (!dialog) return res.status(404).json({ error: 'Group not found' });

    const items = [];
    // iterMessages with minId/maxId fetches only within the range efficiently
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
    res.status(500).json({ error: err.message });
  }
});

// Topic range fetch
app.get('/groups/:id/topics/:topicId/content/range', async (req, res) => {
  try {
    const fromId = Number.parseInt(req.query.from);
    const toId   = Number.parseInt(req.query.to);
    if (!fromId || !toId || fromId > toId) {
      return res.status(400).json({ error: 'Invalid range: provide from and to as integers with from <= to' });
    }

    const c = await getClient();
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/groups/:id/content', async (req, res) => {
  try {
    const type = req.query.type || 'all';
    const limit = Number.parseInt(req.query.limit) || 10;
    const offset = Number.parseInt(req.query.offset) || 0;
    const c = await getClient();
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
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`[telegram-read-service] running on port ${PORT}`));
