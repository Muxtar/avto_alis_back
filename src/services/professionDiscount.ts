// İXTİSAS ENDİRİMİ + TƏSDİQLİ İXTİSAS.
//
// 1) Təsdiqli ixtisas: istifadəçinin profildə YAZDIĞI ixtisas heç nəyi sübut
//    etmir. Sübut — admin tərəfindən APPROVED edilmiş, HƏMİN ixtisasa bağlı
//    (ProfessionDocument.profession) və müddəti keçməmiş sənəddir.
//    Köhnə sənədlər (ixtisas sahəsi olmadan təsdiqlənib): AI yükləmə anında
//    sənədi əsas ixtisasla uyğun bilmişdisə (professionMatch) — əsas ixtisası sübut edir.
//
// 2) Mağaza (biznes obyekti) ixtisas üzrə endirim qaydası qoyur: «Həkim −10%».
//    Alıcının təsdiqli ixtisası uyğun gəlirsə — endirim həmin mağazanın
//    məhsullarına tətbiq olunur. Bir neçə qayda uyğundursa — ən yüksəyi.
//    Qiymət təklifi (razılaşdırılmış qiymət) və birgə alış sətirlərinə tətbiq olunmur.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const r2 = (n: number) => Math.round(n * 100) / 100;
export const normProf = (s: string | null | undefined) => (s || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('az');
export const PRO_DISCOUNT_MAX = 50;

/** İstifadəçinin SƏNƏDLƏ sübut etdiyi ixtisaslar (normallaşdırılmış). */
export async function verifiedProfessions(userId: number): Promise<Set<string>> {
  const now = new Date();
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      profession: true,
      professionDocuments: {
        where: { status: 'APPROVED', OR: [{ validUntil: null }, { validUntil: { gt: now } }] },
        select: { profession: true, professionMatch: true },
      },
    },
  });
  const out = new Set<string>();
  if (!u) return out;
  for (const d of u.professionDocuments) {
    if (d.profession) out.add(normProf(d.profession));
    else if (d.professionMatch && u.profession) out.add(normProf(u.profession));
  }
  return out;
}

export async function hasVerifiedProfession(userId: number, profession: string): Promise<boolean> {
  return (await verifiedProfessions(userId)).has(normProf(profession));
}

export interface ProRule { id: number; businessObjectId: number; profession: string; percent: number; scope: string; listingIds: number[]; maxDiscountPerOrder: number | null; maxUnitsPerOrder: number | null }

/** Obyektlərin HAZIRDA aktiv qaydaları. */
export async function activeRules(objectIds: number[]): Promise<ProRule[]> {
  if (!objectIds.length) return [];
  const now = new Date();
  return prisma.professionDiscount.findMany({
    where: { businessObjectId: { in: objectIds }, active: true, OR: [{ validUntil: null }, { validUntil: { gt: now } }] },
    select: { id: true, businessObjectId: true, profession: true, percent: true, scope: true, listingIds: true, maxDiscountPerOrder: true, maxUnitsPerOrder: true },
  });
}

const ruleCovers = (r: ProRule, listingId: number) => r.scope !== 'SELECTED' || r.listingIds.includes(listingId);

/**
 * Alıcı üçün hər elana uyğun ən yaxşı qayda (yoxdursa xəritədə olmur).
 * listings: { id, businessObjectId, userId }.
 */
export async function bestRulesForBuyer(buyerId: number | null | undefined, listings: { id: number; businessObjectId: number | null; userId: number }[]) {
  const out = new Map<number, ProRule>();
  if (!buyerId) return out;
  const objIds = Array.from(new Set(listings.map((l) => l.businessObjectId).filter((x): x is number => !!x)));
  if (!objIds.length) return out;
  const rules = await activeRules(objIds);
  if (!rules.length) return out;
  const mine = await verifiedProfessions(buyerId);
  if (!mine.size) return out;
  for (const l of listings) {
    if (!l.businessObjectId || l.userId === buyerId) continue;
    const best = rules
      .filter((r) => r.businessObjectId === l.businessObjectId && mine.has(normProf(r.profession)) && ruleCovers(r, l.id))
      .sort((a, b) => b.percent - a.percent)[0];
    if (best) out.set(l.id, best);
  }
  return out;
}

export interface ProLine { key: number; listingId: number; qty: number; unit: number; skip?: boolean }
export interface ProPriced { unit: number; discount: number; percent: number | null; profession: string | null; ruleId: number | null; listUnit: number }

/**
 * Sətirlərə ixtisas endirimini tətbiq et (səbət göstərişi və checkout eyni
 * funksiyanı işlədir — rəqəmlər üst-üstə düşsün).
 * `maxUnitsPerOrder` — hər sətirdə endirimli ədəd sayı; `maxDiscountPerOrder`
 * — bir sifarişdə (bütün sətirlər) həmin qaydadan cəmi endirim.
 */
export function applyProDiscounts(lines: ProLine[], rules: Map<number, ProRule>): Map<number, ProPriced> {
  const used = new Map<number, number>(); // ruleId → istifadə olunan endirim ₼
  const out = new Map<number, ProPriced>();
  for (const ln of lines) {
    const r = ln.skip ? undefined : rules.get(ln.listingId);
    if (!r || ln.unit <= 0 || ln.qty <= 0) { out.set(ln.key, { unit: ln.unit, discount: 0, percent: null, profession: null, ruleId: null, listUnit: ln.unit }); continue; }
    const pct = Math.min(PRO_DISCOUNT_MAX, Math.max(0, r.percent));
    const units = r.maxUnitsPerOrder ? Math.min(ln.qty, r.maxUnitsPerOrder) : ln.qty;
    let disc = r2(ln.unit * units * pct / 100);
    if (r.maxDiscountPerOrder != null) disc = Math.max(0, Math.min(disc, r2(r.maxDiscountPerOrder - (used.get(r.id) || 0))));
    used.set(r.id, (used.get(r.id) || 0) + disc);
    // Vahid qiymət yuvarlaqlaşdırılmır — say × qiymət cəmi səbətdəki ilə qəpiyinədək eyni olsun.
    const unit = disc > 0 ? (ln.unit * ln.qty - disc) / ln.qty : ln.unit;
    out.set(ln.key, { unit, discount: disc, percent: disc > 0 ? pct : null, profession: disc > 0 ? r.profession : null, ruleId: disc > 0 ? r.id : null, listUnit: ln.unit });
  }
  return out;
}

/** Elan səhifəsi üçün: mağazanın ixtisas endirimləri + bu alıcının statusu. */
export async function listingProDiscountInfo(listing: { id: number; businessObjectId: number | null; userId: number }, viewerId?: number | null) {
  if (!listing.businessObjectId) return { rules: [], mine: null as null | { percent: number; profession: string }, missingDoc: [] as string[] };
  const rules = (await activeRules([listing.businessObjectId])).filter((r) => ruleCovers(r, listing.id)).sort((a, b) => b.percent - a.percent);
  let mine: { percent: number; profession: string } | null = null;
  let missingDoc: string[] = [];
  if (viewerId && viewerId !== listing.userId && rules.length) {
    const verified = await verifiedProfessions(viewerId);
    const hit = rules.find((r) => verified.has(normProf(r.profession)));
    if (hit) mine = { percent: hit.percent, profession: hit.profession };
    else {
      // Profildə yazılıb, amma sənədlə təsdiqlənməyib — istifadəçiyə nə etməli olduğunu deyirik.
      const u = await prisma.user.findUnique({ where: { id: viewerId }, select: { profession: true, professions: true } });
      const claimed = new Set([u?.profession, ...(u?.professions || [])].map(normProf).filter(Boolean));
      missingDoc = rules.filter((r) => claimed.has(normProf(r.profession))).map((r) => r.profession);
    }
  }
  return {
    rules: rules.map((r) => ({ profession: r.profession, percent: r.percent, maxUnitsPerOrder: r.maxUnitsPerOrder, maxDiscountPerOrder: r.maxDiscountPerOrder })),
    mine, missingDoc,
  };
}
