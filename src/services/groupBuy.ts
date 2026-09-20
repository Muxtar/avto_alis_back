// BİRGƏ ALIŞ — bir neçə alıcı eyni məhsulu birlikdə alıb ucuzlaşdırır.
//
// NECƏ İŞLƏYİR
//   1. Elanda say-qiymət pilləsi VARSA alıcı «birgə alış» yarada bilər.
//   2. Yaradan xüsusi link alır: /g/<code>. Qrupa YALNIZ bu linklə qoşulmaq olar,
//      ona görə kimin neçə ədəd aldığı düzgün qruplaşır.
//   3. HƏR İŞTİRAKÇI ƏVVƏLCƏ TAM QİYMƏTİ ÖDƏYİR (endirimsiz).
//   4. Qaytarma müddəti (default 14 gün, hər kəs üçün öz təhvil tarixindən)
//      bitəndən sonra qrup HESABLAŞIR: məhsulu SAXLAYAN iştirakçıların ümumi
//      sayına görə son qiymət tapılır və fərq hər kəsə geri qaytarılır.
//
// NİYƏ ƏVVƏLCƏ TAM QİYMƏT (fırıldağın qarşısı)
//   Əvvəl endirim dərhal tətbiq olunurdu. Bu, belə bir fırıldağa imkan verirdi:
//   bir nəfər saxta «qrup» yığır (tanışları ilə), qiymət düşür, sonra o adamlar
//   məhsulu geri qaytarır — nəticədə təkbaşına alan ən ucuz qiyməti qoparırdı.
//   İndi endirim YALNIZ qaytarma müddəti bitəndən sonra, HƏQİQƏTƏN məhsulu
//   saxlayanların sayına görə verilir. Qaytaran adam qrupdan çıxır və onun
//   sayı hesablamaya daxil olmur.
//
// ÖDƏNİŞ: birgə alış yalnız KARTLA mümkündür — fərqi geri qaytarmaq üçün
// ödəniş şlüzü lazımdır (nağdda platforma pulu geri qaytara bilməz).
import { PrismaClient } from '@prisma/client';
import { unitPriceFor, priceInfo, type Tier } from './tierPricing';
import { refundOrderSafe } from './refunds';
import { recordSettlement } from './settlement';
import { pushLive } from './live';

const prisma = new PrismaClient();

// Qrupun standart müddəti (gün) — bu müddətdən sonra qoşulma bağlanır.
export const GROUP_DAYS = Number(process.env.GROUP_BUY_DAYS || 7);

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
  const expired = g.expiresAt <= new Date();
  const open = g.status === 'OPEN' && !expired && !g.settledAt;
  // Hesablaşma nə vaxt olacaq: ən son təhvil + qaytarma müddəti (yoxdursa
  // qrupun bitmə vaxtı + müddət).
  const deadlines = g.orders
    .map((o) => (o.deliveredAt ? new Date(o.deliveredAt.getTime() + RETURN_WINDOW_DAYS * 24 * 3600 * 1000) : null))
    .filter((d): d is Date => !!d);
  const settleEta = g.settledAt
    ? null
    : new Date(Math.max(
        g.expiresAt.getTime(),
        ...(deadlines.length ? deadlines.map((d) => d.getTime()) : [g.expiresAt.getTime() + RETURN_WINDOW_DAYS * 24 * 3600 * 1000]),
      ));
  return {
    code: g.code,
    status: open ? 'OPEN' : 'CLOSED',
    expiresAt: g.expiresAt,
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

/** Qaytarma (iadə) müddəti — gün. Bu müddət bitəndən sonra qrup hesablaşır. */
export const RETURN_WINDOW_DAYS = Number(process.env.RETURN_WINDOW_DAYS || 14);

/** Sifarişin qaytarma müddətinin bitmə vaxtı (təhvildən sayılır). */
export function returnDeadline(order: { deliveredAt: Date | null; status: string }): Date | null {
  if (order.status !== 'DELIVERED' || !order.deliveredAt) return null;
  return new Date(order.deliveredAt.getTime() + RETURN_WINDOW_DAYS * 24 * 3600 * 1000);
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
 *   • qrup bağlanıb (vaxtı bitib və ya yaradan bağlayıb);
 *   • HƏR iştirakçının sifarişi çatdırılıb və 14 günlük qaytarma müddəti bitib;
 *   • gözləyən (cavablandırılmamış) iadə sorğusu qalmayıb.
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
    const hardDeadline = new Date(g.expiresAt.getTime() + 60 * 24 * 3600 * 1000) < now;
    if (!hardDeadline) {
      // Bütün sifarişlər təhvil verilib və müddəti bitibmi?
      const pending = g.orders.some((o) => {
        if (o.status !== 'DELIVERED' || !o.deliveredAt) return true;   // hələ çatmayıb
        const dl = new Date(o.deliveredAt.getTime() + RETURN_WINDOW_DAYS * 24 * 3600 * 1000);
        if (dl > now) return true;                                     // müddət davam edir
        // Cavablandırılmamış iadə sorğusu varsa gözləyirik.
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

/** Vaxtı bitmiş qrupları bağla (fon işi). */
export async function closeExpiredGroups(): Promise<number> {
  const r = await prisma.groupBuy.updateMany({
    where: { status: 'OPEN', expiresAt: { lt: new Date() } },
    data: { status: 'CLOSED' },
  }).catch(() => ({ count: 0 }));
  if (r.count) console.log(`[groupBuy] ${r.count} birgə alış vaxtı bitdiyi üçün bağlandı.`);
  return r.count;
}
