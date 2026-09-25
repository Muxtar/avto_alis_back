import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { alertNegativeReview, reviewTargetOwner, NEGATIVE_MAX } from '../services/reviewAlerts';
import { pushLive } from '../services/live';
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
    alertNegativeReview(comment.id);
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
    alertNegativeReview(comment.id);
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

// ── Rəyə satıcı cavabı ──
// Hədəfin sahibi (elan sahibi / obyektin biznes sahibi / peşəkar) rəyə İCTİMAİ
// cavab yazır — məsələn mənfi rəydə problemi izah edir və ya həll təklif edir.
router.post('/comments/:id/reply', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const c = await prisma.comment.findUnique({ where: { id: parseInt(String(req.params.id)) } });
    if (!c) { res.status(404).json({ success: false, message: 'Rəy tapılmadı' }); return; }
    const t = await reviewTargetOwner(c);
    if (!t || t.ownerId !== req.adminId) { res.status(403).json({ success: false, message: 'Yalnız elanın/obyektin sahibi cavab yaza bilər' }); return; }
    const reply = typeof req.body.reply === 'string' ? req.body.reply.trim() : '';
    if (!reply || reply.length > 1000) { res.status(400).json({ success: false, message: 'Cavab mətni tələb olunur (maks 1000 simvol)' }); return; }
    const updated = await prisma.comment.update({ where: { id: c.id }, data: { sellerReply: reply, sellerReplyAt: new Date() } });
    if (!c.sellerReply) {
      await prisma.notification.create({
        data: { userId: c.userId, type: 'LISTING', title: 'Rəyinizə cavab gəldi', body: `Satıcı ${t.label} haqqındakı rəyinizə cavab yazdı: "${reply.slice(0, 140)}"`, link: t.link },
      }).catch(() => {});
      pushLive(c.userId, { kind: 'notification', toast: 'Rəyinizə satıcı cavab yazdı', tone: 'info' });
    }
    res.json({ success: true, comment: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/comments/:id/reply', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const c = await prisma.comment.findUnique({ where: { id: parseInt(String(req.params.id)) } });
    if (!c) { res.status(404).json({ success: false, message: 'Rəy tapılmadı' }); return; }
    const t = await reviewTargetOwner(c);
    if (!t || t.ownerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const updated = await prisma.comment.update({ where: { id: c.id }, data: { sellerReply: null, sellerReplyAt: null } });
    res.json({ success: true, comment: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── Aldığım rəylər ── (elanlarım, obyektlərim, peşəkar profilim)
// filter=negative → yalnız 1-2 ulduz. Hər rəy üçün müştəri ilə son sifariş də
// qaytarılır ki, satıcı «Müştəri ilə əlaqə» ilə konkret sifariş kontekstində yazsın.
router.get('/me/reviews-received', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const me = req.adminId!;
    const negative = String(req.query.filter || '') === 'negative';
    const unanswered = String(req.query.filter || '') === 'unanswered';
    const comments = await prisma.comment.findMany({
      where: {
        AND: [
          { OR: [{ listing: { userId: me } }, { object: { business: { userId: me } } }, { professionalUserId: me }] },
          { userId: { not: me } },
          ...(negative ? [{ rating: { lte: NEGATIVE_MAX } }] : []),
          ...(unanswered ? [{ sellerReply: null }] : []),
        ],
      },
      include: {
        user: { select: { id: true, name: true, avatar: true } },
        listing: { select: { id: true, title: true, images: true } },
        object: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const buyerIds = Array.from(new Set(comments.map((c) => c.userId)));
    const orders = buyerIds.length ? await prisma.order.findMany({
      where: { sellerId: me, buyerId: { in: buyerIds } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, buyerId: true, status: true, createdAt: true, items: { select: { listingId: true } } },
    }) : [];
    const rows = comments.map((c) => {
      const mine = orders.filter((o) => o.buyerId === c.userId);
      const match = (c.listingId && mine.find((o) => o.items.some((i) => i.listingId === c.listingId))) || mine[0] || null;
      return { ...c, relatedOrder: match ? { id: match.id, status: match.status, createdAt: match.createdAt } : null };
    });
    const all = await prisma.comment.findMany({
      where: { OR: [{ listing: { userId: me } }, { object: { business: { userId: me } } }, { professionalUserId: me }], userId: { not: me } },
      select: { rating: true, sellerReply: true },
    });
    const rated = all.filter((c) => c.rating != null);
    res.json({
      success: true,
      reviews: rows,
      stats: {
        total: all.length,
        negative: rated.filter((c) => c.rating! <= NEGATIVE_MAX).length,
        unansweredNegative: rated.filter((c) => c.rating! <= NEGATIVE_MAX && !c.sellerReply).length,
        avg: rated.length ? Math.round((rated.reduce((s, c) => s + c.rating!, 0) / rated.length) * 10) / 10 : null,
      },
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
