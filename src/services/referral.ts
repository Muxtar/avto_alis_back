// REFERAL SATIŞ — «kimlər mənim yerimə sata bilər».
//
// Proqram (ReferralProgram) bir MAĞAZAYA (objectId) və ya FƏRDİ satıcıya
// (objectId = null) aiddir. Satıcı seçir:
//   • kim sata bilər (audience): ALL — hamı · PROFESSION — ixtisas qaydalarına
//     görə (ReferralRule, sənəd tələbi ilə) · INVITED — yalnız dəvət/təsdiq etdiyi
//     şəxslər (ReferralPartner). ACTIVE partnyor HƏR rejimdə sata bilir, REVOKED
//     heç birində.
//   • hansı məhsullar (productScope): ALL (OFF işarələnənlərdən başqa) və ya
//     SELECTED (yalnız ON işarələnənlər) — Listing.referralMode.
//   • faiz: partnyora xüsusi → məhsula xüsusi → ixtisas qaydası → proqramın default faizi.
//
// Referal satıcı link (ReferralCart) yaradır; alıcı linkdən məhsulları ADİ
// SƏBƏTƏ atır (CartItem.referralCartId), ödəniş/çatdırılma adi checkout-dan
// keçir. Sifarişdə link, proqram, məhsul və şəxs YENİDƏN yoxlanır — dayandırılmış
// link/proqram komissiya yaratmır.
//
// Pul: komissiya satıcının qazancından çıxılır (SellerLedger.referralAmount),
// referal satıcıya ReferralLedger yazılır — çatdırılandan sonra qaytarma
// müddəti bitəndə ödənilə bilən olur, admin ReferralPayout ilə ödəyir.
import { PrismaClient } from '@prisma/client';
import { verifiedProfessions } from './professionDiscount';
import { getPayoutHoldDays } from './settlement';

const prisma = new PrismaClient();

export const AUDIENCES = ['ALL', 'PROFESSION', 'INVITED'];
export const PRODUCT_SCOPES = ['ALL', 'SELECTED'];
export const DOC_TYPES = ['NONE', 'DIPLOMA', 'CV', 'ANY'];
const r2 = (n: number) => Math.round(n * 100) / 100;
const norm = (s: string | null | undefined) => (s || '').trim().toLocaleLowerCase('az');

type Program = NonNullable<Awaited<ReturnType<typeof loadProgram>>>;

export async function loadProgram(id: number) {
  return prisma.referralProgram.findUnique({ where: { id }, include: { rules: { orderBy: { id: 'asc' } } } });
}

/** Elanın aid olduğu proqram: mağaza elanı → mağazanın, əks halda satıcının fərdi proqramı. */
export async function programForListing(listing: { userId: number; businessObjectId: number | null }) {
  return listing.businessObjectId
    ? prisma.referralProgram.findUnique({ where: { objectId: listing.businessObjectId }, include: { rules: true } })
    : prisma.referralProgram.findFirst({ where: { sellerId: listing.userId, objectId: null }, include: { rules: true } });
}

/** Satıcının proqramı (yoxdursa yaradılır). objectId verilərsə sahibi yoxlanmalıdır (çağıran yoxlayır). */
export async function getOrCreateProgram(sellerId: number, objectId: number | null) {
  const found = objectId
    ? await prisma.referralProgram.findUnique({ where: { objectId }, include: { rules: { orderBy: { id: 'asc' } } } })
    : await prisma.referralProgram.findFirst({ where: { sellerId, objectId: null }, include: { rules: { orderBy: { id: 'asc' } } } });
  if (found) return found;
  return prisma.referralProgram.create({ data: { sellerId, objectId }, include: { rules: { orderBy: { id: 'asc' } } } });
}

/** Məhsul proqrama daxildirmi (satıcının məhsul seçimi). */
export function listingIncluded(p: { enabled: boolean; productScope: string }, l: { referralMode: string }) {
  if (!p.enabled) return false;
  return p.productScope === 'SELECTED' ? l.referralMode === 'ON' : l.referralMode !== 'OFF';
}

export interface Eligibility { ok: boolean; reason: string; rulePercent?: number | null; partnerPercent?: number | null; partnerStatus?: string | null }

/** Bu şəxs bu proqram üzrə sata bilərmi? */
export async function eligibility(p: Program | { id: number; sellerId: number; enabled: boolean; audience: string; rules: any[] }, userId: number): Promise<Eligibility> {
  if (!p.enabled) return { ok: false, reason: 'Satıcı referal satışı dayandırıb' };
  if (p.sellerId === userId) return { ok: false, reason: 'Öz məhsulunuza referal ola bilməzsiniz' };
  const partner = await prisma.referralPartner.findUnique({ where: { programId_userId: { programId: p.id, userId } } });
  if (partner?.status === 'REVOKED') return { ok: false, reason: 'Satıcı sizin referal satışınızı dayandırıb', partnerStatus: 'REVOKED' };
  if (partner?.status === 'ACTIVE') return { ok: true, reason: '', partnerPercent: partner.percent, partnerStatus: 'ACTIVE' };
  const pStatus = partner?.status || null;
  if (p.audience === 'ALL') return { ok: true, reason: '', partnerStatus: pStatus };
  if (p.audience === 'INVITED') {
    return {
      ok: false, partnerStatus: pStatus,
      reason: pStatus === 'INVITED' ? 'Satıcının dəvətini qəbul edin' : pStatus === 'REQUESTED' ? 'Müraciətiniz satıcının təsdiqini gözləyir' : 'Bu satıcı yalnız təsdiq etdiyi şəxslərlə işləyir — müraciət edin',
    };
  }
  // PROFESSION — istifadəçinin BÜTÜN ixtisasları yoxlanır (əvvəl yalnız əsas ixtisas).
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { profession: true, professions: true, cvFile: true },
  });
  if (!me) return { ok: false, reason: 'İstifadəçi tapılmadı' };
  const mine = new Set([me.profession, ...(me.professions || [])].map(norm).filter(Boolean));
  const rules = p.rules.filter((r: any) => mine.has(norm(r.profession)));
  if (!rules.length) {
    const list = p.rules.map((r: any) => r.profession).join(', ');
    return { ok: false, partnerStatus: pStatus, reason: list ? `Bu satıcı yalnız bu ixtisaslarla işləyir: ${list}` : 'Satıcı referal ixtisaslarını təyin etməyib' };
  }
  // Diplom şərti HƏMİN ixtisas üzrə təsdiqli sənəd tələb edir — əvvəl istənilən
  // təsdiqli sənəd (məs. başqa sahədə sertifikat) istənilən ixtisası açırdı.
  const verified = await verifiedProfessions(userId);
  const hasCv = !!me.cvFile;
  const passes = (r: any) => {
    const hasDoc = verified.has(norm(r.profession));
    const d = r.requiredDoc;
    return d === 'NONE' || (d === 'DIPLOMA' ? hasDoc : d === 'CV' ? hasCv : hasDoc || hasCv);
  };
  const ok = rules.filter((r: any) => passes(r)).sort((a: any, b: any) => b.commissionPercent - a.commissionPercent);
  if (!ok.length) {
    const d = rules[0].requiredDoc;
    return { ok: false, partnerStatus: pStatus, reason: d === 'DIPLOMA' ? `«${rules[0].profession}» ixtisası üzrə təsdiqlənmiş diplom/sertifikat tələb olunur (profil → Peşə sənədləri)` : d === 'CV' ? 'CV tələb olunur' : 'Diplom və ya CV tələb olunur' };
  }
  return { ok: true, reason: '', rulePercent: ok[0].commissionPercent, partnerStatus: pStatus };
}

/** Konkret məhsul üçün faiz: partnyor → məhsul → ixtisas qaydası → default. */
export function percentFor(p: { defaultPercent: number }, l: { referralPercent: number | null }, el: Eligibility): number {
  const v = el.partnerPercent ?? l.referralPercent ?? el.rulePercent ?? p.defaultPercent;
  return Math.max(0, Math.min(90, Number(v) || 0));
}

/**
 * Linki (və içindəki məhsulları) İNDİ yoxla — səbətə atmaq və sifariş üçün.
 * Qaytarır: etibarlı məhsullar + hər biri üçün faiz, və ya səbəb.
 */
export async function validateLink(token: string, buyerId?: number) {
  const cart = await prisma.referralCart.findUnique({ where: { token } });
  if (!cart) return { ok: false as const, reason: 'Link tapılmadı' };
  if (!cart.active) return { ok: false as const, reason: 'Bu referal link dayandırılıb', cart };
  if (cart.expiresAt && cart.expiresAt < new Date()) return { ok: false as const, reason: 'Bu referal linkin müddəti bitib', cart };
  if (buyerId && buyerId === cart.referrerId) return { ok: false as const, reason: 'Öz referal linkinizdən alış edə bilməzsiniz', cart };
  const program = cart.programId ? await loadProgram(cart.programId) : null;
  if (!program) return { ok: false as const, reason: 'Satıcının referal proqramı tapılmadı', cart };
  if (buyerId && buyerId === program.sellerId) return { ok: false as const, reason: 'Öz məhsulunuzu ala bilməzsiniz', cart };
  const el = await eligibility(program, cart.referrerId);
  if (!el.ok) return { ok: false as const, reason: `Link aktiv deyil: ${el.reason}`, cart };
  if (program.objectId) {
    const obj = await prisma.businessObject.findUnique({ where: { id: program.objectId }, select: { isActive: true, deletedAt: true, business: { select: { isActive: true } } } });
    if (!obj || !obj.isActive || obj.deletedAt || obj.business?.isActive === false) return { ok: false as const, reason: 'Mağaza hazırda aktiv deyil', cart };
  }
  const raw = ((cart.items as any[]) || []).map((i) => ({ listingId: Number(i.listingId), quantity: Math.max(1, Number(i.quantity) || 1) }));
  const listings = await prisma.listing.findMany({
    where: { id: { in: raw.map((i) => i.listingId) } },
    select: { id: true, title: true, price: true, images: true, stock: true, status: true, expiresAt: true, archivedAt: true, userId: true, businessObjectId: true, referralMode: true, referralPercent: true },
  });
  const now = new Date();
  const items = raw.map((i) => {
    const l = listings.find((x) => x.id === i.listingId);
    if (!l) return null;
    const sameProgram = program.objectId ? l.businessObjectId === program.objectId : (l.userId === program.sellerId && !l.businessObjectId);
    const onSale = l.status === 'APPROVED' && !l.archivedAt && (!l.expiresAt || l.expiresAt > now);
    const included = sameProgram && listingIncluded(program, l);
    return {
      listingId: l.id, title: l.title, price: l.price, image: l.images?.[0] || null, stock: l.stock, quantity: i.quantity,
      available: onSale && included && l.stock > 0,
      unavailableReason: !onSale ? 'Satışda deyil' : !included ? 'Satıcı bu məhsulu referaldan çıxarıb' : l.stock <= 0 ? 'Stokda yoxdur' : null,
      percent: percentFor(program, l, el),
    };
  }).filter(Boolean) as any[];
  return { ok: true as const, cart, program, items };
}

/**
 * Checkout: satıcı qrupu üçün referal komissiyasını hesabla.
 * items — səbət sətirləri (referralCartId ilə), lineTotal — sətrin ödənilən məbləği.
 * Bir sifarişdə bir referal satıcı olur (ilk etibarlı link).
 */
export async function computeOrderReferral(buyerId: number, lines: { referralCartId: number | null; listingId: number; lineTotal: number }[]) {
  const withRef = lines.filter((l) => l.referralCartId);
  if (!withRef.length) return null;
  const tokenRows = await prisma.referralCart.findMany({ where: { id: { in: withRef.map((l) => l.referralCartId!) } }, select: { id: true, token: true } });
  for (const row of tokenRows) {
    const v = await validateLink(row.token, buyerId);
    if (!v.ok) continue;
    const perItem = new Map<number, { percent: number; amount: number }>();
    for (const line of lines) {
      if (line.referralCartId !== row.id) continue;
      const it = v.items.find((x: any) => x.listingId === line.listingId && x.available);
      if (!it) continue;
      perItem.set(line.listingId, { percent: it.percent, amount: r2(line.lineTotal * it.percent / 100) });
    }
    if (!perItem.size) continue;
    const amount = r2([...perItem.values()].reduce((s, x) => s + x.amount, 0));
    const base = [...perItem.keys()].reduce((s, id) => s + (lines.find((l) => l.listingId === id)?.lineTotal || 0), 0);
    return { referrerId: v.cart.referrerId, referralCartId: row.id, amount, percent: base > 0 ? r2(amount / base * 100) : 0, perItem };
  }
  return null;
}

/** Sifarişin hazırkı (qaytarılmamış hissəyə düşən) referal məbləği. */
export function effectiveReferral(order: { referralAmount: number | null; referralVoided: boolean; total: number; refundedAmount: number | null }) {
  if (!order.referralAmount || order.referralVoided) return 0;
  const refunded = order.refundedAmount || 0;
  const ratio = order.total > 0 ? Math.max(0, (order.total - refunded) / order.total) : 0;
  return r2(order.referralAmount * ratio);
}

/**
 * Referal hesablaşması — recordSettlement hər status dəyişikliyində çağırır.
 * Ödəniş üsulundan asılı deyil (nağd sifarişdə də referal satıcıya borcumuz yaranır,
 * satıcı isə bu məbləği platformaya borclu olur).
 */
export async function syncReferralLedger(orderId: number) {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, referrerId: true, sellerId: true, status: true, paymentMethod: true, paymentStatus: true, total: true, refundedAmount: true, referralAmount: true, referralVoided: true, deliveredAt: true },
  });
  if (!o?.referrerId || !o.referralAmount) return;
  const existing = await prisma.referralLedger.findUnique({ where: { orderId } });
  const reversed = o.status === 'CANCELLED' || o.referralVoided || o.paymentStatus === ('REFUNDED' as any);
  const amount = effectiveReferral(o);

  if (!existing) {
    if (o.status !== 'DELIVERED' || reversed || amount <= 0) return; // yalnız çatdırılmış satışdan
    const hold = await getPayoutHoldDays();
    const base = o.deliveredAt ? o.deliveredAt.getTime() : Date.now();
    await prisma.referralLedger.create({
      data: {
        orderId, referrerId: o.referrerId, sellerId: o.sellerId, amount,
        heldByPlatform: o.paymentMethod === 'CARD',
        status: hold > 0 ? 'PENDING' : 'AVAILABLE',
        availableAt: new Date(base + hold * 24 * 3600 * 1000),
      },
    });
    return;
  }
  if (existing.status === 'PAID_OUT') {
    if ((reversed || amount < existing.amount - 0.009) && !existing.clawbackNeeded) {
      await prisma.referralLedger.update({ where: { orderId }, data: { clawbackNeeded: true } });
      console.warn(`[referral] CLAWBACK: sifariş #${orderId} referal ödənişindən sonra ləğv/qaytarıldı`);
    }
    return;
  }
  const patch: any = {};
  if (reversed || amount <= 0) { if (existing.status !== 'REVERSED') patch.status = 'REVERSED'; }
  else if (Math.abs(existing.amount - amount) > 0.009) patch.amount = amount;
  if (Object.keys(patch).length) await prisma.referralLedger.update({ where: { orderId }, data: patch });
}

/** Saxlama müddəti bitmiş referal sətirləri ödənilə bilən et (hər 10 dəq). */
export async function releaseReferralLedgers() {
  const r = await prisma.referralLedger.updateMany({
    where: { status: 'PENDING', availableAt: { lte: new Date() } },
    data: { status: 'AVAILABLE' },
  });
  return r.count;
}

export async function referralBalance(referrerId: number) {
  const rows = await prisma.referralLedger.findMany({ where: { referrerId }, select: { status: true, amount: true } });
  let available = 0, pending = 0, paidOut = 0;
  for (const r of rows) {
    if (r.status === 'AVAILABLE') available += r.amount;
    else if (r.status === 'PENDING') pending += r.amount;
    else if (r.status === 'PAID_OUT') paidOut += r.amount;
  }
  return { available: r2(available), pending: r2(pending), paidOut: r2(paidOut) };
}

/** Admin: referal satıcıya ödəniş — AVAILABLE sətirlər PAID_OUT olur. */
export async function createReferralPayout(referrerId: number, adminId: number, adminName: string, method?: string, reference?: string) {
  const ledgers = await prisma.referralLedger.findMany({ where: { referrerId, status: 'AVAILABLE' } });
  const amount = r2(ledgers.reduce((s, l) => s + l.amount, 0));
  if (amount <= 0) throw new Error('Ödəniləcək referal balansı yoxdur');
  const u = await prisma.user.findUnique({ where: { id: referrerId }, select: { name: true, referralIban: true, referralPayeeName: true } });
  const payout = await prisma.referralPayout.create({
    data: { referrerId, amount, iban: u?.referralIban || null, payeeName: u?.referralPayeeName || u?.name || null, method: method || null, reference: reference || null, createdById: adminId, createdName: adminName },
  });
  await prisma.referralLedger.updateMany({ where: { id: { in: ledgers.map((l) => l.id) } }, data: { status: 'PAID_OUT', payoutId: payout.id } });
  await prisma.notification.create({
    data: { userId: referrerId, type: 'REFERRAL', title: 'Referal komissiyası ödənildi', body: `${amount.toFixed(2)} AZN hesabınıza köçürüldü.`, link: '/referral-earnings' },
  }).catch(() => {});
  return payout;
}

/**
 * Bir dəfəlik keçid: proqramdan əvvəlki mağaza ayarlarını (referralEnabled +
 * ReferralRule.objectId) proqrama köçür; köhnə linkləri proqrama bağla; çatdırılmış
 * köhnə referal sifarişləri üçün ledger yarat.
 */
export async function migrateReferralPrograms() {
  const done = await prisma.setting.findUnique({ where: { key: 'referral_program_v1' } });
  if (done) return;
  const objs = await prisma.businessObject.findMany({
    where: { OR: [{ referralEnabled: true }, { referralRules: { some: {} } }] },
    select: { id: true, referralEnabled: true, business: { select: { userId: true } } },
  });
  for (const o of objs) {
    const p = await prisma.referralProgram.upsert({
      where: { objectId: o.id },
      update: {},
      create: { sellerId: o.business.userId, objectId: o.id, enabled: o.referralEnabled, audience: 'PROFESSION' },
    });
    await prisma.referralRule.updateMany({ where: { objectId: o.id, programId: null }, data: { programId: p.id } });
    await prisma.referralCart.updateMany({ where: { objectId: o.id, programId: null }, data: { programId: p.id, sellerId: o.business.userId } });
  }
  // Köhnə linklərin müddəti yox idi (əbədi) — keçiddən 30 gün sonra bitsin.
  await prisma.referralCart.updateMany({ where: { expiresAt: null }, data: { expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) } });
  const oldOrders = await prisma.order.findMany({ where: { referrerId: { not: null }, status: 'DELIVERED' }, select: { id: true } });
  for (const o of oldOrders) await syncReferralLedger(o.id).catch(() => {});
  await prisma.setting.create({ data: { key: 'referral_program_v1', value: new Date().toISOString() } });
  console.log(`[startup] referal proqramı keçidi: ${objs.length} mağaza, ${oldOrders.length} köhnə sifariş`);
}
