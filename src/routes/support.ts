// Dəstək ticket sistemi — istifadəçi müraciət açır, admin cavablandırır.
import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, requirePermission, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';

const router = Router();
const prisma = new PrismaClient();

const CATEGORIES = ['ORDER', 'PAYMENT', 'ACCOUNT', 'LISTING', 'OTHER'];

// ── İstifadəçi: yeni ticket ──
router.post('/support/tickets', adminAuth, upload.array('images', 4), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const subject = String(req.body?.subject || '').trim().slice(0, 160);
    const body = String(req.body?.body || '').trim();
    const category = CATEGORIES.includes(String(req.body?.category)) ? String(req.body.category) : 'OTHER';
    if (!subject || body.length < 5) { res.status(400).json({ success: false, message: 'Mövzu və mesaj tələb olunur' }); return; }
    const files = req.files as Express.Multer.File[] | undefined;
    const images = files?.map((f) => f.filename) || [];
    const me = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { name: true } });
    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.adminId!, subject, category, status: 'OPEN',
        messages: { create: { senderId: req.adminId!, isAdmin: false, senderName: me?.name || 'İstifadəçi', body, images } },
      },
      include: { messages: true },
    });
    res.json({ success: true, ticket });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// İstifadəçi: öz ticketləri.
router.get('/support/tickets', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const tickets = await prisma.supportTicket.findMany({ where: { userId: req.adminId! }, orderBy: { lastReplyAt: 'desc' } });
    res.json({ success: true, tickets });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// İstifadəçi: ticket detalı (mesajlarla).
router.get('/support/tickets/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const ticket = await prisma.supportTicket.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
    if (!ticket || ticket.userId !== req.adminId) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    res.json({ success: true, ticket });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// İstifadəçi: cavab əlavə et.
router.post('/support/tickets/:id/reply', adminAuth, upload.array('images', 4), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const body = String(req.body?.body || '').trim();
    if (body.length < 1) { res.status(400).json({ success: false, message: 'Mesaj yazın' }); return; }
    const t = await prisma.supportTicket.findUnique({ where: { id }, select: { userId: true, status: true } });
    if (!t || t.userId !== req.adminId) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    if (t.status === 'CLOSED') { res.status(400).json({ success: false, message: 'Bağlı ticket' }); return; }
    const files = req.files as Express.Multer.File[] | undefined;
    const me = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { name: true } });
    await prisma.ticketMessage.create({ data: { ticketId: id, senderId: req.adminId!, isAdmin: false, senderName: me?.name || 'İstifadəçi', body, images: files?.map((f) => f.filename) || [] } });
    await prisma.supportTicket.update({ where: { id }, data: { status: 'OPEN', lastReplyAt: new Date() } });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Admin ──
router.get('/admin/support', requirePermission('support'), async (req: AuthRequest, res: Response) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const tickets = await prisma.supportTicket.findMany({
      where: status ? { status: status as any } : undefined,
      orderBy: [{ status: 'asc' }, { lastReplyAt: 'desc' }],
      take: 200,
    });
    const ids = Array.from(new Set(tickets.map((t) => t.userId)));
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true } }) : [];
    const uById = new Map(users.map((u) => [u.id, u]));
    // Açıq ticket sayı (badge üçün).
    const openCount = await prisma.supportTicket.count({ where: { status: 'OPEN' } });
    res.json({ success: true, tickets: tickets.map((t) => ({ ...t, user: uById.get(t.userId) || null })), openCount });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.get('/admin/support/:id', requirePermission('support'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const ticket = await prisma.supportTicket.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
    if (!ticket) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    const user = await prisma.user.findUnique({ where: { id: ticket.userId }, select: { id: true, name: true, phone: true, email: true } });
    res.json({ success: true, ticket, user });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.post('/admin/support/:id/reply', requirePermission('support'), upload.array('images', 4), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const body = String(req.body?.body || '').trim();
    const t = await prisma.supportTicket.findUnique({ where: { id }, select: { userId: true } });
    if (!t) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    if (body.length < 1) { res.status(400).json({ success: false, message: 'Mesaj yazın' }); return; }
    const files = req.files as Express.Multer.File[] | undefined;
    await prisma.ticketMessage.create({ data: { ticketId: id, senderId: req.adminId!, isAdmin: true, senderName: req.adminName || 'Dəstək', body, images: files?.map((f) => f.filename) || [] } });
    await prisma.supportTicket.update({ where: { id }, data: { status: 'PENDING', lastReplyAt: new Date() } });
    await prisma.notification.create({ data: { userId: t.userId, type: 'SYSTEM', title: 'Dəstəkdən cavab', body: 'Müraciətinizə cavab verildi.', link: '/support' } }).catch(() => {});
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.patch('/admin/support/:id/status', requirePermission('support'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const status = String(req.body?.status);
    if (!['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'].includes(status)) { res.status(400).json({ success: false, message: 'Yanlış status' }); return; }
    await prisma.supportTicket.update({ where: { id }, data: { status: status as any } });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
