// ANA SƏHİFƏ REKLAMI — ödənişli.
//
// İstənilən istifadəçi (fərdi və ya sahibkar) öz elanını və ya obyektini ana
// səhifənin karuselində (MAIN) və ya yan bannerində (SIDE) reklam edir.
// Ödəniş VIP ilə eyni bank axınından keçir (BusinessFee, purpose=AD).
//
// Axın: UNPAID → (ödəniş callback) PENDING_REVIEW → (admin təsdiqi) ACTIVE → EXPIRED
//       Admin rədd edərsə REJECTED + refundStatus=PENDING (pul qaytarılmalıdır).
// Müddət admin TƏSDİQLƏYƏNDƏ başlayır — ödənilmiş gün yoxlamada itməsin.
import { PrismaClient } from '@prisma/client';
import { getNumber } from './settings';
import { pushLive, pushAdmins } from './live';

const prisma = new PrismaClient();
const DAY = 24 * 60 * 60 * 1000;

export const AD_PLACEMENTS = ['MAIN', 'SIDE'] as const;
export type AdPlacement = typeof AD_PLACEMENTS[number];
// Gün paketləri və uzun paket endirimi (faizlə).
export const AD_DAYS: { days: number; discount: number }[] = [
  { days: 3, discount: 0 },
  { days: 7, discount: 10 },
  { days: 14, discount: 15 },
  { days: 30, discount: 25 },
];

export const PLACEMENT_LABEL: Record<AdPlacement, string> = {
  MAIN: 'Ana karusel',
  SIDE: 'Yan banner',
};

export async function adPricePerDay(placement: AdPlacement): Promise<number> {
  return getNumber(placement === 'MAIN' ? 'ad_main_price_per_day' : 'ad_side_price_per_day');
}

export async function adMaxSlots(placement: AdPlacement): Promise<number> {
  return getNumber(placement === 'MAIN' ? 'ad_main_max_slots' : 'ad_side_max_slots');
}

export function adPrice(perDay: number, days: number): number {
  const pkg = AD_DAYS.find((d) => d.days === days);
  if (!pkg) throw new Error('Paket seçin');
  return Math.round(perDay * days * (100 - pkg.discount)) / 100;
}

/** Slot dolulugu: aktiv + yoxlamada olanlar sayılır. */
export async function slotUsage(placement: AdPlacement) {
  const now = new Date();
  const [max, used, nextFree] = await Promise.all([
    adMaxSlots(placement),
    prisma.homeAd.count({
      where: { placement, OR: [{ status: 'PENDING_REVIEW' }, { status: 'ACTIVE', endsAt: { gt: now } }] },
    }),
    prisma.homeAd.findFirst({
      where: { placement, status: 'ACTIVE', endsAt: { gt: now } },
      orderBy: { endsAt: 'asc' }, select: { endsAt: true },
    }),
  ]);
  return { max, used, free: Math.max(0, max - used), nextFreeAt: nextFree?.endsAt ?? null };
}

export async function adPackages() {
  const placements = await Promise.all(AD_PLACEMENTS.map(async (p) => {
    const perDay = await adPricePerDay(p);
    const usage = await slotUsage(p);
    return {
      key: p, label: PLACEMENT_LABEL[p], perDay, ...usage,
      packages: AD_DAYS.map((d) => ({ days: d.days, discount: d.discount, price: adPrice(perDay, d.days) })),
    };
  }));
  return { placements };
}

/** Ödəniş təsdiqləndi (və ya pulsuz) → admin yoxlamasına. */
export async function markAdPaid(adId: number) {
  const ad = await prisma.homeAd.findUnique({ where: { id: adId } });
  if (!ad || ad.status !== 'UNPAID') return;
  await prisma.homeAd.update({ where: { id: adId }, data: { status: 'PENDING_REVIEW' } });
  await prisma.notification.create({
    data: {
      userId: ad.userId, type: 'SYSTEM', title: 'Reklam ödənişi qəbul edildi ✓',
      body: `«${ad.headline}» reklamınız yoxlamaya göndərildi. Təsdiqlənən kimi ana səhifədə ${ad.days} gün göstəriləcək.`,
      link: '/reklam',
    },
  }).catch(() => {});
  pushLive(ad.userId, { kind: 'listing', id: ad.id, toast: 'Reklam ödənişi qəbul edildi — yoxlamadadır', tone: 'success' });
  pushAdmins('ad', { id: ad.id, toast: 'Yeni reklam yoxlama gözləyir' });
}

export async function approveAd(adId: number) {
  const ad = await prisma.homeAd.findUnique({ where: { id: adId } });
  if (!ad) throw new Error('Reklam tapılmadı');
  if (ad.status !== 'PENDING_REVIEW') throw new Error('Yalnız yoxlamada olan reklam təsdiqlənə bilər');
  const now = new Date();
  const updated = await prisma.homeAd.update({
    where: { id: adId },
    data: { status: 'ACTIVE', startsAt: now, endsAt: new Date(now.getTime() + ad.days * DAY), rejectReason: null },
  });
  await prisma.notification.create({
    data: {
      userId: ad.userId, type: 'SYSTEM', title: 'Reklamınız yayımdadır 📣',
      body: `«${ad.headline}» ${updated.endsAt!.toLocaleDateString('az-AZ')} tarixinədək ana səhifədə göstəriləcək.`,
      link: '/reklam',
    },
  }).catch(() => {});
  pushLive(ad.userId, { kind: 'listing', id: ad.id, toast: 'Reklamınız ana səhifədə yayımdadır 📣', tone: 'success' });
  return updated;
}

export async function rejectAd(adId: number, reason: string) {
  const ad = await prisma.homeAd.findUnique({ where: { id: adId } });
  if (!ad) throw new Error('Reklam tapılmadı');
  if (ad.status !== 'PENDING_REVIEW' && ad.status !== 'ACTIVE') throw new Error('Bu reklam rədd edilə bilməz');
  const paid = ad.amount > 0;
  const updated = await prisma.homeAd.update({
    where: { id: adId },
    data: { status: 'REJECTED', rejectReason: reason.slice(0, 300), refundStatus: paid ? 'PENDING' : null, endsAt: new Date() },
  });
  await prisma.notification.create({
    data: {
      userId: ad.userId, type: 'SYSTEM', title: 'Reklam qəbul edilmədi',
      body: `«${ad.headline}»: ${reason.slice(0, 200)}${paid ? ` Ödənilmiş ${ad.amount.toFixed(2)} AZN kartınıza qaytarılacaq.` : ''}`,
      link: '/reklam',
    },
  }).catch(() => {});
  pushLive(ad.userId, { kind: 'listing', id: ad.id, toast: 'Reklam qəbul edilmədi', tone: 'error' });
  return updated;
}

/** Müddəti bitmiş reklamları bağla (hər 10 dəqiqə). */
export async function expireAds() {
  const now = new Date();
  // Ödənişə getməyib yarımçıq qalan reklamlar (2 gündən köhnə) silinir.
  await prisma.homeAd.deleteMany({ where: { status: 'UNPAID', createdAt: { lt: new Date(now.getTime() - 2 * DAY) } } }).catch(() => {});
  const ended = await prisma.homeAd.findMany({ where: { status: 'ACTIVE', endsAt: { lte: now } }, select: { id: true, userId: true, headline: true }, take: 500 });
  if (!ended.length) return 0;
  await prisma.homeAd.updateMany({ where: { id: { in: ended.map((a) => a.id) } }, data: { status: 'EXPIRED' } });
  await prisma.notification.createMany({
    data: ended.map((a) => ({
      userId: a.userId, type: 'SYSTEM', title: 'Reklam müddəti bitdi',
      body: `«${a.headline}» artıq ana səhifədə göstərilmir. Yenidən reklam vermək üçün «Reklamlarım» bölməsinə keçin.`,
      link: '/reklam',
    })),
  }).catch(() => {});
  return ended.length;
}
