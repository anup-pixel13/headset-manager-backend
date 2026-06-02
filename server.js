import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

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

app.get('/', (req, res) => {
  res.json({ success: true, message: 'Core app running' });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Core health OK',
    uploadRoot,
    frontend: process.env.FRONTEND_URL || null
  });
});

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Core app listening on ${PORT}`);
});