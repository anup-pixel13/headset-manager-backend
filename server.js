import express from 'express';

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.get('/', (req, res) => {
  res.json({ success: true, message: 'Minimal server running' });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Health OK',
    port: PORT,
    nodeEnv: process.env.NODE_ENV || null
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Minimal app listening on ${PORT}`);
});