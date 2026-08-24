// PULUN GERİ QAYTARILMASI — bütün yollar üçün TƏK giriş nöqtəsi.
//
// Sifariş ləğv edilə bilər: satıcı malı verə bilmir, kuryer tapılmır, alıcı
// fikrini dəyişir, satıcı vaxtında təsdiqləmir. Kartla ödənilibsə pul artıq
// çəkilib və GERİ QAYTARILMALIDIR.
//
// Əvvəl bu, hər yerdə ayrıca `try { refund } catch { console.error }` idi.
// Şlüz sorğusu uğursuz olanda:
//   • sifariş yenə də LƏĞV olunurdu,
//   • `paymentStatus` PAID qalırdı (yəni adi ödənilmiş sifarişdən seçilmirdi),
//   • nə alıcıya, nə admin-ə xəbər gedirdi, nə də təkrar cəhd olurdu.
// Alıcının pulu sistemdə itirdi. Bu fayl həmin boşluğu bağlayır.
//
// Zəmanətlər:
//   1. İKİQAT QAYTARMA OLMUR — RefundAttempt.orderId unikaldır və şlüzə
//      müraciətdən ƏVVƏL yazılır; ikinci sorğu qıfıla dəyib qayıdır.
//      (Bunsuz iki ləğv sorğusu eyni anda gəlsə pul iki dəfə qaytarılardı.)
//   2. UĞURSUZLUQ İTMİR — sətir FAILED qalır, fon işi təkrar cəhd edir,
//      admin panelində görünür.
//   3. NAĞD sifariş şlüzə göndərilmir — qaytaracaq pul yoxdur.

import { PrismaClient } from '@prisma/client';
import { refundOrder as gatewayRefundOrder, activeProvider } from './paymentGateway';

const prisma = new PrismaClient();

export type RefundReason = 'CANCELLED' | 'TIMEOUT' | 'RETURN' | 'ADMIN';

export interface RefundResult {
  ok: boolean;
  /** Şlüzə heç müraciət olunmadı: nağd sifariş, ödənilməyib və ya artıq qaytarılıb. */
  skipped?: 'NOT_PAID' | 'NO_GATEWAY' | 'ALREADY_REFUNDED' | 'IN_PROGRESS';
  error?: string;
}

// Neçə dəfə avtomatik təkrar cəhd ediləcək. Bundan sonra admin əl ilə həll edir
// (məs. bank köçürməsi) və sətri "həll olundu" işarələyir.
const MAX_ATTEMPTS = 5;

/**
 * Sifarişin pulunu alıcıya qaytar. İdempotentdir — təkrar çağırmaq təhlükəsizdir.
 * Sifarişin statusunu DƏYİŞMİR (ləğv qərarını çağıran tərəf verir); yalnız
 * ödəniş tərəfini idarə edir.
 */
export async function refundOrderSafe(
  orderId: number,
  reason: RefundReason,
  amount?: number,
): Promise<RefundResult> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return { ok: false, error: 'Sifariş tapılmadı' };

  // Qaytarılacaq pul varmı? QİSMƏN iadə nəzərə alınır: sifarişin qalıq
  // (hələ qaytarılmamış) məbləği hesablanır. Əvvəl yalnız `paymentStatus`
  // yoxlanılırdı — bir məhsul qaytarılan kimi sifariş REFUNDED olur və
  // ikinci qismən iadə heç vaxt icra olunmurdu.
  const alreadyRefunded = order.refundedAmount || 0;
  const remaining = Math.round((order.total - alreadyRefunded) * 100) / 100;
  if (order.paymentStatus === 'REFUNDED' || remaining <= 0.009) return { ok: true, skipped: 'ALREADY_REFUNDED' };
  if (order.paymentStatus !== 'PAID') return { ok: true, skipped: 'NOT_PAID' };
  if (!order.gatewayRef && !order.gatewayOrderId) return { ok: true, skipped: 'NO_GATEWAY' }; // nağd
  // Qalıqdan çox qaytarmırıq (səhv/ikiqat tələb qorunması).
  const sum = Math.round(Math.min(amount ?? remaining, remaining) * 100) / 100;
  if (sum <= 0.009) return { ok: true, skipped: 'ALREADY_REFUNDED' };

  // ── QIFIL: şlüzə müraciətdən ƏVVƏL sətri yarat ──
  // orderId unikal olduğu üçün ikinci paralel sorğu burada dayanır.
  let claimed = false;
  try {
    await prisma.refundAttempt.create({
      data: { orderId, amount: sum, reason, status: 'PENDING', provider: activeProvider() },
    });
    claimed = true;
  } catch {
    // Sətir artıq var — ya bitib, ya da təkrar cəhddir.
    const existing = await prisma.refundAttempt.findUnique({ where: { orderId } });
    if (existing?.status === 'PENDING') return { ok: false, skipped: 'IN_PROGRESS', error: 'Qaytarma artıq gedir' };
    // DONE olsa belə sifarişdə qalıq varsa NÖVBƏTİ qismən iadəyə icazə verilir
    // (sətir yenidən PENDING olur; `amount` cari cəhdin məbləğidir).
    await prisma.refundAttempt.update({
      where: { orderId },
      data: { status: 'PENDING', amount: sum, reason, doneAt: null, lastError: null },
    });
    claimed = true;
  }
  if (!claimed) return { ok: false, error: 'Qaytarma başladıla bilmədi' };

  try {
    await gatewayRefundOrder(order as any, sum);
    const totalRefunded = Math.round((alreadyRefunded + sum) * 100) / 100;
    const fullyRefunded = totalRefunded >= Math.round(order.total * 100) / 100 - 0.009;
    await prisma.$transaction([
      prisma.order.update({
        where: { id: orderId },
        data: {
          refundedAmount: totalRefunded,
          // Yalnız TAM qaytarılanda status dəyişir; qismən halda sifariş
          // "ödənilmiş" qalır ki, satıcı qalan malların pulunu itirməsin.
          ...(fullyRefunded ? { paymentStatus: 'REFUNDED' as const, gatewayStatus: 'Refunded' } : { gatewayStatus: 'PartiallyRefunded' }),
        },
      }),
      prisma.refundAttempt.update({
        where: { orderId },
        data: { status: 'DONE', doneAt: new Date(), lastError: null, attempts: { increment: 1 } },
      }),
    ]);
    await prisma.notification.create({
      data: {
        userId: order.buyerId, type: 'ORDER', title: `Sifariş #${orderId}`,
        body: `Ödənişiniz geri qaytarıldı — ${sum.toFixed(2)} AZN. Bankdan hesabınıza düşməsi bir neçə iş günü çəkə bilər.`,
        link: '/orders',
      },
    }).catch(() => {});
    return { ok: true };
  } catch (e: any) {
    const msg = String(e?.message || 'Şlüz xətası').slice(0, 500);
    const row = await prisma.refundAttempt.update({
      where: { orderId },
      data: { status: 'FAILED', lastError: msg, attempts: { increment: 1 } },
    }).catch(() => null);
    console.error(`[refund] sifariş #${orderId} qaytarıla bilmədi (cəhd ${row?.attempts ?? '?'}): ${msg}`);
    // Cəhdlər tükənibsə adminləri xəbərdar et — pul alıcıda deyil, bizdədir.
    if ((row?.attempts ?? 0) >= MAX_ATTEMPTS) await notifyAdmins(orderId, sum, msg).catch(() => {});
    return { ok: false, error: msg };
  }
}

// Uğursuz qaytarmaları təkrar cəhd et (fon işi çağırır).
export async function retryFailedRefunds(): Promise<number> {
  let done = 0;
  const rows = await prisma.refundAttempt.findMany({
    where: { status: 'FAILED', attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { updatedAt: 'asc' },
    take: 25,
  }).catch(() => []);
  for (const r of rows) {
    const res = await refundOrderSafe(r.orderId, r.reason as RefundReason, r.amount).catch(() => null);
    if (res?.ok) done++;
  }
  if (done) console.log(`[refund] ${done} uğursuz qaytarma təkrar cəhddə uğurla bitdi.`);
  return done;
}

// PENDING sətir asılı qalıbsa (proses ölüb) 15 dəqiqədən sonra FAILED et ki,
// təkrar cəhd mexanizmi onu götürə bilsin — əks halda qıfıl əbədi bağlı qalar.
export async function unstickPendingRefunds(): Promise<void> {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  await prisma.refundAttempt.updateMany({
    where: { status: 'PENDING', updatedAt: { lt: cutoff } },
    data: { status: 'FAILED', lastError: 'Cəhd yarımçıq qaldı (server yenidən başladı?)' },
  }).catch(() => {});
}

// Ləğv olunmuş sifarişin stokunu geri qaytar. Ödənişdən ASILI DEYİL —
// əvvəl stok bərpası qaytarma try-blokunun içində idi: şlüz xəta versə
// məhsul anbara qayıtmırdı və nağd sifarişlərdə heç vaxt qayıtmırdı.
export async function restoreStockForOrder(orderId: number): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { stockCommitted: true } });
  if (!order?.stockCommitted) return;
  const items = await prisma.orderItem.findMany({ where: { orderId }, select: { listingId: true, quantity: true } });
  for (const it of items) {
    await prisma.listing.update({ where: { id: it.listingId }, data: { stock: { increment: it.quantity } } }).catch(() => {});
  }
  // İki dəfə artırılmasın.
  await prisma.order.update({ where: { id: orderId }, data: { stockCommitted: false } }).catch(() => {});
}

async function notifyAdmins(orderId: number, amount: number, error: string): Promise<void> {
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true }, take: 20 });
  for (const a of admins) {
    await prisma.notification.create({
      data: {
        userId: a.id, type: 'ORDER', title: '⚠️ Pul qaytarıla bilmədi',
        body: `Sifariş #${orderId} — ${amount.toFixed(2)} AZN alıcıya qaytarılmadı. Səbəb: ${error}. Əl ilə həll edin.`,
        link: '/admin/refunds',
      },
    }).catch(() => {});
  }
}
