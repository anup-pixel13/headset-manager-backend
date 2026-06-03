import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import db from './config/db.js';
import authRoutes from './routes/authRoutes.js';


//import authRoutes from './routes/authRoutes.js';
import agentRoutes from './routes/agentRoutes.js';
import assignmentRoutes from './routes/assignmentRoutes.js';
import headsetRoutes from './routes/headsetRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
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

['headset-images', 'signatures', 'pdfs'].forEach((folder) => {
  const dir = path.join(uploadRoot, folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static(uploadRoot));



app.use('/api/auth', authRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/headsets', headsetRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/deposits', depositRoutes);
app.use('/api/repairs', repairRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api/pdfs', pdfRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/processes', processRoutes);
//app.use('/api/yjack', yjackRoutes);
app.use('/api/refunds', refundRoutes);


app.get('/', (req, res) => {
  res.json({ success: true, message: 'Backend running' });
});

app.get('/health', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT 1 AS ok');
    res.json({
      success: true,
      db: rows?.[0]?.ok === 1,
      uploadRoot
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server with authRoutes listening on ${PORT}`);
});