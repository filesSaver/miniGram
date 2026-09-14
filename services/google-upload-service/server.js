require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3004;

app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'google-upload-service' }));

// TODO: implement Google Drive upload using googleapis SDK
app.post('/upload', (req, res) => {
  const { fileName } = req.body;
  if (!fileName) return res.status(400).json({ error: 'fileName is required' });
  res.json({ message: 'Upload queued', fileName });
});

app.listen(PORT, () => console.log(`[google-upload-service] running on port ${PORT}`));
