import multer from 'multer';
import path from 'path';
import fs from 'fs';

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

// Railway / fresh deploylarda uploads/ klasörü olmaya bilər — startup'da yaradırıq
try {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch (err) {
  console.error('uploads/ klasörü yaradılarkən xəta:', err);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `listing-${uniqueSuffix}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB to accommodate HEIC originals
  fileFilter: (_req, file, cb) => {
    // H21 fix: accept HEIC/HEIF (iPhone Camera Roll default format).
    // sharp can decode HEIC and processImages middleware will re-encode to JPEG.
    const allowedExt = /\.(jpe?g|png|webp|heic|heif)$/i;
    const allowedMime = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i;
    const ext = allowedExt.test(file.originalname.toLowerCase());
    const mime = allowedMime.test(file.mimetype) || file.mimetype === 'application/octet-stream';
    if (ext && mime) {
      cb(null, true);
    } else {
      cb(new Error('Yalnızca resim dosyaları yüklenebilir (jpg, png, webp, heic)'));
    }
  },
});
