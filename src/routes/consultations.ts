import { Router, Response } from 'express';
import { PrismaClient, ConsultationSession } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { createPayment as createGatewayPayment } from '../services/paymentGateway';
import { consultationLimiter } from '../middleware/rateLimiter';

const router = Router();
const prisma = new PrismaClient();
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 5001}`;

// Qalan saniyə — ACTIVE olduqda runningSince-dən keçən vaxt da çıxılır.
function remainingSeconds(s: ConsultationSession): number {
  let used = s.consumedSeconds;
  if (s.status === 'ACTIVE' && s.runningSince) {
    used += Math.floor((Date.now() - new Date(s.runningSince).getTime()) / 1000);
  }
  return Math.max(0, s.durationSeconds - used);
}

// Oxunarkən vaxtı bitmiş ACTIVE seansı avtomatik ENDED et.
async function refreshSession(s: ConsultationSession): Promise<ConsultationSession> {
  if (s.status === 'ACTIVE' && remainingSeconds(s) <= 0) {
    return prisma.consultationSession.update({
      where: { id: s.id },
      data: { status: 'ENDED', consumedSeconds: s.durationSeconds, runningSince: null, endedAt: new Date() },
    });
  }
  return s;
}

function publicSession(s: ConsultationSession, meId: number) {
  return {
    id: s.id, buyerId: s.buyerId, professionalId: s.professionalId,
    title: s.title, price: s.price, status: s.status, paymentStatus: s.paymentStatus,
    durationSeconds: s.durationSeconds, consumedSeconds: s.consumedSeconds,
    blockSeconds: s.blockSeconds, remainingSeconds: remainingSeconds(s),
    running: s.status === 'ACTIVE', role: s.professionalId === meId ? 'professional' : 'buyer',
    rated: s.rated, ratingStars: s.ratingStars, ratingLike: s.ratingLike,
    createdAt: s.createdAt, startedAt: s.startedAt, endedAt: s.endedAt,
  };
}

// Peşəkarın təsdiqlənmiş (VÖEN) aktiv biznesi varmı?
async function hasApprovedBusiness(userId: number): Promise<boolean> {
  const b = await prisma.business.findFirst({ where: { userId, status: 'APPROVED', isActive: true }, select: { id: true } });
  return !!b;
}

// ── Peşəkarın "Rəy" təklifləri (çoxlu) ────────────────────────────────────────
function offerFromBody(b: any) {
  return {
    title: b.title ? String(b.title).trim() : null,
    description: b.description ? String(b.description).trim().slice(0, 1000) : null,
    durationMinutes: Math.max(1, Math.min(600, parseInt(String(b.durationMinutes)) || 30)),
    price: Math.max(0, parseFloat(String(b.price)) || 0),
    active: b.active === undefined ? true : !!b.active,
  };
}

router.get('/me/consultation-offers', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const offers = await prisma.consultationOffer.findMany({ where: { userId: req.adminId! }, orderBy: { createdAt: 'asc' } });
    const voen = await hasApprovedBusiness(req.adminId!);
    res.json({ success: true, offers, hasVoen: voen });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.post('/me/consultation-offers', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const offer = await prisma.consultationOffer.create({ data: { userId: req.adminId!, ...offerFromBody(req.body) } });
    res.json({ success: true, offer });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.put('/me/consultation-offers/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const own = await prisma.consultationOffer.findUnique({ where: { id }, select: { userId: true } });
    if (!own || own.userId !== req.adminId) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    const offer = await prisma.consultationOffer.update({ where: { id }, data: offerFromBody(req.body) });
    res.json({ success: true, offer });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.delete('/me/consultation-offers/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const own = await prisma.consultationOffer.findUnique({ where: { id }, select: { userId: true } });
    if (!own || own.userId !== req.adminId) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    await prisma.consultationOffer.delete({ where: { id } });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Sorğu (alıcı) ─────────────────────────────────────────────────────────────
router.post('/consultations/request', consultationLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    // offerId ilə konkret paket seçilir (professionalId ondan götürülür).
    const offerId = req.body.offerId !== undefined ? parseInt(String(req.body.offerId)) : NaN;
    let offer = null;
    if (!Number.isNaN(offerId)) {
      offer = await prisma.consultationOffer.findUnique({ where: { id: offerId } });
    } else if (req.body.professionalId !== undefined) {
      // Geriyə uyğunluq: professionalId verilərsə onun ilk aktiv təklifini götür.
      const pid = parseInt(String(req.body.professionalId));
      offer = await prisma.consultationOffer.findFirst({ where: { userId: pid, active: true }, orderBy: { createdAt: 'asc' } });
    }
    if (!offer || !offer.active) { res.status(400).json({ success: false, message: 'Bu təklif hazırda mövcud deyil' }); return; }
    const professionalId = offer.userId;
    if (professionalId === req.adminId) { res.status(400).json({ success: false, message: 'Özünüzə sorğu göndərə bilməzsiniz' }); return; }
    const pro = await prisma.user.findUnique({ where: { id: professionalId }, select: { consultationSuspended: true } });
    if (pro?.consultationSuspended) { res.status(400).json({ success: false, message: 'Bu peşəkar hazırda konsultasiya qəbul etmir' }); return; }

    // Alıcı NEÇƏ BLOK almaq istədiyini seçir. Məs. təklif "1 saat / 100 AZN"
    // olsa, qty=2 → 2 saat / 200 AZN. Blok ölçüsü təklifdə sabitdir; alıcı
    // yalnız sayı seçir. 1–24 arası (bir gündən çox seans mənasızdır).
    const qty = Math.max(1, Math.min(24, parseInt(String(req.body?.quantity ?? 1)) || 1));
    const voen = await hasApprovedBusiness(professionalId);
    const block = offer.durationMinutes * 60;
    const totalSeconds = block * qty;
    const totalPrice = Math.round(offer.price * qty * 100) / 100;
    const session = await prisma.consultationSession.create({
      data: {
        buyerId: req.adminId!, professionalId, offerId: offer.id,
        title: offer.title || 'Rəy konsultasiyası', price: totalPrice,
        // blockSeconds — sonradan vaxt artırmaq (top-up) üçün bir blokun ölçüsü.
        blockSeconds: block, durationSeconds: totalSeconds,
        status: voen ? 'REQUESTED' : 'PENDING_VOEN',
      },
    });
    // Mesaj bölməsində görünməsi üçün ilk mesaj (ayrı icon ilə göstəriləcək).
    const totalMin = offer.durationMinutes * qty;
    await prisma.message.create({
      data: {
        senderId: req.adminId!, receiverId: professionalId, consultationId: session.id,
        content: `🗣️ Rəy konsultasiyası sorğusu — ${totalMin} dəq / ${totalPrice} AZN`
               + (qty > 1 ? ` (${qty} × ${offer.durationMinutes} dəq)` : ''),
      },
    });
    // Bildiriş
    await prisma.notification.create({
      data: { userId: professionalId, type: 'CONSULTATION', title: 'Yeni Rəy sorğusu', body: `Sizə yeni konsultasiya sorğusu gəldi`, link: '/consultations' },
    }).catch(() => {});
    res.json({ success: true, session: publicSession(session, req.adminId!), needsVoen: !voen });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Mənim seanslarım (alıcı + peşəkar).
router.get('/me/consultations', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const raw = await prisma.consultationSession.findMany({
      where: { OR: [{ buyerId: req.adminId! }, { professionalId: req.adminId! }] },
      orderBy: { createdAt: 'desc' },
      include: {
        buyer: { select: { id: true, name: true, avatar: true } },
        professional: { select: { id: true, name: true, avatar: true } },
      },
    });
    const sessions = [];
    for (const s of raw) {
      const fresh = await refreshSession(s);
      sessions.push({ ...publicSession(fresh, req.adminId!), buyer: s.buyer, professional: s.professional });
    }
    res.json({ success: true, sessions });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Tək seans.
router.get('/consultations/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const s0 = await prisma.consultationSession.findUnique({ where: { id } });
    if (!s0 || (s0.buyerId !== req.adminId && s0.professionalId !== req.adminId)) {
      res.status(404).json({ success: false, message: 'Tapılmadı' }); return;
    }
    const s = await refreshSession(s0);
    res.json({ success: true, session: publicSession(s, req.adminId!) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Seansın mesajları.
router.get('/consultations/:id/messages', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const s = await prisma.consultationSession.findUnique({ where: { id } });
    if (!s || (s.buyerId !== req.adminId && s.professionalId !== req.adminId)) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    const messages = await prisma.message.findMany({
      where: { consultationId: id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, senderId: true, receiverId: true, content: true, createdAt: true },
    });
    res.json({ success: true, messages });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Peşəkar sorğunu QƏBUL edir → alıcıya bildiriş, alıcı ödəyə bilər.
router.post('/consultations/:id/accept', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const s = await prisma.consultationSession.findUnique({ where: { id } });
    if (!s || s.professionalId !== req.adminId) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    if (s.status !== 'REQUESTED') { res.status(400).json({ success: false, message: 'Yalnız yeni sorğunu qəbul etmək olar' }); return; }
    const upd = await prisma.consultationSession.update({ where: { id }, data: { status: 'ACCEPTED' } });
    await prisma.notification.create({ data: { userId: s.buyerId, type: 'CONSULTATION', title: 'Rəy sorğusu qəbul edildi ✓', body: `Peşəkar sorğunuzu qəbul etdi — ${s.price} AZN ödəyib başlaya bilərsiniz.`, link: `/consultations/${id}` } }).catch(() => {});
    res.json({ success: true, session: publicSession(upd, req.adminId!) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Peşəkar sorğunu RƏDD edir → alıcıya bildiriş.
router.post('/consultations/:id/reject', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const s = await prisma.consultationSession.findUnique({ where: { id } });
    if (!s || s.professionalId !== req.adminId) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    if (s.status !== 'REQUESTED') { res.status(400).json({ success: false, message: 'Yalnız yeni sorğunu rədd etmək olar' }); return; }
    const upd = await prisma.consultationSession.update({ where: { id }, data: { status: 'REJECTED' } });
    await prisma.notification.create({ data: { userId: s.buyerId, type: 'CONSULTATION', title: 'Rəy sorğusu rədd edildi', body: 'Peşəkar sorğunuzu qəbul etmədi.', link: `/consultations/${id}` } }).catch(() => {});
    res.json({ success: true, session: publicSession(upd, req.adminId!) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Ödəniş başlat (alıcı) — seansı aktiv etmək üçün.
router.post('/consultations/:id/pay', consultationLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const s = await prisma.consultationSession.findUnique({ where: { id } });
    if (!s || s.buyerId !== req.adminId) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    const voen = await hasApprovedBusiness(s.professionalId);
    if (!voen) { res.status(400).json({ success: false, message: 'Peşəkar hələ VÖEN əlavə etməyib — ödəniş aktivləşə bilməz' }); return; }
    if (s.status === 'ACTIVE') { res.status(400).json({ success: false, message: 'Seans artıq aktivdir' }); return; }
    // Ödəniş yalnız peşəkar sorğunu QƏBUL edəndən sonra (ACCEPTED) və ya vaxt artırmada (ENDED).
    if (!['ACCEPTED', 'ENDED'].includes(s.status)) {
      res.status(400).json({ success: false, message: s.status === 'REQUESTED' ? 'Peşəkar hələ sorğunu qəbul etməyib' : 'Bu mərhələdə ödəniş mümkün deyil' });
      return;
    }

    const reference = `RZ${s.id}-${Date.now()}`;
    const pay = await createGatewayPayment({
      amount: s.price, reference,
      title: 'Rəy konsultasiyası', description: s.title || 'Konsultasiya',
      callbackBase: PUBLIC_BACKEND_URL, language: 'az',
    });
    await prisma.consultationSession.update({
      where: { id: s.id },
      data: { gatewayProvider: pay.provider, gatewayRef: pay.ref, gatewayOrderId: pay.gatewayOrderId, gatewayPassword: pay.password },
    });
    res.json({ success: true, redirectUrl: pay.redirectUrl });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Başlat / Davam et (peşəkar) — sayğacı işə salır.
router.post('/consultations/:id/start', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const s0 = await prisma.consultationSession.findUnique({ where: { id } });
    if (!s0 || s0.professionalId !== req.adminId) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    const s = await refreshSession(s0);
    if (s.paymentStatus !== 'PAID') { res.status(400).json({ success: false, message: 'Ödəniş tamamlanmayıb' }); return; }
    if (s.status === 'ENDED' || remainingSeconds(s) <= 0) { res.status(400).json({ success: false, message: 'Vaxt bitib — alıcı yenidən ödəməlidir' }); return; }
    if (s.status === 'ACTIVE') { res.json({ success: true, session: publicSession(s, req.adminId!) }); return; }
    const updated = await prisma.consultationSession.update({
      where: { id }, data: { status: 'ACTIVE', runningSince: new Date(), startedAt: s.startedAt || new Date() },
    });
    res.json({ success: true, session: publicSession(updated, req.adminId!) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Dayandır / Pauza (peşəkar) — sayğacı saxlayır, vaxt qorunur.
router.post('/consultations/:id/pause', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const s = await prisma.consultationSession.findUnique({ where: { id } });
    if (!s || s.professionalId !== req.adminId) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    if (s.status !== 'ACTIVE') { res.json({ success: true, session: publicSession(s, req.adminId!) }); return; }
    const elapsed = s.runningSince ? Math.floor((Date.now() - new Date(s.runningSince).getTime()) / 1000) : 0;
    const consumed = Math.min(s.durationSeconds, s.consumedSeconds + elapsed);
    const ended = consumed >= s.durationSeconds;
    const updated = await prisma.consultationSession.update({
      where: { id },
      data: { consumedSeconds: consumed, runningSince: null, status: ended ? 'ENDED' : 'PAUSED', endedAt: ended ? new Date() : null },
    });
    res.json({ success: true, session: publicSession(updated, req.adminId!) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Seansı bitir (hər iki tərəf).
router.post('/consultations/:id/end', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const s = await prisma.consultationSession.findUnique({ where: { id } });
    if (!s || (s.buyerId !== req.adminId && s.professionalId !== req.adminId)) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    const elapsed = s.status === 'ACTIVE' && s.runningSince ? Math.floor((Date.now() - new Date(s.runningSince).getTime()) / 1000) : 0;
    const updated = await prisma.consultationSession.update({
      where: { id },
      data: { status: 'ENDED', consumedSeconds: Math.min(s.durationSeconds, s.consumedSeconds + elapsed), runningSince: null, endedAt: new Date() },
    });
    res.json({ success: true, session: publicSession(updated, req.adminId!) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Qiymətləndirmə (alıcı) — 5 ulduz + like/dislike + mətn. Peşəkarın reytinqini yeniləyir.
router.post('/consultations/:id/rate', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const s = await prisma.consultationSession.findUnique({ where: { id } });
    if (!s || s.buyerId !== req.adminId) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    if (s.rated) { res.status(400).json({ success: false, message: 'Artıq qiymətləndirilib' }); return; }
    const stars = Math.max(1, Math.min(5, parseInt(String(req.body.stars)) || 0));
    const like = req.body.like === undefined ? null : !!req.body.like;
    const text = req.body.text ? String(req.body.text).trim().slice(0, 1000) : null;
    await prisma.consultationSession.update({ where: { id }, data: { rated: true, ratingStars: stars, ratingLike: like, ratingText: text } });
    // Peşəkarın ortalama reytinqini yenilə.
    const pro = await prisma.user.findUnique({ where: { id: s.professionalId }, select: { avgRating: true, ratingCount: true } });
    const cnt = (pro?.ratingCount || 0) + 1;
    const avg = (((pro?.avgRating || 0) * (pro?.ratingCount || 0)) + stars) / cnt;
    await prisma.user.update({ where: { id: s.professionalId }, data: { avgRating: avg, ratingCount: cnt } });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;

// Ödəniş callback-i tərəfindən çağırılır — seansı PAID et (və ENDED idisə yeni blok ver).
export async function settleConsultation(where: { gatewayOrderId?: number | null; gatewayRef?: string }, paid: boolean): Promise<void> {
  const w: any = {};
  if (where.gatewayOrderId != null) w.gatewayOrderId = where.gatewayOrderId;
  if (where.gatewayRef) w.gatewayRef = where.gatewayRef;
  if (Object.keys(w).length === 0) return;
  // Bu ödənişin unikal referansı — callback təkrarlarına qarşı idempotentlik açarı.
  const ref = where.gatewayRef ? `r:${where.gatewayRef}` : `k:${where.gatewayOrderId}`;
  const sessions = await prisma.consultationSession.findMany({ where: w });
  for (const s of sessions) {
    if (!paid) { await prisma.consultationSession.update({ where: { id: s.id }, data: { paymentStatus: 'FAILED' } }); continue; }
    // Bu referans artıq tətbiq olunubsa — heç nə etmə (top-up ikiqat blok əlavə etməsin).
    if (s.settledRefs.includes(ref)) continue;
    if (s.paymentStatus === 'PAID' && s.status !== 'ENDED') {
      // İlkin ödənişin təkrar callback-i — yalnız referansı qeyd et, blok əlavə etmə.
      await prisma.consultationSession.update({ where: { id: s.id }, data: { settledRefs: { push: ref } } });
      continue;
    }
    // ENDED idisə top-up: yeni blok əlavə et və PAID-ə qaytar (reaktivasiya).
    const addBlock = s.status === 'ENDED' ? s.blockSeconds : 0;
    await prisma.consultationSession.update({
      where: { id: s.id },
      data: {
        paymentStatus: 'PAID',
        status: 'PAID',
        durationSeconds: s.durationSeconds + addBlock,
        endedAt: null,
        settledRefs: { push: ref },
      },
    });
  }
}

/**
 * VAXTI BİTMİŞ SEANSLARI AVTOMATİK BAĞLA.
 *
 * Problem: vaxt bitəndə mesaj göndərmək onsuz da bloklanırdı, amma seansın
 * STATUSU ACTIVE qalırdı. Nəticədə:
 *   • alıcı rəy verə bilmirdi (rəy forması yalnız ENDED-də açılır)
 *   • şikayət düyməsi çıxmırdı
 *   • seans "işləyir" kimi görünürdü
 * Heç kim "Bitir" düyməsinə basmasa seans əbədi asılı qalırdı.
 *
 * Bu funksiya vaxtı dolmuş ACTIVE seansları tapıb ENDED edir və hər iki
 * tərəfə bildiriş göndərir.
 */
export async function endExpiredConsultations(): Promise<number> {
  try {
    const active = await prisma.consultationSession.findMany({
      where: { status: 'ACTIVE', runningSince: { not: null } },
      select: { id: true, buyerId: true, professionalId: true, durationSeconds: true, consumedSeconds: true, runningSince: true },
    });
    let closed = 0;
    for (const s of active) {
      const elapsed = Math.floor((Date.now() - new Date(s.runningSince!).getTime()) / 1000);
      if (s.consumedSeconds + elapsed < s.durationSeconds) continue;   // vaxt hələ var
      await prisma.consultationSession.update({
        where: { id: s.id },
        data: { status: 'ENDED', consumedSeconds: s.durationSeconds, runningSince: null, endedAt: new Date() },
      });
      closed++;
      // Hər iki tərəfə bildiriş — alıcı rəy/şikayət üçün geri dönsün.
      await prisma.notification.createMany({
        data: [
          { userId: s.buyerId, type: 'CONSULTATION', title: 'Konsultasiya bitdi', body: 'Vaxt tamamlandı. Rəy bildirə və ya şikayət edə bilərsiniz.', link: `/consultations/${s.id}` },
          { userId: s.professionalId, type: 'CONSULTATION', title: 'Konsultasiya bitdi', body: 'Seansın vaxtı tamamlandı.', link: `/consultations/${s.id}` },
        ],
      }).catch(() => {});
    }
    if (closed > 0) console.log(`[consultations] vaxtı bitən ${closed} seans bağlandı`);
    return closed;
  } catch (e) {
    console.error('[consultations] endExpiredConsultations xəta:', (e as any)?.message);
    return 0;
  }
}
