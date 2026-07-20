import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import { requireAdmin, AuthRequest } from '../middleware/auth';
import { processImages } from '../middleware/imageProcess';
import fs from 'fs';
import path from 'path';

const router = Router();
const prisma = new PrismaClient();

const UPLOADS_DIR =
  process.env.UPLOADS_DIR ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads') : path.join(__dirname, '../../uploads'));

// Banner üçün ayrıca yükləyici — daha böyük limit (banner şəkilləri iri olur) və
// daha geniş şəkil qəbulu. processImages sonra JPEG-ə sıxır.
const bannerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => cb(null, `banner-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || '.jpg'}`),
});
const bannerUpload = multer({
  storage: bannerStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB (iri banner şəkilləri)
  fileFilter: (_req, file, cb) => {
    const okMime = /^image\//i.test(file.mimetype) || file.mimetype === 'application/octet-stream';
    const okExt = /\.(jpe?g|png|webp|heic|heif|gif|avif|bmp)$/i.test(file.originalname);
    if (okMime || okExt) cb(null, true);
    else cb(new Error('Yalnız şəkil faylı yükləyin (jpg, png, webp, gif...)'));
  },
});
// Multer xətasını təmiz JSON-la qaytar (bağlantı sıfırlanmasın → ERR_HTTP2 olmasın).
function bannerImage(req: Request, res: Response, next: NextFunction) {
  bannerUpload.single('image')(req, res, (err: any) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Şəkil çox böyükdür (max 20 MB)' : (err.message || 'Şəkil yüklənmədi');
      res.status(400).json({ success: false, message: msg });
      return;
    }
    next();
  });
}

// Public — ana səhifə karuseli üçün aktiv bannerlər.
router.get('/banners', async (_req: Request, res: Response) => {
  try {
    const banners = await prisma.banner.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
    res.json({ success: true, banners });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin — bütün bannerlər.
router.get('/admin/banners', requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const banners = await prisma.banner.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }] });
    res.json({ success: true, banners });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin — banner yarat (şəkil yüklə).
router.post('/admin/banners', requireAdmin, bannerImage, processImages, async (req: AuthRequest, res: Response) => {
  try {
    const file = (req as any).file;
    if (!file) { res.status(400).json({ success: false, message: 'Şəkil tələb olunur' }); return; }
    const banner = await prisma.banner.create({
      data: {
        image: file.filename,
        position: req.body.position === 'SIDE' ? 'SIDE' : 'MAIN',
        link: req.body.link ? String(req.body.link).trim() : null,
        title: req.body.title ? String(req.body.title).trim() : null,
        active: req.body.active !== 'false',
        sortOrder: req.body.sortOrder ? parseInt(String(req.body.sortOrder)) || 0 : 0,
      },
    });
    res.status(201).json({ success: true, banner });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin — banner yenilə (aktiv/link/başlıq/sıra).
router.put('/admin/banners/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const data: any = {};
    if (req.body.active !== undefined) data.active = req.body.active === true || req.body.active === 'true';
    if (req.body.link !== undefined) data.link = req.body.link ? String(req.body.link).trim() : null;
    if (req.body.title !== undefined) data.title = req.body.title ? String(req.body.title).trim() : null;
    if (req.body.sortOrder !== undefined) data.sortOrder = parseInt(String(req.body.sortOrder)) || 0;
    if (req.body.position !== undefined) data.position = req.body.position === 'SIDE' ? 'SIDE' : 'MAIN';
    const banner = await prisma.banner.update({ where: { id }, data });
    res.json({ success: true, banner });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin — banner sil (+ fayl).
router.delete('/admin/banners/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const b = await prisma.banner.findUnique({ where: { id } });
    if (b?.image) { try { fs.unlinkSync(path.join(UPLOADS_DIR, b.image)); } catch { /* fayl yoxdur */ } }
    await prisma.banner.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
