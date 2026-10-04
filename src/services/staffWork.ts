// MAĞAZA İŞÇİLƏRİ — iş bölgüsü üçün köməkçilər:
//   • notifyStaff: hadisə (yeni sifariş, iadə, rəy, şikayət) yalnız sahibə yox,
//     həmin iş üzrə İCAZƏSİ olan işçilərə də bildirilir;
//   • logStaffActivity: kim nə etdi — sahibin gördüyü əməliyyat jurnalı;
//   • objectOfOrder / objectOfListing: hadisənin hansı mağazaya aid olduğu.
import { PrismaClient } from '@prisma/client';
import { pushLive, LiveKind } from './live';
import { effectivePerms, StaffPerm } from './bizAccess';

const prisma = new PrismaClient();

export async function objectOfListing(listingId: number): Promise<{ objectId: number | null; businessId: number | null }> {
  const l = await prisma.listing.findUnique({ where: { id: listingId }, select: { businessObjectId: true, businessId: true } });
  return { objectId: l?.businessObjectId ?? null, businessId: l?.businessId ?? null };
}

export async function objectOfOrder(orderId: number): Promise<{ objectId: number | null; businessId: number | null }> {
  const it = await prisma.orderItem.findFirst({
    where: { orderId, listing: { businessId: { not: null } } },
    select: { listing: { select: { businessObjectId: true, businessId: true } } },
  });
  return { objectId: it?.listing?.businessObjectId ?? null, businessId: it?.listing?.businessId ?? null };
}

/** Bu mağazada verilmiş icazəsi olan aktiv işçilərin id-ləri (sahib daxil deyil). */
export async function staffWithPerm(businessId: number, objectId: number | null, perm: StaffPerm): Promise<number[]> {
  const rows = await prisma.businessMember.findMany({
    where: { businessId, status: 'ACTIVE', OR: [{ objectId: null }, ...(objectId ? [{ objectId }] : [])] },
    select: { userId: true, permissions: true, canSell: true, canBuy: true },
  });
  return Array.from(new Set(rows.filter((r) => effectivePerms(r).includes(perm)).map((r) => r.userId)));
}

/**
 * Hadisəni icazəli işçilərə bildir (bildiriş + açıq səhifədə canlı xəbər).
 * `exceptUserId` — əməliyyatı edən (ona özü haqqında bildiriş getmir).
 * Xəta əsas axını pozmur.
 */
export async function notifyStaff(
  at: { businessId: number | null; objectId: number | null },
  perm: StaffPerm,
  n: { type: string; title: string; body: string; link: string; kind: LiveKind; id?: number },
  exceptUserId?: number | null,
): Promise<number[]> {
  try {
    if (!at.businessId) return [];
    const ids = (await staffWithPerm(at.businessId, at.objectId, perm)).filter((id) => id !== exceptUserId);
    if (!ids.length) return [];
    await prisma.notification.createMany({ data: ids.map((userId) => ({ userId, type: n.type as any, title: n.title, body: n.body, link: n.link })) }).catch(() => {});
    pushLive(ids, { kind: n.kind, id: n.id, toast: n.title, tone: 'info' });
    return ids;
  } catch (e) {
    console.error('[staffWork] notifyStaff:', (e as any)?.message);
    return [];
  }
}

/** Əməliyyat jurnalına yaz. Mağazaya (biznesə) aid deyilsə heç nə yazılmır. */
export async function logStaffActivity(
  at: { businessId: number | null; objectId: number | null },
  userId: number,
  a: { action: string; targetType?: string; targetId?: number; summary: string },
): Promise<void> {
  try {
    if (!at.businessId) return;
    const [u, biz] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
      prisma.business.findUnique({ where: { id: at.businessId }, select: { userId: true } }),
    ]);
    await prisma.staffActivity.create({
      data: {
        businessId: at.businessId, objectId: at.objectId, userId, userName: u?.name || `#${userId}`,
        isOwner: biz?.userId === userId, action: a.action, targetType: a.targetType ?? null, targetId: a.targetId ?? null,
        summary: a.summary.slice(0, 300),
      },
    });
  } catch (e) {
    console.error('[staffWork] logStaffActivity:', (e as any)?.message);
  }
}

/** Cavab uğurlu (2xx/3xx) bitəndə işlət — jurnal yalnız baş tutan əməliyyatı yazsın. */
export function onSuccess(res: { on: (ev: string, cb: () => void) => void; statusCode: number }, fn: () => void) {
  res.on('finish', () => { if (res.statusCode < 400) { try { fn(); } catch { /* jurnal əsas axını pozmasın */ } } });
}

/** Yeni sifarişlər — «sifarişlər» icazəli işçilərə (satıcıya ayrıca bildiriş gedir). */
export async function notifyStaffNewOrders(orderIds: number[]): Promise<void> {
  for (const id of new Set(orderIds)) {
    const o = await prisma.order.findUnique({ where: { id }, select: { id: true, total: true, status: true } }).catch(() => null);
    if (!o || o.status === 'CANCELLED') continue;
    await notifyStaff(await objectOfOrder(id), 'orders', {
      type: 'ORDER', title: `Yeni sifariş #${id}`, body: `${o.total.toFixed(2)} AZN — mağazanın təsdiqini gözləyir.`,
      link: '/business/sales', kind: 'order', id,
    });
  }
}

/** Yeni rəy — «rəylərə cavab» icazəli işçilərə. */
export async function notifyStaffNewReview(commentId: number): Promise<void> {
  try {
    const c = await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true, userId: true, rating: true, content: true, listingId: true, objectId: true } });
    if (!c) return;
    let at = { objectId: c.objectId as number | null, businessId: null as number | null };
    if (c.objectId) at.businessId = (await prisma.businessObject.findUnique({ where: { id: c.objectId }, select: { businessId: true } }))?.businessId ?? null;
    else if (c.listingId) at = await objectOfListing(c.listingId);
    const stars = c.rating ? `${'★'.repeat(c.rating)}${'☆'.repeat(Math.max(0, 5 - c.rating))} ` : '';
    await notifyStaff(at, 'reviews', {
      type: 'LISTING', title: `Yeni rəy ${stars}`.trim(), body: `«${(c.content || '').slice(0, 140)}» — cavab yaza bilərsiniz.`,
      link: '/reviews', kind: 'notification',
    }, c.userId);
  } catch (e) { console.error('[staffWork] notifyStaffNewReview:', (e as any)?.message); }
}
