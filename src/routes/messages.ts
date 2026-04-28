import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

// Send message
router.post('/messages', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { receiverId, listingId, content } = req.body;
    if (!content?.trim()) {
      res.status(400).json({ success: false, message: 'Mesaj boş ola bilməz' });
      return;
    }

    const message = await prisma.message.create({
      data: {
        senderId: req.adminId!,
        receiverId: parseInt(receiverId),
        listingId: listingId ? parseInt(listingId) : null,
        content: content.trim(),
      },
      include: {
        sender: { select: { id: true, name: true } },
        listing: { select: { id: true, title: true } },
      },
    });

    res.status(201).json({ success: true, message });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get my conversations (grouped by other user)
router.get('/messages/conversations', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.adminId!;

    // Get all messages involving this user
    const messages = await prisma.message.findMany({
      where: { OR: [{ senderId: userId }, { receiverId: userId }] },
      include: {
        sender: { select: { id: true, name: true, type: true } },
        receiver: { select: { id: true, name: true, type: true } },
        listing: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Group by conversation partner
    const convMap = new Map<number, any>();
    for (const msg of messages) {
      const partnerId = msg.senderId === userId ? msg.receiverId : msg.senderId;
      const partner = msg.senderId === userId ? msg.receiver : msg.sender;
      if (!convMap.has(partnerId)) {
        const unread = messages.filter((m) => m.senderId === partnerId && m.receiverId === userId && !m.read).length;
        convMap.set(partnerId, {
          partner,
          lastMessage: msg,
          unreadCount: unread,
        });
      }
    }

    res.json({ conversations: Array.from(convMap.values()) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get messages with a specific user
// Get messages with a specific user (with pagination)
router.get('/messages/:partnerId', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.adminId!;
    const partnerId = parseInt(req.params.partnerId);
    const limit = parseInt(req.query.limit as string) || 50;
    const before = req.query.before ? parseInt(req.query.before as string) : undefined;

    const where: any = {
      OR: [
        { senderId: userId, receiverId: partnerId },
        { senderId: partnerId, receiverId: userId },
      ],
    };
    if (before) {
      where.id = { lt: before };
    }

    const total = await prisma.message.count({
      where: {
        OR: [
          { senderId: userId, receiverId: partnerId },
          { senderId: partnerId, receiverId: userId },
        ],
      },
    });

    const messages = await prisma.message.findMany({
      where,
      include: {
        sender: { select: { id: true, name: true } },
        listing: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // Reverse to show oldest first
    messages.reverse();

    // Mark received messages as read
    await prisma.message.updateMany({
      where: { senderId: partnerId, receiverId: userId, read: false },
      data: { read: true },
    });

    const partner = await prisma.user.findUnique({
      where: { id: partnerId },
      select: { id: true, name: true, phone: true, type: true },
    });

    res.json({ messages, partner, total, hasMore: total > (before ? messages.length : limit) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get unread count
router.get('/messages-unread', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const count = await prisma.message.count({
      where: { receiverId: req.adminId!, read: false },
    });
    res.json({ count });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
