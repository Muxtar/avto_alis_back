// Satıcı təsdiqi axını — kartla ödənilmiş sifariş satıcı təsdiqini gözləyir.
// Satıcı müəyyən müddət ərzində təsdiqləməzsə pul AVTOMATİK alıcıya qaytarılır.
import { PrismaClient } from '@prisma/client';
import { refundOrderSafe, retryFailedRefunds, unstickPendingRefunds, restoreStockForOrder } from './refunds';
import { recordSettlement, releaseHeldLedgers } from './settlement';
import { endExpiredConsultations } from '../routes/consultations';

const prisma = new PrismaClient();

// Satıcının təsdiq üçün vaxtı (saat) — admin Setting `seller_confirm_hours`,
// default 24 saat. 1..168 (1 həftə) aralığında.
export async function getSellerConfirmHours(): Promise<number> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: 'seller_confirm_hours' } });
    const n = row ? parseFloat(row.value) : NaN;
    if (Number.isFinite(n) && n >= 1 && n <= 168) return n;
  } catch { /* keç */ }
  return Number(process.env.SELLER_CONFIRM_HOURS) || 24;
}

// Kartla ödənilən (gateway) sifarişlər PAID olanda çağırılır: təsdiq son vaxtını
// təyin edir. Yalnız hələ PENDING olan və deadline təyin olunmamış sifarişlərə.
export async function markOrdersAwaitingConfirm(orderIds: number[]): Promise<void> {
  if (!orderIds.length) return;
  try {
    const hours = await getSellerConfirmHours();
    const now = new Date();
    const deadline = new Date(now.getTime() + hours * 3600 * 1000);
    await prisma.order.updateMany({
      where: { id: { in: orderIds }, status: 'PENDING', paymentStatus: 'PAID', paymentMethod: 'CARD', confirmDeadline: null },
      data: { paidAt: now, confirmDeadline: deadline },
    });
  } catch (e) { console.error('[orderExpiry] markOrdersAwaitingConfirm:', (e as any)?.message); }
}

// Vaxtı keçmiş, satıcı təsdiqləməyən kart sifarişlərini avtomatik geri ödə + ləğv et.
export async function expireUnconfirmedOrders(): Promise<number> {
  let done = 0;
  try {
    const now = new Date();
    const expired = await prisma.order.findMany({
      where: {
        status: 'PENDING', paymentStatus: 'PAID', paymentMethod: 'CARD',
        confirmDeadline: { not: null, lt: now },
      },
      include: { items: true },
      take: 100,
    });
    for (const order of expired) {
      try {
        // 1) Pulun qaytarılması — ortaq servis (qeyd + təkrar cəhd + qıfıl).
        //    Uğursuz olsa sifariş yenə ləğv edilir, amma sətir FAILED qalır və
        //    fon işi təkrar cəhd edir; admin panelində görünür.
        const r = await refundOrderSafe(order.id, 'TIMEOUT', order.total);
        // 2) Sifarişi ləğv et. `paymentStatus`-a burada TOXUNMURUQ — onu
        //    yalnız qaytarma servisi (həqiqətən baş tutanda) dəyişir.
        //    Əvvəl burada "REFUNDED" yazılırdı və qaytarma alınmasa belə
        //    sifariş geri ödənilmiş kimi görünürdü.
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'CANCELLED', autoRefunded: r.ok },
        });
        // 3) Stok bərpası — qaytarmanın nəticəsindən asılı deyil.
        await restoreStockForOrder(order.id).catch(() => {});
        // 4) Satıcı hesablaşmasını geri al.
        await recordSettlement(order.id).catch(() => {});
        // 5) Bildirişlər.
        // Alıcıya yalnız BAŞ TUTAN qaytarma barədə "pulunuz qaytarıldı" deyilir.
        // Uğursuz halda bildirişi qaytarma servisi (admin xəbərdarlığı) idarə edir —
        // olmayan qaytarma barədə alıcıya yalan məlumat verilməməlidir.
        if (r.ok) {
          await prisma.notification.create({ data: { userId: order.buyerId, type: 'ORDER', title: `Sifariş #${order.id}`, body: 'Satıcı vaxtında təsdiqləmədiyi üçün ödənişiniz avtomatik geri qaytarıldı.', link: '/orders' } }).catch(() => {});
        } else {
          await prisma.notification.create({ data: { userId: order.buyerId, type: 'ORDER', title: `Sifariş #${order.id}`, body: 'Sifariş ləğv edildi. Ödənişin qaytarılması emal olunur — qısa müddətdə hesabınıza qayıdacaq.', link: '/orders' } }).catch(() => {});
        }
        await prisma.notification.create({ data: { userId: order.sellerId, type: 'ORDER', title: `Sifariş #${order.id}`, body: 'Vaxtında təsdiqlənmədiyi üçün sifariş ləğv edildi və ödəniş alıcıya qaytarıldı.', link: '/orders?tab=selling' } }).catch(() => {});
        done++;
      } catch (e) {
        console.error(`[orderExpiry] sifariş #${order.id} refund alınmadı:`, (e as any)?.message);
      }
    }
    if (done) console.log(`[orderExpiry] ${done} təsdiqlənməmiş sifariş avtomatik geri ödənildi.`);
  } catch (e) { console.error('[orderExpiry] expireUnconfirmedOrders:', (e as any)?.message); }
  return done;
}

// Server başlayanda periodik yoxlama qur (hər 10 dəqiqə) + dərhal bir dəfə.
export function startOrderExpiryJob() {
  const run = () => {
    expireUnconfirmedOrders().catch(() => {});
    // Yarımçıq qalmış qaytarma qıfıllarını aç, sonra uğursuzları təkrar cəhd et.
    // Alıcının pulu şlüzün müvəqqəti nasazlığına görə bizdə qalmasın.
    unstickPendingRefunds().then(() => retryFailedRefunds()).catch(() => {});
    // Alıcı müdafiəsi pəncərəsi bitmiş hesablaşmaları ödənilə bilən et.
    releaseHeldLedgers().catch(() => {});
    // Vaxtı bitmiş konsultasiya seanslarını bağla (rəy/şikayət açılsın).
    endExpiredConsultations().catch(() => {});
  };
  setTimeout(run, 30 * 1000);              // start-dan 30 san sonra ilk yoxlama
  setInterval(run, 10 * 60 * 1000);        // sonra hər 10 dəqiqə
  console.log('[orderExpiry] satıcı təsdiqi timeout + hesablaşma buraxılışı aktivdir (hər 10 dəq).');
}
