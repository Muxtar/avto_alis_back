// BİRGƏ ALIŞ — bir neçə alıcı eyni məhsulu birlikdə alıb ucuzlaşdırır.
//
// NECƏ İŞLƏYİR
//   1. Elanda say-qiymət pilləsi VARSA alıcı «birgə alış» yarada bilər.
//      Pilləsi olmayan elanda bu düymə ümumiyyətlə görünmür.
//   2. Yaradan xüsusi link alır: /g/<code>. Qrupa YALNIZ bu linklə qoşulmaq olar,
//      ona görə kimin neçə ədəd aldığı düzgün qruplaşır.
//   3. Qrupun ÜMUMİ sayı (bütün iştirakçıların sifarişləri + yeni sifariş)
//      pillə düsturuna verilir və çıxan qiymət HAMIYA tətbiq olunur.
//   4. Sonradan qrup böyüyüb qiymət düşəndə ƏVVƏLKİ iştirakçılar da qazanır:
//      • kartla ödənilibsə fərq avtomatik geri qaytarılır (qismən iadə);
//      • hələ ödənilməyibsə (nağd) sifarişin məbləği azaldılır.
//   5. Qrupun vaxtı bitəndə bağlanır — yeni qoşulma olmur.
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

/** Qrupun hazırkı ümumi sayı (ləğv olunmayan sifarişlərdəki ədədlər). */
export async function groupQty(groupBuyId: number): Promise<number> {
  const orders = await prisma.order.findMany({
    where: { groupBuyId, ...COUNTED },
    select: { items: { select: { quantity: true } } },
  });
  return orders.reduce((s, o) => s + o.items.reduce((x, i) => x + i.quantity, 0), 0);
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
          id: true, buyerId: true, createdAt: true, paymentStatus: true,
          buyer: { select: { id: true, name: true, avatar: true } },
          items: { select: { quantity: true, price: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!g) return null;
  const tiers: Tier[] = g.listing.priceTiers.map((t) => ({ minQty: t.minQty, price: t.price }));
  const qty = g.orders.reduce((s, o) => s + o.items.reduce((x, i) => x + i.quantity, 0), 0);
  const expired = g.expiresAt <= new Date();
  const open = g.status === 'OPEN' && !expired;
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
    // Hazırkı say üçün qiymət + növbəti pillə («daha N ədəd lazımdır»).
    pricing: priceInfo(g.listing.price, tiers, Math.max(1, qty)),
    participants: g.orders.map((o) => ({
      orderId: o.id,
      user: { id: o.buyer.id, name: o.buyer.name, avatar: o.buyer.avatar },
      quantity: o.items.reduce((x, i) => x + i.quantity, 0),
      joinedAt: o.createdAt,
    })),
  };
}

/** Səbətə/sifarişə tətbiq olunacaq qiymət: qrupun ümumi sayı + bu alışın sayı. */
export async function groupUnitPrice(groupBuyId: number, basePrice: number, tiers: Tier[], addQty: number): Promise<number> {
  const current = await groupQty(groupBuyId);
  return unitPriceFor(basePrice, tiers, current + Math.max(0, addQty));
}

/**
 * Qrup böyüyəndə ƏVVƏLKİ sifarişləri yeni (daha ucuz) qiymətə gətirir.
 *
 * Bu, birgə alışın ƏSAS vədidir: «sonradan qoşulan hamıya qazandırır».
 * Əks halda erkən qoşulan bahaya alırdı və heç kim birinci qoşulmaq istəməzdi.
 */
export async function applyGroupPrice(groupBuyId: number): Promise<void> {
  const g = await prisma.groupBuy.findUnique({
    where: { id: groupBuyId },
    include: { listing: { include: { priceTiers: true } } },
  });
  if (!g) return;
  const tiers: Tier[] = g.listing.priceTiers.map((t) => ({ minQty: t.minQty, price: t.price }));
  if (!tiers.length) return;
  const total = await groupQty(groupBuyId);
  const unit = unitPriceFor(g.listing.price, tiers, total);

  const orders = await prisma.order.findMany({
    where: { groupBuyId, ...COUNTED },
    include: { items: true },
  });
  for (const o of orders) {
    const qty = o.items.reduce((s, i) => s + i.quantity, 0);
    const oldUnit = o.items[0]?.price ?? g.listing.price;
    if (unit >= oldUnit - 0.005) continue;               // qiymət düşməyib
    const diff = Math.round((oldUnit - unit) * qty * 100) / 100;
    if (diff < 0.01) continue;

    // Sətir qiymətləri yenilənir (sifariş detalında düzgün görünsün).
    for (const it of o.items) {
      await prisma.orderItem.update({ where: { id: it.id }, data: { price: unit } }).catch(() => {});
    }

    if (o.paymentStatus === 'PAID' && (o.gatewayRef || o.gatewayOrderId)) {
      // Kartla ödənilib — fərqi geri qaytar (qismən iadə).
      const r = await refundOrderSafe(o.id, 'CANCELLED', diff);
      await prisma.notification.create({
        data: {
          userId: o.buyerId, type: 'ORDER', title: `Sifariş #${o.id}`,
          body: r.ok
            ? `Birgə alış böyüdü 🎉 Qiymət ${unit} AZN oldu — ${diff.toFixed(2)} AZN fərq sizə geri qaytarıldı.`
            : `Birgə alış böyüdü 🎉 Qiymət ${unit} AZN oldu — ${diff.toFixed(2)} AZN fərqin qaytarılması emal olunur.`,
          link: `/orders/${o.id}`,
        },
      }).catch(() => {});
    } else {
      // Hələ ödənilməyib (nağd və ya gözləyən kart) — məbləği azaldırıq.
      const newSubtotal = Math.round(unit * qty * 100) / 100;
      const newTotal = Math.max(0, newSubtotal - (o.discountAmount || 0)) + (o.deliveryFee || 0);
      await prisma.order.update({
        where: { id: o.id },
        data: { subtotal: newSubtotal, total: Math.round(newTotal * 100) / 100 },
      }).catch(() => {});
      await prisma.notification.create({
        data: {
          userId: o.buyerId, type: 'ORDER', title: `Sifariş #${o.id}`,
          body: `Birgə alış böyüdü 🎉 Qiymət ${unit} AZN oldu — ödəyəcəyiniz məbləğ ${newTotal.toFixed(2)} AZN-ə düşdü.`,
          link: `/orders/${o.id}`,
        },
      }).catch(() => {});
    }
    await recordSettlement(o.id).catch(() => {});
    pushLive(o.buyerId, { kind: 'order', id: o.id, toast: `🎉 Birgə alış: qiymət ${unit} AZN oldu`, tone: 'success' });
  }
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
