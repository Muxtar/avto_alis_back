// ELAN SAYTDA GÖRÜNÜRMÜ — bir yerdə, hamı eyni qaydanı işlətsin.
//
// Elan ictimai siyahıya (ana səhifə, axtarış, kateqoriya) düşmək üçün eyni anda:
//   təsdiqlənib · arxivlənməyib · müddəti bitməyib · biznesi aktivdir · obyekti aktivdir.
// Əvvəl satıcının public profili (/sellers/:id) biznes/obyekt yoxlamasını etmirdi:
// deaktiv obyektin elanı profildə görünür, ana səhifədə görünmürdü; VIP isə belə
// (görünməyən) elana da satılırdı.
import { Prisma } from '@prisma/client';

/** /listings və digər ictimai siyahılar üçün filtr. */
export function publicListingWhere(now = new Date()): Prisma.ListingWhereInput {
  return {
    status: 'APPROVED',
    archivedAt: null,
    AND: [
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      { OR: [{ businessId: null }, { business: { isActive: true } }] },
      { OR: [{ businessObjectId: null }, { businessObject: { isActive: true } }] },
    ],
  };
}

export interface VisibilityInput {
  status: string; type?: string; archivedAt?: Date | null; expiresAt?: Date | null;
  business?: { isActive: boolean; name?: string } | null;
  businessObject?: { isActive: boolean; name?: string } | null;
}

/** Niyə görünmür — konkret səbəblər (boşdursa görünür) + qeyd (məs. «Xidmətlər» sekmesi). */
export function visibilityOf(l: VisibilityInput, now = new Date()) {
  const reasons: string[] = [];
  if (l.status !== 'APPROVED') reasons.push(l.status === 'PENDING' ? 'Təsdiqlənməyib (admin yoxlamasındadır)' : l.status === 'REJECTED' ? 'Rədd edilib' : 'Arxivdədir');
  if (l.archivedAt) reasons.push('Arxivlənib (obyekt/biznes silinib)');
  if (l.expiresAt && l.expiresAt <= now) reasons.push(`Müddəti bitib (${l.expiresAt.toLocaleDateString('az-AZ')}) — elanı yeniləyin`);
  if (l.business && l.business.isActive === false) reasons.push(`Biznes deaktivdir${l.business.name ? `: ${l.business.name}` : ''} — biznesi aktiv edin`);
  if (l.businessObject && l.businessObject.isActive === false) reasons.push(`Obyekt (mağaza) deaktivdir${l.businessObject.name ? `: ${l.businessObject.name}` : ''} — Biznes bölməsindən obyekti aktiv edin`);
  const note = reasons.length === 0 && l.type === 'SERVICE'
    ? 'Ana səhifədə «Xidmətlər» sekmesindədir — «Məhsullar»da görünmür'
    : null;
  return { visible: reasons.length === 0, reasons, note };
}
