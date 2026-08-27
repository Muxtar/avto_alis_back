import { Router, Response } from 'express';
import { PrismaClient, UserType } from '@prisma/client';
import { adminAuth, requirePermission, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';

const router = Router();
const prisma = new PrismaClient();

// Submit seller verification (KYC)
router.post('/seller/apply', adminAuth, upload.fields([
  { name: 'idImageFront', maxCount: 1 },
  { name: 'idImageBack', maxCount: 1 },
]), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const { taxId, iban, businessName } = req.body;
    const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
    const front = files?.idImageFront?.[0];
    const back = files?.idImageBack?.[0];

    if (!front) { res.status(400).json({ success: false, message: 'Şəxsiyyət vəsiqəsinin ön tərəfi tələb olunur' }); return; }
    if (!taxId || taxId.trim().length < 5) { res.status(400).json({ success: false, message: 'VÖEN tələb olunur' }); return; }

    const userId = req.adminId!;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { type: true, profileComplete: true, sellerVerified: true } });
    if (!user) { res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' }); return; }
    if (!user.profileComplete) { res.status(400).json({ success: false, message: 'Əvvəlcə profili tamamlayın' }); return; }
    if (user.type !== UserType.MECHANIC && user.type !== UserType.PARTS_SELLER) {
      res.status(403).json({ success: false, message: 'Yalnız usta və hissə satıcıları KYC üçün müraciət edə bilər' }); return;
    }
    if (user.sellerVerified) { res.status(400).json({ success: false, message: 'Satıcı kimliyiniz artıq təsdiqlənib' }); return; }

    const existing = await prisma.sellerVerification.findUnique({ where: { userId } });
    const data = {
      idImageFront: front.filename,
      idImageBack: back?.filename || null,
      taxId: taxId.trim(),
      iban: iban?.trim() || null,
      businessName: businessName?.trim() || null,
      status: 'PENDING' as const,
      rejectionReason: null,
      submittedAt: new Date(),
      reviewedAt: null,
      reviewedBy: null,
    };

    const application = existing
      ? await prisma.sellerVerification.update({ where: { userId }, data })
      : await prisma.sellerVerification.create({ data: { userId, ...data } });

    res.json({ success: true, application });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get current user's verification status
router.get('/seller/status', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.adminId! },
      select: {
        type: true,
        sellerVerified: true, sellerVerifiedAt: true,
        sellerApplication: true,
      },
    });
    if (!user) { res.status(404).json({ success: false }); return; }
    // M13 fix: only sellers (MECHANIC / PARTS_SELLER) need KYC.
    // Other types should get a 403 instead of an empty/null response.
    if (user.type !== UserType.MECHANIC && user.type !== UserType.PARTS_SELLER) {
      res.status(403).json({ success: false, message: 'Yalnız satıcı tipi KYC tələb edir' });
      return;
    }
    res.json({ success: true, ...user });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin: list all applications (with filter)
router.get('/admin/seller-applications', requirePermission('kyc'), async (req: AuthRequest, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const where = status ? { status: status as any } : {};
    const applications = await prisma.sellerVerification.findMany({
      where,
      orderBy: { submittedAt: 'desc' },
      include: { user: { select: { id: true, name: true, phone: true, type: true } } },
    });
    res.json({ success: true, applications });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin: approve
router.put('/admin/seller-applications/:id/approve', requirePermission('kyc'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const app = await prisma.sellerVerification.findUnique({ where: { id } });
    if (!app) { res.status(404).json({ success: false, message: 'Ərizə tapılmadı' }); return; }

    await prisma.$transaction([
      prisma.sellerVerification.update({
        where: { id },
        data: { status: 'APPROVED', reviewedAt: new Date(), reviewedBy: req.adminId, rejectionReason: null },
      }),
      prisma.user.update({
        where: { id: app.userId },
        data: { sellerVerified: true, sellerVerifiedAt: new Date() },
      }),
      prisma.notification.create({
        data: {
          userId: app.userId,
          type: 'SYSTEM',
          title: 'Satıcı kimliyi təsdiqləndi',
          body: 'Artıq elan verə və sorğulara təklif verə bilərsiniz.',
          link: '/account',
        },
      }),
    ]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin: reject
router.put('/admin/seller-applications/:id/reject', requirePermission('kyc'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    const app = await prisma.sellerVerification.findUnique({ where: { id } });
    if (!app) { res.status(404).json({ success: false, message: 'Ərizə tapılmadı' }); return; }

    await prisma.$transaction([
      prisma.sellerVerification.update({
        where: { id },
        data: { status: 'REJECTED', reviewedAt: new Date(), reviewedBy: req.adminId, rejectionReason: reason || null },
      }),
      prisma.notification.create({
        data: {
          userId: app.userId,
          type: 'SYSTEM',
          title: 'Satıcı kimliyi rədd edildi',
          body: reason || 'Ərizəniz rədd edildi. Yenidən müraciət edə bilərsiniz.',
          link: '/seller/apply',
        },
      }),
    ]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// KİMLİK YOXLAMASI (ƏL İLƏ) — admin `veriff_enabled` açarını söndürəndə işləyir.
//
// Veriff açıq olanda bu növbə boş qalır: nəticə birbaşa Veriff-dən gəlir və
// istifadəçi APPROVED olur. Veriff söndürüləndə (test mərhələsi) istifadəçi
// vəsiqənin ön/arxa şəklini və selfie-ni göndərir → `idVerifyStatus = PENDING`
// → admin burada şəkillərə baxıb təsdiqləyir və vəsiqədəki məlumatları yazır.
// ═══════════════════════════════════════════════════════════════════════════

const IDENTITY_FIELDS = {
  id: true, name: true, phone: true, type: true, createdAt: true,
  idVerifyStatus: true, idNumber: true, birthDate: true, gender: true,
  idCardImage: true, idCardBackImage: true,
  selfieImage: true, selfieRightImage: true, selfieLeftImage: true,
  faceMatchScore: true, idAiNameMatch: true, idAiNameScore: true,
  idAiFaceMatch: true, idAiFaceScore: true, idAiReason: true,
  veriffStatus: true,
} as const;

// Növbə: status üzrə süzülür (default — yoxlanılanlar).
router.get('/admin/identity', requirePermission('kyc'), async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const q = String(req.query.q || '').trim();
    const where: any = {};
    if (['PENDING', 'APPROVED', 'REJECTED'].includes(status)) where.idVerifyStatus = status;
    // Şəkil göndərməyənlər növbədə görünməməlidir.
    where.idCardImage = { not: null };
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { idNumber: { contains: q, mode: 'insensitive' } },
      ];
    }
    const users = await prisma.user.findMany({
      where, orderBy: { id: 'desc' }, take: 200, select: IDENTITY_FIELDS,
    });
    const counts = await prisma.user.groupBy({
      by: ['idVerifyStatus'],
      where: { idCardImage: { not: null } },
      _count: { _all: true },
    });
    res.json({
      success: true,
      users,
      counts: Object.fromEntries(counts.map((c) => [c.idVerifyStatus || 'NONE', c._count._all])),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Bir müraciətin tam məlumatı (şəkillərlə).
router.get('/admin/identity/:id', requirePermission('kyc'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const user = await prisma.user.findUnique({ where: { id }, select: IDENTITY_FIELDS });
    if (!user) { res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' }); return; }
    res.json({ success: true, user });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Təsdiq — admin vəsiqədəki məlumatları da yazır (ad, FIN, doğum tarixi, cins).
// Boş buraxılan sahə DƏYİŞMİR (istifadəçinin mövcud dəyəri qalır).
router.post('/admin/identity/:id/approve', requirePermission('kyc'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, idCardImage: true } });
    if (!user) { res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' }); return; }
    if (!user.idCardImage) {
      res.status(400).json({ success: false, message: 'Bu istifadəçi kimlik şəkli göndərməyib' }); return;
    }

    const name = String(req.body.name || '').trim();
    const idNumber = String(req.body.idNumber || '').trim();
    const birthDate = String(req.body.birthDate || '').trim();
    const gender = String(req.body.gender || '').trim();

    await prisma.user.update({
      where: { id },
      data: {
        idVerifyStatus: 'APPROVED',
        ...(name ? { name } : {}),
        ...(idNumber ? { idNumber } : {}),
        ...(/^\d{4}-\d{2}-\d{2}$/.test(birthDate) ? { birthDate: new Date(birthDate) } : {}),
        ...(gender ? { gender } : {}),
        idAiReason: 'Admin: gözlə yoxlanılıb və təsdiqlənib',
      },
    });
    await prisma.notification.create({
      data: {
        userId: id, type: 'SYSTEM', title: 'Kimlik təsdiqləndi ✅',
        body: 'Şəxsiyyətiniz yoxlanıldı və təsdiqləndi.', link: '/profile',
      },
    }).catch(() => {});
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Rədd — səbəb istifadəçiyə bildiriş kimi gedir, o yenidən göndərə bilər.
router.post('/admin/identity/:id/reject', requirePermission('kyc'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const reason = String(req.body.reason || '').trim();
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) { res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' }); return; }
    await prisma.user.update({
      where: { id },
      data: {
        idVerifyStatus: 'REJECTED',
        idAiReason: reason ? `Admin: rədd edildi — ${reason}` : 'Admin: rədd edildi',
      },
    });
    await prisma.notification.create({
      data: {
        userId: id, type: 'SYSTEM', title: 'Kimlik təsdiqi alınmadı',
        body: reason || 'Göndərdiyiniz şəkillər qəbul olunmadı. Yenidən cəhd edə bilərsiniz.',
        link: '/profile',
      },
    }).catch(() => {});
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
