// İXTİSAS ENDİRİMİ marşrutları. Məntiq: services/professionDiscount.ts.
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest, viewerIdFromReq } from '../middleware/auth';
import { activeRules, listingProDiscountInfo, normProf, PRO_DISCOUNT_MAX, verifiedProfessions } from '../services/professionDiscount';

const router = Router();
const prisma = new PrismaClient();
const r2 = (n: number) => Math.round(n * 100) / 100;
const MAX_RULES = 20;

/** Obyekt bu istifadəçiyə məxsusdurmu (biznes sahibi). */
async function ownObject(objectId: number, userId: number) {
  const o = await prisma.businessObject.findUnique({ where: { id: objectId }, select: { id: true, name: true, deletedAt: true, business: { select: { userId: true, status: true, isActive: true } } } });
  return o && !o.deletedAt && o.business.userId === userId ? o : null;
}

// Mağaza sahibi: qaydalar + obyektin məhsulları + statistika.
router.get('/me/objects/:id/pro-discounts', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const obj = await ownObject(id, req.adminId!);
    if (!obj) { res.status(403).json({ success: false, message: 'Bu mağaza sizə aid deyil' }); return; }
    const [rules, listings, stats] = await Promise.all([
      prisma.professionDiscount.findMany({ where: { businessObjectId: id }, orderBy: { percent: 'desc' } }),
      prisma.listing.findMany({ where: { businessObjectId: id, status: 'APPROVED', archivedAt: null }, select: { id: true, title: true, price: true, images: true }, orderBy: { createdAt: 'desc' }, take: 300 }),
      prisma.orderItem.findMany({
        where: { proDiscountAmount: { gt: 0 }, listing: { businessObjectId: id }, order: { status: { notIn: ['CANCELLED'] } } },
        select: { proDiscountAmount: true, proDiscountProfession: true, orderId: true },
      }),
    ]);
    const byProf: Record<string, { orders: number; amount: number }> = {};
    const orderSet = new Set<number>();
    for (const s of stats) {
      const k = s.proDiscountProfession || '—';
      byProf[k] = byProf[k] || { orders: 0, amount: 0 };
      byProf[k].amount = r2(byProf[k].amount + (s.proDiscountAmount || 0));
      byProf[k].orders += 1; orderSet.add(s.orderId);
    }
    res.json({
      success: true, object: { id: obj.id, name: obj.name, businessApproved: obj.business.status === 'APPROVED' && obj.business.isActive },
      rules, listings, maxPercent: PRO_DISCOUNT_MAX,
      stats: { orders: orderSet.size, totalDiscount: r2(stats.reduce((a, s) => a + (s.proDiscountAmount || 0), 0)), byProfession: byProf },
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Mağaza sahibi: qaydaları saxla (tam siyahı — göndərilməyənlər silinir).
router.put('/me/objects/:id/pro-discounts', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const obj = await ownObject(id, req.adminId!);
    if (!obj) { res.status(403).json({ success: false, message: 'Bu mağaza sizə aid deyil' }); return; }
    const raw: any[] = Array.isArray(req.body?.rules) ? req.body.rules : [];
    if (raw.length > MAX_RULES) { res.status(400).json({ success: false, message: `Ən çox ${MAX_RULES} ixtisas qaydası` }); return; }
    const own = new Set((await prisma.listing.findMany({ where: { businessObjectId: id }, select: { id: true } })).map((l) => l.id));
    const seen = new Set<string>();
    const clean: any[] = [];
    for (const r of raw) {
      const profession = String(r.profession || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!profession) { res.status(400).json({ success: false, message: 'Hər qayda üçün ixtisas seçin' }); return; }
      if (seen.has(normProf(profession))) { res.status(400).json({ success: false, message: `«${profession}» iki dəfə yazılıb` }); return; }
      seen.add(normProf(profession));
      const percent = r2(parseFloat(String(r.percent)));
      if (!Number.isFinite(percent) || percent < 1 || percent > PRO_DISCOUNT_MAX) { res.status(400).json({ success: false, message: `«${profession}»: endirim 1–${PRO_DISCOUNT_MAX}% arası olmalıdır` }); return; }
      const scope = r.scope === 'SELECTED' ? 'SELECTED' : 'ALL';
      const listingIds = scope === 'SELECTED' ? Array.from(new Set((Array.isArray(r.listingIds) ? r.listingIds : []).map((x: any) => parseInt(String(x))).filter((x: number) => own.has(x)))) : [];
      if (scope === 'SELECTED' && !listingIds.length) { res.status(400).json({ success: false, message: `«${profession}»: endirim veriləcək məhsulları seçin` }); return; }
      const maxU = r.maxUnitsPerOrder ? parseInt(String(r.maxUnitsPerOrder)) : null;
      const maxD = r.maxDiscountPerOrder ? r2(parseFloat(String(r.maxDiscountPerOrder))) : null;
      const until = r.validUntil ? new Date(r.validUntil) : null;
      clean.push({
        profession, percent, scope, listingIds,
        maxUnitsPerOrder: maxU && maxU > 0 ? Math.min(maxU, 999) : null,
        maxDiscountPerOrder: maxD && maxD > 0 ? maxD : null,
        active: r.active !== false,
        validUntil: until && !isNaN(until.getTime()) ? until : null,
      });
    }
    await prisma.$transaction([
      prisma.professionDiscount.deleteMany({ where: { businessObjectId: id } }),
      ...clean.map((c) => prisma.professionDiscount.create({ data: { businessObjectId: id, ...c } })),
    ]);
    const rules = await prisma.professionDiscount.findMany({ where: { businessObjectId: id }, orderBy: { percent: 'desc' } });
    res.json({ success: true, rules });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Elan səhifəsi: bu mağazanın ixtisas endirimləri + baxanın statusu (daxil olmasa da görünür).
router.get('/listings/:id/pro-discount', async (req: Request, res: Response) => {
  try {
    const l = await prisma.listing.findUnique({ where: { id: parseInt(String(req.params.id)) }, select: { id: true, businessObjectId: true, userId: true } });
    if (!l) { res.status(404).json({ success: false, message: 'Elan tapılmadı' }); return; }
    const viewer = await viewerIdFromReq(req);
    res.json({ success: true, ...(await listingProDiscountInfo(l, viewer)) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Mağaza səhifəsi: aktiv ixtisas endirimləri.
router.get('/objects/:id/pro-discounts', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const rules = (await activeRules([id])).sort((a, b) => b.percent - a.percent);
    const viewer = await viewerIdFromReq(req);
    const verified = viewer ? await verifiedProfessions(viewer) : new Set<string>();
    res.json({
      success: true,
      rules: rules.map((r) => ({ profession: r.profession, percent: r.percent, scope: r.scope, productCount: r.scope === 'SELECTED' ? r.listingIds.length : null, mine: verified.has(normProf(r.profession)) })),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// İstifadəçi: sənədlə təsdiqli ixtisaslarım (profil və alış üçün).
router.get('/me/verified-professions', adminAuth, async (req: AuthRequest, res: Response) => {
  const set = await verifiedProfessions(req.adminId!);
  const u = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { profession: true, professions: true } });
  const claimed = Array.from(new Set([u?.profession, ...(u?.professions || [])].filter(Boolean) as string[]));
  res.json({ success: true, verified: claimed.filter((p) => set.has(normProf(p))), unverified: claimed.filter((p) => !set.has(normProf(p))) });
});

export default router;
