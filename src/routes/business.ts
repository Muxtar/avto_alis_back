import { Router, Request, Response } from 'express';
import { recordSettlement } from '../services/settlement';
import { validateIban } from '../services/iban';
import { Prisma, PrismaClient } from '@prisma/client';
import { adminAuth, requirePermission, AuthRequest } from '../middleware/auth';
import { upload, docUpload, UPLOADS_DIR } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';
import { verifyBusinessAI, BusinessDoc, extractBankAccounts, extractBusinessInfo, nameOverlapScore } from '../services/credentialAI';
import fs from 'fs';
import path from 'path';

// Saxlanmış sənəd faylının (filename) diskdəki tam yolu.
function storedPath(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const p = path.join(UPLOADS_DIR, filename);
  return fs.existsSync(p) ? p : null;
}

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
      res.status(403).json({ success: false, code: 'ID_NOT_VERIFIED', message: 'Biznes yaratmaq üçün əvvəlcə profil səhifəsində kimliyinizi Veriff ilə təsdiqləyin.' });
      return;
    }
    // Kimlik profildə edilib (Veriff/AI) — biznesdə təkrar kimlik+selfie istənilmir.
    // (Veriff test rejimində APPROVED-a çatmaya bilər — status set olması kifayətdir.)
    const faceOk = (me.faceMatchScore ?? 0) > 0.5 || me.idAiFaceMatch === true || (me.idAiFaceScore ?? 0) > 0.5;
    const identityReusable = !!me.idVerifyStatus || (!!me.idCardImage && !!me.selfieImage && faceOk);
    const { proofType, name, voen, ownerName, founderName, phone, banks } = req.body;
    // Şirkət məlumatları sənəddən oxunur. Təsisçi sənəddə olmaya bilər — sahibə bərabər götürülür.
    const founder = (founderName?.trim() || ownerName?.trim() || '');
    // Opsional veb-sayt / sosial linklər (boşdursa null)
    const link = (v: any) => { const s = String(v || '').trim(); return s ? s.slice(0, 300) : null; };
    const website = link(req.body.website), instagram = link(req.body.instagram), facebook = link(req.body.facebook), tiktok = link(req.body.tiktok), youtube = link(req.body.youtube), linkedin = link(req.body.linkedin);
    // Şirkət adı/VÖEN/sahibi burada TƏLƏB OLUNMUR — admin sənədlərdən doldurur.
    // İstifadəçi yalnız sənədləri (+ əlaqə/sosial) göndərir → biznes PENDING olur.
    // VÖEN varsa növü son rəqəmindən təyin olunur (1=hüquqi, 2=fiziki),
    // yoxdursa default PHYSICAL — admin sonradan dəyişə bilər.
    const voenDigits = (voen || '').replace(/\D/g, '');
    const kind: 'LEGAL' | 'PHYSICAL' = voenDigits.slice(-1) === '1' ? 'LEGAL' : 'PHYSICAL';
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

    // Bank sənədləri (bir neçə ola bilər) — istifadəçi yükləyir, IBAN-ı ADMIN
    // paneldən sənədə baxıb daxil edir (AI ilə oxuma YOXDUR).
    const bankFiles = filesOf(req, 'bankDocImage');
    if (bankFiles.length === 0) { res.status(400).json({ success: false, message: 'Ən azı bir bank hesabı sənədi tələb olunur' }); return; }
    const bankDocImages = bankFiles.map((f) => f.filename);

    // ---- AI yoxlaması BURADA edilmir (avtomatik yox) ----
    // Sənədlərin AI yoxlaması admin panelin İSTƏYİ ilə (on-demand) aparılır:
    // admin isterse «AI yoxla» düyməsi ilə analiz alır, istəməsə sənədə əl ilə
    // baxıb təsdiqləyir. Biznes həmişə PENDING yaradılır → admin panelə düşür.
    const business = await prisma.business.create({
      data: {
        userId: req.adminId!,
        kind, proofType,
        name: name?.trim() || '', voen: voen?.trim() || '',
        ownerName: ownerName?.trim() || '', founderName: founder,
        phone: phone?.trim() || null,
        website, instagram, facebook, tiktok, youtube, linkedin,
        taxDocImage, companyDocImage, powerOfAttorneyImage,
        bankDocImage: bankDocImages[0] || null, bankDocImages,
        idCardImage, selfieImage,
        // AI sahələri boş — admin paneldə «AI yoxla» ilə doldurulur.
        aiFraudSignals: [],
        autoApproved: false,
        // status: PENDING (default) — admin təsdiq edənə qədər.
      },
    });

    // Admin panelə düşdü — istifadəçiyə "yoxlamaya göndərildi" bildirişi.
    await prisma.notification.create({
      data: { userId: req.adminId!, type: 'SYSTEM', title: 'Biznes yoxlamaya göndərildi', body: `Biznes müraciətiniz admin təsdiqini gözləyir. Təsdiqdən sonra kartla satış mümkün olacaq.`, link: '/business' },
    }).catch(() => {});

    // Bank hesabları: yalnız əl ilə göndərilənlər (adətən boş — admin sonradan
    // sənədə baxıb IBAN əlavə edir). AI ilə oxuma yoxdur.
    const bankRows: { businessId: number; iban: string; title: string | null; isPrimary: boolean; docImage: string | null }[] = [];
    const seenIban = new Set<string>();
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
      autoApproved: false,   // avtomatik təsdiq yoxdur
      pending: true,         // admin təsdiqini gözləyir
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
    // Opsional link sahələri (verilibsə yenilə; boş sətir → null)
    const linkFields = ['website', 'instagram', 'facebook', 'tiktok', 'youtube', 'linkedin'] as const;
    const linkData: any = {};
    for (const f of linkFields) if (req.body[f] !== undefined) { const s = String(req.body[f] || '').trim(); linkData[f] = s ? s.slice(0, 300) : null; }
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
        ...linkData,
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

// Biznes redaktəsi — sənəd (şirkət/vergi + bank) yeniləmə ilə birlikdə (multipart).
// Ad/sahib/təsisçi VƏ YA hər hansı sənəd dəyişsə → biznes yenidən admin təsdiqinə (PENDING).
router.post('/me/businesses/:id/edit', adminAuth, docFields, processImages, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const biz = await prisma.business.findUnique({ where: { id } });
    if (!biz || biz.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const { name, ownerName, founderName, phone } = req.body;
    const linkFields = ['website', 'instagram', 'facebook', 'tiktok', 'youtube', 'linkedin'] as const;
    const linkData: any = {};
    for (const f of linkFields) if (req.body[f] !== undefined) { const s = String(req.body[f] || '').trim(); linkData[f] = s ? s.slice(0, 300) : null; }
    // Yeni sənədlər (verilibsə)
    const newTax = fileName(req, 'taxDocImage');
    const newCompany = fileName(req, 'companyDocImage');
    const newPoa = fileName(req, 'powerOfAttorneyImage');
    const bankFiles = filesOf(req, 'bankDocImage');
    const newBankDocs = bankFiles.map((f) => f.filename);
    const docsChanged = !!(newTax || newCompany || newPoa || newBankDocs.length);
    const identityChanged =
      (name !== undefined && String(name).trim() !== biz.name) ||
      (ownerName !== undefined && String(ownerName).trim() !== biz.ownerName) ||
      (founderName !== undefined && String(founderName).trim() !== biz.founderName);
    const resetApproval = (identityChanged || docsChanged) && biz.status === 'APPROVED';
    const updated = await prisma.business.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(ownerName !== undefined && { ownerName: String(ownerName).trim() }),
        ...(founderName !== undefined && { founderName: String(founderName).trim() }),
        ...(phone !== undefined && { phone: phone?.trim() || null }),
        ...linkData,
        ...(newTax && { taxDocImage: newTax }),
        ...(newCompany && { companyDocImage: newCompany }),
        ...(newPoa && { powerOfAttorneyImage: newPoa }),
        ...(newBankDocs.length && { bankDocImage: newBankDocs[0], bankDocImages: newBankDocs }),
        ...(resetApproval && { status: 'PENDING' as any }),
      },
    });
    if (resetApproval) {
      const stillApproved = await prisma.business.count({ where: { userId: biz.userId, status: 'APPROVED' } });
      if (stillApproved === 0) await prisma.user.update({ where: { id: biz.userId }, data: { sellerVerified: false } }).catch(() => {});
    }
    res.json({ success: true, business: updated, reApproval: resetApproval });
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
    // Səhv IBAN → köçürmə bankda qayıdır və hesablaşma pozulur. Yazılan anda yoxlanır.
    const chk = validateIban(iban);
    if (!chk.ok) { res.status(400).json({ success: false, message: chk.error }); return; }
    const bank = await prisma.bankAccount.create({ data: { businessId, iban: chk.iban, title: title?.trim() || null } });
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

// Ödəniş üçün əsas IBAN seç — bu hesabı primary et, digərlərini primary-dən çıxar.
router.patch('/me/banks/:id/primary', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const bank = await prisma.bankAccount.findUnique({ where: { id }, include: { business: true } });
    if (!bank || bank.business.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    await prisma.$transaction([
      prisma.bankAccount.updateMany({ where: { businessId: bank.businessId }, data: { isPrimary: false } }),
      prisma.bankAccount.update({ where: { id }, data: { isPrimary: true, isActive: true } }),
    ]);
    res.json({ success: true });
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
    // Silinən primary idisə — qalan aktiv hesablardan birini əsas et.
    if (bank.isPrimary) {
      const next = await prisma.bankAccount.findFirst({ where: { businessId: bank.businessId }, orderBy: { id: 'asc' } });
      if (next) await prisma.bankAccount.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==================== OBYEKTLƏR ====================

/**
 * OBYEKTİN ƏLAQƏ NÖMRƏSİNİN YOXLANIŞI.
 *
 * Obyektə yazılan nömrə həmin obyektin elanlarına gələn bütün mesajları
 * qəbul edir (messages.ts-dəki yönləndirmə). Ona görə iki şərt vacibdir:
 *
 *   1) Nömrə saytda QEYDİYYATLI olmalıdır — əks halda mesajlar səssizcə
 *      biznes sahibinə düşür və heç kim səbəbini bilmir.
 *   2) Nömrə sahibi həmin biznesin SAHİBİ və ya ÜZVÜ olmalıdır — əks halda
 *      tanımadığın bir adamın nömrəsini yazıb bütün mesajlarını onun
 *      poçtuna yönləndirmək olardı (onun xəbəri olmadan).
 *
 * Uyğunlaşdırma son 9 rəqəm üzrədir — format fərqi (+994 / 0 / boşluq)
 * problem yaratmasın.
 */
async function validateObjectPhone(businessId: number, phone: string | null | undefined):
  Promise<{ ok: true; userId: number | null } | { ok: false; message: string }> {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return { ok: true, userId: null };          // nömrə boş — icazəlidir
  const tail9 = digits.slice(-9);
  if (tail9.length < 7) return { ok: false, message: 'Telefon nömrəsi natamamdır' };

  const rows = await prisma.$queryRaw<{ id: number }[]>(
    Prisma.sql`SELECT id FROM "User"
               WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = ${tail9}
               LIMIT 1`,
  );
  if (!rows.length) {
    return { ok: false, message: 'Bu nömrə saytda qeydiyyatdan keçməyib. Obyektin əlaqə şəxsi əvvəlcə qeydiyyatdan keçməlidir.' };
  }
  const userId = rows[0].id;

  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { userId: true } });
  if (biz?.userId === userId) return { ok: true, userId };   // biznesin sahibi

  const member = await prisma.businessMember.findFirst({
    where: { businessId, userId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!member) {
    return { ok: false, message: 'Bu nömrənin sahibi biznesin işçisi deyil. Əvvəlcə onu işçi kimi əlavə edin.' };
  }
  return { ok: true, userId };
}

router.post('/me/businesses/:id/objects', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const businessId = parseInt(req.params.id);
    if (!(await ownsBiz(businessId, req.adminId!))) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const { name, phone, address, city, latitude, longitude, activityAreas } = req.body;
    if (!name?.trim() || !address?.trim()) { res.status(400).json({ success: false, message: 'Obyekt adı və ünvanı tələb olunur' }); return; }
    const chk = await validateObjectPhone(businessId, phone);
    if (!chk.ok) { res.status(400).json({ success: false, message: chk.message }); return; }
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
    const owned = await ownsObject(id, req.adminId!);
    if (!owned) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const { name, phone, address, city, latitude, longitude, activityAreas } = req.body;
    if (phone !== undefined) {
      const chk = await validateObjectPhone(owned.businessId, phone);
      if (!chk.ok) { res.status(400).json({ success: false, message: chk.message }); return; }
    }
    const updated = await prisma.businessObject.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(phone !== undefined && { phone: phone?.trim() || null }),
        ...(address !== undefined && { address: String(address).trim() }),
        ...(city !== undefined && { city: city?.trim() || null }),
        ...(latitude !== undefined && { latitude: latitude != null ? parseFloat(latitude) : null }),
        ...(longitude !== undefined && { longitude: longitude != null ? parseFloat(longitude) : null }),
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
    // Eyni biznesdə mövcud üzvlük/sorğu varsa təkrar yaratma.
    const existing = await prisma.businessMember.findFirst({ where: { businessId, userId: target.id } });
    if (existing) { res.status(400).json({ success: false, message: 'Bu istifadəçi ilə artıq üzvlük/sorğu mövcuddur' }); return; }

    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
    // Dəvət — istifadəçi qəbul edənə qədər PENDING_USER statusunda qalır.
    const member = await prisma.businessMember.create({
      data: {
        businessId, userId: target.id, objectId: objId,
        status: 'PENDING_USER',
        canSell: req.body.canSell === undefined ? true : !!req.body.canSell,
        canBuy: !!req.body.canBuy,
      },
      include: { user: { select: { id: true, name: true, publicId: true } }, object: { select: { id: true, name: true } } },
    });
    await prisma.notification.create({
      data: { userId: target.id, type: 'SYSTEM', title: 'İşçi dəvəti', body: `«${biz?.name || 'Biznes'}» sizi işçi kimi əlavə etmək istəyir. Profilinizdən qəbul edin.`, link: '/profile' },
    }).catch(() => {});
    res.status(201).json({ success: true, member });
  } catch (error: any) {
    if (error?.code === 'P2002') { res.status(400).json({ success: false, message: 'Bu istifadəçi artıq əlavə edilib' }); return; }
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==================== İŞÇİLİK (sorğu/qəbul axını) ====================

// Biznes axtarışı — ad və ya VÖEN ilə (işçi öz şirkətini tapmaq üçün).
router.get('/businesses/search', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) { res.json({ success: true, businesses: [] }); return; }
    const businesses = await prisma.business.findMany({
      where: {
        status: 'APPROVED', isActive: true,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { voen: { contains: q } },
        ],
      },
      select: { id: true, name: true, voen: true, userId: true, _count: { select: { objects: true } } },
      take: 10,
    });
    res.json({ success: true, businesses });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// İstifadəçi → biznesə "mən sizin işçinizəm" sorğusu göndərir.
router.post('/businesses/:id/join-request', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const businessId = parseInt(req.params.id);
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { userId: true, name: true, status: true, isActive: true } });
    if (!biz || biz.status !== 'APPROVED' || !biz.isActive) { res.status(404).json({ success: false, message: 'Biznes tapılmadı və ya aktiv deyil' }); return; }
    if (biz.userId === req.adminId) { res.status(400).json({ success: false, message: 'Öz biznesinizə sorğu göndərə bilməzsiniz' }); return; }
    const existing = await prisma.businessMember.findFirst({ where: { businessId, userId: req.adminId! } });
    if (existing) {
      const msg = existing.status === 'ACTIVE' ? 'Artıq bu biznesin işçisisiniz' : 'Bu biznesə artıq sorğu/dəvət mövcuddur';
      res.status(400).json({ success: false, message: msg }); return;
    }
    // İşçi sorğusu — sahib qəbul edənə qədər səlahiyyətsiz.
    const member = await prisma.businessMember.create({
      data: { businessId, userId: req.adminId!, status: 'PENDING_BUSINESS', canSell: false, canBuy: false },
    });
    const me = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { name: true } });
    await prisma.notification.create({
      data: { userId: biz.userId, type: 'SYSTEM', title: 'Yeni işçi sorğusu', body: `${me?.name || 'Bir istifadəçi'} «${biz.name}» biznesinin işçisi olduğunu bildirir. Biznes səhifəsindən təsdiqləyin.`, link: '/business' },
    }).catch(() => {});
    res.status(201).json({ success: true, member });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Sahib: işçi sorğusunu qəbul/rədd et və ya səlahiyyətləri dəyiş.
router.put('/me/businesses/:id/members/:memberId', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const businessId = parseInt(req.params.id);
    if (!(await ownsBiz(businessId, req.adminId!))) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const memberId = parseInt(req.params.memberId);
    const m = await prisma.businessMember.findUnique({ where: { id: memberId }, include: { business: { select: { name: true } } } });
    if (!m || m.businessId !== businessId) { res.status(404).json({ success: false, message: 'Üzv tapılmadı' }); return; }

    const action = String(req.body.action || '');
    if (action === 'reject') {
      await prisma.businessMember.delete({ where: { id: memberId } });
      res.json({ success: true, removed: true }); return;
    }

    const data: any = {};
    if (action === 'accept') {
      if (m.status !== 'PENDING_BUSINESS') { res.status(400).json({ success: false, message: 'Bu sorğu təsdiq gözləmir' }); return; }
      data.status = 'ACTIVE';
      await prisma.notification.create({
        data: { userId: m.userId, type: 'SYSTEM', title: 'İşçi sorğusu qəbul edildi', body: `«${m.business.name}» sizi rəsmi işçi kimi təsdiqlədi.`, link: '/profile' },
      }).catch(() => {});
    }
    // Səlahiyyət dəyişiklikləri (yalnız sahib):
    if (req.body.canSell !== undefined) data.canSell = !!req.body.canSell;
    if (req.body.canBuy !== undefined) data.canBuy = !!req.body.canBuy;
    if (req.body.objectId !== undefined) {
      if (req.body.objectId === null || req.body.objectId === '') data.objectId = null;
      else {
        const o = await prisma.businessObject.findUnique({ where: { id: parseInt(String(req.body.objectId)) }, select: { businessId: true } });
        if (!o || o.businessId !== businessId) { res.status(400).json({ success: false, message: 'Obyekt bu biznesə aid deyil' }); return; }
        data.objectId = parseInt(String(req.body.objectId));
      }
    }
    if (Object.keys(data).length === 0) { res.status(400).json({ success: false, message: 'Dəyişiklik yoxdur' }); return; }

    const updated = await prisma.businessMember.update({
      where: { id: memberId }, data,
      include: { user: { select: { id: true, name: true, publicId: true } }, object: { select: { id: true, name: true } } },
    });
    res.json({ success: true, member: updated });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// İstifadəçi: mənim işçiliklərim (bütün statuslar).
router.get('/me/employment', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const memberships = await prisma.businessMember.findMany({
      where: { userId: req.adminId! },
      include: {
        // objects — "bütün biznes" üzvlüyündə alış üçün obyekt seçiminə lazımdır.
        business: { select: { id: true, name: true, voen: true, objects: { select: { id: true, name: true }, where: { isActive: true } } } },
        object: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, memberships });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// İstifadəçi: dəvətə cavab ver (accept/reject) və ya işdən ayrıl (leave).
router.put('/me/employment/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const m = await prisma.businessMember.findUnique({ where: { id }, include: { business: { select: { userId: true, name: true } } } });
    if (!m || m.userId !== req.adminId) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    const action = String(req.body.action || '');

    if (action === 'accept') {
      if (m.status !== 'PENDING_USER') { res.status(400).json({ success: false, message: 'Bu dəvət təsdiq gözləmir' }); return; }
      const updated = await prisma.businessMember.update({ where: { id }, data: { status: 'ACTIVE' } });
      const me = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { name: true } });
      await prisma.notification.create({
        data: { userId: m.business.userId, type: 'SYSTEM', title: 'İşçi dəvəti qəbul edildi', body: `${me?.name || 'İstifadəçi'} «${m.business.name}» işçi dəvətini qəbul etdi.`, link: '/business' },
      }).catch(() => {});
      res.json({ success: true, member: updated }); return;
    }
    if (action === 'reject' || action === 'leave') {
      await prisma.businessMember.delete({ where: { id } });
      if (action === 'leave' && m.status === 'ACTIVE') {
        const me = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { name: true } });
        await prisma.notification.create({
          data: { userId: m.business.userId, type: 'SYSTEM', title: 'İşçi ayrıldı', body: `${me?.name || 'İstifadəçi'} «${m.business.name}» biznesindən ayrıldı.`, link: '/business' },
        }).catch(() => {});
      }
      res.json({ success: true, removed: true }); return;
    }
    res.status(400).json({ success: false, message: 'Yanlış əməliyyat' });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
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
      where: { userId: req.adminId, status: 'ACTIVE' },
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
        where: { businessId, userId: req.adminId, status: 'ACTIVE', canSell: true, OR: [{ objectId: null }, ...(objectId ? [{ objectId }] : [])] },
      });
      allowed = !!mem;
    }
    if (!allowed) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }

    // Sifarişlər = içində bu biznesə/obyektə aid elan olan order-lər.
    const orders = await prisma.order.findMany({
      where: {
        // Ödənilməmiş KART sifarişi görünmür (uğursuz ödənişdə sifariş yaranmamış sayılır).
        OR: [{ paymentMethod: { not: 'CARD' } }, { paymentStatus: 'PAID' }],
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
        where: { userId: req.adminId, businessId: { in: bizIds }, status: 'ACTIVE', canSell: true, OR: [{ objectId: null }, { objectId: { in: objIds } }] },
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

    // Satıcı hesablaşması — status dəyişdi. BU ÇAĞIRIŞ OLMADAN biznesin
    // "çatdırıldı" etdiyi sifariş ledger-də PENDING qalır və heç vaxt
    // ödəniləcək (AVAILABLE) balansa keçmirdi. Alıcı və admin yollarında
    // bu çağırış var idi, biznes yolunda unudulmuşdu.
    await recordSettlement(orderId).catch(() => {});
    await prisma.notification.create({
      data: { userId: order.buyerId, type: 'ORDER', title: 'Sifariş statusu', body: `Sifariş #${order.id}: ${status}`, link: `/orders/${order.id}` },
    }).catch(() => {});
    res.json({ success: true, order: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==================== ADMIN: BİZNES TƏSDİQİ ====================

router.get('/admin/businesses', requirePermission('businesses'), async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query;
    const where: any = {};
    if (status && status !== 'all') where.status = status;
    const businesses = await prisma.business.findMany({
      where,
      include: {
        user: { select: {
          id: true, name: true, phone: true, publicId: true,
          // Yaradanın təsdiqlənmiş kimlik məlumatları — admin sənəddəki sahiblə
          // müqayisə etsin (ad uyğundurmu, doğru/yanlışdırmı və s.).
          idNumber: true, birthDate: true, gender: true, idVerifyStatus: true,
          idCardImage: true, selfieImage: true, idAiNameMatch: true, idAiFaceMatch: true,
        } },
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

router.put('/admin/businesses/:id/approve', requirePermission('businesses'), async (req: AuthRequest, res: Response) => {
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

router.put('/admin/businesses/:id/reject', requirePermission('businesses'), async (req: AuthRequest, res: Response) => {
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

// ── ADMIN: biznesi AI ilə YENİDƏN yoxla (saxlanmış sənədlər üzərində) ──
// AI bəzən işləmir/yanlış işləyir — admin istədiyi vaxt yenidən çağıra bilər.
router.post('/admin/businesses/:id/ai-recheck', requirePermission('businesses'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const biz = await prisma.business.findUnique({ where: { id }, include: { user: { select: { name: true } } } });
    if (!biz) { res.status(404).json({ success: false, message: 'Biznes tapılmadı' }); return; }
    const docs: BusinessDoc[] = [];
    if (biz.proofType === 'TAX_DOC') {
      const p = storedPath(biz.taxDocImage); if (p) docs.push({ label: 'Vergi qeydiyyatı sənədi', path: p });
    } else {
      const c = storedPath(biz.companyDocImage); if (c) docs.push({ label: 'Şirkət sənədi', path: c });
      const a = storedPath(biz.powerOfAttorneyImage); if (a) docs.push({ label: 'Etibarnamə', path: a });
    }
    if (!docs.length) { res.status(400).json({ success: false, message: 'Yoxlanacaq sənəd tapılmadı (fayllar diskdə yoxdur)' }); return; }
    const ai = await verifyBusinessAI(
      docs, biz.proofType as 'TAX_DOC' | 'POWER_OF_ATTORNEY',
      { name: biz.name, voen: biz.voen, ownerName: biz.ownerName, founderName: biz.founderName },
      (biz.user?.name || '').trim(),
    );
    const aiRec = ai.ok && ai.authorized && ai.documentValid && ai.voenMatch && ai.confidence >= 0.75 && ai.fraudSignals.length === 0;
    const updated = await prisma.business.update({
      where: { id },
      data: {
        aiAuthorized: ai.ok ? ai.authorized : null,
        aiVoenMatch: ai.ok ? ai.voenMatch : null,
        aiConfidence: ai.ok ? ai.confidence : null,
        aiFraudSignals: ai.fraudSignals,
        aiReason: ai.error ? ai.error : ai.reason,
        autoApproved: aiRec,
      },
    });
    res.json({ success: true, ai, aiRecommendsApprove: aiRec, business: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});


// ── VOEN / IBAN DUBLİKAT YOXLAMASI ────────────────────────────────────────
// Eyni VÖEN başqa bir biznesdə qeydiyyatdadırsa bu, saxtakarlıq əlamətidir:
// bir şirkət ikinci dəfə hesab açır, ya da kimsə başqasının sənədini işlədir.
// Admin yüzlərlə VÖEN-i əl ilə tutuşdurmasın deyə sistem özü tapır.
//
// Müqayisə YALNIZ rəqəmlər üzrədir — "1234567891" və "12345678-91" eynidir.
async function findVoenDuplicates(voen: string, exceptId: number) {
  const digits = String(voen || '').replace(/\D/g, '');
  if (digits.length < 6) return [];          // çox qısa → mənasız uyğunluq verir
  const all = await prisma.business.findMany({
    where: { id: { not: exceptId } },
    select: { id: true, name: true, voen: true, status: true, isActive: true, createdAt: true, userId: true },
    take: 2000,
  });
  return all
    .filter((b) => String(b.voen || '').replace(/\D/g, '') === digits)
    .map((b) => ({
      id: b.id, name: b.name, voen: b.voen, status: b.status,
      isActive: b.isActive, createdAt: b.createdAt, ownerUserId: b.userId,
    }));
}

// Eyni IBAN iki biznesdə → pul eyni hesaba gedir. Bu da yoxlanılır.
async function findIbanDuplicates(ibans: string[], exceptId: number) {
  const norm = ibans.map((i) => String(i || '').toUpperCase().replace(/[\s-]/g, '')).filter(Boolean);
  if (!norm.length) return [];
  const rows = await prisma.bankAccount.findMany({
    where: { businessId: { not: exceptId } },
    select: { iban: true, businessId: true, business: { select: { id: true, name: true, voen: true, status: true } } },
    take: 3000,
  });
  const out: any[] = [];
  for (const r of rows) {
    const ri = String(r.iban || '').toUpperCase().replace(/[\s-]/g, '');
    if (norm.includes(ri) && r.business) {
      out.push({ iban: r.iban, id: r.business.id, name: r.business.name, voen: r.business.voen, status: r.business.status });
    }
  }
  return out;
}

// Admin VÖEN-i əl ilə yazanda da canlı yoxlasın deyə ayrıca endpoint.
router.get('/admin/businesses/:id/voen-check', requirePermission('businesses'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const voen = String(req.query.voen || '');
    const duplicates = await findVoenDuplicates(voen, id);
    res.json({ success: true, duplicates });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── ADMIN: sənəddən şirkət məlumatlarını AI ilə OXU (search) — saxlamır, qaytarır ──
// Admin nəticəni görüb istəsə redaktə formasına tətbiq edir.
router.post('/admin/businesses/:id/ai-extract', requirePermission('businesses'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const biz = await prisma.business.findUnique({ where: { id } });
    if (!biz) { res.status(404).json({ success: false, message: 'Biznes tapılmadı' }); return; }
    const docPath = storedPath(biz.proofType === 'TAX_DOC' ? biz.taxDocImage : biz.companyDocImage) || storedPath(biz.taxDocImage) || storedPath(biz.companyDocImage);
    if (!docPath) { res.status(400).json({ success: false, message: 'Oxunacaq sənəd tapılmadı' }); return; }
    const info = await extractBusinessInfo(docPath);
    // Bank sənəd(lər)indən IBAN-ları da oxu — admin eyni anda IBAN-ı doldursun.
    const bankDocs = (biz.bankDocImages?.length ? biz.bankDocImages : (biz.bankDocImage ? [biz.bankDocImage] : []));
    const ibans: string[] = [];
    for (const bd of bankDocs) {
      const p = storedPath(bd);
      if (!p) continue;
      try { const r = await extractBankAccounts(p); for (const a of r.accounts || []) if (a.iban) ibans.push(a.iban); } catch { /* keç */ }
    }
    const uniqIbans = [...new Set(ibans)];
    // AI-ın oxuduğu VÖEN/IBAN başqa biznesdə varmı? Admin təsdiqdən əvvəl görsün.
    const [voenDuplicates, ibanDuplicates] = await Promise.all([
      info?.voen ? findVoenDuplicates(info.voen, id) : Promise.resolve([]),
      findIbanDuplicates(uniqIbans, id),
    ]);
    res.json({ success: true, info, ibans: uniqIbans, voenDuplicates, ibanDuplicates });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── ADMIN: biznes məlumatlarını əl ilə redaktə et ──
router.put('/admin/businesses/:id', requirePermission('businesses'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body || {};
    const data: any = {};
    const s = (v: any): string | undefined => (typeof v === 'string' ? v.trim() : undefined);
    const name = s(b.name), voen = s(b.voen), ownerName = s(b.ownerName), founderName = s(b.founderName), phone = s(b.phone);
    // name/voen/ownerName/founderName MƏCBURİDİR (schema non-null) — yalnız boş
    // olmayanda yenilə. founderName boşdursa sahibə bərabər götürülür.
    if (name) data.name = name;
    if (voen) data.voen = voen;
    if (ownerName) data.ownerName = ownerName;
    const founder = founderName || ownerName; // boşdursa sahib
    if (founder) data.founderName = founder;
    if (phone !== undefined) data.phone = phone || null; // phone nullable-dır
    if (b.proofType === 'TAX_DOC' || b.proofType === 'POWER_OF_ATTORNEY') data.proofType = b.proofType;
    // Şəxs növü: açıq göndərilibsə onu, yoxsa VÖEN-in son rəqəmindən təyin et (1=hüquqi, 2=fiziki).
    if (b.kind === 'LEGAL' || b.kind === 'PHYSICAL') data.kind = b.kind;
    else if (voen) data.kind = voen.replace(/\D/g, '').slice(-1) === '1' ? 'LEGAL' : 'PHYSICAL';
    const biz = await prisma.business.update({ where: { id }, data });
    res.json({ success: true, business: biz });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── ADMIN: biznesə bank hesabı (IBAN) əlavə et — sənədə baxıb ──
router.post('/admin/businesses/:id/banks', requirePermission('businesses'), async (req: AuthRequest, res: Response) => {
  try {
    const businessId = parseInt(req.params.id);
    const iban = String(req.body?.iban || '').replace(/\s+/g, '').toUpperCase();
    const title = typeof req.body?.title === 'string' ? (req.body.title.trim() || null) : null;
    if (!iban) { res.status(400).json({ success: false, message: 'IBAN tələb olunur' }); return; }
    const chk = validateIban(iban);
    if (!chk.ok) { res.status(400).json({ success: false, message: chk.error }); return; }
    const count = await prisma.bankAccount.count({ where: { businessId } });
    const bank = await prisma.bankAccount.create({ data: { businessId, iban: chk.iban, title, isPrimary: count === 0, isActive: true } });
    res.json({ success: true, bank });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── ADMIN: bank hesabını redaktə et (IBAN/ad) ──
router.put('/admin/banks/:id', requirePermission('businesses'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const iban = String(req.body?.iban || '').replace(/\s+/g, '').toUpperCase();
    const title = typeof req.body?.title === 'string' ? (req.body.title.trim() || null) : undefined;
    if (!iban) { res.status(400).json({ success: false, message: 'IBAN tələb olunur' }); return; }
    const chk = validateIban(iban);
    if (!chk.ok) { res.status(400).json({ success: false, message: chk.error }); return; }
    const bank = await prisma.bankAccount.update({ where: { id }, data: { iban: chk.iban, ...(title !== undefined ? { title } : {}) } });
    res.json({ success: true, bank });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── ADMIN: bank hesabını sil ──
router.delete('/admin/banks/:id', requirePermission('businesses'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.bankAccount.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Biznesi sil — ona aid BÜTÜN obyektlər (FK Cascade) və elanlar (əl ilə) silinir.
// Listing.businessId/businessObjectId FK-ları SetNull olduğu üçün elanlar avtomatik
// silinmir; ona görə biznesə və onun obyektlərinə aid elanları əvvəlcə silirik.
router.delete('/admin/businesses/:id', requirePermission('businesses'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ success: false, message: 'Yanlış ID' }); return; }
    const objects = await prisma.businessObject.findMany({ where: { businessId: id }, select: { id: true } });
    const objectIds = objects.map((o) => o.id);
    const deletedListings = await prisma.$transaction(async (tx) => {
      const del = await tx.listing.deleteMany({
        where: { OR: [{ businessId: id }, ...(objectIds.length ? [{ businessObjectId: { in: objectIds } }] : [])] },
      });
      await tx.business.delete({ where: { id } }); // obyektlər FK Cascade ilə silinir
      return del.count;
    });
    res.json({ success: true, deletedListings, deletedObjects: objectIds.length });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Obyekti sil — ona aid BÜTÜN elanlar (əl ilə) silinir.
router.delete('/admin/objects/:id', requirePermission('businesses'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ success: false, message: 'Yanlış ID' }); return; }
    const deletedListings = await prisma.$transaction(async (tx) => {
      const del = await tx.listing.deleteMany({ where: { businessObjectId: id } });
      await tx.businessObject.delete({ where: { id } });
      return del.count;
    });
    res.json({ success: true, deletedListings });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
