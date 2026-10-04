// İXTİSAS SAHİBİNİN HESABI — kim «Rəy konsultasiyası» edə bilir.
//
// Qayda: ixtisas sahibi ödəniş ala bilmək üçün ÖZ VÖEN hesabını yazmalıdır
// (profil → Rəy konsultasiyası). Konsultasiyadan və referal satışdan qazanılan
// pul həmin VÖEN hesabına ödənilir. REFERAL SATIŞ yalnız Rəy konsultasiyası edə
// bilən şəxslərə açıqdır: ixtisas + VÖEN hesabı + ən azı bir aktiv təklif.
//
// Köhnə yol saxlanılır: admin təsdiqli VÖEN-li biznesi olan şəxsin də VÖEN
// hesabı var sayılır (əvvəl yeganə yol bu idi).
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface VoenAccount { voen: string; name: string | null; iban: string | null; source: 'PROFILE' | 'BUSINESS' }

export const normVoen = (v: any) => String(v ?? '').replace(/\D/g, '');
export const normIban = (v: any) => String(v ?? '').replace(/\s+/g, '').toUpperCase();
export const isVoen = (v: string) => /^\d{10}$/.test(v);
export const isAzIban = (v: string) => /^AZ\d{2}[A-Z]{4}[A-Z0-9]{20}$/.test(v);

/** Şəxsin VÖEN hesabı: profildə yazdığı, yoxdursa təsdiqli biznesi. */
export async function voenAccount(userId: number | null | undefined): Promise<VoenAccount | null> {
  if (!userId) return null;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { proVoen: true, proVoenName: true, proIban: true } });
  if (u?.proVoen) return { voen: u.proVoen, name: u.proVoenName, iban: u.proIban, source: 'PROFILE' };
  const b = await prisma.business.findFirst({
    where: { userId, status: 'APPROVED', isActive: true, deletedAt: null },
    select: { voen: true, name: true, banks: { where: { isActive: true }, orderBy: { isPrimary: 'desc' }, take: 1, select: { iban: true } } },
  });
  if (b?.voen) return { voen: b.voen, name: b.name, iban: b.banks[0]?.iban || null, source: 'BUSINESS' };
  return null;
}

export async function hasVoenAccount(userId: number | null | undefined): Promise<boolean> {
  return !!(await voenAccount(userId));
}

export interface ConsultAbility { ok: boolean; hasProfession: boolean; hasVoen: boolean; hasOffer: boolean; reason: string }

/** Bu şəxs Rəy konsultasiyası edə bilirmi (və deməli referal sata bilərmi). */
export async function canConsult(userId: number): Promise<ConsultAbility> {
  const [u, offers, acct] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { profession: true, professions: true } }),
    prisma.consultationOffer.count({ where: { userId, active: true } }),
    voenAccount(userId),
  ]);
  const hasProfession = !!(u?.profession?.trim() || (u?.professions || []).some((p) => p?.trim()));
  const hasVoen = !!acct;
  const hasOffer = offers > 0;
  const reason = !hasProfession ? 'Referal satış yalnız ixtisas sahiblərinə açıqdır — profildə ixtisasınızı əlavə edin'
    : !hasVoen ? 'Referal satış üçün VÖEN hesabınızı yazın (profil → Rəy konsultasiyası) — komissiya həmin hesaba ödənilir'
      : !hasOffer ? 'Referal satış yalnız Rəy konsultasiyası edən ixtisas sahiblərinə açıqdır — profildə ən azı bir aktiv təklif əlavə edin'
        : '';
  return { ok: hasProfession && hasVoen && hasOffer, hasProfession, hasVoen, hasOffer, reason };
}
