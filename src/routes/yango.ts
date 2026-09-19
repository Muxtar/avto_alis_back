import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { emitToUser } from '../services/callSignaling';
import { pushLive } from '../services/live';
import { recordSettlement } from '../services/settlement';
import { refundOrderSafe, restoreStockForOrder } from '../services/refunds';
import {
  isYangoConfigured, checkPrice, createClaim, acceptClaim, getClaimInfo,
  getPerformerPosition, getCancelInfo, cancelClaim, mapYangoStatus, YANGO_MAX_WEIGHT_KG, type Geo,
  getTrackingLinks, toE164, getPointsEta, getDriverPhone, YANGO_DEAD,
} from '../services/yangoDelivery';

const router = Router();
const prisma = new PrismaClient();

const orderInclude = {
  items: { include: { listing: { include: { businessObject: true } } } },
  buyer: { select: { id: true, name: true, phone: true } },
  seller: { select: { id: true, name: true, phone: true, latitude: true, longitude: true, address: true } },
};

// ═══════════════════════════════════════════════════════════════════════════
// YANGO STATUSU → SİFARİŞİN HƏYAT DÖVRÜ
//
// Yango statusu dəyişəndə sifarişdə nə baş verməlidir. Status sorğusu,
// webhook və fon izləyicisi hamısı BUNU çağırır — hər dəfə eyni status ilə də
// çağırıla bilər, ona görə hər addım `updateMany` şərti ilə YALNIZ BİR DƏFƏ
// icra olunur (təkrar bildiriş, təkrar qaytarma olmur).
//
//   kuryer tapıldı … mağazada      → sifariş CONFIRMED qalır
//   pickuped / yolda / ünvanda     → SHIPPED + alıcıya "yoldadır"
//   delivered                      → DELIVERED + satıcı hesablaşması + bildiriş
//   returning (alıcı qəbul etmədi) → hər iki tərəfə "məhsul geri qaytarılır"
//   returned (mal satıcıdadır)     → sifariş LƏĞV + stok + pul geri + bildiriş
//   kuryer tapılmadı / ləğv        → sifariş qalır, satıcı yenidən çağırır
//   cancelled_with_items_on_hands  → mal kuryerdədir: satıcı + admin xəbərdar
//
// ƏVVƏLKİ PROBLEMLƏR (hamısı burada bağlanır):
//   • Yango "çatdırıldı" deyəndə satıcı hesablaşması (recordSettlement)
//     çağırılmırdı — satıcının pulu «gözləmədə» qalıb heç vaxt açılmırdı.
//   • Alıcı imtina edəndə mal satıcıya qayıdırdı, sifariş isə sonsuza qədər
//     SHIPPED qalırdı: pul qaytarılmır, stok bərpa olunmur, heç kim bilmir.
//   • «Kuryer tapılmadı» satıcıya bildirilmirdi.
// ═══════════════════════════════════════════════════════════════════════════
const RANK: Record<string, number> = { PENDING: 0, CONFIRMED: 1, SHIPPED: 2, DELIVERED: 3, CANCELLED: 3 };
const RETURNING = ['returning', 'return_arrived', 'ready_for_return_confirmation'];
const RETURNED = ['returned', 'returned_finish'];
// Kuryer mal götürmədən çatdırılma dağıldı — sifariş qalır, yeni kuryer çağırılır.
const FAILED_BEFORE_PICKUP: Record<string, string> = {
  performer_not_found: 'Kuryer tapılmadı — yenidən kuryer çağırın və ya özünüz çatdırın.',
  estimating_failed: 'Yango çatdırılmanı hesablaya bilmədi (ünvan və ya çəki) — yenidən cəhd edin və ya özünüz çatdırın.',
  cancelled: 'Çatdırılma ləğv edildi — yeni kuryer çağıra bilərsiniz.',
  cancelled_by_taxi: 'Kuryer sifarişdən imtina etdi — yeni kuryer çağırın.',
  cancelled_with_payment: 'Çatdırılma ləğv edildi — yeni kuryer çağıra bilərsiniz.',
  failed: 'Çatdırılma uğursuz oldu — yeni kuryer çağırın və ya özünüz çatdırın.',
};
const MSG_RETURNING = 'Alıcı məhsulu qəbul etmədi — kuryer məhsulu satıcıya qaytarır.';
const MSG_ITEMS_ON_HANDS = 'Çatdırılma ləğv olundu, məhsul KURYERDƏDİR — Yango dəstəyi ilə əlaqə saxlayın.';

const notify = (userId: number, orderId: number, body: string, link = '/orders') =>
  prisma.notification.create({ data: { userId, type: 'ORDER', title: `Sifariş #${orderId}`, body, link } }).catch(() => {});

/** yangoError-u bir dəfə yazır; ilk dəfə yazıldısa true (bildiriş göndərmək üçün). */
async function markOnce(orderId: number, msg: string): Promise<boolean> {
  const r = await prisma.order.updateMany({
    where: { id: orderId, OR: [{ yangoError: null }, { yangoError: { not: msg } }] },
    data: { yangoError: msg },
  }).catch(() => ({ count: 0 }));
  return r.count > 0;
}

async function syncOrderStatus(orderId: number, _current: string, yangoStatus: string) {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, buyerId: true, sellerId: true, paymentStatus: true, referrerId: true, referralVoided: true },
  });
  if (!o || o.status === 'DELIVERED' || o.status === 'CANCELLED') return;   // terminal

  // ── Çatdırıldı ──
  if (mapYangoStatus(yangoStatus) === 'DELIVERED') {
    const r = await prisma.order.updateMany({
      where: { id: orderId, status: { in: ['PENDING', 'CONFIRMED', 'SHIPPED'] } },
      data: { status: 'DELIVERED', deliveryDeadline: null, yangoError: null },
    });
    if (r.count > 0) {
      await recordSettlement(orderId).catch(() => {});   // satıcının qazancı saxlama pəncərəsinə düşür
      await notify(o.buyerId, orderId, 'Sifarişiniz çatdırıldı ✓ Satıcıya rəy yaza bilərsiniz.');
      await notify(o.sellerId, orderId, 'Yango kuryeri sifarişi alıcıya təhvil verdi ✓', '/orders?tab=selling');
    }
    return;
  }

  // ── Alıcı qəbul etmədi, mal geri gedir ──
  if (RETURNING.includes(yangoStatus)) {
    if (await markOnce(orderId, MSG_RETURNING)) {
      await notify(o.sellerId, orderId, 'Alıcı məhsulu qəbul etmədi (və ya ünvanda tapılmadı). Kuryer məhsulu sizə geri gətirir — təhvil alanda sifariş avtomatik ləğv olunacaq.', '/orders?tab=selling');
      await notify(o.buyerId, orderId, 'Məhsul sizə təhvil verilmədi və satıcıya qaytarılır. Məhsul satıcıya çatan kimi sifariş ləğv olunacaq və ödənişiniz qaytarılacaq.');
    }
    return;
  }

  // ── Mal satıcıya qayıtdı → sifarişi bağla, pulu qaytar ──
  if (RETURNED.includes(yangoStatus)) {
    const r = await prisma.order.updateMany({
      where: { id: orderId, status: { in: ['PENDING', 'CONFIRMED', 'SHIPPED'] } },
      data: { status: 'CANCELLED', deliveryDeadline: null, yangoError: 'Məhsul satıcıya qaytarıldı — sifariş ləğv edildi.' },
    });
    if (r.count > 0) {
      await restoreStockForOrder(orderId).catch(() => {});
      const ref = await refundOrderSafe(orderId, 'CANCELLED');
      if (o.referrerId && !o.referralVoided) {
        await prisma.order.update({ where: { id: orderId }, data: { referralVoided: true } }).catch(() => {});
      }
      await recordSettlement(orderId).catch(() => {});
      await notify(o.sellerId, orderId, 'Məhsul sizə geri qaytarıldı — sifariş ləğv edildi, stok bərpa olundu.', '/orders?tab=selling');
      await notify(o.buyerId, orderId, o.paymentStatus === 'PAID'
        ? (ref.ok ? 'Sifariş ləğv edildi və ödənişiniz geri qaytarıldı.' : 'Sifariş ləğv edildi. Ödənişin qaytarılması emal olunur.')
        : 'Sifariş ləğv edildi.');
    }
    return;
  }

  // ── Mal kuryerdə qaldı (ləğv) — insan həll etməlidir ──
  if (yangoStatus === 'cancelled_with_items_on_hands') {
    if (await markOnce(orderId, MSG_ITEMS_ON_HANDS)) {
      await notify(o.sellerId, orderId, 'Yango çatdırılmanı ləğv etdi, amma məhsul kuryerdədir. Yango dəstəyi ilə əlaqə saxlayın; məhsul sizə qayıdandan sonra sifarişi ləğv edin.', '/orders?tab=selling');
      await notify(o.buyerId, orderId, 'Çatdırılmada problem yarandı — satıcı Yango ilə həll edir. Sifariş çatdırılmasa ləğv olunub ödənişiniz qaytarılacaq.');
      const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true }, take: 20 });
      for (const a of admins) await notify(a.id, orderId, `⚠️ Yango ləğv etdi, məhsul kuryerdə qaldı (sifariş #${orderId}). Yoxlayın.`, '/admin/orders');
    }
    return;
  }

  // ── Kuryer mal götürmədən çatdırılma dağıldı ──
  const failMsg = FAILED_BEFORE_PICKUP[yangoStatus];
  if (failMsg) {
    if (await markOnce(orderId, failMsg)) {
      await notify(o.sellerId, orderId, failMsg, '/orders?tab=selling');
      await notify(o.buyerId, orderId, o.paymentStatus === 'PAID'
        ? 'Kuryer çatdırılması baş tutmadı. Satıcı yeni kuryer çağıracaq — gözləmək istəmirsinizsə sifarişi ləğv edib ödənişinizi geri ala bilərsiniz.'
        : 'Kuryer çatdırılması baş tutmadı. Satıcı yeni kuryer çağıracaq.');
    }
    return;
  }

  // ── İrəli hərəkət (kuryer tapıldı → CONFIRMED, götürdü → SHIPPED) ──
  const mapped = mapYangoStatus(yangoStatus);
  if (mapped && mapped !== 'CANCELLED' && (RANK[mapped] ?? 0) > (RANK[o.status] ?? 0)) {
    const r = await prisma.order.updateMany({
      where: { id: orderId, status: o.status },
      data: { status: mapped as any },
    }).catch(() => ({ count: 0 }));
    if (r.count > 0 && mapped === 'SHIPPED') {
      await notify(o.buyerId, orderId, 'Kuryer məhsulu götürdü — sifarişiniz yoldadır 🛵');
    }
  }
}

// ── Sifariş ləğv olunanda aktiv Yango çatdırılmasını da ləğv et ──
//
// Əvvəl sifariş (alıcı, satıcı, admin və ya vaxt aşımı ilə) ləğv olunurdu,
// Yango claim-i isə AKTİV qalırdı: kuryer yenə mağazaya gəlir, Yango pul
// tuturdu, pulu artıq qaytarılmış alıcıya mal gedə bilərdi.
// Kuryer malı artıq götürübsə Yango ləğvə icazə vermir — onda sifariş də
// ləğv edilməməlidir (çağıran tərəf `ok:false` alıb dayanır).
export async function cancelActiveYangoClaim(orderId: number): Promise<{ ok: boolean; message?: string }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId }, select: { id: true, yangoClaimId: true, yangoStatus: true, yangoVersion: true },
  });
  if (!order?.yangoClaimId) return { ok: true };
  const info = await getClaimInfo(order.yangoClaimId);
  const st = String(info.data?.status || order.yangoStatus || '');
  if (YANGO_DEAD.includes(st) || ['delivered', 'delivered_finish'].includes(st)) return { ok: true };
  if (['pickuped', 'delivery_arrived', 'ready_for_delivery_confirmation', ...RETURNING].includes(st)) {
    return { ok: false, message: 'Kuryer məhsulu artıq götürüb — sifarişi indi ləğv etmək olmaz. Çatdırılmanı gözləyin və ya Yango dəstəyi ilə əlaqə saxlayın.' };
  }
  const ci = await getCancelInfo(order.yangoClaimId);
  const state = ci.data?.cancel_state;
  if (state === 'unavailable') {
    return { ok: false, message: 'Yango bu mərhələdə çatdırılmanın ləğvinə icazə vermir — Yango dəstəyi ilə əlaqə saxlayın.' };
  }
  const version = (info.data?.version as number) ?? order.yangoVersion ?? 1;
  const c = await cancelClaim(order.yangoClaimId, version, state === 'paid' ? 'paid' : 'free');
  if (!c.ok) return { ok: false, message: `Yango çatdırılması ləğv edilmədi: ${c.error || 'xəta'}` };
  await prisma.order.update({
    where: { id: orderId },
    data: { yangoStatus: (c.data?.status as string) || 'cancelled', courierLat: null, courierLng: null },
  }).catch(() => {});
  return { ok: true };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


// Yango axını: create → estimating → ready_for_approval → **accept** → performer_lookup.
//
// KUYRERİN GEC TAPILMASININ SƏBƏBİ BURADADIR. Claim yaradılan kimi accept
// çağırsaq, claim hələ `estimating` mərhələsindədir və Yango accept-i rədd edir.
// Əvvəl bu cavab yoxlanmırdı — nəticədə claim `ready_for_approval` vəziyyətində
// ilişib qalırdı və KURYER AXTARIŞI HEÇ BAŞLAMIRDI. Sifariş yalnız kimsə
// səhifəni açıb status sorğusu göndərəndə (və ya Yango öz-özünə təsdiqləyəndə)
// hərəkətə gəlirdi — satıcıya bu, "kuryer çox gec tapılır" kimi görünürdü.
//
// İndi qiymətləndirmənin bitməsi gözlənilir və accept TƏZƏ versiya ilə edilir.
// Gözləmə qəsdən qısadır (default 6 s) — satıcı düyməyə basıb gözləyir, sorğu
// uzanarsa şlüz 502 verər. Qalanını fon təkrarı və status sorğusu tamamlayır.
async function acceptWhenReady(
  claimId: string,
  firstVersion: number,
  budgetMs = 6000,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const DONE = ['accepted', 'performer_lookup', 'performer_draft', 'performer_found', 'pickup_arrived', 'pickuped'];
  const started = Date.now();
  let version = firstVersion;
  let status = '';
  while (Date.now() - started < budgetMs) {
    const info = await getClaimInfo(claimId);
    status = String(info.data?.status || '');
    if (info.data?.version != null) version = info.data.version as number;
    if (DONE.includes(status)) return { ok: true, status };            // artıq təsdiqlənib
    if (status === 'estimating_failed') return { ok: false, error: 'Yango qiymətləndirə bilmədi — ünvan və ya çəki uyğun deyil' };
    if (status === 'ready_for_approval') {
      const acc = await acceptClaim(claimId, version);
      if (acc.ok) return { ok: true, status: (acc.data?.status as string) || 'accepted' };
      // Versiya köhnəlibsə növbəti dövrədə təzəsi ilə yenidən cəhd edilir.
      if (Date.now() - started >= budgetMs) return { ok: false, error: acc.error || 'Yango claim təsdiqlənmədi' };
    }
    // Büdcəni aşmayaq — satıcı düymənin altında gözləyir.
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) break;
    await sleep(Math.min(1200, left));
  }
  return { ok: false, status, error: `Yango hələ hazır deyil (status: ${status || 'bilinmir'})` };
}

// Fon təkrarı — qısa gözləmə çatmasa, sorğunu bloklamadan bir neçə dəfə də cəhd
// edilir. Beləliklə heç kim səhifə açmasa belə kuryer axtarışı başlayır.
function retryAcceptInBackground(orderId: number, claimId: string, version: number) {
  let attempt = 0;
  const tick = async () => {
    attempt++;
    const r = await acceptWhenReady(claimId, version, 8000).catch(() => ({ ok: false } as any));
    if (r.ok) {
      await prisma.order.update({ where: { id: orderId }, data: { yangoStatus: r.status || 'accepted', yangoError: null } }).catch(() => {});
      return;
    }
    if (attempt < 6) setTimeout(tick, 15000); // ~1.5 dəqiqə ərzində 6 cəhd
    else await prisma.order.update({ where: { id: orderId }, data: { yangoError: r.error || 'Yango təsdiqi alınmadı' } }).catch(() => {});
  };
  setTimeout(tick, 5000);
}

// ── Ortaq: sifarişi Yango-ya göndər (claim yarat + təsdiqlə). Həm route, həm
//    avtomatik dispatch (satıcı təsdiqləyəndə) bunu çağırır. ──────────────────
export async function dispatchOrderToYango(orderId: number): Promise<{ ok: boolean; message?: string; claimId?: string; status?: string }> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) return { ok: false, message: 'Sifariş tapılmadı' };
  // Aktiv claim varsa təkrar göndərmirik. Amma claim ÖLÜdürsə (ləğv/uğursuz)
  // yenisi yaradılmalıdır — əvvəl burada köhnə claim qaytarılırdı və ləğvdən
  // sonra kuryeri yenidən çağırmaq MÜMKÜN DEYİLDİ: sifariş ortada ilişib qalırdı.
  const dead = YANGO_DEAD.includes(order.yangoStatus || '');
  if (order.yangoClaimId && !dead) return { ok: true, claimId: order.yangoClaimId, status: order.yangoStatus || undefined };
  if (order.status === 'CANCELLED' || order.status === 'DELIVERED') return { ok: false, message: 'Sifariş bağlanıb — kuryer çağırılmır' };
  // Bunlar əsl "Yango xətası" deyil — sifariş sadəcə Yango ilə deyil (səbəb yazılmır).
  if (order.deliveryType === 'PICKUP') return { ok: false, message: 'Götürmə sifarişi üçün kuryer lazım deyil' };
  if (order.deliveryMethod !== 'COURIER') return { ok: false, message: 'Bu sifariş Yango ilə deyil' };

  // Uğursuzluq səbəbini sifarişdə saxla (satıcıya göstərmək + təkrar cəhd üçün).
  const fail = async (message: string) => {
    console.error(`[yango] sifariş #${order.id} dispatch xətası: ${message}`);
    await prisma.order.update({ where: { id: order.id }, data: { yangoError: message } }).catch(() => {});
    return { ok: false as const, message };
  };

  // Token yoxdursa — COURIER sifariş üçün bunu ARTIQ səbəb kimi yaz (əvvəl səssiz idi).
  if (!isYangoConfigured()) return fail('Yango qoşulmayıb — YANGO_TOKEN Railway-də təyin edilməlidir.');

  const obj = order.items.map((i) => i.listing?.businessObject).find((o) => o && o.latitude != null && o.longitude != null);
  const srcLat = obj?.latitude ?? order.seller.latitude;
  const srcLng = obj?.longitude ?? order.seller.longitude;
  const srcAddr = obj?.address || order.seller.address || '';
  const srcName = obj?.name || order.seller.name || 'Satıcı';
  if (srcLat == null || srcLng == null) return fail('Obyektin/satıcının koordinatı yoxdur');
  if (order.latitude == null || order.longitude == null) return fail('Alıcı ünvanının koordinatı yoxdur');

  /* Nömrələr E.164-ə salınır. Yango boşluqlu («+994 50 000 00 00») və ya
     ölkə kodsuz («0501234567») nömrəyə `Invalid number length` qaytarır və
     claim ÜMUMİYYƏTLƏ yaranmır. Səhvi Yango-ya getməzdən ƏVVƏL tuturuq ki,
     satıcı anlaşılan mesaj görsün və hansı nömrənin düzəldiləcəyini bilsin. */
  const srcRaw = obj?.phone || order.seller.phone || '';
  const dstRaw = order.phone || order.buyer.phone || '';
  if (!srcRaw || !dstRaw) return fail('Göndərən və ya alıcı telefonu yoxdur');
  const srcPhone = toE164(srcRaw);
  const dstPhone = toE164(dstRaw);
  if (!srcPhone) {
    return fail(`Göndərənin telefon nömrəsi düzgün deyil: «${srcRaw}». Obyektin (və ya profilin) nömrəsini +994XXXXXXXXX formatında yazın.`);
  }
  if (!dstPhone) {
    return fail(`Alıcının telefon nömrəsi düzgün deyil: «${dstRaw}». Sifarişdəki əlaqə nömrəsi +994XXXXXXXXX formatında olmalıdır.`);
  }

  // Yük limiti — 50 kq-dan ağır sifariş Yango ilə göndərilə bilməz.
  const totalWeight = order.items.reduce((s, i) => s + i.quantity * ((i.listing as any)?.weightKg || 0), 0);
  if (totalWeight > YANGO_MAX_WEIGHT_KG) return fail(`Sifariş çəkisi ${totalWeight} kq — Yango limiti ${YANGO_MAX_WEIGHT_KG} kq`);

  // Cəhd nömrəsi. Yango eyni `request_id` ilə gələn sorğuya KÖHNƏ claim-i
  // qaytarır (təkrarlanmadan qorunma) — ləğvdən sonra eyni id işlədilsəydi
  // ləğv edilmiş claim geri gələrdi. Sayğac yalnız MÖVCUD claim varsa artır;
  // yaratma uğursuz olsa bazaya yazılmır, ona görə növbəti cəhd eyni id ilə
  // gedir və təkrar sorğu təhlükəsiz qalır.
  const attempt = order.yangoClaimId ? (order.yangoAttempt || 0) + 1 : (order.yangoAttempt || 0);
  const requestId = attempt === 0 ? `order-${order.id}` : `order-${order.id}-r${attempt}`;

  const claim = await createClaim({
    requestId,
    source: { fullname: srcAddr, coordinates: [srcLng, srcLat] as Geo, contact: { name: srcName, phone: srcPhone } },
    destination: { fullname: order.address || 'Çatdırılma ünvanı', coordinates: [order.longitude, order.latitude] as Geo, contact: { name: order.buyer.name || 'Alıcı', phone: dstPhone } },
    items: order.items.map((i) => ({ title: i.title, quantity: i.quantity, costValue: i.price.toFixed(2), costCurrency: 'AZN', weightKg: (i.listing as any)?.weightKg || 1 })),
    emergencyContact: { name: srcName, phone: srcPhone },
    comment: `tradixai sifariş #${order.id}`,
  });
  if (!claim.ok || !claim.data?.id) return fail(claim.error || 'Yango claim yaradıla bilmədi (kuryer tapılmadı ola bilər)');

  const claimId = claim.data.id as string;
  const version = (claim.data.version as number) ?? 1;
  // Təsdiq — kuryer axtarışını BU başladır. Nəticəsi yoxlanılır (əvvəl səssizcə
  // atılırdı və claim təsdiqsiz qalırdı).
  const acc = await acceptWhenReady(claimId, version);
  if (!acc.ok) retryAcceptInBackground(order.id, claimId, version);
  const info = await getClaimInfo(claimId);
  const status = info.data?.status || acc.status || claim.data.status || 'new';
  const price = info.data?.pricing?.offer?.price ? parseFloat(info.data.pricing.offer.price) : (order.deliveryFee || null);
  const currency = info.data?.pricing?.currency || order.yangoCurrency || 'AZN';

  await prisma.order.update({
    where: { id: order.id },
    data: {
      yangoClaimId: claimId, yangoStatus: status, yangoVersion: (info.data?.version as number) ?? version,
      yangoPrice: price, yangoCurrency: currency, yangoAttempt: attempt,
      // Köhnə kuryerin son mövqeyi qalmasın — xəritədə yanlış nöqtə göstərərdi.
      courierLat: null, courierLng: null,
      // Təsdiq alınmayıbsa səbəbi satıcıya göstərilir — sifariş səssizcə gözləməsin.
      yangoError: acc.ok ? null : (acc.error || null),
    },
  });
  return { ok: true, claimId, status };
}

// ── Qiymət təxmini (checkout-da göstərmək üçün) ───────────────────────────────
router.post('/yango/quote', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    // Səbəbi MÜTLƏQ qaytarılmalıdır: səbəbsiz `available:false` gələndə panel
    // "konum seçin" yazırdı və istifadəçi konumu onsuz da seçdiyi üçün nə
    // etməli olduğunu anlamırdı.
    if (!isYangoConfigured()) {
      res.json({ success: true, available: false, fee: 0, message: 'Yango inteqrasiyası hazırda aktiv deyil' });
      return;
    }
    const businessObjectId = req.body.businessObjectId ? parseInt(String(req.body.businessObjectId)) : null;
    const sellerId = req.body.sellerId ? parseInt(String(req.body.sellerId)) : null;
    const lat = req.body.latitude != null ? parseFloat(String(req.body.latitude)) : null;
    const lng = req.body.longitude != null ? parseFloat(String(req.body.longitude)) : null;
    if (lat == null || lng == null || (!businessObjectId && !sellerId)) { res.status(400).json({ success: false, message: 'Konum tələb olunur' }); return; }
    // Götürmə (pickup) yeri: biznes obyektinin koordinatı, yoxdursa satıcının profil konumu.
    let pickup: { latitude: number | null; longitude: number | null } | null = null;
    if (businessObjectId) {
      pickup = await prisma.businessObject.findUnique({ where: { id: businessObjectId }, select: { latitude: true, longitude: true } });
    } else if (sellerId) {
      pickup = await prisma.user.findUnique({ where: { id: sellerId }, select: { latitude: true, longitude: true } });
    }
    if (!pickup?.latitude || !pickup?.longitude) { res.json({ success: true, available: false, fee: 0, message: 'Satıcının/obyektin koordinatı yoxdur' }); return; }
    const q = await checkPrice({ source: [pickup.longitude, pickup.latitude], destination: [lng, lat], weightKg: req.body.weight ? parseFloat(String(req.body.weight)) : 1 });
    if (!q.ok || !q.data?.price) { res.json({ success: true, available: false, fee: 0, message: q.error }); return; }
    res.json({ success: true, available: true, fee: parseFloat(String(q.data.price)), currency: q.data.currency_rules?.code || 'AZN', eta: q.data.eta });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Satıcı: sifarişi Yango ilə göndər ─────────────────────────────────────────
router.post('/orders/:id/yango/dispatch', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const order = await prisma.order.findUnique({ where: { id }, select: { sellerId: true } });
    if (!order || order.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const r = await dispatchOrderToYango(id);
    if (!r.ok) { res.status(502).json({ success: false, message: r.message }); return; }
    res.json({ success: true, claimId: r.claimId, status: r.status });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Status + kuryer məlumatı (alıcı və ya satıcı) ─────────────────────────────
router.get('/orders/:id/yango/status', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true, buyerId: true, sellerId: true, status: true, yangoClaimId: true, yangoStatus: true } });
    if (!order || (order.buyerId !== req.adminId && order.sellerId !== req.adminId)) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (!order.yangoClaimId) { res.json({ success: true, dispatched: false }); return; }

    const info = await getClaimInfo(order.yangoClaimId);
    if (!info.ok || !info.data) { res.status(502).json({ success: false, message: info.error || 'Yango status alına bilmədi' }); return; }
    let status = info.data.status as string;
    let version = (info.data.version as number) ?? undefined;

    // ÖZÜNÜ SAĞALTMA: claim təsdiqsiz ilişibsə burada təsdiqlənir. Köhnə kodda
    // təsdiq nəticəsi yoxlanmadığı üçün belə sifarişlər bazada qalıb ola bilər —
    // satıcı səhifəni açan kimi kuryer axtarışı başlasın.
    if (status === 'ready_for_approval') {
      const acc = await acceptClaim(order.yangoClaimId, version ?? 1);
      if (acc.ok) {
        status = (acc.data?.status as string) || 'accepted';
        if (acc.data?.version != null) version = acc.data.version as number;
      }
    }

    // Kuryer aktiv mərhələ? (Wolt-tipli canlı izləmə/ETA bu mərhələdə lazımdır.)
    const ACTIVE = ['accepted', 'performer_found', 'performer_draft', 'pickup_arrived', 'ready_for_pickup_confirmation', 'pickuped', 'delivery_arrived', 'ready_for_delivery_confirmation'];
    const active = ACTIVE.includes(status);

    // Canlı GPS mövqeyi + izləmə linki + ETA-nı paralel al (aktiv mərhələdə).
    let courierPosition: any = null;
    let trackingUrl: string | null = null;
    let etaExpected: string | null = null;
    let etaSeconds: number | null = null;
    if (active) {
      const [pos, tl, eta] = await Promise.all([
        getPerformerPosition(order.yangoClaimId),
        getTrackingLinks(order.yangoClaimId),
        getPointsEta(order.yangoClaimId),
      ]);
      if (pos.ok && pos.data?.position?.lat != null && pos.data.position.lon != null) courierPosition = pos.data.position;
      // İzləmə linki — destination (təhvil) nöqtəsinin sharing_link-i.
      const destTl = (tl.data?.route_points || []).find((p: any) => p.type === 'destination' && p.sharing_link);
      trackingUrl = destTl?.sharing_link || null;
      // ETA — sonuncu (təhvil) nöqtəsinin gözlənilən çatma vaxtı.
      const pts = eta.data?.route_points || [];
      const destEta = pts.length ? pts[pts.length - 1] : null;
      etaExpected = destEta?.visited_at?.expected || null;
      if (etaExpected) etaSeconds = Math.max(0, Math.round((new Date(etaExpected).getTime() - Date.now()) / 1000));
    }

    // Təsdiq kodu artıq YOXDUR — kod xüsusiyyəti ləğv edilib (services/yangoDelivery.ts).

    await prisma.order.update({
      where: { id: order.id },
      data: {
        yangoStatus: status,
        ...(version != null ? { yangoVersion: version } : {}),
        ...(courierPosition ? { courierLat: courierPosition.lat, courierLng: courierPosition.lon } : {}),
      },
    }).catch(() => {});
    await syncOrderStatus(order.id, order.status, status);

    // Status dəyişibsə — alıcı və satıcıya real-time bildiriş (hansı səhifədə olsa da).
    if (status && status !== order.yangoStatus) {
      const payload = { orderId: order.id, yangoStatus: status };
      emitToUser(order.buyerId, 'order:yango', payload);
      emitToUser(order.sellerId, 'order:yango', payload);
      pushLive([order.buyerId, order.sellerId], { kind: 'order', id: order.id });
    }

    res.json({
      success: true, dispatched: true, status,
      performer: info.data.performer_info || null,
      courierPosition, trackingUrl, etaExpected, etaSeconds,
      routePoints: info.data.route_points || [], pricing: info.data.pricing || null,
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Satıcı: Yango çatdırılmasını ləğv et (əvvəlcə cancel-info ilə pulsuzmu yoxla) ──
router.post('/orders/:id/yango/cancel', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true, sellerId: true, yangoClaimId: true, yangoVersion: true } });
    if (!order || order.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (!order.yangoClaimId) { res.status(400).json({ success: false, message: 'Bu sifariş Yango-ya göndərilməyib' }); return; }

    const info = await getClaimInfo(order.yangoClaimId);
    const version = (info.data?.version as number) ?? order.yangoVersion ?? 1;
    // Pulsuz ləğv mümkündürmü?
    const ci = await getCancelInfo(order.yangoClaimId);
    const cancelState: 'free' | 'paid' = ci.data?.cancel_state === 'paid' ? 'paid' : 'free';
    const cancel = await cancelClaim(order.yangoClaimId, version, cancelState);
    if (!cancel.ok) { res.status(502).json({ success: false, message: cancel.error || 'Yango ləğvi alınmadı' }); return; }
    // Sifarişin ÖZ statusuna toxunmuruq — yalnız çatdırılma ləğv olundu.
    // Köhnə kuryerin mövqeyi təmizlənir ki, xəritədə qalmasın.
    await prisma.order.update({
      where: { id: order.id },
      data: {
        yangoStatus: cancel.data?.status || 'cancelled',
        courierLat: null, courierLng: null,
        yangoError: 'Çatdırılma ləğv edildi — yeni kuryer çağıra bilərsiniz',
      },
    }).catch(() => {});
    res.json({ success: true, status: cancel.data?.status || 'cancelled', cancelState, canRedispatch: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Kuryerə zəng (proksi nömrə) — alıcı və ya satıcı, Wolt kimi ──────────────
router.post('/orders/:id/yango/call', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true, buyerId: true, sellerId: true, yangoClaimId: true } });
    if (!order || (order.buyerId !== req.adminId && order.sellerId !== req.adminId)) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (!order.yangoClaimId) { res.status(400).json({ success: false, message: 'Bu sifariş Yango-ya göndərilməyib' }); return; }
    // Kuryer hələ təyin olunmayıbsa Yango nömrə vermir. Bu, SERVER XƏTASI deyil —
    // sadəcə vaxtı çatmayıb. Əvvəl 502 qaytarılırdı: brauzer konsoluna "Bad
    // Gateway" kimi düşür və sistem sınıb kimi görünürdü. İndi 409 (konflikt).
    const r = await getDriverPhone(order.yangoClaimId);
    if (!r.ok || !r.data?.phone) {
      res.status(409).json({ success: false, pending: true, message: 'Kuryer hələ təyin olunmayıb — nömrə kuryer tapılandan sonra açılır' });
      return;
    }
    res.json({ success: true, phone: r.data.phone, ext: r.data.ext || null, ttlSeconds: r.data.ttl_seconds || null });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Yango webhook (status push). Yango kabinetində bu URL qeyd olunur. ─────────
// Auth yoxdur (Yango bizim JWT göndərmir) — claim_id üzrə uyğunlaşdırırıq.
router.post('/yango/callback', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const claimId = body.claim_id || body.id || body.order_id;
    const status = body.status || body.claim_status;
    if (claimId && status) {
      const order = await prisma.order.findFirst({ where: { yangoClaimId: String(claimId) }, select: { id: true, status: true, yangoVersion: true, yangoStatus: true, buyerId: true, sellerId: true } });
      if (order) {
        let st = String(status);
        // Yango "təsdiq gözlənilir" deyirsə dərhal təsdiqlə — kuryer axtarışı
        // bu addımla başlayır. Push yolu olduğu üçün ən sürətli reaksiya budur.
        if (st === 'ready_for_approval') {
          const acc = await acceptClaim(String(claimId), order.yangoVersion ?? (body.version as number) ?? 1);
          if (acc.ok) st = (acc.data?.status as string) || 'accepted';
        }
        await prisma.order.update({ where: { id: order.id }, data: { yangoStatus: st } }).catch(() => {});
        await syncOrderStatus(order.id, order.status, st);
        // Webhook yolu: heç kim səhifəni açıq saxlamasa belə tərəflər xəbər tutsun.
        if (st !== order.yangoStatus) {
          const payload = { orderId: order.id, yangoStatus: st };
          emitToUser(order.buyerId, 'order:yango', payload);
          emitToUser(order.sellerId, 'order:yango', payload);
          pushLive([order.buyerId, order.sellerId], { kind: 'order', id: order.id });
        }
      }
    }
    // Yango 200 gözləyir.
    res.json({ success: true });
  } catch {
    res.json({ success: true });
  }
});

// ── FON İZLƏYİCİSİ ───────────────────────────────────────────────────────────
//
// Əvvəl Yango statusu YALNIZ kimsə sifariş səhifəsini açıq saxlayanda
// yenilənirdi (webhook qoşulmayıb). Nəticə: kuryer mağazaya gəlib kod
// soruşurdu, satıcı isə heç yerdə kod görmürdü — səhifəni açmamışdı, ya da
// səhifə 30 saniyəlik sorğunu hələ etməmişdi. Kuryer gözləyib sifarişi
// ödənişli ləğv edirdi (sifariş #87).
//
// İndi server özü hər 10 saniyədən bir aktiv claim-ləri yoxlayır:
//   • status dəyişibsə — bazaya yazır, sifarişi sinxronlaşdırır, tərəflərə
//     anlıq xəbər göndərir;
//   • ready_for_approval-da ilişən claim-i təsdiqləyir.
// (Kuryer kodu göndərilmir — kod xüsusiyyəti ləğv edilib.)
const WATCH_STOP = [...YANGO_DEAD, 'delivered', 'delivered_finish'];

let watcherBusy = false;
async function watchActiveClaims() {
  if (watcherBusy || !isYangoConfigured()) return;
  watcherBusy = true;
  try {
    const orders = await prisma.order.findMany({
      where: {
        yangoClaimId: { not: null },
        status: { notIn: ['CANCELLED', 'DELIVERED'] },
        OR: [{ yangoStatus: null }, { yangoStatus: { notIn: WATCH_STOP } }],
      },
      select: { id: true, status: true, yangoClaimId: true, yangoStatus: true, yangoVersion: true, buyerId: true, sellerId: true },
      orderBy: { id: 'desc' },
      take: 40,
    });
    for (const o of orders) {
      const claimId = o.yangoClaimId!;
      const info = await getClaimInfo(claimId);
      if (!info.ok || !info.data) continue;
      let st = String(info.data.status || '');
      let version = (info.data.version as number) ?? o.yangoVersion ?? 1;
      // Təsdiqsiz ilişib qalıbsa — kuryer axtarışını başlat.
      if (st === 'ready_for_approval') {
        const acc = await acceptClaim(claimId, version);
        if (acc.ok) { st = (acc.data?.status as string) || 'accepted'; if (acc.data?.version != null) version = acc.data.version as number; }
      }
      if (st && st !== o.yangoStatus) {
        await prisma.order.update({ where: { id: o.id }, data: { yangoStatus: st, yangoVersion: version } }).catch(() => {});
        await syncOrderStatus(o.id, o.status, st);
        const payload = { orderId: o.id, yangoStatus: st };
        emitToUser(o.buyerId, 'order:yango', payload);
        emitToUser(o.sellerId, 'order:yango', payload);
        pushLive([o.buyerId, o.sellerId], { kind: 'order', id: o.id });
      }
    }
  } catch (e: any) {
    console.error('[yango] izləyici xətası:', e?.message);
  } finally {
    watcherBusy = false;
  }
}

export function startYangoWatcher() {
  // 10 san: status (kuryer tapıldı / yolda / çatdı) tərəflərə tez çatsın.
  setTimeout(watchActiveClaims, 10 * 1000);
  setInterval(watchActiveClaims, 10 * 1000);
  console.log('[yango] aktiv sifariş izləyicisi işə düşdü (hər 10 san).');
}

export default router;
