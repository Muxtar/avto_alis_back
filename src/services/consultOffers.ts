// ƏVVƏLCƏDƏN ÖDƏNİLƏN RƏY TƏKLİFİ (flow = OFFER).
//
// Axın:
//   1. Alıcı hədəfi seçir (saytdakı peşəkar, internetdə tapılan sosial profil və ya nömrə),
//      öz təklifini yazır: müddət + qiymət + ilk mesaj → ÖDƏYİR. Pul platformada saxlanır.
//   2. Chat açılır, ilk mesaj orada görünür, amma 🔒 — qarşı tərəf qəbul edənə qədər yazışma yoxdur.
//   3. Qarşı tərəf (hələ platformada deyilsə — qeydiyyatdan keçib sosial hesabını/nömrəsini
//      təsdiqləyəndən sonra) təklifi görür:
//        • QƏBUL → söhbət açılır, sayğac işləyir;
//        • QARŞI TƏKLİF (öz qiyməti/müddəti) → alıcı razılaşsa fərqi ödəyir (və ya artığı qaytarılır);
//        • RƏDD → pul tam qaytarılır.
//   4. 7 gün ərzində qəbul edilməsə (və ya şəxs heç qoşulmasa) — pul avtomatik qaytarılır.
//
// Pulu almaq (qəbul / qarşı təklif) üçün peşəkarın təsdiqlənmiş VÖEN-li biznesi olmalıdır.
import { PrismaClient, ConsultationSession, ConsultationPayment } from '@prisma/client';
import { hasVoenAccount } from './proAccount';
import { startClockData, CONSULT_IDLE_SECONDS } from './consultClock';

const IDLE_MIN = Math.round(CONSULT_IDLE_SECONDS / 60);
import { createPayment as createGatewayPayment, refundOrder } from './paymentGateway';
import { emitToUser } from './callSignaling';

const prisma = new PrismaClient();
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 5001}`;
// Yalnız testlər üçün: şlüzə getmədən ödəniş/qaytarma (heç vaxt prod-da qoyulmur).
const DRY = process.env.PAYMENT_DRYRUN === '1' && process.env.NODE_ENV !== 'production';

export const OFFER_TTL_DAYS = 7;
export const COUNTER_REPLY_HOURS = 72;
export const UNPAID_TTL_HOURS = 24;
export const OPEN_STATES = ['OFFERED', 'COUNTERED'] as const;
const CLOSED_STATES = ['CANCELLED', 'EXPIRED', 'REJECTED'];

const r2 = (n: number) => Math.round(n * 100) / 100;
const fmtMin = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60} saat` : `${m} dəq`);
export const offerLine = (minutes: number, price: number) => `${fmtMin(minutes)} / ${r2(price)} AZN`;

// Ad köhnədir: indi «VÖEN hesabı var» deməkdir — profildə (Rəy konsultasiyası
// bölməsində) yazılan VÖEN hesabı və ya admin təsdiqli VÖEN-li biznes.
export async function hasApprovedBusiness(userId: number | null | undefined): Promise<boolean> {
  return hasVoenAccount(userId);
}

function notify(userId: number | null | undefined, title: string, body: string, id: number) {
  if (!userId) return Promise.resolve();
  return prisma.notification.create({ data: { userId, type: 'CONSULTATION', title, body, link: `/consultations/${id}` } }).then(() => {}).catch(() => {});
}

/** Chat-a (Ödənişli söhbət) mesaj yaz və hər iki tərəfə canlı göndər. */
async function chatMsg(s: { id: number; buyerId: number; professionalId: number | null }, fromBuyer: boolean, content: string, createdAt?: Date) {
  if (!s.professionalId) return;
  const m = await prisma.message.create({
    data: {
      senderId: fromBuyer ? s.buyerId : s.professionalId, receiverId: fromBuyer ? s.professionalId : s.buyerId,
      consultationId: s.id, content, ...(createdAt ? { createdAt } : {}),
    },
  });
  emitToUser(s.buyerId, 'chat:message', m);
  emitToUser(s.professionalId, 'chat:message', m);
}

// ── ÖDƏNİŞ ─────────────────────────────────────────────────────────────────
export async function startPayment(s: ConsultationSession, amount: number, purpose: 'INITIAL' | 'TOPUP' | 'EXTEND'): Promise<string> {
  amount = r2(amount);
  const reference = `RZ${s.id}-${Date.now()}`;
  const pay = DRY
    ? { provider: 'dry', ref: reference, gatewayOrderId: null, password: null, redirectUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/return?status=success` }
    : await createGatewayPayment({ amount, reference, title: 'Rəy konsultasiyası', description: s.title || 'Konsultasiya', callbackBase: PUBLIC_BACKEND_URL, language: 'az' });
  await prisma.consultationPayment.create({
    data: { sessionId: s.id, amount, purpose, provider: pay.provider, ref: pay.ref, gatewayOrderId: pay.gatewayOrderId, gatewayPassword: pay.password },
  });
  // Callback axtarışı sessiya üzrə də işləsin (köhnə kod yolu) — son ödənişin referansı.
  await prisma.consultationSession.update({
    where: { id: s.id },
    data: { gatewayProvider: pay.provider, gatewayRef: pay.ref, gatewayOrderId: pay.gatewayOrderId, gatewayPassword: pay.password },
  });
  return pay.redirectUrl;
}

/** Şlüz ödənişi təsdiqlədi (və ya rədd etdi) — OFFER axınının ödənişləri. İdempotentdir. */
export async function settleOfferPayments(where: { gatewayOrderId?: number | null; gatewayRef?: string }, paid: boolean): Promise<number> {
  const w: any = where.gatewayRef ? { ref: where.gatewayRef } : where.gatewayOrderId != null ? { gatewayOrderId: where.gatewayOrderId } : null;
  if (!w) return 0;
  const payments = await prisma.consultationPayment.findMany({ where: w });
  for (const p of payments) {
    if (p.status === 'PAID') continue;
    if (!paid) { await prisma.consultationPayment.update({ where: { id: p.id }, data: { status: 'FAILED' } }); continue; }
    // Yarış: iki callback eyni anda — yalnız biri PENDING→PAID keçirə bilər.
    const claimed = await prisma.consultationPayment.updateMany({ where: { id: p.id, status: { not: 'PAID' } }, data: { status: 'PAID', paidAt: new Date() } });
    if (!claimed.count) continue;
    await applyPaid(p);
  }
  return payments.length;
}

async function applyPaid(p: ConsultationPayment) {
  const s = await prisma.consultationSession.findUnique({ where: { id: p.sessionId } });
  if (!s) return;
  await prisma.consultationSession.update({ where: { id: s.id }, data: { paidAmount: { increment: p.amount }, paymentStatus: 'PAID' } });
  // Gec gələn ödəniş — təklif artıq bağlanıb: dərhal qaytar.
  if (CLOSED_STATES.includes(s.status)) { await refundAmount(s.id, p.amount); return; }
  if (p.purpose === 'INITIAL' && s.status === 'OFFERED') {
    const expiresAt = new Date(Date.now() + OFFER_TTL_DAYS * 864e5);
    await prisma.consultationSession.update({ where: { id: s.id }, data: { expiresAt } });
    await publishOffer(s.id);
  } else if (p.purpose === 'TOPUP' && s.status === 'COUNTERED') {
    await prisma.consultationSession.update({ where: { id: s.id }, data: { pendingTopUp: null } });
    await applyCounter(s.id);
  } else if (p.purpose === 'EXTEND' && s.status === 'ENDED') {
    await prisma.consultationSession.update({ where: { id: s.id }, data: { status: 'PAID', durationSeconds: s.durationSeconds + s.blockSeconds, endedAt: null } });
    await notify(s.professionalId, 'Vaxt artırıldı', 'Alıcı konsultasiya vaxtını artırdı — başlada bilərsiniz.', s.id);
  }
}

/** Ödənilmiş təklif qarşı tərəfə görünür: chat-a ilk mesaj + bildiriş (hədəf məlumdursa). */
export async function publishOffer(id: number, at?: Date) {
  const s = await prisma.consultationSession.findUnique({ where: { id } });
  if (!s || !s.professionalId || s.paymentStatus !== 'PAID') return;
  const exists = await prisma.message.count({ where: { consultationId: s.id } });
  if (exists) return;
  const min = Math.round(s.durationSeconds / 60);
  await chatMsg(s, true, `🗣️ Ödənişli təklif: ${offerLine(min, s.price)}${s.offerMessage ? `\n\n${s.offerMessage}` : ''}`, at);
  await notify(s.professionalId, 'Sizə ödənişli təklif gəldi 💰', `${offerLine(min, s.price)} — ödəniş platformada saxlanılır. Qəbul edin, öz təklifinizi göndərin və ya rədd edin.`, s.id);
}

// ── QAYTARMA ────────────────────────────────────────────────────────────────
const transport = (e: any) => { const m = String(e?.message || '').toLowerCase(); return e instanceof TypeError || /fetch failed|timeout|timed out|econn|socket hang up|aborted|enotfound|eai_again|\((5\d\d)\)/.test(m); };

/** Məbləği ödənişlərdən (sondan başlayaraq) qaytar. Nə qədər qaytarıldığını qaytarır. */
export async function refundAmount(sessionId: number, amount: number): Promise<{ refunded: number; failed: boolean }> {
  let left = r2(amount);
  let refunded = 0, failed = false;
  if (left <= 0) return { refunded, failed };
  const pays = await prisma.consultationPayment.findMany({ where: { sessionId, status: 'PAID', needsReview: false }, orderBy: { id: 'desc' } });
  for (const p of pays) {
    if (left <= 0) break;
    const avail = r2(p.amount - p.refunded);
    if (avail <= 0) continue;
    const part = Math.min(avail, left);
    try {
      if (!DRY) await refundOrder({ gatewayProvider: p.provider, gatewayRef: p.ref, gatewayOrderId: p.gatewayOrderId, gatewayPassword: p.gatewayPassword }, part);
      await prisma.consultationPayment.update({ where: { id: p.id }, data: { refunded: { increment: part }, refundError: null } });
      refunded = r2(refunded + part); left = r2(left - part);
    } catch (e: any) {
      failed = true;
      // Cavabsız sorğu — pul çıxmış ola bilər: avtomatik təkrar yox, admin baxsın.
      await prisma.consultationPayment.update({ where: { id: p.id }, data: { refundError: String(e?.message || e).slice(0, 400), needsReview: transport(e) } });
      console.error(`[consultOffers] qaytarma alınmadı (ödəniş #${p.id}):`, e?.message);
    }
  }
  const s = refunded > 0
    ? await prisma.consultationSession.update({ where: { id: sessionId }, data: { paidAmount: { decrement: refunded } } })
    : await prisma.consultationSession.findUnique({ where: { id: sessionId } });
  if (s) {
    const paymentStatus = s.paidAmount <= 0.001 ? 'REFUNDED' : failed ? 'REFUND_PENDING' : 'PAID';
    await prisma.consultationSession.update({ where: { id: sessionId }, data: { paymentStatus, ...(paymentStatus === 'REFUNDED' ? { paidAmount: 0 } : {}) } });
  }
  return { refunded, failed };
}

/** Təklifi bağla və platformada saxlanan bütün pulu qaytar. */
async function closeWithRefund(id: number, status: 'CANCELLED' | 'EXPIRED' | 'REJECTED') {
  const s = await prisma.consultationSession.update({ where: { id }, data: { status, runningSince: null, pendingTopUp: null, endedAt: new Date() } });
  const r = s.paidAmount > 0 ? await refundAmount(id, s.paidAmount) : { refunded: 0, failed: false };
  return { session: s, ...r };
}

// ── TƏRƏFLƏRİN ƏMƏLİYYATLARI ────────────────────────────────────────────────
export class OfferError extends Error { constructor(msg: string, public code?: string) { super(msg); } }
const need = (ok: any, msg: string, code?: string) => { if (!ok) throw new OfferError(msg, code); };

async function load(id: number) {
  const s = await prisma.consultationSession.findUnique({ where: { id } });
  need(s && s.flow === 'OFFER', 'Təklif tapılmadı');
  return s!;
}

/** Peşəkar qəbul edir → söhbət açılır, sayğac işləyir. */
export async function acceptOffer(id: number, proId: number) {
  const s = await load(id);
  need(s.professionalId === proId, 'Tapılmadı');
  need(s.status === 'OFFERED' && s.paymentStatus === 'PAID', 'Bu təklif artıq qəbul edilə bilməz');
  need(await hasApprovedBusiness(proId), 'Ödənişi almaq üçün əvvəlcə VÖEN hesabınızı yazın (Profil → Rəy konsultasiyası). Təklif o vaxta qədər gözləyir.', 'NEEDS_VOEN');
  // Növbə / vaxt təyini yoxdur: qəbul edən kimi vaxt axmağa başlayır.
  const up = await prisma.consultationSession.update({ where: { id }, data: { ...startClockData(), startedAt: new Date() } });
  await chatMsg(up, false, '✅ Sorğu qəbul edildi — söhbət açıldı, vaxt başladı.');
  await notify(up.buyerId, 'Sorğunuz qəbul edildi ✓', `Daxil olun və rəy almağa başlayın. Vaxt yalnız qarşılıqlı yazışma zamanı işləyir — ${IDLE_MIN} dəqiqə yazılmasa özü dayanır.`, id);
  emitToUser(up.buyerId, 'live:update', { kind: 'consultation', id, status: 'ACTIVE', toast: 'Rəy sorğunuz qəbul edildi — daxil olun ✓', tone: 'success', at: Date.now() });
  return up;
}

/** Peşəkar rədd edir → pul tam qaytarılır. */
export async function rejectOffer(id: number, proId: number) {
  const s = await load(id);
  need(s.professionalId === proId, 'Tapılmadı');
  need((OPEN_STATES as readonly string[]).includes(s.status), 'Bu təklif artıq bağlanıb');
  const r = await closeWithRefund(id, 'REJECTED');
  await chatMsg(r.session, false, '✕ Təklif rədd edildi. Ödəniş alıcıya qaytarılır.');
  await notify(s.buyerId, 'Təklif rədd edildi', `${r.refunded} AZN kartınıza qaytarılır.`, id);
  return r.session;
}

/** Peşəkarın öz təklifi (qiymət/müddət). */
export async function counterOffer(id: number, proId: number, price: number, minutes: number, message: string) {
  const s = await load(id);
  need(s.professionalId === proId, 'Tapılmadı');
  need(s.status === 'OFFERED' && s.paymentStatus === 'PAID', 'Qarşı təklif yalnız cavabsız təklifə verilə bilər');
  price = r2(price); minutes = Math.round(minutes);
  need(price >= 1 && price <= 100000, 'Qiymət 1–100000 AZN olmalıdır');
  need(minutes >= 5 && minutes <= 600, 'Müddət 5–600 dəqiqə olmalıdır');
  need(await hasApprovedBusiness(proId), 'Ödənişi almaq üçün əvvəlcə VÖEN hesabınızı yazın (Profil → Rəy konsultasiyası).', 'NEEDS_VOEN');
  const replyBy = new Date(Date.now() + COUNTER_REPLY_HOURS * 3600e3);
  const up = await prisma.consultationSession.update({
    where: { id },
    data: {
      status: 'COUNTERED', counterPrice: price, counterMinutes: minutes, counterMessage: message.slice(0, 1000) || null, counterAt: new Date(),
      expiresAt: s.expiresAt && s.expiresAt > replyBy ? s.expiresAt : replyBy,
    },
  });
  await chatMsg(up, false, `💬 Qarşı təklif: ${offerLine(minutes, price)}${message ? `\n\n${message}` : ''}`);
  const diff = r2(price - s.paidAmount);
  await notify(s.buyerId, 'Qarşı təklif gəldi', `${offerLine(minutes, price)}${diff > 0 ? ` — razılaşsanız ${diff} AZN əlavə ödəyəcəksiniz` : diff < 0 ? ` — razılaşsanız ${-diff} AZN geri qaytarılacaq` : ''}.`, id);
  return up;
}

/** Qarşı təklif qəbul edildi (ödəniş tamamlanandan sonra) → yeni şərtlərlə söhbət açılır. */
async function applyCounter(id: number) {
  const s = await prisma.consultationSession.findUnique({ where: { id } });
  if (!s || s.status !== 'COUNTERED' || s.counterPrice == null || s.counterMinutes == null) return;
  const sec = s.counterMinutes * 60;
  const up = await prisma.consultationSession.update({
    where: { id },
    data: {
      price: s.counterPrice, durationSeconds: sec, blockSeconds: sec, ...startClockData(), startedAt: new Date(),
      counterPrice: null, counterMinutes: null, counterMessage: null, pendingTopUp: null,
    },
  });
  await chatMsg(up, true, `✅ Qarşı təklif qəbul edildi (${offerLine(s.counterMinutes, s.counterPrice)}) — söhbət açıldı.`);
  await notify(up.professionalId, 'Qarşı təklifiniz qəbul edildi ✓', `Söhbət açıldı, vaxt başladı. Vaxt yalnız qarşılıqlı yazışma zamanı işləyir (${IDLE_MIN} dəq yazılmasa dayanır).`, id);
}

/** Alıcı qarşı təklifə razıdır. Baha çıxıbsa fərqi ödəməlidir (needsPayment), ucuzdursa artıq qaytarılır. */
export async function acceptCounter(id: number, buyerId: number): Promise<{ needsPayment?: number; session: ConsultationSession }> {
  const s = await load(id);
  need(s.buyerId === buyerId, 'Tapılmadı');
  need(s.status === 'COUNTERED' && s.counterPrice != null, 'Qarşı təklif yoxdur');
  const diff = r2(s.counterPrice! - s.paidAmount);
  if (diff > 0) {
    const up = await prisma.consultationSession.update({ where: { id }, data: { pendingTopUp: diff } });
    return { needsPayment: diff, session: up };
  }
  if (diff < 0) await refundAmount(id, -diff);
  await applyCounter(id);
  return { session: (await prisma.consultationSession.findUnique({ where: { id } }))! };
}

/** Alıcı qarşı təklifi rədd edir → pul tam qaytarılır. */
export async function rejectCounter(id: number, buyerId: number) {
  const s = await load(id);
  need(s.buyerId === buyerId, 'Tapılmadı');
  need(s.status === 'COUNTERED', 'Qarşı təklif yoxdur');
  const r = await closeWithRefund(id, 'CANCELLED');
  await chatMsg(r.session, true, '✕ Qarşı təklif qəbul edilmədi. Ödəniş geri qaytarılır.');
  await notify(s.professionalId, 'Qarşı təklif rədd edildi', 'Alıcı qarşı təklifinizlə razılaşmadı.', id);
  return r.session;
}

/** Alıcı təklifi geri götürür (qəbul edilməzdən əvvəl) → pul tam qaytarılır. */
export async function cancelOffer(id: number, buyerId: number) {
  const s = await load(id);
  need(s.buyerId === buyerId, 'Tapılmadı');
  need((OPEN_STATES as readonly string[]).includes(s.status), 'Qəbul edilmiş təklifi geri götürmək olmaz');
  const r = await closeWithRefund(id, 'CANCELLED');
  if (s.paymentStatus === 'PAID') {
    await chatMsg(r.session, true, '✕ Təklif geri götürüldü.');
    await notify(s.professionalId, 'Təklif geri götürüldü', 'Alıcı təklifini geri götürdü.', id);
  }
  return r.session;
}

// ── QOŞULMA: hədəf qeydiyyatdan keçdi / sosial hesabını təsdiqlədi ──────────
export async function claimOffers(userId: number, keys: { phoneKey?: string | null; social: string[] }): Promise<number> {
  const or: any[] = [];
  if (keys.phoneKey && keys.phoneKey.length >= 7) or.push({ targetPhoneKey: keys.phoneKey });
  if (keys.social.length) or.push({ targetSocial: { in: keys.social } });
  if (!or.length) return 0;
  const list = await prisma.consultationSession.findMany({
    where: { flow: 'OFFER', professionalId: null, buyerId: { not: userId }, status: { in: [...OPEN_STATES] }, OR: or },
  });
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  for (const s of list) {
    const ok = await prisma.consultationSession.updateMany({ where: { id: s.id, professionalId: null }, data: { professionalId: userId } });
    if (!ok.count) continue;
    const first = await prisma.consultationPayment.findFirst({ where: { sessionId: s.id, status: 'PAID', purpose: 'INITIAL' }, orderBy: { id: 'asc' } });
    await publishOffer(s.id, first?.paidAt || s.createdAt);
    await notify(s.buyerId, `${me?.name || 'Hədəf'} platformaya qoşuldu`, 'Ödənişli təklifiniz ona çatdırıldı — cavabını gözləyin.', s.id);
  }
  return list.length;
}

// ── MÜDDƏT: cavabsız təkliflər (hər 10 dəqiqə — services/orderExpiry) ───────
export async function expireOffers(): Promise<number> {
  const now = new Date();
  let n = 0;
  const due = await prisma.consultationSession.findMany({ where: { flow: 'OFFER', status: { in: [...OPEN_STATES] }, paymentStatus: 'PAID', expiresAt: { lt: now } } });
  for (const s of due) {
    const r = await closeWithRefund(s.id, 'EXPIRED');
    n++;
    await notify(s.buyerId, 'Təklifin müddəti bitdi', `${s.status === 'COUNTERED' ? 'Qarşı təklifə vaxtında cavab verilmədi' : 'Qarşı tərəf 7 gün ərzində cavab vermədi'} — ${r.refunded} AZN kartınıza qaytarılır.`, s.id);
    if (s.professionalId) {
      await chatMsg(r.session, true, '⌛ Təklifin müddəti bitdi — ödəniş alıcıya qaytarıldı.');
      await notify(s.professionalId, 'Təklifin müddəti bitdi', 'Cavab verilmədiyi üçün təklif bağlandı.', s.id);
    }
  }
  // Ödənilməmiş (yarımçıq qalmış) təkliflər — sakitcə bağlanır.
  await prisma.consultationSession.updateMany({
    where: { flow: 'OFFER', status: 'OFFERED', paymentStatus: { in: ['UNPAID', 'FAILED'] }, createdAt: { lt: new Date(Date.now() - UNPAID_TTL_HOURS * 3600e3) } },
    data: { status: 'CANCELLED' },
  });
  // Uğursuz (amma təhlükəsiz təkrarlana bilən) qaytarmaları yenidən yoxla.
  const stuck = await prisma.consultationSession.findMany({ where: { flow: 'OFFER', paymentStatus: 'REFUND_PENDING' }, select: { id: true, status: true, paidAmount: true, price: true } });
  for (const s of stuck) {
    const owed = CLOSED_STATES.includes(s.status) ? s.paidAmount : r2(s.paidAmount - s.price);
    if (owed > 0) await refundAmount(s.id, owed);
  }
  if (n) console.log(`[consultOffers] müddəti bitən ${n} təklif bağlandı, pul qaytarıldı`);
  return n;
}
