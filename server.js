import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import db, { testDbConnection } from './config/db.js';

import authRoutes from './routes/authRoutes.js';
import headsetRoutes from './routes/headsetRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import agentRoutes from './routes/agentRoutes.js';
import assignmentRoutes from './routes/assignmentRoutes.js';
import depositRoutes from './routes/depositRoutes.js';
import repairRoutes from './routes/repairRoutes.js';
import transferRoutes from './routes/transferRoutes.js';
import pdfRoutes from './routes/pdfRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import processRoutes from './routes/processRoutes.js';
//import yjackRoutes from './routes/yjackRoutes.js';
import refundRoutes from './routes/refundRoutes.js';

dotenv.config();

process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ unhandledRejection:', err);
});

const app = express();
app.set('trust proxy', 1);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadRoot = process.env.UPLOAD_ROOT
  ? path.resolve(process.env.UPLOAD_ROOT)
  : path.join(__dirname, 'uploads');

const uploadDirs = [
  path.join(uploadRoot, 'headset-images'),
  path.join(uploadRoot, 'signatures'),
  path.join(uploadRoot, 'pdfs')
];

uploadDirs.forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Created directory: ${dir}`);
  }
});

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://abss.abss.co.in',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (process.env.NODE_ENV !== 'production' && origin.startsWith('http://192.168.')) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/uploads/pdfs/:file', (req, res) => {
  const filePath = path.join(uploadRoot, 'pdfs', req.params.file);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  if (req.query.download === '1') {
    return res.download(filePath, req.params.file);
  }

  return res.sendFile(filePath);
});

app.get('/debug/upload-file', async (req, res) => {
  try {
    const rel = String(req.query.path || '');
    if (!rel.startsWith('/uploads/')) {
      return res.status(400).json({ success: false, message: 'path must start with /uploads/' });
    }

    const abs = path.join(uploadRoot, rel.replace(/^\/uploads\//, ''));
    if (!fs.existsSync(abs)) {
      return res.status(404).json({ success: false, message: 'file not found', abs });
    }

    const stat = fs.statSync(abs);
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(32);
    fs.readSync(fd, buf, 0, 32, 0);
    fs.closeSync(fd);

    res.json({
      success: true,
      abs,
      size: stat.size,
      firstBytesHex: buf.toString('hex'),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.use('/uploads', express.static(uploadRoot));

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Headset backend running'
  });
});

app.get('/health', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT 1 AS ok');
    res.json({
      success: true,
      message: 'Health OK',
      db: rows?.[0]?.ok === 1,
      uploadRoot,
      frontend: process.env.FRONTEND_URL || null,
      nodeEnv: process.env.NODE_ENV || null
    });
  } catch (err) {
    console.error('DB health error:', err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/headsets', headsetRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/deposits', depositRoutes);
app.use('/api/repairs', repairRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api/pdfs', pdfRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/processes', processRoutes);
//app.use('/api/yjack', yjackRoutes);
app.use('/api/refunds', refundRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

app.use((err, req, res, next) => {
  console.error('❌ Express error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error'
  });
});

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Server listening on ${PORT}`);
  try {
    await testDbConnection();
  } catch (err) {
    console.error('❌ Initial DB connection test failed:', err);
  }
});