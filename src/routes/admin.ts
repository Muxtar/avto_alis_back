import { Router, Response } from 'express';
import { PrismaClient, Prisma, UserType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { adminAuth, requireAdmin, AuthRequest, generateToken } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimiter';
import { refund as kapitalRefund } from '../services/kapital';
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

// Create User (admin əl ilə istifadəçi əlavə edir)
router.post('/admin/users', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    if (!name || !phone) { res.status(400).json({ success: false, message: 'Ad və telefon tələb olunur' }); return; }
    const validTypes = ['CAR_OWNER', 'MECHANIC', 'PARTS_SELLER', 'COURIER'];
    const type = validTypes.includes(req.body.type) ? req.body.type : 'CAR_OWNER';
    const exists = await prisma.user.findFirst({ where: { phone } });
    if (exists) { res.status(400).json({ success: false, message: 'Bu telefon artıq qeydiyyatdadır' }); return; }
    const data: any = {
      name, phone, type: type as UserType,
      role: req.body.role === 'ADMIN' ? 'ADMIN' : 'USER',
      verified: req.body.verified === true || req.body.verified === 'true',
      profileComplete: true,
    };
    if (req.body.email) data.email = String(req.body.email).trim();
    if (req.body.password) data.password = await bcrypt.hash(String(req.body.password), 10);
    const user = await prisma.user.create({
      data,
      select: { id: true, name: true, phone: true, email: true, type: true, role: true, verified: true, isBlocked: true, createdAt: true },
    });
    res.status(201).json({ success: true, user });
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

    try {
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
    } catch (err: any) {
      // H11 fix: catch unique-violation on phone
      if (err?.code === 'P2002') {
        res.status(400).json({ success: false, message: 'Bu telefon nömrəsi artıq başqa istifadəçi tərəfindən istifadə olunur' });
        return;
      }
      throw err;
    }
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Delete User
router.delete('/admin/users/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const targetId = parseInt(req.params.id);
    if (Number.isNaN(targetId)) {
      res.status(400).json({ success: false, message: 'Yanlış ID' }); return;
    }
    // C13 fix: prevent admin self-deletion (would lock them out & cascade-delete their data)
    if (targetId === req.adminId) {
      res.status(403).json({ success: false, message: 'Öz hesabınızı silə bilməzsiniz' });
      return;
    }
    await prisma.user.delete({ where: { id: targetId } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get All Listings
router.get('/admin/listings', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { search, category, type, status, page = '1', limit = '20' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: Prisma.ListingWhereInput = {};
    // ?status=PENDING — moderasiya növbəsi
    if (status && status !== 'all') where.status = status as any;
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
    const pendingCount = await prisma.listing.count({ where: { status: 'PENDING' } });

    res.json({ listings, total, pendingCount, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Elan moderasiyası — təsdiqlə / rədd et.
// body: { status: 'APPROVED' | 'REJECTED' | 'PENDING', rejectReason?: string }
router.patch('/admin/listings/:id/status', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const status = String(req.body?.status || '').toUpperCase();
    if (!['APPROVED', 'REJECTED', 'PENDING'].includes(status)) {
      res.status(400).json({ success: false, message: 'status yalnız APPROVED, REJECTED və ya PENDING ola bilər' });
      return;
    }
    const listing = await prisma.listing.update({
      where: { id },
      data: {
        status: status as any,
        rejectReason: status === 'REJECTED' ? (String(req.body?.rejectReason || '').trim() || null) : null,
        reviewedAt: status === 'PENDING' ? null : new Date(),
      },
      select: { id: true, title: true, status: true, rejectReason: true, userId: true },
    });
    res.json({ success: true, listing });
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

// Bulk reactivate — bütün vaxtı bitmiş (və ya expiresAt = null) elanların
// müddətini indidən 30 gün uzadır. Bir dəfəlik admin əməliyyatı: marketplace-də
// köhnə elanlar yenidən görünsün.
router.post('/admin/listings/reactivate-expired', requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const result = await prisma.listing.updateMany({
      where: {
        OR: [
          { expiresAt: null },
          { expiresAt: { lte: now } },
        ],
      },
      data: { expiresAt: newExpiresAt },
    });

    res.json({
      success: true,
      updatedCount: result.count,
      newExpiresAt,
      message: `${result.count} elan 30 gün üçün yeniləndi.`,
    });
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
    const orderId = parseInt(req.params.id);
    if (Number.isNaN(orderId)) {
      res.status(400).json({ success: false, message: 'Yanlış sifariş ID' }); return;
    }
    const { courierId } = req.body;
    const cid = courierId ? parseInt(courierId) : null;
    // C10 fix: when assigning, verify the user is actually a COURIER —
    // otherwise admin could mistakenly assign any user to deliver.
    if (cid !== null) {
      const courier = await prisma.user.findUnique({
        where: { id: cid },
        select: { id: true, type: true },
      });
      if (!courier || courier.type !== 'COURIER') {
        res.status(400).json({ success: false, message: 'Seçilmiş istifadəçi kuryer deyil' });
        return;
      }
    }
    const order = await prisma.order.update({
      where: { id: orderId },
      data: { courierId: cid },
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

      // Kart ödənişidirsə — pulu Kapital Bank vasitəsilə həqiqətən geri qaytar.
      const order = ret.order;
      if (order.gatewayOrderId && order.gatewayPassword && order.paymentStatus === 'PAID') {
        const amt = refundAmount !== undefined ? parseFloat(refundAmount) : (ret.refundAmount ?? order.total);
        try {
          await kapitalRefund(order.gatewayOrderId, order.gatewayPassword, amt);
          await prisma.order.update({
            where: { id: order.id },
            data: { paymentStatus: 'REFUNDED', gatewayStatus: 'Refunded' },
          });
        } catch (err: any) {
          res.status(502).json({ success: false, message: 'Bank iadəsi alınmadı: ' + err.message }); return;
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

// ===================== ORDER STATUS (admin override) =====================

const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;

// Admin sifariş statusunu dəyişir. CANCELLED olduqda stok geri qaytarılır.
router.put('/admin/orders/:id/status', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const orderId = parseInt(req.params.id);
    if (Number.isNaN(orderId)) { res.status(400).json({ success: false, message: 'Yanlış sifariş ID' }); return; }
    const { status } = req.body;
    if (!ORDER_STATUSES.includes(status)) {
      res.status(400).json({ success: false, message: 'Yanlış status' }); return;
    }
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) { res.status(404).json({ success: false, message: 'Sifariş tapılmadı' }); return; }

    // Ləğv olunduqda və əvvəl ləğv olunmayıbsa — stoku geri qaytar.
    if (status === 'CANCELLED' && order.status !== 'CANCELLED') {
      for (const item of order.items) {
        try {
          await prisma.listing.update({ where: { id: item.listingId }, data: { stock: { increment: item.quantity } } });
        } catch { /* listing silinmiş ola bilər */ }
      }
    }
    const updated = await prisma.order.update({ where: { id: orderId }, data: { status } });
    // Alıcıya bildiriş
    try {
      await prisma.notification.create({
        data: { userId: order.buyerId, type: 'ORDER', title: 'Sifariş statusu yeniləndi', body: `Sifariş #${order.id}: ${status}`, link: `/orders/${order.id}` },
      });
    } catch { /* ignore */ }
    res.json({ success: true, order: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== USER BLOCK / UNBLOCK =====================

router.put('/admin/users/:id/block', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const targetId = parseInt(req.params.id);
    if (Number.isNaN(targetId)) { res.status(400).json({ success: false, message: 'Yanlış ID' }); return; }
    if (targetId === req.adminId) { res.status(403).json({ success: false, message: 'Öz hesabınızı bloklaya bilməzsiniz' }); return; }
    const { blocked } = req.body;
    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { role: true } });
    if (!target) { res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' }); return; }
    if (target.role === 'ADMIN') { res.status(403).json({ success: false, message: 'Admini bloklamaq olmaz' }); return; }
    const user = await prisma.user.update({
      where: { id: targetId },
      data: { isBlocked: blocked === true },
      select: { id: true, name: true, isBlocked: true },
    });
    res.json({ success: true, user });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== COMMENT / RATING MODERATION =====================

router.get('/admin/comments', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', limit = '20' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);
    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        include: {
          user: { select: { id: true, name: true, phone: true } },
          listing: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip, take,
      }),
      prisma.comment.count(),
    ]);
    res.json({ comments, total, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/admin/comments/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ success: false, message: 'Yanlış ID' }); return; }
    await prisma.comment.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== BROADCAST NOTIFICATIONS =====================

// Bütün (və ya tipə görə) istifadəçilərə bildiriş göndər.
router.post('/admin/broadcast', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { title, body, link, userType } = req.body;
    if (!title || !body) { res.status(400).json({ success: false, message: 'Başlıq və mətn tələb olunur' }); return; }
    const where: Prisma.UserWhereInput = { role: 'USER', isBlocked: false };
    if (userType && ['CAR_OWNER', 'MECHANIC', 'PARTS_SELLER', 'COURIER'].includes(userType)) {
      where.type = userType as UserType;
    }
    const users = await prisma.user.findMany({ where, select: { id: true } });
    if (users.length === 0) { res.json({ success: true, count: 0 }); return; }
    const result = await prisma.notification.createMany({
      data: users.map((u) => ({
        userId: u.id, type: 'SYSTEM', title: String(title), body: String(body), link: link ? String(link) : null,
      })),
    });
    res.json({ success: true, count: result.count });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== ANALYTICS =====================

router.get('/admin/analytics', requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const last30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [ordersByStatus, paidAgg, deliveredCount, last30Orders, newUsers30, blockedUsers, pendingKyc, openReturns] = await Promise.all([
      prisma.order.groupBy({ by: ['status'], _count: true }),
      prisma.order.aggregate({ _sum: { total: true }, where: { paymentStatus: 'PAID' } }),
      prisma.order.count({ where: { status: 'DELIVERED' } }),
      prisma.order.findMany({ where: { createdAt: { gte: last30 } }, select: { total: true, createdAt: true, status: true } }),
      prisma.user.count({ where: { role: 'USER', createdAt: { gte: last30 } } }),
      prisma.user.count({ where: { isBlocked: true } }),
      prisma.sellerVerification.count({ where: { status: 'PENDING' } }),
      prisma.returnRequest.count({ where: { status: { in: ['REQUESTED', 'APPROVED', 'RETURN_SHIPPED', 'RETURN_RECEIVED'] } } }),
    ]);

    // Son 30 gün — günlük gəlir/sifariş
    const dailyMap = new Map<string, { revenue: number; orders: number }>();
    for (const o of last30Orders) {
      const day = o.createdAt.toISOString().slice(0, 10);
      const cur = dailyMap.get(day) || { revenue: 0, orders: 0 };
      cur.orders += 1;
      if (o.status !== 'CANCELLED') cur.revenue += o.total;
      dailyMap.set(day, cur);
    }
    const daily = Array.from(dailyMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v }));

    res.json({
      revenueTotal: paidAgg._sum.total || 0,
      deliveredCount,
      ordersByStatus: ordersByStatus.map((s) => ({ status: s.status, count: s._count })),
      newUsers30,
      blockedUsers,
      pendingKyc,
      openReturns,
      daily,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==================== KİMLİK (FACE) YOXLAMASI ====================
// İstifadəçilərin kimlik vəsiqəsi + selfie yoxlamaları (face-api.js balı + admin gözü).
router.get('/admin/id-verifications', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const where: Prisma.UserWhereInput = status === 'ALL'
      ? { idCardImage: { not: null } }
      : { idVerifyStatus: status as any };
    const users = await prisma.user.findMany({
      where,
      orderBy: { id: 'desc' },
      select: {
        id: true, name: true, phone: true, profession: true,
        idCardImage: true, selfieImage: true, faceMatchScore: true, idVerifyStatus: true,
        idAiNameMatch: true, idAiNameScore: true, idAiFaceMatch: true, idAiFaceScore: true, idAiReason: true,
      },
      take: 200,
    });
    res.json({ success: true, users });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/admin/id-verifications/:userId/:action', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const action = String(req.params.action);
    if (!['approve', 'reject'].includes(action)) { res.status(400).json({ success: false, message: 'Yanlış əməliyyat' }); return; }
    const user = await prisma.user.update({
      where: { id: userId },
      data: { idVerifyStatus: action === 'approve' ? 'APPROVED' : 'REJECTED' },
      select: { id: true, idVerifyStatus: true },
    });
    await prisma.notification.create({
      data: {
        userId,
        type: 'SYSTEM',
        title: 'Kimlik yoxlaması',
        body: action === 'approve' ? 'Kimliyiniz təsdiqləndi ✓' : 'Kimlik yoxlaması rədd edildi. Yenidən cəhd edin.',
        link: '/profile',
      },
    }).catch(() => {});
    res.json({ success: true, user });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==================== PEŞƏ SƏNƏDLƏRİ (AI ad-soyad yoxlaması) ====================
router.get('/admin/credentials', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const where: Prisma.ProfessionDocumentWhereInput = status === 'ALL' ? {} : { status: status as any };
    const documents = await prisma.professionDocument.findMany({
      where, orderBy: { id: 'desc' }, take: 200,
      select: {
        id: true, title: true, image: true, documentType: true, issuer: true, holderName: true,
        nameMatch: true, nameMatchScore: true, professionMatch: true, confidence: true,
        fraudSignals: true, aiReason: true, status: true, createdAt: true,
        user: { select: { id: true, name: true, phone: true, profession: true } },
      },
    });
    res.json({ success: true, documents });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/admin/credentials/:id/:action', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const action = String(req.params.action);
    if (!['approve', 'reject'].includes(action)) { res.status(400).json({ success: false, message: 'Yanlış əməliyyat' }); return; }
    const doc = await prisma.professionDocument.update({
      where: { id },
      data: { status: action === 'approve' ? 'APPROVED' : 'REJECTED' },
      select: { id: true, status: true, userId: true, title: true },
    });
    await prisma.notification.create({
      data: {
        userId: doc.userId,
        type: 'SYSTEM',
        title: 'Peşə sənədi',
        body: action === 'approve' ? `"${doc.title}" sənədiniz təsdiqləndi ✓` : `"${doc.title}" sənədiniz rədd edildi.`,
        link: '/profile',
      },
    }).catch(() => {});
    res.json({ success: true, document: doc });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==================== SOSIAL MEDIA TƏSDİQİ ====================
router.get('/admin/social-links', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const where: Prisma.SocialLinkWhereInput = status === 'VERIFIED' ? { verified: true } : status === 'ALL' ? {} : { verified: false };
    const links = await prisma.socialLink.findMany({
      where, orderBy: { id: 'desc' }, take: 200,
      include: { user: { select: { id: true, name: true, phone: true } } },
    });
    res.json({ success: true, links });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/admin/social-links/:id/:action', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const action = String(req.params.action);
    if (!['verify', 'reject'].includes(action)) { res.status(400).json({ success: false, message: 'Yanlış əməliyyat' }); return; }
    const link = await prisma.socialLink.update({ where: { id }, data: { verified: action === 'verify' } });
    res.json({ success: true, link });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ───────── İrəli səviyyə admin: ümumi baxış (badge sayları + canlı statistika) ─────────
router.get('/admin/overview', requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [
      users, blockedUsers, listings, orders, businesses, couriers,
      pBusinesses, pSellerApps, pIdVer, pCredentials, pSocial, pComplaints, pReturns,
      revenueAgg, revenueTodayAgg, ordersToday, newUsers7d, activeConsult,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'USER', type: { not: 'COURIER' } } }),
      prisma.user.count({ where: { role: 'USER', isBlocked: true } }),
      prisma.listing.count(),
      prisma.order.count(),
      prisma.business.count(),
      prisma.user.count({ where: { type: 'COURIER' } }),
      prisma.business.count({ where: { status: 'PENDING' } }),
      prisma.sellerVerification.count({ where: { status: 'PENDING' } }),
      prisma.user.count({ where: { idVerifyStatus: 'PENDING' } }),
      prisma.professionDocument.count({ where: { status: 'PENDING' } }),
      prisma.socialLink.count({ where: { verified: false } }),
      prisma.complaint.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
      prisma.returnRequest.count({ where: { status: 'REQUESTED' } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { paymentStatus: 'PAID' } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { paymentStatus: 'PAID', createdAt: { gte: startOfDay } } }),
      prisma.order.count({ where: { createdAt: { gte: startOfDay } } }),
      prisma.user.count({ where: { role: 'USER', createdAt: { gte: weekAgo } } }),
      prisma.consultationSession.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
    ]);
    const pending = {
      businesses: pBusinesses, sellerApps: pSellerApps, idVerifications: pIdVer,
      credentials: pCredentials, socialLinks: pSocial, complaints: pComplaints, returns: pReturns,
    };
    const pendingTotal = Object.values(pending).reduce((a, b) => a + b, 0);
    res.json({
      success: true,
      stats: {
        users, blockedUsers, listings, orders, businesses, couriers,
        revenueTotal: revenueAgg._sum.total || 0,
        revenueToday: revenueTodayAgg._sum.total || 0,
        ordersToday, newUsers7d, activeConsult,
      },
      pending,
      pendingTotal,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ───────── İrəli səviyyə admin: qlobal axtarış (istifadəçi/elan/biznes/sifariş) ─────────
router.get('/admin/search', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) { res.json({ success: true, results: { users: [], listings: [], businesses: [], orders: [] } }); return; }
    const idNum = parseInt(q);
    const hasId = Number.isFinite(idNum) && idNum > 0;
    const userOr: any[] = [{ name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }];
    if (hasId) userOr.push({ id: idNum });
    const listOr: any[] = [{ title: { contains: q, mode: 'insensitive' } }];
    if (hasId) listOr.push({ id: idNum });
    const bizOr: any[] = [{ name: { contains: q, mode: 'insensitive' } }, { voen: { contains: q } }];
    if (hasId) bizOr.push({ id: idNum });

    const [usersRes, listingsRes, businessesRes, ordersRes] = await Promise.all([
      prisma.user.findMany({ where: { role: 'USER', OR: userOr }, take: 6, select: { id: true, name: true, phone: true, type: true, isBlocked: true, avatar: true } }),
      prisma.listing.findMany({ where: { OR: listOr }, take: 6, select: { id: true, title: true, price: true, type: true } }),
      prisma.business.findMany({ where: { OR: bizOr }, take: 5, select: { id: true, name: true, voen: true, status: true } }),
      hasId ? prisma.order.findMany({ where: { id: idNum }, take: 3, select: { id: true, status: true, total: true, paymentStatus: true } }) : Promise.resolve([]),
    ]);
    res.json({ success: true, results: { users: usersRes, listings: listingsRes, businesses: businessesRes, orders: ordersRes } });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
