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

// ── İCAZƏLƏR ────────────────────────────────────────────────────────────────
// Əvvəl işçinin cəmi iki bayrağı var idi (satış / alış). İndi hər iş ayrıca
// icazədir və sahib işçilər arasında iş bölgüsü edə bilir:
export const STAFF_PERMS = ['listings', 'orders', 'returns', 'reviews', 'complaints', 'buy'] as const;
export type StaffPerm = typeof STAFF_PERMS[number];
export const STAFF_PERM_LABEL: Record<StaffPerm, string> = {
  listings: 'Məhsullar (əlavə, redaktə, stok)',
  orders: 'Sifarişlər (təsdiq, göndərmə, ləğv)',
  returns: 'İadələr',
  reviews: 'Rəylərə cavab',
  complaints: 'Şikayətlərə cavab',
  buy: 'Biznes adına alış',
};
// Rol şablonları — yalnız icazə dəstini doldurur; sahib sonra istədiyini dəyişə bilər.
export const STAFF_ROLES: Record<string, { label: string; perms: StaffPerm[] }> = {
  MANAGER: { label: 'Müdir', perms: ['listings', 'orders', 'returns', 'reviews', 'complaints', 'buy'] },
  SELLER: { label: 'Satıcı', perms: ['listings', 'orders'] },
  STOCK: { label: 'Anbardar', perms: ['listings'] },
  SUPPORT: { label: 'Müştəri dəstəyi', perms: ['orders', 'returns', 'reviews', 'complaints'] },
  BUYER: { label: 'Təchizatçı (alış)', perms: ['buy'] },
};

type MemberFlags = { permissions?: string[] | null; canSell: boolean; canBuy: boolean };
/** Üzvün qüvvədə olan icazələri. Yeni siyahı boşdursa köhnə bayraqlardan çıxarılır. */
export function effectivePerms(m: MemberFlags): string[] {
  if (m.permissions && m.permissions.length) return m.permissions;
  return [...(m.canSell ? ['listings', 'orders'] : []), ...(m.canBuy ? ['buy'] : [])];
}
/** Saxlanacaq dəyərlər: icazə siyahısı + köhnə bayraqlar (köhnə kod və iOS üçün sinxron). */
export function permsToData(perms: string[]) {
  const clean = Array.from(new Set(perms.filter((p): p is StaffPerm => (STAFF_PERMS as readonly string[]).includes(p))));
  return { permissions: clean, canSell: clean.includes('listings') || clean.includes('orders'), canBuy: clean.includes('buy') };
}

const memberSelect = { businessId: true, objectId: true, permissions: true, canSell: true, canBuy: true } as const;

/** Bu obyektdə icazəsi varmı: biznes sahibi və ya həmin icazəli aktiv işçi. */
export async function hasObjectPerm(userId: number, objectId: number, perm: StaffPerm): Promise<boolean> {
  const obj = await prisma.businessObject.findUnique({ where: { id: objectId }, select: { businessId: true, business: { select: { userId: true } } } });
  if (!obj) return false;
  if (obj.business.userId === userId) return true;
  const rows = await prisma.businessMember.findMany({
    where: { businessId: obj.businessId, userId, status: 'ACTIVE', OR: [{ objectId: null }, { objectId }] },
    select: memberSelect,
  });
  return rows.some((r) => effectivePerms(r).includes(perm));
}

/** Biznesin bütövündə (obyektə bağlanmamış üzvlüklə) icazə. */
export async function hasBusinessPerm(userId: number, businessId: number, perm: StaffPerm): Promise<boolean> {
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { userId: true } });
  if (!biz) return false;
  if (biz.userId === userId) return true;
  const rows = await prisma.businessMember.findMany({ where: { businessId, userId, status: 'ACTIVE', objectId: null }, select: memberSelect });
  return rows.some((r) => effectivePerms(r).includes(perm));
}

/** İşçi kimi (sahib kimi yox) bu icazəyə malik olduğum obyektlərin id-ləri. */
export async function staffObjectIds(userId: number, perm: StaffPerm): Promise<number[]> {
  const rows = (await prisma.businessMember.findMany({
    where: { userId, status: 'ACTIVE', business: { deletedAt: null } }, select: memberSelect,
  })).filter((r) => effectivePerms(r).includes(perm));
  if (!rows.length) return [];
  const objs = await prisma.businessObject.findMany({
    where: { deletedAt: null, OR: rows.map((r) => (r.objectId ? { id: r.objectId } : { businessId: r.businessId })) },
    select: { id: true },
  });
  return objs.map((o) => o.id);
}

/** Bu obyektdə məhsul sata bilərmi (elan əlavə / redaktə). */
export async function canSellAtObject(userId: number, objectId: number): Promise<boolean> {
  return hasObjectPerm(userId, objectId, 'listings');
}

async function canSellAtBusiness(userId: number, businessId: number): Promise<boolean> {
  return hasBusinessPerm(userId, businessId, 'listings');
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
      where: { userId, status: 'ACTIVE', business: bizOk },
      select: memberSelect,
    }),
  ]);
  const out = new Map<number, SellableObject>();
  for (const o of own) out.set(o.id, { id: o.id, name: o.name, businessId: o.businessId, businessName: o.business.name, owned: true });
  const sellMems = mems.filter((m) => effectivePerms(m).includes('listings'));
  if (sellMems.length) {
    const staffObjs = await prisma.businessObject.findMany({
      where: {
        ...live,
        OR: sellMems.map((m) => (m.objectId ? { id: m.objectId } : { businessId: m.businessId })),
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
 * mağazada uyğun icazəli işçi (`perm`: sifariş, iadə, şikayət...).
 */
export async function canManageOrderAsSeller(orderId: number, sellerId: number, userId: number, perm: StaffPerm = 'orders'): Promise<boolean> {
  if (sellerId === userId) return true;
  const items = await prisma.orderItem.findMany({ where: { orderId }, select: { listing: { select: { businessId: true, businessObjectId: true } } } });
  const bizIds = Array.from(new Set(items.map((i) => i.listing?.businessId).filter((x): x is number => !!x)));
  const objIds = Array.from(new Set(items.map((i) => i.listing?.businessObjectId).filter((x): x is number => !!x)));
  if (!bizIds.length) return false;
  const owns = await prisma.business.count({ where: { id: { in: bizIds }, userId } });
  if (owns > 0) return true;
  const rows = await prisma.businessMember.findMany({
    where: { userId, businessId: { in: bizIds }, status: 'ACTIVE', OR: [{ objectId: null }, ...(objIds.length ? [{ objectId: { in: objIds } }] : [])] },
    select: memberSelect,
  });
  return rows.some((r) => effectivePerms(r).includes(perm));
}
