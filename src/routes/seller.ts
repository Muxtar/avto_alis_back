import { Router, Response } from 'express';
import { PrismaClient, UserType } from '@prisma/client';
import { adminAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';

const router = Router();
const prisma = new PrismaClient();

// Submit seller verification (KYC)
router.post('/seller/apply', adminAuth, upload.fields([
  { name: 'idImageFront', maxCount: 1 },
  { name: 'idImageBack', maxCount: 1 },
]), async (req: AuthRequest, res: Response) => {
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
        sellerVerified: true, sellerVerifiedAt: true,
        sellerApplication: true,
      },
    });
    if (!user) { res.status(404).json({ success: false }); return; }
    res.json({ success: true, ...user });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin: list all applications (with filter)
router.get('/admin/seller-applications', requireAdmin, async (req: AuthRequest, res: Response) => {
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
router.put('/admin/seller-applications/:id/approve', requireAdmin, async (req: AuthRequest, res: Response) => {
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
router.put('/admin/seller-applications/:id/reject', requireAdmin, async (req: AuthRequest, res: Response) => {
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

export default router;
