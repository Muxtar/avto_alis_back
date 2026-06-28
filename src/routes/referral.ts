import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { adminAuth, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

const DOC_TYPES = ['NONE', 'DIPLOMA', 'CV', 'ANY'];

// Obyektin sahibi (biznes sahibi) yoxlaması.
async function ownObject(objectId: number, userId: number) {
  const obj = await prisma.businessObject.findUnique({ where: { id: objectId }, include: { business: true } });
  if (!obj || obj.business.userId !== userId) return null;
  return obj;
}

// Peşəkar bu qaydaya uyğundurmu? (ixtisas + sənəd tələbi)
async function eligibility(userId: number, rule: { profession: string; requiredDoc: string }) {
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { profession: true, cvFile: true, professionDocuments: { where: { status: 'APPROVED' }, select: { id: true } } },
  });
  if (!me) return { ok: false, reason: 'İstifadəçi tapılmadı' };
  if ((me.profession || '').trim().toLowerCase() !== rule.profession.trim().toLowerCase()) {
    return { ok: false, reason: `Bu referal yalnız "${rule.profession}" ixtisası üçündür` };
  }
  const hasDoc = me.professionDocuments.length > 0;
  const hasCv = !!me.cvFile;
  if (rule.requiredDoc === 'DIPLOMA' && !hasDoc) return { ok: false, reason: 'Təsdiqlənmiş diplom/sertifikat tələb olunur' };
  if (rule.requiredDoc === 'CV' && !hasCv) return { ok: false, reason: 'CV tələb olunur' };
  if (rule.requiredDoc === 'ANY' && !hasDoc && !hasCv) return { ok: false, reason: 'Diplom və ya CV tələb olunur' };
  return { ok: true, reason: '' };
}

// ── Mağaza sahibi: referal qaydaları ──────────────────────────────────────────
router.get('/me/objects/:id/referral', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const obj = await ownObject(id, req.adminId!);
    if (!obj) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const rules = await prisma.referralRule.findMany({ where: { objectId: id }, orderBy: { id: 'asc' } });
    res.json({ success: true, referralEnabled: obj.referralEnabled, rules });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.put('/me/objects/:id/referral', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const obj = await ownObject(id, req.adminId!);
    if (!obj) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const enabled = !!req.body.enabled;
    const rawRules = Array.isArray(req.body.rules) ? req.body.rules.slice(0, 4) : [];
    const rules = rawRules
      .map((r: any) => ({
        profession: String(r.profession || '').trim(),
        commissionPercent: Math.max(0, Math.min(100, parseFloat(String(r.commissionPercent)) || 0)),
        requiredDoc: DOC_TYPES.includes(r.requiredDoc) ? r.requiredDoc : 'NONE',
      }))
      .filter((r: any) => r.profession && r.commissionPercent > 0);

    await prisma.$transaction([
      prisma.businessObject.update({ where: { id }, data: { referralEnabled: enabled } }),
      prisma.referralRule.deleteMany({ where: { objectId: id } }),
      ...(rules.length ? [prisma.referralRule.createMany({ data: rules.map((r: any) => ({ ...r, objectId: id })) })] : []),
    ]);
    const saved = await prisma.referralRule.findMany({ where: { objectId: id }, orderBy: { id: 'asc' } });
    res.json({ success: true, referralEnabled: enabled, rules: saved });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Peşəkar: mənim bu obyekt üzrə uyğunluğum (referal səbət yaratmazdan əvvəl).
router.get('/objects/:id/referral-eligibility', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const obj = await prisma.businessObject.findUnique({ where: { id }, select: { referralEnabled: true } });
    if (!obj || !obj.referralEnabled) { res.json({ success: true, eligible: false, reason: 'Bu mağazada referal satış yoxdur' }); return; }
    const me = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { profession: true } });
    const rule = await prisma.referralRule.findFirst({ where: { objectId: id, profession: me?.profession || '__none__' } });
    if (!rule) { res.json({ success: true, eligible: false, reason: 'İxtisasınız bu mağazanın referal siyahısında deyil' }); return; }
    const el = await eligibility(req.adminId!, rule);
    res.json({ success: true, eligible: el.ok, reason: el.reason, commissionPercent: rule.commissionPercent, requiredDoc: rule.requiredDoc });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Kəşf: peşəkarın ixtisasına uyğun referal mağazalar.
router.get('/referral/stores', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const me = await prisma.user.findUnique({
      where: { id: req.adminId! },
      select: { profession: true, cvFile: true, professionDocuments: { where: { status: 'APPROVED' }, select: { id: true } } },
    });
    if (!me?.profession) { res.json({ success: true, profession: null, stores: [] }); return; }
    const hasDoc = me.professionDocuments.length > 0;
    const hasCv = !!me.cvFile;
    const rules = await prisma.referralRule.findMany({
      where: {
        profession: { equals: me.profession, mode: 'insensitive' },
        object: { referralEnabled: true, isActive: true },
      },
      include: {
        object: {
          select: {
            id: true, name: true, city: true, address: true,
            business: { select: { name: true, status: true } },
            _count: { select: { listings: true } },
          },
        },
      },
      orderBy: { commissionPercent: 'desc' },
    });
    const stores = rules.map((r) => {
      const eligible = r.requiredDoc === 'NONE' || (r.requiredDoc === 'DIPLOMA' ? hasDoc : r.requiredDoc === 'CV' ? hasCv : (hasDoc || hasCv));
      return {
        objectId: r.object.id, name: r.object.name, city: r.object.city, address: r.object.address,
        businessName: r.object.business.name, listingCount: r.object._count.listings,
        commissionPercent: r.commissionPercent, requiredDoc: r.requiredDoc, eligible,
      };
    });
    res.json({ success: true, profession: me.profession, stores });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Peşəkar: referal səbət (link) yarat.
router.post('/referral/cart', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const objectId = parseInt(String(req.body.objectId));
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    const obj = await prisma.businessObject.findUnique({ where: { id: objectId }, include: { business: true } });
    if (!obj || !obj.referralEnabled) { res.status(400).json({ success: false, message: 'Bu mağaza referal satışa icazə vermir' }); return; }
    if (obj.business.userId === req.adminId) { res.status(400).json({ success: false, message: 'Öz mağazanıza referal yarada bilməzsiniz' }); return; }

    const me = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { profession: true } });
    const rule = await prisma.referralRule.findFirst({ where: { objectId, profession: me?.profession || '__none__' } });
    if (!rule) { res.status(400).json({ success: false, message: 'İxtisasınız bu mağazanın referal siyahısında deyil' }); return; }
    const el = await eligibility(req.adminId!, rule);
    if (!el.ok) { res.status(400).json({ success: false, message: el.reason }); return; }

    // Məhsulları yoxla — hamısı bu obyektə aid olmalıdır.
    const items: { listingId: number; quantity: number }[] = [];
    for (const it of rawItems) {
      const lid = parseInt(String(it.listingId));
      const qty = Math.max(1, parseInt(String(it.quantity)) || 1);
      if (Number.isNaN(lid)) continue;
      const listing = await prisma.listing.findUnique({ where: { id: lid }, select: { businessObjectId: true } });
      if (listing && listing.businessObjectId === objectId) items.push({ listingId: lid, quantity: qty });
    }
    if (items.length === 0) { res.status(400).json({ success: false, message: 'Bu mağazadan ən azı bir məhsul seçin' }); return; }

    const token = crypto.randomBytes(8).toString('hex');
    await prisma.referralCart.create({
      data: { token, referrerId: req.adminId!, objectId, businessId: obj.businessId, percent: rule.commissionPercent, items },
    });
    res.json({ success: true, token, percent: rule.commissionPercent });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Alıcı: referal səbəti aç (public).
router.get('/referral/:token', async (req, res: Response) => {
  try {
    const cart = await prisma.referralCart.findUnique({ where: { token: String(req.params.token) } });
    if (!cart) { res.status(404).json({ success: false, message: 'Link tapılmadı' }); return; }
    const itemsArr = (cart.items as any[]) || [];
    const ids = itemsArr.map((i) => i.listingId);
    const listings = await prisma.listing.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, price: true, images: true, stock: true },
    });
    const items = itemsArr.map((i) => {
      const l = listings.find((x) => x.id === i.listingId);
      return l ? { listingId: l.id, title: l.title, price: l.price, image: l.images?.[0] || null, quantity: i.quantity, stock: l.stock } : null;
    }).filter(Boolean);
    const [referrer, obj] = await Promise.all([
      prisma.user.findUnique({ where: { id: cart.referrerId }, select: { id: true, name: true, profession: true } }),
      prisma.businessObject.findUnique({ where: { id: cart.objectId }, select: { id: true, name: true, city: true, phone: true } }),
    ]);
    const total = items.reduce((s: number, i: any) => s + i.price * i.quantity, 0);
    res.json({ success: true, token: cart.token, items, total, percent: cart.percent, referrer, store: obj });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Alıcı: referal səbətdən sifariş ver (MVP: nağd).
router.post('/referral/:token/checkout', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const cart = await prisma.referralCart.findUnique({ where: { token: String(req.params.token) } });
    if (!cart) { res.status(404).json({ success: false, message: 'Link tapılmadı' }); return; }
    if (cart.referrerId === req.adminId) { res.status(400).json({ success: false, message: 'Öz referal linkinizdən sifariş verə bilməzsiniz' }); return; }
    const obj = await prisma.businessObject.findUnique({ where: { id: cart.objectId }, include: { business: true } });
    if (!obj) { res.status(400).json({ success: false, message: 'Mağaza tapılmadı' }); return; }
    const sellerId = obj.business.userId;

    const itemsArr = (cart.items as any[]) || [];
    const listings = await prisma.listing.findMany({ where: { id: { in: itemsArr.map((i) => i.listingId) } }, select: { id: true, title: true, price: true, stock: true } });
    const orderItems = itemsArr.map((i) => {
      const l = listings.find((x) => x.id === i.listingId);
      return l ? { listingId: l.id, title: l.title, price: l.price, quantity: i.quantity } : null;
    }).filter(Boolean) as { listingId: number; title: string; price: number; quantity: number }[];
    if (orderItems.length === 0) { res.status(400).json({ success: false, message: 'Səbət boşdur' }); return; }

    const total = orderItems.reduce((s, i) => s + i.price * i.quantity, 0);
    const referralAmount = +(total * cart.percent / 100).toFixed(2);
    const { address, phone, note } = req.body;

    const order = await prisma.$transaction(async (tx) => {
      // Atomik stok azaltma.
      for (const i of orderItems) {
        const r = await tx.listing.updateMany({ where: { id: i.listingId, stock: { gte: i.quantity } }, data: { stock: { decrement: i.quantity } } });
        if (r.count === 0) throw new Error(`"${i.title}" üçün kifayət qədər stok yoxdur`);
      }
      const o = await tx.order.create({
        data: {
          buyerId: req.adminId!, sellerId, subtotal: total, total,
          address: address || null, phone: phone || null, note: note || null,
          paymentMethod: 'CASH', paymentStatus: 'PENDING',
          referrerId: cart.referrerId, referralPercent: cart.percent, referralAmount,
          items: { create: orderItems.map((i) => ({ listingId: i.listingId, quantity: i.quantity, price: i.price, title: i.title })) },
        },
      });
      await tx.notification.create({ data: { userId: sellerId, type: 'ORDER', title: 'Yeni referal sifariş', body: `Referal sifariş: ${total.toFixed(2)} AZN`, link: '/orders' } }).catch(() => {});
      await tx.notification.create({ data: { userId: cart.referrerId, type: 'REFERRAL', title: 'Referal sifariş verildi', body: `Sizin link üzərindən sifariş: komissiya ${referralAmount} AZN (çatdırılanda qətiləşir)`, link: '/referral-earnings' } }).catch(() => {});
      return o;
    });
    res.json({ success: true, orderId: order.id });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Peşəkar: referal qazancım.
router.get('/me/referral-earnings', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      where: { referrerId: req.adminId! },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, total: true, referralPercent: true, referralAmount: true, status: true, createdAt: true,
        seller: { select: { id: true, name: true } },
      },
    });
    const confirmed = orders.filter((o) => o.status === 'DELIVERED').reduce((s, o) => s + (o.referralAmount || 0), 0);
    const pending = orders.filter((o) => o.status !== 'DELIVERED' && o.status !== 'CANCELLED').reduce((s, o) => s + (o.referralAmount || 0), 0);
    res.json({ success: true, orders, confirmedTotal: +confirmed.toFixed(2), pendingTotal: +pending.toFixed(2) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
