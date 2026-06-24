import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { refundOrder } from '../services/paymentGateway';

const router = Router();
const prisma = new PrismaClient();

const CATEGORIES = ['TIME_WASTED', 'FRAUD', 'RUDE', 'FAKE_INFO', 'OTHER'];
const COMPLAINT_WINDOW_DAYS = 7;

// ── İstifadəçi: şikayət göndər ────────────────────────────────────────────────
router.post('/complaints', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const category = String(req.body.category || '').trim();
    const description = String(req.body.description || '').trim();
    if (!CATEGORIES.includes(category)) { res.status(400).json({ success: false, message: 'Şikayət növü yanlışdır' }); return; }
    if (description.length < 5) { res.status(400).json({ success: false, message: 'Şikayətin təsvirini yazın' }); return; }

    const consultationId = req.body.consultationId !== undefined ? parseInt(String(req.body.consultationId)) : null;
    let targetUserId = req.body.targetUserId !== undefined ? parseInt(String(req.body.targetUserId)) : NaN;

    if (consultationId) {
      const s = await prisma.consultationSession.findUnique({ where: { id: consultationId } });
      if (!s || s.buyerId !== req.adminId) { res.status(403).json({ success: false, message: 'Bu seansdan şikayət edə bilməzsiniz' }); return; }
      targetUserId = s.professionalId;
      // 7 gün pəncərə (seansın yaranmasından).
      const ageDays = (Date.now() - new Date(s.createdAt).getTime()) / 86400000;
      if (ageDays > COMPLAINT_WINDOW_DAYS) { res.status(400).json({ success: false, message: 'Şikayət müddəti bitib (7 gün)' }); return; }
      // Hər seansa bir şikayət.
      const dup = await prisma.complaint.findFirst({ where: { complainantId: req.adminId!, consultationId } });
      if (dup) { res.status(400).json({ success: false, message: 'Bu seans üçün artıq şikayət göndərmisiniz' }); return; }
    }
    if (Number.isNaN(targetUserId)) { res.status(400).json({ success: false, message: 'Şikayət ediləcək şəxs göstərilməyib' }); return; }
    if (targetUserId === req.adminId) { res.status(400).json({ success: false, message: 'Özünüzdən şikayət edə bilməzsiniz' }); return; }

    const complaint = await prisma.complaint.create({
      data: { complainantId: req.adminId!, targetUserId, consultationId, category, description },
    });
    res.json({ success: true, complaint });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Mənim göndərdiyim şikayətlər.
router.get('/me/complaints', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const complaints = await prisma.complaint.findMany({
      where: { complainantId: req.adminId! },
      orderBy: { createdAt: 'desc' },
      include: { target: { select: { id: true, name: true } } },
    });
    res.json({ success: true, complaints });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get('/admin/complaints', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const complaints = await prisma.complaint.findMany({
      where: status ? { status: status as any } : undefined,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        complainant: { select: { id: true, name: true } },
        target: { select: { id: true, name: true, complaintFlags: true, consultationSuspended: true } },
      },
    });
    res.json({ success: true, complaints });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Şikayət detalı + DƏLİL siqnalları (söhbət + vaxt analizi).
router.get('/admin/complaints/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const complaint = await prisma.complaint.findUnique({
      where: { id },
      include: {
        complainant: { select: { id: true, name: true } },
        target: { select: { id: true, name: true, complaintFlags: true, consultationSuspended: true } },
        consultation: true,
      },
    });
    if (!complaint) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }

    let evidence: any = null;
    if (complaint.consultationId) {
      const s = complaint.consultation!;
      const msgs = await prisma.message.findMany({
        where: { consultationId: complaint.consultationId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, senderId: true, content: true, createdAt: true },
      });
      const proMsgs = msgs.filter((m) => m.senderId === s.professionalId);
      const buyerMsgs = msgs.filter((m) => m.senderId === s.buyerId);
      // İlk peşəkar cavabına qədər keçən vaxt (seans başlayandan).
      let firstProGapSec: number | null = null;
      if (s.startedAt && proMsgs.length > 0) {
        firstProGapSec = Math.max(0, Math.floor((new Date(proMsgs[0].createdAt).getTime() - new Date(s.startedAt).getTime()) / 1000));
      }
      evidence = {
        activeSeconds: s.consumedSeconds,
        durationSeconds: s.durationSeconds,
        proMessageCount: proMsgs.length,
        buyerMessageCount: buyerMsgs.length,
        firstProResponseGapSec: firstProGapSec,
        proNeverResponded: s.consumedSeconds > 0 && proMsgs.length === 0,
        price: s.price,
        paymentStatus: s.paymentStatus,
        refundable: s.paymentStatus === 'PAID' && !!(s.gatewayRef || s.gatewayOrderId),
        messages: msgs.map((m) => ({ ...m, who: m.senderId === s.professionalId ? 'professional' : 'buyer' })),
      };
    }
    res.json({ success: true, complaint, evidence });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Şikayəti həll et — geri ödəniş / peşəkarı dayandır / rədd və s.
router.post('/admin/complaints/:id/resolve', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const c = await prisma.complaint.findUnique({ where: { id }, include: { consultation: true } });
    if (!c) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }

    const status = String(req.body.status || 'RESOLVED'); // RESOLVED | REJECTED
    const resolution = req.body.resolution ? String(req.body.resolution) : null;
    const adminNote = req.body.adminNote ? String(req.body.adminNote).trim() : null;
    const doRefund = !!req.body.refund;
    const doSuspend = !!req.body.suspend;
    const upheld = status === 'RESOLVED';

    // Geri ödəniş (yalnız seans şikayətində, ödənilibsə).
    if (doRefund && c.consultation && c.consultation.paymentStatus === 'PAID' && (c.consultation.gatewayRef || c.consultation.gatewayOrderId)) {
      try {
        await refundOrder({
          gatewayProvider: c.consultation.gatewayProvider,
          gatewayRef: c.consultation.gatewayRef,
          gatewayOrderId: c.consultation.gatewayOrderId,
          gatewayPassword: c.consultation.gatewayPassword,
        }, c.consultation.price);
      } catch (err: any) {
        res.status(400).json({ success: false, message: 'Geri ödəniş alınmadı: ' + (err?.message || 'şlüz xətası') }); return;
      }
      await prisma.consultationSession.update({ where: { id: c.consultation.id }, data: { paymentStatus: 'REFUNDED' } });
      await prisma.notification.create({ data: { userId: c.complainantId, type: 'COMPLAINT', title: 'Geri ödəniş edildi', body: 'Şikayətiniz üzrə vəsait geri qaytarıldı.', link: '/consultations' } }).catch(() => {});
    }

    // Peşəkarı dayandır (təkliflərini deaktiv et).
    if (doSuspend) {
      await prisma.user.update({ where: { id: c.targetUserId }, data: { consultationSuspended: true } });
      await prisma.consultationOffer.updateMany({ where: { userId: c.targetUserId }, data: { active: false } });
      await prisma.notification.create({ data: { userId: c.targetUserId, type: 'COMPLAINT', title: 'Rəy təklifləri dayandırıldı', body: 'Şikayət əsasında konsultasiya təklifləriniz admin tərəfindən dayandırıldı.', link: '/profile' } }).catch(() => {});
    }

    // Təsdiqlənmiş şikayət sayğacı.
    if (upheld) {
      await prisma.user.update({ where: { id: c.targetUserId }, data: { complaintFlags: { increment: 1 } } });
    }

    await prisma.complaint.update({
      where: { id },
      data: { status: status as any, resolution: resolution || (doRefund ? 'REFUNDED' : doSuspend ? 'SUSPENDED' : upheld ? 'WARNED' : 'REJECTED'), adminNote, resolvedById: req.adminId, resolvedAt: new Date() },
    });
    await prisma.notification.create({ data: { userId: c.complainantId, type: 'COMPLAINT', title: 'Şikayət nəticələndi', body: upheld ? 'Şikayətiniz nəzərə alındı.' : 'Şikayətiniz araşdırıldı.', link: '/consultations' } }).catch(() => {});

    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
