import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

// Get my favorites
router.get('/favorites', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const favorites = await prisma.favorite.findMany({
      where: { userId: req.adminId! },
      include: {
        listing: { include: { user: { select: { id: true, name: true, phone: true, type: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ favorites });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Add to favorites
router.post('/favorites', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { listingId } = req.body;
    if (!listingId) {
      res.status(400).json({ success: false, message: 'listingId tələb olunur' });
      return;
    }
    const favorite = await prisma.favorite.upsert({
      where: { userId_listingId: { userId: req.adminId!, listingId: parseInt(listingId) } },
      create: { userId: req.adminId!, listingId: parseInt(listingId) },
      update: {},
    });
    res.status(201).json({ success: true, favorite });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Remove from favorites
router.delete('/favorites/:listingId', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.favorite.deleteMany({
      where: { userId: req.adminId!, listingId: parseInt(req.params.listingId) },
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Check if favorited (multiple listings)
router.post('/favorites/check', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { listingIds } = req.body;
    if (!Array.isArray(listingIds)) {
      res.json({ favorites: [] });
      return;
    }
    const favorites = await prisma.favorite.findMany({
      where: { userId: req.adminId!, listingId: { in: listingIds.map((id: any) => parseInt(id)) } },
      select: { listingId: true },
    });
    res.json({ favorites: favorites.map(f => f.listingId) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
