const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { iterDownload } = require('telegram/client/downloads');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3003;
const JWT_SECRET = process.env.JWT_SECRET;
const DB_SERVICE_URL = process.env.DB_SERVICE_URL || 'http://db-service:3006';

if (!JWT_SECRET) {
  console.error('[telegram-download-service] FATAL: JWT_SECRET is not set');
  process.exit(1);
}

app.use(express.json());

async function getUserConfig(userId) {
  const res = await fetch(`${DB_SERVICE_URL}/users/${userId}`);
  if (!res.ok) throw Object.assign(new Error(`db-service fetch failed: ${res.status}`), { code: 503 });
  return res.json();
}

// Keep one live client per user — avoids 30s MTProto handshake on every download
const clientPool = new Map();

async function getClientForUser(userId) {
  const existing = clientPool.get(userId);
  if (existing) {
    try {
      if (!existing.connected) {
        console.log(`[pool] reconnecting client for user ${userId}`);
        await existing.connect();
      }
      return existing;
    } catch (e) {
      console.warn(`[pool] reconnect failed, creating new client: ${e.message}`);
      clientPool.delete(userId);
    }
  }

  const config = await getUserConfig(userId);
  if (!config.api_id || !config.api_hash || !config.session_string) {
    throw Object.assign(new Error('Telegram not configured or not logged in'), { code: 428 });
  }
  const client = new TelegramClient(
    new StringSession(config.session_string),
    Number.parseInt(config.api_id),
    config.api_hash,
    { connectionRetries: 5, useWSS: true }
  );
  await client.connect();
  clientPool.set(userId, client);
  console.log(`[pool] new client for user ${userId}, pool size=${clientPool.size}`);
  return client;
}

// Per-user download queue — max 3 concurrent downloads to avoid Telegram rate limits
const MAX_CONCURRENT = 3;
const userQueues = new Map(); // userId -> { active: number, queue: Array<fn> }

function enqueueDownload(userId, fn) {
  if (!userQueues.has(userId)) userQueues.set(userId, { active: 0, queue: [] });
  const q = userQueues.get(userId);
  return new Promise((resolve, reject) => {
    const wrapped = async () => {
      q.active++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally {
        q.active--;
        if (q.queue.length > 0) q.queue.shift()();
      }
    };
    if (q.active < MAX_CONCURRENT) wrapped();
    else q.queue.push(wrapped);
  });
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  const tokenFromQuery = req.query.token;
  const raw = header?.startsWith('Bearer ') ? header.slice(7) : tokenFromQuery;
  if (!raw) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(raw, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'telegram-download-service' }));

// Stream a single Telegram media file to the browser, with Range support for resume
app.get('/download/file', requireAuth, async (req, res) => {
  const { groupId, messageId } = req.query;
  if (!groupId || !messageId) {
    return res.status(400).json({ error: 'groupId and messageId are required' });
  }

  const t0 = Date.now();

  await enqueueDownload(req.userId, async () => {
    let client;
    try {
      client = await getClientForUser(req.userId);
      console.log(`[download] client ready in ${Date.now() - t0}ms (groupId=${groupId} messageId=${messageId})`);

      let entity;
      try {
        entity = await client.getEntity(new Api.PeerChannel({ channelId: BigInt(groupId) }));
      } catch {
        try {
          entity = await client.getEntity(new Api.PeerChat({ chatId: BigInt(groupId) }));
        } catch {
          res.status(404).json({ error: 'Group not found' });
          return;
        }
      }

      const [msg] = await client.getMessages(entity, { ids: [Number.parseInt(String(messageId))] });
      if (!msg?.media) { res.status(404).json({ error: 'No media in this message' }); return; }

      let fileName, mimeType = 'application/octet-stream', fileSize = 0;

      if (msg.media.className === 'MessageMediaDocument') {
        const doc = msg.media.document;
        const fnAttr = (doc?.attributes || []).find(a => a.className === 'DocumentAttributeFilename');
        fileName = fnAttr?.fileName || `file_${messageId}.${(doc?.mimeType || '').split('/')[1] || 'bin'}`;
        mimeType = doc?.mimeType || mimeType;
        fileSize = doc?.size ? Number(doc.size) : 0;
      } else if (msg.media.className === 'MessageMediaPhoto') {
        fileName = `photo_${messageId}.jpg`;
        mimeType = 'image/jpeg';
      } else {
        res.status(422).json({ error: 'Unsupported media type' });
        return;
      }

      console.log(`[download] ${fileName} — ${(fileSize / 1024 / 1024).toFixed(1)}MB`);

      // Parse Range header for resume support (browser sends this after a disconnect)
      const rangeHeader = req.headers['range'];
      let startByte = 0;
      if (rangeHeader && fileSize > 0) {
        const match = rangeHeader.match(/bytes=(\d+)-/);
        if (match) startByte = parseInt(match[1], 10);
      }

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Cache-Control', 'no-store');

      if (startByte > 0 && fileSize > 0) {
        // Resuming — 206 Partial Content
        res.setHeader('Content-Range', `bytes ${startByte}-${fileSize - 1}/${fileSize}`);
        res.setHeader('Content-Length', fileSize - startByte);
        res.status(206);
        console.log(`[download] resuming from byte ${startByte} (${(startByte / 1024 / 1024).toFixed(1)}MB already done)`);
      } else if (fileSize > 0) {
        res.setHeader('Content-Length', fileSize);
        res.status(200);
      } else {
        res.setHeader('Transfer-Encoding', 'chunked');
        res.status(200);
      }

      let aborted = false;
      req.on('close', () => { aborted = true; console.log(`[download] client disconnected at ${(totalBytes / 1024 / 1024).toFixed(1)}MB`); });

      let totalBytes = 0;
      let chunkCount = 0;
      let skipped = 0;

      // Calculate which gramjs chunk offset to start from
      const CHUNK_SIZE = 512 * 1024; // 512KB per gramjs chunk
      const skipChunks = Math.floor(startByte / CHUNK_SIZE);
      const skipBytesInChunk = startByte % CHUNK_SIZE;

      for await (const chunk of iterDownload(client, { file: msg.media })) {
        if (aborted) break;

        // Skip already-downloaded chunks when resuming
        if (skipped < skipChunks) { skipped++; continue; }

        let data = chunk;
        // Trim the first partial chunk when resuming mid-chunk
        if (skipped === skipChunks && skipBytesInChunk > 0 && totalBytes === 0) {
          data = chunk.slice(skipBytesInChunk);
          skipped++; // mark as handled
        }

        chunkCount++;
        totalBytes += data.length;

        if (chunkCount === 1) {
          console.log(`[download] FIRST chunk after ${Date.now() - t0}ms — ${data.length} bytes`);
        } else if (chunkCount % 20 === 0) {
          const elapsed = Date.now() - t0;
          const mbps = ((totalBytes / 1024 / 1024) / (elapsed / 1000)).toFixed(2);
          console.log(`[download] chunk #${chunkCount}, total=${((startByte + totalBytes) / 1024 / 1024).toFixed(1)}MB, speed=${mbps}MB/s`);
        }

        const ok = res.write(data);
        if (!ok) await new Promise(resolve => res.once('drain', resolve));
      }

      const elapsed = Date.now() - t0;
      console.log(`[download] done — ${(totalBytes / 1024 / 1024).toFixed(1)}MB in ${(elapsed / 1000).toFixed(1)}s`);

      if (!aborted) {
        res.end();
        // Only log to DB when download completes fully
        if (startByte + totalBytes >= fileSize * 0.99) {
          fetch(`${DB_SERVICE_URL}/downloads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: req.userId, groupId, messageId, fileName, fileSize: fileSize || totalBytes }),
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`[download] ERROR groupId=${groupId} messageId=${messageId}:`, err.message);
      if (!res.headersSent) {
        res.status(err.code || 500).json({ error: err.message });
      } else {
        res.destroy();
      }
    }
  });
});

app.listen(PORT, () => {
  console.log(`[telegram-download-service] running on port ${PORT}`);
}).on('connection', socket => {
  socket.setTimeout(0);
});
