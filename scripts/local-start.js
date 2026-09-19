#!/usr/bin/env node
// Starts all microservices + Angular dev server locally.
// Requires: npm run local:db (postgres in Docker) to be running first.
// NOTE: Run `docker compose down` first if the full Docker stack is up — it occupies the same ports.
// Usage: npm run local:start

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Warn if full Docker stack is competing for ports
try {
  const running = execSync('docker ps --format "{{.Names}}"', { stdio: ['ignore','pipe','ignore'] }).toString();
  const conflicting = ['db-service','auth-service','api-gateway','telegram-read-service','telegram-download-service','ui-service']
    .filter(name => running.includes(name));
  if (conflicting.length > 0) {
    console.error(`\x1b[31m[local-start] ERROR: Docker containers are occupying the same ports: ${conflicting.join(', ')}\x1b[0m`);
    console.error('\x1b[33m[local-start] Run: docker compose down   — then retry npm run local:start\x1b[0m');
    process.exit(1);
  }
} catch (_) { /* docker not available, skip check */ }

// Free any ports left over from a previous local run
const LOCAL_PORTS = [3000, 3001, 3002, 3003, 3004, 3005, 3006, 4200];
for (const port of LOCAL_PORTS) {
  try {
    const pids = execSync(`lsof -ti :${port}`, { stdio: ['ignore','pipe','ignore'] }).toString().trim();
    if (pids) {
      pids.split('\n').forEach(pid => {
        try { process.kill(Number(pid), 'SIGTERM'); } catch (_) {}
      });
      console.log(`[local-start] freed port ${port}`);
    }
  } catch (_) { /* port was already free */ }
}

// Load .env.local
const envFile = path.join(__dirname, '..', '.env.local');
if (!fs.existsSync(envFile)) {
  console.error('[local-start] Missing .env.local — copy .env.local and fill in values');
  process.exit(1);
}

const envVars = {};
fs.readFileSync(envFile, 'utf8')
  .split('\n')
  .filter(l => l && !l.startsWith('#'))
  .forEach(l => {
    const idx = l.indexOf('=');
    if (idx === -1) return;
    const key = l.slice(0, idx).trim();
    const val = l.slice(idx + 1).trim();
    envVars[key] = val;
  });

const base = { ...process.env, ...envVars };

const DB_URL  = envVars.DATABASE_URL  || 'postgresql://postgres:postgres@localhost:5432/minigram';
const JWT     = envVars.JWT_SECRET    || 'local-dev-secret-change-me';
const ROOT    = path.join(__dirname, '..');

const services = [
  {
    name: 'db-service',
    cwd: path.join(ROOT, 'services/db-service'),
    env: { ...base, PORT: '3006', DATABASE_URL: DB_URL },
  },
  {
    name: 'auth-service',
    cwd: path.join(ROOT, 'services/auth-service'),
    env: { ...base, PORT: '3001', DB_SERVICE_URL: 'http://localhost:3006', JWT_SECRET: JWT },
  },
  {
    name: 'tg-read',
    cwd: path.join(ROOT, 'services/telegram-read-service'),
    env: { ...base, PORT: '3002', JWT_SECRET: JWT, DB_SERVICE_URL: 'http://localhost:3006' },
  },
  {
    name: 'tg-download',
    cwd: path.join(ROOT, 'services/telegram-download-service'),
    env: {
      ...base,
      PORT: '3003',
      JWT_SECRET: JWT,
      DB_SERVICE_URL: 'http://localhost:3006',
      DOWNLOADS_DESKTOP: envVars.DOWNLOADS_DESKTOP || `${process.env.HOME}/Desktop`,
      DOWNLOADS_DOWNLOADS: envVars.DOWNLOADS_DOWNLOADS || `${process.env.HOME}/Downloads`,
      DOWNLOADS_CUSTOM: path.join(ROOT, 'downloads/Custom'),
    },
  },
  {
    name: 'gateway',
    cwd: path.join(ROOT, 'services/api-gateway'),
    env: {
      ...base,
      PORT: '3000',
      AUTH_SERVICE_URL: 'http://localhost:3001',
      READ_SERVICE_URL: 'http://localhost:3002',
      DOWNLOAD_SERVICE_URL: 'http://localhost:3003',
      GUPLOAD_SERVICE_URL: 'http://localhost:3004',
      GDOWNLOAD_SERVICE_URL: 'http://localhost:3005',
      DB_SERVICE_URL: 'http://localhost:3006',
    },
  },
  {
    name: 'ui',
    cwd: path.join(ROOT, 'services/ui-service'),
    cmd: ['npm', 'start'],
    env: { ...base },
  },
];

// ANSI colours per service
const COLORS = ['\x1b[36m', '\x1b[32m', '\x1b[33m', '\x1b[35m', '\x1b[34m', '\x1b[96m'];
const RESET = '\x1b[0m';

const procs = [];

function spawnService(svc, i) {
  const color = COLORS[i % COLORS.length];
  const prefix = `${color}[${svc.name}]${RESET} `;

  const cmd = svc.cmd || ['node', 'server.js'];
  const proc = spawn(cmd[0], cmd.slice(1), {
    cwd: svc.cwd,
    env: svc.env,
    shell: false,
  });

  procs.push(proc);

  proc.stdout.on('data', d => process.stdout.write(prefix + d.toString().replaceAll('\n', `\n${prefix}`)));
  proc.stderr.on('data', d => process.stderr.write(prefix + d.toString().replaceAll('\n', `\n${prefix}`)));
  proc.on('exit', code => {
    if (code !== 0 && code !== null) {
      console.error(`${prefix}exited with code ${code}`);
    }
  });
}

// Spawn backend services immediately; delay UI slightly so freed port 4200 is released
services.forEach((svc, i) => {
  if (svc.name === 'ui') {
    setTimeout(() => spawnService(svc, i), 500);
  } else {
    spawnService(svc, i);
  }
});

const shutdown = () => {
  console.log('\n[local-start] Shutting down all services...');
  procs.forEach(p => p.kill('SIGTERM'));
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('[local-start] All services started. Angular UI → http://localhost:4200  |  Gateway → http://localhost:3000');
console.log('[local-start] Press Ctrl+C to stop all.\n');
