// İADƏ AXINI — ortaq addımlar (satıcı, admin və SİSTEM eyni funksiyaları işlədir).
//
// Axın:
//   REQUESTED ──(satıcı təsdiq / 72 saat cavabsız → sistem təsdiqi)──► APPROVED
//   REQUESTED ──(satıcı SƏBƏBLƏ rədd)──► REJECTED ──(alıcı mübahisə açır)──► DISPUTED
//   APPROVED ──(alıcı göndərir: üsul + izləmə kodu)──► RETURN_SHIPPED
//   APPROVED ──(7 gün göndərilmir)──► CANCELLED
//   RETURN_SHIPPED ──(satıcı qəbul edir)──► RETURN_RECEIVED
//   RETURN_SHIPPED ──(satıcı «problem var» deyir / 10 gün təsdiqləmir)──► DISPUTED
//   RETURN_RECEIVED ──(satıcı qaytarır / 48 saat keçir → sistem qaytarır)──► REFUNDED
//   DISPUTED ──(sistem/admin qərarı)──► APPROVED | REFUNDED | REJECTED
//
// Hər addım ReturnEvent-ə yazılır — alıcı, satıcı və admin eyni tarixçəni görür.
import { PrismaClient } from '@prisma/client';
import { refundOrderSafe } from './refunds';
import { recordSettlement } from './settlement';
import { pushLive, pushAdmins } from './live';

const prisma = new PrismaClient();

const H = 60 * 60 * 1000;
export const RETURN_SELLER_RESPOND_HOURS = Number(process.env.RETURN_SELLER_RESPOND_HOURS || 72);
export const RETURN_SHIP_DAYS = Number(process.env.RETURN_SHIP_DAYS || 7);
export const RETURN_RECEIVE_DAYS = Number(process.env.RETURN_RECEIVE_DAYS || 10);
export const RETURN_REFUND_HOURS = Number(process.env.RETURN_REFUND_HOURS || 48);
// Rədd edilmiş iadəyə alıcı neçə gün ərzində mübahisə aça bilər.
export const RETURN_DISPUTE_DAYS = Number(process.env.RETURN_DISPUTE_DAYS || 7);

export const RETURN_METHODS = ['COURIER', 'IN_PERSON', 'POST', 'YANGO'];
export const RETURN_METHOD_AZ: Record<string, string> = {
  COURIER: 'Kuryer', IN_PERSON: 'Şəxsən təhvil', POST: 'Poçt', YANGO: 'Yango',
};

export type Actor = 'BUYER' | 'SELLER' | 'SYSTEM' | 'ADMIN';

export const hoursFromNow = (h: number) => new Date(Date.now() + h * H);

export async function logReturnEvent(returnId: number, actor: Actor, actorId: number | null, status: string, note?: string | null) {
  await prisma.returnEvent.create({
    data: { returnId, actor, actorId, status, note: note ? String(note).slice(0, 1000) : null },
  }).catch((e) => console.error('[returnFlow] event yazılmadı:', e?.message));
}

async function notify(userId: number, title: string, body: string, link = '/iadeler') {
  await prisma.notification.create({ data: { userId, type: 'ORDER', title, body, link } }).catch(() => {});
}

/** Sorğunu təsdiqlə — satıcı, sistem (satıcı cavab vermədi) və ya mübahisə qərarı. */
export async function approveReturn(retId: number, actor: Actor, actorId: number | null, opts: { refundAmount?: number; note?: string } = {}) {
  const ret = await prisma.returnRequest.findUnique({ where: { id: retId } });
  if (!ret) throw new Error('İadə tapılmadı');
  const ord = await prisma.order.findUnique({ where: { id: ret.orderId }, select: { total: true, refundedAmount: true } });
  const remain = Math.round(((ord?.total || 0) - (ord?.refundedAmount || 0)) * 100) / 100;
  const amt = Math.min(opts.refundAmount ?? ret.refundAmount ?? remain, remain);
  const updated = await prisma.returnRequest.update({
    where: { id: ret.id },
    data: { status: 'APPROVED', refundAmount: amt, shipBy: hoursFromNow(RETURN_SHIP_DAYS * 24), sellerRespondBy: null, receiveBy: null, refundBy: null },
  });
  const who = actor === 'SYSTEM' ? 'Satıcı vaxtında cavab vermədiyi üçün sistem' : actor === 'ADMIN' ? 'Admin' : 'Satıcı';
  await logReturnEvent(ret.id, actor, actorId, 'APPROVED', opts.note || `${who} iadəni təsdiqlədi (${amt.toFixed(2)} AZN)`);
  // Satıcı məbləği endiribsə alıcı bunu göndərməzdən ƏVVƏL açıq görməlidir.
  const lowered = ret.refundAmount != null && amt < ret.refundAmount - 0.009;
  await notify(ret.buyerId, `İadə təsdiqləndi — sifariş #${ret.orderId}`,
    `${who} iadəni təsdiqlədi (${amt.toFixed(2)} AZN).${lowered ? ` DİQQƏT: istədiyiniz məbləğ ${ret.refundAmount!.toFixed(2)} AZN idi — razı deyilsinizsə məhsulu göndərməyin, iadəni ləğv edin və ya dəstəyə yazın.` : ''} Məhsulu ${RETURN_SHIP_DAYS} gün ərzində satıcıya göndərib «Göndərdim» düyməsini basın.`);
  if (actor !== 'SELLER') {
    await notify(ret.sellerId, `İadə təsdiqləndi — sifariş #${ret.orderId}`,
      `${who} sifariş #${ret.orderId} üzrə iadəni təsdiqlədi. Alıcı məhsulu geri göndərəcək.`);
  }
  pushLive([ret.buyerId, ret.sellerId], { kind: 'return', id: ret.id, status: 'APPROVED' });
  return updated;
}

/** Qaytarılan mal susmaya görə stoka qayıdırmı: qüsurlu maldan başqa hamısı. */
export const defaultRestock = (reason: string) => reason !== 'DEFECTIVE';

/**
 * PULU QAYTAR + stoku bərpa et + xalları düzəlt + referalı ləğv et + hesablaşmanı yenilə.
 * Satıcının «Geri ödə» düyməsi, admin qərarı və sistemin avtomatik qaytarması
 * EYNİ funksiyanı işlədir — məntiq bir yerdədir.
 *
 * STOK yalnız o halda artır ki:
 *   • mal FİZİKİ OLARAQ satıcıya çatıb (receivedAt) — admin malı geri almadan pulu
 *     qaytarırsa (məs. mübahisə qərarı) anbara heç nə gəlməyib, stok artmamalıdır;
 *   • satıcı «stoka qaytarma» deməyib (qüsurlu mal yenidən satışa çıxmamalıdır).
 */
export async function finalizeReturnRefund(
  retId: number, actor: Actor, actorId: number | null, opts: { amount?: number; note?: string; restock?: boolean } = {},
): Promise<{ ok: boolean; error?: string; retrying?: boolean; cashRefund?: boolean; amount?: number; stockWarnings?: string[]; restockedQty?: number }> {
  // ── QIFIL ── Əvvəl status əvvəlcədən oxunurdu: iki paralel sorğu (iki klik və ya
  // satıcı + 10 dəqiqəlik sistem işi) hər ikisi «hələ qaytarılmayıb» görüb pulu və
  // stoku İKİ DƏFƏ qaytara bilərdi. Yarımçıq qalmış qıfıl 10 dəqiqədən sonra açılır.
  const stale = new Date(Date.now() - 10 * 60 * 1000);
  const claim = await prisma.returnRequest.updateMany({
    where: { id: retId, status: { not: 'REFUNDED' }, OR: [{ refundClaimedAt: null }, { refundClaimedAt: { lt: stale } }] },
    data: { refundClaimedAt: new Date() },
  });
  if (claim.count === 0) {
    const cur = await prisma.returnRequest.findUnique({ where: { id: retId }, select: { status: true } });
    if (!cur) return { ok: false, error: 'İadə tapılmadı' };
    return { ok: false, error: cur.status === 'REFUNDED' ? 'Bu iadə artıq tamamlanıb' : 'Pul qaytarma artıq gedir — bir az gözləyin' };
  }
  const release = () => prisma.returnRequest.update({ where: { id: retId }, data: { refundClaimedAt: null } }).catch(() => {});

  try {
  const ret = await prisma.returnRequest.findUnique({
    where: { id: retId },
    include: { orderItem: true, order: { include: { items: true } } },
  });
  if (!ret) return { ok: false, error: 'İadə tapılmadı' };

  const ord = ret.order;
  const isCardPaid = !!((ord.gatewayRef || ord.gatewayOrderId) && ord.paymentStatus === 'PAID');
  const remainingNow = Math.round((ord.total - (ord.refundedAmount || 0)) * 100) / 100;
  const amt = Math.max(0, Math.min(opts.amount ?? ret.refundAmount ?? remainingNow, remainingNow));
  // NAĞD sifarişdə pul platformadan keçməyib — satıcı alıcıya nağd qaytarır.
  const cashRefund = !isCardPaid;
  if (isCardPaid && amt > 0.009) {
    const r = await refundOrderSafe(ord.id, actor === 'ADMIN' ? 'ADMIN' : 'RETURN', amt);
    if (!r.ok) { await release(); return { ok: false, error: 'Bank iadəsi alınmadı: ' + (r.error || ''), retrying: true }; }
  }

  const received = !!ret.receivedAt;
  const wantRestock = opts.restock ?? ret.restock ?? defaultRestock(ret.reason);
  const doRestock = received && wantRestock;
  const stockWarnings: string[] = [];
  let restockedQty = 0;
  await prisma.$transaction(async (tx) => {
    const lines = ret.orderItem
      ? [{ listingId: ret.orderItem.listingId, qty: ret.quantity }]
      : ord.items.map((i) => ({ listingId: i.listingId, qty: i.quantity }));
    if (doRestock) for (const l of lines) {
      if (l.qty <= 0) continue;
      const exists = await tx.listing.findUnique({ where: { id: l.listingId }, select: { id: true } });
      if (exists) { await tx.listing.update({ where: { id: l.listingId }, data: { stock: { increment: l.qty } } }); restockedQty += l.qty; }
      else stockWarnings.push(`Elan #${l.listingId} silinib, stok bərpa edilə bilmədi`);
    }
    // XALLAR — qaytarılan pulun payı qədər: bu alışdan qazanılan xal geri alınır,
    // alışda xərclənən xal alıcıya qaytarılır. Əvvəl heç biri edilmirdi: alıcı malı
    // qaytarıb pulunu alır, qazandığı xal isə onda qalırdı.
    const ratio = ord.total > 0 ? Math.min(1, amt / ord.total) : (ret.orderItem ? 0 : 1);
    const takeBack = Math.round((ord.pointsEarned || 0) * ratio);
    const giveBack = Math.round((ord.pointsUsed || 0) * ratio);
    if (takeBack || giveBack) {
      const u = await tx.user.findUnique({ where: { id: ret.buyerId }, select: { loyaltyPoints: true } });
      if (u) await tx.user.update({ where: { id: ret.buyerId }, data: { loyaltyPoints: Math.max(0, u.loyaltyPoints - takeBack + giveBack) } });
    }
    // Qaytarılmış mal üçün referal komissiyası ödənilmir.
    // QİSMƏN iadə (bir sətir): komissiya yalnız həmin sətrin payı qədər azalır.
    // Kartda bu, refundedAmount nisbəti ilə avtomatik olur (effectiveReferral);
    // nağdda pul platformadan keçmədiyi üçün sətrin komissiyası birbaşa çıxılır.
    if (ord.referrerId && !ord.referralVoided && ret.orderItem && ord.items.length > 1) {
      if (!isCardPaid && ord.referralAmount) {
        const it = ord.items.find((i) => i.id === ret.orderItem!.id);
        const cut = it?.referralAmount ? Math.round(it.referralAmount * Math.min(1, ret.quantity / it.quantity) * 100) / 100 : 0;
        if (cut > 0) await tx.order.update({ where: { id: ord.id }, data: { referralAmount: Math.max(0, Math.round((ord.referralAmount - cut) * 100) / 100) } });
      }
    } else if (ord.referrerId && !ord.referralVoided) {
      await tx.order.update({ where: { id: ord.id }, data: { referralVoided: true } });
      await tx.notification.create({
        data: { userId: ord.referrerId, type: 'REFERRAL', title: 'Referal komissiyası ləğv edildi', body: `Sifariş #${ord.id} qaytarıldığı üçün komissiya ləğv olundu.`, link: '/referral-earnings' },
      }).catch(() => {});
    }
    await tx.returnRequest.update({
      where: { id: ret.id },
      data: { status: 'REFUNDED', cashRefund, refundAmount: amt, refundedAt: new Date(), refundBy: null, receiveBy: null, restock: wantRestock, restockedQty, refundClaimedAt: null },
    });
  });
  if (stockWarnings.length) console.warn(`[returnFlow] iadə #${ret.id} stok xəbərdarlığı:`, stockWarnings);

  // Hesablaşma — bu olmasa qaytarılmış pul satıcıya da ödənilə bilərdi.
  await recordSettlement(ord.id).catch(() => {});

  const who = actor === 'SYSTEM' ? 'Sistem' : actor === 'ADMIN' ? 'Admin' : 'Satıcı';
  const stockNote = restockedQty > 0 ? `${restockedQty} ədəd stoka qaytarıldı`
    : !received ? 'mal satıcıya çatmadığı üçün stok dəyişmədi'
    : !wantRestock ? 'mal stoka qaytarılmadı' : 'stok dəyişmədi';
  await logReturnEvent(ret.id, actor, actorId, 'REFUNDED',
    `${opts.note || `${who}: ${amt.toFixed(2)} AZN ${cashRefund ? 'nağd qaytarılmalıdır' : 'karta qaytarıldı'}`} · ${stockNote}`);
  await notify(ret.buyerId, `İadə tamamlandı — sifariş #${ord.id}`,
    cashRefund
      ? `Məbləğ (${amt.toFixed(2)} AZN) nağd ödəniş olduğu üçün satıcı tərəfindən nağd qaytarılır — almadınızsa dəstəyə yazın.`
      : `${amt.toFixed(2)} AZN kartınıza qaytarıldı. Banka düşməsi bir neçə iş günü çəkə bilər.`);
  if (actor !== 'SELLER') {
    await notify(ret.sellerId, `İadə tamamlandı — sifariş #${ord.id}`,
      `${who} sifariş #${ord.id} üzrə ${amt.toFixed(2)} AZN iadəni tamamladı (${stockNote}).${cashRefund ? ' Nağd sifariş: məbləği alıcıya siz qaytarmalısınız.' : ''}`, '/iadeler?tab=selling');
  }
  pushLive([ret.buyerId, ret.sellerId], { kind: 'return', id: ret.id, status: 'REFUNDED' });
  if (cashRefund && actor === 'SYSTEM') pushAdmins('return', { id: ret.id, toast: `Nağd iadə #${ret.id}: satıcının qaytarmasına nəzarət edin` });
  return { ok: true, cashRefund, amount: amt, stockWarnings, restockedQty };
  } catch (e) {
    // Gözlənilməz xəta — qıfılı aç ki, iadə həmişəlik ilişib qalmasın.
    await release();
    throw e;
  }
}

/** İadəni rədd edilmiş kimi bağla (satıcı səbəbi ilə və ya mübahisə satıcının xeyrinə). */
export async function rejectReturn(retId: number, actor: Actor, actorId: number | null, reason: string) {
  const ret = await prisma.returnRequest.findUnique({ where: { id: retId } });
  if (!ret) throw new Error('İadə tapılmadı');
  const updated = await prisma.returnRequest.update({
    where: { id: ret.id },
    data: {
      status: 'REJECTED', sellerRespondBy: null, shipBy: null, receiveBy: null, refundBy: null,
      ...(actor === 'SELLER' ? { sellerNote: reason } : { adminNote: reason }),
    },
  });
  await logReturnEvent(ret.id, actor, actorId, 'REJECTED', reason);
  pushLive([ret.buyerId, ret.sellerId], { kind: 'return', id: ret.id, status: 'REJECTED' });
  return updated;
}
