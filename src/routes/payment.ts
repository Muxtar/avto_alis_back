import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, requirePermission, AuthRequest } from '../middleware/auth';
import { getOrderStatus, isPaidStatus } from '../services/kapital';
import { refundOrder } from '../services/paymentGateway';
import { refundOrderSafe } from '../services/refunds';
import { isCardReference, finishCardLink, startCardLink, PUBLIC_CARD_FIELDS, CARD_VERIFY_AMOUNT } from '../services/savedCards';
import { getPaymentStatus as yigimStatus, isPaidStatus as yigimPaid } from '../services/yigimPay';
import { settleConsultation } from './consultations';
import { recordSettlement, recordSettlementMany } from '../services/settlement';
import { markOrdersAwaitingConfirm } from '../services/orderExpiry';

const router = Router();
const prisma = new PrismaClient();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
// Kart bağlama callback-i bu ünvana gəlir (cart.ts-dəki ilə eyni).
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 5001}`;

// Ödəniş təsdiqi nəticəsini order-lərə tətbiq edir (idempotent) — hər iki şlüz üçün.
export async function settleOrders(where: { gatewayProvider?: string; gatewayRef?: string; gatewayOrderId?: number }, status: string, paid: boolean) {
  const orders = await prisma.order.findMany({ where, include: { items: true } });
  if (orders.length === 0) return;
  const wasPaid = orders.some((o) => o.paymentStatus === 'PAID');
  await prisma.order.updateMany({ where, data: { gatewayStatus: status || null, paymentStatus: paid ? 'PAID' : 'FAILED' } });
  if (paid) {
    // DİQQƏT: kartla ödəniş sifarişi AVTOMATİK təsdiqləmir. Sifariş PENDING qalır və
    // SATICININ təsdiqini gözləyir; satıcı vaxtında təsdiqləməsə pul avtomatik geri
    // qaytarılır (orderExpiry). Deadline aşağıda markOrdersAwaitingConfirm ilə qoyulur.
    // KART: stok yalnız İNDİ (ödəniş təsdiqi) azalır — bir dəfə (stockCommitted).
    // Beləliklə ödənilməmiş/tərk edilmiş kart sifarişi stoku bloklamır.
    // GEC GƏLƏN ÖDƏNİŞ: sifariş artıq ləğv olunubsa (satıcı rədd etdi, kuryer
    // tapılmadı, vaxt keçdi) pul indi gəlir — həmin pul saxlanıla bilməz.
    // Stok da bağlanmamalıdır. Belə sifarişlər dərhal geri qaytarılır.
    const cancelledLate = orders.filter((o) => o.status === 'CANCELLED');
    for (const o of cancelledLate) {
      console.warn(`[settleOrders] ləğv olunmuş sifariş #${o.id} üçün gec ödəniş gəldi — avtomatik qaytarılır`);
      await refundOrderSafe(o.id, 'CANCELLED', o.total).catch((e) => console.error('[settleOrders] gec ödəniş qaytarması:', e?.message));
    }

    for (const o of orders) {
      if (o.stockCommitted || o.status === 'CANCELLED') continue;
      for (const it of o.items) {
        const r = await prisma.listing.updateMany({
          where: { id: it.listingId, stock: { gte: it.quantity } },
          data: { stock: { decrement: it.quantity } },
        }).catch(() => null);
        if (!r || r.count === 0) console.error(`[settleOrders] stok azaldıla bilmədi (order ${o.id}, listing ${it.listingId}) — stok tükənib ola bilər`);
      }
      await prisma.order.update({ where: { id: o.id }, data: { stockCommitted: true } }).catch(() => {});
    }
    if (!wasPaid) {
      const byBuyer = new Map<number, number>();
      for (const o of orders) if (o.pointsEarned > 0) byBuyer.set(o.buyerId, (byBuyer.get(o.buyerId) || 0) + o.pointsEarned);
      for (const [buyerId, pts] of byBuyer) {
        try { await prisma.user.update({ where: { id: buyerId }, data: { loyaltyPoints: { increment: pts } } }); } catch { /* silinmiş */ }
      }
      // Kart ödənişi uğurlu → alıcının səbətindən ödənilmiş məhsulları sil (uğurda təmizlənir).
      for (const o of orders) {
        try {
          const c = await prisma.cart.findUnique({ where: { userId: o.buyerId }, select: { id: true } });
          if (c) await prisma.cartItem.deleteMany({ where: { cartId: c.id, listingId: { in: o.items.map((it) => it.listingId) } } });
        } catch { /* səbət yoxdur */ }
      }
    }
  }
  // FAILED — kartda stok checkout-da azaldılmayıb, ona görə geri qaytarmağa ehtiyac
  // yoxdur (heç azalmayıb). Order PENDING+FAILED qalır; alıcı yenidən cəhd edə bilər.

  // Satıcı hesablaşması — ödənilmiş sifarişlər üçün ledger yarat/yenilə.
  await recordSettlementMany(orders.map((o) => o.id)).catch(() => {});
  // Kartla ödənilən sifarişlərə satıcı təsdiqi son vaxtını qoy (timeout refund üçün).
  if (paid) await markOrdersAwaitingConfirm(orders.map((o) => o.id)).catch(() => {});
}

// ====================== CALLBACK ======================
// Bank ödənişdən sonra müştərini bura yönəldir: ?ID=<gatewayOrderId>&STATUS=<...>
// STATUS müvəqqəti ola bilər → MÜTLƏQ getOrderStatus ilə təsdiqləyirik.
router.get('/payment/callback', async (req: Request, res: Response) => {
  const gatewayOrderId = parseInt(String(req.query.ID || ''));
  try {
    if (Number.isNaN(gatewayOrderId)) {
      return res.redirect(`${FRONTEND_URL}/payment/return?status=error`);
    }
    // Əvvəlki vəziyyəti bilmək üçün order-ləri item-lərlə birlikdə əvvəlcədən oxu (idempotentlik).
    const orders = await prisma.order.findMany({ where: { gatewayOrderId }, include: { items: true } });
    const consultCount = await prisma.consultationSession.count({ where: { gatewayOrderId } });
    if (orders.length === 0 && consultCount === 0) {
      return res.redirect(`${FRONTEND_URL}/payment/return?status=error`);
    }
    const wasPaid = orders.some((o) => o.paymentStatus === 'PAID');

    // Banka birbaşa sorğu ilə həqiqi statusu al (callback STATUS-a güvənmə).
    const { status } = await getOrderStatus(gatewayOrderId);
    const paid = isPaidStatus(status);
    // Rəy konsultasiyası ödənişidirsə seansı da təsdiqlə.
    if (consultCount > 0) await settleConsultation({ gatewayOrderId }, paid);

    await prisma.order.updateMany({
      where: { gatewayOrderId },
      data: { gatewayStatus: status || null, paymentStatus: paid ? 'PAID' : 'FAILED' },
    });

    if (paid) {
      // Yalnız hələ PENDING olanları təsdiqlə — satıcı/biznes artıq CANCELLED edibsə dirçəltmə.
      await prisma.order.updateMany({ where: { gatewayOrderId, status: 'PENDING' }, data: { status: 'CONFIRMED' } });
      // FAILED→PAID keçidində əvvəl geri qaytarılmış stoku yenidən tut (over-increment-in qarşısını alır).
      for (const o of orders) {
        if (!o.stockRestored) continue;
        for (const it of o.items) {
          try { await prisma.listing.update({ where: { id: it.listingId }, data: { stock: { decrement: it.quantity } } }); } catch { /* listing silinmiş ola bilər */ }
        }
        await prisma.order.update({ where: { id: o.id }, data: { stockRestored: false } });
      }
      // Loyalty xalını yalnız indi (ödəniş təsdiqində) və bir dəfə hesabla (idempotent).
      if (!wasPaid) {
        const byBuyer = new Map<number, number>();
        for (const o of orders) if (o.pointsEarned > 0) byBuyer.set(o.buyerId, (byBuyer.get(o.buyerId) || 0) + o.pointsEarned);
        for (const [buyerId, pts] of byBuyer) {
          try { await prisma.user.update({ where: { id: buyerId }, data: { loyaltyPoints: { increment: pts } } }); } catch { /* istifadəçi silinmiş ola bilər */ }
        }
      }
    } else {
      // Ödəniş uğursuz — stoku geri qaytar (yalnız bir dəfə: əvvəl FAILED deyilsə və ya stockRestored qoyulmayıbsa).
      for (const o of orders) {
        if (o.paymentStatus === 'FAILED' || o.stockRestored) continue;
        for (const it of o.items) {
          try { await prisma.listing.update({ where: { id: it.listingId }, data: { stock: { increment: it.quantity } } }); } catch { /* listing silinmiş ola bilər */ }
        }
        await prisma.order.update({ where: { id: o.id }, data: { stockRestored: true } });
      }
    }

    return res.redirect(`${FRONTEND_URL}/payment/return?status=${paid ? 'success' : 'failed'}`);
  } catch (err: any) {
    console.error('[payment/callback]', err.message);
    return res.redirect(`${FRONTEND_URL}/payment/return?status=error`);
  }
});

// ====================== YIĞIM (MAGNET) WEBHOOK ======================
// YIĞIM ödəniş statusu dəyişəndə bura GET sorğu göndərir: ?reference=<ref>
// Bu SERVER-TO-SERVER webhook-dur — istifadəçinin brauzeri bura düşmür
// (brauzer üçün ayrıca back-url/fail-url `extra` ilə ötürülür).
//
// YIĞIM TƏLƏBİ: "Callback-dən cavab gəldikdən sonra get-payment sorğusu çağırın."
// Ona görə ardıcıllıq belədir:
//   1) callback-i qeyd et → 2) YIĞIM-ə DƏRHAL 200 cavab ver →
//   3) yalnız BUNDAN SONRA (fonda) get-payment çağırıb sifarişi settle et.
// Əvvəl get-payment cavab gözlənilirdi, yəni YIĞIM-in callback sorğusu hələ
// açıq ikən onlara sorğu gedirdi — şikayətin səbəbi məhz bu idi.
router.get('/payment/yigim/callback', async (req: Request, res: Response) => {
  const reference = String(req.query.reference || '');
  if (!reference) { res.status(400).send('reference required'); return; }
  try {
    // KART BAĞLAMA callback-i — sifariş deyil. Referansın prefiksindən bilinir.
    if (isCardReference(reference)) {
      res.status(200).send('OK');                       // YIĞIM 200 gözləyir
      setImmediate(() => { finishCardLink(reference).catch((e) => console.error('[card link]', e?.message)); });
      return;
    }
    const order = await prisma.order.findFirst({ where: { gatewayRef: reference }, select: { id: true } });
    const consultCount = await prisma.consultationSession.count({ where: { gatewayRef: reference } });
    if (!order && consultCount === 0) { res.status(404).send('not found'); return; }

    // 1) Callback-in gəldiyini qeyd et (status endpoint-i bundan sonra icazəlidir).
    if (order) {
      await prisma.order.updateMany({ where: { gatewayRef: reference }, data: { gatewayCallbackAt: new Date() } });
    }

    // 2) YIĞIM-ə DƏRHAL cavab (get-payment-dən ƏVVƏL).
    res.status(200).send('OK');

    // 3) Cavab göndərildikdən SONRA get-payment + settle (fonda).
    setImmediate(async () => {
      try {
        const { status } = await yigimStatus(reference);
        const paid = yigimPaid(status);
        if (order) await settleOrders({ gatewayRef: reference }, status, paid);
        if (consultCount > 0) await settleConsultation({ gatewayRef: reference }, paid);
        console.log(`[yigim callback] ${reference} → status=${status} paid=${paid}`);
      } catch (e: any) {
        console.error('[yigim callback settle]', e?.message);
      }
    });
  } catch (err: any) {
    console.error('[payment/yigim/callback]', err.message);
    if (!res.headersSent) res.status(500).send('error');
  }
});

// ====================== STATUS (polling) ======================
// Frontend istəsə öz sifarişinin ödəniş statusunu yoxlaya bilər.
router.get('/payment/status/:orderId', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const orderId = parseInt(req.params.orderId);
    let order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.buyerId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return;
    }
    // YIĞIM: get-payment (yigimStatus) YALNIZ callback gəldikdən SONRA çağırılmalıdır
    // (YIĞIM tələbi: "callbackdan cavab gəlmədən get-payment çağırmayın"). Ona görə
    // burada birbaşa sorğunu yalnız gatewayCallbackAt təyin olunubsa edirik. Callback
    // hələ gəlməyibsə sadəcə DB statusunu qaytarırıq (frontend yenidən poll edir).
    // Əlavə: callback yenicə gəlibsə (< 10 san) fonda settle onsuz da gedir —
    // təkrar get-payment göndərməmək üçün gözləyirik.
    const callbackAgeMs = order.gatewayCallbackAt ? Date.now() - new Date(order.gatewayCallbackAt).getTime() : -1;
    const callbackSettled = callbackAgeMs >= 0 && callbackAgeMs < 10_000;
    if (order.paymentStatus !== 'PAID' && order.gatewayRef && order.gatewayProvider === 'yigim' && order.gatewayCallbackAt && !callbackSettled) {
      try {
        const { status } = await yigimStatus(order.gatewayRef);
        await settleOrders({ gatewayRef: order.gatewayRef }, status, yigimPaid(status));
        order = (await prisma.order.findUnique({ where: { id: orderId } })) || order;
      } catch (e: any) { console.error('[payment/status verify]', e?.message); }
    }
    res.json({
      success: true,
      paymentStatus: order.paymentStatus,
      gatewayStatus: order.gatewayStatus,
      callbackReceived: !!order.gatewayCallbackAt,  // frontend poll-u dayandırmaq üçün
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ====================== REFUND (admin) ======================
router.post('/payment/refund/:orderId', requirePermission('finance'), async (req: AuthRequest, res: Response) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const { amount } = req.body;
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) { res.status(404).json({ success: false, message: 'Sifariş tapılmadı' }); return; }
    const hasGateway = order.gatewayRef || order.gatewayOrderId;
    if (!hasGateway) {
      res.status(400).json({ success: false, message: 'Bu sifariş kartla ödənilməyib' }); return;
    }
    if (order.paymentStatus !== 'PAID') {
      res.status(400).json({ success: false, message: 'Yalnız ödənilmiş sifarişi iadə etmək olar' }); return;
    }

    // Eyni gateway-order altındakı bütün order-lər birlikdə ödənildiyi üçün,
    // qismən iadə bu order-in məbləği qədər; məbləç verilməsə bu order-in totalı.
    const refundAmount = amount !== undefined ? parseFloat(amount) : order.total;
    // Ortaq servis: ikiqat qaytarma qıfılı + qeyd + uğursuzluqda təkrar cəhd.
    const r = await refundOrderSafe(order.id, 'ADMIN', refundAmount);
    if (!r.ok) { res.status(502).json({ success: false, message: r.error || 'Qaytarma alınmadı', retrying: true }); return; }
    await recordSettlement(order.id).catch(() => {});   // ledger geri al
    res.json({ success: true, skipped: r.skipped || null });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});


// ====================== SAXLANMIŞ KARTLAR ======================
// DİQQƏT: bu endpointlərin heç biri `token` qaytarmır (PUBLIC_CARD_FIELDS).
// Token serverdə qalır; ödəniş kartın `id`-si ilə icra olunur.

// Kartlarımın siyahısı.
router.get('/me/cards', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const cards = await prisma.savedCard.findMany({
      where: { userId: req.adminId!, status: 'ACTIVE' },
      select: PUBLIC_CARD_FIELDS,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ success: true, cards });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Yeni kart bağla — YIĞIM kart səhifəsinin linkini qaytarır.
router.post('/me/cards/init', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const r = await startCardLink(req.adminId!, PUBLIC_BACKEND_URL);
    res.json({ success: true, url: r.url, verifyAmount: CARD_VERIFY_AMOUNT });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Bağlamanın nəticəsi — brauzer qayıdandan sonra soruşur (callback gec gələ bilər).
router.get('/me/cards/last', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const row = await prisma.savedCard.findFirst({
      where: { userId: req.adminId! },
      orderBy: { createdAt: 'desc' },
      select: { ...PUBLIC_CARD_FIELDS, status: true },
    });
    res.json({ success: true, card: row });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Kartı sil.
router.delete('/me/cards/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const del = await prisma.savedCard.deleteMany({ where: { id, userId: req.adminId! } });
    if (!del.count) { res.status(404).json({ success: false, message: 'Kart tapılmadı' }); return; }
    // Əsas kart silinibsə qalanlardan biri əsas olsun.
    const rest = await prisma.savedCard.findFirst({ where: { userId: req.adminId!, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } });
    if (rest && !(await prisma.savedCard.count({ where: { userId: req.adminId!, status: 'ACTIVE', isDefault: true } }))) {
      await prisma.savedCard.update({ where: { id: rest.id }, data: { isDefault: true } });
    }
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Əsas kartı dəyiş.
router.patch('/me/cards/:id/default', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const mine = await prisma.savedCard.findFirst({ where: { id, userId: req.adminId!, status: 'ACTIVE' } });
    if (!mine) { res.status(404).json({ success: false, message: 'Kart tapılmadı' }); return; }
    await prisma.savedCard.updateMany({ where: { userId: req.adminId! }, data: { isDefault: false } });
    await prisma.savedCard.update({ where: { id }, data: { isDefault: true } });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
