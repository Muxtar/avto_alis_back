// BİRDƏFƏLİK HAQLAR — biznes yaratma və Veriff kimlik doğrulaması.
//
// İki ödəniş növü var (`purpose`), məntiq isə ortaqdır:
//   BUSINESS — biznes yaratmaq üçün (AI sənəd yoxlaması, şlüz xərcləri)
//   VERIFF   — kimliyi DƏRHAL Veriff ilə təsdiqləmək üçün (Veriff xidmət haqqı).
//              Admin yoxlaması pulsuzdur — bu haqq yalnız Veriff seçiləndə alınır.
//
// Hər ikisinin tarifi admin paneldən dəyişilir; 0 = pulsuz.
//
// Axın:
//   1) İstifadəçi «Ödə» → BusinessFee(UNPAID) + şlüz ödənişi yaranır
//   2) Şlüz callback-i → PAID (pul gəldi, hələ istifadə olunmayıb)
//   3) Biznes forması göndərilir → PAID qeyd USED olur (businessId yazılır)
//
// Ödənişin ÖDƏNİLDİYİ yalnız ŞLÜZ CALLBACK-i ilə təsdiqlənir — brauzerdən
// gələn «uğurlu oldu» siqnalına heç vaxt inanılmır (saxtalaşdırıla bilər).
//
// Tarif 0 olarsa haqq ümumiyyətlə tələb olunmur (admin pulsuz edə bilər).

import { PrismaClient } from '@prisma/client';
import { getNumber } from './settings';

const prisma = new PrismaClient();

/** Ödənişin növü: biznes yaratma haqqı, yoxsa Veriff kimlik doğrulaması. */
export type FeePurpose = 'BUSINESS' | 'VERIFF';

const FEE_KEY: Record<FeePurpose, string> = {
  BUSINESS: 'business_fee_azn',
  VERIFF: 'veriff_fee_azn',
};

/** Cari tarif (AZN). Admin paneldən dəyişilir. 0 = pulsuz. */
export async function feeAmount(purpose: FeePurpose = 'BUSINESS'): Promise<number> {
  try { return await getNumber(FEE_KEY[purpose]); } catch { return 0; }
}

export interface FeeState {
  amount: number;      // cari tarif
  required: boolean;   // ödəniş tələb olunurmu (tarif > 0)
  paid: boolean;       // istifadəyə hazır ödənilmiş haqq varmı
  feeId: number | null;
  paidAt: Date | null;
  pendingRef: string | null; // başlanmış, hələ təsdiqlənməmiş ödəniş
}

/** İstifadəçinin həmin növ ödəniş üzrə vəziyyəti. */
export async function feeState(userId: number, purpose: FeePurpose = 'BUSINESS'): Promise<FeeState> {
  const amount = await feeAmount(purpose);
  if (amount <= 0) {
    return { amount: 0, required: false, paid: true, feeId: null, paidAt: null, pendingRef: null };
  }
  const [ready, pending] = await Promise.all([
    prisma.businessFee.findFirst({
      where: { userId, purpose, status: 'PAID' },
      orderBy: { paidAt: 'asc' },   // ən köhnə ödəniş əvvəl xərclənsin
      select: { id: true, paidAt: true },
    }),
    prisma.businessFee.findFirst({
      where: { userId, purpose, status: 'UNPAID' },
      orderBy: { createdAt: 'desc' },
      select: { gatewayRef: true },
    }),
  ]);
  return {
    amount,
    required: true,
    paid: !!ready,
    feeId: ready?.id ?? null,
    paidAt: ready?.paidAt ?? null,
    pendingRef: pending?.gatewayRef ?? null,
  };
}

/**
 * Biznes yaradılarkən haqqı xərclə.
 *
 * `status: 'PAID'` şərti updateMany-nin İÇİNDƏDİR — bu, eyni anda iki biznes
 * göndərilsə belə bir ödənişin iki dəfə işlənməsinin qarşısını alır (DB
 * səviyyəsində atomik). Əvvəlcə oxuyub sonra yazsaydıq yarış şəraiti olardı.
 *
 * @returns xərclənən qeydin id-si, tarif 0-dırsa null, ödəniş yoxdursa `false`
 */
export async function consumeFee(
  userId: number,
  businessId: number | null,
  purpose: FeePurpose = 'BUSINESS',
): Promise<{ ok: boolean; feeId: number | null }> {
  const amount = await feeAmount(purpose);
  if (amount <= 0) return { ok: true, feeId: null };

  const candidate = await prisma.businessFee.findFirst({
    where: { userId, purpose, status: 'PAID' },
    orderBy: { paidAt: 'asc' },
    select: { id: true },
  });
  if (!candidate) return { ok: false, feeId: null };

  const r = await prisma.businessFee.updateMany({
    where: { id: candidate.id, status: 'PAID' },
    data: { status: 'USED', businessId, usedAt: new Date() },
  });
  if (r.count === 0) return { ok: false, feeId: null };   // başqa sorğu qabaqladı
  return { ok: true, feeId: candidate.id };
}

/**
 * Haqqı yenidən istifadəyə aç.
 *
 * Admin biznesi RƏDD etsə və ya biznes silinsə istifadəçi ikinci dəfə ödəməməlidir —
 * pul alındı, xidmət (təsdiqlənmiş biznes) verilmədi. Qeyd PAID-ə qayıdır və
 * növbəti müraciətdə işlənir.
 */
export async function releaseFee(businessId: number): Promise<void> {
  await prisma.businessFee.updateMany({
    where: { businessId, status: 'USED' },
    data: { status: 'PAID', businessId: null, usedAt: null },
  }).catch(() => {});
}

/**
 * Veriff haqqını yenidən istifadəyə aç.
 *
 * Veriff təsdiqi RƏDD olunsa və ya yenidən təqdim istənsə istifadəçi ikinci
 * dəfə ödəməməlidir — pul alındı, təsdiq alınmadı. Ən son xərclənmiş qeyd
 * PAID-ə qaytarılır.
 */
export async function releaseIdentityFee(userId: number): Promise<void> {
  const last = await prisma.businessFee.findFirst({
    where: { userId, purpose: 'VERIFF', status: 'USED' },
    orderBy: { usedAt: 'desc' },
    select: { id: true },
  });
  if (!last) return;
  await prisma.businessFee.updateMany({
    where: { id: last.id, status: 'USED' },
    data: { status: 'PAID', usedAt: null },
  }).catch(() => {});
}

/**
 * Şlüz callback-i — ödənişi təsdiqlə (idempotent).
 *
 * Təkrar callback gəlsə artıq USED olmuş qeyd PAID-ə QAYTARILMIR (status
 * filtri yalnız UNPAID/FAILED-i tutur) — əks halda bir ödənişlə iki biznes
 * yaratmaq mümkün olardı.
 */
export async function settleBusinessFee(
  where: { gatewayRef?: string; gatewayOrderId?: number | null },
  paid: boolean,
): Promise<void> {
  const w: any = {};
  if (where.gatewayRef) w.gatewayRef = where.gatewayRef;
  if (where.gatewayOrderId != null) w.gatewayOrderId = where.gatewayOrderId;
  if (Object.keys(w).length === 0) return;

  const fees = await prisma.businessFee.findMany({ where: w, select: { id: true, userId: true, status: true, amount: true, purpose: true } });
  for (const f of fees) {
    if (f.status === 'USED' || f.status === 'REFUNDED') continue;   // artıq yekunlaşıb
    if (paid) {
      if (f.status === 'PAID') continue;                            // təkrar callback
      await prisma.businessFee.update({ where: { id: f.id }, data: { status: 'PAID', paidAt: new Date() } });
      const isVeriff = f.purpose === 'VERIFF';
      await prisma.notification.create({
        data: {
          userId: f.userId, type: 'SYSTEM',
          title: 'Ödəniş qəbul edildi ✓',
          body: isVeriff
            ? `Kimlik doğrulaması haqqı (${f.amount.toFixed(2)} AZN) ödənildi. İndi Veriff ilə təsdiqi başlada bilərsiniz.`
            : `Biznes yaratma haqqı (${f.amount.toFixed(2)} AZN) ödənildi. İndi biznes müraciətinizi göndərə bilərsiniz.`,
          link: isVeriff ? '/profile' : '/business',
        },
      }).catch(() => {});
    } else {
      await prisma.businessFee.update({ where: { id: f.id }, data: { status: 'FAILED' } });
    }
  }
}

/** Bu referans/order bir biznes haqqına aiddirmi (callback marşrutlaşdırması üçün). */
export async function isBusinessFeeRef(where: { gatewayRef?: string; gatewayOrderId?: number | null }): Promise<boolean> {
  const w: any = {};
  if (where.gatewayRef) w.gatewayRef = where.gatewayRef;
  if (where.gatewayOrderId != null) w.gatewayOrderId = where.gatewayOrderId;
  if (Object.keys(w).length === 0) return false;
  return (await prisma.businessFee.count({ where: w })) > 0;
}
