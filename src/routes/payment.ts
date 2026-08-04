import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, requirePermission, AuthRequest } from '../middleware/auth';
import { getOrderStatus, isPaidStatus } from '../services/kapital';
import { refundOrder } from '../services/paymentGateway';
import { getPaymentStatus as yigimStatus, isPaidStatus as yigimPaid } from '../services/yigimPay';
import { settleConsultation } from './consultations';
import { recordSettlement, recordSettlementMany } from '../services/settlement';
import { markOrdersAwaitingConfirm } from '../services/orderExpiry';

const router = Router();
const prisma = new PrismaClient();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Ödəniş təsdiqi nəticəsini order-lərə tətbiq edir (idempotent) — hər iki şlüz üçün.
async function settleOrders(where: { gatewayProvider?: string; gatewayRef?: string; gatewayOrderId?: number }, status: string, paid: boolean) {
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
    for (const o of orders) {
      if (o.stockCommitted) continue;
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
// STATUS-a güvənmirik — getPaymentStatus ilə birbaşa təsdiqləyirik.
router.get('/payment/yigim/callback', async (req: Request, res: Response) => {
  const reference = String(req.query.reference || '');
  try {
    if (!reference) return res.redirect(`${FRONTEND_URL}/payment/return?status=error`);
    const order = await prisma.order.findFirst({ where: { gatewayRef: reference } });
    const consultCount = await prisma.consultationSession.count({ where: { gatewayRef: reference } });
    if (!order && consultCount === 0) return res.redirect(`${FRONTEND_URL}/payment/return?status=error`);
    // YIĞIM callback-i GƏLDİ — bunu qeyd et. get-payment (yigimStatus) YALNIZ callback
    // gəldikdən sonra çağırılmalıdır (YIĞIM tələbi). Bu andan status endpoint də icazəlidir.
    if (order) await prisma.order.updateMany({ where: { gatewayRef: reference }, data: { gatewayCallbackAt: new Date() } });
    const { status } = await yigimStatus(reference);
    const paid = yigimPaid(status);
    if (order) await settleOrders({ gatewayRef: reference }, status, paid);
    if (consultCount > 0) await settleConsultation({ gatewayRef: reference }, paid);
    return res.redirect(`${FRONTEND_URL}/payment/return?status=${paid ? 'success' : 'failed'}`);
  } catch (err: any) {
    console.error('[payment/yigim/callback]', err.message);
    return res.redirect(`${FRONTEND_URL}/payment/return?status=error`);
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
    if (order.paymentStatus !== 'PAID' && order.gatewayRef && order.gatewayProvider === 'yigim' && order.gatewayCallbackAt) {
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
    await refundOrder(order, refundAmount);

    await prisma.order.update({
      where: { id: order.id },
      data: { paymentStatus: 'REFUNDED', gatewayStatus: 'Refunded' },
    });
    await recordSettlement(order.id).catch(() => {});   // ledger geri al
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
