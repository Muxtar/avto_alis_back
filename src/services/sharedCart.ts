// PAYLAŞILAN SƏBƏT — «başqası ödəsin» və «paket / resept göndər».
//
// İki istifadə:
//   1) SENDER («başqası ödəsin»): paylaşan HƏR ŞEYİ seçir — məhsullar, ünvan/konum,
//      çatdırılma üsulu (Yango / satıcı özü / mağazadan götürmə). Linki açan YALNIZ
//      ödəyir (hesabı olmaya bilər). Məhsul paylaşana və ya onun seçdiyi dosta gedir.
//   2) RECIPIENT / BUNDLE («paket / resept»): paylaşan (məs. həkim) məhsulları
//      qeydlərlə seçib göndərir; linki açan onları ÖZ səbətinə atır və adi
//      checkout-dan (öz ünvanı, Yango, kart/nağd) alır.
//
// Əvvəl ödəniş marşrutu checkout qaydalarını keçirdi: çatdırılma üsulu/haqqı yox
// idi (Yango kuryer göndərə bilmirdi), fərdi satıcının məhsulu kartla alınırdı,
// yoxlamadakı/arxivlənmiş elan satılırdı, pillə qiyməti tətbiq olunmurdu. İndi
// paylaşım anında və ödəniş anında EYNİ yoxlamalar (validateSharedItems) işləyir.
import { PrismaClient } from '@prisma/client';
import { bestRulesForBuyer, applyProDiscounts } from './professionDiscount';
import { unitPriceFor, type Tier } from './tierPricing';
import { groupBuyEnabled } from './groupBuy';
import { checkPrice as yangoCheckPrice, isYangoConfigured, YANGO_MAX_WEIGHT_KG } from './yangoDelivery';
import { programForListing, listingIncluded, eligibility } from './referral';
import crypto from 'crypto';

const prisma = new PrismaClient();
export const SHARE_LINK_DAYS = Number(process.env.SHARE_LINK_DAYS || 30);

export interface SharedItemInput { listingId: number; quantity: number; note?: string | null; price?: number; referralCartId?: number | null }

export interface DeliveryChoice {
  deliveryType: 'DELIVERY' | 'PICKUP';
  deliveryMethod: 'COURIER' | 'SELF' | null;
  latitude: number | null;
  longitude: number | null;
}

export interface ValidatedLine {
  listingId: number; title: string; quantity: number; unit: number; lineTotal: number;
  sellerId: number; referralCartId: number | null; note: string | null;
  groupBuy: boolean; // elanda birgə alış açıqdır → sifariş pəncərəyə qoşulmalıdır
  // İxtisas endirimi (ALICININ təsdiqli ixtisasına görə — ödəyənin deyil).
  proDiscountPercent?: number | null; proDiscountAmount?: number | null; proDiscountProfession?: string | null; listUnitPrice?: number | null;
}

/**
 * Məhsulları və çatdırılmanı checkout qaydaları ilə yoxla.
 * card=true → hamısı biznes məhsulu olmalıdır (kartla ödəniş yalnız VÖEN-li satıcıda).
 * Qaytarır: sətirlər (hazırkı pillə qiyməti ilə) + satıcı üzrə çatdırılma haqqı, və ya səbəb.
 */
export async function validateSharedItems(items: SharedItemInput[], delivery: DeliveryChoice | null, opts: { card: boolean; buyerId?: number | null }) {
  const ids = items.map((i) => Number(i.listingId));
  const listings = await prisma.listing.findMany({
    where: { id: { in: ids } },
    include: { priceTiers: true },
  });
  const now = new Date();
  const lines: ValidatedLine[] = [];
  for (const it of items) {
    const l = listings.find((x) => x.id === Number(it.listingId));
    if (!l) return { ok: false as const, message: 'Linkdəki məhsullardan biri artıq mövcud deyil' };
    if (l.status !== 'APPROVED' || l.archivedAt || (l.expiresAt && l.expiresAt <= now)) return { ok: false as const, message: `«${l.title}» hazırda satışda deyil` };
    const qty = Math.max(1, Math.min(999, Number(it.quantity) || 1));
    if (l.stock < qty) return { ok: false as const, message: `«${l.title}» üçün stokda ${l.stock} ədəd var` };
    if (opts.card && !(l.businessId || l.businessObjectId)) {
      return { ok: false as const, message: `«${l.title}» fərdi satıcınındır — kartla (başqasının ödəməsi ilə) alına bilməz, yalnız satıcı ilə nağd` };
    }
    const tiers: Tier[] = (l.priceTiers || []).map((t) => ({ minQty: t.minQty, price: t.price }));
    // BİRGƏ ALIŞ: tam qiymət ödənilir, pəncərə bağlananda fərq qaytarılır (checkout ilə eyni).
    const gb = groupBuyEnabled(l as any);
    const unit = !gb && tiers.length ? unitPriceFor(l.price, tiers, qty) : l.price;
    lines.push({ listingId: l.id, title: l.title, quantity: qty, unit, lineTotal: Math.round(unit * qty * 100) / 100, sellerId: l.userId, referralCartId: it.referralCartId ?? null, note: it.note ?? null, groupBuy: gb });
  }
  // İxtisas endirimi — səbət/checkout ilə eyni hesab; birgə alış sətirləri xaric.
  if (opts.buyerId) {
    const rules = await bestRulesForBuyer(opts.buyerId, listings.map((l) => ({ id: l.id, businessObjectId: l.businessObjectId, userId: l.userId })));
    const pro = applyProDiscounts(lines.map((ln, idx) => ({ key: idx, listingId: ln.listingId, qty: ln.quantity, unit: ln.unit, skip: ln.groupBuy })), rules);
    lines.forEach((ln, idx) => {
      const p = pro.get(idx);
      if (!p || !p.discount) return;
      ln.listUnitPrice = ln.unit; ln.unit = p.unit;
      ln.lineTotal = Math.round((ln.lineTotal - p.discount) * 100) / 100;
      ln.proDiscountPercent = p.percent; ln.proDiscountAmount = p.discount; ln.proDiscountProfession = p.profession;
    });
  }
  if (opts.card) {
    // Biznes aktiv və təsdiqli olmalıdır.
    const objIds = listings.filter((l) => !l.businessId && l.businessObjectId).map((l) => l.businessObjectId as number);
    const objBiz = objIds.length ? (await prisma.businessObject.findMany({ where: { id: { in: objIds } }, select: { businessId: true } })).map((o) => o.businessId) : [];
    const bizIds = Array.from(new Set([...listings.map((l) => l.businessId).filter((x): x is number => !!x), ...objBiz]));
    const ok = await prisma.business.count({ where: { id: { in: bizIds }, isActive: true, status: 'APPROVED' } });
    if (ok !== bizIds.length) return { ok: false as const, message: 'Məhsullardan birinin biznesi hazırda aktiv deyil — kartla ödəniş mümkün deyil' };
  }

  const feeBySeller = new Map<number, number>();
  if (delivery && delivery.deliveryType === 'DELIVERY') {
    const pickupOnly = listings.find((l) => (l as any).pickupOnly);
    if (pickupOnly) return { ok: false as const, message: `«${pickupOnly.title}» yalnız mağazadan götürmə ilə satılır` };
    if (delivery.deliveryMethod === 'SELF') {
      const bad = listings.find((l) => !(l as any).allowSelfDelivery);
      if (bad) return { ok: false as const, message: `«${bad.title}» üçün satıcı özü çatdırılma təklif etmir — Yango və ya götürmə seçin` };
    } else if (delivery.deliveryMethod === 'COURIER') {
      if (delivery.latitude == null || delivery.longitude == null) return { ok: false as const, message: 'Yango çatdırılması üçün xəritədən konum seçin' };
      const bySeller = new Map<number, typeof listings>();
      for (const l of listings) { const a = bySeller.get(l.userId) || []; a.push(l); bySeller.set(l.userId, a); }
      for (const [sellerId, ls] of bySeller.entries()) {
        const w = ls.reduce((s, l) => s + (lines.find((x) => x.listingId === l.id)?.quantity || 0) * ((l as any).weightKg || 0), 0);
        if (w > YANGO_MAX_WEIGHT_KG) return { ok: false as const, message: `Çəki ${w} kq — Yango limiti ${YANGO_MAX_WEIGHT_KG} kq. Götürmə və ya satıcı çatdırması seçin` };
        if (isYangoConfigured()) {
          const objId = ls.find((l) => l.businessObjectId)?.businessObjectId;
          const obj = objId ? await prisma.businessObject.findUnique({ where: { id: objId }, select: { latitude: true, longitude: true } }) : null;
          if (obj?.latitude != null && obj.longitude != null) {
            const weightKg = ls.reduce((s, l) => s + (lines.find((x) => x.listingId === l.id)?.quantity || 1) * ((l as any).weightKg || 1), 0);
            const q = await yangoCheckPrice({ source: [obj.longitude, obj.latitude], destination: [delivery.longitude, delivery.latitude], weightKg }).catch(() => null);
            if (q?.ok && q.data?.price) feeBySeller.set(sellerId, parseFloat(String(q.data.price)) || 0);
          }
        }
      }
    } else {
      return { ok: false as const, message: 'Çatdırılma üsulunu seçin' };
    }
  }
  return { ok: true as const, lines, feeBySeller };
}

/**
 * Paylaşan referal ola bilərsə (məs. həkim mağazanın referal proqramındadır)
 * həmin məhsullar üçün referal linki yaradılır — alış olanda komissiya ona yazılır.
 */
export async function attachReferral(sharerId: number, items: SharedItemInput[]): Promise<SharedItemInput[]> {
  const out: SharedItemInput[] = [];
  const linkByProgram = new Map<number, number>();
  for (const it of items) {
    const l = await prisma.listing.findUnique({ where: { id: it.listingId }, select: { id: true, userId: true, businessObjectId: true, businessId: true, referralMode: true, status: true } });
    let refId: number | null = null;
    if (l && l.status === 'APPROVED') {
      const p = await programForListing(l);
      if (p && listingIncluded(p, l) && (await eligibility(p, sharerId)).ok) {
        if (!linkByProgram.has(p.id)) {
          const link = await prisma.referralCart.create({
            data: {
              token: crypto.randomBytes(8).toString('hex'), referrerId: sharerId, programId: p.id, sellerId: p.sellerId,
              objectId: p.objectId, businessId: l.businessId, percent: p.defaultPercent,
              items: items.map((x) => ({ listingId: x.listingId, quantity: x.quantity })), title: 'Paylaşılan səbət',
              expiresAt: new Date(Date.now() + p.linkDays * 24 * 3600 * 1000),
            },
          });
          linkByProgram.set(p.id, link.id);
        }
        refId = linkByProgram.get(p.id)!;
      }
    }
    out.push({ ...it, referralCartId: refId });
  }
  return out;
}
