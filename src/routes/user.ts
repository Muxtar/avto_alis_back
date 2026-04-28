import { Router, Response } from 'express';
import { PrismaClient, UserType } from '@prisma/client';
import { adminAuth, requireSellerVerified, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';
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
        workplaces: true, vehicles: true,
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

// Update my profile
router.put('/me', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { name, phone } = req.body;
    const user = await prisma.user.update({
      where: { id: req.adminId },
      data: {
        ...(name !== undefined && { name }),
        ...(phone !== undefined && { phone }),
      },
      select: { id: true, name: true, phone: true, email: true, type: true, role: true, verified: true, createdAt: true },
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

// Create my listing - requires seller verification + type match
router.post('/me/listings', requireSellerVerified, upload.array('images', 5), async (req: AuthRequest, res: Response) => {
  try {
    const { title, description, price, category, type, location, phone, condition, country, brand, stock, forVehicle, unit, unitValue, year, model, city, fuelType, paymentType } = req.body;

    if (type === 'PRODUCT' && req.userType !== UserType.PARTS_SELLER) {
      res.status(403).json({ success: false, message: 'Yalnız hissə satıcıları məhsul elanı verə bilər' }); return;
    }
    if (type === 'SERVICE' && req.userType !== UserType.MECHANIC) {
      res.status(403).json({ success: false, message: 'Yalnız ustalar xidmət elanı verə bilər' }); return;
    }

    const files = req.files as Express.Multer.File[];
    const images = files?.map((f) => f.filename) || [];

    const listing = await prisma.listing.create({
      data: {
        userId: req.adminId!, title, description, price: parseFloat(price),
        category, type, images, location: location || null, phone: phone || null,
        condition: condition || 'NEW',
        country: country || null,
        brand: brand || null,
        stock: stock ? parseInt(stock) : 1,
        forVehicle: forVehicle || null,
        unit: unit || null,
        unitValue: unitValue ? parseFloat(unitValue) : null,
        year: year ? parseInt(year) : null,
        model: model || null,
        city: city || null,
        fuelType: fuelType || null,
        paymentType: paymentType || null,
      },
    });
    res.status(201).json({ success: true, listing });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Update my listing
router.put('/me/listings/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.listing.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!existing || existing.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return;
    }
    const { title, description, price, category, type, location, phone, condition, country, brand, stock, forVehicle, unit, unitValue, year, model, city, fuelType, paymentType } = req.body;
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
      },
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
    // Dev modunda kodu dondur (test icin), production'da dondurme
    const isDev = process.env.NODE_ENV !== 'production';
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

export default router;
