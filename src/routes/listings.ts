import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { upload } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';
import { adminAuth, AuthRequest, verifyTokenUserId } from '../middleware/auth';
import { purchasedListing, reviewStats } from '../services/reviewGating';

const router = Router();
const prisma = new PrismaClient();

// Get listings with filters
router.get('/listings', async (req: Request, res: Response) => {
  try {
    const { search, category, type, condition, country, brand, model, city, fuelType, paymentType, sort, page = '1', limit = '12' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: Prisma.ListingWhereInput = {
      // Yalnız admin tərəfindən təsdiqlənmiş elanlar saytda görünür.
      status: 'APPROVED',
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        // Deaktiv biznes/obyektin elanları marketplace-də görünməsin.
        { OR: [{ businessId: null }, { business: { isActive: true } }] },
        { OR: [{ businessObjectId: null }, { businessObject: { isActive: true } }] },
      ],
    };
    if (search) {
      const s = search as string;
      // Ümumi axtarış: məhsul/xidmət (başlıq, təsvir, marka, model),
      // satıcının adı-soyadı, şirkət adı və biznes obyekti adı.
      (where.AND as Prisma.ListingWhereInput[]).push({
        OR: [
          { title: { contains: s, mode: 'insensitive' } },
          { description: { contains: s, mode: 'insensitive' } },
          { brand: { contains: s, mode: 'insensitive' } },
          { model: { contains: s, mode: 'insensitive' } },
          { user: { name: { contains: s, mode: 'insensitive' } } },
          { business: { name: { contains: s, mode: 'insensitive' } } },
          { businessObject: { name: { contains: s, mode: 'insensitive' } } },
        ],
      });
    }
    // Əsas kateqoriya seçiləndə alt-kateqoriyaları da tut (prefix uyğunluğu).
    if (category) (where.AND as Prisma.ListingWhereInput[]).push({ category: { startsWith: category as string } });
    if (type && type !== 'all') where.type = type as any;
    if (condition) where.condition = condition as any;
    if (country) where.country = country as string;
    if (brand) where.brand = { contains: brand as string, mode: 'insensitive' };
    if (model) where.model = { contains: model as string, mode: 'insensitive' };
    // Satıcı/obyekt üzrə filtr — məhsul detalı səhifəsində "satıcının/obyektin
    // digər elanları" bölməsi üçün.
    if (req.query.sellerId) { const sid = parseInt(String(req.query.sellerId)); if (sid) where.userId = sid; }
    if (req.query.objectId) { const oid = parseInt(String(req.query.objectId)); if (oid) where.businessObjectId = oid; }
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

    // id ilə tie-break — eyni createdAt/price/year olan elanlarda ən son
    // əlavə olunan (ən böyük id) həmişə birinci; stabil pagination.
    const sortMap: Record<string, Prisma.ListingOrderByWithRelationInput[]> = {
      price_asc: [{ price: 'asc' }, { id: 'desc' }],
      price_desc: [{ price: 'desc' }, { id: 'desc' }],
      date_asc: [{ createdAt: 'asc' }, { id: 'asc' }],
      date_desc: [{ createdAt: 'desc' }, { id: 'desc' }],
      popular: [{ viewCount: 'desc' }, { id: 'desc' }],
      year_asc: [{ year: 'asc' }, { id: 'desc' }],
      year_desc: [{ year: 'desc' }, { id: 'desc' }],
    };
    const orderBy = sortMap[sort as string] || [{ createdAt: 'desc' }, { id: 'desc' }];

    const [listings, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, type: true, avgRating: true, ratingCount: true } },
          // VÖEN elanlarda kartda şəxsin yox, obyektin adı/№-si göstərilir.
          businessObject: { select: { id: true, name: true } },
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
// Kateqoriyaya uyğun filtr məlumatları (marka/şəhər/qiymət aralığı) — sol filtr paneli üçün.
router.get('/listings/filters', async (req: Request, res: Response) => {
  try {
    const { category, type } = req.query;
    const base: any = { status: 'APPROVED', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] };
    if (category) base.category = { startsWith: String(category) };
    if (type && type !== 'all') base.type = type as any;
    const [brands, cities, agg] = await Promise.all([
      prisma.listing.findMany({ where: { ...base, brand: { not: null } }, select: { brand: true }, distinct: ['brand'], orderBy: { brand: 'asc' }, take: 300 }),
      prisma.listing.findMany({ where: { ...base, city: { not: null } }, select: { city: true }, distinct: ['city'], orderBy: { city: 'asc' } }),
      prisma.listing.aggregate({ where: base, _min: { price: true }, _max: { price: true } }),
    ]);
    res.json({
      success: true,
      brands: brands.map((b) => b.brand).filter(Boolean),
      cities: cities.map((c) => c.city).filter(Boolean),
      price: { min: agg._min.price ?? null, max: agg._max.price ?? null },
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

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
      select: {
        id: true, name: true, type: true, createdAt: true, workplaces: true,
        serviceBrands: true, serviceAllBrands: true, serviceCategories: true,
        sellerVerified: true, idVerifyStatus: true, avatar: true, profession: true, bio: true,
        birthDate: true, gender: true, // kimlik məlumatları — FIN və vəsiqə şəkli ictimai DEYİL
        cvFile: true, cvPublic: true,
        consultationOffers: { where: { active: true }, select: { id: true, title: true, description: true, durationMinutes: true, price: true }, orderBy: { createdAt: 'asc' } },
        // Yalnız təsdiqlənmiş sosial hesablar public profildə görünür.
        socialLinks: { where: { verified: true }, select: { platform: true, url: true } },
        // Yalnız istifadəçinin public etdiyi peşə sənədləri (YES ikonu ilə).
        professionDocuments: { where: { isPublic: true }, select: { id: true, title: true, image: true, documentType: true } },
        // Rəsmi işçilik — yalnız təsdiqlənmiş (ACTIVE) üzvlüklər public görünür.
        businessMemberships: {
          where: { status: 'ACTIVE' },
          select: { id: true, business: { select: { id: true, name: true } }, object: { select: { id: true, name: true } } },
        },
      },
    });
    if (!user) {
      res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' });
      return;
    }
    // CV yalnız public edilibsə görünsün.
    if (!user.cvPublic) (user as any).cvFile = null;
    // Rəy (konsultasiya) təklif edən şəxsin telefonu profildə ictimai DEYİL —
    // əlaqə yalnız platforma üzərindən (platformadan kənar əlaqənin qarşısı).
    if (user.consultationOffers?.length) (user as any).phone = null;

    // M1 fix: paginate seller's listings to avoid serving thousands at once.
    const page = parseInt((req.query.page as string) || '1');
    const limit = Math.min(parseInt((req.query.limit as string) || '24'), 100);
    const skip = (page - 1) * limit;
    const sellerListingsWhere = {
      userId: user.id,
      status: 'APPROVED' as const, // gözləmədə/rədd edilmiş elanlar profildə görünmür
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };
    const [listings, listingsTotal] = await Promise.all([
      prisma.listing.findMany({
        where: sellerListingsWhere,
        include: { user: { select: { id: true, name: true, type: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.listing.count({ where: sellerListingsWhere }),
    ]);

    // Stats based on full count (not just current page).
    const [productsCount, servicesCount] = await Promise.all([
      prisma.listing.count({ where: { ...sellerListingsWhere, type: 'PRODUCT' } }),
      prisma.listing.count({ where: { ...sellerListingsWhere, type: 'SERVICE' } }),
    ]);
    const stats = {
      totalListings: listingsTotal,
      totalProducts: productsCount,
      totalServices: servicesCount,
    };

    res.json({ user, listings, stats, page, totalPages: Math.ceil(listingsTotal / limit) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Verilmiş id-lər arasından hələ də mövcud (APPROVED + vaxtı bitməmiş) elanların
// id-lərini qaytarır. "Əvvəl baxdıqlarınız" silinmiş/gizli elanları göstərməsin
// deyə istifadə olunur. (/:id-dən ƏVVƏL olmalıdır — yoxsa "exist" id kimi tutulur.)
router.get('/listings/exist', async (req: Request, res: Response) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) { res.json({ ids: [] }); return; }
    const rows = await prisma.listing.findMany({
      where: { id: { in: ids.slice(0, 50) }, status: 'APPROVED', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { id: true },
    });
    res.json({ ids: rows.map((r) => r.id) });
  } catch {
    res.json({ ids: [] });
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
        // YALNIZ açıq sahələr — idCardImage/selfie/FIN/parol və s. SIZDIRILMIR.
        user: {
          select: {
            id: true, name: true, type: true, avatar: true,
            profession: true, bio: true, gender: true, birthDate: true,
            idVerifyStatus: true, sellerVerified: true,
            city: true, address: true, latitude: true, longitude: true,
            avgRating: true, ratingCount: true, createdAt: true,
            workplaces: true,
          },
        },
        // VÖEN (obyektə bağlı) elanlarda obyekt məlumatı göstərilir (şəxsin yox).
        businessObject: {
          select: {
            id: true, name: true, address: true, city: true,
            latitude: true, longitude: true,
            business: { select: { id: true, name: true } },
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
    if (listing.expiresAt && listing.expiresAt <= new Date()) {
      res.status(404).json({ success: false, message: 'Elan tapılmadı' });
      return;
    }
    // Moderasiyadan keçməmiş elanı yalnız sahibi və admin görə bilər.
    if (listing.status !== 'APPROVED') {
      const viewerId = verifyTokenUserId(req.headers.authorization?.replace('Bearer ', ''));
      let allowed = viewerId != null && viewerId === listing.userId;
      if (!allowed && viewerId != null) {
        const viewer = await prisma.user.findUnique({ where: { id: viewerId }, select: { role: true } });
        allowed = viewer?.role === 'ADMIN';
      }
      if (!allowed) {
        res.status(404).json({ success: false, message: 'Elan tapılmadı' });
        return;
      }
    }

    // canReview — bu istifadəçi rəy yaza bilərmi?
    //  • VÖEN-li elan: yalnız məhsulu satın alan rəy yaza bilər.
    //  • Fərdi (VÖEN-siz) elan: alışı izləyə bilmədiyimiz üçün hər kəs (giriş
    //    etmiş, öz elanı olmayan) rəy yaza bilər — almadan da.
    // Hər iki halda bir istifadəçi bir elana yalnız bir dəfə (dəyişilə bilər).
    // VÖEN-siz-də canReview=true olduğundan frontend rəy formunu göstərir.
    let canReview = false;
    const reviewerId = verifyTokenUserId(req.headers.authorization?.replace('Bearer ', ''));
    if (reviewerId != null && reviewerId !== listing.userId) {
      const isVoen = !!(listing.businessId || listing.businessObjectId);
      canReview = isVoen ? await purchasedListing(reviewerId, listing.id) : true;
    }

    // VÖEN elanda obyektin reytinqini (5 ulduz + bəyən/bəyənmə) də göndər —
    // istifadəçi obyekti açmadan məhsul səhifəsində obyektin etibarını görsün.
    let objectRating = null;
    if (listing.businessObjectId) {
      const rows = await prisma.comment.findMany({ where: { objectId: listing.businessObjectId }, select: { rating: true } });
      objectRating = reviewStats(rows.map((r) => r.rating));
    }
    const businessObject = listing.businessObject ? { ...listing.businessObject, rating: objectRating } : listing.businessObject;

    // Telefon nömrəsi ictimai göstərilmir — əlaqə yalnız sayt daxili chat ilə.
    res.json({ ...listing, phone: null, businessObject, canReview });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Add comment to listing (auth required)
router.post('/listings/:id/comments', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const listingId = parseInt(req.params.id);
    if (Number.isNaN(listingId)) {
      res.status(400).json({ success: false, message: 'Yanlış ID' });
      return;
    }
    const { content, rating } = req.body;
    const trimmed = typeof content === 'string' ? content.trim() : '';
    if (!trimmed) {
      res.status(400).json({ success: false, message: 'Şərh mətni tələb olunur' });
      return;
    }
    if (trimmed.length > 1000) {
      res.status(400).json({ success: false, message: 'Şərh çox uzundur (maks 1000 simvol)' });
      return;
    }
    // Validate rating: must be 1..5 if provided.
    let parsedRating: number | null = null;
    if (rating !== undefined && rating !== null && rating !== '') {
      const n = typeof rating === 'number' ? rating : parseInt(rating);
      if (Number.isNaN(n) || n < 1 || n > 5) {
        res.status(400).json({ success: false, message: 'Reytinq 1-5 aralığında olmalıdır' });
        return;
      }
      parsedRating = n;
    }
    // Verify the listing actually exists (avoid raw FK error).
    const exists = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, businessId: true, businessObjectId: true, userId: true } });
    if (!exists) {
      res.status(404).json({ success: false, message: 'Elan tapılmadı' });
      return;
    }
    if (exists.userId === req.adminId) {
      res.status(403).json({ success: false, message: 'Öz elanınıza rəy yaza bilməzsiniz' });
      return;
    }
    // Kim rəy yaza bilər: VÖEN-li elana yalnız məhsulu satın alan; fərdi
    // (VÖEN-siz) elanda alışı izləyə bilmədiyimiz üçün hər kəs almadan da.
    const isVoen = !!(exists.businessId || exists.businessObjectId);
    if (isVoen && !(await purchasedListing(req.adminId!, listingId))) {
      res.status(403).json({ success: false, message: 'Yalnız məhsulu satın aldıqdan sonra rəy yaza bilərsiniz' });
      return;
    }
    // Bir dəfə — artıq rəy varsa dəyişməlidir (silib/redaktə).
    const already = await prisma.comment.findFirst({ where: { userId: req.adminId!, listingId } });
    if (already) {
      res.status(400).json({ success: false, message: 'Bu məhsula artıq rəy yazmısınız — mövcud rəyinizi dəyişə bilərsiniz' });
      return;
    }
    const comment = await prisma.comment.create({
      data: {
        userId: req.adminId!,
        listingId,
        content: trimmed,
        rating: parsedRating,
      },
      include: { user: { select: { id: true, name: true, type: true } } },
    });
    res.status(201).json({ success: true, comment });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Şərhi redaktə et — yalnız sahibi.
router.put('/comments/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const comment = await prisma.comment.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!comment) { res.status(404).json({ success: false, message: 'Şərh tapılmadı' }); return; }
    if (comment.userId !== req.adminId) { res.status(403).json({ success: false, message: 'Yalnız öz şərhinizi dəyişə bilərsiniz' }); return; }
    const trimmed = typeof req.body.content === 'string' ? req.body.content.trim() : '';
    if (!trimmed) { res.status(400).json({ success: false, message: 'Şərh mətni tələb olunur' }); return; }
    if (trimmed.length > 1000) { res.status(400).json({ success: false, message: 'Şərh çox uzundur (maks 1000 simvol)' }); return; }
    // Reytinqi də dəyişmək mümkündür (verilibsə).
    let ratingData: any = {};
    if (req.body.rating !== undefined && req.body.rating !== null && req.body.rating !== '') {
      const n = typeof req.body.rating === 'number' ? req.body.rating : parseInt(req.body.rating);
      if (Number.isNaN(n) || n < 1 || n > 5) { res.status(400).json({ success: false, message: 'Reytinq 1-5 aralığında olmalıdır' }); return; }
      ratingData = { rating: n };
    }
    const updated = await prisma.comment.update({
      where: { id: comment.id },
      data: { content: trimmed, ...ratingData },
      include: { user: { select: { id: true, name: true, type: true } } },
    });
    res.json({ success: true, comment: updated });
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
router.post('/listings', adminAuth, upload.array('images', 5), processImages, async (req: AuthRequest, res: Response) => {
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

    const expiresAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
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
        expiresAt,
        status: 'PENDING', // admin təsdiqindən sonra saytda görünəcək
      },
      include: { user: { select: { id: true, name: true, avatar: true, verified: true, type: true } } },
    });

    res.status(201).json({ success: true, listing });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
