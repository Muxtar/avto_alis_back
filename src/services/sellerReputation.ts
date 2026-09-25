// ŞİKAYƏT = REPUTASİYA. Şikayət pul/mal qaytarmır (bunun üçün İadə var) —
// alıcının satıcı haqqında rəsmi fikridir və satıcının ETİBARLILIQ reytinqinə
// təsir edir.
//
// Kim şikayət edə bilər: həmin satıcıdan ALIŞ etmiş (sifarişi olan) alıcı,
// və ya konsultasiya/bron almış istifadəçi. Alışsız «elan haqqında» bildiriş
// admin moderasiyasına gedir, reytinqə TƏSİR ETMİR.
//
// Axın: alıcı şikayət yazır → satıcıya bildiriş, satıcı cavab yazır →
// alıcı «problem həll olundu» deyə bilər (geri götürür) → admin istəsə
// «əsaslıdır» / «əsassızdır» qərarı verir.
//
// Reytinqə təsir (son 365 gün):
//   admin «əsaslıdır» → 1 · baxılmamış/açıq → 0.5 · geri götürülüb və ya «əsassız» → 0
import { PrismaClient } from '@prisma/client';
import { pushLive, pushAdmins } from './live';

const prisma = new PrismaClient();
const YEAR = 365 * 24 * 3600 * 1000;

// Satıcının DAVRANIŞI haqqında şikayət növləri (qaytarma səbəbi deyil).
export const SELLER_COMPLAINT_CATEGORIES: Record<string, string> = {
  NOT_AS_DESCRIBED: 'Məhsul/xidmət təsvirə uyğun deyildi',
  POOR_QUALITY: 'Keyfiyyətsiz məhsul/xidmət',
  DEFECTIVE: 'Qüsurlu məhsul',
  DAMAGED: 'Zədəli gəldi',
  WRONG_ITEM: 'Səhv məhsul göndərdi',
  LATE: 'Gecikdirdi / vaxtında göndərmədi',
  NO_RESPONSE: 'Cavab vermir / əlaqə saxlamır',
  RUDE: 'Kobud davranış',
  RETURN_REJECTED: 'İadəni əsassız rədd etdi',
  RETURN_IGNORED: 'İadə sorğusuna cavab vermədi',
  PICKUP_NOT_RECEIVED: 'Mağazada məhsulu vermədi',
  FAKE_INFO: 'Yalan məlumat',
  FRAUD: 'Fırıldaq şübhəsi',
  TIME_WASTED: 'Vaxtımı boşa xərclədi',
  OTHER: 'Digər',
};

export async function createSellerComplaint(p: {
  complainantId: number; targetUserId: number; category: string; description: string;
  orderId?: number | null; listingId?: number | null; returnId?: number | null; images?: string[];
}) {
  const complaint = await prisma.complaint.create({
    data: {
      complainantId: p.complainantId, targetUserId: p.targetUserId,
      orderId: p.orderId ?? null, listingId: p.listingId ?? null, returnId: p.returnId ?? null,
      category: p.category, description: p.description.slice(0, 3000), images: p.images || [],
      // Satıcının cavabı gözlənilir (məcburi deyil, amma cavabsız şikayət reytinqdə qalır).
      status: p.orderId ? 'AWAITING_SELLER' : 'OPEN',
    },
  });
  if (p.orderId) {
    await prisma.notification.create({
      data: {
        userId: p.targetUserId, type: 'COMPLAINT', title: 'Sizin haqqınızda şikayət yazıldı',
        body: `${SELLER_COMPLAINT_CATEGORIES[p.category] || p.category} (sifariş #${p.orderId}). Alıcıya cavab yazın — şikayətlər etibarlılıq reytinqinizə təsir edir.`,
        link: '/complaints?tab=against',
      },
    }).catch(() => {});
    pushLive(p.targetUserId, { kind: 'complaint', id: complaint.id, toast: 'Sizin haqqınızda şikayət yazıldı — cavab verin', tone: 'error' });
  }
  pushAdmins('complaint', { id: complaint.id, toast: 'Yeni şikayət' });
  return complaint;
}

/** Şikayətin reytinqə çəkisi. */
export function complaintWeight(c: { status: string; resolution: string | null }): number {
  if (c.status === 'REJECTED' || c.resolution === 'UNFOUNDED' || c.resolution === 'WITHDRAWN') return 0;
  if (c.resolution === 'UPHELD' || c.resolution === 'WARNED' || c.resolution === 'REFUNDED' || c.resolution === 'SUSPENDED') return 1;
  return 0.5;
}

/** Satıcının etibarlılıq göstəriciləri (son 365 gün). */
export async function sellerReputation(sellerId: number) {
  const since = new Date(Date.now() - YEAR);
  const [completed, complaints, returns, user] = await Promise.all([
    prisma.order.count({ where: { sellerId, status: 'DELIVERED', createdAt: { gte: since } } }),
    prisma.complaint.findMany({
      where: { targetUserId: sellerId, createdAt: { gte: since }, OR: [{ orderId: { not: null } }, { consultationId: { not: null } }] },
      select: { status: true, resolution: true, category: true, sellerRespondedAt: true },
    }),
    prisma.returnRequest.findMany({ where: { sellerId, createdAt: { gte: since } }, select: { status: true, events: { where: { status: 'SELLER_NO_RESPONSE' }, select: { id: true } } } }),
    prisma.user.findUnique({ where: { id: sellerId }, select: { avgRating: true, ratingCount: true } }),
  ]);
  const weighted = complaints.reduce((s, c) => s + complaintWeight(c), 0);
  const counted = complaints.filter((c) => complaintWeight(c) > 0).length;
  const answered = complaints.filter((c) => c.sellerRespondedAt).length;
  const returnsRejected = returns.filter((r) => r.status === 'REJECTED').length;
  const returnsIgnored = returns.filter((r) => r.events.length > 0).length;
  const base = Math.max(completed, 1);
  // Etibarlılıq 0–100: şikayət nisbəti əsas cərimədir, cavabsız qalan iadələr əlavə.
  const score = Math.max(0, Math.round(100 - Math.min(70, (weighted / base) * 200) - Math.min(20, returnsIgnored * 5)));
  const enough = completed >= 3 || counted > 0;
  const level = !enough ? null : score >= 90 ? 'Etibarlı satıcı' : score >= 75 ? 'Yaxşı' : score >= 50 ? 'Diqqətli olun' : 'Riskli';
  return {
    score: enough ? score : null, level, completedOrders: completed,
    complaints: counted, complaintsAnswered: answered, returnsRejected, returnsIgnored,
    avgRating: user?.avgRating ?? null, ratingCount: user?.ratingCount ?? 0,
  };
}
