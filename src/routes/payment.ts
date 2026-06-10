import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { getOrderStatus, refund, isPaidStatus } from '../services/kapital';

const router = Router();
const prisma = new PrismaClient();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ====================== CALLBACK ======================
// Bank ödənişdən sonra müştərini bura yönəldir: ?ID=<gatewayOrderId>&STATUS=<...>
// STATUS müvəqqəti ola bilər → MÜTLƏQ getOrderStatus ilə təsdiqləyirik.
router.get('/payment/callback', async (req: Request, res: Response) => {
  const gatewayOrderId = parseInt(String(req.query.ID || ''));
  try {
    if (Number.isNaN(gatewayOrderId)) {
      return res.redirect(`${FRONTEND_URL}/payment/return?status=error`);
    }
    const orders = await prisma.order.findMany({ where: { gatewayOrderId } });
    if (orders.length === 0) {
      return res.redirect(`${FRONTEND_URL}/payment/return?status=error`);
    }

    // Banka birbaşa sorğu ilə həqiqi statusu al (callback STATUS-a güvənmə).
    const { status } = await getOrderStatus(gatewayOrderId);
    const paid = isPaidStatus(status);

    await prisma.order.updateMany({
      where: { gatewayOrderId },
      data: {
        gatewayStatus: status || null,
        paymentStatus: paid ? 'PAID' : 'FAILED',
        ...(paid ? { status: 'CONFIRMED' } : {}),
      },
    });

    // Ödəniş uğursuzdursa — stoku geri qaytar (checkout-da azalmışdı).
    if (!paid) {
      const withItems = await prisma.order.findMany({ where: { gatewayOrderId }, include: { items: true } });
      for (const o of withItems) {
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
    if (!order.gatewayOrderId || !order.gatewayPassword) {
      res.status(400).json({ success: false, message: 'Bu sifariş kartla ödənilməyib' }); return;
    }
    if (order.paymentStatus !== 'PAID') {
      res.status(400).json({ success: false, message: 'Yalnız ödənilmiş sifarişi iadə etmək olar' }); return;
    }

    // Eyni gateway-order altındakı bütün order-lər birlikdə ödənildiyi üçün,
    // qismən iadə bu order-in məbləği qədər; məbləç verilməsə bu order-in totalı.
    const refundAmount = amount !== undefined ? parseFloat(amount) : order.total;
    await refund(order.gatewayOrderId, order.gatewayPassword, refundAmount);

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
