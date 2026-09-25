import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, requirePermission, AuthRequest } from '../middleware/auth';
import { complaintLimiter } from '../middleware/rateLimiter';
import { refundOrder } from '../services/paymentGateway';
import { upload } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';
import { pushLive, pushAdmins } from '../services/live';
import { createSellerComplaint, SELLER_COMPLAINT_CATEGORIES } from '../services/sellerReputation';

const router = Router();
const prisma = new PrismaClient();

// Şikayət növləri — şəxs/seans (əvvəlki) + eBay üslubu məhsul qüsuru növləri.
const CATEGORIES = Object.keys(SELLER_COMPLAINT_CATEGORIES);
const COMPLAINT_WINDOW_DAYS = 7;
const MAX_EVIDENCE = 6;

// ── İstifadəçi: şikayət göndər (foto sübutlu — eBay üslubu) ───────────────────
// multipart: description, category, + hədəf (consultationId | orderId | listingId |
// targetUserId) + images[] (qüsurlu məhsulun şəkilləri). JSON da qəbul edilir
// (şəkilsiz şəxs/seans şikayətləri üçün geriyə uyğunluq).
router.post('/complaints', complaintLimiter, adminAuth, upload.array('images', MAX_EVIDENCE), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const category = String(req.body.category || '').trim();
    const description = String(req.body.description || '').trim();
    if (!CATEGORIES.includes(category)) { res.status(400).json({ success: false, message: 'Şikayət növü yanlışdır' }); return; }
    if (description.length < 5) { res.status(400).json({ success: false, message: 'Şikayətin təsvirini yazın' }); return; }

    const files = req.files as Express.Multer.File[] | undefined;
    const images = files?.map((f) => f.filename) || [];

    const consultationId = req.body.consultationId ? parseInt(String(req.body.consultationId)) : null;
    const orderId = req.body.orderId ? parseInt(String(req.body.orderId)) : null;
    let listingId = req.body.listingId ? parseInt(String(req.body.listingId)) : null;
    let targetUserId = req.body.targetUserId !== undefined ? parseInt(String(req.body.targetUserId)) : NaN;

    if (consultationId) {
      const s = await prisma.consultationSession.findUnique({ where: { id: consultationId } });
      if (!s || s.buyerId !== req.adminId) { res.status(403).json({ success: false, message: 'Bu seansdan şikayət edə bilməzsiniz' }); return; }
      targetUserId = s.professionalId;
      const ageDays = (Date.now() - new Date(s.createdAt).getTime()) / 86400000;
      if (ageDays > COMPLAINT_WINDOW_DAYS) { res.status(400).json({ success: false, message: 'Şikayət müddəti bitib (7 gün)' }); return; }
      const dup = await prisma.complaint.findFirst({ where: { complainantId: req.adminId!, consultationId } });
      if (dup) { res.status(400).json({ success: false, message: 'Bu seans üçün artıq şikayət göndərmisiniz' }); return; }
    } else if (orderId) {
      // Sifariş şikayəti — yalnız alıcı, satıcıya qarşı.
      const o = await prisma.order.findUnique({ where: { id: orderId }, select: { buyerId: true, sellerId: true } });
      if (!o || o.buyerId !== req.adminId) { res.status(403).json({ success: false, message: 'Bu sifarişdən şikayət edə bilməzsiniz' }); return; }
      targetUserId = o.sellerId;
    } else if (listingId) {
      // Məhsul/elan şikayəti — hədəf elan sahibidir.
      const l = await prisma.listing.findUnique({ where: { id: listingId }, select: { userId: true } });
      if (!l) { res.status(404).json({ success: false, message: 'Elan tapılmadı' }); return; }
      targetUserId = l.userId;
    }

    if (Number.isNaN(targetUserId)) { res.status(400).json({ success: false, message: 'Şikayət ediləcək şəxs/məhsul göstərilməyib' }); return; }
    if (targetUserId === req.adminId) { res.status(400).json({ success: false, message: 'Özünüzdən şikayət edə bilməzsiniz' }); return; }

    // MƏHSUL / SİFARİŞ ŞİKAYƏTİ — REPUTASİYA (pul/mal qaytarmır; bunun üçün İadə var).
    // Satıcının reytinqinə yalnız ALIŞ etmiş alıcının şikayəti təsir edir.
    if (!consultationId && (orderId || listingId)) {
      let oid = orderId;
      if (!oid && listingId) {
        // Elandan şikayət edən bu satıcıdan həmin məhsulu alıbsa — sifarişə bağla.
        const bought = await prisma.order.findFirst({
          where: { buyerId: req.adminId!, sellerId: targetUserId, status: { not: 'PENDING' }, items: { some: { listingId } }, OR: [{ paymentMethod: { not: 'CARD' } }, { paymentStatus: { in: ['PAID', 'REFUNDED'] } }] },
          orderBy: { createdAt: 'desc' }, select: { id: true },
        });
        oid = bought?.id ?? null;
      }
      if (oid) {
        const dup = await prisma.complaint.findFirst({ where: { complainantId: req.adminId!, orderId: oid, status: { not: 'REJECTED' }, OR: [{ resolution: null }, { resolution: { not: 'WITHDRAWN' } }] }, select: { id: true } });
        if (dup) { res.status(400).json({ success: false, message: `Bu sifariş üzrə artıq şikayətiniz var (#${dup.id})` }); return; }
      }
      // Alış yoxdursa — elan haqqında bildiriş (admin moderasiyası, reytinqə təsir etmir).
      const complaint = await createSellerComplaint({ complainantId: req.adminId!, targetUserId, orderId: oid, listingId, category, description, images });
      res.json({ success: true, complaint, affectsRating: !!oid });
      return;
    }

    const complaint = await prisma.complaint.create({
      data: { complainantId: req.adminId!, targetUserId, consultationId, orderId, listingId, category, description, images },
    });
    pushAdmins('complaint', { id: complaint.id, toast: 'Yeni şikayət' });
    res.json({ success: true, complaint });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// İstifadəçi: mövcud şikayətə əlavə foto/sübut əlavə et (admin istəyəndən sonra).
router.post('/complaints/:id/evidence', complaintLimiter, adminAuth, upload.array('images', MAX_EVIDENCE), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const c = await prisma.complaint.findUnique({ where: { id }, select: { complainantId: true, images: true, status: true } });
    if (!c || c.complainantId !== req.adminId) { res.status(404).json({ success: false, message: 'Şikayət tapılmadı' }); return; }
    if (c.status === 'RESOLVED' || c.status === 'REJECTED') { res.status(400).json({ success: false, message: 'Bağlanmış şikayətə sübut əlavə edilə bilməz' }); return; }
    const files = req.files as Express.Multer.File[] | undefined;
    const add = files?.map((f) => f.filename) || [];
    if (!add.length) { res.status(400).json({ success: false, message: 'Şəkil əlavə edin' }); return; }
    const images = [...(c.images || []), ...add].slice(0, MAX_EVIDENCE);
    // Sübut əlavə olundu → yenidən baxış üçün REVIEWING-ə qaytar.
    const updated = await prisma.complaint.update({ where: { id }, data: { images, ...(c.status === 'AWAITING_SELLER' ? {} : { status: 'REVIEWING' }) } });
    pushAdmins('complaint', { id, toast: `Şikayət #${id}: sübut əlavə edildi` });
    res.json({ success: true, complaint: updated });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Satıcının cavabı — izah / üzr / həll təklifi. Pul və ya mal hərəkəti YOXDUR.
router.post('/complaints/:id/respond', complaintLimiter, adminAuth, upload.array('images', MAX_EVIDENCE), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const c = await prisma.complaint.findUnique({ where: { id } });
    if (!c || c.targetUserId !== req.adminId) { res.status(404).json({ success: false, message: 'Şikayət tapılmadı' }); return; }
    if (c.status === 'RESOLVED' || c.status === 'REJECTED') { res.status(400).json({ success: false, message: 'Şikayət bağlanıb' }); return; }
    const response = String(req.body?.response || '').trim();
    if (response.length < 10) { res.status(400).json({ success: false, message: 'Cavabınızı ətraflı yazın (ən azı 10 simvol)' }); return; }
    const images = ((req.files as Express.Multer.File[] | undefined) || []).map((f) => f.filename);
    const updated = await prisma.complaint.update({
      where: { id },
      data: { sellerResponse: response.slice(0, 3000), sellerImages: [...c.sellerImages, ...images].slice(0, 6), sellerRespondedAt: new Date(), status: 'REVIEWING' },
    });
    await prisma.notification.create({
      data: { userId: c.complainantId, type: 'COMPLAINT', title: 'Satıcı şikayətinizə cavab verdi', body: `${response.slice(0, 160)}${response.length > 160 ? '…' : ''} — problem həll olunubsa şikayəti bağlaya bilərsiniz.`, link: '/complaints' },
    }).catch(() => {});
    pushLive(c.complainantId, { kind: 'complaint', id, toast: 'Satıcı şikayətinizə cavab verdi', tone: 'info' });
    res.json({ success: true, complaint: updated });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Alıcı: «problem həll olundu» — şikayəti geri götürür (reytinqə təsir etmir).
router.post('/complaints/:id/withdraw', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const c = await prisma.complaint.findUnique({ where: { id } });
    if (!c || c.complainantId !== req.adminId) { res.status(404).json({ success: false, message: 'Şikayət tapılmadı' }); return; }
    if (c.status === 'RESOLVED' || c.status === 'REJECTED') { res.status(400).json({ success: false, message: 'Şikayət artıq bağlanıb' }); return; }
    const note = String(req.body?.note || '').trim().slice(0, 500);
    const updated = await prisma.complaint.update({
      where: { id },
      data: { status: 'RESOLVED', resolution: 'WITHDRAWN', resolvedAt: new Date(), adminNote: note ? `Alıcı: ${note}` : c.adminNote },
    });
    await prisma.notification.create({
      data: { userId: c.targetUserId, type: 'COMPLAINT', title: 'Alıcı şikayətini bağladı ✓', body: 'Alıcı problemin həll olunduğunu bildirdi — şikayət reytinqinizə təsir etmir.', link: '/complaints?tab=against' },
    }).catch(() => {});
    pushLive(c.targetUserId, { kind: 'complaint', id, toast: 'Alıcı şikayətini bağladı ✓', tone: 'success' });
    res.json({ success: true, complaint: updated });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Mənə qarşı açılmış şikayətlər (satıcı cavab versin).
router.get('/me/complaints/against', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const complaints = await prisma.complaint.findMany({
      where: { targetUserId: req.adminId!, consultationId: null },
      orderBy: { createdAt: 'desc' },
      include: { complainant: { select: { id: true, name: true } } },
    });
    res.json({ success: true, complaints });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Mənim göndərdiyim şikayətlər (sübut vəziyyəti ilə — admin foto istəyibsə görünsün).
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
router.get('/admin/complaints', requirePermission('complaints'), async (req: AuthRequest, res: Response) => {
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
router.get('/admin/complaints/:id', requirePermission('complaints'), async (req: AuthRequest, res: Response) => {
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

    // Məhsul/sifariş şikayətidirsə əlaqəli obyektləri gətir (admin analiz üçün).
    let listing: any = null, order: any = null;
    if (complaint.listingId) {
      listing = await prisma.listing.findUnique({
        where: { id: complaint.listingId },
        select: { id: true, title: true, price: true, images: true, condition: true, user: { select: { id: true, name: true } } },
      });
    }
    if (complaint.orderId) {
      order = await prisma.order.findUnique({
        where: { id: complaint.orderId },
        select: { id: true, status: true, total: true, paymentStatus: true, paymentMethod: true,
          items: { select: { listingId: true, title: true, price: true, quantity: true, listing: { select: { images: true } } } } },
      });
    }

    const returnRequest = complaint.returnId ? await prisma.returnRequest.findUnique({
      where: { id: complaint.returnId }, include: { events: { orderBy: { createdAt: 'asc' } } },
    }) : null;

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
    res.json({ success: true, complaint, evidence, listing, order, returnRequest });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Admin: şikayətçidən əlavə foto/sübut istə (eBay üslubu — "daha çox məlumat").
// Status EVIDENCE_REQUESTED olur və şikayətçiyə bildiriş gedir.
router.post('/admin/complaints/:id/request-evidence', requirePermission('complaints'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const note = String(req.body?.note || '').trim().slice(0, 300);
    const c = await prisma.complaint.findUnique({ where: { id }, select: { id: true, complainantId: true, status: true } });
    if (!c) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    if (c.status === 'RESOLVED' || c.status === 'REJECTED') { res.status(400).json({ success: false, message: 'Bağlanmış şikayət' }); return; }
    await prisma.complaint.update({ where: { id }, data: { status: 'EVIDENCE_REQUESTED', adminNote: note || undefined } });
    await prisma.notification.create({
      data: {
        userId: c.complainantId, type: 'SYSTEM',
        title: 'Şikayətiniz üçün əlavə sübut istənir',
        body: note ? `Admin: ${note}` : 'Zəhmət olmasa qüsurun foto/sübutlarını əlavə edin ki, araşdırma tamamlansın.',
        link: '/complaints',
      },
    }).catch(() => {});
    pushLive(c.complainantId, { kind: 'complaint', id, status: 'EVIDENCE_REQUESTED', toast: 'Şikayətiniz üçün əlavə sübut istənir', tone: 'info' });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Şikayəti həll et — geri ödəniş / peşəkarı dayandır / rədd və s.
router.post('/admin/complaints/:id/resolve', requirePermission('complaints'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const c = await prisma.complaint.findUnique({ where: { id }, include: { consultation: true } });
    if (!c) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }

    // SİFARİŞ/MƏHSUL ŞİKAYƏTİ — admin yalnız əsaslı olub-olmadığını qərarlaşdırır
    // (reytinqə təsir). Pul/mal qaytarılması iadə bölməsindədir.
    if (!c.consultationId && (c.orderId || c.listingId)) {
      const verdict = String(req.body.verdict || '');
      if (verdict !== 'UPHELD' && verdict !== 'UNFOUNDED') { res.status(400).json({ success: false, message: 'Qərar seçin: əsaslıdır və ya əsassızdır' }); return; }
      const note = String(req.body.adminNote || '').trim();
      if (note.length < 5) { res.status(400).json({ success: false, message: 'Qərarın səbəbini yazın — hər iki tərəf görəcək' }); return; }
      const upheld = verdict === 'UPHELD';
      const updated = await prisma.complaint.update({
        where: { id },
        data: { status: upheld ? 'RESOLVED' : 'REJECTED', resolution: verdict, adminNote: note, decisionReason: note, decisionBy: 'ADMIN', decidedAt: new Date(), resolvedAt: new Date(), resolvedById: req.adminId },
      });
      if (upheld) await prisma.user.update({ where: { id: c.targetUserId }, data: { complaintFlags: { increment: 1 } } }).catch(() => {});
      const txt = upheld ? `Admin şikayəti əsaslı saydı — satıcının etibarlılıq reytinqinə təsir edir. ${note}` : `Admin şikayəti əsassız saydı — reytinqə təsir etmir. ${note}`;
      await prisma.notification.createMany({ data: [
        { userId: c.complainantId, type: 'COMPLAINT', title: `Şikayət #${id} üzrə qərar`, body: txt, link: '/complaints' },
        { userId: c.targetUserId, type: 'COMPLAINT', title: `Sizin haqqınızda şikayət #${id} üzrə qərar`, body: txt, link: '/complaints?tab=against' },
      ] }).catch(() => {});
      pushLive([c.complainantId, c.targetUserId], { kind: 'complaint', id, status: updated.status });
      res.json({ success: true, complaint: updated });
      return;
    }

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
    pushLive(c.complainantId, { kind: 'complaint', id, status, toast: 'Şikayətiniz nəticələndi', tone: upheld ? 'success' : 'info' });
    // Qarşı tərəf: dayandırıldısa profili/təklifləri dərhal dəyişməlidir.
    pushLive(c.targetUserId, { kind: doSuspend ? 'consultation' : 'complaint', id });
    if (c.consultation) pushLive([c.complainantId, c.targetUserId], { kind: 'consultation', id: c.consultation.id });

    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
