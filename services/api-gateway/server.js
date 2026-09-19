const express = require('express');
const cors = require('cors');
const { legacyCreateProxyMiddleware: proxy } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow the Angular dev server (port 4200) to call the gateway directly,
// bypassing the dev-proxy which buffers streaming responses.
app.use(cors({
  origin: ['http://localhost:4200', /^https?:\/\/localhost(:\d+)?$/],
  credentials: true,
}));

const AUTH_URL     = process.env.AUTH_SERVICE_URL     || 'http://localhost:3001';
const READ_URL     = process.env.READ_SERVICE_URL     || 'http://localhost:3002';
const DOWNLOAD_URL = process.env.DOWNLOAD_SERVICE_URL || 'http://localhost:3003';
const GUP_URL      = process.env.GUPLOAD_SERVICE_URL  || 'http://localhost:3004';
const GDWN_URL     = process.env.GDOWNLOAD_SERVICE_URL || 'http://localhost:3005';
const DB_URL       = process.env.DB_SERVICE_URL        || 'http://localhost:3006';

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'api-gateway' }));

app.use('/auth', proxy({ target: AUTH_URL, changeOrigin: true, pathRewrite: { '^/auth': '' } }));
app.use('/groups', proxy({ target: READ_URL, changeOrigin: true }));
app.use('/download/log-db', proxy({ target: DB_URL, changeOrigin: true, pathRewrite: { '^/download/log-db': '/downloads' } }));
app.use('/download/counts-db', proxy({ target: DB_URL, changeOrigin: true, pathRewrite: { '^/download/counts-db': '/downloads/counts' } }));
app.use('/download', proxy({
  target: DOWNLOAD_URL,
  changeOrigin: true,
  proxyTimeout: 0,      // no proxy-level timeout for large file downloads
  timeout: 0,
}));
app.use('/google/upload', proxy({ target: GUP_URL, changeOrigin: true, pathRewrite: { '^/google/upload': '/upload' } }));
app.use('/google/download', proxy({ target: GDWN_URL, changeOrigin: true, pathRewrite: { '^/google/download': '/download' } }));

app.listen(PORT, () => console.log(`[api-gateway] running on port ${PORT}`));
