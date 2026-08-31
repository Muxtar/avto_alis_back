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

// Satıcının təsdiqdən SONRA malı yola salmaq üçün vaxtı (saat) — Setting
// `delivery_deadline_hours`, default 72 saat. 2..720 (30 gün) aralığında.
export async function getDeliveryDeadlineHours(): Promise<number> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: 'delivery_deadline_hours' } });
    const n = row ? parseFloat(row.value) : NaN;
    if (Number.isFinite(n) && n >= 2 && n <= 720) return n;
  } catch { /* keç */ }
  return Number(process.env.DELIVERY_DEADLINE_HOURS) || 72;
}

// Ödənilməmiş/tərk edilmiş kart checkout-u üçün vaxt (dəqiqə) — Setting
// `abandoned_checkout_minutes`, default 30. 5..1440 aralığında.
export async function getAbandonedCheckoutMinutes(): Promise<number> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: 'abandoned_checkout_minutes' } });
    const n = row ? parseFloat(row.value) : NaN;
    if (Number.isFinite(n) && n >= 5 && n <= 1440) return n;
  } catch { /* keç */ }
  return Number(process.env.ABANDONED_CHECKOUT_MINUTES) || 30;
}

// TƏRK EDİLMİŞ KART CHECKOUT-U — «olmayan sifarişlər»in kökü.
//
// Kartla ödəyəndə sifariş sətri alıcı bank səhifəsinə keçməzdən ƏVVƏL
// yaradılır. Alıcı ödəmədən çıxsa (pəncərəni bağladı, kart rədd etdi, geri
// döndü) sətir `status: PENDING` + `paymentStatus: PENDING/FAILED` olaraq
// ƏBƏDİ qalırdı. Alıcı üçün belə sifariş yoxdur — pul çıxmayıb; admin
// panelində isə «gözləmədə» kimi görünürdü və heç vaxt yox olmurdu.
//
// Belə sətirlər müəyyən müddətdən sonra ləğv edilir. Təhlükəsizdir:
//   • pul alınmayıb → qaytarılacaq bir şey yoxdur
//   • kartda stok yalnız ödəniş təsdiqində tutulur (stockCommitted) → stok azad
//   • satıcıya bildiriş getməyib (sellerNotifiedAt) → kimsə gözləmir
// Ödəniş gec gəlsə şlüz callback-ləri ləğv olunmuş sifariş üçün pulu
// avtomatik geri qaytarır (settleOrders / payment callback).
export async function expireAbandonedCheckouts(): Promise<number> {
  try {
    const minutes = await getAbandonedCheckoutMinutes();
    const cutoff = new Date(Date.now() - minutes * 60 * 1000);
    const r = await prisma.order.updateMany({
      where: {
        paymentMethod: 'CARD',
        status: 'PENDING',
        paymentStatus: { in: ['PENDING', 'FAILED'] },
        paidAt: null,
        stockCommitted: false,
        createdAt: { lt: cutoff },
      },
      data: { status: 'CANCELLED', confirmDeadline: null, deliveryDeadline: null },
    });
    if (r.count > 0) {
      console.log(`[orderExpiry] ${r.count} tərk edilmiş (ödənilməmiş) kart sifarişi ləğv edildi.`);
    }
    return r.count;
  } catch (e) {
    console.error('[orderExpiry] expireAbandonedCheckouts:', (e as any)?.message);
    return 0;
  }
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

// ── İLİŞİB QALMIŞ SİFARİŞLƏR ───────────────────────────────────────────────
//
// Satıcı təsdiqləyir, sonra heç nə olmur: kuryer tapılmır, Yango xəta verir,
// satıcı göndərmir. Alıcının pulu çəkilib, mal yoxdur, sifariş də ləğv olunmayıb —
// çünki ləğvi kimsə ƏL İLƏ etməlidir. Heç kim etməsə pul bizdə qalır.
//
// Bu funksiya həmin halı bağlayır:
//   • CONFIRMED, heç vaxt göndərilməyib, vaxt keçib → AVTOMATİK ləğv + pul geri
//   • SHIPPED, çatdırılmayıb, vaxt keçib → yalnız ADMİN İŞARƏSİ.
//     Göndərilmiş sifarişi avtomatik ləğv etmək təhlükəlidir: mal yolda və ya
//     artıq alıcıda ola bilər. Belə halda insan qərar verməlidir.
export async function expireUndeliveredOrders(): Promise<number> {
  let cancelled = 0;
  try {
    const now = new Date();

    // Bu düzəlişdən ƏVVƏL təsdiqlənmiş sifarişlərdə `deliveryDeadline` yoxdur —
    // nəzarətçi onları görməzdi və pul yenə ilişib qalardı. Onlara son tarix
    // İNDİDƏN verilir (yaradılma tarixindən yox): satıcı hazırda o sifarişlə
    // məşğul ola bilər, gözlənilmədən ləğv etmək düzgün olmazdı.
    const backfillHours = await getDeliveryDeadlineHours();
    await prisma.order.updateMany({
      where: { status: 'CONFIRMED', paymentStatus: 'PAID', paymentMethod: 'CARD', deliveryDeadline: null },
      data: { deliveryDeadline: new Date(now.getTime() + backfillHours * 3600 * 1000) },
    }).catch(() => {});

    // 1) Təsdiqlənib, amma yola düşməyib.
    const stuck = await prisma.order.findMany({
      where: {
        status: 'CONFIRMED', paymentStatus: 'PAID', paymentMethod: 'CARD',
        deliveryDeadline: { not: null, lt: now },
      },
      take: 100,
    });
    for (const order of stuck) {
      try {
        const r = await refundOrderSafe(order.id, 'CANCELLED', order.total);
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'CANCELLED', autoRefunded: r.ok, deliveryDeadline: null },
        });
        await restoreStockForOrder(order.id).catch(() => {});
        await recordSettlement(order.id).catch(() => {});
        await prisma.notification.create({
          data: {
            userId: order.buyerId, type: 'ORDER', title: `Sifariş #${order.id}`,
            body: r.ok
              ? 'Sifariş vaxtında göndərilmədiyi üçün ləğv edildi və ödənişiniz geri qaytarıldı.'
              : 'Sifariş vaxtında göndərilmədiyi üçün ləğv edildi. Ödənişin qaytarılması emal olunur.',
            link: '/orders',
          },
        }).catch(() => {});
        await prisma.notification.create({
          data: {
            userId: order.sellerId, type: 'ORDER', title: `Sifariş #${order.id}`,
            body: 'Sifariş vaxtında göndərilmədiyi üçün avtomatik ləğv edildi və ödəniş alıcıya qaytarıldı.',
            link: '/orders?tab=selling',
          },
        }).catch(() => {});
        cancelled++;
      } catch (e) {
        console.error(`[orderExpiry] ilişmiş sifariş #${order.id}:`, (e as any)?.message);
      }
    }

    // 2) Göndərilib, amma çatdırılmayıb — yalnız bir dəfə admin işarəsi.
    const late = await prisma.order.findMany({
      where: {
        status: 'SHIPPED', paymentStatus: 'PAID',
        deliveryDeadline: { not: null, lt: now },
        stuckFlaggedAt: null,
      },
      take: 50,
    });
    if (late.length) {
      const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true }, take: 20 });
      for (const order of late) {
        for (const a of admins) {
          await prisma.notification.create({
            data: {
              userId: a.id, type: 'ORDER', title: '⚠️ Çatdırılmayan sifariş',
              body: `Sifariş #${order.id} (${order.total.toFixed(2)} AZN) göndərilib, amma vaxtında çatdırılmayıb. Yoxlayın — pul alıcıya qaytarılmalı ola bilər.`,
              link: '/admin/orders',
            },
          }).catch(() => {});
        }
        await prisma.order.update({ where: { id: order.id }, data: { stuckFlaggedAt: now } }).catch(() => {});
      }
      console.log(`[orderExpiry] ${late.length} çatdırılmayan sifariş admin üçün işarələndi.`);
    }

    if (cancelled) console.log(`[orderExpiry] ${cancelled} ilişmiş sifariş ləğv edilib pulu qaytarıldı.`);
  } catch (e) { console.error('[orderExpiry] expireUndeliveredOrders:', (e as any)?.message); }
  return cancelled;
}

// Server başlayanda periodik yoxlama qur (hər 10 dəqiqə) + dərhal bir dəfə.
export function startOrderExpiryJob() {
  const run = () => {
    // Ödənilməmiş, tərk edilmiş kart sifarişlərini təmizlə — admin panelində
    // «olmayan sifariş gözləmədə» kimi qalmasınlar.
    expireAbandonedCheckouts().catch(() => {});
    expireUnconfirmedOrders().catch(() => {});
    // Təsdiqlənib, amma göndərilməyən sifarişlər — pul alıcıda ilişib qalmasın.
    expireUndeliveredOrders().catch(() => {});
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
