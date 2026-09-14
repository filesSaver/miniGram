require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3005;

app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'google-download-service' }));

// TODO: implement Google Drive download using googleapis SDK
app.post('/download', (req, res) => {
  const { fileId } = req.body;
  if (!fileId) return res.status(400).json({ error: 'fileId is required' });
  res.json({ message: 'Download queued', fileId });
});

app.listen(PORT, () => console.log(`[google-download-service] running on port ${PORT}`));
