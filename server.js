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
//import repairRoutes from './routes/repairRoutes.js';

const app = express();

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Upload directories
const uploadRoot = process.env.UPLOAD_ROOT
  ? path.resolve(process.env.UPLOAD_ROOT)
  : path.join(__dirname, 'uploads');

// Create upload directories
const uploadDirs = [
  path.join(uploadRoot, 'headset-images'),
  path.join(uploadRoot, 'signatures'),
  path.join(uploadRoot, 'pdfs')
];

uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Created directory: ${dir}`);
  }
});

// ============================================
// MIDDLEWARE - ORDER IS CRITICAL!
// ============================================

// 1. CORS - FIRST
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.startsWith('http://192.168.')) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token']
}));

// 2. BODY PARSERS - MUST BE BEFORE ROUTES
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/uploads/pdfs/:file', (req, res, next) => {
  // if not requesting download, let static middleware serve it (view in browser)
  if (req.query.download !== '1') return next();

  const filePath = path.join(uploadRoot, 'pdfs', req.params.file);
  return res.download(filePath, req.params.file);
});
app.use('/api/yjacks', yjackRoutes);
// 3. Static file serving
app.use('/uploads', express.static(uploadRoot));

app.use('/api/refunds', refundRoutes);

// 4. Request logging (AFTER body parsers)
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`📥 ${req.method} ${req.path} - ${timestamp}`);
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    console.log('📦 Body:', JSON.stringify(req.body));
  }
  next();
});

// ============================================
// API ROUTES - AFTER ALL MIDDLEWARE
// ============================================

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
    database: process.env.DB_NAME
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
  res.status(500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 8081;

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎧 HEADSET INVENTORY MANAGEMENT SYSTEM');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📍 Server:       http://localhost:${PORT}`);
  console.log(`🌍 Environment:  ${process.env.NODE_ENV || 'development'}`);
  console.log(`🗄️  Database:     ${process.env.DB_NAME}`);
  console.log(`🖥️  DB Host:      ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 Available Endpoints:');
  console.log('   GET  /health              - Health check');
  console.log('   POST /api/auth/login      - User login');
  console.log('   GET  /api/headsets        - List headsets');
  console.log('   POST /api/headsets        - Add headset');
  console.log('   GET  /api/dashboard/stats - Dashboard stats');
  console.log('   GET  /api/agents          - List agents');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🌐 Network Access IPs:`);
  console.log(`   ${process.env.ALLOWED_IP_RANGES || '192.168.10.0/24,192.168.7.0/24,192.168.9.0/24'}`);
  console.log('━━━━━━━��━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

// Graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));