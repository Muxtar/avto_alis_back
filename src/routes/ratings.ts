import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

// Satici icin rating ver (alici, DELIVERED sonrasi)
router.post('/orders/:orderId/rating', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const { rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      res.status(400).json({ success: false, message: 'Rating 1-5 arası olmalıdır' });
      return;
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.buyerId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    if (order.status !== 'DELIVERED') {
      res.status(400).json({ success: false, message: 'Yalnız çatdırılmış sifarişlər üçün rating verə bilərsiniz' });
      return;
    }

    const existing = await prisma.sellerRating.findUnique({ where: { orderId } });
    if (existing) {
      res.status(400).json({ success: false, message: 'Bu sifariş üçün artıq rating vermişsiniz' });
      return;
    }

    const created = await prisma.sellerRating.create({
      data: {
        orderId,
        sellerId: order.sellerId,
        buyerId: req.adminId!,
        rating: parseInt(rating),
        comment: comment || null,
      },
    });

    // Saticinin ortalamasini yenile
    const stats = await prisma.sellerRating.aggregate({
      where: { sellerId: order.sellerId },
      _avg: { rating: true },
      _count: true,
    });

    await prisma.user.update({
      where: { id: order.sellerId },
      data: {
        avgRating: stats._avg.rating || null,
        ratingCount: stats._count,
      },
    });

    res.status(201).json({ success: true, rating: created });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Satici ratinglerini getir
router.get('/sellers/:id/ratings', async (req: any, res: Response) => {
  try {
    const sellerId = parseInt(req.params.id);
    const ratings = await prisma.sellerRating.findMany({
      where: { sellerId },
      include: { buyer: { select: { id: true, name: true, type: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const stats = await prisma.sellerRating.aggregate({
      where: { sellerId },
      _avg: { rating: true },
      _count: true,
    });
    res.json({
      ratings,
      avgRating: stats._avg.rating ? Math.round(stats._avg.rating * 10) / 10 : null,
      ratingCount: stats._count,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
