// QİYMƏT TƏKLİFİ məntiqi (routes/offers.ts və checkout istifadə edir).
import { PrismaClient } from '@prisma/client';
import { pushLive } from './live';
import { unitPriceFor, type Tier } from './tierPricing';
import { emitToUser, isUserOnline } from './callSignaling';

const prisma = new PrismaClient();
const H = 3600 * 1000;
export const OFFER_RESPOND_HOURS = Number(process.env.OFFER_RESPOND_HOURS || 48);
export const OFFER_BUY_WINDOW_HOURS = Number(process.env.OFFER_BUY_WINDOW_HOURS || 48);
// Çox aşağı (spam) təkliflərin qarşısı: elan qiymətinin ən azı bu hissəsi.
export const OFFER_MIN_RATIO = Number(process.env.OFFER_MIN_RATIO || 0.5);

export const OFFER_STATUS_AZ: Record<string, string> = {
  PENDING: 'Satıcının cavabı gözlənilir', COUNTERED: 'Satıcı əks-təklif verdi', ACCEPTED: 'Qəbul edildi — alış açıqdır',
  REJECTED: 'Rədd edildi', CANCELLED: 'Ləğv edildi', EXPIRED: 'Müddəti bitdi', USED: 'Alındı',
};

async function notify(userId: number, title: string, body: string, link = '/offers') {
  await prisma.notification.create({ data: { userId, type: 'ORDER', title, body, link } }).catch(() => {});
  pushLive(userId, { kind: 'order', toast: title, tone: 'info' });
}

/** Elanın bu say üçün hazırkı vahid qiyməti (pillə nəzərə alınır) — təklif bundan aşağı olmalıdır. */
export async function currentUnitPrice(listingId: number, qty: number) {
  const l = await prisma.listing.findUnique({ where: { id: listingId }, include: { priceTiers: true } });
  if (!l) return null;
  const tiers: Tier[] = l.priceTiers.map((t) => ({ minQty: t.minQty, price: t.price }));
  return { listing: l, unit: tiers.length ? unitPriceFor(l.price, tiers, qty) : l.price };
}

/**
 * Elan saytda ONLAYN alınırmı? Yalnız biznes (VÖEN) elanları səbət/ödənişdən keçir.
 * Fərdi satıcının elanında da qiymət təklif etmək olar — razılaşma olanda
 * alış chat üzərindən davam edir (səbət yoxdur).
 */
export const isOnlineListing = (l: { businessId?: number | null; businessObjectId?: number | null } | null | undefined) =>
  !!(l && (l.businessId || l.businessObjectId));

/** Razılaşmanı söhbətə yaz — chat elan konteksti ilə «İş» axınında açılsın. */
async function postDealMessage(fromId: number, toId: number, listingId: number, content: string) {
  const blocked = await prisma.blockedUser.findFirst({ where: { OR: [{ blockerId: toId, blockedId: fromId }, { blockerId: fromId, blockedId: toId }] }, select: { id: true } });
  if (blocked) return;
  const online = isUserOnline(toId);
  const m = await prisma.message.create({
    data: { senderId: fromId, receiverId: toId, listingId, isBusiness: true, content, deliveredAt: online ? new Date() : null },
    include: { sender: { select: { id: true, name: true, avatar: true } }, listing: { select: { id: true, title: true, price: true, images: true, city: true, businessId: true, businessObjectId: true } } },
  }).catch(() => null);
  if (m) { emitToUser(toId, 'chat:message', m); emitToUser(fromId, 'chat:message', m); }
}

/** Təklif qəbul olundu — onlayn elanda alış pəncərəsi açılır; fərdi elanda razılaşma chat-a keçir. */
export async function openBuyWindow(offerId: number, finalPrice: number, by: 'SELLER' | 'BUYER') {
  const o = await prisma.priceOffer.update({
    where: { id: offerId },
    data: { status: 'ACCEPTED', finalPrice, acceptedUntil: new Date(Date.now() + OFFER_BUY_WINDOW_HOURS * H), expiresAt: null },
  });
  const l = await prisma.listing.findUnique({ where: { id: o.listingId }, select: { title: true, businessId: true, businessObjectId: true } });
  if (!isOnlineListing(l)) {
    const chatToSeller = `/messages?chat=${o.sellerId}&seg=BUSINESS`;
    const deal = `✅ Qiymət razılaşdırıldı: «${l?.title}» — ${o.quantity} ədəd × ${finalPrice} ₼. Görüş/çatdırılma və ödənişi burada razılaşaq.`;
    // Razılaşmanı qəbul edən tərəfin adından söhbətə yaz (o, bu addımı özü etdi).
    if (by === 'SELLER') await postDealMessage(o.sellerId, o.buyerId, o.listingId, deal);
    else await postDealMessage(o.buyerId, o.sellerId, o.listingId, deal);
    await notify(o.buyerId, `Qiymət razılaşdırıldı ✅ — «${l?.title}»`,
      `${o.quantity} ədəd × ${finalPrice} ₼. Bu elan fərdi satıcınındır — alışı satıcı ilə mesajlaşaraq tamamlayın.`, chatToSeller);
    if (by === 'BUYER') await notify(o.sellerId, `Alıcı əks-təklifinizi qəbul etdi — «${l?.title}»`, `${o.quantity} ədəd × ${finalPrice} ₼. Alıcı ilə mesajlaşaraq satışı tamamlayın.`, `/messages?chat=${o.buyerId}&seg=BUSINESS`);
    return o;
  }
  await notify(o.buyerId, `Qiymət razılaşdırıldı ✅ — «${l?.title}»`,
    `${o.quantity} ədəd × ${finalPrice} ₼. ${OFFER_BUY_WINDOW_HOURS} saat ərzində bu qiymətlə ala bilərsiniz.`, `/offers?id=${o.id}`);
  if (by === 'BUYER') await notify(o.sellerId, `Alıcı əks-təklifinizi qəbul etdi — «${l?.title}»`, `${o.quantity} ədəd × ${finalPrice} ₼. Alıcı indi sifariş verə bilər.`, `/offers?tab=selling&id=${o.id}`);
  return o;
}

/**
 * Checkout: səbət sətrinin təklifi hələ etibarlıdırmı? Etibarlıdırsa razılaşdırılmış
 * vahid qiyməti qaytarır. Say təklifdəki ilə eyni olmalıdır.
 */
export async function validOfferPrice(offerId: number, buyerId: number, listingId: number, quantity: number): Promise<{ ok: true; unit: number } | { ok: false; message: string }> {
  const o = await prisma.priceOffer.findUnique({ where: { id: offerId } });
  if (!o || o.buyerId !== buyerId || o.listingId !== listingId) return { ok: false, message: 'Qiymət təklifi tapılmadı' };
  if (o.status === 'USED') return { ok: false, message: 'Bu təkliflə artıq alış edilib' };
  if (o.status !== 'ACCEPTED' || !o.acceptedUntil || o.acceptedUntil < new Date()) return { ok: false, message: 'Razılaşdırılmış qiymətin müddəti bitib — səbətdən silib yenidən təklif göndərin' };
  if (quantity !== o.quantity) return { ok: false, message: `Razılaşdırılmış qiymət ${o.quantity} ədəd üçündür` };
  return { ok: true, unit: o.finalPrice ?? o.unitPrice };
}

/** Müddətləri yoxla (hər 10 dəq): cavabsız təkliflər və istifadə olunmamış alış pəncərələri. */
export async function expireOffers(): Promise<number> {
  const now = new Date();
  const stale = await prisma.priceOffer.findMany({
    where: { OR: [{ status: { in: ['PENDING', 'COUNTERED'] }, expiresAt: { lt: now } }, { status: 'ACCEPTED', acceptedUntil: { lt: now } }] },
    take: 200,
  });
  for (const o of stale) {
    await prisma.priceOffer.update({ where: { id: o.id }, data: { status: 'EXPIRED' } });
    // Səbətdəki təklif sətri adi sətirə çevrilmir — silinir (alıcı köhnə qiymətlə yanılmasın).
    await prisma.cartItem.deleteMany({ where: { priceOfferId: o.id } }).catch(() => {});
    const msg = o.status === 'ACCEPTED' ? 'Razılaşdırılmış qiymətin müddəti bitdi — lazım olsa yenidən təklif göndərin.' : o.status === 'COUNTERED' ? 'Əks-təklifə vaxtında cavab verilmədi.' : 'Satıcı təklifə vaxtında cavab vermədi.';
    await notify(o.buyerId, 'Qiymət təklifinin müddəti bitdi', msg, `/offers?id=${o.id}`);
  }
  return stale.length;
}
