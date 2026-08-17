// SAXLANMIŞ KARTLAR — YIĞIM (MAGNET) tokenizasiyası.
//
// Kart məlumatı bizdə SAXLANMIR. YIĞIM kartı öz tərəfində saxlayır, bizə
// `token` verir; biz yalnız tokeni + maskalanmış nömrəni + bitmə tarixini
// yazırıq. Beləliklə PCI DSS yükü şlüzdə qalır.
//
// Kart bağlama axını (YIĞIM-in öz sənədindəki ardıcıllıq):
//   1. /payment/create → type=DMS, amount=0.05, save=y   → kart səhifəsi açılır
//   2. istifadəçi kartı daxil edir
//   3. callback gəlir → /payment/status
//   4. status=0 və code='00' → token/pan/expiry yazılır
//   5. /payment/cancel → bloklanmış 5 qəpik geri açılır
//
// TƏHLÜKƏSİZLİK QAYDASI: `token` heç vaxt brauzerə göndərilmir. Onunla bizim
// merchant üzərindən pul çəkmək mümkündür — sızması kart nömrəsinin sızması
// ilə eyni ağırlıqdadır. Müştəri yalnız sətrin `id`-sini görür.

import { PrismaClient } from '@prisma/client';
import * as yigim from './yigimPay';

const prisma = new PrismaClient();

// Kartı yoxlamaq üçün bloklanan məbləğ (AZN). Dərhal geri açılır.
export const CARD_VERIFY_AMOUNT = Number(process.env.YIGIM_CARD_VERIFY_AMOUNT || 0.05);

// Saxlanmış kartla ödənişin rejimi. YIĞIM axın sənədi DMS göstərir, spesifikasiya
// isə hər ikisinə icazə verir. SMS = dərhal çəkilir (bizim indiki sifariş axını
// belədir). DMS qaytarılsa (status S1 = bloklandı) kod avtomatik capture edir,
// ona görə hər iki halda ödəniş tamamlanır.
const EXECUTE_TYPE = (process.env.YIGIM_EXECUTE_TYPE || 'SMS').toUpperCase() === 'DMS' ? 'DMS' : 'SMS';

// Müştəriyə göndərilə bilən sahələr — `token` QƏSDƏN yoxdur.
export const PUBLIC_CARD_FIELDS = {
  id: true, maskedPan: true, expiry: true, brand: true, issuer: true,
  isDefault: true, lastUsedAt: true, createdAt: true,
} as const;

// Referansdan kart bağlama sorğusu olduğunu bilmək üçün prefiks.
export const CARD_REF_PREFIX = 'card-';
export const isCardReference = (ref: string) => ref.startsWith(CARD_REF_PREFIX);

/** 1) Kart bağlamanı başlat — YIĞIM kart səhifəsinin URL-ini qaytarır. */
export async function startCardLink(userId: number, callbackBase: string): Promise<{ url: string; reference: string }> {
  if (!yigim.isConfigured()) throw new Error('YIĞIM qoşulmayıb');
  // Referans unikal olmalıdır; təsadüfi hissə təxmin edilməsin deyə uzundur.
  const reference = `${CARD_REF_PREFIX}${userId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  await prisma.savedCard.create({ data: { userId, reference, status: 'PENDING' } });

  const fe = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const r = await yigim.createPayment({
    reference,
    amount: CARD_VERIFY_AMOUNT,
    description: 'Kartın yadda saxlanması',
    // DMS — pul çəkilmir, yalnız bloklanır və dərhal geri açılır.
    type: 'DMS',
    saveCard: true,
    callbackUrl: `${callbackBase}/api/payment/yigim/callback`,
    extra: `back-url=${fe}/account?card=ok;fail-url=${fe}/account?card=fail`,
  });
  return { url: r.url, reference };
}

/** 2) Callback gələndə — statusu oxu, tokeni yaz, bloku aç. */
export async function finishCardLink(reference: string): Promise<void> {
  const row = await prisma.savedCard.findUnique({ where: { reference } });
  if (!row || row.status !== 'PENDING') return; // təkrar callback — idempotent

  let ok = false;
  try {
    const { status, raw } = await yigim.getPaymentStatus(reference);
    // Kart yalnız əməliyyat təsdiqlənəndə saxlanılır. DMS-də blok statusu
    // "S1"-dir; hər ikisi uğurlu bağlama sayılır.
    ok = yigim.isPaidStatus(status) || String(status) === 'S1';
    if (ok && raw?.token) {
      await prisma.savedCard.update({
        where: { reference },
        data: {
          status: 'ACTIVE',
          token: String(raw.token),
          maskedPan: raw.pan ? String(raw.pan) : null,
          expiry: raw.expiry ? String(raw.expiry) : null,
          brand: raw.system ? String(raw.system) : null,
          issuer: raw.issuer ? String(raw.issuer) : null,
          // İlk kart avtomatik əsas olur.
          isDefault: (await prisma.savedCard.count({ where: { userId: row.userId, status: 'ACTIVE' } })) === 0,
        },
      });
    } else {
      ok = false;
      await prisma.savedCard.update({ where: { reference }, data: { status: 'FAILED' } });
    }
  } catch (e: any) {
    console.error('[savedCards] status oxunmadı:', e?.message);
    await prisma.savedCard.update({ where: { reference }, data: { status: 'FAILED' } }).catch(() => {});
  }

  // Bloklanmış 5 qəpiyi hər halda geri aç — kart saxlanmasa da pul qalmasın.
  try { await yigim.cancel(reference); } catch (e: any) { console.error('[savedCards] blok açılmadı:', e?.message); }
}

/** 3) Saxlanmış kartla ödəniş. Yönləndirmə yoxdur — cavab dərhal gəlir. */
export async function chargeSavedCard(
  userId: number, cardId: number, amount: number, reference: string, description?: string,
): Promise<{ ok: boolean; status: string; message?: string }> {
  const card = await prisma.savedCard.findFirst({ where: { id: cardId, userId, status: 'ACTIVE' } });
  if (!card?.token) return { ok: false, status: '', message: 'Kart tapılmadı' };

  const r = await yigim.executeSavedCard({
    reference, token: card.token, amount, type: EXECUTE_TYPE as 'SMS' | 'DMS', description,
  });

  let status = r.status;
  // DMS cavabı (S1 = bloklandı) → dərhal capture, əks halda pul çəkilməmiş qalar.
  if (status === 'S1') {
    try {
      await yigim.capture(reference, amount);
      const after = await yigim.getPaymentStatus(reference);
      status = after.status;
    } catch (e: any) {
      return { ok: false, status, message: 'Bloklandı, amma çəkilmədi: ' + e?.message };
    }
  }

  const ok = yigim.isPaidStatus(status);
  if (ok) await prisma.savedCard.update({ where: { id: card.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { ok, status, message: ok ? undefined : `Ödəniş rədd edildi (status ${status || '—'})` };
}
