// MAĞAZA ADINDAN İŞLƏMƏK — icazə yoxlamaları bir yerdə.
//
// Qayda: obyektə (mağazaya) bağlı elanın SATICISI həmişə biznes sahibidir.
// İşçi mağaza adından işləyir, amma pul, məsuliyyət, reytinq və bildirişlər
// biznesdə qalır. Əvvəl işçinin yaratdığı elan onun şəxsi hesabına yazılırdı:
// sifariş, iadə və şikayət işçiyə gedir, sahib isə görmürdü; işçi işdən çıxandan
// sonra da həmin elanlara sahib olaraq qalırdı.
//
// İşçinin icazəsi HƏR sorğuda bazadan yoxlanır — sahib onu çıxaran (və ya satış
// səlahiyyətini söndürən) kimi giriş dərhal kəsilir.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Bu obyektdə satış edə bilərmi: biznes sahibi və ya satış səlahiyyətli aktiv işçi. */
export async function canSellAtObject(userId: number, objectId: number): Promise<boolean> {
  const obj = await prisma.businessObject.findUnique({ where: { id: objectId }, select: { businessId: true, business: { select: { userId: true } } } });
  if (!obj) return false;
  if (obj.business.userId === userId) return true;
  const mem = await prisma.businessMember.count({
    where: { businessId: obj.businessId, userId, status: 'ACTIVE', canSell: true, OR: [{ objectId: null }, { objectId }] },
  });
  return mem > 0;
}

/** Biznesin bütövündə (obyektə bağlanmamış) satış səlahiyyəti. */
async function canSellAtBusiness(userId: number, businessId: number): Promise<boolean> {
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { userId: true } });
  if (!biz) return false;
  if (biz.userId === userId) return true;
  const mem = await prisma.businessMember.count({ where: { businessId, userId, status: 'ACTIVE', canSell: true, objectId: null } });
  return mem > 0;
}

/** Elanı idarə edə bilərmi: sahibi, ya da elanın mağazasında satış səlahiyyətli işçi. */
export async function canManageListing(
  listing: { userId: number; businessId?: number | null; businessObjectId?: number | null },
  userId: number,
): Promise<boolean> {
  if (listing.userId === userId) return true;
  if (listing.businessObjectId) return canSellAtObject(userId, listing.businessObjectId);
  if (listing.businessId) return canSellAtBusiness(userId, listing.businessId);
  return false;
}

export interface SellableObject { id: number; name: string; businessId: number; businessName: string; owned: boolean }

/** İstifadəçinin məhsul sata biləcəyi obyektlər: öz biznesləri + işçi olduğu mağazalar. */
export async function sellableObjects(userId: number): Promise<SellableObject[]> {
  const live = { deletedAt: null, isActive: true } as const;
  const bizOk = { status: 'APPROVED', isActive: true, deletedAt: null } as const;
  const [own, mems] = await Promise.all([
    prisma.businessObject.findMany({
      where: { ...live, business: { ...bizOk, userId } },
      select: { id: true, name: true, businessId: true, business: { select: { name: true } } },
    }),
    prisma.businessMember.findMany({
      where: { userId, status: 'ACTIVE', canSell: true, business: bizOk },
      select: { businessId: true, objectId: true },
    }),
  ]);
  const out = new Map<number, SellableObject>();
  for (const o of own) out.set(o.id, { id: o.id, name: o.name, businessId: o.businessId, businessName: o.business.name, owned: true });
  if (mems.length) {
    const staffObjs = await prisma.businessObject.findMany({
      where: {
        ...live,
        OR: mems.map((m) => (m.objectId ? { id: m.objectId } : { businessId: m.businessId })),
      },
      select: { id: true, name: true, businessId: true, business: { select: { name: true } } },
    });
    for (const o of staffObjs) if (!out.has(o.id)) out.set(o.id, { id: o.id, name: o.name, businessId: o.businessId, businessName: o.business.name, owned: false });
  }
  return Array.from(out.values());
}

/**
 * Sifarişi SATICI TƏRƏFDƏN idarə edə bilərmi (təsdiq / göndərmə / ləğv):
 * sifarişin satıcısı, sifarişdəki elanların biznes sahibi, ya da həmin
 * mağazada satış səlahiyyətli işçi.
 */
export async function canManageOrderAsSeller(orderId: number, sellerId: number, userId: number): Promise<boolean> {
  if (sellerId === userId) return true;
  const items = await prisma.orderItem.findMany({ where: { orderId }, select: { listing: { select: { businessId: true, businessObjectId: true } } } });
  const bizIds = Array.from(new Set(items.map((i) => i.listing?.businessId).filter((x): x is number => !!x)));
  const objIds = Array.from(new Set(items.map((i) => i.listing?.businessObjectId).filter((x): x is number => !!x)));
  if (!bizIds.length) return false;
  const owns = await prisma.business.count({ where: { id: { in: bizIds }, userId } });
  if (owns > 0) return true;
  const mem = await prisma.businessMember.count({
    where: { userId, businessId: { in: bizIds }, status: 'ACTIVE', canSell: true, OR: [{ objectId: null }, ...(objIds.length ? [{ objectId: { in: objIds } }] : [])] },
  });
  return mem > 0;
}
