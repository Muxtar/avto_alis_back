import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

// Get my addresses
router.get('/addresses', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const addresses = await prisma.savedAddress.findMany({
      where: { userId: req.adminId! },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ addresses });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Create address
router.post('/addresses', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { label, address, phone, latitude, longitude, isDefault } = req.body;
    if (!label || !address) {
      res.status(400).json({ success: false, message: 'Etiket və ünvan tələb olunur' });
      return;
    }

    // Default yapilacaksa digerlerini false yap
    if (isDefault) {
      await prisma.savedAddress.updateMany({
        where: { userId: req.adminId! },
        data: { isDefault: false },
      });
    }

    const created = await prisma.savedAddress.create({
      data: {
        userId: req.adminId!,
        label, address,
        phone: phone || null,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        isDefault: !!isDefault,
      },
    });
    res.status(201).json({ success: true, address: created });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Update address
router.put('/addresses/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.savedAddress.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!existing || existing.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    const { label, address, phone, latitude, longitude, isDefault } = req.body;

    if (isDefault) {
      await prisma.savedAddress.updateMany({
        where: { userId: req.adminId!, id: { not: existing.id } },
        data: { isDefault: false },
      });
    }

    const updated = await prisma.savedAddress.update({
      where: { id: existing.id },
      data: {
        ...(label !== undefined && { label }),
        ...(address !== undefined && { address }),
        ...(phone !== undefined && { phone }),
        ...(latitude !== undefined && { latitude: latitude ? parseFloat(latitude) : null }),
        ...(longitude !== undefined && { longitude: longitude ? parseFloat(longitude) : null }),
        ...(isDefault !== undefined && { isDefault: !!isDefault }),
      },
    });
    res.json({ success: true, address: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Delete address
router.delete('/addresses/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.savedAddress.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!existing || existing.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    await prisma.savedAddress.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
