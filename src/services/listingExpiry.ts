// ELAN MÜDDƏTİNİN BİTMƏSİ — sahibinə bildiriş.
//
// Elan 20 gündən sonra (expiresAt) marketplace-dən avtomatik gizlənir, amma
// sahibi bundan xəbər tutmurdu. İndi müddət bitən kimi sahibinə bildiriş
// gedir; bildirişə basanda elanın səhifəsi açılır və oradan «Yenilə» ilə
// elan yenidən 20 günlük aktiv edilir.
import { PrismaClient } from '@prisma/client';
import { pushLive } from './live';

const prisma = new PrismaClient();

// Yalnız son 3 gündə bitmiş elanlar üçün — ilk işə düşəndə aylar əvvəl
// bitmiş köhnə elanlara toplu bildiriş yağmasın.
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

export async function notifyExpiredListings(): Promise<number> {
  try {
    const now = new Date();
    const expired = await prisma.listing.findMany({
      where: {
        status: 'APPROVED',
        archivedAt: null,
        expiryNotifiedAt: null,
        expiresAt: { lte: now, gt: new Date(now.getTime() - LOOKBACK_MS) },
      },
      select: { id: true, userId: true, title: true },
      take: 500,
    });
    for (const l of expired) {
      // Əvvəlcə işarələ — paralel işə düşmədə eyni elana iki bildiriş getməsin.
      const claimed = await prisma.listing.updateMany({
        where: { id: l.id, expiryNotifiedAt: null },
        data: { expiryNotifiedAt: now },
      });
      if (claimed.count === 0) continue;
      await prisma.notification.create({
        data: {
          userId: l.userId,
          type: 'LISTING',
          title: 'Elanınızın müddəti bitdi',
          body: `«${l.title}» elanı artıq saytda görünmür. Baxıb yeniləyə bilərsiniz.`,
          link: `/marketplace/${l.id}?renew=1`,
        },
      }).catch(() => {});
      pushLive(l.userId, { kind: 'listing', id: l.id, toast: `«${l.title}» elanının müddəti bitdi`, tone: 'info' });
    }
    if (expired.length > 0) console.log(`[listingExpiry] ${expired.length} elanın müddəti bitdi — sahiblərinə bildiriş göndərildi.`);
    return expired.length;
  } catch (e) {
    console.error('[listingExpiry] notifyExpiredListings:', (e as any)?.message);
    return 0;
  }
}
