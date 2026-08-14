import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { upload } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';
import { analyzeImage } from '../services/aiText';
import { imageToSearchQuery, visionSearchEnabled } from '../services/visionSearchAI';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { imageSearchLimiter, webSearchLimiter } from '../middleware/rateLimiter';
import { webSearch, webSearchEnabled, socialHandle, WebResult, type SearchMode } from '../services/webSearchAI';
import { enrichProfiles, isApifyConfigured } from '../services/apifyProfiles';
import { fetchPreviews, fallbackAvatar, probeProfiles, probeHandle, looksLikeHandle } from '../services/socialPreview';
import { resolveFlag } from '../services/settings';
import { reviewStats } from '../services/reviewGating';
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
    // Admin "şəkillə axtarış" AI flag-ı deaktivdirsə xüsusiyyət bağlıdır.
    if (!(await resolveFlag('ai_vision_search'))) {
      fs.promises.unlink(file.path).catch(() => undefined);
      res.status(503).json({ success: false, message: 'Şəkillə axtarış hazırda deaktivdir' });
      return;
    }
    // After processImages middleware, the file has been re-encoded to JPEG
    // at max 1280px. Read it back and base64-encode for the vision model.
    const buffer = await fs.promises.readFile(file.path);
    const base64 = buffer.toString('base64');

    // Claude vision (ANTHROPIC_API_KEY) varsa onu üstün tuturuq — sayt ümumi
    // elan saytıdır, ona görə ümumi məhsul tanıma lazımdır. Yoxdursa, köhnə
    // (avtomobil ehtiyat hissəsi üçün qurulmuş) vision axını işə düşür.
    if (visionSearchEnabled()) {
      const vision = await imageToSearchQuery(base64, 'image/jpeg');
      fs.promises.unlink(file.path).catch(() => undefined);
      if (!vision.ok) {
        res.status(422).json({ success: false, message: vision.error || 'Şəkil tanınmadı' });
        return;
      }
      res.json({
        success: true,
        searchQuery: vision.query,
        analysis: {
          productType: vision.productType,
          brand: vision.brand,
          category: vision.category,
          keywords: vision.keywords,
        },
      });
      return;
    }

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

// Şəxs axtarışının nəticələrini saytdakı doğrulanmış sosial linklərlə tutuşdurur.
// Uyğun gələn profilə istifadəçi məlumatı (ad, avatar, id) əlavə olunur və
// belə nəticələr siyahının BAŞINA çıxarılır — istifadəçi "bizimkini" dərhal görsün.
// Platforma adları normallaşdırılır (x ↔ twitter).
function normPlatform(p: string): string {
  const s = (p || '').toLowerCase();
  return s === 'x' ? 'twitter' : s;
}
async function attachSiteUsers(results: WebResult[]): Promise<WebResult[]> {
  try {
    const platforms = Array.from(new Set(results.map((r) => normPlatform(r.platform || '')).filter(Boolean)));
    if (!platforms.length) return results;
    const links = await prisma.socialLink.findMany({
      where: { verified: true, platform: { in: platforms } },
      select: { platform: true, url: true, user: { select: { id: true, name: true, avatar: true, isBlocked: true } } },
    });
    // "platforma:istifadəçi_adı" → istifadəçi xəritəsi.
    const byKey = new Map<string, { id: number; name: string; avatar: string | null }>();
    for (const l of links) {
      if (!l.user || l.user.isBlocked) continue;
      const h = socialHandle(l.url);
      if (!h) continue;
      byKey.set(`${normPlatform(l.platform)}:${h.toLowerCase()}`, { id: l.user.id, name: l.user.name, avatar: l.user.avatar });
    }
    if (!byKey.size) return results;
    const marked = results.map((r) => {
      if (!r.handle) return r;
      const u = byKey.get(`${normPlatform(r.platform || '')}:${r.handle.toLowerCase()}`);
      return u ? { ...r, siteUser: u } : r;
    });
    // Saytda qeydiyyatlı olanlar əvvəldə.
    return [...marked.filter((r) => r.siteUser), ...marked.filter((r) => !r.siteUser)];
  } catch (e: any) {
    console.error('[search/web] attachSiteUsers:', e?.message);
    return results;
  }
}

// POST /api/search/web — saytda nəticə tapılmayanda internetdən axtarır.
// Claude-un web_search server aləti işlədilir. Auth + saatlıq limit var,
// çünki hər sorğu real pula başa gəlir.
router.post('/search/web', webSearchLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    // Admin `internet_search` flag-ı deaktivdirsə internet axtarışı bağlıdır.
    if (!(await resolveFlag('internet_search'))) {
      res.status(503).json({ success: false, message: 'İnternet axtarışı deaktiv edilib' });
      return;
    }
    if (!webSearchEnabled()) {
      res.status(503).json({ success: false, message: 'İnternet axtarışı hazırda əlçatan deyil' });
      return;
    }
    const q = String(req.body?.query || '').trim();
    if (!q) { res.status(400).json({ success: false, message: 'Axtarış mətni tələb olunur' }); return; }

    // Rejimi istifadəçi axtarış sahəsindəki seçici ilə ÖZÜ təyin edir:
    //   'product' → yalnız məhsul (sayt + AZ alış-veriş saytları)
    //   'person'  → yalnız şəxs (sayt ixtisas sahibləri + sosial media)
    //   'auto'    → sistem sorğuya baxıb özü qərar verir (default)
    const rawMode = String(req.body?.mode || 'auto').toLowerCase();
    const mode: SearchMode = rawMode === 'product' || rawMode === 'person' ? rawMode : 'auto';

    const data = await webSearch(q, mode);
    // ŞƏXS rejimində motor xəta versə də dayanmırıq: birbaşa profil yoxlaması
    // (probe) motordan asılı deyil və çox vaxt nəticəni məhz o tapır.
    // Məhsul rejimində isə motorsuz edəcək bir şey yoxdur → 422.
    if (!data.ok && mode !== 'person') {
      res.status(422).json({ success: false, mode: data.mode, message: data.error || 'Nəticə tapılmadı' });
      return;
    }
    // Xəta olsa da şəxs axını davam etsin — nəticələr boş massivdən başlayır.
    const engineError = data.ok ? null : (data.error || null);
    if (!data.ok) { data.mode = 'person'; data.results = []; data.summary = ''; }
    // Şəxs axtarışında tapılan sosial profilləri saytımızdakı DOĞRULANMIŞ sosial
    // linklərlə tutuşdur — profil bizim istifadəçiyə aiddirsə işarələnir.
    // (Uyğunlaşdırma keşdən KƏNARDA gedir ki, istifadəçi məlumatı həmişə təzə olsun.)
    let results = data.mode === 'person' ? await attachSiteUsers(data.results) : data.results;

    // DİQQƏT: burada `results.length` YOXLANMIR.
    // Əvvəl `data.mode === 'person' && results.length` idi — motor sıfır nəticə
    // qaytaranda bütün blok atlanırdı və birbaşa profil yoxlaması (probe) HEÇ VAXT
    // işə düşmürdü. Halbuki probe məhz o hal üçündür: `x_agayev_79` kimi
    // indekslənməmiş profillər yalnız birbaşa yoxlama ilə tapılır.
    if (data.mode === 'person') {
      // 1) DƏRİN AXTARIŞ (ƏVVƏLCƏ) — nəticə azdırsa ehtimal olunan profil ünvanlarını
      //     birbaşa yoxla (motorun indeksləmədiyi profillər üçün). Nəticə YALNIZ
      //     səhifə başlığında axtarılan ad təsdiqlənəndə əlavə olunur.
      if (results.length < 6) {
        try {
          // Sorğu istifadəçi adına bənzəyirsə (boşluqsuz, `_`/`.`/rəqəmli) onu
          // BİRBAŞA handle kimi yoxla; əks halda ad-soyaddan ünvan qur.
          const probed = looksLikeHandle(q)
            ? await probeHandle(q)
            : await probeProfiles(q, 6 - results.length);
          const seen = new Set(results.map((r) => `${(r.platform || '').toLowerCase()}:${(r.handle || '').toLowerCase()}`));
          for (const pr of probed) {
            const key = `${pr.platform}:${pr.handle.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({
              title: pr.name || pr.handle, url: pr.url, snippet: pr.description || '',
              price: null, site: pr.platform, kind: 'social',
              platform: pr.platform, handle: pr.handle,
              displayName: pr.name, avatarUrl: pr.avatarUrl, description: pr.description,
            });
          }
        } catch (e: any) { console.error('[search/web] probe:', e?.message); }
      }


      // 2) PULSUZ önizləmə — profil səhifəsinin og:image / og:title etiketləri.
      //    Instagram, Facebook, TikTok, LinkedIn, Telegram üçün işləyir.
      try {
        const need = results.filter((r) => !r.siteUser);
        const previews = await fetchPreviews(need.map((r) => ({ url: r.url, platform: r.platform })));
        if (previews.size) {
          results = results.map((r) => {
            const p = previews.get(r.url);
            if (!p) return r;
            return {
              ...r,
              displayName: r.displayName || p.name,
              avatarUrl: r.avatarUrl || p.avatarUrl,
              description: r.description || p.description,
            };
          });
        }
      } catch (e: any) { console.error('[search/web] preview:', e?.message); }

      // 1b) Şəkil hələ də yoxdursa açıq avatar xidmətini sına.
      //     X (Twitter) krauler UA-ya 404 verir və og:image vermir — bu addım
      //     məhz onun üçündür (empirik olaraq yoxlanılıb).
      results = results.map((r) =>
        r.avatarUrl || r.siteUser ? r : { ...r, avatarUrl: fallbackAvatar(r.platform || '', r.handle) },
      );

      // 2) Apify qoşulubsa — əlavə məlumat (izləyici sayı, təsdiq nişanı) ilə zənginləşdir.
      if (isApifyConfigured()) {
        try {
          const enriched = await enrichProfiles(
            results.filter((r) => r.handle && !r.siteUser).map((r) => ({ platform: r.platform || '', handle: r.handle! })),
          );
          if (enriched.size) {
            results = results.map((r) => {
              const p = r.handle ? enriched.get(`${(r.platform || '').toLowerCase()}:${r.handle.toLowerCase()}`) : null;
              return p ? { ...r, displayName: p.fullName || r.displayName, avatarUrl: p.avatarUrl || r.avatarUrl, followers: p.followers ?? null, verifiedBadge: p.verified } : r;
            });
          }
        } catch (e: any) { console.error('[search/web] apify enrich:', e?.message); }
      }
    }
    // MƏHSUL nəticələri üçün kart şəkli — elan səhifəsinin og:image-i.
    // tap.az, umico.az, turbo.az və s. bunu krauler UA-ya verir (yoxlanılıb).
    // Alınmasa kart şəkilsiz göstərilir — axtarış pozulmur.
    if (data.mode === 'product' && results.length) {
      try {
        const previews = await fetchPreviews(results.map((r) => ({ url: r.url })), 6);
        if (previews.size) {
          results = results.map((r) => {
            const p = previews.get(r.url);
            if (!p) return r;
            return { ...r, image: p.avatarUrl, description: r.description || p.description };
          });
        }
      } catch (e: any) { console.error('[search/web] product preview:', e?.message); }
    }
    res.json({ success: true, mode: data.mode, summary: data.summary, results, engineError });
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
    // Yalnız ixtisası olan istifadəçilər; q peşə VƏ YA ad ilə uyğun gəlir
    // (ad yalnız ixtisas sahibi üçün — istifadəçi tələbi).
    // Ən azı bir ixtisası olanlar (əsas profession VƏ YA professions massivi).
    const hasProfession = { OR: [{ profession: { not: null } }, { professions: { isEmpty: false } }] };
    if (q) {
      where.AND = [
        hasProfession,
        // q peşə (əsas/massiv) VƏ YA ad üzrə uyğun gəlir. Massivdə `has` dəqiq uyğunluq
        // (sektor seçicisindən tam ad gəlir); əsas profession isə `contains` (sərbəst mətn).
        { OR: [{ profession: { contains: q, mode: 'insensitive' } }, { professions: { has: q } }, { name: { contains: q, mode: 'insensitive' } }] },
      ];
    } else {
      where.AND = [hasProfession];
    }
    if (city) where.city = { contains: city, mode: 'insensitive' };
    const professionals = await prisma.user.findMany({
      where,
      take: 60,
      orderBy: [{ idVerifyStatus: 'asc' }, { avgRating: 'desc' }, { id: 'desc' }],
      select: {
        id: true, name: true, profession: true, professions: true, avatar: true, city: true, bio: true,
        publicId: true, idVerifyStatus: true, avgRating: true, ratingCount: true,
        _count: { select: { listings: true } },
        consultationOffers: { where: { active: true }, select: { price: true, durationMinutes: true }, orderBy: { price: 'asc' } },
      },
    });
    // `professions` massivində Prisma yalnız DƏQİQ uyğunluq (`has`) dəstəkləyir.
    // Ona görə struktur sorğu boş qayıdanda hissəvi uyğunluğu kodda yoxlayırıq
    // (məs. "santex" → "Santexnik"). Yalnız q varsa və nəticə yoxdursa işə düşür.
    if (q && professionals.length === 0) {
      const ql = q.toLowerCase();
      const pool = await prisma.user.findMany({
        where: { isBlocked: false, AND: [hasProfession] },
        take: 300,
        orderBy: [{ idVerifyStatus: 'asc' }, { avgRating: 'desc' }, { id: 'desc' }],
        select: {
          id: true, name: true, profession: true, professions: true, avatar: true, city: true, bio: true,
          publicId: true, idVerifyStatus: true, avgRating: true, ratingCount: true,
          _count: { select: { listings: true } },
          consultationOffers: { where: { active: true }, select: { price: true, durationMinutes: true }, orderBy: { price: 'asc' } },
        },
      });
      const hit = pool.filter((u) => (u.professions || []).some((p) => p.toLowerCase().includes(ql)));
      return res.json({ success: true, professionals: hit.slice(0, 60) });
    }
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
          id: true, name: true, type: true, avatar: true, avgRating: true, ratingCount: true,
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
          status: 'APPROVED',
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        include: {
          user: { select: { id: true, name: true, type: true, avgRating: true, ratingCount: true } },
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
        id: true, name: true, address: true, city: true,
        latitude: true, longitude: true, activityAreas: true, isActive: true,
        referralEnabled: true,
        referralRules: { select: { profession: true, commissionPercent: true, requiredDoc: true } },
        business: { select: { id: true, name: true, status: true, website: true, instagram: true, facebook: true, tiktok: true, youtube: true, linkedin: true } },
      },
    });
    if (!object || !object.isActive) { res.status(404).json({ success: false, message: 'Obyekt tapılmadı' }); return; }
    const listings = await prisma.listing.findMany({
      where: { businessObjectId: id, status: 'APPROVED', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      include: {
        user: { select: { id: true, name: true, type: true, avgRating: true, ratingCount: true } },
        _count: { select: { comments: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    // Obyektin 5 ulduz + bəyən/bəyənmə reytinqi (obyekt rəylərindən) — başlıqda göstərilir.
    const ratingRows = await prisma.comment.findMany({ where: { objectId: id }, select: { rating: true } });
    const rating = reviewStats(ratingRows.map((r) => r.rating));
    res.json({ success: true, object: { ...object, rating }, listings });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Public biznes səhifəsi — QR/link ilə açılır. Yalnız təsdiqlənmiş, aktiv biznes.
// KYC/VÖEN/sənədlər SIZDIRILMIR — yalnız açıq məlumat + obyektlər.
router.get('/businesses/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    if (Number.isNaN(id)) { res.status(400).json({ success: false, message: 'Yanlış ID' }); return; }
    const business = await prisma.business.findUnique({
      where: { id },
      select: {
        id: true, name: true, status: true, isActive: true,
        website: true, instagram: true, facebook: true, tiktok: true, youtube: true, linkedin: true,
        objects: {
          where: { isActive: true },
          select: {
            id: true, name: true, city: true, address: true, 
            activityAreas: true, latitude: true, longitude: true,
            _count: { select: { listings: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!business || business.status !== 'APPROVED' || !business.isActive) {
      res.status(404).json({ success: false, message: 'Biznes tapılmadı' }); return;
    }
    res.json({ success: true, business });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
