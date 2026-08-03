import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, requirePermission, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

// Validate promo code (alici checkout'da kullanir)
router.post('/promo/validate', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { code, orderAmount } = req.body;
    if (!code) {
      res.status(400).json({ success: false, message: 'Promo kod tələb olunur' });
      return;
    }

    const promo = await prisma.promoCode.findUnique({ where: { code: code.toUpperCase() } });
    if (!promo || !promo.active) {
      res.status(404).json({ success: false, message: 'Promo kod tapılmadı və ya aktiv deyil' });
      return;
    }

    const now = new Date();
    if (promo.validFrom > now) {
      res.status(400).json({ success: false, message: 'Promo kod hələ aktiv deyil' });
      return;
    }
    if (promo.validUntil && promo.validUntil < now) {
      res.status(400).json({ success: false, message: 'Promo kodun vaxtı keçib' });
      return;
    }
    if (promo.usageLimit && promo.usageCount >= promo.usageLimit) {
      res.status(400).json({ success: false, message: 'Promo kod istifadə limitini keçib' });
      return;
    }
    if (promo.minOrderAmount && orderAmount < promo.minOrderAmount) {
      res.status(400).json({ success: false, message: `Minimum sifariş məbləği ${promo.minOrderAmount} AZN olmalıdır` });
      return;
    }

    // Indirimi hesapla
    let discount = 0;
    if (promo.discountType === 'PERCENT') {
      discount = (orderAmount * promo.discountValue) / 100;
      if (promo.maxDiscount && discount > promo.maxDiscount) discount = promo.maxDiscount;
    } else {
      discount = promo.discountValue;
    }

    res.json({
      success: true,
      promo: {
        id: promo.id,
        code: promo.code,
        description: promo.description,
        discountType: promo.discountType,
        discountValue: promo.discountValue,
      },
      discount: Math.round(discount * 100) / 100,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin: promo kod olustur
router.post('/admin/promo', requirePermission('promo'), async (req: AuthRequest, res: Response) => {
  try {
    const { code, description, discountType, discountValue, minOrderAmount, maxDiscount, usageLimit, validUntil } = req.body;
    if (!code || !discountType || !discountValue) {
      res.status(400).json({ success: false, message: 'Kod, tip və qiymət tələb olunur' });
      return;
    }
    const promo = await prisma.promoCode.create({
      data: {
        code: code.toUpperCase(),
        description: description || null,
        discountType,
        discountValue: parseFloat(discountValue),
        minOrderAmount: minOrderAmount ? parseFloat(minOrderAmount) : null,
        maxDiscount: maxDiscount ? parseFloat(maxDiscount) : null,
        usageLimit: usageLimit ? parseInt(usageLimit) : null,
        validUntil: validUntil ? new Date(validUntil) : null,
      },
    });
    res.status(201).json({ success: true, promo });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin: promo kod listesi
router.get('/admin/promo', requirePermission('promo'), async (_req: AuthRequest, res: Response) => {
  try {
    const promos = await prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ promos });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin: promo kod redaktə et / aktiv-deaktiv (toggle)
router.put('/admin/promo/:id', requirePermission('promo'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ success: false, message: 'Yanlış ID' }); return; }
    const { code, description, discountType, discountValue, minOrderAmount, maxDiscount, usageLimit, validUntil, active } = req.body;
    const data: any = {};
    if (code !== undefined) data.code = String(code).toUpperCase();
    if (description !== undefined) data.description = description || null;
    if (discountType !== undefined) data.discountType = discountType;
    if (discountValue !== undefined) data.discountValue = parseFloat(discountValue);
    if (minOrderAmount !== undefined) data.minOrderAmount = minOrderAmount ? parseFloat(minOrderAmount) : null;
    if (maxDiscount !== undefined) data.maxDiscount = maxDiscount ? parseFloat(maxDiscount) : null;
    if (usageLimit !== undefined) data.usageLimit = usageLimit ? parseInt(usageLimit) : null;
    if (validUntil !== undefined) data.validUntil = validUntil ? new Date(validUntil) : null;
    if (active !== undefined) data.active = !!active;
    try {
      const promo = await prisma.promoCode.update({ where: { id }, data });
      res.json({ success: true, promo });
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(400).json({ success: false, message: 'Bu kod artıq mövcuddur' }); return; }
      throw err;
    }
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin: promo kod sil
router.delete('/admin/promo/:id', requirePermission('promo'), async (req: AuthRequest, res: Response) => {
  try {
    await prisma.promoCode.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
