// SAXLANMIŞ KARTLAR — YIĞIM (MAGNET) tokenizasiyası.
//
// Kart məlumatı bizdə SAXLANMIR. YIĞIM kartı öz tərəfində saxlayır, bizə
// `token` verir; biz yalnız tokeni + maskalanmış nömrəni + bitmə tarixini
// yazırıq. Beləliklə PCI DSS yükü şlüzdə qalır.
//
// Kart NECƏ saxlanılır: alıcı səbətdə "Kartı yadda saxla" seçir → şlüzə
// `save=y` göndərilir → ödəniş baş tutanda /payment/status cavabında `token`
// gəlir → burada yazılır. Ayrıca kart bağlama səhifəsi və sınaq bloku YOXDUR.
//
// TƏHLÜKƏSİZLİK QAYDASI: `token` heç vaxt brauzerə göndərilmir. Onunla bizim
// merchant üzərindən pul çəkmək mümkündür — sızması kart nömrəsinin sızması
// ilə eyni ağırlıqdadır. Müştəri yalnız sətrin `id`-sini görür.

import { PrismaClient } from '@prisma/client';
import * as yigim from './yigimPay';

const prisma = new PrismaClient();

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

/**
 * Ödəniş uğurlu olandan sonra kartı saxla.
 *
 * Ayrıca "kart bağlama" axını YOXDUR — alıcı səbətdə "Kartı yadda saxla"
 * seçir, biz şlüzə `save=y` göndəririk, ödəniş baş tutanda şlüz cavabında
 * `token` gəlir və burada yazılır. Yəni kart REAL ALIŞ zamanı saxlanılır;
 * istifadəçidən əlavə addım və ya sınaq bloku tələb olunmur.
 *
 * İdempotentdir: eyni kart təkrar saxlanarsa sətir yenilənir, dublikat yaranmır.
 */
export async function saveCardFromPayment(reference: string, raw: any): Promise<void> {
  const token = raw?.token ? String(raw.token) : '';
  if (!token) return;                       // şlüz token qaytarmayıb — saxlanacaq bir şey yoxdur

  // Bu referans hansı sifarişə (və alıcıya) aiddir və saxlama istənilibmi?
  const order = await prisma.order.findFirst({
    where: { gatewayRef: reference, saveCardRequested: true },
    select: { buyerId: true },
  });
  if (!order) return;

  const data = {
    maskedPan: raw.pan ? String(raw.pan) : null,
    expiry: raw.expiry ? String(raw.expiry) : null,
    brand: raw.system ? String(raw.system) : null,
    issuer: raw.issuer ? String(raw.issuer) : null,
    status: 'ACTIVE',
  };
  const first = (await prisma.savedCard.count({ where: { userId: order.buyerId, status: 'ACTIVE' } })) === 0;
  await prisma.savedCard.upsert({
    where: { userId_token: { userId: order.buyerId, token } },
    create: { userId: order.buyerId, token, reference, isDefault: first, ...data },
    update: data,                            // maska/tarix yenilənə bilər
  }).catch((e) => console.error('[savedCards] saxlanmadı:', e?.message));
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
