import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

// Bildirimleri getir
router.get('/notifications', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.adminId! },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const unreadCount = await prisma.notification.count({
      where: { userId: req.adminId!, read: false },
    });
    res.json({ notifications, unreadCount });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Bildirimi okundu isaretle
router.put('/notifications/:id/read', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const notif = await prisma.notification.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!notif || notif.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    const updated = await prisma.notification.update({
      where: { id: notif.id },
      data: { read: true },
    });
    res.json({ success: true, notification: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Tumunu okundu isaretle
router.put('/notifications/read-all', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.adminId!, read: false },
      data: { read: true },
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Bildirim sayisi
router.get('/notifications/unread-count', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const count = await prisma.notification.count({
      where: { userId: req.adminId!, read: false },
    });
    res.json({ count });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
