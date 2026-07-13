import { Request, Response, NextFunction } from 'express';
import { isCloudinaryConfigured, uploadToCloudinary, unlinkLocal } from '../services/cloudinaryStore';

// processImages-dən SONRA işləyir: yerli (optimize olunmuş) şəkilləri Cloudinary-yə
// yükləyir və file.filename-i daimi bulud URL-i ilə əvəz edir. Route handler-lər
// `file.filename`-i images massivinə yazdığı üçün DB-də bulud URL saxlanılır.
// Cloudinary qoşulmayıbsa heç nə etmir — yerli disk davranışı qalır.
// YALNIZ public şəkillərdə istifadə olunur (elan, avatar, obyekt). KYC/vəsiqə
// şəkilləri bu middleware-dən keçmir — onlar məxfi qalır (yerli).
export async function cloudinaryUpload(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!isCloudinaryConfigured()) { next(); return; }
  try {
    const files: Express.Multer.File[] = [];
    if (req.file) files.push(req.file);
    if (Array.isArray(req.files)) files.push(...(req.files as Express.Multer.File[]));
    else if (req.files && typeof req.files === 'object') {
      for (const key of Object.keys(req.files)) {
        const v = (req.files as Record<string, Express.Multer.File[]>)[key];
        if (Array.isArray(v)) files.push(...v);
      }
    }
    for (const f of files) {
      // PDF-lər Cloudinary şəkil kimi yüklənmir — yerli qalır.
      if (/\.pdf$/i.test(f.originalname) || f.mimetype === 'application/pdf') continue;
      try {
        const url = await uploadToCloudinary(f.path, 'listings');
        f.filename = url; // handler bunu images-ə yazır → tam URL
        unlinkLocal(f.path); // yerli surəti sil
      } catch {
        // Yükləmə alınmasa yerli faylı saxla (filename olduğu kimi qalır) — elan yenə işləyir.
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}
