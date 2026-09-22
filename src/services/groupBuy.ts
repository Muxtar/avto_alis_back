// BİRGƏ ALIŞ — eyni elandan eyni pəncərədə alanların sayı toplanır və hamı ucuz alır.
//
// NECƏ İŞLƏYİR (AVTOMATİK — link və ya «qrup yarat» düyməsi YOXDUR)
//   1. Satıcı elanı qoyanda stok 1-dən çoxdursa «birgə alış» seçimi çıxır:
//      say-qiymət pillələrini yazır (stokun tam sayına qədər) və PƏNCƏRƏ
//      uzunluğunu seçir (məs. 3 gün) → Listing.groupBuyDays.
//   2. İlk alıcı həmin elandan sifariş verən kimi pəncərə AVTOMATİK açılır:
//      elanın altında geri sayım başlayır və onu BÜTÜN alıcılar görür.
//   3. Pəncərə bitənə qədər alanların sayı toplanır. Pəncərə bağlananda
//      toplanan saya uyğun pillə qiyməti hamıya tətbiq olunur.
//   4. Pəncərə bitəndən sonra YENİ alıcı gələndə yenidən 3 günlük TƏZƏ
//      pəncərə açılır — sayma sıfırdan başlayır.
//   5. Stok bitəndə (məs. 1000 ədəd satılanda) pəncərə də bağlanır.
//
// PUL AXINI (fırıldağın qarşısı)
//   • Hər alıcı ƏVVƏLCƏ TAM QİYMƏTİ ödəyir — pəncərə bitməmiş son qiymət
//     məlum deyil. Ödəniş yalnız KARTLA (fərqi geri qaytarmaq üçün).
//   • Pəncərə bitəndən sonra 14 GÜN qaytarma müddəti gözlənilir. Bu müddətdə
//     məhsulu geri qaytaran iştirakçı qrupdan DÜŞÜR və sayı hesaba alınmır.
//   • 14 gün bitəndə hesablaşma aparılır: məhsulu SAXLAYANLARIN ümumi sayına
//     görə son qiymət tapılır və fərq hər alıcının kartına qaytarılır.
//   Beləcə saxta qrupla (tanışlar alıb sonra qaytarmaqla) ucuz qiymət qoparmaq
//   mümkün olmur.
import { PrismaClient, Prisma } from '@prisma/client';
import { unitPriceFor, priceInfo, type Tier } from './tierPricing';
import { refundOrderSafe } from './refunds';
import { recordSettlement } from './settlement';
import { pushLive } from './live';

const prisma = new PrismaClient();

/** Satıcı müddət seçməyibsə istifadə olunan default pəncərə (gün). */
export const GROUP_DAYS = Number(process.env.GROUP_BUY_DAYS || 3);
/** Pəncərə üçün icazə verilən aralıq (gün). */
export const MIN_WINDOW_DAYS = 1;
export const MAX_WINDOW_DAYS = 30;

/** Qaytarma (iadə) müddəti — gün. Pəncərə bitəndən sonra bu qədər gözlənilir. */
export const RETURN_WINDOW_DAYS = Number(process.env.RETURN_WINDOW_DAYS || 14);

const DAY = 24 * 3600 * 1000;

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // oxşar simvollar (l,o,0,1) yoxdur
export function groupCode(len = 8): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

/** Qrupda SAYILAN sifarişlər: ləğv olunmuş sifarişlər saya daxil deyil. */
const COUNTED = { status: { not: 'CANCELLED' as const } };

// Məhsul geri qaytarılıb sayılan iadə statusları — bu saylar qrupdan ÇIXIR.
// (Satıcı məhsulu geri ALDIĞINI sistemdə təsdiqləyəndən sonra.)
const RETURNED_STATUSES = ['RETURN_RECEIVED', 'REFUNDED'] as const;

/** Bir sifarişdə ALICIDA QALAN say (qaytarılanlar çıxılmış). */
export function keptQtyOf(order: { items: { quantity: number }[]; returnRequests?: { status: string; quantity: number }[] }): number {
  const bought = order.items.reduce((s, i) => s + i.quantity, 0);
  const returned = (order.returnRequests || [])
    .filter((r) => (RETURNED_STATUSES as readonly string[]).includes(r.status))
    .reduce((s, r) => s + (r.quantity || 0), 0);
  return Math.max(0, bought - returned);
}

/** Qrupun hazırkı sayı — qaytarılan məhsullar SAYILMIR. */
export async function groupQty(groupBuyId: number): Promise<number> {
  const orders = await prisma.order.findMany({
    where: { groupBuyId, ...COUNTED },
    select: { items: { select: { quantity: true } }, returnRequests: { select: { status: true, quantity: true } } },
  });
  return orders.reduce((s, o) => s + keptQtyOf(o as any), 0);
}

// ─────────────────────────── PƏNCƏRƏ İDARƏSİ ───────────────────────────

/** Elanda birgə alış açıqdırmı? (satıcı müddət seçib + pillə var + stok > 1) */
export function groupBuyEnabled(listing: { stock: number; groupBuyDays: number | null; priceTiers: any[] }): boolean {
  return !!listing.groupBuyDays && listing.groupBuyDays > 0 && listing.stock > 1 && (listing.priceTiers?.length || 0) > 0;
}

/** Elanın AÇIQ pəncərəsi (varsa). Vaxtı keçibsə null qaytarır. */
export async function activeGroup(listingId: number) {
  return prisma.groupBuy.findFirst({
    where: { listingId, status: 'OPEN', settledAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Sifariş verilən anda pəncərəni tap, yoxdursa AÇ.
 *
 * İlk alıcı pəncərəni başladır (creator = həmin alıcı); sonrakılar hazır
 * pəncərəyə düşür. Pəncərə bitibsə növbəti alıcı üçün təzəsi açılır.
 */
export async function ensureActiveGroup(listingId: number, buyerId: number, tx?: Prisma.TransactionClient): Promise<number | null> {
  const db = (tx || prisma) as Prisma.TransactionClient;
  const listing = await db.listing.findUnique({
    where: { id: listingId },
    select: { id: true, stock: true, groupBuyDays: true, priceTiers: { select: { id: true } } },
  });
  if (!listing || !groupBuyEnabled(listing as any)) return null;

  const now = new Date();
  const open = await db.groupBuy.findFirst({
    where: { listingId, status: 'OPEN', settledAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, _count: { select: { orders: { where: COUNTED } } } },
  });
  const days = Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, listing.groupBuyDays || GROUP_DAYS));
  const expiresAt = new Date(now.getTime() + days * DAY);
  if (open) {
    // Açıq pəncərədə heç bir qüvvədə sifariş qalmayıbsa (ödənilməyib ləğv
    // olunub) geri sayım bu alıcıdan YENİDƏN başlayır — boş pəncərə kimsənin
    // vaxtını yeməsin.
    if (open._count.orders === 0) {
      await db.groupBuy.update({
        where: { id: open.id },
        data: { expiresAt, windowDays: days, creatorId: buyerId, settleAt: new Date(expiresAt.getTime() + RETURN_WINDOW_DAYS * DAY) },
      });
    }
    return open.id;
  }

  let code = groupCode();
  for (let i = 0; i < 5 && (await db.groupBuy.findUnique({ where: { code }, select: { id: true } })); i++) code = groupCode();
  const g = await db.groupBuy.create({
    data: {
      code, listingId, creatorId: buyerId, windowDays: days, expiresAt,
      settleAt: new Date(expiresAt.getTime() + RETURN_WINDOW_DAYS * DAY),
    },
    select: { id: true },
  });
  console.log(`[groupBuy] elan #${listingId} üçün ${days} günlük pəncərə açıldı (kod ${code}).`);
  return g.id;
}

/** Elanın hazırkı pəncərəsi — məhsul səhifəsi üçün (yoxdursa null). */
export async function listingGroupState(listingId: number) {
  const g = await activeGroup(listingId);
  if (!g) return null;
  const st = await groupState(g.code);
  // Sifarişi ləğv olunubsa pəncərə faktiki başlamayıb — geri sayım
  // göstərilmir, növbəti həqiqi alıcı təzə pəncərə açır.
  return st && st.participants.length ? st : null;
}

/** Qrupun tam vəziyyəti — səhifə və səbət üçün. */
export async function groupState(code: string) {
  const g = await prisma.groupBuy.findUnique({
    where: { code },
    include: {
      listing: {
        include: {
          priceTiers: true,
          user: { select: { id: true, name: true } },
          businessObject: { select: { id: true, name: true } },
        },
      },
      creator: { select: { id: true, name: true, avatar: true } },
      orders: {
        where: COUNTED,
        select: {
          id: true, buyerId: true, createdAt: true, paymentStatus: true, status: true, deliveredAt: true,
          buyer: { select: { id: true, name: true, avatar: true } },
          items: { select: { quantity: true, price: true } },
          returnRequests: { select: { status: true, quantity: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!g) return null;
  const tiers: Tier[] = g.listing.priceTiers.map((t) => ({ minQty: t.minQty, price: t.price }));
  // Say = məhsulu SAXLAYANLAR (qaytaranlar çıxılır).
  const qty = g.orders.reduce((s, o) => s + keptQtyOf(o as any), 0);
  const now = Date.now();
  const expired = g.expiresAt.getTime() <= now;
  const open = g.status === 'OPEN' && !expired && !g.settledAt;
  // Hesablaşma: pəncərə bitir → 14 gün qaytarma müddəti → hesablaşma.
  const settleEta = g.settledAt ? null : (g.settleAt || new Date(g.expiresAt.getTime() + RETURN_WINDOW_DAYS * DAY));
  return {
    code: g.code,
    status: g.settledAt ? 'SETTLED' : open ? 'OPEN' : 'CLOSED',
    expiresAt: g.expiresAt,
    startedAt: g.createdAt,
    windowDays: g.windowDays,
    // Geri sayım üçün — saat fərqindən asılı olmasın deyə saniyə göndəririk.
    secondsLeft: open ? Math.max(0, Math.round((g.expiresAt.getTime() - now) / 1000)) : 0,
    creator: g.creator,
    listing: {
      id: g.listing.id, title: g.listing.title, images: g.listing.images, price: g.listing.price,
      stock: g.listing.stock, seller: g.listing.user, businessObject: g.listing.businessObject,
    },
    tiers: tiers.sort((a, b) => a.minQty - b.minQty),
    totalQty: qty,
    // Ödəniş modeli: hamı TAM qiyməti ödəyir, endirim sonra qaytarılır.
    fullPrice: g.listing.price,
    returnWindowDays: RETURN_WINDOW_DAYS,
    settledAt: g.settledAt,
    finalUnitPrice: g.finalUnitPrice,
    settleEta,
    // Hazırkı say üçün qiymət + növbəti pillə («daha N ədəd lazımdır»).
    pricing: priceInfo(g.listing.price, tiers, Math.max(1, qty)),
    participants: g.orders.map((o) => ({
      orderId: o.id,
      user: { id: o.buyer.id, name: o.buyer.name, avatar: o.buyer.avatar },
      quantity: keptQtyOf(o as any),
      returned: o.items.reduce((x, i) => x + i.quantity, 0) - keptQtyOf(o as any),
      joinedAt: o.createdAt,
    })),
  };
}

/** Sifarişin qaytarma müddətinin bitmə vaxtı (təhvildən sayılır). */
export function returnDeadline(order: { deliveredAt: Date | null; status: string }): Date | null {
  if (order.status !== 'DELIVERED' || !order.deliveredAt) return null;
  return new Date(order.deliveredAt.getTime() + RETURN_WINDOW_DAYS * DAY);
}

/**
 * QRUP HESABLAŞMASI — qaytarma müddəti bitəndən sonra endirimi qaytarır.
 *
 * Addımlar:
 *   1. Məhsulu SAXLAYAN iştirakçıların ümumi sayı hesablanır (qaytaranlar çıxır).
 *   2. Həmin say üçün son qiymət tapılır (pillə düsturu).
 *   3. Hər iştirakçıya (ödədiyi tam qiymət − son qiymət) × saxladığı say qaytarılır.
 *   4. Qrup SETTLED olur — bir daha hesablanmır.
 */
export async function settleGroup(groupBuyId: number): Promise<{ ok: boolean; reason?: string; unit?: number }> {
  const g = await prisma.groupBuy.findUnique({
    where: { id: groupBuyId },
    include: { listing: { include: { priceTiers: true } } },
  });
  if (!g) return { ok: false, reason: 'tapılmadı' };
  if (g.settledAt) return { ok: false, reason: 'artıq hesablaşıb' };
  const tiers: Tier[] = g.listing.priceTiers.map((t) => ({ minQty: t.minQty, price: t.price }));
  if (!tiers.length) return { ok: false, reason: 'pillə yoxdur' };

  const orders = await prisma.order.findMany({
    where: { groupBuyId, ...COUNTED },
    include: { items: true, returnRequests: { select: { status: true, quantity: true } } },
  });
  const totalKept = orders.reduce((s, o) => s + keptQtyOf(o as any), 0);
  const unit = unitPriceFor(g.listing.price, tiers, totalKept);

  for (const o of orders) {
    const kept = keptQtyOf(o as any);
    if (kept <= 0) continue;                       // hamısını qaytarıb — fərq yoxdur
    const paidUnit = o.items[0]?.price ?? g.listing.price;
    const diff = Math.round((paidUnit - unit) * kept * 100) / 100;
    if (diff < 0.01) {
      await prisma.notification.create({
        data: {
          userId: o.buyerId, type: 'ORDER', title: `Sifariş #${o.id}`,
          body: `Birgə alış tamamlandı. Qrupda ${totalKept} ədəd qaldığı üçün endirim yaranmadı — qiymət ${unit} AZN.`,
          link: `/orders/${o.id}`,
        },
      }).catch(() => {});
      continue;
    }
    // Kartla ödənilibsə fərq geri qaytarılır.
    const r = o.paymentStatus === 'PAID' ? await refundOrderSafe(o.id, 'CANCELLED', diff) : { ok: false as const, error: 'ödənilməyib' };
    await prisma.notification.create({
      data: {
        userId: o.buyerId, type: 'ORDER', title: `Sifariş #${o.id}`,
        body: r.ok
          ? `🎉 Birgə alış tamamlandı! Qrupda ${totalKept} ədəd qaldı, son qiymət ${unit} AZN — ${diff.toFixed(2)} AZN sizə geri qaytarıldı.`
          : `🎉 Birgə alış tamamlandı! Son qiymət ${unit} AZN — ${diff.toFixed(2)} AZN fərqin qaytarılması emal olunur.`,
        link: `/orders/${o.id}`,
      },
    }).catch(() => {});
    await recordSettlement(o.id).catch(() => {});
    pushLive(o.buyerId, { kind: 'order', id: o.id, toast: `🎉 Birgə alış endirimi: ${diff.toFixed(2)} AZN geri qaytarıldı`, tone: 'success' });
  }

  await prisma.groupBuy.update({
    where: { id: groupBuyId },
    data: { status: 'SETTLED', settledAt: new Date(), finalUnitPrice: unit },
  });
  console.log(`[groupBuy] qrup ${g.code} hesablaşdı: ${totalKept} ədəd, son qiymət ${unit} AZN`);
  return { ok: true, unit };
}

/**
 * Hesablaşma vaxtı çatmış qrupları tap və hesablaşdır (fon işi).
 *
 * Şərtlər:
 *   • pəncərə bağlanıb və üstündən 14 gün (qaytarma müddəti) keçib — settleAt;
 *   • sifariş hələ çatdırılmayıbsa və ya cavablandırılmamış iadə sorğusu varsa
 *     gözlənilir (alıcı məhsulu görməmiş endirim hesablanmasın).
 * 60 gündən sonra qrup hər halda hesablaşır (ilişib qalmasın).
 */
export async function settleDueGroups(): Promise<number> {
  const now = new Date();
  const groups = await prisma.groupBuy.findMany({
    where: { settledAt: null, expiresAt: { lt: now } },
    include: {
      orders: {
        where: COUNTED,
        select: {
          id: true, status: true, deliveredAt: true,
          returnRequests: { select: { status: true } },
        },
      },
    },
    take: 50,
  });
  let done = 0;
  for (const g of groups) {
    const settleAt = g.settleAt || new Date(g.expiresAt.getTime() + RETURN_WINDOW_DAYS * DAY);
    const hardDeadline = new Date(g.expiresAt.getTime() + 60 * DAY) < now;
    if (!hardDeadline) {
      if (settleAt > now) continue;                                    // 14 gün hələ bitməyib
      // Təhvil verilməyən sifariş və ya açıq iadə sorğusu varsa gözləyirik.
      const pending = g.orders.some((o) => {
        if (o.status !== 'DELIVERED' || !o.deliveredAt) return true;   // hələ çatmayıb
        const dl = new Date(o.deliveredAt.getTime() + RETURN_WINDOW_DAYS * DAY);
        if (dl > now) return true;                                     // müddət davam edir
        return o.returnRequests.some((r) => ['REQUESTED', 'APPROVED', 'RETURN_SHIPPED'].includes(r.status));
      });
      if (pending) continue;
    }
    if (!g.orders.length) {
      await prisma.groupBuy.update({ where: { id: g.id }, data: { status: 'SETTLED', settledAt: now } }).catch(() => {});
      continue;
    }
    const r = await settleGroup(g.id).catch(() => ({ ok: false }));
    if (r.ok) done++;
  }
  return done;
}

/**
 * Vaxtı bitmiş (və stoku bitmiş) pəncərələri bağla (fon işi).
 * Bağlananda iştirakçılara xəbər verilir: say bəlli oldu, 14 gündən sonra
 * fərq qaytarılacaq.
 */
export async function closeExpiredGroups(): Promise<number> {
  const now = new Date();
  const due = await prisma.groupBuy.findMany({
    where: { status: 'OPEN', OR: [{ expiresAt: { lt: now } }, { listing: { stock: { lte: 0 } } }] },
    select: {
      id: true, code: true, expiresAt: true, settleAt: true,
      listing: { select: { id: true, price: true, priceTiers: true } },
      orders: { where: COUNTED, select: { id: true, buyerId: true, items: { select: { quantity: true } }, returnRequests: { select: { status: true, quantity: true } } } },
    },
    take: 50,
  });
  for (const g of due) {
    const settleAt = g.settleAt || new Date(Math.max(g.expiresAt.getTime(), now.getTime()) + RETURN_WINDOW_DAYS * DAY);
    await prisma.groupBuy.update({ where: { id: g.id }, data: { status: 'CLOSED', settleAt } }).catch(() => {});
    if (!g.orders.length) continue;
    const tiers: Tier[] = g.listing.priceTiers.map((t) => ({ minQty: t.minQty, price: t.price }));
    const qty = g.orders.reduce((s, o) => s + keptQtyOf(o as any), 0);
    const unit = unitPriceFor(g.listing.price, tiers, qty);
    const when = settleAt.toLocaleDateString('az-AZ');
    for (const o of g.orders) {
      await prisma.notification.create({
        data: {
          userId: o.buyerId, type: 'ORDER', title: `Sifariş #${o.id}`,
          body: `Birgə alış bağlandı: qrupda ${qty} ədəd toplandı, gözlənilən qiymət ${unit} AZN. `
            + `${RETURN_WINDOW_DAYS} günlük qaytarma müddəti bitəndən sonra (${when}) fərq kartınıza qaytarılacaq.`,
          link: `/orders/${o.id}`,
        },
      }).catch(() => {});
      pushLive(o.buyerId, { kind: 'order', id: o.id });
    }
  }
  if (due.length) console.log(`[groupBuy] ${due.length} birgə alış pəncərəsi bağlandı.`);
  return due.length;
}
