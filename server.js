import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Load environment variables FIRST
dotenv.config();

// Import routes
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
import yjackRoutes from './routes/yjackRoutes.js';
import refundRoutes from './routes/refundRoutes.js';

const app = express();
app.set('trust proxy', 1);

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Upload root
const uploadRoot = process.env.UPLOAD_ROOT
  ? path.resolve(process.env.UPLOAD_ROOT)
  : path.join(__dirname, 'uploads');

// Create upload directories
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

// ============================================
// CORS
// ============================================
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://abss.abss.co.in',
  process.env.FRONTEND_URL
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    if (process.env.NODE_ENV !== 'production' && origin.startsWith('http://192.168.')) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token'],
  exposedHeaders: ['Content-Length', 'Content-Type']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ============================================
// BODY PARSERS
// ============================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================
// PDF direct download support
// ============================================
app.get('/uploads/pdfs/:file', (req, res, next) => {
  if (req.query.download !== '1') return next();

  const filePath = path.join(uploadRoot, 'pdfs', req.params.file);
  return res.download(filePath, req.params.file);
});

// ============================================
// STATIC FILES
// ============================================
app.use('/uploads', express.static(uploadRoot, {
  maxAge: '7d',
  fallthrough: true
}));

// ============================================
// REQUEST LOGGING
// ============================================
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`📥 ${req.method} ${req.path} - ${timestamp}`);
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    console.log('📦 Body:', JSON.stringify(req.body));
  }
  next();
});

// ============================================
// ROUTES
// ============================================
app.use('/api/yjacks', yjackRoutes);
app.use('/api/refunds', refundRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/headsets', headsetRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/deposits', depositRoutes);
app.use('/api/repairs', repairRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api/pdf', pdfRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/processes', processRoutes);

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'OK',
    message: 'Headset Inventory System is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    database: process.env.DB_NAME,
    frontend: process.env.FRONTEND_URL || null,
    uploadRoot
  });
});

// ============================================
// ROOT ENDPOINT
// ============================================
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Headset Inventory Management System API',
    version: '1.0.0'
  });
});

// ============================================
// 404 HANDLER
// ============================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found`
  });
});

// ============================================
// ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
  console.error('❌ Server Error:', err.message);
  if (res.headersSent) return next(err);

  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
});

// ============================================
// START SERVER
// ============================================
// const PORT = process.env.PORT || 8081;

const PORT = Number(process.env.PORT || 3000);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎧 HEADSET INVENTORY MANAGEMENT SYSTEM');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📍 Port:         ${PORT}`);
  console.log(`🌍 Environment:  ${process.env.NODE_ENV || 'development'}`);
  console.log(`🗄️  Database:     ${process.env.DB_NAME}`);
  console.log(`🖥️  DB Host:      ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}`);
  console.log(`💾 Upload Root:   ${uploadRoot}`);
  console.log(`🌐 Frontend URL:  ${process.env.FRONTEND_URL || 'not set'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

server.on('error', (err) => {
  console.error('❌ Listen error:', err);
  process.exit(1);
});
server.timeout = 120_000;
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received, shutting down gracefully...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('⚠️ SIGINT received, shutting down gracefully...');
  server.close(() => process.exit(0));
});