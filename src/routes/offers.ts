// QİYMƏT TƏKLİFİ marşrutları. Məntiq: services/priceOffer.ts.
import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { pushLive } from '../services/live';
import { visibilityOf } from '../services/listingVisibility';
import { currentUnitPrice, openBuyWindow, OFFER_RESPOND_HOURS, OFFER_MIN_RATIO, OFFER_STATUS_AZ } from '../services/priceOffer';

const router = Router();
const prisma = new PrismaClient();
const offerLimiter = rateLimit(20, 60 * 60 * 1000);
const r2 = (n: number) => Math.round(n * 100) / 100;

async function notify(userId: number, title: string, body: string, link: string) {
  await prisma.notification.create({ data: { userId, type: 'ORDER', title, body, link } }).catch(() => {});
  pushLive(userId, { kind: 'order', toast: title, tone: 'info' });
}

// Alıcı: elan üçün qiymət təklif et.
router.post('/listings/:id/offers', offerLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const listingId = parseInt(String(req.params.id));
    const quantity = Math.max(1, Math.min(999, parseInt(String(req.body?.quantity)) || 1));
    const unitPrice = r2(parseFloat(String(req.body?.unitPrice)));
    const message = req.body?.message ? String(req.body.message).trim().slice(0, 500) : null;
    const cur = await currentUnitPrice(listingId, quantity);
    if (!cur) { res.status(404).json({ success: false, message: 'Elan tapılmadı' }); return; }
    const l = cur.listing;
    if (l.userId === req.adminId) { res.status(400).json({ success: false, message: 'Öz elanınıza təklif verə bilməzsiniz' }); return; }
    // Fərdi (VÖEN-siz) elan saytda onlayn alınmır — razılaşdırılmış qiymətlə səbətə atmaq mümkün olmazdı.
    if (!l.businessId && !l.businessObjectId) { res.status(400).json({ success: false, message: 'Bu elan fərdi satıcınındır — onlayn alınmır, qiyməti satıcı ilə mesajla razılaşdırın' }); return; }
    const full = await prisma.listing.findUnique({ where: { id: listingId }, select: { status: true, type: true, archivedAt: true, expiresAt: true, business: { select: { isActive: true } }, businessObject: { select: { isActive: true } } } });
    if (!full || !visibilityOf(full).visible) { res.status(400).json({ success: false, message: 'Elan hazırda satışda deyil' }); return; }
    if (l.type === 'PRODUCT' && l.stock < quantity) { res.status(400).json({ success: false, message: `Stokda ${l.stock} ədəd var` }); return; }
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) { res.status(400).json({ success: false, message: 'Təklif etdiyiniz qiyməti yazın' }); return; }
    if (unitPrice >= cur.unit) { res.status(400).json({ success: false, message: `Təklif hazırkı qiymətdən (${cur.unit} ₼) aşağı olmalıdır — bu qiymətə elə indi ala bilərsiniz` }); return; }
    if (unitPrice < r2(cur.unit * OFFER_MIN_RATIO)) { res.status(400).json({ success: false, message: `Təklif çox aşağıdır — ən azı ${r2(cur.unit * OFFER_MIN_RATIO)} ₼ yazın` }); return; }
    const open = await prisma.priceOffer.findFirst({ where: { listingId, buyerId: req.adminId!, status: { in: ['PENDING', 'COUNTERED', 'ACCEPTED'] } } });
    if (open) { res.status(400).json({ success: false, message: 'Bu elan üçün aktiv təklifiniz var — «Qiymət təkliflərim» bölməsindən baxın' }); return; }
    const offer = await prisma.priceOffer.create({
      data: {
        listingId, buyerId: req.adminId!, sellerId: l.userId, quantity, listPrice: cur.unit, unitPrice, message,
        expiresAt: new Date(Date.now() + OFFER_RESPOND_HOURS * 3600 * 1000),
      },
    });
    const buyer = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { name: true } });
    const pct = Math.round((1 - unitPrice / cur.unit) * 100);
    await notify(l.userId, `Qiymət təklifi: «${l.title}»`,
      `${buyer?.name || 'Alıcı'}: ${quantity} ədəd × ${unitPrice} ₼ (sizin qiymət ${cur.unit} ₼, −${pct}%).${message ? ` «${message.slice(0, 100)}»` : ''} ${OFFER_RESPOND_HOURS} saat ərzində cavab verin.`,
      `/offers?tab=selling&id=${offer.id}`);
    res.status(201).json({ success: true, offer });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Mənim təkliflərim (alıcı: göndərdiklərim, satıcı: gələnlər).
router.get('/me/offers', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const selling = String(req.query.role || '') === 'seller';
    const offers = await prisma.priceOffer.findMany({
      where: selling ? { sellerId: req.adminId! } : { buyerId: req.adminId! },
      orderBy: { updatedAt: 'desc' }, take: 200,
    });
    const listings = await prisma.listing.findMany({ where: { id: { in: offers.map((o) => o.listingId) } }, select: { id: true, title: true, images: true, price: true, stock: true } });
    const users = await prisma.user.findMany({ where: { id: { in: offers.map((o) => (selling ? o.buyerId : o.sellerId)) } }, select: { id: true, name: true, avatar: true } });
    const counts = selling
      ? await prisma.priceOffer.count({ where: { sellerId: req.adminId!, status: 'PENDING' } })
      : await prisma.priceOffer.count({ where: { buyerId: req.adminId!, status: { in: ['COUNTERED', 'ACCEPTED'] } } });
    res.json({
      success: true, needsAction: counts,
      offers: offers.map((o) => ({
        ...o, statusLabel: OFFER_STATUS_AZ[o.status] || o.status,
        listing: listings.find((l) => l.id === o.listingId) || null,
        counterparty: users.find((u) => u.id === (selling ? o.buyerId : o.sellerId)) || null,
        inCart: false,
      })),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Satıcı: qəbul et / rədd et / əks-təklif.
router.put('/offers/:id/respond', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const o = await prisma.priceOffer.findUnique({ where: { id: parseInt(String(req.params.id)) } });
    if (!o || o.sellerId !== req.adminId) { res.status(404).json({ success: false, message: 'Təklif tapılmadı' }); return; }
    if (o.status !== 'PENDING') { res.status(400).json({ success: false, message: 'Bu təklifə artıq cavab verilib' }); return; }
    const action = String(req.body?.action || '');
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
    const l = await prisma.listing.findUnique({ where: { id: o.listingId }, select: { title: true } });
    if (action === 'accept') {
      await prisma.priceOffer.update({ where: { id: o.id }, data: { sellerNote: note } });
      const upd = await openBuyWindow(o.id, o.unitPrice, 'SELLER');
      res.json({ success: true, offer: upd }); return;
    }
    if (action === 'reject') {
      const upd = await prisma.priceOffer.update({ where: { id: o.id }, data: { status: 'REJECTED', sellerNote: note, expiresAt: null } });
      await notify(o.buyerId, `Qiymət təklifiniz rədd edildi — «${l?.title}»`, note ? `Satıcı: «${note}»` : 'Satıcı bu qiymətlə razılaşmadı. Yenidən başqa qiymət təklif edə bilərsiniz.', `/offers?id=${o.id}`);
      res.json({ success: true, offer: upd }); return;
    }
    if (action === 'counter') {
      const counter = r2(parseFloat(String(req.body?.counterPrice)));
      if (!Number.isFinite(counter) || counter <= o.unitPrice || counter >= o.listPrice) {
        res.status(400).json({ success: false, message: `Əks-təklif alıcının qiymətindən (${o.unitPrice} ₼) yuxarı, sizin qiymətinizdən (${o.listPrice} ₼) aşağı olmalıdır` }); return;
      }
      const upd = await prisma.priceOffer.update({
        where: { id: o.id },
        data: { status: 'COUNTERED', counterPrice: counter, sellerNote: note, expiresAt: new Date(Date.now() + OFFER_RESPOND_HOURS * 3600 * 1000) },
      });
      await notify(o.buyerId, `Satıcı əks-təklif verdi — «${l?.title}»`, `${o.quantity} ədəd × ${counter} ₼${note ? ` — «${note}»` : ''}. Qəbul edin və ya rədd edin.`, `/offers?id=${o.id}`);
      res.json({ success: true, offer: upd }); return;
    }
    res.status(400).json({ success: false, message: 'Əməl seçin' });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Alıcı: əks-təklifi qəbul / rədd et, və ya öz təklifini ləğv et.
router.put('/offers/:id/buyer', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const o = await prisma.priceOffer.findUnique({ where: { id: parseInt(String(req.params.id)) } });
    if (!o || o.buyerId !== req.adminId) { res.status(404).json({ success: false, message: 'Təklif tapılmadı' }); return; }
    const action = String(req.body?.action || '');
    if (action === 'accept_counter') {
      if (o.status !== 'COUNTERED' || o.counterPrice == null) { res.status(400).json({ success: false, message: 'Əks-təklif yoxdur' }); return; }
      const upd = await openBuyWindow(o.id, o.counterPrice, 'BUYER');
      res.json({ success: true, offer: upd }); return;
    }
    if (action === 'reject_counter' || action === 'cancel') {
      if (!['PENDING', 'COUNTERED', 'ACCEPTED'].includes(o.status)) { res.status(400).json({ success: false, message: 'Bu təklif artıq bağlanıb' }); return; }
      const upd = await prisma.priceOffer.update({ where: { id: o.id }, data: { status: action === 'cancel' ? 'CANCELLED' : 'REJECTED', expiresAt: null } });
      await prisma.cartItem.deleteMany({ where: { priceOfferId: o.id } }).catch(() => {});
      const l = await prisma.listing.findUnique({ where: { id: o.listingId }, select: { title: true } });
      await notify(o.sellerId, action === 'cancel' ? `Alıcı qiymət təklifini ləğv etdi — «${l?.title}»` : `Alıcı əks-təklifinizi rədd etdi — «${l?.title}»`, '', `/offers?tab=selling&id=${o.id}`);
      res.json({ success: true, offer: upd }); return;
    }
    res.status(400).json({ success: false, message: 'Əməl seçin' });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Alıcı: razılaşdırılmış qiymətlə səbətə at (say və qiymət təklifdəkidir).
router.post('/offers/:id/add-to-cart', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const o = await prisma.priceOffer.findUnique({ where: { id: parseInt(String(req.params.id)) } });
    if (!o || o.buyerId !== req.adminId) { res.status(404).json({ success: false, message: 'Təklif tapılmadı' }); return; }
    if (o.status !== 'ACCEPTED' || !o.acceptedUntil || o.acceptedUntil < new Date()) { res.status(400).json({ success: false, message: 'Razılaşdırılmış qiymətin müddəti bitib' }); return; }
    const l = await prisma.listing.findUnique({ where: { id: o.listingId }, select: { stock: true, type: true } });
    if (!l || (l.type === 'PRODUCT' && l.stock < o.quantity)) { res.status(400).json({ success: false, message: 'Stokda kifayət qədər məhsul qalmayıb' }); return; }
    let cart = await prisma.cart.findUnique({ where: { userId: req.adminId! } });
    if (!cart) cart = await prisma.cart.create({ data: { userId: req.adminId! } });
    // Təklif sətri həmişə AYRI sətirdir — eyni məhsulun adi sətrinə toxunulmur
    // (adi sətir öz qiyməti ilə, təklif sətri razılaşdırılmış qiymətlə qalır).
    const existing = await prisma.cartItem.findFirst({ where: { cartId: cart.id, priceOfferId: o.id } });
    if (existing) await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity: o.quantity } });
    else await prisma.cartItem.create({ data: { cartId: cart.id, listingId: o.listingId, quantity: o.quantity, priceOfferId: o.id } });
    res.json({ success: true, redirect: '/cart' });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
