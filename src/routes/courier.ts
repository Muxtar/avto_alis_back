import { Router, Response } from 'express';
import { PrismaClient, UserType } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { recordSettlement } from '../services/settlement';
import { pushLive } from '../services/live';

const router = Router();
const prisma = new PrismaClient();

// Get courier profile
router.get('/courier/profile', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const courier = await prisma.user.findUnique({
      where: { id: req.adminId },
      select: { id: true, name: true, phone: true, type: true, createdAt: true, _count: { select: { courierOrders: true } } },
    });
    if (!courier || courier.type !== UserType.COURIER) {
      res.status(403).json({ success: false, message: 'Kuryer deyilsiniz' });
      return;
    }
    res.json({ success: true, courier });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get orders assigned to courier
router.get('/courier/orders', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query;
    const where: any = { courierId: req.adminId };
    if (status && status !== 'all') where.status = status;

    const orders = await prisma.order.findMany({
      where,
      include: {
        items: {
          include: {
            listing: { select: { id: true, title: true, images: true, location: true } },
          },
        },
        buyer: { select: { id: true, name: true, phone: true } },
        seller: {
          select: {
            id: true, name: true, phone: true,
            workplaces: { select: { latitude: true, longitude: true, address: true } },
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

// Update order status (courier can mark as SHIPPED or DELIVERED)
router.put('/courier/orders/:id/status', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!order || order.courierId !== req.adminId) {
      res.status(403).json({ success: false, message: 'Bu sifariş sizə aid deyil' });
      return;
    }
    const { status } = req.body;
    if (!['SHIPPED', 'DELIVERED'].includes(status)) {
      res.status(400).json({ success: false, message: 'Kuryer yalnız SHIPPED və ya DELIVERED statusu təyin edə bilər' });
      return;
    }
    // ARDICILLIQ: bitmiş sifarişin statusu dəyişdirilə bilməz və məhsul
    // götürülmədən «çatdırıldı» olmaz. Əvvəl heç bir yoxlama yox idi.
    if (order.status === 'DELIVERED' || order.status === 'CANCELLED') {
      res.status(400).json({ success: false, message: 'Bu sifariş artıq bağlanıb' }); return;
    }
    if (status === 'DELIVERED' && order.status !== 'SHIPPED') {
      res.status(400).json({ success: false, message: 'Əvvəlcə məhsulu götürdüyünüzü qeyd edin (Göndərildi)' }); return;
    }
    // Kartla ödənilməmiş sifariş çatdırılmış sayıla bilməz.
    if (order.paymentMethod === 'CARD' && order.paymentStatus !== 'PAID') {
      res.status(400).json({ success: false, message: 'Ödəniş tamamlanmayıb' }); return;
    }
    // DELIVERED üçün təhvil kodu tələb olunur (alıcının kodu) — səhv/təkrar təhvilin qarşısını alır.
    if (status === 'DELIVERED' && order.pickupCode) {
      const provided = String(req.body?.code || '').trim().toUpperCase();
      if (provided !== order.pickupCode.toUpperCase()) {
        res.status(400).json({ success: false, message: 'Təhvil kodu yanlışdır. Alıcıdan kodu soruşun.' });
        return;
      }
    }
    // ÇATDIRILMA ANI: `deliveredAt` mütləq yazılmalıdır — 14 günlük qaytarma
    // pəncərəsi ondan sayılır. Əvvəl yalnız `status` yazılırdı: kuryerin
    // çatdırdığı sifariş həm sonsuz iadə hüququ ilə qalırdı, həm də satıcının
    // hesablaşması heç vaxt aparılmırdı.
    const updated = await prisma.order.update({
      where: { id: parseInt(req.params.id) },
      data: {
        status,
        ...(status === 'DELIVERED'
          ? { deliveredAt: order.deliveredAt || new Date(), deliveryDeadline: null }
          : {}),
      },
    });

    if (status === 'DELIVERED') {
      // Satıcının uçot sətri yazılsın (saxlama pəncərəsi buradan başlayır).
      await recordSettlement(order.id).catch(() => {});
      await prisma.notification.createMany({
        data: [
          { userId: order.buyerId, type: 'ORDER', title: `Sifariş #${order.id}`, body: 'Sifarişiniz çatdırıldı. Problem varsa 14 gün ərzində iadə sorğusu göndərə bilərsiniz.', link: '/orders' },
          { userId: order.sellerId, type: 'ORDER', title: `Sifariş #${order.id}`, body: 'Sifariş kuryer tərəfindən çatdırıldı.', link: '/orders' },
        ],
      }).catch(() => {});
    }
    pushLive([order.buyerId, order.sellerId], { kind: 'order', id: order.id, status });
    res.json({ success: true, order: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
