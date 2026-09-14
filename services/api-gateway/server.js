require('dotenv').config();
const express = require('express');
const { legacyCreateProxyMiddleware: proxy } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

const AUTH_URL     = process.env.AUTH_SERVICE_URL     || 'http://localhost:3001';
const READ_URL     = process.env.READ_SERVICE_URL     || 'http://localhost:3002';
const DOWNLOAD_URL = process.env.DOWNLOAD_SERVICE_URL || 'http://localhost:3003';
const GUP_URL      = process.env.GUPLOAD_SERVICE_URL  || 'http://localhost:3004';
const GDWN_URL     = process.env.GDOWNLOAD_SERVICE_URL|| 'http://localhost:3005';

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'api-gateway' }));

app.use('/auth', proxy({ target: AUTH_URL, changeOrigin: true, pathRewrite: { '^/auth': '' } }));
app.use('/groups', proxy({ target: READ_URL, changeOrigin: true }));
app.use('/download', proxy({ target: DOWNLOAD_URL, changeOrigin: true }));
app.use('/google/upload', proxy({ target: GUP_URL, changeOrigin: true, pathRewrite: { '^/google/upload': '/upload' } }));
app.use('/google/download', proxy({ target: GDWN_URL, changeOrigin: true, pathRewrite: { '^/google/download': '/download' } }));

app.listen(PORT, () => console.log(`[api-gateway] running on port ${PORT}`));
