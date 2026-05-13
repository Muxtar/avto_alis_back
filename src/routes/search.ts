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

export default router;
