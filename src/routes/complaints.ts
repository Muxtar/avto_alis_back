import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, requirePermission, AuthRequest } from '../middleware/auth';
import { complaintLimiter } from '../middleware/rateLimiter';
import { refundOrder } from '../services/paymentGateway';
import { upload } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';
import { pushLive, pushAdmins } from '../services/live';
import { openDispute, respondToDispute, appealDispute, applyDecision, decideDispute } from '../services/disputeDecision';

const router = Router();
const prisma = new PrismaClient();

// Şikayət növləri — şəxs/seans (əvvəlki) + eBay üslubu məhsul qüsuru növləri.
const CATEGORIES = [
  'TIME_WASTED', 'FRAUD', 'RUDE', 'FAKE_INFO', 'OTHER',
  'DEFECTIVE', 'DAMAGED', 'NOT_AS_DESCRIBED', 'WRONG_ITEM',
];
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

    // MƏHSUL / SİFARİŞ ŞİKAYƏTİ → MÜBAHİSƏ: satıcıya cavab müddəti verilir,
    // sonra SİSTEM qərar verir (services/disputeDecision). Əvvəl belə şikayət
    // yalnız admin siyahısına düşürdü — satıcı xəbər tutmur, qərar gecikirdi.
    if (!consultationId && (orderId || listingId)) {
      let oid = orderId;
      // Elandan şikayət edən bu məhsulu ALIBSA — sifarişə bağla (pul qaytarıla bilsin).
      if (!oid && listingId) {
        const bought = await prisma.order.findFirst({
          where: { buyerId: req.adminId!, status: 'DELIVERED', items: { some: { listingId } } },
          orderBy: { createdAt: 'desc' }, select: { id: true },
        });
        oid = bought?.id ?? null;
      }
      // Mübahisə yalnız ÇATDIRILMIŞ və yaxın vaxtda (30 gün) alınmış sifariş üçün:
      // çatdırılmamış sifarişdə «məhsulu geri göndər» mənasızdır (onu sifariş
      // müddətləri avtomatik ləğv/iadə edir), köhnə sifarişə isə admin baxır.
      if (oid) {
        const o = await prisma.order.findUnique({ where: { id: oid }, select: { status: true, deliveredAt: true } });
        const recent = o?.deliveredAt && Date.now() - o.deliveredAt.getTime() <= 30 * 24 * 3600 * 1000;
        if (!o || o.status !== 'DELIVERED' || !recent) {
          const complaint = await prisma.complaint.create({
            data: { complainantId: req.adminId!, targetUserId, orderId: oid, listingId, category, description, images },
          });
          pushAdmins('complaint', { id: complaint.id, toast: 'Yeni şikayət' });
          res.json({ success: true, complaint });
          return;
        }
      }
      if (oid) {
        const open = await prisma.complaint.findFirst({
          where: { complainantId: req.adminId!, orderId: oid, status: { in: ['OPEN', 'AWAITING_SELLER', 'REVIEWING', 'EVIDENCE_REQUESTED'] } },
          select: { id: true },
        });
        if (open) { res.status(400).json({ success: false, message: `Bu sifariş üzrə açıq şikayətiniz var (#${open.id})` }); return; }
        const activeReturn = await prisma.returnRequest.findFirst({
          where: { orderId: oid, status: { in: ['REQUESTED', 'APPROVED', 'RETURN_SHIPPED', 'RETURN_RECEIVED', 'DISPUTED'] } },
          select: { id: true },
        });
        if (activeReturn) {
          res.status(400).json({ success: false, message: `Bu sifariş üzrə iadə davam edir (#${activeReturn.id}) — onu «İadələr» səhifəsindən izləyin` }); return;
        }
      }
      const complaint = await openDispute({
        complainantId: req.adminId!, targetUserId, orderId: oid, listingId, category, description, images, actor: 'BUYER',
      });
      res.json({ success: true, complaint });
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

// Qarşı tərəfin (satıcının) cavabı: iddianı qəbul et və ya izah + foto ilə etiraz et.
router.post('/complaints/:id/respond', complaintLimiter, adminAuth, upload.array('images', MAX_EVIDENCE), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const accept = String(req.body?.accept) === 'true';
    const response = String(req.body?.response || '').trim();
    if (!accept && response.length < 10) { res.status(400).json({ success: false, message: 'Mövqeyinizi ətraflı izah edin (ən azı 10 simvol)' }); return; }
    const images = ((req.files as Express.Multer.File[] | undefined) || []).map((f) => f.filename);
    const complaint = await respondToDispute(id, req.adminId!, { accept, response: response || 'İddianı qəbul edirəm.', images });
    res.json({ success: true, complaint });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Uduzan tərəf qərardan bir dəfə adminə müraciət edir.
router.post('/complaints/:id/appeal', complaintLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const note = String(req.body?.note || '').trim();
    if (note.length < 10) { res.status(400).json({ success: false, message: 'Müraciətin səbəbini yazın (ən azı 10 simvol)' }); return; }
    const complaint = await appealDispute(parseInt(String(req.params.id)), req.adminId!, note);
    res.json({ success: true, complaint });
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

    // MÜBAHİSƏ (sifariş/məhsul) — admin qərarı sistemin EYNİ tətbiq funksiyası ilə:
    // iadə təsdiqi / pulun qaytarılması / rədd + hər iki tərəfə izahlı bildiriş.
    if (!c.consultationId && (c.orderId || c.listingId)) {
      const decision = String(req.body.decision || '');
      if (decision === 'RERUN') { const r = await decideDispute(id); res.json({ success: true, complaint: r }); return; }
      if (decision !== 'COMPLAINANT' && decision !== 'RESPONDENT') {
        res.status(400).json({ success: false, message: 'Qərar seçin: şikayətçinin və ya qarşı tərəfin xeyrinə' }); return;
      }
      const reason = String(req.body.adminNote || '').trim();
      if (reason.length < 5) { res.status(400).json({ success: false, message: 'Qərarın səbəbini yazın — hər iki tərəf görəcək' }); return; }
      const pct = req.body.refundPercent !== undefined ? Math.max(0, Math.min(100, Number(req.body.refundPercent))) : undefined;
      const r = await applyDecision(id, decision, 'ADMIN', reason, { adminId: req.adminId!, refundPercent: pct });
      await prisma.complaint.update({ where: { id }, data: { adminNote: reason } });
      res.json({ success: true, complaint: r });
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
