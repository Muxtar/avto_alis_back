import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { upload } from '../middleware/upload';
import { adminAuth, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

// Get listings with filters
router.get('/listings', async (req: Request, res: Response) => {
  try {
    const { search, category, type, condition, country, brand, model, city, fuelType, paymentType, sort, page = '1', limit = '12' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: Prisma.ListingWhereInput = {};
    if (search) {
      where.OR = [
        { title: { contains: search as string, mode: 'insensitive' } },
        { description: { contains: search as string, mode: 'insensitive' } },
        { brand: { contains: search as string, mode: 'insensitive' } },
        { model: { contains: search as string, mode: 'insensitive' } },
      ];
    }
    if (category) where.category = category as string;
    if (type && type !== 'all') where.type = type as any;
    if (condition) where.condition = condition as any;
    if (country) where.country = country as string;
    if (brand) where.brand = { contains: brand as string, mode: 'insensitive' };
    if (model) where.model = { contains: model as string, mode: 'insensitive' };
    if (city) where.city = city as string;
    if (fuelType) where.fuelType = fuelType as any;
    if (paymentType) {
      // BOTH istənərsə, həm CASH, həm CREDIT, həm BOTH dönsün
      const pt = paymentType as string;
      if (pt === 'BOTH') {
        where.paymentType = 'BOTH';
      } else {
        where.paymentType = { in: [pt as any, 'BOTH'] };
      }
    }

    // Fiyat araligi filtresi
    const minPrice = req.query.min_price ? parseFloat(req.query.min_price as string) : undefined;
    const maxPrice = req.query.max_price ? parseFloat(req.query.max_price as string) : undefined;
    if (minPrice !== undefined || maxPrice !== undefined) {
      where.price = {};
      if (minPrice !== undefined) where.price.gte = minPrice;
      if (maxPrice !== undefined) where.price.lte = maxPrice;
    }

    // Buraxilis ili (uretim yili) filtresi - tek yil veya araliq
    const year = req.query.year ? parseInt(req.query.year as string) : undefined;
    const minYear = req.query.min_year ? parseInt(req.query.min_year as string) : undefined;
    const maxYear = req.query.max_year ? parseInt(req.query.max_year as string) : undefined;
    if (year !== undefined && !Number.isNaN(year)) {
      where.year = year;
    } else if (minYear !== undefined || maxYear !== undefined) {
      where.year = {};
      if (minYear !== undefined && !Number.isNaN(minYear)) where.year.gte = minYear;
      if (maxYear !== undefined && !Number.isNaN(maxYear)) where.year.lte = maxYear;
    }

    const sortMap: Record<string, Prisma.ListingOrderByWithRelationInput> = {
      price_asc: { price: 'asc' },
      price_desc: { price: 'desc' },
      date_asc: { createdAt: 'asc' },
      date_desc: { createdAt: 'desc' },
      popular: { viewCount: 'desc' },
      year_asc: { year: 'asc' },
      year_desc: { year: 'desc' },
    };
    const orderBy = sortMap[sort as string] || { createdAt: 'desc' };

    const [listings, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, phone: true, type: true, avgRating: true, ratingCount: true } },
          _count: { select: { comments: true, favorites: true } },
        },
        orderBy,
        skip,
        take,
      }),
      prisma.listing.count({ where }),
    ]);

    res.json({ listings, total, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get platform stats
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [totalListings, totalProducts, totalServices, totalUsers, totalOrders, categories, brands, priceStats, years, yearStats, cities] = await Promise.all([
      prisma.listing.count(),
      prisma.listing.count({ where: { type: 'PRODUCT' } }),
      prisma.listing.count({ where: { type: 'SERVICE' } }),
      prisma.user.count(),
      prisma.order.count(),
      prisma.listing.findMany({ select: { category: true }, distinct: ['category'] }),
      prisma.listing.findMany({ select: { brand: true }, distinct: ['brand'], where: { brand: { not: null } } }),
      prisma.listing.aggregate({ _avg: { price: true }, _min: { price: true }, _max: { price: true } }),
      prisma.listing.findMany({ select: { year: true }, distinct: ['year'], where: { year: { not: null } }, orderBy: { year: 'desc' } }),
      prisma.listing.aggregate({ _min: { year: true }, _max: { year: true }, where: { year: { not: null } } }),
      prisma.listing.findMany({ select: { city: true }, distinct: ['city'], where: { city: { not: null } }, orderBy: { city: 'asc' } }),
    ]);

    res.json({
      totalListings,
      totalProducts,
      totalServices,
      totalUsers,
      totalOrders,
      totalCategories: categories.length,
      categories: categories.map(c => c.category),
      brands: brands.map(b => b.brand).filter(Boolean),
      cities: cities.map(c => c.city).filter((c): c is string => c !== null),
      years: years.map(y => y.year).filter((y): y is number => y !== null),
      yearStats: {
        min: yearStats._min.year || null,
        max: yearStats._max.year || null,
      },
      priceStats: {
        avg: Math.round((priceStats._avg.price || 0) * 100) / 100,
        min: priceStats._min.price || 0,
        max: priceStats._max.price || 0,
      },
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get categories (MUST be before /listings/:id)
router.get('/listings/categories', async (_req: Request, res: Response) => {
  try {
    const categories = await prisma.listing.findMany({
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    });
    res.json(categories.map((c) => c.category));
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get seller profile with their listings
router.get('/sellers/:id', async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: parseInt(req.params.id) },
      select: { id: true, name: true, phone: true, type: true, createdAt: true, workplaces: true },
    });
    if (!user) {
      res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' });
      return;
    }

    const listings = await prisma.listing.findMany({
      where: { userId: user.id },
      include: { user: { select: { id: true, name: true, phone: true, type: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const stats = {
      totalListings: listings.length,
      totalProducts: listings.filter((l) => l.type === 'PRODUCT').length,
      totalServices: listings.filter((l) => l.type === 'SERVICE').length,
    };

    res.json({ user, listings, stats });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get single listing (increment view count only if listing exists)
router.get('/listings/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);

    // Once listing'i bul, varsa view count arttir ve dondir - tek islemde
    const listing = await prisma.listing.update({
      where: { id },
      data: { viewCount: { increment: 1 } },
      include: {
        user: {
          include: {
            workplaces: true,
          },
        },
        comments: {
          include: { user: { select: { id: true, name: true, type: true } } },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { comments: true, favorites: true } },
      },
    }).catch(() => null);

    if (!listing) {
      res.status(404).json({ success: false, message: 'Elan tapılmadı' });
      return;
    }
    res.json(listing);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Add comment to listing (auth required)
router.post('/listings/:id/comments', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { content, rating } = req.body;
    if (!content?.trim()) {
      res.status(400).json({ success: false, message: 'Şərh mətni tələb olunur' });
      return;
    }
    const comment = await prisma.comment.create({
      data: {
        userId: req.adminId!,
        listingId: parseInt(req.params.id),
        content: content.trim(),
        rating: rating ? parseInt(rating) : null,
      },
      include: { user: { select: { id: true, name: true, type: true } } },
    });
    res.status(201).json({ success: true, comment });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Delete comment (auth required, only owner can delete)
router.delete('/comments/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const comment = await prisma.comment.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!comment) {
      res.status(404).json({ success: false, message: 'Şərh tapılmadı' });
      return;
    }
    if (comment.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'Yalnız öz şərhinizi silə bilərsiniz' });
      return;
    }
    await prisma.comment.delete({ where: { id: comment.id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Create listing — any logged-in user (auth required)
router.post('/listings', adminAuth, upload.array('images', 5), async (req: AuthRequest, res: Response) => {
  try {
    const { title, description, price, category, type, location, phone, year } = req.body;
    if (!title || !description || !price || !category || !type) {
      res.status(400).json({ success: false, message: 'Başlıq, təsvir, qiymət, kateqoriya və tip tələb olunur' });
      return;
    }
    if (type !== 'PRODUCT' && type !== 'SERVICE') {
      res.status(400).json({ success: false, message: 'Tip yalnız PRODUCT və ya SERVICE ola bilər' }); return;
    }

    const files = req.files as Express.Multer.File[];
    const images = files?.map((f) => f.filename) || [];

    const listing = await prisma.listing.create({
      data: {
        userId: req.adminId!,
        title,
        description,
        price: parseFloat(price),
        category,
        type,
        images,
        location: location || null,
        phone: phone || null,
        year: year ? parseInt(year) : null,
      },
      include: { user: true },
    });

    res.status(201).json({ success: true, listing });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
