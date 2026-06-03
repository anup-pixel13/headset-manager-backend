import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '..');
const uploadRoot = process.env.UPLOAD_ROOT
  ? path.resolve(process.env.UPLOAD_ROOT)
  : path.join(projectRoot, 'uploads');

const headsetImagesDir = path.join(uploadRoot, 'headset-images');

if (!fs.existsSync(headsetImagesDir)) {
  fs.mkdirSync(headsetImagesDir, { recursive: true });
}

const mimeToExt = (mimetype) => {
  switch (mimetype) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    default:
      return '.jpg';
  }
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, headsetImagesDir),
  filename: (req, file, cb) => {
    const safeExt = mimeToExt(file.mimetype);

    const base = (req.body?.headset_number || 'HEADSET')
      .toString()
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '');

    const stamp = Date.now();
    const rand = Math.random().toString(16).slice(2, 10);

    cb(null, `${base}_${stamp}_${rand}${safeExt}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error('Only PNG/JPG/WEBP images are allowed'), false);
  }
  cb(null, true);
};

export const headsetImagesUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
}).fields([
  { name: 'image1', maxCount: 1 },
  { name: 'image2', maxCount: 1 },
]);