import { Router, Response } from 'express';
import { rateLimit } from '../middleware/rateLimiter';
import { PrismaClient, UserType } from '@prisma/client';
import { adminAuth, requireType, AuthRequest } from '../middleware/auth';
import { createPayment as createGatewayPayment } from '../services/paymentGateway';
import { refundOrderSafe, restoreStockForOrder, commitStockForOrder } from '../services/refunds';
import { monthsAllowedFor, getInstallmentConfig, installmentFee } from '../services/installment';
import { chargeSavedCard } from '../services/savedCards';
import { missingRequiredConsents } from '../services/legal';
import { settleOrders } from './payment';
import { recordSettlement, recordSettlementMany, sellerBalance } from '../services/settlement';
import { markOrdersAwaitingConfirm, getDeliveryDeadlineHours } from '../services/orderExpiry';
import { checkPrice as yangoCheckPrice, isYangoConfigured, YANGO_MAX_WEIGHT_KG, yangoDead } from '../services/yangoDelivery';
import { notifySellersNewOrder } from '../services/orderNotify';
import { dispatchOrderToYango, cancelActiveYangoClaim } from './yango';
import { pushLive, pushAdmins } from '../services/live';
import { upload } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';
import { complaintLimiter } from '../middleware/rateLimiter';
import {
  approveReturn, finalizeReturnRefund, rejectReturn, logReturnEvent, hoursFromNow,
  RETURN_SELLER_RESPOND_HOURS, RETURN_RECEIVE_DAYS, RETURN_REFUND_HOURS, RETURN_DISPUTE_DAYS, RETURN_METHODS, RETURN_METHOD_AZ,
} from '../services/returnFlow';
import { createSellerComplaint } from '../services/sellerReputation';
import { validOfferPrice } from '../services/priceOffer';
import { isPickup, onPickupReady, onPickupHandedOver, onPickupReceived, PICKUP_DEADLINE_HOURS } from '../services/pickupFlow';
import { computeOrderReferral } from '../services/referral';
import { validateSharedItems, attachReferral, SHARE_LINK_DAYS, type SharedItemInput, type DeliveryChoice } from '../services/sharedCart';
import { unitPriceFor, priceInfo, type Tier } from '../services/tierPricing';
import { groupQty, RETURN_WINDOW_DAYS, groupBuyEnabled, activeGroup, ensureActiveGroup } from '../services/groupBuy';

const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 5001}`;

const BUYER_TYPES: UserType[] = [UserType.CAR_OWNER, UserType.MECHANIC, UserType.PARTS_SELLER];

const router = Router();
const prisma = new PrismaClient();

// Təhvil kodu — qarışmaması üçün oxşar simvollar (0/O, 1/I) çıxarılıb. Məs. "TX-7F3K".
function genPickupCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `TX-${s}`;
}

// Get my cart
router.get('/cart', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    let cart = await prisma.cart.findUnique({
      where: { userId: req.adminId! },
      include: {
        items: {
          include: {
            listing: { include: { user: { select: { id: true, name: true, phone: true } }, priceTiers: { orderBy: { minQty: 'asc' } } } },
            groupBuy: { select: { id: true, code: true, status: true, expiresAt: true } },
          },
        },
      },
    });
    if (!cart) {
      cart = await prisma.cart.create({
        data: { userId: req.adminId! },
        include: { items: { include: { listing: { include: { user: { select: { id: true, name: true, phone: true } }, priceTiers: { orderBy: { minQty: 'asc' } } } }, groupBuy: { select: { id: true, code: true, status: true, expiresAt: true } } } } },
      });
    }
    // HƏR SƏTİRİN QİYMƏTİ elanın adi qiyməti DEYİL:
    //   • adi sətir + say-qiymət pilləsi → seçilən saya görə (çox alanda ucuz);
    //   • elanda BİRGƏ ALIŞ açıqdırsa → indi TAM qiymət ödənilir, endirim
    //     pəncərə + qaytarma müddəti bitəndən sonra kartа qaytarılır.
    const priced = await Promise.all(cart.items.map(async (i) => {
      const tiers: Tier[] = (i.listing.priceTiers || []).map((t: any) => ({ minQty: t.minQty, price: t.price }));
      // Razılaşdırılmış qiymət təklifi — birgə alış/pillə tətbiq olunmur, qiymət sabitdir.
      const offer = (i as any).priceOfferId ? await prisma.priceOffer.findUnique({ where: { id: (i as any).priceOfferId } }) : null;
      const offerValid = !!(offer && offer.status === 'ACCEPTED' && offer.acceptedUntil && offer.acceptedUntil > new Date());
      const inGroupBuy = !offer && groupBuyEnabled(i.listing as any);
      let unit = offerValid ? (offer!.finalPrice ?? offer!.unitPrice) : i.listing.price;
      let groupTotalQty: number | null = null;
      let groupCode: string | null = null;
      let groupExpiresAt: Date | null = null;
      if (inGroupBuy) {
        // Elanın açıq pəncərəsi (varsa) — alış ona qoşulacaq.
        const g = await activeGroup(i.listing.id);
        if (g) {
          groupCode = g.code;
          groupExpiresAt = g.expiresAt;
          groupTotalQty = await groupQty(g.id);
        } else {
          groupTotalQty = 0;   // ilk alan pəncərəni özü başladır
        }
      } else if (tiers.length && !offer) {
        unit = unitPriceFor(i.listing.price, tiers, i.quantity);
      }
      return {
        ...i,
        unitPrice: unit,
        offer: offer ? { id: offer.id, valid: offerValid, finalPrice: offer.finalPrice ?? offer.unitPrice, listPrice: offer.listPrice, acceptedUntil: offer.acceptedUntil } : null,
        lineTotal: Math.round(unit * i.quantity * 100) / 100,
        tiers,
        groupTotalQty,
        groupCode,
        groupExpiresAt,
        groupWindowDays: inGroupBuy ? (i.listing as any).groupBuyDays : null,
        groupStartsNow: inGroupBuy && !groupCode,
        // Birgə alışda endirim sonra qaytarılır — alıcı bunu səbətdə görür.
        groupRefundLater: inGroupBuy,
        returnWindowDays: RETURN_WINDOW_DAYS,
        pricing: priceInfo(i.listing.price, tiers, inGroupBuy ? (groupTotalQty || 0) + i.quantity : i.quantity),
      };
    }));
    const total = Math.round(priced.reduce((sum, i) => sum + i.lineTotal, 0) * 100) / 100;
    res.json({ cart: { ...cart, items: priced }, total, count: cart.items.length });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ====================== SƏBƏT PAYLAŞIMI ======================
// Məntiq və yoxlamalar: services/sharedCart.ts.
const SHARE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function shareToken(len = 10): string {
  let s = '';
  for (let i = 0; i < len; i++) s += SHARE_ALPHABET[Math.floor(Math.random() * SHARE_ALPHABET.length)];
  return s;
}
const shareNum = (v: any) => (v != null && v !== '' && Number.isFinite(parseFloat(String(v))) ? parseFloat(String(v)) : null);

function deliveryFromShare(sc: { deliveryType: string; deliveryMethod: string | null; latitude: number | null; longitude: number | null }): DeliveryChoice {
  return {
    deliveryType: sc.deliveryType === 'PICKUP' ? 'PICKUP' : 'DELIVERY',
    deliveryMethod: sc.deliveryType === 'PICKUP' ? null : (sc.deliveryMethod === 'SELF' ? 'SELF' : sc.deliveryMethod === 'COURIER' ? 'COURIER' : null),
    latitude: sc.latitude, longitude: sc.longitude,
  };
}

// Səbəti paylaş.
//   deliveryMode=SENDER    → «başqası ödəsin»: ünvan + çatdırılma üsulunu paylaşan seçir, açan yalnız ödəyir
//   deliveryMode=RECIPIENT → açan öz səbətinə atıb adi qaydada alır; kind=BUNDLE → «paket / resept»
// Məhsullar ya səbətdən (itemIds), ya da birbaşa (items:[{listingId,quantity}]) gəlir.
// notes: {cartItemId|listingId: "qeyd"} — hər məhsula istifadə qeydi (resept üçün).
router.post('/cart/share', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const me = req.adminId!;
    const notes: Record<string, string> = req.body?.notes && typeof req.body.notes === 'object' ? req.body.notes : {};
    const noteFor = (...keys: any[]) => { for (const k of keys) { const v = notes[String(k)]; if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 300); } return null; };
    let items: SharedItemInput[] = [];
    let chosenCartItemIds: number[] = [];
    if (Array.isArray(req.body?.items) && req.body.items.length) {
      items = req.body.items.slice(0, 50).map((i: any) => ({ listingId: parseInt(String(i.listingId)), quantity: Math.max(1, parseInt(String(i.quantity)) || 1), note: (i.note ? String(i.note).trim().slice(0, 300) : null) || noteFor(i.listingId) }))
        .filter((i: SharedItemInput) => Number.isFinite(i.listingId));
    } else {
      const cart = await prisma.cart.findUnique({ where: { userId: me }, include: { items: true } });
      if (!cart || cart.items.length === 0) { res.status(400).json({ success: false, message: 'Səbət boşdur' }); return; }
      const rawSel: any[] = Array.isArray(req.body.itemIds) ? req.body.itemIds : [];
      const selIds = new Set(rawSel.map((x) => parseInt(String(x))).filter((n) => n > 0));
      const chosen = selIds.size ? cart.items.filter((i) => selIds.has(i.id)) : cart.items;
      chosenCartItemIds = chosen.map((i) => i.id);
      items = chosen.map((i) => ({ listingId: i.listingId, quantity: i.quantity, note: noteFor(i.id, i.listingId) }));
    }
    if (items.length === 0) { res.status(400).json({ success: false, message: 'Məhsul seçilməyib' }); return; }
    if (items.some((i) => i.listingId && false)) void 0;

    const deliveryMode = String(req.body.deliveryMode || '').toUpperCase() === 'SENDER' ? 'SENDER' : 'RECIPIENT';
    const kind = String(req.body.kind || '').toUpperCase() === 'BUNDLE' ? 'BUNDLE' : 'CART';
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 1000) : null;

    // Məhsulu KİM alacaq / linki KİMƏ göndəririk.
    //   SENDER: recipientUserId → məhsul dosta gedir (yoxsa paylaşanın özünə).
    //   RECIPIENT/BUNDLE: recipientUserId → linki həmin şəxsə bildiriş + mesajla göndəririk.
    let recipientUserId: number | null = null;
    const rawRecipient = parseInt(String(req.body?.recipientUserId ?? ''));
    if (rawRecipient > 0 && rawRecipient !== me) {
      const r = await prisma.user.findUnique({ where: { id: rawRecipient }, select: { id: true, isBlocked: true, type: true } });
      if (!r) { res.status(400).json({ success: false, message: 'Seçilmiş şəxs saytda qeydiyyatlı deyil' }); return; }
      if (r.isBlocked) { res.status(400).json({ success: false, message: 'Seçilmiş şəxsin hesabı bloklanıb' }); return; }
      if (!BUYER_TYPES.includes(r.type)) { res.status(400).json({ success: false, message: 'Bu hesab məhsul ala bilməz' }); return; }
      recipientUserId = r.id;
    }

    // SENDER: ünvan + çatdırılma üsulu İNDİ seçilir və ödəniş qaydaları ilə yoxlanır —
    // ödəyən sonra heç nə seçmir, yalnız ödəyir.
    let loc: any = {};
    let delivery: DeliveryChoice | null = null;
    if (deliveryMode === 'SENDER') {
      const dType = String(req.body.deliveryType || 'DELIVERY').toUpperCase() === 'PICKUP' ? 'PICKUP' : 'DELIVERY';
      const dMethod = dType === 'PICKUP' ? null : (String(req.body.deliveryMethod || 'COURIER').toUpperCase() === 'SELF' ? 'SELF' : 'COURIER');
      loc = {
        address: req.body.address?.trim() || null, city: req.body.city?.trim() || null,
        latitude: shareNum(req.body.latitude), longitude: shareNum(req.body.longitude), phone: req.body.phone?.trim() || null,
        deliveryType: dType, deliveryMethod: dMethod,
      };
      if (dType === 'DELIVERY' && !loc.address) { res.status(400).json({ success: false, message: 'Çatdırılma ünvanını seçin' }); return; }
      if (!loc.phone) { res.status(400).json({ success: false, message: 'Əlaqə telefonunu yazın (kuryer/satıcı zəng edə bilsin)' }); return; }
      delivery = { deliveryType: dType, deliveryMethod: dMethod as any, latitude: loc.latitude, longitude: loc.longitude };
    }
    const v = await validateSharedItems(items, delivery, { card: deliveryMode === 'SENDER' });
    if (!v.ok) { res.status(400).json({ success: false, message: v.message }); return; }

    // Qiymət surəti (ödəyən qiymət dəyişibsə xəbərdar olsun) + referal (paylaşan uyğundursa).
    const snap = items.map((i) => ({ ...i, price: v.lines.find((l) => l.listingId === i.listingId)?.unit }));
    const withRef = await attachReferral(me, snap);

    let token = shareToken();
    for (let i = 0; i < 5; i++) {
      try {
        await prisma.sharedCart.create({
          data: {
            token, userId: me, title: req.body?.title?.trim()?.slice(0, 80) || null, items: withRef as any, deliveryMode, recipientUserId,
            kind, note, expiresAt: new Date(Date.now() + SHARE_LINK_DAYS * 24 * 3600 * 1000), ...loc,
          },
        });
        break;
      } catch { token = shareToken(); }
    }

    // Paket/link konkret şəxsə göndərilirsə — bildiriş + söhbətdə mesaj.
    if (recipientUserId && deliveryMode !== 'SENDER') {
      const meU = await prisma.user.findUnique({ where: { id: me }, select: { name: true, profession: true } });
      const fe = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const label = kind === 'BUNDLE' ? 'məhsul paketi (resept)' : 'səbət';
      const text = `${kind === 'BUNDLE' ? '📋' : '🛒'} Sizin üçün ${label} hazırladım${note ? `: ${note}` : ''}\n${fe}/shared/${token}`;
      await prisma.message.create({ data: { senderId: me, receiverId: recipientUserId, content: text } }).catch(() => {});
      await prisma.notification.create({
        data: { userId: recipientUserId, type: 'MESSAGE', title: `${meU?.name || 'İstifadəçi'} sizə ${label} göndərdi`, body: `${items.length} məhsul${note ? ` — ${note.slice(0, 120)}` : ''}. Açıb səbətinizə əlavə edin.`, link: `/shared/${token}` },
      }).catch(() => {});
      pushLive(recipientUserId, { kind: 'notification', toast: `${meU?.name || 'İstifadəçi'} sizə ${label} göndərdi`, tone: 'info' });
    }
    // Paylaşılan məhsulları öz səbətindən çıxar (paket göndərəndə — öz alışı ilə qarışmasın).
    if (req.body?.removeFromCart === true && chosenCartItemIds.length) {
      await prisma.cartItem.deleteMany({ where: { id: { in: chosenCartItemIds }, cart: { userId: me } } }).catch(() => {});
    }
    res.json({ success: true, token, expiresAt: new Date(Date.now() + SHARE_LINK_DAYS * 24 * 3600 * 1000), referral: withRef.some((i) => i.referralCartId) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Mənim paylaşdığım linklər (status ilə).
router.get('/me/shared-carts', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.sharedCart.findMany({ where: { userId: req.adminId! }, orderBy: { createdAt: 'desc' }, take: 100 });
    const orderIds = rows.flatMap((r) => r.orderIds);
    const orders = orderIds.length ? await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, paymentStatus: true, status: true, total: true } }) : [];
    const recips = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.recipientUserId).filter((x): x is number => !!x) } }, select: { id: true, name: true } });
    const now = new Date();
    res.json({
      success: true,
      links: rows.map((r) => {
        const os = orders.filter((o) => r.orderIds.includes(o.id));
        return {
          token: r.token, title: r.title, kind: r.kind, deliveryMode: r.deliveryMode, note: r.note, createdAt: r.createdAt, expiresAt: r.expiresAt,
          itemCount: Array.isArray(r.items) ? (r.items as any[]).length : 0,
          recipient: recips.find((u) => u.id === r.recipientUserId)?.name || null,
          state: r.cancelledAt ? 'CANCELLED' : os.some((o) => o.paymentStatus === 'PAID') ? 'PAID' : r.expiresAt && r.expiresAt < now ? 'EXPIRED' : 'OPEN',
          paidTotal: os.filter((o) => o.paymentStatus === 'PAID').reduce((s, o) => s + o.total, 0),
        };
      }),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Paylaşan linki dayandırır.
router.delete('/shared-cart/:token', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const sc = await prisma.sharedCart.findUnique({ where: { token: String(req.params.token) } });
    if (!sc || sc.userId !== req.adminId) { res.status(404).json({ success: false, message: 'Link tapılmadı' }); return; }
    await prisma.sharedCart.update({ where: { id: sc.id }, data: { cancelledAt: new Date() } });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Paylaşılan səbəti gör (açıq — linki açan giriş etmədən baxa bilər).
router.get('/shared-cart/:token', async (req: AuthRequest, res: Response) => {
  try {
    const sc = await prisma.sharedCart.findUnique({ where: { token: req.params.token } });
    if (!sc) { res.status(404).json({ success: false, message: 'Səbət tapılmadı' }); return; }
    const by = await prisma.user.findUnique({ where: { id: sc.userId }, select: { id: true, name: true, profession: true, avatar: true } });
    const raw = Array.isArray(sc.items) ? (sc.items as any[]) : [];
    const listings = await prisma.listing.findMany({
      where: { id: { in: raw.map((i) => Number(i.listingId)) } },
      select: { id: true, title: true, price: true, images: true, stock: true, status: true, archivedAt: true, expiresAt: true, businessId: true, businessObjectId: true, user: { select: { id: true, name: true } } },
    });
    const now = new Date();
    const result = raw.map((i) => {
      const l = listings.find((x) => x.id === Number(i.listingId));
      if (!l) return null;
      const onSale = l.status === 'APPROVED' && !l.archivedAt && (!l.expiresAt || l.expiresAt > now);
      return {
        ...l, quantity: i.quantity, note: i.note || null,
        available: onSale && l.stock >= i.quantity,
        unavailableReason: !onSale ? 'Satışda deyil' : l.stock < i.quantity ? `Stokda ${l.stock} ədəd var` : null,
        sharedPrice: i.price ?? null, priceChanged: i.price != null && Math.abs(i.price - l.price) > 0.009,
        referral: !!i.referralCartId,
      };
    }).filter(Boolean) as any[];
    const total = result.filter((x) => x.available).reduce((s: number, x: any) => s + x.price * x.quantity, 0);
    const recipient = sc.recipientUserId
      ? await prisma.user.findUnique({ where: { id: sc.recipientUserId }, select: { id: true, name: true, avatar: true } })
      : by;
    const paidOrder = sc.orderIds.length
      ? await prisma.order.findFirst({ where: { id: { in: sc.orderIds }, paymentStatus: 'PAID' }, select: { id: true } })
      : null;
    const closed = sc.cancelledAt ? 'Paylaşan bu linki dayandırıb' : sc.expiresAt && sc.expiresAt < now ? 'Linkin müddəti bitib' : null;
    res.json({
      success: true, title: sc.title, kind: sc.kind, note: sc.note, by, items: result, total, count: result.length,
      deliveryMode: sc.deliveryMode, recipient, expiresAt: sc.expiresAt, closed,
      // SENDER: ünvan + çatdırılma paylaşan tərəfindən seçilib → açan yalnız ödəyir (hesab lazım deyil).
      // RECIPIENT/BUNDLE: açan məhsulları öz səbətinə atıb adi qaydada alır.
      payable: !paidOrder && !closed && sc.deliveryMode === 'SENDER' && result.every((x: any) => x.available),
      needsAddress: false,
      paid: !!paidOrder,
      delivery: sc.deliveryMode === 'SENDER' ? {
        type: sc.deliveryType, method: sc.deliveryMethod,
        address: sc.address, city: sc.city, latitude: sc.latitude, longitude: sc.longitude, phone: sc.phone,
      } : null,
      deliveryAddress: sc.deliveryMode === 'SENDER' ? { address: sc.address, city: sc.city, latitude: sc.latitude, longitude: sc.longitude, phone: sc.phone } : null,
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// "BAŞQASI ÖDƏSİN" (qonaq ödənişi) — yalnız SENDER linki.
// Paylaşan hər şeyi seçib (məhsullar, ünvan/konum, çatdırılma üsulu). Linki açan
// YALNIZ ödəyir, hesabı olmaya bilər. Sifariş adi kart sifarişi kimi yaranır:
// pillə qiyməti, çatdırılma haqqı (Yango), konum, referal — checkout ilə eyni.
const guestPayLimiter = rateLimit(12, 10 * 60 * 1000);

router.post('/shared-cart/:token/pay', guestPayLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const sc = await prisma.sharedCart.findUnique({ where: { token: String(req.params.token) } });
    if (!sc) { res.status(404).json({ success: false, message: 'Link tapılmadı' }); return; }
    if (sc.cancelledAt) { res.status(410).json({ success: false, message: 'Paylaşan bu linki dayandırıb' }); return; }
    if (sc.expiresAt && sc.expiresAt < new Date()) { res.status(410).json({ success: false, message: 'Linkin müddəti bitib' }); return; }
    if (sc.deliveryMode !== 'SENDER') {
      res.status(400).json({ success: false, message: 'Bu linkdə məhsulları öz səbətinizə əlavə edib adi qaydada alırsınız', importInstead: true }); return;
    }
    if (sc.orderIds.length) {
      const already = await prisma.order.findFirst({ where: { id: { in: sc.orderIds }, paymentStatus: 'PAID' }, select: { id: true } });
      if (already) { res.status(409).json({ success: false, message: 'Bu link artıq ödənilib' }); return; }
    }
    const buyerId = sc.recipientUserId || sc.userId;
    const buyer = await prisma.user.findUnique({ where: { id: buyerId }, select: { id: true, isBlocked: true } });
    if (!buyer || buyer.isBlocked) { res.status(400).json({ success: false, message: 'Alıcı hesabı əlçatan deyil' }); return; }
    if (req.adminId && req.adminId === buyerId && !req.body?.selfPay) void 0;

    const items = (Array.isArray(sc.items) ? (sc.items as any[]) : []) as SharedItemInput[];
    const v = await validateSharedItems(items, deliveryFromShare(sc), { card: true });
    if (!v.ok) { res.status(400).json({ success: false, message: v.message }); return; }

    const payerName = String(req.body?.payerName || '').trim().slice(0, 80) || null;
    const payerPhone = String(req.body?.payerPhone || '').trim().slice(0, 32) || null;
    const payerUserId = req.adminId || null;
    // Sifarişlər SATICI + BİRGƏ ALIŞ pəncərəsi üzrə bölünür (checkout ilə eyni):
    // birgə alış məhsulu öz sifarişini alır və pəncərəyə qoşulur — əks halda alıcı
    // tam qiyməti ödəyib qrup endirimindən kənarda qalardı.
    const byKey = new Map<string, { sellerId: number; groupBuyId: number | null; lines: typeof v.lines }>();
    for (const l of v.lines) {
      const gid = l.groupBuy ? await ensureActiveGroup(l.listingId, buyerId) : null;
      const key = `${l.sellerId}:${gid ?? 0}`;
      const e = byKey.get(key) || { sellerId: l.sellerId, groupBuyId: gid, lines: [] as typeof v.lines };
      e.lines.push(l); byKey.set(key, e);
    }
    const feeCharged = new Set<number>();

    const created: { id: number; total: number }[] = [];
    for (const { sellerId, groupBuyId, lines } of byKey.values()) {
      const goods = Math.round(lines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100;
      // Kuryer bir dəfə gəlir — çatdırılma haqqı satıcı üzrə BİR dəfə.
      const fee = feeCharged.has(sellerId) ? 0 : (v.feeBySeller.get(sellerId) || 0);
      if (fee > 0) feeCharged.add(sellerId);
      const ref = await computeOrderReferral(buyerId, lines.map((l) => ({ referralCartId: l.referralCartId, listingId: l.listingId, lineTotal: l.lineTotal })));
      const order = await prisma.order.create({
        data: {
          buyerId, sellerId, subtotal: goods, total: Math.round((goods + fee) * 100) / 100,
          status: 'PENDING', paymentMethod: 'CARD', paymentStatus: 'PENDING',
          deliveryType: sc.deliveryType === 'PICKUP' ? 'PICKUP' : 'DELIVERY',
          deliveryMethod: sc.deliveryType === 'PICKUP' ? null : (sc.deliveryMethod === 'SELF' ? 'SELF' : 'COURIER'),
          deliveryFee: fee,
          address: sc.deliveryType === 'PICKUP' ? null : [sc.city, sc.address].filter(Boolean).join(', '),
          phone: sc.phone, latitude: sc.latitude, longitude: sc.longitude,
          note: sc.note || null,
          pickupCode: genPickupCode(),
          sharedCartId: sc.id, payerName, payerPhone, payerUserId, groupBuyId,
          referrerId: ref?.referrerId ?? null, referralPercent: ref?.percent ?? null, referralAmount: ref?.amount ?? null, referralCartId: ref?.referralCartId ?? null,
          items: { create: lines.map((l) => ({ listingId: l.listingId, quantity: l.quantity, price: l.unit, title: l.title, referralPercent: ref?.perItem.get(l.listingId)?.percent ?? null, referralAmount: ref?.perItem.get(l.listingId)?.amount ?? null })) },
        } as any,
        select: { id: true, total: true },
      });
      created.push(order);
    }

    const grandTotal = Math.round(created.reduce((sum, o) => sum + o.total, 0) * 100) / 100;
    try {
      const pay = await createGatewayPayment({
        amount: grandTotal, reference: `SH${created[0].id}`, title: 'tradixai',
        description: `Paylaşılan alış #${created.map((o) => o.id).join(',')}`, callbackBase: PUBLIC_BACKEND_URL,
      });
      await prisma.order.updateMany({
        where: { id: { in: created.map((o) => o.id) } },
        data: { gatewayProvider: pay.provider, gatewayRef: pay.ref, gatewayOrderId: pay.gatewayOrderId, gatewayPassword: pay.password, gatewayStatus: pay.status },
      });
      await prisma.sharedCart.update({ where: { id: sc.id }, data: { orderIds: { set: [...sc.orderIds, ...created.map((o) => o.id)] } } }).catch(() => {});
      res.json({ success: true, paymentUrl: pay.redirectUrl, orderIds: created.map((o) => o.id), total: grandTotal });
    } catch (err: any) {
      console.error('[shared-cart/pay] gateway failed:', err.message);
      await prisma.order.updateMany({ where: { id: { in: created.map((o) => o.id) } }, data: { status: 'CANCELLED', paymentStatus: 'FAILED' } }).catch(() => {});
      res.status(502).json({ success: false, message: 'Ödəniş başladıla bilmədi: ' + err.message });
    }
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Ödənişdən sonra qonaq nəticəni görsün (hesabı olmadığı üçün /orders-a girə bilmir).
router.get('/shared-cart/:token/status', async (req: AuthRequest, res: Response) => {
  try {
    const sc = await prisma.sharedCart.findUnique({ where: { token: String(req.params.token) }, select: { orderIds: true } });
    if (!sc) { res.status(404).json({ success: false, message: 'Link tapılmadı' }); return; }
    if (!sc.orderIds.length) { res.json({ success: true, status: 'NONE' }); return; }
    const orders = await prisma.order.findMany({ where: { id: { in: sc.orderIds } }, select: { id: true, paymentStatus: true, status: true, total: true }, orderBy: { id: 'desc' } });
    const paid = orders.filter((o) => o.paymentStatus === 'PAID');
    res.json({
      success: true,
      status: paid.length ? 'PAID' : (orders.some((o) => o.paymentStatus === 'FAILED') ? 'FAILED' : 'PENDING'),
      orders: (paid.length ? paid : orders).map((o) => ({ id: o.id, total: o.total, status: o.status })),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Köhnə «birbaşa nağd al» marşrutu checkout qaydalarını keçirdi — indi səbətə yönləndirir.
router.post('/shared-cart/:token/checkout', requireType(BUYER_TYPES), async (_req: AuthRequest, res: Response) => {
  res.status(410).json({ success: false, message: 'Məhsulları səbətinizə əlavə edib adi qaydada alın', importInstead: true });
});

// Paylaşılan səbəti / paketi öz səbətimə əlavə et (sonra adi checkout: öz ünvanım, Yango, kart/nağd).
router.post('/cart/import/:token', requireType(BUYER_TYPES), async (req: AuthRequest, res: Response) => {
  try {
    const sc = await prisma.sharedCart.findUnique({ where: { token: req.params.token } });
    if (!sc) { res.status(404).json({ success: false, message: 'Səbət tapılmadı' }); return; }
    if (sc.cancelledAt) { res.status(410).json({ success: false, message: 'Paylaşan bu linki dayandırıb' }); return; }
    if (sc.expiresAt && sc.expiresAt < new Date()) { res.status(410).json({ success: false, message: 'Linkin müddəti bitib' }); return; }
    const items = Array.isArray(sc.items) ? (sc.items as any[]) : [];
    const pick: number[] | null = Array.isArray(req.body?.listingIds) ? req.body.listingIds.map((x: any) => parseInt(String(x))) : null;
    let cart = await prisma.cart.findUnique({ where: { userId: req.adminId! } });
    if (!cart) cart = await prisma.cart.create({ data: { userId: req.adminId! } });
    let added = 0; const skipped: string[] = [];
    const now = new Date();
    for (const it of items) {
      const lid = Number(it.listingId); const qty = Math.max(1, Number(it.quantity) || 1);
      if (pick && !pick.includes(lid)) continue;
      const listing = await prisma.listing.findUnique({ where: { id: lid }, select: { id: true, title: true, userId: true, stock: true, status: true, archivedAt: true, expiresAt: true } });
      if (!listing) continue;
      if (listing.userId === req.adminId) { skipped.push(`${listing.title}: öz məhsulunuz`); continue; }
      if (listing.status !== 'APPROVED' || listing.archivedAt || (listing.expiresAt && listing.expiresAt <= now)) { skipped.push(`${listing.title}: satışda deyil`); continue; }
      if (listing.stock <= 0) { skipped.push(`${listing.title}: stokda yoxdur`); continue; }
      // Referal (məs. həkimin tövsiyəsi) — link hələ etibarlıdırsa komissiya ona yazılır.
      const referralCartId = it.referralCartId && sc.userId !== req.adminId ? Number(it.referralCartId) : null;
      const cur = await prisma.cartItem.findFirst({ where: { cartId: cart.id, listingId: lid, groupBuyId: null, priceOfferId: null } });
      const q = Math.min(listing.stock, (cur?.quantity || 0) + qty);
      if (cur) await prisma.cartItem.update({ where: { id: cur.id }, data: { quantity: q, ...(referralCartId ? { referralCartId } : {}) } });
      else await prisma.cartItem.create({ data: { cartId: cart.id, listingId: lid, quantity: Math.min(listing.stock, qty), referralCartId } });
      added++;
    }
    if (!added) { res.status(400).json({ success: false, message: skipped.length ? `Heç bir məhsul əlavə olunmadı — ${skipped.join('; ')}` : 'Məhsul seçin' }); return; }
    if (sc.userId !== req.adminId) {
      await prisma.notification.create({
        data: { userId: sc.userId, type: 'SYSTEM', title: sc.kind === 'BUNDLE' ? 'Göndərdiyiniz paket səbətə əlavə olundu' : 'Paylaşdığınız səbət açıldı', body: `${added} məhsul alıcının səbətinə əlavə olundu.`, link: '/shared-links' },
      }).catch(() => {});
    }
    res.json({ success: true, added, skipped });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Alıcı: «Götürmədim» — satıcı təhvil verdiyini bildirib, amma alıcı məhsulu almayıb → mübahisə.
router.post('/orders/:id/pickup-not-received', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const o = await prisma.order.findUnique({ where: { id: parseInt(String(req.params.id)) } });
    if (!o || o.buyerId !== req.adminId) { res.status(404).json({ success: false, message: 'Sifariş tapılmadı' }); return; }
    if (!isPickup(o) || o.status !== 'SHIPPED') { res.status(400).json({ success: false, message: 'Bu sifarişdə bu əməl mümkün deyil' }); return; }
    const description = String(req.body?.description || '').trim();
    if (description.length < 5) { res.status(400).json({ success: false, message: 'Nə baş verdiyini qısaca yazın' }); return; }
    await prisma.order.update({ where: { id: o.id }, data: { pickupConfirmBy: null } }); // avtomatik təsdiq dayanır
    const complaint = await createSellerComplaint({
      complainantId: o.buyerId, targetUserId: o.sellerId, orderId: o.id, category: 'PICKUP_NOT_RECEIVED',
      description: `Satıcı «təhvil verdim» dedi, amma alıcı məhsulu götürmədiyini bildirir: ${description}`,
    });
    pushAdmins('order', { id: o.id, toast: `Sifariş #${o.id}: alıcı məhsulu götürmədiyini bildirir` });
    res.json({ success: true, complaint });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Add to cart
router.post('/cart/add', requireType(BUYER_TYPES), async (req: AuthRequest, res: Response) => {
  try {
    const listingId = parseInt(req.body?.listingId);
    const quantity = parseInt(req.body?.quantity ?? 1);
    if (Number.isNaN(listingId)) {
      res.status(400).json({ success: false, message: 'Yanlış elan ID' }); return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      res.status(400).json({ success: false, message: 'Say 0-dan böyük olmalıdır' }); return;
    }
    const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { priceTiers: true } });
    if (!listing) { res.status(404).json({ success: false, message: 'Elan tapılmadı' }); return; }
    if (listing.userId === req.adminId) { res.status(400).json({ success: false, message: 'Öz elanınızı ala bilməzsiniz' }); return; }

    // ── BİRGƏ ALIŞ ──
    // Səbətdə ayrıca «qrup sətri» YOXDUR: elanda birgə alış açıqdırsa alış
    // sifariş verilən anda avtomatik aktiv pəncərəyə qoşulur (checkout-da).
    let cart = await prisma.cart.findUnique({ where: { userId: req.adminId! } });
    if (!cart) cart = await prisma.cart.create({ data: { userId: req.adminId! } });

    // Yalnız ADİ sətir artırılır. «Daha ucuza axtar» ilə razılaşdırılmış
    // təklif sətri ayrıca qalır — onun sayı və qiyməti sabitdir, qarışmamalıdır.
    const existing = await prisma.cartItem.findFirst({
      where: { cartId: cart.id, listingId, priceOfferId: null },
    });
    const offerQty = (await prisma.cartItem.aggregate({
      where: { cartId: cart.id, listingId, priceOfferId: { not: null } }, _sum: { quantity: true },
    }))._sum.quantity || 0;

    // H2 fix: validate combined quantity (existing + new) against stock.
    // Stok hər iki sətrin cəminə görə yoxlanır.
    const totalRequested = (existing?.quantity || 0) + quantity;
    if (listing.stock < totalRequested + offerQty) {
      res.status(400).json({
        success: false,
        message: offerQty
          ? `Kifayət qədər stok yoxdur (mövcud: ${listing.stock}, ${offerQty} ədədi razılaşdırılmış qiymətlə səbətdədir)`
          : `Kifayət qədər stok yoxdur (mövcud: ${listing.stock})`,
      });
      return;
    }

    let item;
    if (existing) {
      item = await prisma.cartItem.update({
        where: { id: existing.id },
        data: { quantity: totalRequested },
      });
    } else {
      item = await prisma.cartItem.create({
        data: { cartId: cart.id, listingId, quantity },
      });
    }
    res.status(201).json({ success: true, item });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Update cart item quantity
router.put('/cart/item/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    // H12 fix: validate quantity > 0 and check stock.
    const itemId = parseInt(req.params.id);
    const quantity = parseInt(req.body?.quantity);
    if (Number.isNaN(itemId)) {
      res.status(400).json({ success: false, message: 'Yanlış ID' }); return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      res.status(400).json({ success: false, message: 'Say 0-dan böyük olmalıdır' }); return;
    }
    const item = await prisma.cartItem.findUnique({
      where: { id: itemId },
      include: { cart: true, listing: { select: { stock: true, title: true } } },
    });
    if (!item || item.cart.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    if (item.listing.stock < quantity) {
      res.status(400).json({
        success: false,
        message: `Kifayət qədər stok yoxdur (mövcud: ${item.listing.stock})`,
      });
      return;
    }
    if ((item as any).priceOfferId && quantity !== item.quantity) {
      res.status(400).json({ success: false, message: `Razılaşdırılmış qiymət ${item.quantity} ədəd üçündür — sayı dəyişmək üçün yeni təklif göndərin` });
      return;
    }
    // M11 fix: include listing data in response so frontend doesn't need to refetch.
    const updated = await prisma.cartItem.update({
      where: { id: item.id },
      data: { quantity },
      include: { listing: true },
    });
    res.json({ success: true, item: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Remove from cart
router.delete('/cart/item/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const item = await prisma.cartItem.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { cart: true },
    });
    if (!item || item.cart.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    await prisma.cartItem.delete({ where: { id: item.id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Səbəti tamamilə boşalt (AI köməkçi və «hamısını sil» düyməsi üçün).
router.delete('/cart/clear', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const cart = await prisma.cart.findUnique({ where: { userId: req.adminId! }, select: { id: true } });
    if (!cart) { res.json({ success: true, removed: 0 }); return; }
    const r = await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    res.json({ success: true, removed: r.count });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Checkout (Bolt Food benzeri: delivery/pickup + scheduled + promo + loyalty)
router.post('/cart/checkout', requireType(BUYER_TYPES), async (req: AuthRequest, res: Response) => {
  try {
    const {
      address, phone, note,
      deliveryType = 'DELIVERY',
      deliveryMethod = 'COURIER', // alıcının seçimi: COURIER (Yango) | SELF (satıcı özü)
      scheduledAt,
      paymentMethod = 'CASH',
      promoCode,
      usePoints = 0,
      latitude, longitude,
      installmentMonths,     // hissəli alış planı (yalnız biznes məhsulları + kart)
      savedCardId,           // saxlanmış kartla ödəniş (yönləndirmə olmadan)
      saveCard,              // yeni kartla ödəyəndə "kartı yadda saxla"
    } = req.body;

    // HÜQUQİ QAPI: qaydalar qəbul edilməyibsə sifariş verilmir.
    // Qeydiyyatda qəbul MƏCBURİ DEYİL (istifadəçi keçə bilər) — amma alış
    // anında qarşısına çıxır və qəbul etmədən keçmək mümkün deyil.
    const missingDocs = await missingRequiredConsents(req.adminId!);
    if (missingDocs.length) {
      res.status(451).json({
        success: false,
        code: 'CONSENT_REQUIRED',
        message: 'Sifariş vermək üçün qaydaları qəbul etməlisiniz',
        missing: missingDocs.map((d) => ({ slug: d.slug, title: d.title, version: d.version })),
      });
      return;
    }

    const buyerLat = latitude != null && latitude !== '' ? parseFloat(latitude) : null;
    const buyerLng = longitude != null && longitude !== '' ? parseFloat(longitude) : null;
    const dMethod: 'COURIER' | 'SELF' = deliveryMethod === 'SELF' ? 'SELF' : 'COURIER';

    // Biznes adına alış — yalnız canBuy səlahiyyətli ACTIVE işçi (və ya sahib) obyekt seçə bilər.
    let buyerObjectId: number | null = null;
    if (req.body.buyerObjectId) {
      const objId = parseInt(String(req.body.buyerObjectId));
      const obj = await prisma.businessObject.findUnique({ where: { id: objId }, include: { business: { select: { userId: true } } } });
      if (!obj) { res.status(400).json({ success: false, message: 'Seçilmiş obyekt tapılmadı' }); return; }
      let allowed = obj.business.userId === req.adminId;
      if (!allowed) {
        const mem = await prisma.businessMember.findFirst({
          where: { businessId: obj.businessId, userId: req.adminId!, status: 'ACTIVE', canBuy: true, OR: [{ objectId: null }, { objectId: objId }] },
          select: { id: true },
        });
        allowed = !!mem;
      }
      if (!allowed) { res.status(403).json({ success: false, message: 'Bu obyekt adına alış səlahiyyətiniz yoxdur' }); return; }
      buyerObjectId = objId;
    }

    const cart = await prisma.cart.findUnique({
      where: { userId: req.adminId! },
      // Pillələr ödənişdə də lazımdır: qiymət elanın adi qiyməti deyil,
      // seçilən saya (və birgə alışda qrupun sayına) görə hesablanır.
      include: { items: { include: { listing: { include: { priceTiers: true } } } } },
    });
    if (!cart || cart.items.length === 0) {
      res.status(400).json({ success: false, message: 'Səbət boşdur' });
      return;
    }

    // Qismən checkout — yalnız seçilmiş məhsullar (itemIds verilməyibsə hamısı).
    const rawSel: any[] = Array.isArray(req.body.itemIds) ? req.body.itemIds : [];
    const selIds = new Set(rawSel.map((x) => parseInt(String(x))).filter((n) => n > 0));
    if (selIds.size) {
      cart.items = cart.items.filter((i) => selIds.has(i.id));
      if (cart.items.length === 0) { res.status(400).json({ success: false, message: 'Seçilmiş məhsul yoxdur' }); return; }
    }

    // BİRGƏ ALIŞ yalnız KARTLA: endirim fərqi sonradan geri qaytarılır,
    // nağd ödənişdə platforma pulu qaytara bilmir (pul satıcıdadır).
    if (paymentMethod !== 'CARD' && cart.items.some((i) => groupBuyEnabled(i.listing as any))) {
      res.status(400).json({
        success: false,
        message: 'Birgə alış yalnız kartla ödənişlə mümkündür — endirim fərqi sonradan kartınıza qaytarılır.',
      });
      return;
    }

    // Stok kontrolu (preliminary; final atomic check is inside the transaction below)
    for (const item of cart.items) {
      if (item.listing.stock < item.quantity) {
        res.status(400).json({ success: false, message: `"${item.listing.title}" üçün kifayət qədər stok yoxdur (mövcud: ${item.listing.stock})` });
        return;
      }
    }

    // KART ÖDƏNİŞİ yalnız BİZNESƏ bağlı elanlar üçün mümkündür (VÖEN + bank lazımdır).
    // Fərdi satıcının məhsulu kartla alına bilməz — yalnız nağd/əldən (tap.az kimi).
    if (paymentMethod === 'CARD') {
      // Kart yalnız biznesə bağlı elanlar üçün — businessId və ya (fallback) businessObjectId.
      const nonBusiness = cart.items.filter((i) => !(i.listing.businessId || i.listing.businessObjectId));
      if (nonBusiness.length > 0) {
        res.status(400).json({
          success: false,
          message: `Bu məhsul(lar) yalnız nağd alına bilər: ${nonBusiness.map((i) => `"${i.listing.title}"`).join(', ')}. Satıcı ilə birbaşa danışın.`,
        });
        return;
      }
      // Biznes id-lərini topla; elanda businessId yoxdursa obyektdən çıxar.
      const directBizIds = cart.items.map((i) => i.listing.businessId).filter((x): x is number => !!x);
      const objIds = cart.items.filter((i) => !i.listing.businessId && i.listing.businessObjectId).map((i) => i.listing.businessObjectId as number);
      let objBizIds: number[] = [];
      if (objIds.length) {
        const objs = await prisma.businessObject.findMany({ where: { id: { in: objIds } }, select: { businessId: true } });
        objBizIds = objs.map((o) => o.businessId);
      }
      // Biznes aktiv VƏ təsdiqli olmalıdır.
      const bizIds = Array.from(new Set([...directBizIds, ...objBizIds]));
      const okBiz = await prisma.business.findMany({ where: { id: { in: bizIds }, isActive: true, status: 'APPROVED' }, select: { id: true } });
      if (okBiz.length !== bizIds.length) {
        res.status(400).json({ success: false, message: 'Bu məhsulların biznesi hazırda aktiv deyil — kartla ödəniş mümkün deyil.' });
        return;
      }
    }

    // ── HİSSƏLİ ÖDƏNİŞ (taksit) ──
    // Əvvəl yanlış plan səssizcə atılırdı: alıcı «6 ay» seçib tam məbləği bir
    // dəfəyə ödəyirdi. İndi hər şərt yoxlanır və səbəb alıcıya deyilir.
    let instMonths: number | null = null;
    let instCfg: Awaited<ReturnType<typeof getInstallmentConfig>> | null = null;
    if (installmentMonths !== undefined && installmentMonths !== null && installmentMonths !== '' && Number(installmentMonths) !== 0) {
      if (paymentMethod !== 'CARD') { res.status(400).json({ success: false, message: 'Hissəli ödəniş yalnız kartla mümkündür' }); return; }
      instCfg = await getInstallmentConfig();
      if (!instCfg.available) { res.status(400).json({ success: false, message: `Hissəli ödəniş mümkün deyil: ${instCfg.reason}` }); return; }
      if (savedCardId) { res.status(400).json({ success: false, message: 'Hissəli ödənişdə kart bankın ödəniş səhifəsində seçilir — saxlanmış kartla taksit mümkün deyil' }); return; }
      const n = parseInt(String(installmentMonths), 10);
      if (!monthsAllowedFor(cart.items.map((i) => i.listing as any), n, instCfg.months)) {
        res.status(400).json({ success: false, message: `${n} aylıq plan səbətdəki məhsulların hamısı üçün mümkün deyil (satıcı limiti və ya plan bağlıdır)` }); return;
      }
      const cartGross = cart.items.reduce((sum, i) => sum + i.listing.price * i.quantity, 0);
      if (cartGross < instCfg.minAmount) { res.status(400).json({ success: false, message: `Hissəli ödəniş ${instCfg.minAmount} AZN-dən yuxarı alışlarda mümkündür` }); return; }
      instMonths = n;
    }

    // ── Çatdırılma seçiminin yoxlanması + Yango haqqının hesablanması (satıcı üzrə) ──
    const feeBySeller = new Map<number, number>();
    if (deliveryType === 'DELIVERY') {
      // "Yalnız götürmə" məhsulunda çatdırılma yoxdur (Yango + satıcı çatdırması bağlı).
      const pickupOnlyItem = cart.items.find((i) => (i.listing as any).pickupOnly);
      if (pickupOnlyItem) { res.status(400).json({ success: false, message: `"${pickupOnlyItem.listing.title}" yalnız götürmə ilə satılır — çatdırılma mümkün deyil.` }); return; }
      if (dMethod === 'SELF') {
        // Satıcı özü çatdırılma — bütün elanlar buna icazə verməlidir.
        const notAllowed = cart.items.find((i) => !(i.listing as any).allowSelfDelivery);
        if (notAllowed) { res.status(400).json({ success: false, message: `"${notAllowed.listing.title}" üçün satıcı özü çatdırılma təklif etmir` }); return; }
      } else {
        // Yango (kuryer) — alıcının koordinatı tələb olunur; haqqı check-price ilə hesablanır.
        if (buyerLat == null || buyerLng == null) { res.status(400).json({ success: false, message: 'Yango çatdırılması üçün xəritədən konum seçin' }); return; }
        const grp = new Map<number, typeof cart.items>();
        for (const it of cart.items) { const a = grp.get(it.listing.userId) || []; a.push(it); grp.set(it.listing.userId, a); }
        // Yük limiti (50 kq) — hər satıcı (bir claim) üzrə çəki yoxlanır.
        for (const [, items] of grp.entries()) {
          const w = items.reduce((s, i) => s + i.quantity * ((i.listing as any).weightKg || 0), 0);
          if (w > YANGO_MAX_WEIGHT_KG) {
            res.status(400).json({ success: false, message: `Sifariş çəkisi ${w} kq-dır — Yango limiti ${YANGO_MAX_WEIGHT_KG} kq. Kuryer mümkün deyil; "mağazadan götürmə" və ya "satıcı özü çatdırır" seçin.` });
            return;
          }
        }
        if (isYangoConfigured()) {
          const objIds = Array.from(new Set(cart.items.map((i) => (i.listing as any).businessObjectId).filter((x): x is number => !!x)));
          const objs = objIds.length ? await prisma.businessObject.findMany({ where: { id: { in: objIds } }, select: { id: true, latitude: true, longitude: true } }) : [];
          const objMap = new Map(objs.map((o) => [o.id, o]));
          for (const [sellerId, items] of grp.entries()) {
            const withObj = items.find((i) => (i.listing as any).businessObjectId && objMap.get((i.listing as any).businessObjectId)?.latitude != null);
            const obj = withObj ? objMap.get((withObj.listing as any).businessObjectId) : null;
            if (obj && obj.latitude != null && obj.longitude != null) {
              const weightKg = items.reduce((s, i) => s + i.quantity * ((i.listing as any).weightKg || 1), 0);
              const q = await yangoCheckPrice({ source: [obj.longitude, obj.latitude], destination: [buyerLng, buyerLat], weightKg });
              if (q.ok && q.data?.price) feeBySeller.set(sellerId, parseFloat(String(q.data.price)) || 0);
            }
          }
        }
      }
    }

    // Kullanici bilgilerini al (loyalty points kontrolu)
    const user = await prisma.user.findUnique({ where: { id: req.adminId! } });
    if (!user) {
      res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' });
      return;
    }
    const pointsToUse = Math.max(0, Math.min(parseInt(usePoints) || 0, user.loyaltyPoints));
    const pointsDiscount = pointsToUse * 0.01; // 1 puan = 0.01 AZN

    // Promo kod dogrulama
    let promoCodeRecord: any = null;
    let promoDiscount = 0;
    // ── HƏR SƏTİRİN VAHİD QİYMƏTİ ──
    // Adi sətir: say-qiymət pilləsinə görə (çox alanda ucuz).
    // Birgə alış sətri: QRUPUN ümumi sayı + bu alış — qiymət hamıya eynidir.
    const unitPrices = new Map<number, number>();
    for (const i of cart.items) {
      // RAZILAŞDIRILMIŞ QİYMƏT TƏKLİFİ — etibarlıdırsa vahid qiymət təklifdən gəlir.
      if ((i as any).priceOfferId) {
        const v = await validOfferPrice((i as any).priceOfferId, req.adminId!, i.listingId, i.quantity);
        if (!v.ok) { res.status(400).json({ success: false, message: `«${i.listing.title}»: ${v.message}` }); return; }
        unitPrices.set(i.id, v.unit);
        continue;
      }
      const tiers: Tier[] = ((i.listing as any).priceTiers || []).map((t: any) => ({ minQty: t.minQty, price: t.price }));
      // BİRGƏ ALIŞ: tam qiymət ödənilir, endirim sonra qaytarılır.
      let unit = i.listing.price;
      if (!groupBuyEnabled(i.listing as any) && tiers.length) {
        unit = unitPriceFor(i.listing.price, tiers, i.quantity);
      }
      unitPrices.set(i.id, unit);
    }
    const unitOf = (i: { id: number; listing: { price: number } }) => unitPrices.get(i.id) ?? i.listing.price;

    const subtotal = cart.items.reduce((sum, i) => sum + unitOf(i) * i.quantity, 0);
    if (promoCode) {
      promoCodeRecord = await prisma.promoCode.findUnique({ where: { code: promoCode.toUpperCase() } });
      if (promoCodeRecord && promoCodeRecord.active) {
        const now = new Date();
        const valid = promoCodeRecord.validFrom <= now &&
                      (!promoCodeRecord.validUntil || promoCodeRecord.validUntil >= now) &&
                      (!promoCodeRecord.usageLimit || promoCodeRecord.usageCount < promoCodeRecord.usageLimit) &&
                      (!promoCodeRecord.minOrderAmount || subtotal >= promoCodeRecord.minOrderAmount);
        if (valid) {
          if (promoCodeRecord.discountType === 'PERCENT') {
            promoDiscount = (subtotal * promoCodeRecord.discountValue) / 100;
            if (promoCodeRecord.maxDiscount && promoDiscount > promoCodeRecord.maxDiscount) {
              promoDiscount = promoCodeRecord.maxDiscount;
            }
          } else {
            promoDiscount = promoCodeRecord.discountValue;
          }
        }
      }
    }

    // Sifarişlər SATICI + BİRGƏ ALIŞ üzrə bölünür.
    // Birgə alış sətri öz sifarişini alır: qiymət sonradan qrupun sayına görə
    // dəyişə bilir (fərq geri qaytarılır) və bu, adi məhsullarla qarışmamalıdır.
    // Hansı sətir hansı BİRGƏ ALIŞ pəncərəsinə düşür — pəncərə yoxdursa
    // elə burada açılır (ilk alıcı geri sayımı başladır).
    const groupOfItem = new Map<number, number | null>();
    for (const item of cart.items) {
      // Təklif qiyməti ilə alınan məhsul birgə alışa qoşulmur (qiymət artıq razılaşdırılıb).
      groupOfItem.set(item.id, groupBuyEnabled(item.listing as any) && !(item as any).priceOfferId
        ? await ensureActiveGroup(item.listingId, req.adminId!)
        : null);
    }

    const bySeller = new Map<string, typeof cart.items>();
    const groupOfKey = new Map<string, number | null>();
    const sellerOfKey = new Map<string, number>();
    for (const item of cart.items) {
      const key = `${item.listing.userId}:${groupOfItem.get(item.id) ?? 0}`;
      const arr = bySeller.get(key) || [];
      arr.push(item);
      bySeller.set(key, arr);
      groupOfKey.set(key, groupOfItem.get(item.id) ?? null);
      sellerOfKey.set(key, item.listing.userId);
    }
    const sellerCount = bySeller.size;

    const orders = await prisma.$transaction(async (tx) => {
      const createdOrders: any[] = [];

      // C7 fix: Allocate discount sequentially. Use leftover-rolling so the
      // full discount is applied even when one seller's subtotal is smaller
      // than its naive equal share.
      let promoRemaining = promoDiscount;
      let pointsRemaining = pointsToUse;
      const feeCharged = new Set<number>();

      // Distribute points fairly: integer pieces summing exactly to pointsToUse.
      // Last seller absorbs rounding remainder so total == pointsToUse exactly.
      const pointsBuckets: number[] = [];
      const evenShare = Math.floor(pointsToUse / sellerCount);
      let assigned = 0;
      for (let i = 0; i < sellerCount; i++) {
        if (i === sellerCount - 1) pointsBuckets.push(pointsToUse - assigned);
        else { pointsBuckets.push(evenShare); assigned += evenShare; }
      }

      let bucketIdx = 0;
      for (const [key, items] of bySeller.entries()) {
        const sellerId = sellerOfKey.get(key)!;
        const groupBuyId = groupOfKey.get(key) ?? null;
        const sellerSubtotal = items.reduce((sum, i) => sum + unitOf(i) * i.quantity, 0);
        const sellerPointsUsed = pointsBuckets[bucketIdx++];

        // Apply remaining promo first (capped by what this seller's subtotal can absorb).
        const promoApplied = Math.min(promoRemaining, sellerSubtotal);
        promoRemaining -= promoApplied;

        // Then apply remaining points.
        const remainingAfterPromo = sellerSubtotal - promoApplied;
        const pointsAppliedAzn = Math.min(pointsRemaining * 0.01, remainingAfterPromo);
        const pointsAppliedRaw = Math.round(pointsAppliedAzn * 100); // back to point units
        pointsRemaining -= pointsAppliedRaw;

        const actualDiscount = promoApplied + pointsAppliedRaw * 0.01;
        // Yango çatdırılma haqqı (yalnız kuryer+çatdırılma seçimində) cəmə əlavə olunur.
        // Bir satıcının həm adi, həm birgə alış sifarişi ola bilər —
        // çatdırılma haqqı İKİ DƏFƏ alınmamalıdır (kuryer bir dəfə gəlir).
        const feeAlready = feeCharged.has(sellerId);
        const sellerDeliveryFee = deliveryType === 'DELIVERY' && dMethod === 'COURIER' && !feeAlready ? (feeBySeller.get(sellerId) || 0) : 0;
        if (sellerDeliveryFee > 0) feeCharged.add(sellerId);
        // Taksit bank komissiyası — malların ödənilən məbləğindən; alıcı ödəyirsə cəmə əlavə olunur.
        const instFeeAmt = instMonths && instCfg ? installmentFee(Math.max(0, sellerSubtotal - actualDiscount), instCfg.fees[instMonths] || 0) : 0;
        const instBuyerPays = !!(instMonths && instCfg?.buyerPaysFee);
        const total = Math.max(0, sellerSubtotal - actualDiscount) + sellerDeliveryFee + (instBuyerPays ? instFeeAmt : 0);

        // C8 fix: Never mint loyalty points on portions of an order paid with points.
        // Only the cash-paid portion qualifies for new points.
        const cashPaidPortion = Math.max(0, sellerSubtotal - promoApplied - pointsAppliedRaw * 0.01);
        const pointsEarned = Math.floor(cashPaidPortion); // 1 AZN nağd ödənilən = 1 xal

        // C6 fix: atomic stock decrement + check via updateMany with stock>=qty guard.
        // If any update fails the predicate, we throw to roll back the whole transaction.
        // Eyni məhsulun iki sətri ola bilər (qiymət təklifi + adi) — stok CƏMƏ görə yoxlanır.
        const qtyByListing = new Map<number, number>();
        for (const i of items) qtyByListing.set(i.listingId, (qtyByListing.get(i.listingId) || 0) + i.quantity);
        for (const i of items) {
          // Stok burada AZALMIR (nə nağdda, nə kartda) — satıcı sifarişi təsdiqləyəndə
          // azalır (commitStockForOrder). Burada yalnız mövcudluq yoxlanır ki, tükənmiş
          // məhsula sifariş verilməsin. Satıcı ləğv etsə stoka toxunulmayıb.
          if ((i.listing.stock ?? 0) < (qtyByListing.get(i.listingId) || i.quantity)) throw new Error(`"${i.listing.title}" üçün kifayət qədər stok yoxdur`);
        }

        // REFERAL: səbət sətri referal linkindən gəlibsə komissiya hesablanır.
        // Link/proqram/şəxs/məhsul burada YENİDƏN yoxlanır — dayandırılmış link
        // komissiya yaratmır. Baza — sətrin endirimdən sonrakı ödənilən payı.
        const goodsRatio = sellerSubtotal > 0 ? Math.max(0, sellerSubtotal - actualDiscount) / sellerSubtotal : 0;
        const ref = await computeOrderReferral(req.adminId!, items.map((i) => ({
          referralCartId: (i as any).referralCartId ?? null, listingId: i.listingId, lineTotal: unitOf(i) * i.quantity * goodsRatio,
        })));

        const order = await tx.order.create({
          data: {
            buyerId: req.adminId!,
            sellerId,
            subtotal: sellerSubtotal,
            discountAmount: actualDiscount,
            total,
            pointsEarned,
            pointsUsed: sellerPointsUsed,
            address: address || null,
            phone: phone || null,
            note: note || null,
            deliveryType,
            // Çatdırılma metodu alıcının seçimidir (COURIER=Yango | SELF=satıcı özü).
            deliveryMethod: deliveryType === 'PICKUP' ? null : dMethod,
            deliveryFee: sellerDeliveryFee,
            buyerObjectId, // biznes adına alış (canBuy işçi)
            // Hər sifariş üçün unikal təhvil kodu.
            pickupCode: genPickupCode(),
            scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
            paymentMethod,
            // CARD → bank təsdiqləyənə qədər PENDING; WALLET → PAID; CASH → PENDING (çatdırılanda).
            paymentStatus: paymentMethod === 'WALLET' ? 'PAID' : 'PENDING',
            // Hissəli alış — yalnız kartla və yalnız BİZNES məhsullarında.
            // Şərtlər ödənmirsə səssizcə boş qalır (sifariş adi qaydada gedir).
            // Yeni kartla ödəyib "yadda saxla" seçilibsə şlüzə save=y gedir
            // və ödəniş təsdiqlənəndə token yazılır.
            saveCardRequested: paymentMethod === 'CARD' && !savedCardId && saveCard === true,
            // Ay sayı SATICININ elandakı seçimi ilə yoxlanılır: taksiti
            // bağlayıbsa və ya limit qoyubsa (məs. ən çox 6 ay) alıcı daha
            // uzun plan seçə bilmir. Əvvəl yoxlama yalnız «biznes elanıdırmı»
            // idi — satıcının sözü keçmirdi.
            installmentMonths: instMonths,
            installmentFee: instFeeAmt,
            installmentFeePayer: instMonths ? (instBuyerPays ? 'BUYER' : 'SELLER') : null,
            promoCodeId: promoCodeRecord?.id || null,
            groupBuyId,
            referrerId: ref?.referrerId ?? null,
            referralPercent: ref?.percent ?? null,
            referralAmount: ref?.amount ?? null,
            referralCartId: ref?.referralCartId ?? null,
            latitude: latitude ? parseFloat(latitude) : null,
            longitude: longitude ? parseFloat(longitude) : null,
            items: {
              create: items.map((i) => ({
                listingId: i.listingId,
                quantity: i.quantity,
                price: unitOf(i),          // pillə / birgə alış qiyməti
                title: i.listing.title,
                // Referal yalnız linkdən gələn sətrə — eyni məhsulun təklif sətrinə yazılmır.
                referralPercent: (i as any).referralCartId ? ref?.perItem.get(i.listingId)?.percent ?? null : null,
                referralAmount: (i as any).referralCartId ? ref?.perItem.get(i.listingId)?.amount ?? null : null,
              })),
            },
          },
        });

        // SATICIYA BİLDİRİŞ — yalnız sifariş HƏQİQİ olduqda.
        //
        // Kartla ödənişdə sifariş sətri alıcı bank səhifəsinə keçməzdən ƏVVƏL
        // yaradılır. Əvvəl bildiriş elə buradan gedirdi: alıcı «Sifarişi
        // tamamla» düyməsinə basan kimi satıcıya «Sizə yeni sifariş gəldi»
        // düşürdü — alıcı ödəmədən çıxsa belə. Satıcı olmayan sifarişi
        // gözləyirdi. İndi kart sifarişləri üçün bildiriş ödəniş
        // təsdiqləndikdə göndərilir (services/orderNotify).
        if (paymentMethod !== 'CARD') {
          if (ref) {
            await tx.notification.create({ data: { userId: ref.referrerId, type: 'REFERRAL', title: 'Linkinizdən sifariş verildi', body: `Sifariş #${order.id}: komissiya ${ref.amount.toFixed(2)} AZN (çatdırılandan və qaytarma müddəti bitəndən sonra ödənilir).`, link: '/referral-earnings' } });
          }
          await tx.order.update({ where: { id: order.id }, data: { sellerNotifiedAt: new Date() } });
          await tx.notification.create({
            data: {
              userId: sellerId,
              type: 'ORDER',
              title: 'Yeni sifariş',
              body: `Sifariş #${order.id} — ${total.toFixed(2)} AZN (${paymentMethod === 'WALLET' ? 'balansdan ödənildi' : 'nağd'}).`,
              link: '/orders?tab=selling',
            },
          });
        }

        createdOrders.push(order);
      }

      // M14: Single user.update for net loyalty change (was 2 round-trips).
      // CARD: qazanılan xal yalnız ödəniş təsdiqlənəndə (payment callback) hesablanır;
      // burada yalnız istifadə olunan xal çıxılır. CASH/WALLET: dərhal hesablanır.
      const totalPointsEarned = createdOrders.reduce((s, o) => s + o.pointsEarned, 0);
      const earnedNow = paymentMethod === 'CARD' ? 0 : totalPointsEarned;
      const netPointsDelta = earnedNow - pointsToUse;
      if (netPointsDelta !== 0) {
        await tx.user.update({
          where: { id: req.adminId! },
          data: {
            loyaltyPoints: netPointsDelta > 0
              ? { increment: netPointsDelta }
              : { decrement: -netPointsDelta },
          },
        });
      }

      // H10 fix: Promo usageCount is incremented inside the transaction with
      // an atomic check that we haven't exceeded the limit.
      if (promoCodeRecord) {
        if (promoCodeRecord.usageLimit) {
          const r = await tx.promoCode.updateMany({
            where: {
              id: promoCodeRecord.id,
              usageCount: { lt: promoCodeRecord.usageLimit },
            },
            data: { usageCount: { increment: 1 } },
          });
          if (r.count === 0) {
            throw new Error('Promo kodun istifadə limiti tükənib');
          }
        } else {
          await tx.promoCode.update({
            where: { id: promoCodeRecord.id },
            data: { usageCount: { increment: 1 } },
          });
        }
      }

      // Səbətdən silmə: NAĞD/wallet dərhal (sifariş verildi). KART: ödəniş UĞURLU olanda
      // (settleOrders-də) silinir — ödəniş uğursuz olsa məhsullar səbətdə qalıb təkrar alına bilər.
      if (paymentMethod !== 'CARD') {
        // Qiymət təklifləri istifadə olundu — təkrar həmin qiymətlə alınmasın.
        for (const it of cart.items.filter((x: any) => x.priceOfferId)) {
          const ord = createdOrders.find((o: any) => o.sellerId === it.listing.userId && !o.groupBuyId) || createdOrders.find((o: any) => o.sellerId === it.listing.userId);
          await tx.priceOffer.update({ where: { id: (it as any).priceOfferId }, data: { status: 'USED', orderId: ord?.id ?? null } });
        }
        await tx.cartItem.deleteMany({ where: { id: { in: cart.items.map((i) => i.id) } } });
      }

      return createdOrders;
    });

    // BİRGƏ ALIŞ: qiymət BURADA dəyişmir. Hər kəs tam qiyməti ödəyir; endirim
    // 14 günlük qaytarma müddəti bitəndən sonra, məhsulu SAXLAYANLARIN sayına
    // görə hesablanır (services/groupBuy → settleDueGroups). Bu, saxta qrup
    // yığıb sonra məhsulu qaytarmaqla endirim qoparmağın qarşısını alır.

    // KART ÖDƏNİŞİ: transaction commit olandan SONRA (xarici API çağırışı
    // tranzaksiya içində olmamalıdır) Kapital-də bir ödəniş yaradılır və
    // checkout-dakı bütün order-lər həmin gatewayOrderId ilə bağlanır.
    let paymentUrl: string | null = null;
    if (paymentMethod === 'CARD') {
      const grandTotal = orders.reduce((s, o) => s + o.total, 0);
      if (grandTotal <= 0) {
        // Tamamilə endirimlə örtülüb — ödənişə ehtiyac yoxdur (amma yenə satıcı təsdiqi gözlənir).
        await prisma.order.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { paymentStatus: 'PAID' } });
        await recordSettlementMany(orders.map((o) => o.id)).catch(() => {});
        await markOrdersAwaitingConfirm(orders.map((o) => o.id)).catch(() => {});
        // Ödəniş tələb olunmadı, amma sifariş həqiqidir — satıcıya indi xəbər ver.
        await notifySellersNewOrder(orders.map((o) => o.id)).catch(() => {});
      } else if (savedCardId) {
        // ── SAXLANMIŞ KARTLA ÖDƏNİŞ ──
        // Yönləndirmə yoxdur: YIĞIM tokenlə sinxron çəkir, cavab dərhal gəlir.
        const ref = `TX${orders[0].id}`;
        await prisma.order.updateMany({
          where: { id: { in: orders.map((o) => o.id) } },
          data: { gatewayProvider: 'yigim', gatewayRef: ref },
        });
        const r = await chargeSavedCard(req.adminId!, parseInt(String(savedCardId)), grandTotal, ref, `Sifariş #${orders.map((o) => o.id).join(',')}`)
          .catch((e: any) => ({ ok: false, status: '', message: e?.message } as any));
        if (r.ok) {
          // Ödəniş baş tutdu — adi kart callback-i ilə eyni emal.
          await settleOrders({ gatewayRef: ref }, '00', true);
        } else {
          // Kart rədd etdi — sifarişlər ödənilməmiş qalır, alıcı yenidən cəhd edir.
          await prisma.order.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { paymentStatus: 'FAILED', gatewayStatus: r.status || null } });
          res.status(402).json({ success: false, message: r.message || 'Kartdan ödəniş alınmadı', orders: orders.map((o) => o.id) });
          return;
        }
      } else {
        try {
          // Şlüz facade YIĞIM (MAGNET) və ya Kapital-ı seçir (PAYMENT_GATEWAY env).
          const ref = `TX${orders[0].id}`;
          const pay = await createGatewayPayment({
            amount: grandTotal,
            reference: ref,
            title: 'tradixai',
            description: `Sifariş #${orders.map((o) => o.id).join(',')}`,
            callbackBase: PUBLIC_BACKEND_URL,
            saveCard: saveCard === true && !instMonths,
            installmentMonths: instMonths,
          });
          await prisma.order.updateMany({
            where: { id: { in: orders.map((o) => o.id) } },
            data: {
              gatewayProvider: pay.provider,
              gatewayRef: pay.ref,
              gatewayOrderId: pay.gatewayOrderId,
              gatewayPassword: pay.password,
              gatewayStatus: pay.status,
            },
          });
          paymentUrl = pay.redirectUrl;
        } catch (err: any) {
          // Ödəniş başlaya bilmədi → kompensasiya: istifadə olunan xal, promo və
          // order-ləri geri qaytar. (Kartda stok checkout-da AZALDILMIR, ona görə
          // burada stok bərpası YOXDUR — əks halda over-increment olardı.)
          console.error('[checkout] gateway createPayment failed:', err.message);
          try {
            await prisma.$transaction(async (tx) => {
              if (pointsToUse > 0) {
                await tx.user.update({ where: { id: req.adminId! }, data: { loyaltyPoints: { increment: pointsToUse } } });
              }
              if (promoCodeRecord) {
                await tx.promoCode.update({ where: { id: promoCodeRecord.id }, data: { usageCount: { decrement: 1 } } }).catch(() => {});
              }
              await tx.order.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { status: 'CANCELLED', paymentStatus: 'FAILED', referralVoided: true } });
            });
          } catch (rbErr: any) {
            console.error('[checkout] rollback failed:', rbErr.message);
          }
          res.status(502).json({ success: false, message: 'Ödəniş başladıla bilmədi: ' + err.message });
          return;
        }
      }
    }

    res.status(201).json({
      success: true,
      orders,
      paymentUrl, // CARD olduqda — frontend bura yönəltməlidir
      totalDiscount: orders.reduce((s, o) => s + (o.discountAmount || 0), 0),
      pointsEarned: orders.reduce((s, o) => s + o.pointsEarned, 0),
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get my orders (as buyer)
router.get('/orders/buying', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      // Ödənilməmiş KART sifarişi heç bir siyahıda görünmür — ödəniş uğursuzdursa sifariş
      // sanki heç yaranmayıb (nə alıcı, nə satıcı görür). Nağd/wallet normal görünür.
      where: { buyerId: req.adminId!, hiddenForBuyer: false, OR: [{ paymentMethod: { not: 'CARD' } }, { paymentStatus: 'PAID' }] },
      include: {
        // Kart görünüşü üçün məhsulun ilk şəkli.
        items: { include: { listing: { select: { images: true } } } },
        seller: {
          select: {
            id: true, name: true, phone: true,
            workplaces: { select: { latitude: true, longitude: true, address: true } },
          },
        },
        courier: { select: { id: true, name: true, phone: true } },
        buyerObject: { select: { id: true, name: true } },
        returnRequests: { include: { orderItem: true } },
        // Alıcı bu sifarişə artıq satıcı qiyməti veribmi — forma təkrar
        // açılmasın (əvvəl bu məlumat qaytarılmırdı: forma hər dəfə görünür,
        // göndərəndə isə «artıq rating vermisiniz» xətası çıxırdı).
        sellerRating: { select: { rating: true, comment: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    // Alıcının bu məhsullara YAZDIĞI rəylər — «Rəy yaz» düyməsi yazılmış
    // məhsulda «Rəyi dəyiş»ə çevrilsin.
    const listingIds = Array.from(new Set(orders.flatMap((o) => o.items.map((i) => i.listingId))));
    const myReviews = listingIds.length
      ? await prisma.comment.findMany({
          where: { userId: req.adminId!, listingId: { in: listingIds } },
          select: { id: true, listingId: true, rating: true, content: true },
        })
      : [];
    res.json({ orders, myReviews });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get orders for my listings (as seller) — MUST be before /orders/:id to
// avoid being shadowed by Express route matching (the param route would
// catch "selling" as :id and call findUnique({ id: NaN }) → 404).
router.get('/orders/selling', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      // Ödənilməmiş KART sifarişi satıcıya da görünmür (uğursuz ödənişdə qəbul/rədd çıxmasın).
      where: { sellerId: req.adminId!, hiddenForSeller: false, OR: [{ paymentMethod: { not: 'CARD' } }, { paymentStatus: 'PAID' }] },
      include: {
        // Kart görünüşü üçün məhsulun ilk şəkli.
        items: { include: { listing: { select: { images: true } } } },
        buyer: { select: { id: true, name: true, phone: true } },
        buyerObject: { select: { id: true, name: true } },
        referrer: { select: { id: true, name: true, profession: true } },
        returnRequests: {
          include: {
            orderItem: true,
            buyer: { select: { id: true, name: true, phone: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ orders });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get single order detail with live location (buyer or seller or courier)
router.get('/orders/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, message: 'Yanlış ID' });
      return;
    }
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        items: { include: { listing: { select: { id: true, title: true, images: true } } } },
        buyer: { select: { id: true, name: true, phone: true } },
        seller: {
          select: {
            id: true, name: true, phone: true,
            workplaces: { select: { latitude: true, longitude: true, address: true, name: true } },
          },
        },
        courier: { select: { id: true, name: true, phone: true } },
        sellerRating: { select: { rating: true, comment: true } },
      },
    });
    if (!order) {
      res.status(404).json({ success: false, message: 'Sifariş tapılmadı' });
      return;
    }
    // Yalniz alici, satici veya kurye goremez
    if (order.buyerId !== req.adminId && order.sellerId !== req.adminId && order.courierId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    // M5 fix: If caller is buyer, only show the workplace they actually
    // ordered from — not all of seller's workplaces (privacy leak).
    if (order.buyerId === req.adminId && order.seller?.workplaces) {
      // We don't know which exact workplace the buyer ordered from, but we
      // limit to the first one to avoid leaking the full list of seller addresses.
      order.seller.workplaces = order.seller.workplaces.slice(0, 1);
    }
    res.json({ order });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Update order status (seller only) + buyer bildirimi
// Enforces a state machine so a seller cannot skip statuses
// (e.g. PENDING → DELIVERED bypassing the courier).
const ORDER_TRANSITIONS: Record<string, string[]> = {
  PENDING:   ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SHIPPED', 'CANCELLED'],
  SHIPPED:   ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

router.put('/orders/:id/status', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, message: 'Yanlış ID' }); return;
    }
    const next = String(req.body?.status || '').toUpperCase();
    if (!ORDER_TRANSITIONS[next] && next !== 'PENDING') {
      // Allow only enum values defined in the transition map.
      res.status(400).json({ success: false, message: 'Yanlış status' }); return;
    }
    const order = await prisma.order.findUnique({ where: { id } });
    const isSeller = !!order && order.sellerId === req.adminId;
    const isBuyer = !!order && order.buyerId === req.adminId;
    if (!order || (!isSeller && !isBuyer)) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    // Satıcı bütün keçidləri edə bilər; alıcı yalnız: gözləyəni ləğv, göndərilən sifarişi "təhvil aldım".
    // Alıcı: gözləyəni və ya təsdiqlənib hələ GÖNDƏRİLMƏMİŞ sifarişi ləğv edə bilər (ödənilibsə refund olunur);
    // göndərilən sifarişi "təhvil aldım" edə bilər. (Göndərildikdən sonra ləğv yoxdur — mallar yoldadır.)
    const BUYER_TRANSITIONS: Record<string, string[]> = { PENDING: ['CANCELLED'], CONFIRMED: ['CANCELLED'], SHIPPED: ['DELIVERED'] };
    const allowed = [...(isSeller ? (ORDER_TRANSITIONS[order.status] || []) : (BUYER_TRANSITIONS[order.status] || []))];
    // MAĞAZADAN GÖTÜRMƏ: alıcı satıcıdan əvvəl də «götürdüm» deyə bilər; satıcı isə
    // alıcının təhvil kodunu yazaraq birbaşa tamamlaya bilər (kod aşağıda yoxlanır).
    if (isPickup(order) && order.status === 'CONFIRMED') allowed.push('DELIVERED');

    // ── ÇIXILMAZ VƏZİYYƏTİN QARŞISI: dağılmış çatdırılma ──
    //
    // SHIPPED statusunu çox vaxt İNSAN deyil, Yango qoyur: claim `pickuped`
    // olan kimi sifariş avtomatik SHIPPED-ə keçir. Sonra kuryer ləğv edilirsə
    // (satıcı ləğv etdi, kuryer imtina etdi, mal geri qayıtdı) sifariş SHIPPED
    // olaraq qalır — cədvəldə isə SHIPPED-dən yalnız DELIVERED var.
    // Nəticə: heç kim sifarişi bağlaya bilmir. Satıcı "ləğv et" düyməsinə
    // basır → 400, alıcının pulu isə sonsuza qədər ilişib qalır. Halbuki
    // sistem alıcıya məhz "sifarişi ləğv edib pulunuzu geri ala bilərsiniz"
    // bildirişini göndərir (bax: routes/yango.ts, syncOrderStatus).
    //
    // Ona görə: kuryer ARTIQ HƏRƏKƏT ETMƏYƏCƏKSƏ (claim ölü statusdadır)
    // SHIPPED-dən ləğv həm satıcıya, həm alıcıya açılır. Canlı kuryeri olan
    // sifariş isə əvvəlki kimi qorunur — mallar yoldadırsa ləğv yoxdur.
    const deliveryCollapsed =
      order.status === 'SHIPPED' && !!order.yangoClaimId && yangoDead(order.yangoStatus);
    const canCancelStuck = next === 'CANCELLED' && deliveryCollapsed;

    if (!allowed.includes(next) && !canCancelStuck) {
      res.status(400).json({
        success: false,
        message: order.status === 'SHIPPED' && next === 'CANCELLED'
          ? (order.yangoClaimId
            // Yango mal götürüləndən sonra ləğvə icazə vermir — "çatdırılmanı
            // ləğv edin" məsləhəti yanlış idi. Alıcı qəbul etməsə mal geri
            // gəlir və sifariş avtomatik ləğv olunur (routes/yango.ts).
            ? 'Kuryer məhsulu artıq götürüb — sifariş indi ləğv edilə bilməz. Alıcı qəbul etməsə məhsul satıcıya qaytarılacaq və sifariş avtomatik ləğv olunacaq.'
            : 'Sifariş artıq yoldadır — ləğv edilə bilməz. Təhvil verildikdən sonra qaytarma sorğusu göndərə bilərsiniz.')
          : `${order.status} → ${next} keçidi icazə verilmir`,
      });
      return;
    }
    // Kartla ödənilən sifarişi ödəniş təsdiqlənmədən göndərmək olmaz.
    if (order.paymentMethod === 'CARD' && order.paymentStatus !== 'PAID' && (next === 'SHIPPED' || next === 'DELIVERED')) {
      res.status(400).json({ success: false, message: 'Ödəniş təsdiqlənməyib — sifarişi göndərmək olmaz' });
      return;
    }
    // DELIVERED üçün təhvil kodu YALNIZ satıcı təsdiqləyəndə tələb olunur (səhv adama təhvilin
    // qarşısı). Alıcı özü "təhvil aldım" deyəndə kod lazım deyil — özü təsdiqləyir.
    //
    // YANGO sifarişində kod YOXDUR: kod xüsusiyyəti ləğv edilib, alıcı «TX-…»
    // kodunu Yango sifarişində görmür də. Əvvəl Yango ilişəndə (sifariş #88)
    // satıcı sifarişi «çatdırıldı» edə bilmirdi — görünməyən kodu istəyirdi.
    // Kod yalnız mağazadan götürmədə, satıcının özü çatdırmasında və bizim
    // öz kuryerimizdə (courierId) qalır.
    const isYangoOrder = order.deliveryType !== 'PICKUP' && order.deliveryMethod === 'COURIER' && !order.courierId;
    if (next === 'DELIVERED' && isSeller && order.pickupCode && !isYangoOrder) {
      const provided = String(req.body?.code || '').trim().toUpperCase();
      if (provided !== order.pickupCode.toUpperCase()) {
        res.status(400).json({ success: false, message: 'Təhvil kodu yanlışdır. Alıcıdan kodu soruşun.' });
        return;
      }
    }
    // Təsdiqdən sonra malın yola düşməsi üçün son tarix qoyulur. Bu keçsə
    // sifariş avtomatik ləğv olunub pul qaytarılır (kuryer tapılmadı, satıcı
    // göndərmədi, sistemdə problem oldu — alıcının pulu ilişib qalmasın).
    // Yalnız KARTLA ödənilmiş sifarişlərə lazımdır: nağdda pul bizdə deyil.
    let deliveryDeadline: Date | null | undefined;
    if (next === 'CONFIRMED' && order.paymentMethod === 'CARD') {
      const h = await getDeliveryDeadlineHours();
      deliveryDeadline = new Date(Date.now() + h * 3600 * 1000);
    } else if (next === 'DELIVERED' || next === 'CANCELLED') {
      deliveryDeadline = null; // iş bitdi — nəzarətçi bir daha toxunmasın
    }
    // Götürmədə alıcı mağazaya gec gələ bilər — avtomatik ləğv üçün daha uzun müddət.
    if (next === 'CONFIRMED' && order.paymentMethod === 'CARD' && isPickup(order)) {
      deliveryDeadline = new Date(Date.now() + Math.max(PICKUP_DEADLINE_HOURS, await getDeliveryDeadlineHours()) * 3600 * 1000);
    }
    // Təhvil tarixi — 14 günlük qaytarma müddəti buradan sayılır.
    const deliveredAt = next === 'DELIVERED' && !order.deliveredAt ? new Date() : undefined;

    // LƏĞV: əvvəlcə Yango çatdırılması ləğv olunur. Kuryer malı artıq
    // götürübsə Yango icazə vermir — onda sifariş də ləğv EDİLMİR (əks halda
    // pul qaytarılır, mal isə alıcıya gedirdi).
    if (next === 'CANCELLED' && order.yangoClaimId) {
      const yc = await cancelActiveYangoClaim(order.id);
      if (!yc.ok) { res.status(409).json({ success: false, message: yc.message }); return; }
    }

    // SATIŞ BAŞLAYIR → stok indi azalır. Stok çatmırsa (başqa alıcıya artıq
    // satılıb) təsdiq edilmir — satıcı sifarişi ləğv etməlidir (pul qaytarılır).
    if (['CONFIRMED', 'SHIPPED', 'DELIVERED'].includes(next) && !order.stockCommitted) {
      const sc = await commitStockForOrder(order.id);
      if (!sc.ok) {
        res.status(409).json({
          success: false, code: 'NO_STOCK',
          message: `«${sc.missing}» üçün stokda kifayət qədər məhsul yoxdur (qalıb: ${sc.available ?? 0}). Sifarişi ləğv edin — alıcının pulu qaytarılacaq.`,
        });
        return;
      }
    }

    const updated = await prisma.order.update({
      where: { id },
      // Satıcı təsdiqləyəndə (CONFIRMED) təsdiq son vaxtını təmizlə — daha timeout refund olmaz.
      data: {
        status: next as any,
        ...(next === 'CONFIRMED' ? { confirmDeadline: null } : {}),
        ...(deliveryDeadline !== undefined ? { deliveryDeadline } : {}),
        ...(deliveredAt ? { deliveredAt } : {}),
      },
    });

    // MAĞAZADAN GÖTÜRMƏ bildirişləri.
    if (isPickup(order)) {
      if (next === 'CONFIRMED') onPickupReady(order.id).catch(() => {});
      if (next === 'SHIPPED') await onPickupHandedOver(order.id).catch(() => {});
      if (next === 'DELIVERED' && isBuyer) onPickupReceived(order.id, 'BUYER').catch(() => {});
    }

    // Satıcı təsdiqləyəndə Yango kuryerinə göndər. isYangoConfigured() yoxlaması BURADA
    // deyil — dispatchOrderToYango özü yoxlayır və uğursuzluq səbəbini (token yoxdur,
    // koordinat yoxdur və s.) sifarişə yazır ki, satıcı NİYƏ işləmədiyini görsün.
    if (next === 'CONFIRMED' && order.deliveryType !== 'PICKUP' && order.deliveryMethod === 'COURIER' && !order.yangoClaimId) {
      dispatchOrderToYango(order.id).catch((e) => console.error('[cart] yango dispatch:', e?.message));
    }

    // ── LƏĞV: stok bərpası + pulun qaytarılması ──
    //
    // Stok bərpası ödənişdən ASILI DEYİL. Əvvəl o, qaytarma try-blokunun
    // içində idi: şlüz xəta versə məhsul anbara qayıtmırdı, nağd sifarişlərdə
    // isə heç vaxt qayıtmırdı.
    let refundFailed: string | null = null;
    if (next === 'CANCELLED') {
      await restoreStockForOrder(id).catch((e) => console.error('[cancel stock]', e?.message));

      // Kartla ödənilibsə pul geri qaytarılır. Nəticə ARTIQ udulmur —
      // uğursuzluq qeyd olunur, təkrar cəhd edilir və cavabda bildirilir.
      const r = await refundOrderSafe(id, 'CANCELLED');
      if (!r.ok) refundFailed = r.error || 'Qaytarma alınmadı';
    }

    // Sifariş ləğv edildikdə referal komissiyasını ləğv et (ləğv olunan sifariş üçün komissiya ödənilmir).
    if (next === 'CANCELLED' && order.referrerId && !order.referralVoided) {
      await prisma.order.update({ where: { id }, data: { referralVoided: true } });
      await prisma.notification.create({
        data: { userId: order.referrerId, type: 'REFERRAL', title: 'Referal komissiyası ləğv edildi', body: `Sifariş #${order.id} ləğv edildiyi üçün komissiya ləğv olundu.`, link: '/referral-earnings' },
      }).catch(() => {});
    }

    // Satıcı hesablaşması — status/ödəniş dəyişdi (DELIVERED→AVAILABLE, CANCELLED/REFUND→REVERSED).
    await recordSettlement(id).catch(() => {});

    // Aliciya bildirim
    const statusLabels: Record<string, string> = {
      CONFIRMED: 'qəbul edildi',
      SHIPPED: 'yola çıxdı',
      DELIVERED: 'çatdırıldı',
      CANCELLED: 'rədd/ləğv edildi',
    };
    // Təhvil alındı — alıcıya rəy xatırlatması. Rəy yazmaq üçün məhsulu
    // axtarmağa ehtiyac yoxdur: «Sifarişlər» səhifəsində hər məhsulun
    // yanında «Rəy yaz» düyməsi var.
    if (next === 'DELIVERED') {
      await prisma.notification.create({
        data: {
          userId: order.buyerId, type: 'ORDER', title: `Sifariş #${order.id}`,
          body: 'Sifarişiniz tamamlandı ✓ Məhsula və satıcıya rəy yazmağınız digər alıcılara kömək edir.',
          link: '/orders',
        },
      }).catch(() => {});
    }

    const label = statusLabels[next];
    if (label) {
      // Statusu satıcı dəyişibsə alıcıya, alıcı dəyişibsə (təhvil aldım/ləğv) satıcıya bildir.
      await prisma.notification.create({
        data: {
          userId: isBuyer ? order.sellerId : order.buyerId,
          type: 'ORDER',
          title: `Sifariş #${order.id}`,
          body: isBuyer && next === 'DELIVERED' ? 'Alıcı sifarişi təhvil aldı.' : `Sifariş ${label}.`,
          link: '/orders',
        },
      });
    }
    // Hər iki tərəfin açıq Sifarişlər səhifəsi yeniləmədən dəyişsin; qarşı
    // tərəfə isə hansı səhifədə olsa da qısa xəbər.
    pushLive(isBuyer ? order.sellerId : order.buyerId, {
      kind: 'order', id: order.id, status: next,
      ...(label ? { toast: `Sifariş #${order.id}: ${isBuyer && next === 'DELIVERED' ? 'alıcı təhvil aldı' : label}`, tone: next === 'CANCELLED' ? 'error' as const : 'info' as const } : {}),
    });
    pushLive(isBuyer ? order.buyerId : order.sellerId, { kind: 'order', id: order.id, status: next });

    // Ləğv baş tutdu, amma pul qaytarıla bilmədisə bunu GİZLƏTMİRİK — həm
    // satıcı/alıcı bilməlidir, həm də admin panelinə düşür və təkrar cəhd olunur.
    res.json({
      success: true,
      order: updated,
      ...(refundFailed ? { refundPending: true, refundError: refundFailed, message: 'Sifariş ləğv edildi, lakin ödənişin qaytarılması alınmadı — avtomatik təkrar cəhd ediləcək və admin xəbərdar edildi.' } : {}),
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Sifarişi öz siyahından sil (soft-hide) — yalnız tamamlanmış/ləğv olunmuş sifarişlər.
// Sifariş qarşı tərəf üçün qalır; yalnız silən şəxsin siyahısından gizlədilir.
router.delete('/orders/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ success: false, message: 'Yanlış ID' }); return; }
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true, buyerId: true, sellerId: true, status: true } });
    const isSeller = !!order && order.sellerId === req.adminId;
    const isBuyer = !!order && order.buyerId === req.adminId;
    if (!order || (!isSeller && !isBuyer)) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (!['CANCELLED', 'DELIVERED'].includes(order.status)) {
      res.status(400).json({ success: false, message: 'Yalnız tamamlanmış və ya ləğv olunmuş sifarişi silə bilərsiniz' }); return;
    }
    await prisma.order.update({ where: { id }, data: isBuyer ? { hiddenForBuyer: true } : { hiddenForSeller: true } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Kurye canli konumu guncelle (kurye)
router.put('/orders/:id/courier-location', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!order || order.courierId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    const { lat, lng } = req.body;
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        courierLat: lat ? parseFloat(lat) : null,
        courierLng: lng ? parseFloat(lng) : null,
      },
    });
    res.json({ success: true, order: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== RETURN / REFUND SYSTEM =====================
// Addımların ortaq məntiqi services/returnFlow.ts-dədir (satıcı, admin və
// sistem eyni funksiyaları işlədir), mübahisə və sistem qərarı isə
// services/disputeDecision.ts-dədir. Hər addım ReturnEvent-ə yazılır.

const RETURN_REASONS = ['DEFECTIVE', 'WRONG_ITEM', 'NOT_AS_DESCRIBED', 'CHANGED_MIND', 'OTHER'];
const RETURN_REASON_AZ: Record<string, string> = {
  DEFECTIVE: 'Qüsurlu', WRONG_ITEM: 'Səhv məhsul', NOT_AS_DESCRIBED: 'Təsvirə uyğun deyil', CHANGED_MIND: 'Bəyənmədim', OTHER: 'Digər',
};
const uploadedNames = (req: AuthRequest) => ((req.files as Express.Multer.File[] | undefined) || []).map((f) => f.filename);
const returnInclude = {
  order: { include: { items: true } },
  orderItem: true,
  events: { orderBy: { createdAt: 'asc' as const } },
};

// Create return request (buyer) — multipart: səbəb + izah + sübut şəkilləri.
router.post('/returns', adminAuth, upload.array('images', 6), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const { orderId, orderItemId, reason, quantity } = req.body;
    const reasonText = String(req.body.reasonText || '').trim();
    if (!RETURN_REASONS.includes(reason)) { res.status(400).json({ success: false, message: 'Qaytarma səbəbini seçin' }); return; }
    // Satıcı qərar verə bilsin deyə SƏBƏB İZAHI məcburidir.
    if (reasonText.length < 10) { res.status(400).json({ success: false, message: 'Məhsulu niyə qaytardığınızı yazın (ən azı 10 simvol) — satıcı bunu görüb qərar verəcək' }); return; }
    const images = uploadedNames(req);
    const order = await prisma.order.findUnique({
      where: { id: parseInt(orderId) },
      include: { items: true },
    });
    if (!order || order.buyerId !== req.adminId) {
      res.status(403).json({ success: false, message: 'Bu sifariş sizə aid deyil' }); return;
    }
    if (order.status !== 'DELIVERED') {
      res.status(400).json({ success: false, message: 'Yalnız çatdırılmış sifarişlər üçün iadə tələb edə bilərsiniz' }); return;
    }
    // QAYTARMA MÜDDƏTİ — təhvildən 14 gün (env: RETURN_WINDOW_DAYS).
    // Əvvəl müddət YOX idi: illər sonra da iadə açmaq olardı. Birgə alışda bu,
    // həm də hesablaşmanı sonsuza qədər gözlədərdi.
    if (order.deliveredAt) {
      const deadline = new Date(order.deliveredAt.getTime() + RETURN_WINDOW_DAYS * 24 * 3600 * 1000);
      if (deadline < new Date()) {
        res.status(400).json({
          success: false,
          message: `Qaytarma müddəti bitib (${RETURN_WINDOW_DAYS} gün). Problem varsa dəstəyə yazın.`,
        });
        return;
      }
    }

    // ── QALIQ YOXLAMASI ──
    // Pul artıq tam qaytarılıbsa yeni iadə açmağın mənası yoxdur.
    const alreadyRefunded = order.refundedAmount || 0;
    const remaining = Math.round((order.total - alreadyRefunded) * 100) / 100;
    if (order.paymentStatus === 'REFUNDED' || remaining <= 0.009) {
      res.status(400).json({ success: false, message: 'Bu sifarişin pulu artıq geri qaytarılıb' }); return;
    }

    // ── FAKTİKİ ÖDƏNİLMİŞ MƏBLƏĞ ──
    // Sifarişin cəmi = (məhsullar − promo − bal) + çatdırılma.
    // Sətir qiymətləri isə ENDİRİMSİZdir. Əvvəl qismən iadədə birbaşa
    // `item.price × say` qaytarılırdı: 100 AZN-lik məhsulu 50 AZN promo ilə
    // alan adam 100 AZN geri alırdı. İndi sətrin faktiki ödənilmiş payı
    // (endirim nisbəti tətbiq olunmuş) qaytarılır.
    const goodsGross = order.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const goodsPaid = Math.max(0, order.total - (order.deliveryFee || 0));
    const paidRatio = goodsGross > 0 ? goodsPaid / goodsGross : 1;

    let refundAmount: number;
    let itemId: number | null = null;

    // Sifarişdə AKTİV (bağlanmamış) iadə sorğuları — dublikat qaytarmanın qarşısı.
    const activeReturns = await prisma.returnRequest.findMany({
      where: { orderId: order.id, status: { notIn: ['CANCELLED', 'REJECTED'] } },
      select: { id: true, orderItemId: true },
    });
    const hasFullReturn = activeReturns.some((r) => r.orderItemId === null);

    if (orderItemId) {
      const item = order.items.find((i) => i.id === parseInt(orderItemId));
      if (!item) { res.status(404).json({ success: false, message: 'Məhsul tapılmadı' }); return; }
      const qty = parseInt(quantity) || item.quantity;
      if (qty > item.quantity) { res.status(400).json({ success: false, message: 'Miqdar orijinaldan çox ola bilməz' }); return; }
      if (hasFullReturn) {
        res.status(400).json({ success: false, message: 'Bu sifariş üçün tam iadə sorğusu var — əvvəlcə onu bitirin' }); return;
      }
      if (activeReturns.some((r) => r.orderItemId === item.id)) {
        res.status(400).json({ success: false, message: 'Bu məhsul üçün aktiv iadə sorğusu var' }); return;
      }
      refundAmount = Math.round(item.price * qty * paidRatio * 100) / 100;
      itemId = item.id;
    } else {
      // TAM iadə: qismən iadə açıqdırsa (və ya artıq qaytarılıbsa) icazə yoxdur —
      // əks halda eyni pul ikinci dəfə qaytarıla bilərdi.
      if (activeReturns.length) {
        res.status(400).json({
          success: false,
          message: hasFullReturn
            ? 'Bu sifariş üçün aktiv iadə sorğusu var'
            : 'Bu sifarişdə açıq məhsul iadəsi var — tam iadə üçün əvvəlcə onu bitirin və ya ləğv edin',
        });
        return;
      }
      refundAmount = remaining;
    }

    // Heç vaxt qalıqdan çox qaytarılmasın.
    refundAmount = Math.min(refundAmount, remaining);

    const returnQuantity = orderItemId
      ? (parseInt(quantity) || order.items.find((i) => i.id === parseInt(orderItemId))!.quantity)
      : order.items.reduce((s, i) => s + i.quantity, 0);

    const returnReq = await prisma.returnRequest.create({
      data: {
        orderId: order.id,
        orderItemId: itemId,
        buyerId: req.adminId!,
        sellerId: order.sellerId,
        reason,
        reasonText: reasonText.slice(0, 1000),
        quantity: returnQuantity,
        refundAmount,
        images,
        // Satıcı bu müddətdə cavab verməsə sistem avtomatik təsdiqləyir.
        sellerRespondBy: hoursFromNow(RETURN_SELLER_RESPOND_HOURS),
      },
    });
    await logReturnEvent(returnReq.id, 'BUYER', req.adminId!, 'REQUESTED',
      `${RETURN_REASON_AZ[reason]}: ${reasonText.slice(0, 300)}${images.length ? ` (${images.length} şəkil)` : ''}`);
    await prisma.notification.create({
      data: {
        userId: order.sellerId, type: 'ORDER', title: `İadə sorğusu — sifariş #${order.id}`,
        body: `Alıcı ${returnQuantity} ədəd üçün iadə istəyir (${refundAmount.toFixed(2)} AZN). Səbəb: ${RETURN_REASON_AZ[reason]} — «${reasonText.slice(0, 120)}». Qəbul edin və ya səbəb yazaraq rədd edin (${RETURN_SELLER_RESPOND_HOURS} saat ərzində; cavabsız qalan iadə etibarlılıq reytinqinizə təsir edir).`,
        link: '/iadeler?tab=selling',
      },
    }).catch(() => {});
    pushLive(order.sellerId, { kind: 'return', id: returnReq.id, status: returnReq.status, toast: `Sifariş #${order.id} üçün iadə sorğusu gəldi`, tone: 'info' });
    pushAdmins('return', { id: returnReq.id });
    res.status(201).json({ success: true, returnRequest: returnReq });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get buyer's return requests
router.get('/returns/buying', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const returns = await prisma.returnRequest.findMany({
      where: { buyerId: req.adminId! },
      include: { ...returnInclude, seller: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ returns });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get seller's return requests
router.get('/returns/selling', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const returns = await prisma.returnRequest.findMany({
      where: { sellerId: req.adminId! },
      include: { ...returnInclude, buyer: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ returns });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Bir iadənin detalı + izlənmə tarixçəsi + mübahisə (yalnız tərəflər).
router.get('/returns/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({
      where: { id: parseInt(String(req.params.id)) },
      include: {
        ...returnInclude,
        buyer: { select: { id: true, name: true } },
        seller: { select: { id: true, name: true } },
      },
    });
    if (!ret || (ret.buyerId !== req.adminId && ret.sellerId !== req.adminId)) { res.status(404).json({ success: false, message: 'İadə tapılmadı' }); return; }
    const dispute = ret.disputeId ? await prisma.complaint.findUnique({
      where: { id: ret.disputeId },
      select: { id: true, status: true, category: true, description: true, images: true, sellerResponse: true, sellerImages: true, respondBy: true, decision: true, decisionBy: true, decisionReason: true, decidedAt: true, appealed: true, complainantId: true, targetUserId: true },
    }) : null;
    res.json({ success: true, returnRequest: ret, dispute });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Cancel return (buyer, only REQUESTED)
router.put('/returns/:id/cancel', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!ret || ret.buyerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ret.status !== 'REQUESTED' && ret.status !== 'APPROVED') { res.status(400).json({ success: false, message: 'Yalnız göndərilməmiş iadəni ləğv edə bilərsiniz' }); return; }
    const updated = await prisma.returnRequest.update({ where: { id: ret.id }, data: { status: 'CANCELLED', sellerRespondBy: null, shipBy: null } });
    await logReturnEvent(ret.id, 'BUYER', req.adminId!, 'CANCELLED', 'Alıcı iadəni ləğv etdi');
    pushLive([ret.buyerId, ret.sellerId], { kind: 'return', id: ret.id, status: updated.status });
    res.json({ success: true, returnRequest: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Mark return as shipped (buyer, only APPROVED) — üsul + izləmə kodu.
router.put('/returns/:id/ship', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!ret || ret.buyerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ret.status !== 'APPROVED') { res.status(400).json({ success: false, message: 'Sorğu hələ təsdiqlənməyib' }); return; }
    const method = RETURN_METHODS.includes(String(req.body?.returnMethod)) ? String(req.body.returnMethod) : 'IN_PERSON';
    const trackingCode = req.body?.trackingCode ? String(req.body.trackingCode).trim().slice(0, 80) : null;
    const updated = await prisma.returnRequest.update({
      where: { id: ret.id },
      data: {
        status: 'RETURN_SHIPPED', returnMethod: method, trackingCode, shippedAt: new Date(), shipBy: null,
        // Satıcı bu müddətdə qəbulu təsdiqləməsə sistem mübahisə açır.
        receiveBy: hoursFromNow(RETURN_RECEIVE_DAYS * 24),
      },
    });
    await logReturnEvent(ret.id, 'BUYER', req.adminId!, 'RETURN_SHIPPED',
      `${RETURN_METHOD_AZ[method]} ilə göndərildi${trackingCode ? ` — izləmə kodu: ${trackingCode}` : ''}`);
    await prisma.notification.create({
      data: {
        userId: ret.sellerId, type: 'ORDER', title: `Qaytarılan məhsul yoldadır — sifariş #${ret.orderId}`,
        body: `Alıcı məhsulu ${RETURN_METHOD_AZ[method]} ilə göndərdi${trackingCode ? ` (izləmə: ${trackingCode})` : ''}. Məhsulu alanda «Qəbul etdim» və ya problem varsa «Problem var» basın.`,
        link: '/iadeler?tab=selling',
      },
    }).catch(() => {});
    pushLive([ret.buyerId, ret.sellerId], { kind: 'return', id: ret.id, status: updated.status });
    res.json({ success: true, returnRequest: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Approve return (seller, only REQUESTED)
router.put('/returns/:id/approve', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!ret || ret.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ret.status !== 'REQUESTED') { res.status(400).json({ success: false, message: 'Bu sorğu artıq cavablandırılıb' }); return; }
    // Satıcı məbləği dəyişə bilər: 0-dan böyük, sifarişin qalığından çox olmamaqla.
    const ord0 = await prisma.order.findUnique({ where: { id: ret.orderId }, select: { total: true, refundedAmount: true } });
    const remain0 = Math.round(((ord0?.total || 0) - (ord0?.refundedAmount || 0)) * 100) / 100;
    let amt0: number | undefined;
    if (req.body?.refundAmount !== undefined && req.body.refundAmount !== '') {
      const v = parseFloat(String(req.body.refundAmount));
      if (!Number.isFinite(v) || v <= 0) { res.status(400).json({ success: false, message: 'Geri ödəmə məbləği 0-dan böyük olmalıdır' }); return; }
      if (v > remain0 + 0.009) { res.status(400).json({ success: false, message: `Məbləğ sifarişin qalığından (${remain0.toFixed(2)} AZN) çox ola bilməz` }); return; }
      amt0 = Math.round(v * 100) / 100;
    }
    const note = req.body?.sellerNote ? String(req.body.sellerNote).trim().slice(0, 500) : '';
    if (note) await prisma.returnRequest.update({ where: { id: ret.id }, data: { sellerNote: note } });
    const updated = await approveReturn(ret.id, 'SELLER', req.adminId!, {
      refundAmount: amt0,
      note: note ? `Satıcı təsdiqlədi: ${note}` : undefined,
    });
    res.json({ success: true, returnRequest: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Reject return (seller, only REQUESTED) — SƏBƏB MƏCBURİDİR (+ istəyə görə şəkil).
router.put('/returns/:id/reject', adminAuth, upload.array('images', 4), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!ret || ret.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ret.status !== 'REQUESTED') { res.status(400).json({ success: false, message: 'Bu sorğu artıq cavablandırılıb' }); return; }
    const note = String(req.body?.sellerNote || '').trim();
    if (note.length < 10) { res.status(400).json({ success: false, message: 'Rədd səbəbini ətraflı yazın (ən azı 10 simvol) — alıcı və sistem bunu görəcək' }); return; }
    const imgs = uploadedNames(req);
    if (imgs.length) await prisma.returnRequest.update({ where: { id: ret.id }, data: { sellerImages: [...ret.sellerImages, ...imgs].slice(0, 6) } });
    const updated = await rejectReturn(ret.id, 'SELLER', req.adminId!, note.slice(0, 1000));
    await prisma.notification.create({
      data: {
        userId: ret.buyerId, type: 'ORDER', title: `İadə rədd edildi — sifariş #${ret.orderId}`,
        body: `Satıcının səbəbi: ${note.slice(0, 200)}. Razı deyilsinizsə ${RETURN_DISPUTE_DAYS} gün ərzində şikayət açın — sistem sübutlara baxıb qərar verəcək.`,
        link: '/iadeler',
      },
    }).catch(() => {});
    res.json({ success: true, returnRequest: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Alıcı rədd edilmiş iadə ilə razı deyil → satıcı haqqında ŞİKAYƏT (reputasiya).
// Məhsul geri qaytarılmır — qaytarma yalnız satıcının qəbulu ilə olur.
router.post('/returns/:id/dispute', complaintLimiter, adminAuth, upload.array('images', 6), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({ where: { id: parseInt(String(req.params.id)) } });
    if (!ret || ret.buyerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ret.status !== 'REJECTED' && ret.status !== 'REQUESTED') { res.status(400).json({ success: false, message: 'Şikayət yalnız rədd edilmiş və ya cavabsız qalan iadə üçün yazıla bilər' }); return; }
    if (ret.disputeId) { res.status(400).json({ success: false, message: 'Bu iadə üzrə artıq şikayət yazmısınız' }); return; }
    const description = String(req.body?.description || '').trim();
    if (description.length < 10) { res.status(400).json({ success: false, message: 'Niyə razı olmadığınızı yazın (ən azı 10 simvol)' }); return; }
    const complaint = await createSellerComplaint({
      complainantId: ret.buyerId, targetUserId: ret.sellerId, orderId: ret.orderId, returnId: ret.id,
      category: ret.status === 'REJECTED' ? 'RETURN_REJECTED' : 'RETURN_IGNORED', description,
      images: [...ret.images, ...uploadedNames(req)].slice(0, 8),
    });
    await prisma.returnRequest.update({ where: { id: ret.id }, data: { disputeId: complaint.id } });
    await logReturnEvent(ret.id, 'BUYER', ret.buyerId, 'COMPLAINT', `Alıcı satıcı haqqında şikayət yazdı: ${description.slice(0, 200)}`);
    res.status(201).json({ success: true, complaint });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Confirm return received (seller, only RETURN_SHIPPED)
router.put('/returns/:id/receive', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!ret || ret.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ret.status !== 'RETURN_SHIPPED') { res.status(400).json({ success: false, message: 'Məhsul hələ göndərilməyib' }); return; }
    const updated = await prisma.returnRequest.update({
      where: { id: ret.id },
      data: { status: 'RETURN_RECEIVED', receivedAt: new Date(), receiveBy: null, refundBy: hoursFromNow(RETURN_REFUND_HOURS) },
    });
    await logReturnEvent(ret.id, 'SELLER', req.adminId!, 'RETURN_RECEIVED', 'Satıcı məhsulu qəbul etdi');
    await prisma.notification.create({
      data: {
        userId: ret.buyerId, type: 'ORDER', title: `Məhsul qəbul edildi — sifariş #${ret.orderId}`,
        body: `Satıcı qaytarılan məhsulu qəbul etdi. Pul ${RETURN_REFUND_HOURS} saat ərzində qaytarılacaq (satıcı etməsə sistem özü qaytarır).`,
        link: '/iadeler',
      },
    }).catch(() => {});
    pushLive([ret.buyerId, ret.sellerId], { kind: 'return', id: ret.id, status: updated.status });
    res.json({ success: true, returnRequest: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Satıcı: qaytarılan məhsul zədəli / fərqli / əskik gəldi → mübahisə (foto sübutla).
router.post('/returns/:id/receive-problem', complaintLimiter, adminAuth, upload.array('images', 6), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({ where: { id: parseInt(String(req.params.id)) } });
    if (!ret || ret.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ret.status !== 'RETURN_SHIPPED' && ret.status !== 'RETURN_RECEIVED') { res.status(400).json({ success: false, message: 'Bu mərhələdə problem bildirmək olmaz' }); return; }
    const description = String(req.body?.description || '').trim();
    const imgs = uploadedNames(req);
    if (description.length < 10) { res.status(400).json({ success: false, message: 'Problemi ətraflı yazın (ən azı 10 simvol)' }); return; }
    if (!imgs.length) { res.status(400).json({ success: false, message: 'Problemi göstərən ən azı 1 şəkil əlavə edin' }); return; }
    await prisma.returnRequest.update({
      where: { id: ret.id },
      data: { sellerImages: [...ret.sellerImages, ...imgs].slice(0, 8), receivedAt: ret.receivedAt || new Date() },
    });
    // Pul qaytarılmasını dayandır — ADMİN baxır (avtomatik qərar yoxdur).
    await prisma.returnRequest.update({ where: { id: ret.id }, data: { status: 'DISPUTED', refundBy: null, receiveBy: null, sellerNote: description.slice(0, 1000) } });
    await logReturnEvent(ret.id, 'SELLER', ret.sellerId, 'DISPUTED', `Satıcı qaytarılan məhsulda problem bildirdi: ${description.slice(0, 300)}`);
    await prisma.notification.create({
      data: { userId: ret.buyerId, type: 'ORDER', title: `İadə #${ret.id}: satıcı problem bildirdi`, body: `Satıcının izahı: «${description.slice(0, 200)}». Admin yoxlayıb qərar verəcək.`, link: `/iadeler?id=${ret.id}` },
    }).catch(() => {});
    pushLive([ret.buyerId, ret.sellerId], { kind: 'return', id: ret.id, status: 'DISPUTED' });
    pushAdmins('return', { id: ret.id, toast: `İadə #${ret.id}: satıcı qaytarılan məhsulda problem bildirdi` });
    const complaint = null;
    res.status(201).json({ success: true, complaint });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Issue refund + restore stock (seller, only RETURN_RECEIVED)
router.put('/returns/:id/refund', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!ret || ret.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ret.status !== 'RETURN_RECEIVED') { res.status(400).json({ success: false, message: 'Məhsul hələ qəbul edilməyib' }); return; }
    const r = await finalizeReturnRefund(ret.id, 'SELLER', req.adminId!);
    if (!r.ok) { res.status(r.retrying ? 502 : 400).json({ success: false, message: r.error, retrying: r.retrying }); return; }
    const updated = await prisma.returnRequest.findUnique({ where: { id: ret.id } });
    res.json({ success: true, returnRequest: updated, stockWarnings: r.stockWarnings?.length ? r.stockWarnings : undefined });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Satıcının öz qazancı — balans + son əməliyyatlar + payout tarixçəsi.
router.get('/me/earnings', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const sellerId = req.adminId!;
    const [balance, ledgers, payouts] = await Promise.all([
      sellerBalance(sellerId),
      prisma.sellerLedger.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, orderId: true, grossAmount: true, commission: true, commissionRate: true, netAmount: true, heldByPlatform: true, status: true, createdAt: true } }),
      prisma.payout.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, amount: true, method: true, reference: true, createdAt: true } }),
    ]);
    res.json({ success: true, balance, ledgers, payouts });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
});

export default router;
