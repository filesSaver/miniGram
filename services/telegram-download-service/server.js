const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3003;
const JWT_SECRET = process.env.JWT_SECRET;
const DB_SERVICE_URL = process.env.DB_SERVICE_URL || 'http://db-service:3006';

if (!JWT_SECRET) {
  console.error('[telegram-download-service] FATAL: JWT_SECRET is not set');
  process.exit(1);
}

const DEST_PATHS = {
  desktop:   process.env.DOWNLOADS_DESKTOP   || path.join(__dirname, 'downloads', 'Desktop'),
  downloads: process.env.DOWNLOADS_DOWNLOADS || path.join(__dirname, 'downloads', 'Downloads'),
  custom:    process.env.DOWNLOADS_CUSTOM    || path.join(__dirname, 'downloads', 'Custom'),
};

app.use(express.json());

async function getUserConfig(userId) {
  const res = await fetch(`${DB_SERVICE_URL}/users/${userId}`);
  if (!res.ok) throw Object.assign(new Error(`db-service fetch failed: ${res.status}`), { code: 503 });
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

function sanitizeFolderName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download';
}

function logPath(destDir) {
  return path.join(destDir, '.download-log.json');
}

function readLog(destDir) {
  try {
    return JSON.parse(fs.readFileSync(logPath(destDir), 'utf8'));
  } catch {
    return {};
  }
}

function writeLog(destDir, log) {
  fs.writeFileSync(logPath(destDir), JSON.stringify(log, null, 2));
}

function countsPath(baseDir) {
  return path.join(baseDir, '.download-counts.json');
}

function readCounts(baseDir) {
  try {
    return JSON.parse(fs.readFileSync(countsPath(baseDir), 'utf8'));
  } catch {
    return {};
  }
}

function incrementCount(baseDir, groupId) {
  const counts = readCounts(baseDir);
  counts[groupId] = (counts[groupId] || 0) + 1;
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(countsPath(baseDir), JSON.stringify(counts, null, 2));
}

const jobs = new Map();

function makeJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function runDownloadJob(jobId, userId, groupId, groupName, messageIds, destKey) {
  const job = jobs.get(jobId);
  const baseDir = DEST_PATHS[destKey] || DEST_PATHS.downloads;
  const folderName = sanitizeFolderName(groupName || groupId);
  const destDir = path.join(baseDir, folderName);
  fs.mkdirSync(destDir, { recursive: true });
  job.folder = destDir;

  for (const id of messageIds) {
    job.itemStatus[id] = 'queued';
    job.itemProgress[id] = { pct: 0, downloaded: 0, total: 0 };
  }

  const log = readLog(destDir);

  let c;
  try {
    c = await getClientForUser(userId);
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    return;
  }

  try {
    const dialogs = await c.getDialogs({});
    const dialog = dialogs.find(
      d => (d.entity instanceof Api.Chat || d.entity instanceof Api.Channel) &&
           d.entity.id.toString() === String(groupId)
    );
    if (!dialog) {
      job.status = 'failed';
      job.error = 'Group not found';
      return;
    }

    for (const msgId of messageIds) {
      if (log[msgId]?.status === 'done') {
        job.itemStatus[msgId] = 'done';
        job.itemProgress[msgId] = { pct: 100, downloaded: log[msgId].fileSize || 0, total: log[msgId].fileSize || 0 };
        job.results.push({ messageId: msgId, status: 'ok', fileName: log[msgId].fileName, filePath: log[msgId].filePath, skippedAlreadyDone: true });
        job.downloaded++;
        job.done++;
        continue;
      }

      job.itemStatus[msgId] = 'downloading';
      job.itemProgress[msgId] = { pct: 0, downloaded: 0, total: 0 };

      try {
        const [msg] = await c.getMessages(dialog.entity, { ids: [Number.parseInt(String(msgId))] });
        if (!msg || !msg.media) {
          job.itemStatus[msgId] = 'skipped';
          job.results.push({ messageId: msgId, status: 'skipped', reason: 'no media' });
          log[msgId] = { status: 'skipped', ts: Date.now() };
          job.done++;
          continue;
        }

        let fileName;
        let totalSize = 0;

        if (msg.media.className === 'MessageMediaDocument') {
          const attrs = msg.media.document?.attributes || [];
          const fnAttr = attrs.find(a => a.className === 'DocumentAttributeFilename');
          fileName = fnAttr?.fileName || null;
          totalSize = msg.media.document?.size ? Number(msg.media.document.size) : 0;
          if (!fileName) {
            const mime = msg.media.document?.mimeType || '';
            const ext = mime.split('/')[1] || 'bin';
            fileName = `file_${msgId}.${ext}`;
          }
        } else if (msg.media.className === 'MessageMediaPhoto') {
          fileName = `photo_${msgId}.jpg`;
        } else {
          job.itemStatus[msgId] = 'skipped';
          job.results.push({ messageId: msgId, status: 'skipped', reason: 'unsupported media type' });
          log[msgId] = { status: 'skipped', ts: Date.now() };
          job.done++;
          continue;
        }

        job.itemProgress[msgId].total = totalSize;

        const filePath = path.join(destDir, fileName);

        const buffer = await c.downloadMedia(msg, {
          progressCallback: (dl, tot) => {
            const downloaded = Number(dl);
            const total = Number(tot) || totalSize;
            job.itemProgress[msgId] = {
              pct: total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0,
              downloaded,
              total,
            };
          },
        });

        if (!buffer || buffer.length === 0) {
          job.itemStatus[msgId] = 'error';
          job.results.push({ messageId: msgId, status: 'failed', reason: 'empty download' });
          log[msgId] = { status: 'error', ts: Date.now() };
        } else {
          fs.writeFileSync(filePath, buffer);
          job.itemStatus[msgId] = 'done';
          job.itemProgress[msgId] = { pct: 100, downloaded: buffer.length, total: buffer.length };
          job.results.push({ messageId: msgId, status: 'ok', fileName, filePath });
          log[msgId] = { status: 'done', fileName, filePath, fileSize: buffer.length, ts: Date.now() };
          job.downloaded++;
          incrementCount(baseDir, groupId);
        }
      } catch (err) {
        job.itemStatus[msgId] = 'error';
        job.results.push({ messageId: msgId, status: 'failed', reason: err.message });
        log[msgId] = { status: 'error', reason: err.message, ts: Date.now() };
      }

      job.done++;
      writeLog(destDir, log);
    }

    job.status = 'done';
    writeLog(destDir, log);
  } finally {
    c?.disconnect().catch(() => {});
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'telegram-download-service' }));

app.get('/download/locations', requireAuth, (req, res) => {
  res.json({
    desktop:   DEST_PATHS.desktop,
    downloads: DEST_PATHS.downloads,
    custom:    DEST_PATHS.custom,
  });
});

app.get('/download/counts', requireAuth, (req, res) => {
  const merged = {};
  for (const baseDir of Object.values(DEST_PATHS)) {
    const counts = readCounts(baseDir);
    for (const [gid, n] of Object.entries(counts)) {
      merged[gid] = (merged[gid] || 0) + n;
    }
  }
  res.json(merged);
});

app.get('/download/log/:destKey/:groupFolder', requireAuth, (req, res) => {
  const baseDir = DEST_PATHS[req.params.destKey] || DEST_PATHS.downloads;
  const destDir = path.join(baseDir, req.params.groupFolder);
  res.json(readLog(destDir));
});

app.post('/download/batch', requireAuth, (req, res) => {
  const { groupId, groupName, messageIds, destKey } = req.body;
  if (!groupId || !Array.isArray(messageIds) || messageIds.length === 0) {
    return res.status(400).json({ error: 'groupId and messageIds[] are required' });
  }

  const jobId = makeJobId();
  const job = {
    jobId,
    userId: req.userId,
    status: 'running',
    total: messageIds.length,
    done: 0,
    downloaded: 0,
    folder: null,
    results: [],
    itemStatus: {},
    itemProgress: {},
    error: null,
  };
  jobs.set(jobId, job);

  runDownloadJob(jobId, req.userId, groupId, groupName, messageIds, destKey || 'downloads').catch(err => {
    job.status = 'failed';
    job.error = err.message;
  });

  res.json({ jobId, status: 'running', total: messageIds.length });
});

app.get('/download/status/:jobId', requireAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
  res.json(job);
});

app.post('/download/open', requireAuth, (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath is required' });
  const allowed = Object.values(DEST_PATHS);
  if (!allowed.some(d => filePath.startsWith(d))) {
    return res.status(403).json({ error: 'Path not in allowed download directories' });
  }
  execFile('open', [filePath], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.post('/download', requireAuth, (req, res) => {
  const { groupId, messageId } = req.body;
  if (!groupId || !messageId) return res.status(400).json({ error: 'groupId and messageId are required' });
  res.json({ message: 'Use /download/batch for bulk downloads', groupId, messageId });
});

app.listen(PORT, () => console.log(`[telegram-download-service] running on port ${PORT}`));
