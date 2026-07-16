import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { messageLimiter } from '../middleware/rateLimiter';
import { emitToUser, isUserOnline } from '../services/callSignaling';

const router = Router();
const prisma = new PrismaClient();

// Mesajın müştəriyə göndərilən standart forması (reaksiyalar + cavab verilən mesaj daxil).
const msgInclude = {
  sender: { select: { id: true, name: true } },
  listing: { select: { id: true, title: true } },
  reactions: { select: { userId: true, emoji: true } },
  replyTo: { select: { id: true, content: true, senderId: true, deletedAt: true } },
} as const;

// Send message
router.post('/messages', messageLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { receiverId, listingId, consultationId, content, replyToId } = req.body;
    if (!content?.trim()) {
      res.status(400).json({ success: false, message: 'Mesaj boş ola bilməz' });
      return;
    }

    // Rəy konsultasiyası mesajı — yalnız seans AKTİV və vaxtı varsa göndərilə bilər.
    let consultId: number | null = null;
    if (consultationId) {
      consultId = parseInt(String(consultationId));
      const s = await prisma.consultationSession.findUnique({ where: { id: consultId } });
      if (!s || (s.buyerId !== req.adminId && s.professionalId !== req.adminId)) {
        res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return;
      }
      const used = s.consumedSeconds + (s.status === 'ACTIVE' && s.runningSince ? Math.floor((Date.now() - new Date(s.runningSince).getTime()) / 1000) : 0);
      const remaining = s.durationSeconds - used;
      if (s.status !== 'ACTIVE' || remaining <= 0) {
        res.status(403).json({ success: false, message: 'Konsultasiya aktiv deyil — vaxt bitib və ya başlanmayıb' }); return;
      }
    }

    const receiver = parseInt(receiverId);
    const online = isUserOnline(receiver);
    const message = await prisma.message.create({
      data: {
        senderId: req.adminId!,
        receiverId: receiver,
        listingId: listingId ? parseInt(listingId) : null,
        consultationId: consultId,
        content: content.trim(),
        replyToId: replyToId ? parseInt(String(replyToId)) : null,
        deliveredAt: online ? new Date() : null, // qarşı tərəf onlayndırsa dərhal çatdırıldı
      },
      include: msgInclude,
    });

    // Real-time: qarşı tərəfə və göndərənin digər cihazlarına anında çatdır.
    emitToUser(receiver, 'chat:message', message);
    emitToUser(req.adminId!, 'chat:message', message);
    if (online) emitToUser(req.adminId!, 'chat:delivered', { ids: [message.id], deliveredAt: message.deliveredAt });

    res.status(201).json({ success: true, message });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Redaktə et — yalnız göndərən, silinməmiş mesaj.
router.patch('/messages/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const { content } = req.body;
    if (!content?.trim()) { res.status(400).json({ success: false, message: 'Mesaj boş ola bilməz' }); return; }
    const m = await prisma.message.findUnique({ where: { id } });
    if (!m || m.senderId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (m.deletedAt) { res.status(400).json({ success: false, message: 'Silinmiş mesaj redaktə olunmur' }); return; }
    const updated = await prisma.message.update({ where: { id }, data: { content: content.trim(), editedAt: new Date() }, include: msgInclude });
    emitToUser(m.receiverId, 'chat:updated', updated);
    emitToUser(m.senderId, 'chat:updated', updated);
    res.json({ success: true, message: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Hamı üçün sil — sətir qalır, mətn boşalır, reaksiyalar silinir.
router.delete('/messages/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const m = await prisma.message.findUnique({ where: { id } });
    if (!m || m.senderId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    await prisma.messageReaction.deleteMany({ where: { messageId: id } });
    const updated = await prisma.message.update({ where: { id }, data: { deletedAt: new Date(), content: '' }, include: msgInclude });
    emitToUser(m.receiverId, 'chat:deleted', { id, deletedAt: updated.deletedAt });
    emitToUser(m.senderId, 'chat:deleted', { id, deletedAt: updated.deletedAt });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Emoji reaksiya — toggle (eyni emoji varsa götürülür, fərqlidirsə dəyişir).
router.post('/messages/:id/react', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const emoji = String(req.body?.emoji || '').slice(0, 8);
    if (!emoji) { res.status(400).json({ success: false, message: 'Emoji tələb olunur' }); return; }
    const m = await prisma.message.findUnique({ where: { id }, select: { id: true, senderId: true, receiverId: true, deletedAt: true } });
    if (!m) { res.status(404).json({ success: false, message: 'Mesaj tapılmadı' }); return; }
    if (m.deletedAt) { res.status(400).json({ success: false, message: 'Silinmiş mesaja reaksiya olmaz' }); return; }
    const me = req.adminId!;
    if (m.senderId !== me && m.receiverId !== me) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const existing = await prisma.messageReaction.findUnique({ where: { messageId_userId: { messageId: id, userId: me } } });
    if (existing && existing.emoji === emoji) {
      await prisma.messageReaction.delete({ where: { id: existing.id } });
    } else if (existing) {
      await prisma.messageReaction.update({ where: { id: existing.id }, data: { emoji } });
    } else {
      await prisma.messageReaction.create({ data: { messageId: id, userId: me, emoji } });
    }
    const reactions = await prisma.messageReaction.findMany({ where: { messageId: id }, select: { userId: true, emoji: true } });
    const partnerId = m.senderId === me ? m.receiverId : m.senderId;
    emitToUser(partnerId, 'chat:reaction', { id, reactions });
    emitToUser(me, 'chat:reaction', { id, reactions });
    res.json({ success: true, reactions });
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

// Get messages with a specific user (with pagination)
router.get('/messages/:partnerId', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.adminId!;
    const partnerId = parseInt(String(req.params.partnerId));
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
      include: msgInclude,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // Reverse to show oldest first
    messages.reverse();

    // Mark received messages as read — qarşı tərəfə "oxundu" bildir (mavi ✓✓).
    const upd = await prisma.message.updateMany({
      where: { senderId: partnerId, receiverId: userId, read: false },
      data: { read: true },
    });
    if (upd.count > 0) emitToUser(partnerId, 'chat:read', { by: userId });

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
