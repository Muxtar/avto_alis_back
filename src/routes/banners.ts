import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAdmin, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';
import fs from 'fs';
import path from 'path';

const router = Router();
const prisma = new PrismaClient();

const UPLOADS_DIR =
  process.env.UPLOADS_DIR ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads') : path.join(__dirname, '../../uploads'));

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
router.post('/admin/banners', requireAdmin, upload.single('image'), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const file = (req as any).file;
    if (!file) { res.status(400).json({ success: false, message: 'Şəkil tələb olunur' }); return; }
    const banner = await prisma.banner.create({
      data: {
        image: file.filename,
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
