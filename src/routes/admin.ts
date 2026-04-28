import { Router, Response } from 'express';
import { PrismaClient, Prisma, UserType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { adminAuth, requireAdmin, AuthRequest, generateToken } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimiter';
import fs from 'fs';
import path from 'path';

const router = Router();
const prisma = new PrismaClient();

// Admin Login
router.post('/admin/login', authLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { username, password } = req.body;

    const admin = await prisma.user.findFirst({
      where: { name: username, role: 'ADMIN' },
    });

    if (!admin || !admin.password) {
      res.status(401).json({ success: false, message: 'Yanlış istifadəçi adı və ya şifrə' });
      return;
    }

    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) {
      res.status(401).json({ success: false, message: 'Yanlış istifadəçi adı və ya şifrə' });
      return;
    }

    const token = generateToken(admin.id);
    res.json({ success: true, token, admin: { id: admin.id, name: admin.name } });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Dashboard Stats
router.get('/admin/dashboard', requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const [totalUsers, totalListings, totalProducts, totalServices, recentUsers, recentListings] = await Promise.all([
      prisma.user.count({ where: { role: 'USER' } }),
      prisma.listing.count(),
      prisma.listing.count({ where: { type: 'PRODUCT' } }),
      prisma.listing.count({ where: { type: 'SERVICE' } }),
      prisma.user.findMany({ where: { role: 'USER' }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, name: true, phone: true, type: true, verified: true, createdAt: true } }),
      prisma.listing.findMany({ orderBy: { createdAt: 'desc' }, take: 5, include: { user: { select: { name: true } } } }),
    ]);

    const categoryCounts = await prisma.listing.groupBy({ by: ['category'], _count: true, orderBy: { _count: { category: 'desc' } } });

    res.json({
      stats: { totalUsers, totalListings, totalProducts, totalServices },
      categoryCounts: categoryCounts.map((c) => ({ category: c.category, count: c._count })),
      recentUsers,
      recentListings,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get All Users
router.get('/admin/users', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { search, type, page = '1', limit = '20' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: Prisma.UserWhereInput = { role: 'USER' };
    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { phone: { contains: search as string } },
      ];
    }
    if (type) where.type = type as any;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: { vehicles: true, workplaces: true, _count: { select: { listings: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ users, total, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Update User
router.put('/admin/users/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name, phone, type, verified, role } = req.body;

    // Admin kendisini degistiremez ve baskasini admin yapamaz (sadece superadmin yapabilir)
    const targetId = parseInt(req.params.id);
    if (role === 'ADMIN' && targetId !== req.adminId) {
      res.status(403).json({ success: false, message: 'Başqa istifadəçiyə admin rolu vermək mümkün deyil' });
      return;
    }
    // Admin kendisinin rolunu dusurememeli
    if (targetId === req.adminId && role && role !== 'ADMIN') {
      res.status(403).json({ success: false, message: 'Öz admin rolunuzu dəyişə bilməzsiniz' });
      return;
    }

    const user = await prisma.user.update({
      where: { id: targetId },
      data: {
        ...(name !== undefined && { name }),
        ...(phone !== undefined && { phone }),
        ...(type !== undefined && { type }),
        ...(verified !== undefined && { verified }),
        ...(role !== undefined && { role }),
      },
    });
    res.json({ success: true, user });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Delete User
router.delete('/admin/users/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.user.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get All Listings
router.get('/admin/listings', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { search, category, type, page = '1', limit = '20' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: Prisma.ListingWhereInput = {};
    if (search) {
      where.OR = [
        { title: { contains: search as string, mode: 'insensitive' } },
        { description: { contains: search as string, mode: 'insensitive' } },
      ];
    }
    if (category) where.category = category as string;
    if (type && type !== 'all') where.type = type as any;

    const [listings, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        include: { user: { select: { id: true, name: true, phone: true, type: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.listing.count({ where }),
    ]);

    res.json({ listings, total, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Update Listing
router.put('/admin/listings/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { title, description, price, category, type } = req.body;
    const listing = await prisma.listing.update({
      where: { id: parseInt(req.params.id) },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(price !== undefined && { price: parseFloat(price) }),
        ...(category !== undefined && { category }),
        ...(type !== undefined && { type }),
      },
    });
    res.json({ success: true, listing });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Delete Listing
router.delete('/admin/listings/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const listing = await prisma.listing.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!listing) { res.status(404).json({ success: false, message: 'Elan tapılmadı' }); return; }

    // Resimleri diskten sil
    if (listing.images && listing.images.length > 0) {
      for (const img of listing.images) {
        const filePath = path.join(__dirname, '../../uploads', img);
        fs.unlink(filePath, () => {});
      }
    }

    await prisma.listing.delete({ where: { id: listing.id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== COURIER MANAGEMENT =====================

// Create Courier
router.post('/admin/couriers', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name, phone, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const courier = await prisma.user.create({
      data: { name, phone, password: hashedPassword, type: UserType.COURIER, role: 'USER', verified: true },
    });
    res.status(201).json({ success: true, courier: { id: courier.id, name: courier.name, phone: courier.phone } });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get All Couriers
router.get('/admin/couriers', requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const couriers = await prisma.user.findMany({
      where: { type: 'COURIER' },
      select: { id: true, name: true, phone: true, createdAt: true, _count: { select: { courierOrders: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ couriers });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Update Courier
router.put('/admin/couriers/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name, phone, password } = req.body;
    const data: any = {};
    if (name !== undefined) data.name = name;
    if (phone !== undefined) data.phone = phone;
    if (password) data.password = await bcrypt.hash(password, 10);
    const courier = await prisma.user.update({
      where: { id: parseInt(req.params.id) },
      data,
      select: { id: true, name: true, phone: true },
    });
    res.json({ success: true, courier });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Delete Courier
router.delete('/admin/couriers/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.user.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== ORDER MANAGEMENT =====================

// Get All Orders (admin)
router.get('/admin/orders', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { status, page = '1', limit = '20' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: Prisma.OrderWhereInput = {};
    if (status && status !== 'all') where.status = status as any;

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          items: true,
          buyer: { select: { id: true, name: true, phone: true } },
          seller: { select: { id: true, name: true, phone: true } },
          courier: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.order.count({ where }),
    ]);

    res.json({ orders, total, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Assign Courier to Order
router.put('/admin/orders/:id/assign-courier', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { courierId } = req.body;
    const order = await prisma.order.update({
      where: { id: parseInt(req.params.id) },
      data: { courierId: courierId ? parseInt(courierId) : null },
      include: { courier: { select: { id: true, name: true, phone: true } } },
    });
    res.json({ success: true, order });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== RETURN MANAGEMENT =====================

// Get All Returns
router.get('/admin/returns', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { status, page = '1', limit = '20' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: Prisma.ReturnRequestWhereInput = {};
    if (status && status !== 'all') where.status = status as any;

    const [returns, total] = await Promise.all([
      prisma.returnRequest.findMany({
        where,
        include: {
          order: { include: { items: true } },
          orderItem: true,
          buyer: { select: { id: true, name: true, phone: true } },
          seller: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.returnRequest.count({ where }),
    ]);

    res.json({ returns, total, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin override return status
router.put('/admin/returns/:id/override', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { status, adminNote, refundAmount } = req.body;
    if (!['APPROVED', 'REJECTED', 'REFUNDED'].includes(status)) {
      res.status(400).json({ success: false, message: 'Yalnız APPROVED, REJECTED və ya REFUNDED statusu təyin edə bilərsiniz' }); return;
    }

    const ret = await prisma.returnRequest.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { orderItem: true, order: { include: { items: true } } },
    });
    if (!ret) { res.status(404).json({ success: false, message: 'İadə sorğusu tapılmadı' }); return; }

    // If forcing refund, restore stock
    if (status === 'REFUNDED') {
      if (ret.orderItem) {
        try {
          await prisma.listing.update({
            where: { id: ret.orderItem.listingId },
            data: { stock: { increment: ret.quantity } },
          });
        } catch { /* listing may be deleted */ }
      } else {
        for (const item of ret.order.items) {
          try {
            await prisma.listing.update({
              where: { id: item.listingId },
              data: { stock: { increment: item.quantity } },
            });
          } catch { /* listing may be deleted */ }
        }
      }
    }

    const updated = await prisma.returnRequest.update({
      where: { id: ret.id },
      data: {
        status,
        adminNote: adminNote || null,
        ...(refundAmount !== undefined && { refundAmount: parseFloat(refundAmount) }),
      },
    });
    res.json({ success: true, returnRequest: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
