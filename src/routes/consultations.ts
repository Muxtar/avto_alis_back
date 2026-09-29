import { Router, Response } from 'express';
import { PrismaClient, ConsultationSession } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { createPayment as createGatewayPayment } from '../services/paymentGateway';
import { Prisma } from '@prisma/client';
import {
  startPayment, settleOfferPayments, acceptOffer, rejectOffer, counterOffer, acceptCounter, rejectCounter, cancelOffer,
  OfferError, OPEN_STATES,
} from '../services/consultOffers';
import { phoneKeyOf, socialKeyOf } from '../services/pendingInvites';
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
    needsPrice: s.flow !== 'OFFER' && !s.offerId && !(s.price > 0), // nömrəyə göndərilmiş köhnə sorğu — qiyməti peşəkar yazır
    createdAt: s.createdAt, startedAt: s.startedAt, endedAt: s.endedAt,
    // Əvvəlcədən ödənilən təklif (OFFER)
    flow: s.flow, offerMessage: s.offerMessage, expiresAt: s.expiresAt, paidAmount: s.paidAmount,
    counterPrice: s.counterPrice, counterMinutes: s.counterMinutes, counterMessage: s.counterMessage, pendingTopUp: s.pendingTopUp,
    target: s.professionalId ? null : { name: s.targetName, url: s.targetUrl, avatar: s.targetAvatar, social: s.targetSocial, phone: s.targetPhoneKey ? true : false },
    locked: s.flow === 'OFFER' && (OPEN_STATES as readonly string[]).includes(s.status),
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
// ── TƏKLİF (əvvəl ödəniş, sonra qəbul) ────────────────────────────────────────
// Hədəf: { offerId, quantity } (peşəkarın paketi) | { professionalId } | { social: { platform, url, name, avatar } } | { phone }.
// Paketdə qiymət/müddət paketdən gəlir; digərlərində alıcı özü yazır: { price, minutes }. message — ilk mesaj.
async function createOffer(buyerId: number, b: any): Promise<ConsultationSession> {
  const bad = (m: string) => { throw new OfferError(m); };
  let proId: number | null = null;
  let price = 0, minutes = 0, blockMin = 0, title = 'Rəy konsultasiyası', offerId: number | null = null;
  const target: any = {};
  if (b.offerId !== undefined || (b.professionalId !== undefined && b.price === undefined)) {
    // Peşəkarın paketi (və ya köhnə çağırış: professionalId → ilk aktiv paket).
    const offer = b.offerId !== undefined
      ? await prisma.consultationOffer.findUnique({ where: { id: parseInt(String(b.offerId)) } })
      : await prisma.consultationOffer.findFirst({ where: { userId: parseInt(String(b.professionalId)), active: true }, orderBy: { createdAt: 'asc' } });
    if (!offer || !offer.active) bad('Bu təklif hazırda mövcud deyil');
    const qty = Math.max(1, Math.min(24, parseInt(String(b.quantity ?? 1)) || 1));
    proId = offer!.userId; offerId = offer!.id; title = offer!.title || title;
    price = Math.round(offer!.price * qty * 100) / 100; minutes = offer!.durationMinutes * qty; blockMin = offer!.durationMinutes;
  } else {
    price = Math.round((parseFloat(String(b.price)) || 0) * 100) / 100;
    minutes = parseInt(String(b.minutes)) || 0;
    blockMin = minutes;
    if (b.professionalId !== undefined) proId = parseInt(String(b.professionalId)) || null;
    else if (b.social) {
      const url = String(b.social.url || '').trim().slice(0, 500);
      const key = socialKeyOf(String(b.social.platform || ''), url);
      if (!key || !/^https:\/\//i.test(url)) bad('Bu link şəxsi sosial profil deyil');
      const [platform] = key!.split(':');
      const links = await prisma.socialLink.findMany({ where: { platform, verified: true }, select: { platform: true, url: true, userId: true } });
      proId = links.find((l) => socialKeyOf(l.platform, l.url) === key)?.userId ?? null;
      Object.assign(target, { targetSocial: key, targetUrl: url, targetName: String(b.social.name || '').trim().slice(0, 120) || key!.split(':')[1], targetAvatar: b.social.avatar ? String(b.social.avatar).slice(0, 500) : null });
    } else if (b.phone) {
      const key = phoneKeyOf(String(b.phone));
      if (key.length < 7) bad('Düzgün nömrə yazın');
      const rows = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`SELECT id FROM "User" WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = ${key} AND type != 'COURIER' LIMIT 1`);
      proId = rows[0]?.id ?? null;
      Object.assign(target, { targetPhoneKey: key, targetName: String(b.name || '').trim().slice(0, 120) || String(b.phone) });
    } else bad('Kimə təklif göndərdiyinizi seçin');
  }
  if (!(price >= 1 && price <= 100000)) bad('Qiymət 1–100000 AZN olmalıdır');
  if (!(minutes >= 5 && minutes <= 24 * 60)) bad('Müddət 5 dəqiqədən 24 saata qədər olmalıdır');
  const message = String(b.message || '').trim().slice(0, 2000);
  if (!offerId && message.length < 2) bad('Qarşı tərəfə ilk mesajınızı yazın');
  if (proId === buyerId) bad('Özünüzə təklif göndərə bilməzsiniz');
  if (target.targetSocial) {
    const mine = await prisma.socialLink.findMany({ where: { userId: buyerId }, select: { platform: true, url: true } });
    if (mine.some((l) => socialKeyOf(l.platform, l.url) === target.targetSocial)) bad('Bu sizin öz hesabınızdır');
  }
  if (proId) {
    const pro = await prisma.user.findUnique({ where: { id: proId }, select: { consultationSuspended: true, isBlocked: true } });
    if (!pro || pro.isBlocked) bad('Bu istifadəçi tapılmadı');
    if (pro!.consultationSuspended) bad('Bu peşəkar hazırda konsultasiya qəbul etmir');
    const blk = await prisma.blockedUser.findFirst({ where: { OR: [{ blockerId: proId, blockedId: buyerId }, { blockerId: buyerId, blockedId: proId }] } });
    if (blk) bad('Bu istifadəçi ilə əlaqə bloklanıb');
  }
  // Eyni hədəfə ikinci açıq (ödənilmiş, cavabsız) təklif olmasın; ümumi limit — spam qoruması.
  const tgt: any = proId ? { professionalId: proId } : target.targetSocial ? { targetSocial: target.targetSocial } : { targetPhoneKey: target.targetPhoneKey };
  const dup = await prisma.consultationSession.count({ where: { buyerId, flow: 'OFFER', status: { in: [...OPEN_STATES] }, paymentStatus: 'PAID', ...tgt } });
  if (dup) bad('Bu şəxsə artıq cavab gözləyən təklifiniz var');
  const open = await prisma.consultationSession.count({ where: { buyerId, flow: 'OFFER', status: { in: [...OPEN_STATES] }, paymentStatus: 'PAID' } });
  if (open >= 10) bad('Eyni anda ən çox 10 cavabsız təklif ola bilər');
  // Köhnə ödənilməmiş cəhdlər (ödəniş səhifəsi bağlanıb) — təmizlə.
  await prisma.consultationSession.updateMany({ where: { buyerId, flow: 'OFFER', status: 'OFFERED', paymentStatus: { in: ['UNPAID', 'FAILED'] }, ...tgt }, data: { status: 'CANCELLED' } });
  return prisma.consultationSession.create({
    data: {
      buyerId, professionalId: proId, offerId, flow: 'OFFER', title, price, offerMessage: message || null,
      blockSeconds: blockMin * 60, durationSeconds: minutes * 60, status: 'OFFERED', paymentStatus: 'UNPAID', ...target,
    },
  });
}

async function offerRoute(req: AuthRequest, res: Response) {
  try {
    const s = await createOffer(req.adminId!, req.body || {});
    let redirectUrl: string | null = null;
    try { redirectUrl = await startPayment(s, s.price, 'INITIAL'); }
    catch (e: any) { res.status(400).json({ success: false, message: `Ödəniş başlamadı: ${e?.message || 'xəta'}`, session: publicSession(s, req.adminId!) }); return; }
    res.json({ success: true, session: publicSession(s, req.adminId!), redirectUrl });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
}
router.post('/consultations/offer', consultationLimiter, adminAuth, offerRoute);
// Köhnə ad — saytdakı «Rəy al» (paket) da artıq eyni axınla: əvvəl ödəniş, sonra qəbul.
router.post('/consultations/request', consultationLimiter, adminAuth, offerRoute);

// Təklif əməliyyatları (OFFER axını). Xəta mesajları birbaşa istifadəçiyə göstərilir.
const offerAction = (fn: (id: number, userId: number, body: any) => Promise<any>) => async (req: AuthRequest, res: Response) => {
  try {
    const out = await fn(parseInt(String(req.params.id)), req.adminId!, req.body || {});
    const session = out?.session ?? out;
    res.json({ success: true, session: publicSession(session, req.adminId!), ...(out?.needsPayment ? { needsPayment: out.needsPayment } : {}) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message, code: e?.code }); }
};
router.post('/consultations/:id/counter', adminAuth, offerAction((id, uid, b) => counterOffer(id, uid, parseFloat(String(b.price)) || 0, parseInt(String(b.minutes)) || 0, String(b.message || '').trim())));
router.post('/consultations/:id/counter/accept', adminAuth, offerAction((id, uid) => acceptCounter(id, uid)));
router.post('/consultations/:id/counter/reject', adminAuth, offerAction((id, uid) => rejectCounter(id, uid)));
router.post('/consultations/:id/cancel', adminAuth, offerAction((id, uid) => cancelOffer(id, uid)));

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
    if (s.flow === 'OFFER') {
      try { const up = await acceptOffer(id, req.adminId!); res.json({ success: true, session: publicSession(up, req.adminId!) }); }
      catch (e: any) { res.status(400).json({ success: false, message: e.message, code: e?.code }); }
      return;
    }
    if (s.status !== 'REQUESTED') { res.status(400).json({ success: false, message: 'Yalnız yeni sorğunu qəbul etmək olar' }); return; }
    // Qeydiyyatdan əvvəl nömrəyə göndərilmiş sorğu (təklifsiz, qiymət 0) — qiyməti peşəkar indi yazır.
    const data: any = { status: 'ACCEPTED' };
    if (!s.offerId && !(s.price > 0)) {
      const price = Math.round((parseFloat(String(req.body?.price)) || 0) * 100) / 100;
      if (!(price >= 1 && price <= 100000)) { res.status(400).json({ success: false, message: 'Qəbul etmək üçün qiyməti yazın (AZN)' }); return; }
      const min = parseInt(String(req.body?.durationMinutes)) || Math.round(s.durationSeconds / 60);
      const sec = Math.max(5, Math.min(600, min)) * 60;
      Object.assign(data, { price, durationSeconds: sec, blockSeconds: sec });
    }
    const upd = await prisma.consultationSession.update({ where: { id }, data });
    await prisma.notification.create({ data: { userId: s.buyerId, type: 'CONSULTATION', title: 'Rəy sorğusu qəbul edildi ✓', body: `Peşəkar sorğunuzu qəbul etdi — ${upd.price} AZN ödəyib başlaya bilərsiniz.`, link: `/consultations/${id}` } }).catch(() => {});
    res.json({ success: true, session: publicSession(upd, req.adminId!), needsVoen: !(await hasApprovedBusiness(s.professionalId)) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Peşəkar sorğunu RƏDD edir → alıcıya bildiriş.
router.post('/consultations/:id/reject', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const s = await prisma.consultationSession.findUnique({ where: { id } });
    if (!s || s.professionalId !== req.adminId) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    if (s.flow === 'OFFER') {
      try { const up = await rejectOffer(id, req.adminId!); res.json({ success: true, session: publicSession(up, req.adminId!) }); }
      catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
      return;
    }
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
    if (s.flow === 'OFFER') {
      // Əvvəlcədən ödəniş: ilkin təklif / qarşı təklifin fərqi / bitmiş seansa vaxt artırma.
      const [amount, purpose] = s.status === 'OFFERED' && s.paymentStatus !== 'PAID' ? [s.price, 'INITIAL' as const]
        : s.status === 'COUNTERED' && (s.pendingTopUp || 0) > 0 ? [s.pendingTopUp!, 'TOPUP' as const]
        : s.status === 'ENDED' ? [s.price, 'EXTEND' as const]
        : [0, null];
      if (!purpose) { res.status(400).json({ success: false, message: 'Bu mərhələdə ödəniş lazım deyil' }); return; }
      const redirectUrl = await startPayment(s, amount, purpose);
      res.json({ success: true, redirectUrl });
      return;
    }
    if (!s.professionalId) { res.status(400).json({ success: false, message: 'Peşəkar hələ qoşulmayıb' }); return; }
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
    if (!['PAID', 'REFUND_PENDING'].includes(s.paymentStatus)) { res.status(400).json({ success: false, message: 'Ödəniş tamamlanmayıb' }); return; }
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
    if (!s.professionalId) { res.status(400).json({ success: false, message: 'Qiymətləndiriləcək peşəkar yoxdur' }); return; }
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
  // Əvvəlcədən ödənilən təkliflər (OFFER) — ödəniş cədvəli üzrə.
  await settleOfferPayments(where, paid);
  const sessions = await prisma.consultationSession.findMany({ where: { ...w, flow: { not: 'OFFER' } } });
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
          ...(s.professionalId ? [{ userId: s.professionalId, type: 'CONSULTATION', title: 'Konsultasiya bitdi', body: 'Seansın vaxtı tamamlandı.', link: `/consultations/${s.id}` }] : []),
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
