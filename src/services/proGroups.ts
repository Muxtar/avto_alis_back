// PEŞƏ QRUPLARI — «Bakı · Həkim».
//
// Qaydalar:
//   • Hər şəhər + ixtisas cütü üçün BİR qrup (kind=PRO_CITY). Yoxdursa ilk uyğun
//     istifadəçi ilə yaradılır, varsa sadəcə əlavə olunur.
//   • Qeydiyyatda və ixtisas əlavə ediləndə — AVTOMATİK qoşulma.
//   • Şəhər dəyişəndə — köhnə şəhərin qrupundan avtomatik ÇIXARILMIR: istifadəçi
//     özü təsdiqləyir (çıx / qal). Yeni şəhərin qrupu isə TƏKLİF kimi görünür.
//   • İxtisas silinəndə — eyni: qrup «uyğun deyil» kimi təklif olunur, çıxmaq özünə qalır.
//   • İstifadəçi yalnız ÖZ şəhəri + ÖZ ixtisası üzrə qrupa qoşula bilər.
//   • Özü çıxıbsa (opt-out) — sistem onu geri avtomatik əlavə etmir; özü qoşula bilər.
//   • Qrupda admin yoxdur: heç kim başqasını əlavə/çıxara, adı dəyişə bilməz.
import { PrismaClient } from '@prisma/client';
import { emitToUser } from './callSignaling';

const prisma = new PrismaClient();

const norm = (s: string | null | undefined) => (s || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('az');
// Şəhər yazılışları: «Baku», «Bakı şəhəri», «BAKI» → «bakı».
const CITY_ALIASES: Record<string, string> = { baku: 'bakı', 'baki': 'bakı', ganja: 'gəncə', gence: 'gəncə', sumgait: 'sumqayıt', sumqayit: 'sumqayıt', lankaran: 'lənkəran', lenkeran: 'lənkəran', sheki: 'şəki', seki: 'şəki', mingachevir: 'mingəçevir', mingecevir: 'mingəçevir', shirvan: 'şirvan', quba: 'quba', nakhchivan: 'naxçıvan', naxcivan: 'naxçıvan' };
export function cityKeyOf(city: string | null | undefined): string {
  let k = norm(city).replace(/\s+(şəhəri|seheri|şəhər|rayonu|r-nu|city)$/u, '').trim();
  return CITY_ALIASES[k] || k;
}
export const professionKeyOf = (p: string | null | undefined) => norm(p);
const cap = (s: string) => s.trim().replace(/\s+/g, ' ');

export interface ProfileLike { city: string | null; profession: string | null; professions: string[] }
export const professionsOf = (u: { profession: string | null; professions: string[] | null }) =>
  Array.from(new Map([u.profession, ...(u.professions || [])].filter(Boolean).map((p) => [professionKeyOf(p!), cap(p!)])).values()).slice(0, 3);

/** Şəhər + ixtisas qrupunu tap və ya yarat. */
export async function ensureGroup(city: string, profession: string, creatorId: number) {
  const cityKey = cityKeyOf(city), professionKey = professionKeyOf(profession);
  const found = await prisma.conversation.findUnique({ where: { kind_cityKey_professionKey: { kind: 'PRO_CITY', cityKey, professionKey } } });
  if (found) return found;
  try {
    return await prisma.conversation.create({
      data: { kind: 'PRO_CITY', cityKey, professionKey, city: cap(city), profession: cap(profession), name: `${cap(city)} · ${cap(profession)}`, createdById: creatorId },
    });
  } catch {
    // Paralel qeydiyyat — başqası artıq yaratdı.
    return prisma.conversation.findUniqueOrThrow({ where: { kind_cityKey_professionKey: { kind: 'PRO_CITY', cityKey, professionKey } } });
  }
}

async function addMember(conversationId: number, userId: number) {
  await prisma.proGroupOptOut.deleteMany({ where: { conversationId, userId } });
  await prisma.conversationMember.upsert({
    where: { conversationId_userId: { conversationId, userId } },
    create: { conversationId, userId, role: 'MEMBER' },
    update: { keepStale: false },
  });
  emitToUser(userId, 'chat:groupChanged', { conversationId });
}

/**
 * İstifadəçinin peşə qruplarını sinxronla.
 *   mode=AUTO    — qeydiyyat / yeni ixtisas: uyğun qruplara avtomatik qoşul (opt-out olanlar xaric).
 *   mode=PASSIVE — heç nəyə avtomatik qoşulmur (şəhər dəyişəndə, sadə baxış).
 * Köhnə istifadəçi ilk dəfə (proGroupsSyncedAt=null) PASSIVE çağırılsa belə AUTO işləyir.
 * `onlyProfessions` — AUTO yalnız bu ixtisaslara (məs. yeni əlavə olunan) tətbiq olunsun.
 */
export async function syncProGroups(userId: number, mode: 'AUTO' | 'PASSIVE', onlyProfessions?: string[]) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { city: true, profession: true, professions: true, isBlocked: true, proGroupsSyncedAt: true } });
  if (!u || u.isBlocked) return;
  const firstTime = !u.proGroupsSyncedAt;
  const effMode = firstTime ? 'AUTO' : mode;
  if (effMode === 'AUTO' && u.city) {
    const only = onlyProfessions ? new Set(onlyProfessions.map(professionKeyOf)) : null;
    for (const p of professionsOf(u)) {
      if (only && !only.has(professionKeyOf(p))) continue;
      const g = await ensureGroup(u.city, p, userId);
      const opted = await prisma.proGroupOptOut.findUnique({ where: { conversationId_userId: { conversationId: g.id, userId } } });
      if (opted) continue;
      const already = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: g.id, userId } } });
      if (!already) await addMember(g.id, userId);
    }
  }
  if (firstTime) await prisma.user.update({ where: { id: userId }, data: { proGroupsSyncedAt: new Date() } });
}

/** Profil yeniləndi — dəyişikliyə görə düzgün rejimlə sinxronla və lazım olsa bildiriş göndər. */
export async function onProfileChanged(userId: number, before: ProfileLike, after: ProfileLike) {
  const cityChanged = cityKeyOf(before.city) !== cityKeyOf(after.city);
  const beforeKeys = new Set(professionsOf(before).map(professionKeyOf));
  const added = professionsOf(after).filter((p) => !beforeKeys.has(professionKeyOf(p)));
  if (cityChanged) {
    // Yeni şəhərdə avtomatik qoşulma yoxdur — təklif; köhnə qrupdan çıxmaq özünə qalır.
    await syncProGroups(userId, 'PASSIVE');
    const stale = await staleMemberships(userId);
    if (after.city && (stale.length || professionsOf(after).length)) {
      await prisma.notification.create({
        data: {
          userId, type: 'SYSTEM', title: `Şəhəriniz dəyişdi: ${after.city}`,
          body: `${professionsOf(after).length ? `«${after.city}» üzrə peşə qrupunuza qoşula bilərsiniz. ` : ''}${stale.length ? `Köhnə şəhərin qrupundan (${stale.map((s) => s.name).join(', ')}) çıxmaq istəyirsinizsə təsdiqləyin.` : ''}`.trim(),
          link: '/messages?proGroups=1',
        },
      }).catch(() => {});
    }
  } else if (added.length) {
    await syncProGroups(userId, 'AUTO', added);
  }
}

/** İstifadəçinin üzv olduğu, amma artıq uyğun olmayan peşə qrupları («qal» deyilənlər xaric). */
async function staleMemberships(userId: number) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { city: true, profession: true, professions: true } });
  const cKey = cityKeyOf(u?.city);
  const pKeys = new Set(u ? professionsOf(u).map(professionKeyOf) : []);
  const mine = await prisma.conversationMember.findMany({ where: { userId, keepStale: false, conversation: { kind: 'PRO_CITY' } }, include: { conversation: true } });
  return mine.filter((m) => m.conversation.cityKey !== cKey || !pKeys.has(m.conversation.professionKey || '')).map((m) => ({
    conversationId: m.conversationId, name: m.conversation.name,
    reason: m.conversation.cityKey !== cKey ? 'CITY' : 'PROFESSION',
  }));
}

/** Peşə qrupları görünüşü: üzvlüklər + qoşulma təklifləri + çıxma təklifləri. */
export async function proGroupsOverview(userId: number) {
  await syncProGroups(userId, 'PASSIVE');
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { city: true, profession: true, professions: true } });
  if (!u) return null;
  const profs = professionsOf(u);
  const cKey = cityKeyOf(u.city);
  const mine = await prisma.conversationMember.findMany({ where: { userId, conversation: { kind: 'PRO_CITY' } }, include: { conversation: { include: { _count: { select: { members: true } } } } } });
  const joinable: { profession: string; city: string; conversationId: number | null; memberCount: number; optedOut: boolean }[] = [];
  if (u.city) {
    for (const p of profs) {
      const g = await prisma.conversation.findUnique({ where: { kind_cityKey_professionKey: { kind: 'PRO_CITY', cityKey: cKey, professionKey: professionKeyOf(p) } }, include: { _count: { select: { members: true } } } });
      if (g && mine.some((m) => m.conversationId === g.id)) continue;
      const opted = g ? !!(await prisma.proGroupOptOut.findUnique({ where: { conversationId_userId: { conversationId: g.id, userId } } })) : false;
      joinable.push({ profession: p, city: u.city, conversationId: g?.id ?? null, memberCount: g?._count.members ?? 0, optedOut: opted });
    }
  }
  return {
    city: u.city, professions: profs,
    groups: mine.map((m) => ({
      id: m.conversationId, name: m.conversation.name, city: m.conversation.city, profession: m.conversation.profession,
      memberCount: m.conversation._count.members,
      fits: m.conversation.cityKey === cKey && profs.some((p) => professionKeyOf(p) === m.conversation.professionKey),
    })),
    joinable,
    leaveSuggestions: await staleMemberships(userId),
  };
}

/** Qoşul — yalnız öz şəhəri + öz ixtisası. */
export async function joinProGroup(userId: number, profession: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { city: true, profession: true, professions: true } });
  if (!u?.city) throw new Error('Əvvəlcə profildə şəhərinizi qeyd edin');
  const p = professionsOf(u).find((x) => professionKeyOf(x) === professionKeyOf(profession));
  if (!p) throw new Error('Yalnız öz ixtisasınız üzrə qrupa qoşula bilərsiniz');
  const g = await ensureGroup(u.city, p, userId);
  await addMember(g.id, userId);
  return g;
}

/** Çıx — opt-out yazılır ki, sistem geri əlavə etməsin. */
export async function leaveProGroup(userId: number, conversationId: number) {
  const g = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { kind: true } });
  if (!g || g.kind !== 'PRO_CITY') throw new Error('Peşə qrupu tapılmadı');
  const others = (await prisma.conversationMember.findMany({ where: { conversationId }, select: { userId: true } })).map((m) => m.userId);
  await prisma.conversationMember.deleteMany({ where: { conversationId, userId } });
  await prisma.proGroupOptOut.upsert({ where: { conversationId_userId: { conversationId, userId } }, create: { conversationId, userId }, update: {} });
  others.forEach((id) => emitToUser(id, 'chat:groupChanged', { conversationId }));
}

/** «Qal» — uyğun olmasa da qrupda qalmaq istəyir (təklif bir daha çıxmasın). */
export async function keepProGroup(userId: number, conversationId: number) {
  await prisma.conversationMember.updateMany({ where: { conversationId, userId }, data: { keepStale: true } });
}
