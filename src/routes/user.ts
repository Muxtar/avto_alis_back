import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { getProvider, isConfigured, signState, verifyState, OAUTH_PLATFORMS } from '../services/socialOauth';
import { upload } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';
import { listingWriteLimiter, bulkLimiter } from '../middleware/rateLimiter';
import { extractPassportFromFiles } from '../services/vehiclePassportAI';
import { analyzeCredential, verifyIdentityAI, extractIdName } from '../services/credentialAI';
import fs from 'fs';
import path from 'path';

const router = Router();
const prisma = new PrismaClient();

// Get current user full profile
router.get('/me', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.adminId },
      select: {
        id: true, name: true, phone: true, email: true, type: true, role: true, verified: true,
        profileComplete: true, sellerVerified: true, sellerVerifiedAt: true, createdAt: true,
        idVerifyStatus: true, profession: true, avatar: true,
        idCardImage: true, selfieImage: true, faceMatchScore: true, idNumber: true,
        birthDate: true, gender: true,
        idAiNameMatch: true, idAiNameScore: true, idAiFaceMatch: true, idAiFaceScore: true, idAiReason: true,
        city: true, address: true, latitude: true, longitude: true,
        workplaces: true, vehicles: true,
        socialLinks: { select: { id: true, platform: true, url: true, verified: true } },
        professionDocuments: {
          select: {
            id: true, title: true, image: true, documentType: true, holderName: true,
            nameMatch: true, nameMatchScore: true, professionMatch: true, confidence: true,
            aiReason: true, status: true, createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        sellerApplication: { select: { status: true, rejectionReason: true, submittedAt: true } },
        _count: { select: { listings: true, sentMessages: true, receivedMessages: true } },
      },
    });
    if (!user) { res.status(404).json({ success: false }); return; }
    res.json({ success: true, user });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Kimlik təsdiqini yenidən təqdim et (profildən). Üz uyğunluğu brauzerdə hesablanır.
const identityUpload = upload.fields([{ name: 'idCardImage', maxCount: 1 }, { name: 'selfieImage', maxCount: 1 }]);
router.post('/me/identity', adminAuth, identityUpload, processImages, async (req: AuthRequest, res: Response) => {
  try {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const idCardFile = files?.['idCardImage']?.[0];
    const selfieFile = files?.['selfieImage']?.[0];
    if (!idCardFile || !selfieFile) {
      res.status(400).json({ success: false, message: 'Şəxsiyyət vəsiqəsi şəkli və selfie tələb olunur' }); return;
    }
    const scoreNum = req.body.faceMatchScore !== undefined ? parseFloat(String(req.body.faceMatchScore)) : NaN;

    // Vəsiqədən oxunan ad-soyad varsa profil adını yenilə (kimlik = mənbə).
    const idName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (idName) {
      await prisma.user.update({ where: { id: req.adminId! }, data: { name: idName } }).catch(() => {});
    }
    // İstifadəçinin (yenilənmiş) ad-soyadı ilə müqayisə üçün adı götür.
    const me = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { name: true } });
    // Claude AI ilə kimlik doğrulaması (vəsiqə adı + üz uyğunluğu).
    const ai = await verifyIdentityAI(idCardFile.path, selfieFile.path, (me?.name || '').trim());

    const user = await prisma.user.update({
      where: { id: req.adminId! },
      data: {
        idCardImage: idCardFile.filename, selfieImage: selfieFile.filename,
        ...(ai.birthDate ? { birthDate: new Date(ai.birthDate) } : {}),
        ...(ai.gender ? { gender: ai.gender } : {}),
        ...(ai.idNumber ? { idNumber: ai.idNumber } : {}),
        faceMatchScore: Number.isFinite(scoreNum) ? scoreNum : (ai.ok ? ai.faceMatchScore : null),
        idAiNameMatch: ai.ok ? ai.nameMatch : null,
        idAiNameScore: ai.ok ? ai.nameMatchScore : null,
        idAiFaceMatch: ai.ok ? ai.faceMatch : null,
        idAiFaceScore: ai.ok ? ai.faceMatchScore : null,
        idAiReason: ai.error ? ai.error : ai.reason,
        idVerifyStatus: 'PENDING',
      },
      select: { id: true, name: true, idVerifyStatus: true, faceMatchScore: true, idCardImage: true, selfieImage: true, idAiNameMatch: true, idAiFaceMatch: true, idAiReason: true },
    });
    res.json({ success: true, user });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Şəxsiyyət vəsiqəsi şəklindən ad-soyadı AI ilə oxu (qeydiyyatda/profildə avtomatik doldurma).
router.post('/me/extract-id-name', adminAuth, upload.single('idCardImage'), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    if (!file) { res.status(400).json({ success: false, message: 'Şəxsiyyət vəsiqəsi şəkli tələb olunur' }); return; }
    const r = await extractIdName(file.path);
    // Faylı saxlamırıq — yalnız ad oxumaq üçün idi (əsl yükləmə kimlik təsdiqində olur).
    fs.promises.unlink(file.path).catch(() => {});
    res.json({ success: true, ...r });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Peşə sənədi yüklə + AI ad-soyad uyğunluğunu yoxla.
// Bir neçə sənəd ayrı-ayrı sorğularla yüklənə bilər (hərəsində başlıq + 1 şəkil).
router.get('/me/credentials', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const docs = await prisma.professionDocument.findMany({
      where: { userId: req.adminId! },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, title: true, image: true, documentType: true, holderName: true,
        nameMatch: true, nameMatchScore: true, professionMatch: true, confidence: true,
        fraudSignals: true, aiReason: true, status: true, createdAt: true,
      },
    });
    res.json({ success: true, documents: docs });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.post('/me/credentials', adminAuth, upload.single('document'), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    const title = String(req.body.title || '').trim();
    if (!file) { res.status(400).json({ success: false, message: 'Sənəd şəkli tələb olunur' }); return; }
    if (!title) { res.status(400).json({ success: false, message: 'Sənədin başlığını yazın (məs. Diplom)' }); return; }

    const me = await prisma.user.findUnique({
      where: { id: req.adminId! },
      select: { name: true, profession: true },
    });
    const expectedName = (me?.name || '').trim();

    // AI analizi — ad-soyad uyğunluğunu yoxlayır. Xəta olsa belə sənəd saxlanılır (admin yoxlayar).
    const ai = await analyzeCredential(file.path, expectedName, me?.profession || null);

    const doc = await prisma.professionDocument.create({
      data: {
        userId: req.adminId!,
        title,
        image: file.filename,
        documentType: ai.documentType,
        issuer: ai.issuer,
        holderName: ai.holderName,
        nameMatch: ai.nameMatch,
        nameMatchScore: ai.ok ? ai.nameMatchScore : null,
        professionMatch: ai.professionMatch,
        confidence: ai.ok ? ai.confidence : null,
        fraudSignals: ai.fraudSignals,
        aiReason: ai.error ? ai.error : ai.reason,
        status: 'PENDING',
      },
      select: {
        id: true, title: true, image: true, documentType: true, holderName: true,
        nameMatch: true, nameMatchScore: true, professionMatch: true, confidence: true,
        fraudSignals: true, aiReason: true, status: true, createdAt: true,
      },
    });
    res.status(201).json({ success: true, document: doc, ai: { ok: ai.ok, error: ai.error } });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.delete('/me/credentials/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ success: false, message: 'Yanlış ID' }); return; }
    const doc = await prisma.professionDocument.findUnique({ where: { id }, select: { userId: true, image: true } });
    if (!doc || doc.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    await prisma.professionDocument.delete({ where: { id } });
    // Faylı da sil (best-effort).
    if (doc.image) fs.promises.unlink(path.join(__dirname, '../../uploads', doc.image)).catch(() => {});
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Profil şəkli yüklə.
router.post('/me/avatar', adminAuth, upload.single('avatar'), async (req: AuthRequest, res: Response) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    if (!file) { res.status(400).json({ success: false, message: 'Şəkil tələb olunur' }); return; }
    const user = await prisma.user.update({
      where: { id: req.adminId! },
      data: { avatar: file.filename },
      select: { id: true, name: true, phone: true, email: true, type: true, role: true, verified: true, profileComplete: true, profession: true, avatar: true },
    });
    res.json({ success: true, user });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Update my profile. city/address/latitude/longitude are the user's default
// location used to auto-fill listings and power the /locations browser.
router.put('/me', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { name, phone, city, address, latitude, longitude, profession } = req.body;
    const toFloat = (v: any) => {
      if (v === null || v === '' || v === undefined) return null;
      const n = typeof v === 'number' ? v : parseFloat(v);
      return Number.isFinite(n) ? n : null;
    };
    const user = await prisma.user.update({
      where: { id: req.adminId },
      data: {
        ...(name !== undefined && { name }),
        ...(phone !== undefined && { phone }),
        ...(profession !== undefined && { profession: profession?.trim() || null }),
        ...(city !== undefined && { city: city || null }),
        ...(address !== undefined && { address: address || null }),
        ...(latitude !== undefined && { latitude: toFloat(latitude) }),
        ...(longitude !== undefined && { longitude: toFloat(longitude) }),
      },
      select: {
        id: true, name: true, phone: true, email: true, type: true, role: true, verified: true, createdAt: true,
        profession: true, avatar: true,
        city: true, address: true, latitude: true, longitude: true,
      },
    });
    res.json({ success: true, user });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get my listings with stats
router.get('/me/listings', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const listings = await prisma.listing.findMany({
      where: { userId: req.adminId },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, phone: true, type: true } },
        _count: { select: { comments: true } },
      },
    });
    res.json({ listings });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Create my listing — any logged-in user can post (PRODUCT or SERVICE).
// If `city`/`location` aren't provided, falls back to the user's default
// location from their profile so listings always carry where they're from.
router.post('/me/listings', listingWriteLimiter, adminAuth, upload.array('images', 5), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const { title, description, price, category, type, location, phone, condition, country, brand, stock, forVehicle, unit, unitValue, year, model, city, fuelType, paymentType, businessObjectId, attributes, listingMode } = req.body;
    const parsedAttrs = (() => { try { const o = attributes ? JSON.parse(attributes) : null; return o && typeof o === 'object' && Object.keys(o).length ? o : undefined; } catch { return undefined; } })();

    if (!title || !description || !price || !category || !type) {
      res.status(400).json({ success: false, message: 'Başlıq, təsvir, qiymət, kateqoriya və tip tələb olunur' }); return;
    }
    if (type !== 'PRODUCT' && type !== 'SERVICE') {
      res.status(400).json({ success: false, message: 'Tip yalnız PRODUCT və ya SERVICE ola bilər' }); return;
    }

    // Biznes obyekti seçilibsə — TƏSDİQLƏNMİŞ biznesə aid olmalıdır (kart üçün).
    let bizId: number | null = null;
    let bizObjId: number | null = null;
    if (businessObjectId) {
      const obj = await prisma.businessObject.findUnique({
        where: { id: parseInt(String(businessObjectId)) },
        include: { business: true },
      });
      if (!obj || obj.business.userId !== req.adminId) {
        res.status(403).json({ success: false, message: 'Seçilmiş obyekt sizə aid deyil' }); return;
      }
      if (obj.business.status !== 'APPROVED') {
        res.status(400).json({ success: false, message: 'Biznes hələ təsdiqlənməyib' }); return;
      }
      bizId = obj.businessId;
      bizObjId = obj.id;
    }

    // VÖEN-li elan MÜTLƏQ təsdiqlənmiş biznes obyektinə bağlı olmalıdır (kartla satış).
    if (listingMode === 'voen' && !bizObjId) {
      res.status(400).json({ success: false, message: 'VÖEN-li elan üçün təsdiqlənmiş biznes və ona bağlı obyekt seçilməlidir' }); return;
    }

    const files = req.files as Express.Multer.File[];
    const images = files?.map((f) => f.filename) || [];

    // Inherit user's default city/address when caller didn't pass one.
    const me = await prisma.user.findUnique({
      where: { id: req.adminId! },
      select: { city: true, address: true },
    });
    const effectiveCity = city || me?.city || null;
    const effectiveLocation = location || me?.address || null;

    const expiresAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const listing = await prisma.listing.create({
      data: {
        userId: req.adminId!, title, description, price: parseFloat(price),
        category, type, images, location: effectiveLocation, phone: phone || null,
        condition: condition || 'NEW',
        country: country || null,
        brand: brand || null,
        stock: stock ? parseInt(stock) : 1,
        forVehicle: forVehicle || null,
        unit: unit || null,
        unitValue: unitValue ? parseFloat(unitValue) : null,
        year: year ? parseInt(year) : null,
        model: model || null,
        city: effectiveCity,
        fuelType: fuelType || null,
        paymentType: paymentType || null,
        attributes: parsedAttrs ?? undefined,
        businessId: bizId,
        businessObjectId: bizObjId,
        expiresAt,
      },
    });
    res.status(201).json({ success: true, listing });
  } catch (error: any) {
    console.error('[POST /me/listings] error:', error.message, error.code, error);
    res.status(400).json({ success: false, message: error.message });
  }
});

// Update my listing — accepts multipart/form-data so images can be edited.
// Pass `existingImages` as a JSON-stringified array of filenames to keep;
// any image previously stored but not in the array is deleted from disk.
// New uploads via `images` field are appended (total cap = 5).
router.put('/me/listings/:id', adminAuth, upload.array('images', 5), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.listing.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!existing || existing.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return;
    }
    const { title, description, price, category, type, location, phone, condition, country, brand, stock, forVehicle, unit, unitValue, year, model, city, fuelType, paymentType, existingImages, attributes } = req.body;
    const parsedAttrs = attributes !== undefined ? (() => { try { const o = JSON.parse(attributes); return o && typeof o === 'object' ? o : {}; } catch { return {}; } })() : undefined;

    let nextImages: string[] | undefined;
    const isMultipart = (req.headers['content-type'] || '').includes('multipart/form-data');
    const newFiles = (req.files as Express.Multer.File[] | undefined) || [];

    if (isMultipart) {
      let kept: string[] = existing.images;
      if (existingImages !== undefined) {
        try {
          const parsed = typeof existingImages === 'string' ? JSON.parse(existingImages) : existingImages;
          if (Array.isArray(parsed)) kept = parsed.filter((s) => typeof s === 'string');
        } catch {
          kept = existing.images;
        }
      }
      // Delete removed images from disk.
      const removed = existing.images.filter((img) => !kept.includes(img));
      for (const img of removed) {
        const filePath = path.join(__dirname, '../../uploads', img);
        fs.unlink(filePath, () => {});
      }
      nextImages = [...kept, ...newFiles.map((f) => f.filename)].slice(0, 5);
    }

    const listing = await prisma.listing.update({
      where: { id: parseInt(req.params.id) },
      data: {
        ...(title !== undefined && { title }), ...(description !== undefined && { description }),
        ...(price !== undefined && { price: parseFloat(price) }), ...(category !== undefined && { category }),
        ...(type !== undefined && { type }), ...(location !== undefined && { location }),
        ...(phone !== undefined && { phone }),
        ...(condition !== undefined && { condition }),
        ...(country !== undefined && { country }),
        ...(brand !== undefined && { brand }),
        ...(stock !== undefined && { stock: parseInt(stock) }),
        ...(forVehicle !== undefined && { forVehicle }),
        ...(unit !== undefined && { unit }),
        ...(unitValue !== undefined && { unitValue: unitValue ? parseFloat(unitValue) : null }),
        ...(year !== undefined && { year: year ? parseInt(year) : null }),
        ...(model !== undefined && { model: model || null }),
        ...(city !== undefined && { city: city || null }),
        ...(fuelType !== undefined && { fuelType: fuelType || null }),
        ...(paymentType !== undefined && { paymentType: paymentType || null }),
        ...(parsedAttrs !== undefined && { attributes: parsedAttrs }),
        ...(nextImages !== undefined && { images: nextImages }),
      },
    });
    res.json({ success: true, listing });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Bulk publish from desktop sync — accepts up to 100 items at once.
// Used by Kassa SQL desktop app to push local inventory to tradixai.
router.post('/me/listings/bulk', bulkLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const items = req.body?.items;
    const { businessObjectId, listingMode } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ success: false, message: 'items massiv tələb olunur' });
      return;
    }
    if (items.length > 100) {
      res.status(400).json({ success: false, message: 'Maksimum 100 məhsul bir sorğuda' });
      return;
    }

    // Bütün toplu elanlar bir təsdiqlənmiş biznes obyektinə bağlanır (kartla satış üçün).
    let bizId: number | null = null;
    let bizObjId: number | null = null;
    if (businessObjectId) {
      const obj = await prisma.businessObject.findUnique({
        where: { id: parseInt(String(businessObjectId)) },
        include: { business: true },
      });
      if (!obj || obj.business.userId !== req.adminId) {
        res.status(403).json({ success: false, message: 'Seçilmiş obyekt sizə aid deyil' }); return;
      }
      if (obj.business.status !== 'APPROVED') {
        res.status(400).json({ success: false, message: 'Biznes hələ təsdiqlənməyib' }); return;
      }
      bizId = obj.businessId;
      bizObjId = obj.id;
    }
    // VÖEN-li toplu yükləmədə obyekt mütləqdir.
    if (listingMode === 'voen' && !bizObjId) {
      res.status(400).json({ success: false, message: 'VÖEN-li toplu yükləmə üçün təsdiqlənmiş biznes obyekti seçilməlidir' }); return;
    }
    const expiresAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const created: { index: number; id: number; externalId?: string }[] = [];
    const errors: { index: number; message: string; externalId?: string }[] = [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      try {
        if (!it?.title || !it?.price || !it?.category) {
          errors.push({ index: i, message: 'title, price, category tələb olunur', externalId: it?.externalId });
          continue;
        }
        const listing = await prisma.listing.create({
          data: {
            userId: req.adminId!,
            title: String(it.title),
            description: String(it.description || it.title),
            price: parseFloat(String(it.price)),
            category: String(it.category),
            type: it.type === 'SERVICE' ? 'SERVICE' : 'PRODUCT',
            images: [],
            condition: it.condition || 'NEW',
            brand: it.brand ? String(it.brand) : null,
            stock: it.stock ? parseInt(String(it.stock)) : 1,
            model: it.model ? String(it.model) : null,
            year: it.year ? parseInt(String(it.year)) : null,
            city: it.city ? String(it.city) : null,
            forVehicle: it.forVehicle ? String(it.forVehicle) : null,
            businessId: bizId,
            businessObjectId: bizObjId,
            expiresAt,
          },
        });
        created.push({ index: i, id: listing.id, externalId: it.externalId });
      } catch (err: any) {
        errors.push({ index: i, message: err.message, externalId: it?.externalId });
      }
    }
    res.json({ success: true, created, errors, total: items.length });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Reactivate my listing — extends expiry by 20 days.
// H7 fix: cooldown of 24h between reactivations to prevent gaming the
// "newest" sort by spam-reactivating.
router.post('/me/listings/:id/reactivate', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, message: 'Yanlış ID' }); return;
    }
    const existing = await prisma.listing.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return;
    }
    // Cooldown: only allow reactivation if the listing is actually expired
    // (or within 1 day of expiring) — prevents abuse.
    const now = Date.now();
    if (existing.expiresAt && existing.expiresAt.getTime() > now + 24 * 60 * 60 * 1000) {
      res.status(400).json({
        success: false,
        message: 'Bu elanın müddəti hələ dolmayıb. Yalnız bitməyə yaxın və ya bitmiş elanları yeniləmək olar.',
      });
      return;
    }
    const expiresAt = new Date(now + 20 * 24 * 60 * 60 * 1000);
    const listing = await prisma.listing.update({
      where: { id: existing.id },
      data: { expiresAt },
    });
    res.json({ success: true, listing });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Delete my listing + cleanup uploaded images
router.delete('/me/listings/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.listing.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!existing || existing.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return;
    }

    // Resimleri diskten sil
    if (existing.images && existing.images.length > 0) {
      for (const img of existing.images) {
        const filePath = path.join(__dirname, '../../uploads', img);
        fs.unlink(filePath, () => {}); // sessiz sil, dosya yoksa hata vermesin
      }
    }

    await prisma.listing.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== EMAIL VERIFICATION =====================

function generateEmailCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send email verification code
router.post('/me/email/send-code', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ success: false, message: 'Email tələb olunur' });
      return;
    }
    const code = generateEmailCode();
    await prisma.emailVerification.create({
      data: {
        userId: req.adminId!,
        email,
        code,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });
    // TEST MODE: kodu cavabda qaytarir. SMS_PROVIDER=twilio qoyulanda gizlədilir
    const isDev = process.env.SMS_PROVIDER !== 'twilio';
    res.json({ success: true, message: 'Doğrulama kodu göndərildi', ...(isDev && { code }) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Verify email code
router.post('/me/email/verify', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { email, code } = req.body;
    const record = await prisma.emailVerification.findFirst({
      where: { userId: req.adminId!, email, verified: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!record || record.code !== code) {
      res.status(400).json({ success: false, message: 'Kod yanlışdır və ya vaxtı keçib' });
      return;
    }
    await prisma.emailVerification.update({ where: { id: record.id }, data: { verified: true } });
    const user = await prisma.user.update({
      where: { id: req.adminId! },
      data: { email },
      select: { id: true, name: true, phone: true, email: true, type: true, role: true, verified: true, createdAt: true },
    });
    res.json({ success: true, user });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== SOSIAL MEDIA HESABLARI =====================
const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'linkedin', 'twitter', 'telegram', 'website'];

router.get('/me/social', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const links = await prisma.socialLink.findMany({ where: { userId: req.adminId! }, orderBy: { id: 'asc' } });
    res.json({ success: true, links });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Əl ilə link əlavə et — admin təsdiqindən sonra public profildə görünür.
router.post('/me/social', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const platform = String(req.body.platform || '').toLowerCase().trim();
    const url = String(req.body.url || '').trim();
    if (!SOCIAL_PLATFORMS.includes(platform)) { res.status(400).json({ success: false, message: 'Platforma yanlışdır' }); return; }
    if (!/^https?:\/\//i.test(url)) { res.status(400).json({ success: false, message: 'Düzgün link daxil edin (https://...)' }); return; }
    const link = await prisma.socialLink.upsert({
      where: { userId_platform: { userId: req.adminId!, platform } },
      update: { url, verified: false },
      create: { userId: req.adminId!, platform, url },
    });
    res.json({ success: true, link });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.delete('/me/social/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const link = await prisma.socialLink.findUnique({ where: { id } });
    if (!link || link.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    await prisma.socialLink.delete({ where: { id } });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ---- OAuth ilə təsdiq ("hesabla daxil ol" — ən güclü üsul) ----
const SOCIAL_FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Hansı platformalar OAuth üçün konfiqurasiya olunub (env açarı var)?
router.get('/social/oauth/providers', async (_req: Request, res: Response) => {
  res.json({ success: true, configured: OAUTH_PLATFORMS.filter(isConfigured) });
});

// OAuth başlat — imzalı state ilə platformanın authorize URL-ini qaytarır.
router.get('/me/social/oauth/:platform/start', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const platform = req.params.platform;
    const provider = getProvider(platform);
    if (!provider) { res.status(400).json({ success: false, message: 'Platforma dəstəklənmir' }); return; }
    if (!isConfigured(platform)) { res.status(400).json({ success: false, message: `${platform} üçün OAuth açarları konfiqurasiya olunmayıb` }); return; }
    res.json({ success: true, url: provider.buildAuthUrl(signState(req.adminId!, platform)) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// OAuth callback — platforma buraya yönləndirir: token mübadiləsi + linki verified saxla.
router.get('/social/oauth/:platform/callback', async (req: Request, res: Response) => {
  const platform = req.params.platform;
  const fail = (msg: string) => res.redirect(`${SOCIAL_FRONTEND_URL}/profile?social=error&msg=${encodeURIComponent(msg)}`);
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const decoded = verifyState(state);
    const provider = getProvider(platform);
    if (!decoded || decoded.platform !== platform || !provider) return fail('Etibarsız sorğu');
    if (!code) return fail('Kod gəlmədi');
    const { url } = await provider.exchange(code);
    await prisma.socialLink.upsert({
      where: { userId_platform: { userId: decoded.userId, platform } },
      update: { url, verified: true },
      create: { userId: decoded.userId, platform, url, verified: true },
    });
    return res.redirect(`${SOCIAL_FRONTEND_URL}/profile?social=connected`);
  } catch (e: any) {
    return fail(e.message || 'OAuth xətası');
  }
});

// ===================== VEHICLES (CAR_OWNER) =====================

// List my vehicles
router.get('/me/vehicles', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const vehicles = await prisma.vehicle.findMany({ where: { userId: req.adminId! }, orderBy: { id: 'desc' } });
    res.json({ vehicles });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Two-image upload: front + back of the texniki pasport.
const passportFields = upload.fields([
  { name: 'passportImageFront', maxCount: 1 },
  { name: 'passportImageBack', maxCount: 1 },
]);

function pickPassportFile(
  files: Express.Multer.File[] | { [k: string]: Express.Multer.File[] } | undefined,
  key: string,
): Express.Multer.File | undefined {
  if (!files || Array.isArray(files)) return undefined;
  return files[key]?.[0];
}

// Bütün AI sahələrini eyni şəkildə UI-dan ya da AI-dan götürmək üçün ortaq
// list. JSON save endpoint-ləri də bunu istifadə edir.
const PASSPORT_FIELD_KEYS = [
  'registrationNumber', 'registrationDate', 'manufactureYear',
  'ownerName', 'ownerAddress', 'ownershipType', 'validUntil', 'cardSerial',
  'vehicleType', 'engineNumber', 'bodyNumber', 'chassisNumber', 'color',
  'maxMass', 'unloadedMass', 'seatCount', 'engineCapacity', 'issuedBy', 'specialMarks',
] as const;

const NUMERIC_FIELDS = new Set(['manufactureYear', 'seatCount']);

function pickPassportFields(input: Record<string, any> | undefined | null) {
  const out: Record<string, any> = {};
  if (!input) return out;
  for (const k of PASSPORT_FIELD_KEYS) {
    const v = input[k];
    if (v === undefined) continue;
    if (v === null || v === '') {
      out[k] = null;
      continue;
    }
    if (NUMERIC_FIELDS.has(k)) {
      const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^0-9]/g, ''), 10);
      out[k] = Number.isFinite(n) ? n : null;
    } else {
      out[k] = String(v).trim() || null;
    }
  }
  return out;
}

// STEP 1: Şəkilləri yüklə + AI ilə oxu. DB-yə HEÇ NƏ yazılmır.
// Cavab: yüklənmiş fayl adları + bütün sahələr. UI bunları forma yığır,
// kullanıcı redaktə edir, sonra /me/vehicles/save-ə göndərir.
router.post(
  '/me/vehicles/extract',
  adminAuth,
  passportFields,
  processImages,
  async (req: AuthRequest, res: Response) => {
    try {
      const front = pickPassportFile(req.files, 'passportImageFront');
      const back = pickPassportFile(req.files, 'passportImageBack');
      if (!front || !back) {
        res.status(400).json({
          success: false,
          message: 'Texniki pasportun ön və arxa şəkilləri tələb olunur',
        });
        return;
      }

      const ai = await extractPassportFromFiles(front.path, back.path);
      const f = ai.fields;
      res.json({
        success: true,
        ok: ai.ok,
        error: ai.error,
        passportImageFront: front.filename,
        passportImageBack: back.filename,
        fields: {
          // marka/model/year-i ayrıca qaytarırıq ki, UI form-un əsas
          // sahələrinə də ön-doldurma edə bilsin.
          brand: f.brand,
          model: f.model,
          year: f.manufactureYear,
          registrationNumber: f.registrationNumber,
          registrationDate: f.registrationDate,
          manufactureYear: f.manufactureYear,
          ownerName: f.ownerName,
          ownerAddress: f.ownerAddress,
          ownershipType: f.ownershipType,
          validUntil: f.validUntil,
          cardSerial: f.cardSerial,
          vehicleType: f.vehicleType,
          engineNumber: f.engineNumber,
          bodyNumber: f.bodyNumber,
          chassisNumber: f.chassisNumber,
          color: f.color,
          maxMass: f.maxMass,
          unloadedMass: f.unloadedMass,
          seatCount: f.seatCount,
          engineCapacity: f.engineCapacity,
          issuedBy: f.issuedBy,
          specialMarks: f.specialMarks,
        },
        aiRaw: ai.raw,
      });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
);

// STEP 2: Kullanıcının redaktə etdiyi sahələri DB-yə yaz.
// Body JSON: { brand, model, year, passportImageFront, passportImageBack, ...fields }
router.post('/me/vehicles', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as Record<string, any>;
    const brand = String(body.brand || '').trim();
    const model = String(body.model || '').trim();
    const yearStr = body.year ? String(body.year) : '';
    const front = body.passportImageFront ? String(body.passportImageFront) : null;
    const back = body.passportImageBack ? String(body.passportImageBack) : null;

    if (!brand || !model || !yearStr) {
      res.status(400).json({ success: false, message: 'Marka, model və il tələb olunur' });
      return;
    }
    if (!front || !back) {
      res.status(400).json({
        success: false,
        message: 'Texniki pasportun ön və arxa şəkilləri tələb olunur (əvvəlcə /extract çağırın)',
      });
      return;
    }

    const fields = pickPassportFields(body);
    const vehicle = await prisma.vehicle.create({
      data: {
        userId: req.adminId!,
        brand,
        model,
        year: parseInt(yearStr, 10),
        passportImage: front,
        passportImageFront: front,
        passportImageBack: back,
        ...fields,
        aiExtracted: body.aiRaw ?? null,
        aiVerifiedAt: body.aiVerified ? new Date() : null,
      },
    });
    res.status(201).json({ success: true, vehicle });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Update a vehicle (JSON). Yeni şəkillər lazımdırsa, əvvəlcədən /extract
// çağırılıb fayl adları + sahələr UI-da redaktə edilməlidir.
router.put('/me/vehicles/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.vehicle.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    const body = req.body as Record<string, any>;
    const updates: Record<string, any> = {};

    if (body.brand !== undefined) updates.brand = String(body.brand);
    if (body.model !== undefined) updates.model = String(body.model);
    if (body.year !== undefined) updates.year = parseInt(String(body.year), 10);

    // Yeni şəkillər
    if (body.passportImageFront && body.passportImageFront !== existing.passportImageFront) {
      if (existing.passportImageFront) {
        fs.unlink(path.join(__dirname, '../../uploads', existing.passportImageFront), () => {});
      }
      updates.passportImage = body.passportImageFront;
      updates.passportImageFront = body.passportImageFront;
    }
    if (body.passportImageBack && body.passportImageBack !== existing.passportImageBack) {
      if (existing.passportImageBack) {
        fs.unlink(path.join(__dirname, '../../uploads', existing.passportImageBack), () => {});
      }
      updates.passportImageBack = body.passportImageBack;
    }

    Object.assign(updates, pickPassportFields(body));
    if (body.aiRaw !== undefined) updates.aiExtracted = body.aiRaw;
    if (body.aiVerified) updates.aiVerifiedAt = new Date();

    const vehicle = await prisma.vehicle.update({ where: { id }, data: updates });
    res.json({ success: true, vehicle });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Delete a vehicle
router.delete('/me/vehicles/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.vehicle.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    for (const fname of [existing.passportImage, existing.passportImageFront, existing.passportImageBack]) {
      if (fname) {
        fs.unlink(path.join(__dirname, '../../uploads', fname), () => {});
      }
    }
    await prisma.vehicle.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== WORKPLACES (MECHANIC / PARTS_SELLER) =====================

router.get('/me/workplaces', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const workplaces = await prisma.workplace.findMany({ where: { userId: req.adminId! }, orderBy: { id: 'desc' } });
    res.json({ workplaces });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/me/workplaces', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { name, address, latitude, longitude } = req.body;
    if (!name || !address) {
      res.status(400).json({ success: false, message: 'Ad və ünvan tələb olunur' });
      return;
    }
    const workplace = await prisma.workplace.create({
      data: {
        userId: req.adminId!,
        name,
        address,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
      },
    });
    res.status(201).json({ success: true, workplace });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.put('/me/workplaces/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.workplace.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    const { name, address, latitude, longitude } = req.body;
    const workplace = await prisma.workplace.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(address !== undefined && { address }),
        ...(latitude !== undefined && { latitude: latitude === null || latitude === '' ? null : parseFloat(latitude) }),
        ...(longitude !== undefined && { longitude: longitude === null || longitude === '' ? null : parseFloat(longitude) }),
      },
    });
    res.json({ success: true, workplace });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/me/workplaces/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.workplace.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    await prisma.workplace.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
