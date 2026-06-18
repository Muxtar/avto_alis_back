import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { upload, docUpload } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';
import { verifyBusinessAI, BusinessDoc, extractBankAccounts, extractBusinessInfo, nameOverlapScore } from '../services/credentialAI';
import fs from 'fs';

const router = Router();
const prisma = new PrismaClient();

// Hər kəsə verilən xüsusi public ID (məs. "TX-7F3K2Q").
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(len = 6): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return 'TX-' + s;
}
async function ensurePublicId(userId: number): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { publicId: true } });
  if (u?.publicId) return u.publicId;
  for (let i = 0; i < 6; i++) {
    const code = randomCode();
    try {
      const updated = await prisma.user.update({ where: { id: userId }, data: { publicId: code }, select: { publicId: true } });
      return updated.publicId!;
    } catch { /* unikal toqquşma — yenidən cəhd */ }
  }
  throw new Error('public ID yaradıla bilmədi');
}

// KYC sənədləri üçün multipart sahələri.
const docFields = docUpload.fields([
  { name: 'taxDocImage', maxCount: 1 },
  { name: 'companyDocImage', maxCount: 1 },
  { name: 'powerOfAttorneyImage', maxCount: 1 },
  { name: 'bankDocImage', maxCount: 5 }, // bir neçə bank sənədi
  { name: 'idCardImage', maxCount: 1 },
  { name: 'selfieImage', maxCount: 1 },
]);
function filesOf(req: Request, key: string): Express.Multer.File[] {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  return files?.[key] || [];
}
function fileName(req: Request, key: string): string | null {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  return files?.[key]?.[0]?.filename || null;
}
function filePath(req: Request, key: string): string | null {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  return files?.[key]?.[0]?.path || null;
}

// ==================== İSTİFADƏÇİ: PUBLIC ID ====================
router.get('/me/public-id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const publicId = await ensurePublicId(req.adminId!);
    res.json({ success: true, publicId });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==================== İSTİFADƏÇİ: BİZNESLƏR ====================

router.get('/me/businesses', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    await ensurePublicId(req.adminId!);
    const businesses = await prisma.business.findMany({
      where: { userId: req.adminId },
      include: {
        banks: true,
        objects: { include: { _count: { select: { listings: true } } } },
        members: { include: { user: { select: { id: true, name: true, publicId: true } }, object: { select: { id: true, name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, businesses });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Vergi sənədindən (şəkil/PDF) şirkət məlumatlarını AI ilə oxu — forma avtomatik dolsun.
router.post('/me/extract-business-info', adminAuth, docUpload.single('doc'), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    if (!file) { res.status(400).json({ success: false, message: 'Sənəd tələb olunur' }); return; }
    const r = await extractBusinessInfo(file.path);
    fs.promises.unlink(file.path).catch(() => {}); // yalnız oxumaq üçün — əsl yükləmə formada olur

    // İstifadəçinin (kimlikdəki) adı şirkətin rəhbəri/sahibi ilə uyğundurmu?
    const me = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { name: true } });
    const userName = (me?.name || '').trim();
    const ownerScore = Math.max(
      nameOverlapScore(userName, r.ownerName || ''),
      nameOverlapScore(userName, r.founderName || ''),
    );
    const isOwner = !!userName && ownerScore >= 0.5;
    const ownerMessage = !r.ok
      ? (r.error || 'Sənəd oxunmadı')
      : isOwner
        ? 'Kimliyiniz şirkətin rəhbəri/sahibi ilə uyğundur.'
        : `Kimliyinizdəki ad ("${userName || '—'}") şirkətin rəhbəri ("${r.ownerName || '—'}") ilə uyğun deyil. Yalnız rəhbər və ya etibarnaməli şəxs biznes yarada bilər.`;

    res.json({ success: true, ...r, userName, isOwner, ownerScore, ownerMessage });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Bank sənədindən (şəkil/PDF) IBAN-ları AI ilə oxu — yükləmədən qabaq göstərmək üçün.
router.post('/me/extract-bank-doc', adminAuth, docUpload.single('doc'), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    if (!file) { res.status(400).json({ success: false, message: 'Sənəd tələb olunur' }); return; }
    const r = await extractBankAccounts(file.path);
    fs.promises.unlink(file.path).catch(() => {});
    res.json({ success: true, accounts: r.accounts, error: r.error });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Yeni biznes (multipart — sənədlər + sahələr + banks JSON)
router.post('/me/businesses', adminAuth, docFields, processImages, async (req: AuthRequest, res: Response) => {
  try {
    // Kimlik + üz təsdiqi olmadan biznes yaratmaq olmaz (profili tamamlamalıdır).
    const me = await prisma.user.findUnique({
      where: { id: req.adminId! },
      select: { idVerifyStatus: true, name: true, idCardImage: true, selfieImage: true, faceMatchScore: true, idAiFaceMatch: true, idAiFaceScore: true },
    });
    if (!me?.idVerifyStatus) {
      res.status(403).json({ success: false, code: 'ID_NOT_VERIFIED', message: 'Biznes yaratmaq üçün əvvəlcə profilinizi tamamlayın (kimlik + üz təsdiqi).' });
      return;
    }
    // Profildə kimlik artıq təsdiqlənib və üz uyğunluğu 50%-dən çoxdursa — biznesdə
    // təkrar kimlik+selfie istənilmir, profildəki sənədlər istifadə olunur.
    const faceOk = (me.faceMatchScore ?? 0) > 0.5 || me.idAiFaceMatch === true || (me.idAiFaceScore ?? 0) > 0.5;
    const identityReusable = !!me.idCardImage && !!me.selfieImage && faceOk;
    const { kind, proofType, name, voen, ownerName, founderName, phone, banks } = req.body;
    // Şirkət məlumatları sənəddən oxunur. Təsisçi sənəddə olmaya bilər — sahibə bərabər götürülür.
    const founder = (founderName?.trim() || ownerName?.trim() || '');
    if (!name?.trim() || !voen?.trim() || !ownerName?.trim()) {
      res.status(400).json({ success: false, message: 'Şirkət sənədi oxunmadı (ad/VÖEN/sahib) — sənədi yenidən yükləyin' }); return;
    }
    if (!['LEGAL', 'PHYSICAL'].includes(kind)) { res.status(400).json({ success: false, message: 'Şəxs növü seçin' }); return; }
    if (!['TAX_DOC', 'POWER_OF_ATTORNEY'].includes(proofType)) { res.status(400).json({ success: false, message: 'Sənəd növü seçin' }); return; }

    const taxDocImage = fileName(req, 'taxDocImage');
    const companyDocImage = fileName(req, 'companyDocImage');
    const powerOfAttorneyImage = fileName(req, 'powerOfAttorneyImage');
    // Kimlik artıq təsdiqlənibsə profildəki şəkilləri istifadə et; əks halda formdan götür.
    const idCardImage = fileName(req, 'idCardImage') || (identityReusable ? me.idCardImage : null);
    const selfieImage = fileName(req, 'selfieImage') || (identityReusable ? me.selfieImage : null);

    if (proofType === 'TAX_DOC' && !taxDocImage) { res.status(400).json({ success: false, message: 'Vergi qeydiyyatı sənədi tələb olunur' }); return; }
    if (proofType === 'POWER_OF_ATTORNEY' && (!companyDocImage || !powerOfAttorneyImage)) {
      res.status(400).json({ success: false, message: 'Şirkət sənədi və etibarnamə tələb olunur' }); return;
    }
    // Kimlik təkrar yalnız profildə təsdiq yoxdursa tələb olunur.
    if (!identityReusable && (!idCardImage || !selfieImage)) {
      res.status(400).json({ success: false, message: 'Şəxsiyyət vəsiqəsi və selfie tələb olunur' }); return;
    }

    // Bank sənədləri (bir neçə ola bilər) — IBAN-lar hər birindən AI ilə oxunur.
    const bankFiles = filesOf(req, 'bankDocImage');
    if (bankFiles.length === 0) { res.status(400).json({ success: false, message: 'Ən azı bir bank hesabı sənədi tələb olunur' }); return; }
    const primaryIdx = (() => { const n = parseInt(String(req.body.primaryBankIndex)); return Number.isInteger(n) && n >= 0 && n < bankFiles.length ? n : 0; })();
    const bankDocImages = bankFiles.map((f) => f.filename);
    const perDoc = await Promise.all(bankFiles.map((f) => extractBankAccounts(f.path)));

    // ---- Claude AI ilə şirkət sənədlərinin yoxlanması ----
    // Profil sahibi rəhbər (vergi sənədi) və ya etibarnaməli isə avtomatik təsdiq.
    const docs: BusinessDoc[] = [];
    if (proofType === 'TAX_DOC') {
      const p = filePath(req, 'taxDocImage'); if (p) docs.push({ label: 'Vergi qeydiyyatı sənədi', path: p });
    } else {
      const c = filePath(req, 'companyDocImage'); if (c) docs.push({ label: 'Şirkət sənədi', path: c });
      const a = filePath(req, 'powerOfAttorneyImage'); if (a) docs.push({ label: 'Etibarnamə', path: a });
    }
    const ai = await verifyBusinessAI(
      docs,
      proofType as 'TAX_DOC' | 'POWER_OF_ATTORNEY',
      { name: name.trim(), voen: voen.trim(), ownerName: ownerName.trim(), founderName: founder },
      (me?.name || '').trim(),
    );
    // TAX_DOC: kimlik şirkətin rəhbəri ilə uyğun deyilsə biznes yaradılmır (AI açarı varsa).
    // (Etibarnamə halında səlahiyyət etibarnamə ilə verilir — bloklanmır.)
    const userOwnerScore = Math.max(
      nameOverlapScore((me?.name || '').trim(), ownerName.trim()),
      nameOverlapScore((me?.name || '').trim(), founder),
    );
    if (proofType === 'TAX_DOC' && ai.ok && !ai.authorized && userOwnerScore < 0.5) {
      res.status(403).json({ success: false, code: 'NOT_OWNER', message: 'Kimliyinizdəki ad şirkətin rəhbəri ilə uyğun deyil — yalnız rəhbər və ya etibarnaməli şəxs biznes yarada bilər.' });
      return;
    }
    // Avtomatik təsdiq şərti: səlahiyyətli + sənəd əsl + VÖEN uyğun + yüksək əminlik + saxtakarlıq yoxdur.
    const autoApprove = ai.ok && ai.authorized && ai.documentValid && ai.voenMatch
      && ai.confidence >= 0.75 && ai.fraudSignals.length === 0;

    const business = await prisma.business.create({
      data: {
        userId: req.adminId!,
        kind, proofType,
        name: name.trim(), voen: voen.trim(),
        ownerName: ownerName.trim(), founderName: founder,
        phone: phone?.trim() || null,
        taxDocImage, companyDocImage, powerOfAttorneyImage,
        bankDocImage: bankDocImages[0] || null, bankDocImages,
        idCardImage, selfieImage,
        aiAuthorized: ai.ok ? ai.authorized : null,
        aiVoenMatch: ai.ok ? ai.voenMatch : null,
        aiConfidence: ai.ok ? ai.confidence : null,
        aiFraudSignals: ai.fraudSignals,
        aiReason: ai.error ? ai.error : ai.reason,
        autoApproved: autoApprove,
        ...(autoApprove ? { status: 'APPROVED' as any, reviewedAt: new Date() } : {}),
      },
    });

    // Avtomatik təsdiqlənibsə — satıcı statusunu ver + bildiriş.
    if (autoApprove) {
      await prisma.user.update({ where: { id: req.adminId! }, data: { sellerVerified: true, sellerVerifiedAt: new Date() } }).catch(() => {});
      await prisma.notification.create({
        data: { userId: req.adminId!, type: 'SYSTEM', title: 'Biznes təsdiqləndi', body: `"${name.trim()}" AI tərəfindən təsdiqləndi — artıq kartla satış mümkündür.`, link: '/business' },
      }).catch(() => {});
    }

    // Bank hesabları: hər sənədin IBAN-ları + əsas (primary) seçilən sənədin hesabı ödəniş üçün.
    const bankRows: { businessId: number; iban: string; title: string | null; isPrimary: boolean; docImage: string | null }[] = [];
    const seenIban = new Set<string>();
    let primaryAssigned = false;
    perDoc.forEach((d, idx) => {
      for (const acc of d.accounts) {
        if (seenIban.has(acc.iban)) continue;
        seenIban.add(acc.iban);
        const isPrimary = idx === primaryIdx && !primaryAssigned;
        if (isPrimary) primaryAssigned = true;
        bankRows.push({ businessId: business.id, iban: acc.iban, title: acc.bankName, isPrimary, docImage: bankFiles[idx].filename });
      }
    });
    // Əl ilə əlavə olunanlar (ixtiyari).
    try {
      const arr = banks ? JSON.parse(banks) : [];
      if (Array.isArray(arr)) {
        for (const b of arr) {
          const iban = String(b?.iban || '').replace(/\s+/g, '').toUpperCase();
          if (iban && !seenIban.has(iban)) { seenIban.add(iban); bankRows.push({ businessId: business.id, iban, title: b?.title?.trim() || null, isPrimary: false, docImage: null }); }
        }
      }
    } catch { /* banks formatı yanlışdırsa keç */ }
    // Heç bir primary təyin olunmayıbsa (əsas sənəddə IBAN tapılmadısa) ilk hesabı primary et.
    if (bankRows.length > 0 && !bankRows.some((r) => r.isPrimary)) bankRows[0].isPrimary = true;
    if (bankRows.length > 0) {
      await prisma.bankAccount.createMany({ data: bankRows }).catch(() => {});
    }

    res.status(201).json({
      success: true,
      business,
      autoApproved: autoApprove,
      ai: { ok: ai.ok, authorized: ai.authorized, reason: ai.error || ai.reason },
      bankAccountsFound: bankRows.length,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Biznesin redaktəsi. Telefon "yüngül" sahədir; lakin KYC kimliyi (ad/sahib/təsisçi)
// dəyişirsə təsdiq etibarsızlaşır → status yenidən PENDING-ə qaytarılır.
// Sübut sənədi/VÖEN/növ dəyişmək üçün biznes silinib yenidən yaradılmalıdır.
router.put('/me/businesses/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const biz = await prisma.business.findUnique({ where: { id } });
    if (!biz || biz.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const { name, ownerName, founderName, phone } = req.body;
    // KYC kimliyi dəyişdimi?
    const identityChanged =
      (name !== undefined && String(name).trim() !== biz.name) ||
      (ownerName !== undefined && String(ownerName).trim() !== biz.ownerName) ||
      (founderName !== undefined && String(founderName).trim() !== biz.founderName);
    const resetApproval = identityChanged && biz.status === 'APPROVED';
    const updated = await prisma.business.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(ownerName !== undefined && { ownerName: String(ownerName).trim() }),
        ...(founderName !== undefined && { founderName: String(founderName).trim() }),
        ...(phone !== undefined && { phone: phone?.trim() || null }),
        ...(resetApproval && { status: 'PENDING' as any }),
      },
    });
    // Təsdiq sıfırlandısa və başqa təsdiqli biznes qalmayıbsa — sellerVerified-i geri al.
    if (resetApproval) {
      const stillApproved = await prisma.business.count({ where: { userId: biz.userId, status: 'APPROVED' } });
      if (stillApproved === 0) {
        await prisma.user.update({ where: { id: biz.userId }, data: { sellerVerified: false } }).catch(() => {});
      }
    }
    res.json({ success: true, business: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Biznesi aktiv/deaktiv et
router.patch('/me/businesses/:id/active', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const biz = await prisma.business.findUnique({ where: { id } });
    if (!biz || biz.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const updated = await prisma.business.update({ where: { id }, data: { isActive: req.body.isActive === true } });
    res.json({ success: true, business: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/me/businesses/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const biz = await prisma.business.findUnique({ where: { id } });
    if (!biz || biz.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    await prisma.business.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==================== BANK HESABLARI ====================
async function ownsBiz(businessId: number, userId: number) {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { userId: true } });
  return b?.userId === userId;
}

router.post('/me/businesses/:id/banks', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const businessId = parseInt(req.params.id);
    if (!(await ownsBiz(businessId, req.adminId!))) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const { iban, title } = req.body;
    if (!iban?.trim()) { res.status(400).json({ success: false, message: 'IBAN tələb olunur' }); return; }
    const bank = await prisma.bankAccount.create({ data: { businessId, iban: iban.trim(), title: title?.trim() || null } });
    res.status(201).json({ success: true, bank });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.patch('/me/banks/:id/active', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const bank = await prisma.bankAccount.findUnique({ where: { id }, include: { business: true } });
    if (!bank || bank.business.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const updated = await prisma.bankAccount.update({ where: { id }, data: { isActive: req.body.isActive === true } });
    res.json({ success: true, bank: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/me/banks/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const bank = await prisma.bankAccount.findUnique({ where: { id }, include: { business: true } });
    if (!bank || bank.business.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    await prisma.bankAccount.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==================== OBYEKTLƏR ====================

router.post('/me/businesses/:id/objects', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const businessId = parseInt(req.params.id);
    if (!(await ownsBiz(businessId, req.adminId!))) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const { name, phone, address, city, latitude, longitude, activityAreas } = req.body;
    if (!name?.trim() || !address?.trim()) { res.status(400).json({ success: false, message: 'Obyekt adı və ünvanı tələb olunur' }); return; }
    const obj = await prisma.businessObject.create({
      data: {
        businessId,
        name: name.trim(),
        phone: phone?.trim() || null,
        address: address.trim(),
        city: city?.trim() || null,
        latitude: latitude != null ? parseFloat(latitude) : null,
        longitude: longitude != null ? parseFloat(longitude) : null,
        activityAreas: Array.isArray(activityAreas) ? activityAreas.filter((x: any) => typeof x === 'string') : [],
      },
    });
    res.status(201).json({ success: true, object: obj });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

async function ownsObject(objectId: number, userId: number) {
  const o = await prisma.businessObject.findUnique({ where: { id: objectId }, include: { business: { select: { userId: true } } } });
  return o && o.business.userId === userId ? o : null;
}

router.put('/me/objects/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (!(await ownsObject(id, req.adminId!))) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const { name, phone, address, city, activityAreas } = req.body;
    const updated = await prisma.businessObject.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(phone !== undefined && { phone: phone?.trim() || null }),
        ...(address !== undefined && { address: String(address).trim() }),
        ...(city !== undefined && { city: city?.trim() || null }),
        ...(activityAreas !== undefined && { activityAreas: Array.isArray(activityAreas) ? activityAreas.filter((x: any) => typeof x === 'string') : [] }),
      },
    });
    res.json({ success: true, object: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.patch('/me/objects/:id/active', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (!(await ownsObject(id, req.adminId!))) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const updated = await prisma.businessObject.update({ where: { id }, data: { isActive: req.body.isActive === true } });
    res.json({ success: true, object: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/me/objects/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (!(await ownsObject(id, req.adminId!))) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    await prisma.businessObject.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==================== SƏLAHİYYƏT VERMƏ (üzvlər) ====================

// Başqa istifadəçiyə (public ID ilə) biznesin/obyektin idarəsini ver.
router.post('/me/businesses/:id/members', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const businessId = parseInt(req.params.id);
    if (!(await ownsBiz(businessId, req.adminId!))) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const { publicId, objectId } = req.body;
    if (!publicId?.trim()) { res.status(400).json({ success: false, message: 'İstifadəçi ID-si tələb olunur' }); return; }
    const target = await prisma.user.findUnique({ where: { publicId: publicId.trim() }, select: { id: true } });
    if (!target) { res.status(404).json({ success: false, message: 'Bu ID ilə istifadəçi tapılmadı' }); return; }
    if (target.id === req.adminId) { res.status(400).json({ success: false, message: 'Özünüzü əlavə edə bilməzsiniz' }); return; }
    // objectId verilibsə bu biznesə aid olmalıdır
    let objId: number | null = null;
    if (objectId) {
      const o = await prisma.businessObject.findUnique({ where: { id: parseInt(String(objectId)) }, select: { businessId: true } });
      if (!o || o.businessId !== businessId) { res.status(400).json({ success: false, message: 'Obyekt bu biznesə aid deyil' }); return; }
      objId = parseInt(String(objectId));
    }
    const member = await prisma.businessMember.create({
      data: { businessId, userId: target.id, objectId: objId },
      include: { user: { select: { id: true, name: true, publicId: true } }, object: { select: { id: true, name: true } } },
    });
    await prisma.notification.create({
      data: { userId: target.id, type: 'SYSTEM', title: 'Biznes idarəetməsi', body: 'Sizə bir biznes/obyektin idarəsi verildi.', link: '/business/managed' },
    }).catch(() => {});
    res.status(201).json({ success: true, member });
  } catch (error: any) {
    if (error?.code === 'P2002') { res.status(400).json({ success: false, message: 'Bu istifadəçi artıq əlavə edilib' }); return; }
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/me/members/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const m = await prisma.businessMember.findUnique({ where: { id }, include: { business: { select: { userId: true } } } });
    if (!m || m.business.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    await prisma.businessMember.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Mənə həvalə olunmuş biznes/obyektlər (idarəçi olduğum)
router.get('/me/managed', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const memberships = await prisma.businessMember.findMany({
      where: { userId: req.adminId },
      include: {
        business: { select: { id: true, name: true, isActive: true, status: true } },
        object: { select: { id: true, name: true } },
      },
    });
    res.json({ success: true, memberships });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==================== SATIŞ PƏNCƏRƏSİ (sifarişlər) ====================
// Biznesin (və ya konkret obyektin) sifarişləri. Sahibi və ya səlahiyyətli üzv görə bilər.
router.get('/me/businesses/:id/orders', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const businessId = parseInt(req.params.id);
    const objectId = req.query.objectId ? parseInt(String(req.query.objectId)) : null;
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { userId: true } });
    if (!biz) { res.status(404).json({ success: false, message: 'Biznes tapılmadı' }); return; }

    // İcazə: sahibi, ya da bu biznes/obyekt üçün üzv.
    let allowed = biz.userId === req.adminId;
    if (!allowed) {
      const mem = await prisma.businessMember.findFirst({
        where: { businessId, userId: req.adminId, OR: [{ objectId: null }, ...(objectId ? [{ objectId }] : [])] },
      });
      allowed = !!mem;
    }
    if (!allowed) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }

    // Sifarişlər = içində bu biznesə/obyektə aid elan olan order-lər.
    const orders = await prisma.order.findMany({
      where: {
        items: {
          some: {
            listing: objectId ? { businessObjectId: objectId } : { businessId },
          },
        },
      },
      include: {
        items: { include: { listing: { select: { id: true, title: true, businessObjectId: true } } } },
        buyer: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ success: true, orders });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Biznes sifarişinin statusunu dəyiş (sahibi VƏ YA səlahiyyətli üzv).
// Fərdi satıcı axını (cart.ts) ilə eyni state machine — geriyə/qanunsuz keçidlər qadağandır.
const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const ORDER_TRANSITIONS: Record<string, string[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};
router.put('/me/business-orders/:orderId/status', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const status = String(req.body?.status || '').toUpperCase();
    if (!ORDER_STATUSES.includes(status)) { res.status(400).json({ success: false, message: 'Yanlış status' }); return; }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { listing: { select: { businessId: true, businessObjectId: true } } } } },
    });
    if (!order) { res.status(404).json({ success: false, message: 'Sifariş tapılmadı' }); return; }

    // State machine: yalnız icazəli keçidlər (PENDING→CONFIRMED→SHIPPED→DELIVERED, ləğv).
    const allowedNext = ORDER_TRANSITIONS[order.status] || [];
    if (!allowedNext.includes(status)) {
      res.status(400).json({ success: false, message: `${order.status} → ${status} keçidi icazə verilmir` }); return;
    }
    // Kartla ödənilən sifarişi ödəniş təsdiqlənmədən göndərmək olmaz.
    if (order.paymentMethod === 'CARD' && order.paymentStatus !== 'PAID' && (status === 'SHIPPED' || status === 'DELIVERED')) {
      res.status(400).json({ success: false, message: 'Ödəniş təsdiqlənməyib — sifarişi göndərmək olmaz' }); return;
    }

    // Order-dəki elanların biznes/obyektləri
    const bizIds = Array.from(new Set(order.items.map((i) => i.listing.businessId).filter((x): x is number => !!x)));
    const objIds = Array.from(new Set(order.items.map((i) => i.listing.businessObjectId).filter((x): x is number => !!x)));
    if (bizIds.length === 0) { res.status(400).json({ success: false, message: 'Bu sifariş biznesə aid deyil' }); return; }

    // İcazə: bu bizneslərdən birinin sahibi, ya da uyğun üzv
    const owns = await prisma.business.count({ where: { id: { in: bizIds }, userId: req.adminId } });
    let allowed = owns > 0;
    if (!allowed) {
      const mem = await prisma.businessMember.count({
        where: { userId: req.adminId, businessId: { in: bizIds }, OR: [{ objectId: null }, { objectId: { in: objIds } }] },
      });
      allowed = mem > 0;
    }
    if (!allowed) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }

    // CANCELLED → stoku geri qaytar
    if (status === 'CANCELLED' && order.status !== 'CANCELLED') {
      for (const it of order.items) {
        try { await prisma.listing.update({ where: { id: it.listingId }, data: { stock: { increment: it.quantity } } }); } catch { /* silinmiş ola bilər */ }
      }
    }
    const updated = await prisma.order.update({ where: { id: orderId }, data: { status: status as any } });
    await prisma.notification.create({
      data: { userId: order.buyerId, type: 'ORDER', title: 'Sifariş statusu', body: `Sifariş #${order.id}: ${status}`, link: `/orders/${order.id}` },
    }).catch(() => {});
    res.json({ success: true, order: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==================== ADMIN: BİZNES TƏSDİQİ ====================

router.get('/admin/businesses', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query;
    const where: any = {};
    if (status && status !== 'all') where.status = status;
    const businesses = await prisma.business.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, phone: true, publicId: true } },
        objects: true,
        banks: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, businesses });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.put('/admin/businesses/:id/approve', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const biz = await prisma.business.update({
      where: { id }, data: { status: 'APPROVED', reviewedAt: new Date(), rejectionReason: null },
    });
    await prisma.user.update({ where: { id: biz.userId }, data: { sellerVerified: true, sellerVerifiedAt: new Date() } });
    await prisma.notification.create({
      data: { userId: biz.userId, type: 'SYSTEM', title: 'Biznes təsdiqləndi', body: `"${biz.name}" təsdiqləndi — artıq kartla satış mümkündür.`, link: '/business' },
    }).catch(() => {});
    res.json({ success: true, business: biz });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.put('/admin/businesses/:id/reject', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    if (!reason?.trim()) { res.status(400).json({ success: false, message: 'Səbəb tələb olunur' }); return; }
    const biz = await prisma.business.update({
      where: { id }, data: { status: 'REJECTED', reviewedAt: new Date(), rejectionReason: reason.trim() },
    });
    const stillApproved = await prisma.business.count({ where: { userId: biz.userId, status: 'APPROVED' } });
    if (stillApproved === 0) await prisma.user.update({ where: { id: biz.userId }, data: { sellerVerified: false } });
    await prisma.notification.create({
      data: { userId: biz.userId, type: 'SYSTEM', title: 'Biznes rədd edildi', body: `"${biz.name}": ${reason.trim()}`, link: '/business' },
    }).catch(() => {});
    res.json({ success: true, business: biz });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
