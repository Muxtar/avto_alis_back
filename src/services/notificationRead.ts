// BİLDİRİŞLƏRİN AVTOMATİK OXUNMASI.
//
// Problem: istifadəçi bildirişin aid olduğu şeyə baxanda (mesajı oxuyanda,
// sifarişi açanda, iadəyə cavab verəndə) zəngdəki «1» itmirdi — yalnız səhifəni
// yeniləyəndə və ya zəngi açanda gedirdi. İndi:
//   • istifadəçi hansı səhifəni açırsa, linki həmin səhifəyə aparan oxunmamış
//     bildirişlər oxunmuş sayılır (markReadByPath);
//   • söhbət açılanda həmin şəxsin mesaj bildirişləri oxunur (markReadForChat);
//   • dəyişiklik ANLIQ bütün açıq tablara çatır (live «notification» hadisəsi).
import { PrismaClient } from '@prisma/client';
import { pushLive } from './live';

const prisma = new PrismaClient();

// Linkin bu parametrləri konkret obyekti göstərir — uyğunluq üçün bərabər olmalıdır.
// Qalanları (məs. renew=1, filter=negative) yalnız səhifənin görünüşünü dəyişir.
const IDENTITY_PARAMS = ['id', 'chat', 'objectId'];

function parse(u: string): { path: string; q: URLSearchParams } | null {
  try {
    const url = new URL(u, 'http://x');
    return { path: url.pathname.replace(/\/+$/, '') || '/', q: url.searchParams };
  } catch { return null; }
}

/** Bildiriş linki cari səhifəyə aiddirmi? */
export function linkMatchesPage(link: string, page: string): boolean {
  const a = parse(link); const b = parse(page);
  if (!a || !b || a.path !== b.path) return false;
  for (const k of IDENTITY_PARAMS) {
    const v = a.q.get(k);
    // «tab» linkdə yoxdursa hər tab uyğundur; varsa eyni olmalıdır.
    if (v !== null && b.q.get(k) !== v) return false;
  }
  return true;
}

export async function markReadByPath(userId: number, page: string): Promise<number> {
  const unread = await prisma.notification.findMany({ where: { userId, read: false, link: { not: null } }, select: { id: true, link: true }, take: 200 });
  const ids = unread.filter((n) => linkMatchesPage(n.link!, page)).map((n) => n.id);
  if (!ids.length) return 0;
  await prisma.notification.updateMany({ where: { id: { in: ids } }, data: { read: true } });
  pushLive(userId, { kind: 'notification' });
  return ids.length;
}

/** Söhbət oxunanda həmin şəxsdən gələn mesaj bildirişləri. */
export async function markReadForChat(userId: number, partnerId: number): Promise<void> {
  const r = await prisma.notification.updateMany({
    where: { userId, read: false, type: 'MESSAGE', link: { contains: `chat=${partnerId}` } },
    data: { read: true },
  });
  if (r.count) pushLive(userId, { kind: 'notification' });
}
