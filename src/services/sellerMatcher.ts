import { PrismaClient, Prisma } from '@prisma/client';
import { AIAnalysis } from './deepseek';

const prisma = new PrismaClient();

export async function findRelevantSellers(
  analysis: AIAnalysis,
  buyerId: number,
  cities?: string[]
): Promise<number[]> {
  // AI analizinden arama kosullari olustur
  const orConditions: Prisma.ListingWhereInput[] = [];

  // Keyword'lerle ara
  for (const keyword of analysis.keywords) {
    orConditions.push({ title: { contains: keyword, mode: 'insensitive' } });
    orConditions.push({ description: { contains: keyword, mode: 'insensitive' } });
  }

  // Brand ile ara
  if (analysis.brand) {
    orConditions.push({ brand: { contains: analysis.brand, mode: 'insensitive' } });
  }

  // Arac markasi ile ara
  if (analysis.vehicleBrand) {
    orConditions.push({ title: { contains: analysis.vehicleBrand, mode: 'insensitive' } });
    orConditions.push({ brand: { contains: analysis.vehicleBrand, mode: 'insensitive' } });
    orConditions.push({ forVehicle: { contains: analysis.vehicleBrand, mode: 'insensitive' } });
  }

  // Arac modeli ile ara
  if (analysis.vehicleModel) {
    orConditions.push({ title: { contains: analysis.vehicleModel, mode: 'insensitive' } });
    orConditions.push({ forVehicle: { contains: analysis.vehicleModel, mode: 'insensitive' } });
  }

  // Product type ile ara
  if (analysis.productType) {
    orConditions.push({ title: { contains: analysis.productType, mode: 'insensitive' } });
    orConditions.push({ category: { contains: analysis.productType, mode: 'insensitive' } });
  }

  // Category ile ara
  if (analysis.category) {
    orConditions.push({ category: { contains: analysis.category, mode: 'insensitive' } });
  }

  if (orConditions.length === 0) {
    return [];
  }

  // City filter — sellers whose listings OR workplaces are in selected cities.
  const userFilter: Prisma.UserWhereInput = {
    type: { in: ['PARTS_SELLER', 'MECHANIC'] },
    id: { not: buyerId },
  };
  if (cities && cities.length > 0) {
    userFilter.OR = [
      { workplaces: { some: { address: { in: cities, mode: 'insensitive' } } } },
      { listings: { some: { city: { in: cities, mode: 'insensitive' } } } },
    ];
  }

  // Eslesen listingleri bul
  const listings = await prisma.listing.findMany({
    where: {
      OR: orConditions,
      ...(cities && cities.length > 0 ? { city: { in: cities, mode: 'insensitive' } } : {}),
      user: userFilter,
    },
    select: { userId: true },
    take: 100,
  });

  // Unique satici ID'leri - en fazla 20
  const sellerIds = [...new Set(listings.map(l => l.userId))].slice(0, 20);

  // Eslesen listing yoksa, tum sellerVerified PARTS_SELLER ve MECHANIC'leri al (max 10)
  // C11 fix: filter by sellerVerified (KYC-onaylı), not just verified (phone-OTP).
  if (sellerIds.length === 0) {
    const allSellers = await prisma.user.findMany({
      where: {
        ...userFilter,
        sellerVerified: true,
      },
      select: { id: true },
      take: 10,
    });
    return allSellers.map(s => s.id);
  }

  return sellerIds;
}
