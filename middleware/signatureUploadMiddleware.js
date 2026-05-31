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

const signaturesDir = path.join(uploadRoot, 'signatures');

if (!fs.existsSync(signaturesDir)) fs.mkdirSync(signaturesDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, signaturesDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? ext : '.png';

    const assignmentId = req.params?.id || 'assignment';
    const role = (req.body?.signer_role || 'unknown').toString().toLowerCase();
    const stamp = Date.now();
    cb(null, `assign_${assignmentId}_${role}_${stamp}${safeExt}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
  if (!allowed.includes(file.mimetype)) return cb(new Error('Only PNG/JPG/WEBP images are allowed'), false);
  cb(null, true);
};

export const signatureUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 } // 3MB
}).single('signature');