import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import { requirePermission, AuthRequest } from '../middleware/auth';
import { processImages } from '../middleware/imageProcess';
import { pushAdmins } from '../services/live';
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
    const [banners, siteRows] = await Promise.all([
      prisma.banner.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      }),
      prisma.banner.count({ where: { kind: 'SITE' } }),
    ]);
    // siteConfigured=false → admin hələ sayt slaydı seçməyib, frontend hamısını göstərir.
    res.json({ success: true, banners, siteConfigured: siteRows > 0 });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin — bütün bannerlər.
router.get('/admin/banners', requirePermission('banners'), async (_req: AuthRequest, res: Response) => {
  try {
    const banners = await prisma.banner.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }] });
    res.json({ success: true, banners });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin — banner yarat (şəkil yüklə).
router.post('/admin/banners', requirePermission('banners'), bannerImage, processImages, async (req: AuthRequest, res: Response) => {
  try {
    const file = (req as any).file;
    if (!file) { res.status(400).json({ success: false, message: 'Şəkil tələb olunur' }); return; }
    const banner = await prisma.banner.create({
      data: {
        image: file.filename,
        position: req.body.position === 'SIDE' ? 'SIDE' : 'MAIN',
        link: req.body.link ? String(req.body.link).trim() : null,
        title: req.body.title ? String(req.body.title).trim() : null,
        subtitle: req.body.subtitle ? String(req.body.subtitle).trim().slice(0, 160) : null,
        ctaLabel: req.body.ctaLabel ? String(req.body.ctaLabel).trim().slice(0, 40) : null,
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
router.put('/admin/banners/:id', requirePermission('banners'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const data: any = {};
    if (req.body.active !== undefined) data.active = req.body.active === true || req.body.active === 'true';
    if (req.body.link !== undefined) data.link = req.body.link ? String(req.body.link).trim() : null;
    if (req.body.title !== undefined) data.title = req.body.title ? String(req.body.title).trim() : null;
    if (req.body.sortOrder !== undefined) data.sortOrder = parseInt(String(req.body.sortOrder)) || 0;
    if (req.body.position !== undefined) data.position = req.body.position === 'SIDE' ? 'SIDE' : 'MAIN';
    if (req.body.subtitle !== undefined) data.subtitle = req.body.subtitle ? String(req.body.subtitle).trim().slice(0, 160) : null;
    if (req.body.ctaLabel !== undefined) data.ctaLabel = req.body.ctaLabel ? String(req.body.ctaLabel).trim().slice(0, 40) : null;
    const banner = await prisma.banner.update({ where: { id }, data });
    res.json({ success: true, banner });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin — saytın hazır dizayn slaydını karuselə əlavə et (şəkil yüklənmir).
// Mətn/link boş qalırsa frontend slaydın öz mətnini göstərir.
router.post('/admin/banners/site', requirePermission('banners'), async (req: AuthRequest, res: Response) => {
  try {
    const siteKey = String(req.body?.siteKey || '').trim();
    if (!/^[a-z0-9_-]{2,40}$/.test(siteKey)) { res.status(400).json({ success: false, message: 'Slayd seçin' }); return; }
    const exists = await prisma.banner.findFirst({ where: { kind: 'SITE', siteKey } });
    if (exists) { res.status(400).json({ success: false, message: 'Bu slayd artıq karuseldədir' }); return; }
    const last = await prisma.banner.findFirst({ where: { position: 'MAIN' }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    const banner = await prisma.banner.create({
      data: { kind: 'SITE', siteKey, image: '', position: 'MAIN', active: true, sortOrder: (last?.sortOrder ?? -1) + 1 },
    });
    pushAdmins('banner', { id: banner.id });
    res.status(201).json({ success: true, banner });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin — sıranı toplu yenilə (sürüşdür / yuxarı-aşağı).
router.put('/admin/banners-order', requirePermission('banners'), async (req: AuthRequest, res: Response) => {
  try {
    const ids: number[] = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0).slice(0, 200);
    await prisma.$transaction(ids.map((id, i) => prisma.banner.update({ where: { id }, data: { sortOrder: i } })));
    pushAdmins('banner', {});
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin — banner sil (+ fayl).
router.delete('/admin/banners/:id', requirePermission('banners'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const b = await prisma.banner.findUnique({ where: { id } });
    if (b?.image && b.kind !== 'SITE') { try { fs.unlinkSync(path.join(UPLOADS_DIR, b.image)); } catch { /* fayl yoxdur */ } }
    await prisma.banner.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
