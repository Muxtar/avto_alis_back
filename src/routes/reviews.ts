import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { purchasedFromObject, consultedProfessional, deliveredOrderCountFromObject, consultationCount, reviewStats } from '../services/reviewGating';

const router = Router();
const prisma = new PrismaClient();

function parseRating(v: any): number | null | 'ERR' {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(v);
  if (Number.isNaN(n) || n < 1 || n > 5) return 'ERR';
  return n;
}
function validContent(v: any): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 1000) return null;
  return s;
}

// ── Obyekt rəyi ──
// Yalnız o obyektdən alış etmiş (çatdırılmış) istifadəçi — HƏR ALIŞA bir rəy.
router.post('/objects/:id/comments', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const objectId = parseInt(String(req.params.id));
    const content = validContent(req.body.content);
    if (!content) { res.status(400).json({ success: false, message: 'Şərh mətni tələb olunur (maks 1000 simvol)' }); return; }
    const rating = parseRating(req.body.rating);
    if (rating === 'ERR') { res.status(400).json({ success: false, message: 'Reytinq 1-5 aralığında olmalıdır' }); return; }
    const obj = await prisma.businessObject.findUnique({ where: { id: objectId }, select: { id: true } });
    if (!obj) { res.status(404).json({ success: false, message: 'Obyekt tapılmadı' }); return; }
    if (!(await purchasedFromObject(req.adminId!, objectId))) {
      res.status(403).json({ success: false, message: 'Yalnız bu obyektdən alış etdikdən sonra rəy yaza bilərsiniz' }); return;
    }
    // HƏR ALIŞ BİR RƏY HAQQI. Əvvəl ömürlük bir rəy vardı: eyni mağazadan
    // ikinci dəfə alan müştəri yeni rəy yaza bilmirdi.
    const [orders, mine] = await Promise.all([
      deliveredOrderCountFromObject(req.adminId!, objectId),
      prisma.comment.count({ where: { userId: req.adminId!, objectId } }),
    ]);
    if (mine >= orders) {
      res.status(400).json({
        success: false,
        message: 'Bu mağazadakı alışlarınızın hamısına rəy yazmısınız — mövcud rəyinizi dəyişə və ya növbəti alışdan sonra yenisini yaza bilərsiniz',
      });
      return;
    }
    const comment = await prisma.comment.create({
      data: { userId: req.adminId!, objectId, content, rating: rating as number | null },
      include: { user: { select: { id: true, name: true, type: true, avatar: true } } },
    });
    res.status(201).json({ success: true, comment });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Obyekt rəyləri + məmnunluq faizi.
router.get('/objects/:id/reviews', async (req: Request, res: Response) => {
  try {
    const objectId = parseInt(String(req.params.id));
    const comments = await prisma.comment.findMany({
      where: { objectId },
      include: { user: { select: { id: true, name: true, type: true, avatar: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ success: true, comments, stats: reviewStats(comments.map((c) => c.rating)) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── İxtisas / rəy profili rəyi ──
// Yalnız o peşəkardan seans almış istifadəçi — HƏR SEANSA bir rəy.
router.post('/professionals/:id/comments', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const proId = parseInt(String(req.params.id));
    const content = validContent(req.body.content);
    if (!content) { res.status(400).json({ success: false, message: 'Şərh mətni tələb olunur (maks 1000 simvol)' }); return; }
    const rating = parseRating(req.body.rating);
    if (rating === 'ERR') { res.status(400).json({ success: false, message: 'Reytinq 1-5 aralığında olmalıdır' }); return; }
    if (proId === req.adminId) { res.status(403).json({ success: false, message: 'Öz profilinizə rəy yaza bilməzsiniz' }); return; }
    const pro = await prisma.user.findUnique({ where: { id: proId }, select: { id: true, profession: true } });
    if (!pro || !pro.profession) { res.status(404).json({ success: false, message: 'İxtisas profili tapılmadı' }); return; }
    if (!(await consultedProfessional(req.adminId!, proId))) {
      res.status(403).json({ success: false, message: 'Yalnız bu peşəkardan rəy/konsultasiya aldıqdan sonra rəy yaza bilərsiniz' }); return;
    }
    // Hər seans bir rəy haqqı verir (mağaza rəyi ilə eyni qayda).
    const [sessions, mine] = await Promise.all([
      consultationCount(req.adminId!, proId),
      prisma.comment.count({ where: { userId: req.adminId!, professionalUserId: proId } }),
    ]);
    if (mine >= sessions) {
      res.status(400).json({
        success: false,
        message: 'Keçirdiyiniz seansların hamısına rəy yazmısınız — mövcud rəyinizi dəyişə və ya növbəti seansdan sonra yenisini yaza bilərsiniz',
      });
      return;
    }
    const comment = await prisma.comment.create({
      data: { userId: req.adminId!, professionalUserId: proId, content, rating: rating as number | null },
      include: { user: { select: { id: true, name: true, type: true, avatar: true } } },
    });
    res.status(201).json({ success: true, comment });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// İxtisas profili rəyləri + məmnunluq faizi.
router.get('/professionals/:id/reviews', async (req: Request, res: Response) => {
  try {
    const proId = parseInt(String(req.params.id));
    const comments = await prisma.comment.findMany({
      where: { professionalUserId: proId },
      include: { user: { select: { id: true, name: true, type: true, avatar: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ success: true, comments, stats: reviewStats(comments.map((c) => c.rating)) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
