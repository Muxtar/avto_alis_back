// VIP ELAN — ödənişli önə çıxarma.
//
// Satıcı elanı üçün paket (1 / 7 / 30 gün) seçir və ödəyir. Ödəniş eyni bank
// axınından keçir (BusinessFee, purpose=VIP) — callback gələndə activateVip()
// elanı VIP edir. VIP elanlar /listings-də HƏMİŞƏ əvvəldə (isVip desc), kartda
// VIP nişanı var. Qiymətlər admin paneldən (vip_price_*d) dəyişilir; 0 → pulsuz.
import { PrismaClient } from '@prisma/client';
import { getNumber } from './settings';
import { pushLive, pushPublicListings } from './live';

const prisma = new PrismaClient();
const DAY = 24 * 60 * 60 * 1000;

export const VIP_DAYS = [1, 7, 30] as const;

export async function vipPackages() {
  return Promise.all(VIP_DAYS.map(async (days) => ({ days, price: await getNumber(`vip_price_${days}d`) })));
}

/**
 * Elanı `days` gün VIP et. Artıq VIP-dirsə müddət qalan vaxtın ÜSTÜNƏ gəlir.
 * Elanın öz müddəti (expiresAt) VIP-dən tez bitirsə uzadılır — ödənilmiş VIP
 * elan gizləndiyi üçün boşa getməsin.
 */
export async function activateVip(listingId: number, days: number) {
  const l = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, userId: true, title: true, isVip: true, vipUntil: true, expiresAt: true } });
  if (!l) throw new Error('Elan tapılmadı');
  const now = Date.now();
  const base = l.isVip && l.vipUntil && l.vipUntil.getTime() > now ? l.vipUntil.getTime() : now;
  const vipUntil = new Date(base + days * DAY);
  const expiresAt = !l.expiresAt || l.expiresAt < vipUntil ? vipUntil : l.expiresAt;
  const updated = await prisma.listing.update({
    where: { id: l.id },
    data: { isVip: true, vipUntil, expiresAt, expiryNotifiedAt: null },
  });
  await prisma.notification.create({
    data: {
      userId: l.userId, type: 'LISTING', title: 'Elanınız VIP oldu 👑',
      body: `«${l.title}» ${vipUntil.toLocaleDateString('az-AZ')} tarixinədək siyahılarda ən öndə göstəriləcək.`,
      link: `/marketplace/${l.id}`,
    },
  }).catch(() => {});
  pushLive(l.userId, { kind: 'listing', id: l.id, toast: `«${l.title}» VIP oldu 👑`, tone: 'success' });
  pushPublicListings({ id: l.id, reason: 'approved' });
  return updated;
}

/** Müddəti bitmiş VIP-ləri söndür (hər 10 dəqiqə) + sahibinə yeniləmə təklifi. */
export async function expireVips() {
  const now = new Date();
  const ended = await prisma.listing.findMany({ where: { isVip: true, vipUntil: { lte: now } }, select: { id: true, userId: true, title: true }, take: 500 });
  if (!ended.length) return 0;
  await prisma.listing.updateMany({ where: { id: { in: ended.map((l) => l.id) } }, data: { isVip: false } });
  await prisma.notification.createMany({
    data: ended.map((l) => ({
      userId: l.userId, type: 'LISTING', title: 'VIP müddəti bitdi',
      body: `«${l.title}» artıq VIP deyil. Yenidən önə çıxarmaq üçün elana daxil olub «VIP et» basın.`,
      link: `/marketplace/${l.id}?vip=renew`,
    })),
  }).catch(() => {});
  return ended.length;
}
