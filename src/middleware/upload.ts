import multer from 'multer';
import path from 'path';
import fs from 'fs';

// Şəkillərin saxlandığı qovluq. Railway persistent Volume mount ediləndə
// avtomatik RAILWAY_VOLUME_MOUNT_PATH qoyulur — bu halda şəkillər deploy-lar
// arasında SİLİNMİR. UPLOADS_DIR əl ilə də verilə bilər.
export const UPLOADS_DIR =
  process.env.UPLOADS_DIR ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads') : path.join(__dirname, '../../uploads'));

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

// Çat media üçün: şəkil, səs, video və sənəd (WhatsApp kimi). Fayllar "chat-" prefiksi ilə saxlanır.
const chatStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `chat-${uniqueSuffix}${ext}`);
  },
});

export const chatUpload = multer({
  storage: chatStorage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB (səs/video/sənəd)
  fileFilter: (_req, file, cb) => {
    const mime = file.mimetype || '';
    const name = file.originalname.toLowerCase();
    const okMime =
      /^(image|audio|video)\//.test(mime) ||
      mime === 'application/pdf' ||
      mime === 'application/msword' ||
      mime.startsWith('application/vnd.openxmlformats-officedocument') ||
      mime === 'application/vnd.ms-excel' ||
      mime === 'application/vnd.ms-powerpoint' ||
      mime === 'text/plain' ||
      mime === 'application/zip' ||
      mime === 'application/x-zip-compressed';
    const okExt = /\.(jpe?g|png|webp|heic|heif|gif|mp3|m4a|aac|ogg|opus|wav|webm|mp4|mov|3gp|pdf|docx?|xlsx?|pptx?|txt|zip)$/i.test(name);
    // Mobil klientlər bəzən octet-stream göndərir — yalnız icazəli uzantı varsa qəbul et.
    if (okMime || (mime === 'application/octet-stream' && okExt) || okExt) cb(null, true);
    else cb(new Error('Bu fayl növü dəstəklənmir'));
  },
});

// Biznes sənədləri üçün: şəkillərə əlavə PDF də qəbul edir (vergi/bank sənədi PDF ola bilər).
export const docUpload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB (PDF-lər üçün)
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const isImgExt = /\.(jpe?g|png|webp|heic|heif)$/i.test(name);
    const isPdfExt = /\.pdf$/i.test(name);
    const imgMime = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(file.mimetype);
    const pdfMime = file.mimetype === 'application/pdf';
    // octet-stream yalnız şəkil uzantıları üçün etibarlıdır (bəzi mobil klientlər belə göndərir);
    // PDF üçün mütləq real application/pdf mime tələb olunur — disguise qarşısını alır.
    const ok =
      (isImgExt && (imgMime || file.mimetype === 'application/octet-stream')) ||
      (isPdfExt && pdfMime);
    if (ok) cb(null, true);
    else cb(new Error('Yalnız şəkil və ya PDF yüklənə bilər'));
  },
});
