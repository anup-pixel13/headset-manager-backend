import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import db from './config/db.js';

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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/uploads', express.static(uploadRoot));

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Backend running'
  });
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

// ---- route loading with logs ----
try {
  const authRoutes = (await import('./routes/authRoutes.js')).default;
  app.use('/api/auth', authRoutes);
  console.log('✅ Loaded authRoutes');
} catch (err) {
  console.error('❌ Failed loading authRoutes:', err);
}

try {
  const headsetRoutes = (await import('./routes/headsetRoutes.js')).default;
  app.use('/api/headsets', headsetRoutes);
  console.log('✅ Loaded headsetRoutes');
} catch (err) {
  console.error('❌ Failed loading headsetRoutes:', err);
}

try {
  const dashboardRoutes = (await import('./routes/dashboardRoutes.js')).default;
  app.use('/api/dashboard', dashboardRoutes);
  console.log('✅ Loaded dashboardRoutes');
} catch (err) {
  console.error('❌ Failed loading dashboardRoutes:', err);
}

try {
  const agentRoutes = (await import('./routes/agentRoutes.js')).default;
  app.use('/api/agents', agentRoutes);
  console.log('✅ Loaded agentRoutes');
} catch (err) {
  console.error('❌ Failed loading agentRoutes:', err);
}

try {
  const assignmentRoutes = (await import('./routes/assignmentRoutes.js')).default;
  app.use('/api/assignments', assignmentRoutes);
  console.log('✅ Loaded assignmentRoutes');
} catch (err) {
  console.error('❌ Failed loading assignmentRoutes:', err);
}

try {
  const depositRoutes = (await import('./routes/depositRoutes.js')).default;
  app.use('/api/deposits', depositRoutes);
  console.log('✅ Loaded depositRoutes');
} catch (err) {
  console.error('❌ Failed loading depositRoutes:', err);
}

try {
  const repairRoutes = (await import('./routes/repairRoutes.js')).default;
  app.use('/api/repairs', repairRoutes);
  console.log('✅ Loaded repairRoutes');
} catch (err) {
  console.error('❌ Failed loading repairRoutes:', err);
}

try {
  const transferRoutes = (await import('./routes/transferRoutes.js')).default;
  app.use('/api/transfers', transferRoutes);
  console.log('✅ Loaded transferRoutes');
} catch (err) {
  console.error('❌ Failed loading transferRoutes:', err);
}

try {
  const pdfRoutes = (await import('./routes/pdfRoutes.js')).default;
  app.use('/api/pdfs', pdfRoutes);
  console.log('✅ Loaded pdfRoutes');
} catch (err) {
  console.error('❌ Failed loading pdfRoutes:', err);
}

try {
  const reportRoutes = (await import('./routes/reportRoutes.js')).default;
  app.use('/api/reports', reportRoutes);
  console.log('✅ Loaded reportRoutes');
} catch (err) {
  console.error('❌ Failed loading reportRoutes:', err);
}

try {
  const processRoutes = (await import('./routes/processRoutes.js')).default;
  app.use('/api/processes', processRoutes);
  console.log('✅ Loaded processRoutes');
} catch (err) {
  console.error('❌ Failed loading processRoutes:', err);
}

try {
  const yjackRoutes = (await import('./routes/yjackRoutes.js')).default;
  app.use('/api/yjack', yjackRoutes);
  console.log('✅ Loaded yjackRoutes');
} catch (err) {
  console.error('❌ Failed loading yjackRoutes:', err);
}

try {
  const refundRoutes = (await import('./routes/refundRoutes.js')).default;
  app.use('/api/refunds', refundRoutes);
  console.log('✅ Loaded refundRoutes');
} catch (err) {
  console.error('❌ Failed loading refundRoutes:', err);
}

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
  console.log(`✅ Server listening on ${PORT}`);
});