// Rəy yazma icazəsi yoxlamaları — kim nəyə rəy yaza bilər.
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Bu istifadəçi bu məhsulu (listing) satın alıb və çatdırılıb?
export async function purchasedListing(userId: number, listingId: number): Promise<boolean> {
  const item = await prisma.orderItem.findFirst({
    where: { listingId, order: { buyerId: userId, status: 'DELIVERED' } },
    select: { id: true },
  });
  return !!item;
}

// Bu istifadəçi bu obyektdən nəyisə satın alıb və çatdırılıb?
export async function purchasedFromObject(userId: number, objectId: number): Promise<boolean> {
  const item = await prisma.orderItem.findFirst({
    where: { listing: { businessObjectId: objectId }, order: { buyerId: userId, status: 'DELIVERED' } },
    select: { id: true },
  });
  return !!item;
}

// Bu istifadəçi qarşı tərəflə 1:1 yazışıb (fərdi elanlar üçün "əlaqə saxlayıb" sübutu)?
export async function messagedUser(userId: number, otherId: number): Promise<boolean> {
  const m = await prisma.message.findFirst({
    where: {
      conversationId: null,
      OR: [
        { senderId: userId, receiverId: otherId },
        { senderId: otherId, receiverId: userId },
      ],
    },
    select: { id: true },
  });
  return !!m;
}

// Bu istifadəçi bu peşəkardan rəy/konsultasiya alıb (ödənilib və ya keçib)?
export async function consultedProfessional(userId: number, proId: number): Promise<boolean> {
  const s = await prisma.consultationSession.findFirst({
    where: { buyerId: userId, professionalId: proId, status: { in: ['PAID', 'ACTIVE', 'PAUSED', 'ENDED'] } },
    select: { id: true },
  });
  return !!s;
}

// Rəylərdən məmnunluq faizi (5 ulduz əsaslı) + orta + say.
export function reviewStats(ratings: (number | null)[]): { percent: number | null; avg: number | null; count: number } {
  const vals = ratings.filter((r): r is number => typeof r === 'number' && r >= 1 && r <= 5);
  if (vals.length === 0) return { percent: null, avg: null, count: 0 };
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { percent: Math.round((avg / 5) * 100), avg: Math.round(avg * 10) / 10, count: vals.length };
}
