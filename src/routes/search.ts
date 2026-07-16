import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { upload } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';
import { analyzeImage } from '../services/deepseek';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { imageSearchLimiter } from '../middleware/rateLimiter';
import fs from 'fs';

const router = Router();
const prisma = new PrismaClient();

// POST /api/search/image — accepts an uploaded image, runs AI vision
// to extract searchable keywords (brand, model, productType, etc.) and
// returns a structured response that the frontend uses to populate the
// global search bar / redirect to the marketplace with the right filters.
//
// Auth + rate limit required: AI vision calls cost real money (OpenAI
// per-image pricing), so we gate the endpoint to authenticated users
// and cap at 15 requests / hour per IP.
router.post('/search/image', imageSearchLimiter, adminAuth, upload.single('image'), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ success: false, message: 'Şəkil tələb olunur' });
      return;
    }
    // After processImages middleware, the file has been re-encoded to JPEG
    // at max 1280px. Read it back and base64-encode for the vision model.
    const buffer = await fs.promises.readFile(file.path);
    const base64 = buffer.toString('base64');
    const analysis = await analyzeImage(base64, 'image/jpeg');

    // Clean up the temporary upload — we don't need to keep search images.
    fs.promises.unlink(file.path).catch(() => undefined);

    res.json({
      success: true,
      analysis,
      // Convenience: a single search query string built from the analysis
      // that the frontend can drop into ?search= directly.
      searchQuery: [analysis.brand, analysis.vehicleBrand, analysis.vehicleModel, analysis.productType]
        .filter(Boolean)
        .join(' ')
        .trim() || analysis.summary,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// GET /api/search/cities-summary — returns aggregated counts of active
// listings + distinct sellers per city. Powers the /locations browse page.
// Public endpoint — no auth required so anyone can browse.
// GET /api/professionals?q=<peşə>&city=<şəhər> — peşəyə görə mütəxəssis axtarışı.
router.get('/professionals', async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    const city = String(req.query.city || '').trim();
    const where: any = { isBlocked: false };
    if (q) where.profession = { contains: q, mode: 'insensitive' };
    else where.AND = [{ profession: { not: null } }, { profession: { not: '' } }];
    if (city) where.city = { contains: city, mode: 'insensitive' };
    const professionals = await prisma.user.findMany({
      where,
      take: 60,
      orderBy: [{ idVerifyStatus: 'asc' }, { avgRating: 'desc' }, { id: 'desc' }],
      select: {
        id: true, name: true, profession: true, avatar: true, city: true, bio: true,
        publicId: true, idVerifyStatus: true, avgRating: true, ratingCount: true,
        _count: { select: { listings: true } },
        consultationOffers: { where: { active: true }, select: { price: true, durationMinutes: true }, orderBy: { price: 'asc' } },
      },
    });
    res.json({ success: true, professionals });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get('/search/cities-summary', async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    // Group active listings by city.
    const listingsPerCity = await prisma.listing.groupBy({
      by: ['city'],
      where: {
        city: { not: null },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      _count: { _all: true },
    });
    // Group sellers by their default city.
    const sellersPerCity = await prisma.user.groupBy({
      by: ['city'],
      where: { city: { not: null }, profileComplete: true },
      _count: { _all: true },
    });

    const map = new Map<string, { city: string; listings: number; sellers: number }>();
    for (const row of listingsPerCity) {
      if (!row.city) continue;
      map.set(row.city, { city: row.city, listings: row._count._all, sellers: 0 });
    }
    for (const row of sellersPerCity) {
      if (!row.city) continue;
      const existing = map.get(row.city);
      if (existing) existing.sellers = row._count._all;
      else map.set(row.city, { city: row.city, listings: 0, sellers: row._count._all });
    }
    const cities = Array.from(map.values()).sort((a, b) => (b.listings + b.sellers) - (a.listings + a.sellers));
    res.json({ success: true, cities });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// GET /api/search/by-city/:city — returns all sellers and active listings
// in a given city. Public.
router.get('/search/by-city/:city', async (req: Request, res: Response) => {
  try {
    const city = decodeURIComponent(String(req.params.city));
    if (!city) {
      res.status(400).json({ success: false, message: 'Şəhər tələb olunur' });
      return;
    }
    const now = new Date();
    const [sellers, listings] = await Promise.all([
      prisma.user.findMany({
        where: { city, profileComplete: true },
        select: {
          id: true, name: true, type: true, phone: true, avgRating: true, ratingCount: true,
          city: true, address: true, latitude: true, longitude: true,
          workplaces: { select: { name: true, address: true, latitude: true, longitude: true } },
          _count: { select: { listings: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.listing.findMany({
        where: {
          city,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        include: {
          user: { select: { id: true, name: true, type: true } },
          _count: { select: { comments: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 60,
      }),
    ]);
    res.json({ success: true, city, sellers, listings });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// GET /api/map/points — Azərbaycan üzrə xəritə nöqtələri: biznes obyektləri + istifadəçilər
// (koordinatı olanlar). İctimaidir — yalnız açıq məlumat qaytarılır (ad, konum, tip).
router.get('/map/points', async (_req: Request, res: Response) => {
  try {
    const [objects, users] = await Promise.all([
      prisma.businessObject.findMany({
        where: {
          isActive: true,
          latitude: { not: null },
          longitude: { not: null },
          business: { status: 'APPROVED', isActive: true },
        },
        select: {
          id: true, name: true, latitude: true, longitude: true, city: true,
          address: true, activityAreas: true, businessId: true,
          _count: { select: { listings: true } },
        },
        take: 2000,
      }),
      prisma.user.findMany({
        where: {
          profileComplete: true,
          isBlocked: false,
          latitude: { not: null },
          longitude: { not: null },
        },
        select: {
          id: true, name: true, type: true, latitude: true, longitude: true,
          city: true, avatar: true, profession: true,
          _count: { select: { listings: true } },
        },
        take: 3000,
      }),
    ]);
    res.json({
      success: true,
      objects: objects.map((o) => ({
        id: o.id, name: o.name, latitude: o.latitude, longitude: o.longitude,
        city: o.city, address: o.address, activityAreas: o.activityAreas,
        businessId: o.businessId, listingCount: o._count.listings,
      })),
      users: users.map((u) => ({
        id: u.id, name: u.name, type: u.type, latitude: u.latitude, longitude: u.longitude,
        city: u.city, avatar: u.avatar, profession: u.profession, listingCount: u._count.listings,
      })),
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// GET /api/objects/:id — biznes obyektinin açıq səhifəsi: obyekt məlumatı + aktiv elanları.
router.get('/objects/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    if (Number.isNaN(id)) { res.status(400).json({ success: false, message: 'Yanlış ID' }); return; }
    const now = new Date();
    const object = await prisma.businessObject.findUnique({
      where: { id },
      select: {
        id: true, name: true, phone: true, address: true, city: true,
        latitude: true, longitude: true, activityAreas: true, isActive: true,
        referralEnabled: true,
        referralRules: { select: { profession: true, commissionPercent: true, requiredDoc: true } },
        business: { select: { id: true, name: true, status: true, website: true, instagram: true, facebook: true, tiktok: true, youtube: true, linkedin: true } },
      },
    });
    if (!object || !object.isActive) { res.status(404).json({ success: false, message: 'Obyekt tapılmadı' }); return; }
    const listings = await prisma.listing.findMany({
      where: { businessObjectId: id, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      include: {
        user: { select: { id: true, name: true, type: true } },
        _count: { select: { comments: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ success: true, object, listings });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
