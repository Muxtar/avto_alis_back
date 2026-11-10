// Ana səhifə reklamı — istifadəçi, ictimai və admin marşrutları.
// Bax: services/homeAds.ts (axın, qiymət, slotlar).
import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import { adminAuth, requirePermission, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';
import { consultationLimiter, rateLimit } from '../middleware/rateLimiter';
import { createPayment as createGatewayPayment } from '../services/paymentGateway';
import { publicListingWhere } from '../services/listingVisibility';
import { pushAdmins } from '../services/live';
import {
  AD_PLACEMENTS, AD_DAYS, type AdPlacement, adPackages, adPricePerDay, adPrice, slotUsage,
  markAdPaid, approveAd, rejectAd,
} from '../services/homeAds';

const router = Router();
const prisma = new PrismaClient();
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 5001}`;
const statLimiter = rateLimit(600, 60 * 60 * 1000);

// Multer xətasını təmiz JSON-la qaytar.
function adImage(req: Request, res: Response, next: NextFunction) {
  upload.single('image')(req, res, (err: any) => {
    if (err) {
      res.status(400).json({ success: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'Şəkil çox böyükdür' : (err.message || 'Şəkil yüklənmədi') });
      return;
    }
    next();
  });
}

function dropFile(req: Request) {
  const f = (req as any).file;
  if (f?.path) fs.promises.unlink(f.path).catch(() => undefined);
}

// Reklam edilə bilən mənbələr: istifadəçinin saytda GÖRÜNƏN elanları + aktiv obyektləri.
async function mySources(userId: number) {
  const [listings, objects] = await Promise.all([
    prisma.listing.findMany({
      where: { userId, ...publicListingWhere() },
      select: { id: true, title: true, price: true, images: true, type: true, city: true, businessId: true, businessObjectId: true },
      orderBy: { createdAt: 'desc' }, take: 200,
    }),
    prisma.businessObject.findMany({
      where: { isActive: true, deletedAt: null, business: { userId, deletedAt: null, status: 'APPROVED' } },
      select: { id: true, name: true, address: true, city: true, business: { select: { name: true } } },
      orderBy: { id: 'desc' }, take: 100,
    }),
  ]);
  // Obyektin şəkli yoxdur — həmin obyektin ilk elanının şəkli göstərilir.
  const objCover = new Map<number, string>();
  if (objects.length) {
    const ls = await prisma.listing.findMany({
      where: { businessObjectId: { in: objects.map((o) => o.id) }, ...publicListingWhere(), NOT: { images: { isEmpty: true } } },
      select: { businessObjectId: true, images: true }, orderBy: { createdAt: 'desc' }, take: 300,
    });
    for (const l of ls) if (l.businessObjectId && !objCover.has(l.businessObjectId)) objCover.set(l.businessObjectId, l.images[0]);
  }
  return {
    listings: listings.map((l) => ({
      id: l.id, title: l.title, price: l.price, image: l.images[0] || null, type: l.type, city: l.city,
      sellerKind: l.businessId || l.businessObjectId ? 'BUSINESS' : 'INDIVIDUAL',
    })),
    objects: objects.map((o) => ({ id: o.id, name: o.name, address: o.address, city: o.city, businessName: o.business?.name || null, image: objCover.get(o.id) || null })),
  };
}

// ── İctimai ──────────────────────────────────────────────────────────────────

router.get('/ads/packages', async (_req, res: Response) => {
  try { res.json({ success: true, ...(await adPackages()) }); }
  catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Ana səhifədə göstəriləcək aktiv reklamlar. Mənbə (elan/obyekt) artıq saytda
// görünmürsə reklam da göstərilmir.
router.get('/ads/active', async (_req, res: Response) => {
  try {
    const now = new Date();
    const ads = await prisma.homeAd.findMany({
      where: { status: 'ACTIVE', endsAt: { gt: now } },
      orderBy: [{ startsAt: 'asc' }],
      take: 100,
    });
    const listingIds = ads.map((a) => a.listingId).filter((x): x is number => !!x);
    const objectIds = ads.map((a) => a.objectId).filter((x): x is number => !!x);
    const [listings, objects] = await Promise.all([
      listingIds.length ? prisma.listing.findMany({
        where: { id: { in: listingIds }, ...publicListingWhere() },
        select: { id: true, price: true, images: true, city: true, title: true },
      }) : [],
      objectIds.length ? prisma.businessObject.findMany({
        where: { id: { in: objectIds }, isActive: true, deletedAt: null },
        select: { id: true, name: true, city: true, address: true },
      }) : [],
    ]);
    const lMap = new Map(listings.map((l) => [l.id, l]));
    const oMap = new Map(objects.map((o) => [o.id, o]));
    type PublicAd = {
      id: number; placement: string; sourceType: string; sellerKind: string; headline: string; subtitle: string | null;
      image: string | null; productImage: string | null; price: number | null; city: string | null; href: string;
    };
    const out = ads.flatMap((a): PublicAd[] => {
      if (a.sourceType === 'LISTING') {
        const l = a.listingId ? lMap.get(a.listingId) : null;
        if (!l) return [];
        return [{
          id: a.id, placement: a.placement, sourceType: a.sourceType, sellerKind: a.sellerKind,
          headline: a.headline, subtitle: a.subtitle, image: a.image || l.images[0] || null,
          productImage: l.images[0] || null, price: l.price, city: l.city, href: `/marketplace/${l.id}`,
        }];
      }
      const o = a.objectId ? oMap.get(a.objectId) : null;
      if (!o) return [];
      return [{
        id: a.id, placement: a.placement, sourceType: a.sourceType, sellerKind: a.sellerKind,
        headline: a.headline, subtitle: a.subtitle || o.address, image: a.image, productImage: null,
        price: null, city: o.city, href: `/object/${o.id}`,
      }];
    });
    res.json({ success: true, ads: out });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Statistika — göstərilmə (toplu) və klik.
router.post('/ads/impressions', statLimiter, async (req: Request, res: Response) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0).slice(0, 30);
    if (ids.length) await prisma.homeAd.updateMany({ where: { id: { in: ids }, status: 'ACTIVE' }, data: { impressions: { increment: 1 } } });
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});

router.post('/ads/:id/click', statLimiter, async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    if (id > 0) await prisma.homeAd.updateMany({ where: { id, status: 'ACTIVE' }, data: { clicks: { increment: 1 } } });
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});

// ── İstifadəçi ───────────────────────────────────────────────────────────────

router.get('/me/ads', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ads = await prisma.homeAd.findMany({ where: { userId: req.adminId! }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json({ success: true, ads });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.get('/me/ad-sources', adminAuth, async (req: AuthRequest, res: Response) => {
  try { res.json({ success: true, ...(await mySources(req.adminId!)) }); }
  catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

async function startPayment(ad: { id: number; userId: number; amount: number; days: number; headline: string; placement: string }) {
  const reference = `AD${ad.id}-${Date.now()}`;
  const pay = await createGatewayPayment({
    amount: ad.amount, reference,
    title: `Ana səhifə reklamı — ${ad.days} gün`,
    description: `«${ad.headline.slice(0, 60)}» — ${ad.placement === 'MAIN' ? 'ana karusel' : 'yan banner'}, ${ad.days} gün`,
    callbackBase: PUBLIC_BACKEND_URL, language: 'az',
  });
  await prisma.businessFee.create({
    data: {
      userId: ad.userId, amount: ad.amount, status: 'UNPAID', purpose: 'AD', adId: ad.id,
      gatewayProvider: pay.provider, gatewayRef: pay.ref, gatewayOrderId: pay.gatewayOrderId, gatewayPassword: pay.password,
    },
  });
  return pay;
}

// Yeni reklam: mənbə + yerləşmə + paket + mətn (+ istəyə görə xüsusi şəkil).
router.post('/me/ads', consultationLimiter, adminAuth, adImage, processImages, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.adminId!;
    const placement = String(req.body?.placement || '') as AdPlacement;
    const days = parseInt(String(req.body?.days));
    const sourceType = String(req.body?.sourceType || '');
    const headline = String(req.body?.headline || '').replace(/\s+/g, ' ').trim().slice(0, 70);
    const subtitle = String(req.body?.subtitle || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
    const file = (req as any).file;
    const fail = (m: string) => { dropFile(req); res.status(400).json({ success: false, message: m }); };

    if (!AD_PLACEMENTS.includes(placement)) return fail('Reklam yerini seçin');
    if (!AD_DAYS.some((d) => d.days === days)) return fail('Paket seçin');
    if (headline.length < 3) return fail('Reklam başlığını yazın');

    const src = await mySources(userId);
    let listingId: number | null = null, objectId: number | null = null;
    let sellerKind = 'INDIVIDUAL';
    let hasImage = !!file;
    if (sourceType === 'LISTING') {
      const l = src.listings.find((x) => x.id === parseInt(String(req.body?.listingId)));
      if (!l) return fail('Elan tapılmadı və ya saytda görünmür');
      listingId = l.id; sellerKind = l.sellerKind; hasImage = hasImage || !!l.image;
    } else if (sourceType === 'OBJECT') {
      const o = src.objects.find((x) => x.id === parseInt(String(req.body?.objectId)));
      if (!o) return fail('Obyekt tapılmadı və ya aktiv deyil');
      objectId = o.id; sellerKind = 'BUSINESS'; hasImage = hasImage || !!o.image;
    } else return fail('Reklam ediləcək elanı və ya obyekti seçin');
    if (!hasImage) return fail('Reklam üçün şəkil yükləyin');

    const usage = await slotUsage(placement);
    if (usage.free <= 0) {
      return fail(`Bu yerdə boş slot yoxdur.${usage.nextFreeAt ? ` Ən tez ${usage.nextFreeAt.toLocaleDateString('az-AZ')} tarixində boşalır.` : ''}`);
    }

    const amount = adPrice(await adPricePerDay(placement), days);
    // Obyekt reklamında şəkil yüklənməyibsə obyektin ilk elanının şəkli götürülür.
    const objImg = objectId ? src.objects.find((o) => o.id === objectId)?.image || null : null;
    const ad = await prisma.homeAd.create({
      data: {
        userId, placement, sourceType, listingId, objectId, sellerKind, headline, subtitle,
        image: file?.filename || objImg, days, amount, status: 'UNPAID',
      },
    });

    if (amount <= 0) {
      await markAdPaid(ad.id);
      res.json({ success: true, free: true, ad: await prisma.homeAd.findUnique({ where: { id: ad.id } }) });
      return;
    }
    const pay = await startPayment(ad);
    res.json({ success: true, amount, adId: ad.id, redirectUrl: pay.redirectUrl });
  } catch (e: any) { dropFile(req); res.status(400).json({ success: false, message: e.message }); }
});

// Yarımçıq qalmış ödənişi təkrarla.
router.post('/me/ads/:id/pay', consultationLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ad = await prisma.homeAd.findUnique({ where: { id: parseInt(String(req.params.id)) } });
    if (!ad || ad.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ad.status !== 'UNPAID') { res.status(400).json({ success: false, message: 'Bu reklam artıq ödənilib' }); return; }
    const usage = await slotUsage(ad.placement as AdPlacement);
    if (usage.free <= 0) { res.status(400).json({ success: false, message: 'Bu yerdə hazırda boş slot yoxdur' }); return; }
    const pay = await startPayment(ad);
    res.json({ success: true, amount: ad.amount, adId: ad.id, redirectUrl: pay.redirectUrl });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Ödənilməmiş reklamı sil.
router.delete('/me/ads/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ad = await prisma.homeAd.findUnique({ where: { id: parseInt(String(req.params.id)) } });
    if (!ad || ad.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ad.status !== 'UNPAID') { res.status(400).json({ success: false, message: 'Yalnız ödənilməmiş reklam silinə bilər' }); return; }
    await prisma.homeAd.delete({ where: { id: ad.id } });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Admin (icazə: banners — karuseli idarə edən admin) ──────────────────────

router.get('/admin/ads', requirePermission('banners'), async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.query.status || '');
    const where: any = status === 'REFUND' ? { refundStatus: 'PENDING' } : status ? { status } : { status: { not: 'UNPAID' } };
    const ads = await prisma.homeAd.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 200,
      include: { user: { select: { id: true, name: true, phone: true } } },
    });
    const listingIds = ads.map((a) => a.listingId).filter((x): x is number => !!x);
    const objectIds = ads.map((a) => a.objectId).filter((x): x is number => !!x);
    const [ls, os, counts] = await Promise.all([
      listingIds.length ? prisma.listing.findMany({ where: { id: { in: listingIds } }, select: { id: true, title: true, images: true, price: true } }) : [],
      objectIds.length ? prisma.businessObject.findMany({ where: { id: { in: objectIds } }, select: { id: true, name: true, address: true } }) : [],
      prisma.homeAd.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const lMap = new Map(ls.map((l) => [l.id, l]));
    const oMap = new Map(os.map((o) => [o.id, o]));
    const refundPending = await prisma.homeAd.count({ where: { refundStatus: 'PENDING' } });
    res.json({
      success: true,
      ads: ads.map((a) => ({ ...a, listing: a.listingId ? lMap.get(a.listingId) || null : null, object: a.objectId ? oMap.get(a.objectId) || null : null })),
      counts: { ...Object.fromEntries(counts.map((c) => [c.status, c._count._all])), REFUND: refundPending },
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.post('/admin/ads/:id/approve', requirePermission('banners'), async (req: AuthRequest, res: Response) => {
  try {
    const ad = await approveAd(parseInt(String(req.params.id)));
    pushAdmins('ad', { id: ad.id });
    res.json({ success: true, ad });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.post('/admin/ads/:id/reject', requirePermission('banners'), async (req: AuthRequest, res: Response) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) { res.status(400).json({ success: false, message: 'Səbəbi yazın' }); return; }
    const ad = await rejectAd(parseInt(String(req.params.id)), reason);
    pushAdmins('ad', { id: ad.id });
    res.json({ success: true, ad });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Rədd edilmiş reklamın pulu bankdan qaytarıldı — qeyd.
router.post('/admin/ads/:id/refunded', requirePermission('banners'), async (req: AuthRequest, res: Response) => {
  try {
    const ad = await prisma.homeAd.update({ where: { id: parseInt(String(req.params.id)) }, data: { refundStatus: 'DONE' } });
    pushAdmins('ad', { id: ad.id });
    res.json({ success: true, ad });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
