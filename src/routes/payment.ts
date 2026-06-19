import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { getOrderStatus, isPaidStatus } from '../services/kapital';
import { refundOrder } from '../services/paymentGateway';
import { getPaymentStatus as yigimStatus, isPaidStatus as yigimPaid } from '../services/yigimPay';

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
    await prisma.order.updateMany({ where: { ...where, status: 'PENDING' }, data: { status: 'CONFIRMED' } });
    if (!wasPaid) {
      const byBuyer = new Map<number, number>();
      for (const o of orders) if (o.pointsEarned > 0) byBuyer.set(o.buyerId, (byBuyer.get(o.buyerId) || 0) + o.pointsEarned);
      for (const [buyerId, pts] of byBuyer) {
        try { await prisma.user.update({ where: { id: buyerId }, data: { loyaltyPoints: { increment: pts } } }); } catch { /* silinmiş */ }
      }
    }
  } else {
    for (const o of orders) {
      if (o.paymentStatus === 'FAILED') continue;
      for (const it of o.items) {
        try { await prisma.listing.update({ where: { id: it.listingId }, data: { stock: { increment: it.quantity } } }); } catch { /* silinmiş */ }
      }
    }
  }
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
    if (orders.length === 0) {
      return res.redirect(`${FRONTEND_URL}/payment/return?status=error`);
    }
    const wasPaid = orders.some((o) => o.paymentStatus === 'PAID');

    // Banka birbaşa sorğu ilə həqiqi statusu al (callback STATUS-a güvənmə).
    const { status } = await getOrderStatus(gatewayOrderId);
    const paid = isPaidStatus(status);

    await prisma.order.updateMany({
      where: { gatewayOrderId },
      data: { gatewayStatus: status || null, paymentStatus: paid ? 'PAID' : 'FAILED' },
    });

    if (paid) {
      // Yalnız hələ PENDING olanları təsdiqlə — satıcı/biznes artıq CANCELLED edibsə dirçəltmə.
      await prisma.order.updateMany({ where: { gatewayOrderId, status: 'PENDING' }, data: { status: 'CONFIRMED' } });
      // Loyalty xalını yalnız indi (ödəniş təsdiqində) və bir dəfə hesabla (idempotent).
      if (!wasPaid) {
        const byBuyer = new Map<number, number>();
        for (const o of orders) if (o.pointsEarned > 0) byBuyer.set(o.buyerId, (byBuyer.get(o.buyerId) || 0) + o.pointsEarned);
        for (const [buyerId, pts] of byBuyer) {
          try { await prisma.user.update({ where: { id: buyerId }, data: { loyaltyPoints: { increment: pts } } }); } catch { /* istifadəçi silinmiş ola bilər */ }
        }
      }
    } else {
      // Ödəniş uğursuz — stoku geri qaytar (yalnız bir dəfə: əvvəl FAILED deyilsə).
      for (const o of orders) {
        if (o.paymentStatus === 'FAILED') continue;
        for (const it of o.items) {
          try { await prisma.listing.update({ where: { id: it.listingId }, data: { stock: { increment: it.quantity } } }); } catch { /* listing silinmiş ola bilər */ }
        }
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
    if (!order) return res.redirect(`${FRONTEND_URL}/payment/return?status=error`);
    const { status } = await yigimStatus(reference);
    const paid = yigimPaid(status);
    await settleOrders({ gatewayRef: reference }, status, paid);
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
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.buyerId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return;
    }
    res.json({ success: true, paymentStatus: order.paymentStatus, gatewayStatus: order.gatewayStatus });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ====================== REFUND (admin) ======================
router.post('/payment/refund/:orderId', requireAdmin, async (req: AuthRequest, res: Response) => {
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
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
