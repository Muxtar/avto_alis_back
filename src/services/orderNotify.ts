// Satıcıya «yeni sifariş» bildirişi — DÜZGÜN ANDA, BİR DƏFƏ.
//
// Əvvəl bildiriş sifariş sətri yaradılan anda, ödəniş metodundan asılı
// olmayaraq göndərilirdi. Kartla ödəyən alıcı «Sifarişi tamamla» düyməsinə
// basan kimi (hələ bank səhifəsinə keçməmiş) satıcıya «Sizə yeni sifariş
// gəldi» düşürdü. Alıcı ödəmədən çıxsa satıcı olmayan sifarişi gözləyirdi.
//
// İndi: NAĞD/BALANS — dərhal (pul sonra alınsa da sifariş həqiqidir),
// KART — yalnız ödəniş təsdiqlənəndə.
import { PrismaClient } from '@prisma/client';
import { emitToUser } from './callSignaling';

const prisma = new PrismaClient();

/**
 * Verilmiş sifarişlər üçün satıcıya bildiriş göndərir.
 *
 * İDEMPOTENT: `sellerNotifiedAt` boş olan sətirlər atomik şəkildə işarələnir
 * və bildiriş yalnız həqiqətən işarələnənlərə göndərilir. Şlüz callback-i ilə
 * status sorğusu eyni sifarişi iki dəfə settle etsə belə satıcı bir bildiriş
 * alır.
 */
export async function notifySellersNewOrder(orderIds: number[]): Promise<void> {
  const ids = [...new Set(orderIds.filter((n) => Number.isFinite(n)))];
  if (!ids.length) return;
  try {
    // Yalnız hələ xəbər verilməmiş və LƏĞV OLUNMAMIŞ sifarişlər.
    const targets = await prisma.order.findMany({
      where: { id: { in: ids }, sellerNotifiedAt: null, status: { not: 'CANCELLED' } },
      select: { id: true, sellerId: true, total: true },
    });
    if (!targets.length) return;

    // Əvvəlcə işarələ, sonra göndər: eyni anda iki callback gəlsə yalnız biri
    // sətirləri tutur (updateMany şərti `sellerNotifiedAt: null`-dır).
    const claimed: typeof targets = [];
    for (const o of targets) {
      const r = await prisma.order.updateMany({
        where: { id: o.id, sellerNotifiedAt: null },
        data: { sellerNotifiedAt: new Date() },
      });
      if (r.count > 0) claimed.push(o);
    }
    if (!claimed.length) return;

    await prisma.notification.createMany({
      data: claimed.map((o) => ({
        userId: o.sellerId,
        type: 'ORDER',
        title: 'Yeni sifariş',
        body: `Sifariş #${o.id} — ${o.total.toFixed(2)} AZN. Ödəniş təsdiqləndi, təsdiqinizi gözləyir.`,
        link: '/orders?tab=selling',
      })),
    }).catch(() => {});

    for (const o of claimed) {
      emitToUser(o.sellerId, 'order:new', { orderId: o.id, total: o.total });
    }
  } catch (e) {
    console.error('[orderNotify] notifySellersNewOrder:', (e as any)?.message);
  }
}
