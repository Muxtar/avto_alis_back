// MƏNFİ RƏY → SATICIYA XƏBƏR.
//
// 1-2 ulduz (saytda «bəyənmədim» sayılır — reviewStats) rəy yazılanda və ya
// mövcud rəy ora endiriləndə hədəfin sahibinə (elan sahibi, obyektin biznes
// sahibi, peşəkar) bildiriş gedir. Sahib «Aldığım rəylər» səhifəsindən rəyə
// ictimai cavab yaza və müştəri ilə birbaşa əlaqə saxlaya bilər.
import { PrismaClient } from '@prisma/client';
import { pushLive } from './live';

const prisma = new PrismaClient();
export const NEGATIVE_MAX = 2;

/** Rəyin hədəfinin sahibi (cavab yazmaq/bildiriş almaq hüququ olan istifadəçi). */
export async function reviewTargetOwner(c: { listingId: number | null; objectId: number | null; professionalUserId: number | null }): Promise<{ ownerId: number; label: string; link: string } | null> {
  if (c.listingId) {
    const l = await prisma.listing.findUnique({ where: { id: c.listingId }, select: { userId: true, title: true } });
    return l ? { ownerId: l.userId, label: `«${l.title}» elanı`, link: `/marketplace/${c.listingId}` } : null;
  }
  if (c.objectId) {
    const o = await prisma.businessObject.findUnique({ where: { id: c.objectId }, select: { name: true, business: { select: { userId: true } } } });
    return o ? { ownerId: o.business.userId, label: `«${o.name}» obyekti`, link: `/object/${c.objectId}` } : null;
  }
  if (c.professionalUserId) return { ownerId: c.professionalUserId, label: 'profiliniz', link: `/seller/${c.professionalUserId}` };
  return null;
}

export async function alertNegativeReview(commentId: number) {
  try {
    const c = await prisma.comment.findUnique({ where: { id: commentId }, include: { user: { select: { name: true } } } });
    if (!c || c.rating == null || c.rating > NEGATIVE_MAX) return;
    const t = await reviewTargetOwner(c);
    if (!t || t.ownerId === c.userId) return;
    await prisma.notification.create({
      data: {
        userId: t.ownerId, type: 'LISTING',
        title: `Mənfi rəy: ${'★'.repeat(c.rating)}${'☆'.repeat(5 - c.rating)}`,
        body: `${c.user.name || 'Müştəri'} ${t.label} haqqında: "${c.content.slice(0, 120)}". Cavab yazın və ya müştəri ilə əlaqə saxlayın.`,
        link: '/reviews?filter=negative',
      },
    });
    pushLive(t.ownerId, { kind: 'notification', toast: `${t.label} üçün mənfi rəy gəldi`, tone: 'error' });
  } catch (e: any) {
    console.error('[reviewAlerts]', e?.message);
  }
}
