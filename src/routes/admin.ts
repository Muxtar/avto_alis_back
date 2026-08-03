import { Router, Response } from 'express';
import { PrismaClient, Prisma, UserType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { adminAuth, requireAdmin, requirePermission, requireSuperAdmin, AuthRequest, generateToken, isAdminPhone, ADMIN_MODULES } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimiter';
import { createOtp } from '../services/otp';
import { refund as kapitalRefund } from '../services/kapital';
import { listFlags, setFlag } from '../services/settings';
import { infobipStatus, testWhatsApp } from '../services/infobipWhatsApp';
import { smsStatus, testSms } from '../services/infobipSms';
import { otpChannel } from '../services/otp';
import fs from 'fs';
import path from 'path';

const router = Router();
const prisma = new PrismaClient();

// ── Tənzimləmələr (feature-flags) ──
// Admin paneldəki "Tənzimləmələr" səhifəsi üçün. Bütün flag-lar meta + cari
// dəyər ilə qaytarılır; PATCH ilə tək açar aktiv/deaktiv edilir.
router.get('/admin/settings', requirePermission('settings'), async (_req: AuthRequest, res: Response) => {
  try {
    const flags = await listFlags();
    res.json({ success: true, settings: flags });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.patch('/admin/settings', requirePermission('settings'), async (req: AuthRequest, res: Response) => {
  try {
    const key = String(req.body?.key || '');
    const value = req.body?.value === true || req.body?.value === 'true';
    if (!key) { res.status(400).json({ success: false, message: 'key tələb olunur' }); return; }
    await setFlag(key, value);
    res.json({ success: true, key, value });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// OTP konfiqurasiya vəziyyəti — aktiv kanal + Infobip SMS/WhatsApp env-ləri.
router.get('/admin/whatsapp-status', requirePermission('settings'), async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ success: true, channel: otpChannel(), sms: smsStatus(), whatsapp: infobipStatus() });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Test OTP mesajı göndər — WhatsApp və/və ya SMS ayrıca sınanır (channel:
// 'whatsapp' | 'sms' | 'both'). Provayderin real cavabını/xətasını qaytarır.
router.post('/admin/whatsapp-test', requirePermission('settings'), async (req: AuthRequest, res: Response) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    if (!phone) { res.status(400).json({ success: false, message: 'phone tələb olunur' }); return; }
    const which = String(req.body?.channel || 'both').toLowerCase();
    const result: any = {};
    if (which === 'whatsapp' || which === 'both') result.whatsapp = await testWhatsApp(phone);
    if (which === 'sms' || which === 'both') result.sms = await testSms(phone);
    res.json({ success: true, channel: otpChannel(), result });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── ADMIN: nömrə + OTP ilə giriş ──
// Nömrə ADMIN_PHONES (Railway env) siyahısında olmalıdır. İsim+şifrə girişi
// yedək olaraq qalır. Eyni nömrə ilə normal saytda giriş də admin verir.

// 1) Nömrəni göndər → siyahıdadırsa OTP göndərilir (SMS).
router.post('/admin/login/phone', authLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const raw = String(req.body?.phone || '').trim();
    if (!isAdminPhone(raw)) { res.status(403).json({ success: false, message: 'Bu nömrə admin siyahısında deyil' }); return; }
    const digits = raw.replace(/\D/g, '');
    const tail = digits.slice(-9);
    // Mövcud istifadəçini formatdan asılı olmadan tap, yoxdursa yarat — hər ikisinə admin rolu.
    let user = await prisma.user.findFirst({ where: { phone: { contains: tail } } });
    if (!user) {
      user = await prisma.user.create({
        data: { name: 'Admin', phone: digits.startsWith('994') ? `+${digits}` : (raw || `+${digits}`), type: 'CAR_OWNER', role: 'ADMIN', verified: true, profileComplete: true },
      });
    } else if (user.role !== 'ADMIN') {
      user = await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    }
    if (user.isBlocked) { res.status(403).json({ success: false, message: 'Hesab bloklanıb' }); return; }
    const otp = await createOtp(user.id); // otp_real aktivdirsə SMS gedir
    res.json({ success: true, userId: user.id, delivered: otp.delivered, ...(otp.showCode ? { code: otp.code } : {}) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// 2) Kodu təsdiqlə → admin token qaytarılır.
router.post('/admin/login/phone/verify', authLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const userId = parseInt(String(req.body?.userId || ''));
    const code = String(req.body?.code || '');
    if (!userId || !code) { res.status(400).json({ success: false, message: 'userId və kod tələb olunur' }); return; }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !isAdminPhone(user.phone)) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (user.isBlocked) { res.status(403).json({ success: false, message: 'Hesab bloklanıb' }); return; }
    const record = await prisma.verificationCode.findFirst({
      where: { userId, verified: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!record || record.code !== code) { res.status(400).json({ success: false, message: 'Kod yanlışdır və ya vaxtı keçib' }); return; }
    await prisma.verificationCode.update({ where: { id: record.id }, data: { verified: true } });
    if (user.role !== 'ADMIN') await prisma.user.update({ where: { id: userId }, data: { role: 'ADMIN' } });
    const token = generateToken(user.id);
    res.json({ success: true, token, admin: { id: user.id, name: user.name } });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

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

// Cari admin haqqında — frontend sidebar-ı icazələrə görə süzsün deyə.
// isSuperAdmin=true olan hər modula girə bilir; digərləri yalnız permissions-a.
router.get('/admin/me', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const me = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { id: true, name: true, avatar: true, adminPermissions: true } });
    res.json({
      success: true,
      id: me?.id, name: me?.name, avatar: me?.avatar,
      isSuperAdmin: !!req.isSuperAdmin,
      // Super-admin bütün modullara icazəli sayılır (UI-də hamısı görünsün).
      permissions: req.isSuperAdmin ? [...ADMIN_MODULES] : (me?.adminPermissions || []),
      modules: [...ADMIN_MODULES],
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get All Users
router.get('/admin/users', requirePermission('users'), async (req: AuthRequest, res: Response) => {
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
router.post('/admin/users', requirePermission('users'), async (req: AuthRequest, res: Response) => {
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
router.put('/admin/users/:id', requirePermission('users'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, phone, type, verified, role } = req.body;

    const targetId = parseInt(req.params.id);
    // Admin başqa istifadəçiyə admin rolu VERƏ bilər (owner istəyi).
    // Yalnız öz admin rolunu düşürməsinin qarşısı alınır (özünü kilidləməsin).
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
router.delete('/admin/users/:id', requirePermission('users'), async (req: AuthRequest, res: Response) => {
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
    // Açıq (explicit) cascade — DB-dəki FK onDelete "NO ACTION" qalmışsa belə
    // (köhnə db push) silmə işləsin deyə bütün asılı qeydləri sıra ilə silirik.
    const U = targetId;
    await prisma.$transaction(async (tx) => {
      // SetNull tərəflər: bu istifadəçi kuryer/referrer olan sifarişlərdə əlaqəni sıfırla
      await tx.order.updateMany({ where: { courierId: U }, data: { courierId: null } });
      await tx.order.updateMany({ where: { referrerId: U }, data: { referrerId: null } });
      // 1) Başqa entity-lərə istinad edən uşaq cədvəllər (əvvəl silinir)
      await tx.messageReaction.deleteMany({ where: { userId: U } });
      await tx.returnRequest.deleteMany({ where: { OR: [{ buyerId: U }, { sellerId: U }] } });
      await tx.inquiryOffer.deleteMany({ where: { sellerId: U } });
      await tx.inquiryTarget.deleteMany({ where: { sellerId: U } });
      await tx.sellerRating.deleteMany({ where: { OR: [{ sellerId: U }, { buyerId: U }] } });
      await tx.comment.deleteMany({ where: { userId: U } });
      await tx.conversationMember.deleteMany({ where: { userId: U } });
      await tx.referralCart.deleteMany({ where: { referrerId: U } });
      await tx.consultationOffer.deleteMany({ where: { userId: U } });
      // 2) Orta səviyyə entity-lər
      await tx.consultationSession.deleteMany({ where: { OR: [{ buyerId: U }, { professionalId: U }] } });
      await tx.order.deleteMany({ where: { OR: [{ buyerId: U }, { sellerId: U }] } });
      await tx.inquiry.deleteMany({ where: { buyerId: U } });
      await tx.message.deleteMany({ where: { OR: [{ senderId: U }, { receiverId: U }] } });
      await tx.cart.deleteMany({ where: { userId: U } });
      await tx.sharedCart.deleteMany({ where: { userId: U } });
      await tx.booking.deleteMany({ where: { OR: [{ guestId: U }, { hostId: U }] } });
      await tx.complaint.deleteMany({ where: { OR: [{ complainantId: U }, { targetUserId: U }] } });
      await tx.listing.deleteMany({ where: { userId: U } });   // OrderItem/Favorite/Comment cascade
      await tx.business.deleteMany({ where: { userId: U } });   // BusinessObject/bank/member cascade
      // 3) Sadə uşaq cədvəllər
      await tx.vehicle.deleteMany({ where: { userId: U } });
      await tx.workplace.deleteMany({ where: { userId: U } });
      await tx.verificationCode.deleteMany({ where: { userId: U } });
      await tx.phoneNumber.deleteMany({ where: { userId: U } });
      await tx.emailVerification.deleteMany({ where: { userId: U } });
      await tx.socialLink.deleteMany({ where: { userId: U } });
      await tx.professionDocument.deleteMany({ where: { userId: U } });
      await tx.favorite.deleteMany({ where: { userId: U } });
      await tx.savedAddress.deleteMany({ where: { userId: U } });
      await tx.sellerVerification.deleteMany({ where: { userId: U } });
      await tx.notification.deleteMany({ where: { userId: U } });
      await tx.businessMember.deleteMany({ where: { userId: U } });
      await tx.contact.deleteMany({ where: { ownerId: U } });
      await tx.session.deleteMany({ where: { userId: U } });
      // 4) Nəhayət istifadəçinin özü
      await tx.user.delete({ where: { id: U } });
    }, { timeout: 20000 });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get All Listings
router.get('/admin/listings', requirePermission('listings'), async (req: AuthRequest, res: Response) => {
  try {
    const { search, category, type, status, page = '1', limit = '20' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: Prisma.ListingWhereInput = {};
    // ?status=PENDING — moderasiya növbəsi
    if (status && status !== 'all') where.status = status as any;
    // ?ownerType=object|user&ownerId=N — konkret sahibin elanları
    const ownerType = String(req.query.ownerType || '');
    const ownerId = parseInt(String(req.query.ownerId || ''));
    if (ownerType === 'object' && !Number.isNaN(ownerId)) where.businessObjectId = ownerId;
    else if (ownerType === 'user' && !Number.isNaN(ownerId)) { where.userId = ownerId; where.businessObjectId = null; }
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

// GET /admin/listing-owners — elanları SAHİBİNƏ görə qruplaşdırır.
// VÖEN-li elan biznes obyektinə, digərləri şəxsə aid sayılır.
// Cavab: hər sahib üçün ad, VÖEN/şirkət və elan sayları (ümumi/gözləmədə/...).
router.get('/admin/listing-owners', requirePermission('listings'), async (req: AuthRequest, res: Response) => {
  try {
    const { status, search } = req.query;
    const base: Prisma.ListingWhereInput = {};
    if (status && status !== 'all') base.status = status as any;

    const [objRows, userRows] = await Promise.all([
      prisma.listing.groupBy({
        by: ['businessObjectId', 'status'],
        where: { ...base, businessObjectId: { not: null } },
        _count: { _all: true },
      }),
      prisma.listing.groupBy({
        by: ['userId', 'status'],
        where: { ...base, businessObjectId: null },
        _count: { _all: true },
      }),
    ]);

    type Owner = {
      key: string; kind: 'OBJECT' | 'USER'; id: number;
      name: string; subtitle: string | null; voen: string | null;
      total: number; pending: number; approved: number; rejected: number;
    };
    const owners = new Map<string, Owner>();
    const bump = (o: Owner, st: string, n: number) => {
      o.total += n;
      if (st === 'PENDING') o.pending += n;
      else if (st === 'APPROVED') o.approved += n;
      else if (st === 'REJECTED') o.rejected += n;
    };

    const objIds = [...new Set(objRows.map((r) => r.businessObjectId!).filter((x) => x != null))];
    const userIds = [...new Set(userRows.map((r) => r.userId))];
    const [objects, users] = await Promise.all([
      objIds.length
        ? prisma.businessObject.findMany({
            where: { id: { in: objIds } },
            select: { id: true, name: true, city: true, business: { select: { name: true, voen: true } } },
          })
        : Promise.resolve([]),
      userIds.length
        ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, phone: true, type: true } })
        : Promise.resolve([]),
    ]);
    const objById = new Map(objects.map((o) => [o.id, o]));
    const userById = new Map(users.map((u) => [u.id, u]));

    for (const r of objRows) {
      const o = objById.get(r.businessObjectId!);
      if (!o) continue;
      const key = `OBJECT:${o.id}`;
      if (!owners.has(key)) {
        owners.set(key, {
          key, kind: 'OBJECT', id: o.id,
          name: `${o.name} (Obyekt №${o.id})`,
          subtitle: [o.business?.name, o.city].filter(Boolean).join(' · ') || null,
          voen: o.business?.voen || null,
          total: 0, pending: 0, approved: 0, rejected: 0,
        });
      }
      bump(owners.get(key)!, r.status, r._count._all);
    }
    for (const r of userRows) {
      const u = userById.get(r.userId);
      if (!u) continue;
      const key = `USER:${u.id}`;
      if (!owners.has(key)) {
        owners.set(key, {
          key, kind: 'USER', id: u.id,
          name: u.name || `İstifadəçi №${u.id}`,
          subtitle: u.phone || null,
          voen: null,
          total: 0, pending: 0, approved: 0, rejected: 0,
        });
      }
      bump(owners.get(key)!, r.status, r._count._all);
    }

    let list = [...owners.values()];
    if (search) {
      const q = String(search).toLowerCase();
      list = list.filter((o) =>
        o.name.toLowerCase().includes(q) ||
        (o.subtitle || '').toLowerCase().includes(q) ||
        (o.voen || '').includes(q));
    }
    // Gözləyəni çox olan sahib yuxarıda — moderasiya növbəsi üçün rahat.
    list.sort((a, b) => b.pending - a.pending || b.total - a.total || a.name.localeCompare(b.name));

    res.json({ success: true, owners: list });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Elan moderasiyası — təsdiqlə / rədd et.
// body: { status: 'APPROVED' | 'REJECTED' | 'PENDING', rejectReason?: string }
router.patch('/admin/listings/:id/status', requirePermission('listings'), async (req: AuthRequest, res: Response) => {
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
router.put('/admin/listings/:id', requirePermission('listings'), async (req: AuthRequest, res: Response) => {
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
router.delete('/admin/listings/:id', requirePermission('listings'), async (req: AuthRequest, res: Response) => {
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
router.post('/admin/listings/reactivate-expired', requirePermission('listings'), async (_req: AuthRequest, res: Response) => {
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
router.post('/admin/couriers', requirePermission('couriers'), async (req: AuthRequest, res: Response) => {
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
router.get('/admin/couriers', requirePermission('couriers'), async (_req: AuthRequest, res: Response) => {
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
router.put('/admin/couriers/:id', requirePermission('couriers'), async (req: AuthRequest, res: Response) => {
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
router.delete('/admin/couriers/:id', requirePermission('couriers'), async (req: AuthRequest, res: Response) => {
  try {
    await prisma.user.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== ORDER MANAGEMENT =====================

// Get All Orders (admin)
router.get('/admin/orders', requirePermission('orders'), async (req: AuthRequest, res: Response) => {
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

// ── Maliyyə / Ödənişlər hesabatı ──
// Kim kimdən aldı, nə qədər ödədi, platformaya (bizə) nə qədər pul gəldi.
// "Bizə gələn pul" = KART ödənişləri (PAID) — YIĞIM/Kapital merchant hesabımıza
// düşür. NAĞD ödənişlər alıcı→satıcı birbaşa gedir (bizə gəlmir).
router.get('/admin/finance', requirePermission('finance'), async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page || '1')) || 1;
    const take = Math.min(parseInt(String(req.query.limit || '25')) || 25, 100);
    const skip = (page - 1) * take;
    const method = String(req.query.method || 'all');       // all | CARD | CASH | WALLET
    const payStatus = String(req.query.paymentStatus || 'all'); // all | PAID | PENDING | FAILED | REFUNDED
    const q = String(req.query.q || '').trim();
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;

    // Ortaq filtr (tarix + axtarış) — özet kartları bunun üzərindən hesablanır.
    const baseWhere: Prisma.OrderWhereInput = {};
    if (from || to) baseWhere.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    if (q) baseWhere.OR = [
      { buyer: { name: { contains: q, mode: 'insensitive' } } },
      { buyer: { phone: { contains: q } } },
      { seller: { name: { contains: q, mode: 'insensitive' } } },
      { seller: { phone: { contains: q } } },
    ];

    // Cədvəl filtri (üstünə metod + ödəniş statusu).
    const tableWhere: Prisma.OrderWhereInput = { ...baseWhere };
    if (method !== 'all') tableWhere.paymentMethod = method as any;
    if (payStatus !== 'all') tableWhere.paymentStatus = payStatus as any;

    const [rows, total, cardPaid, cashPaid, refunded, allPaid, referralAgg] = await Promise.all([
      prisma.order.findMany({
        where: tableWhere,
        include: {
          items: { select: { title: true, quantity: true, price: true } },
          buyer: { select: { id: true, name: true, phone: true } },
          seller: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip, take,
      }),
      prisma.order.count({ where: tableWhere }),
      // Bizə gələn pul: KART + PAID
      prisma.order.aggregate({ _sum: { total: true }, _count: true, where: { ...baseWhere, paymentMethod: 'CARD', paymentStatus: 'PAID' } }),
      // Nağd (elden): CASH + PAID — bizə gəlmir, satıcıya birbaşa
      prisma.order.aggregate({ _sum: { total: true }, _count: true, where: { ...baseWhere, paymentMethod: 'CASH', paymentStatus: 'PAID' } }),
      // İadə edilmiş
      prisma.order.aggregate({ _sum: { total: true }, _count: true, where: { ...baseWhere, paymentStatus: 'REFUNDED' } }),
      // Bütün ödənilmiş (kart+nağd)
      prisma.order.aggregate({ _sum: { total: true }, _count: true, where: { ...baseWhere, paymentStatus: 'PAID' } }),
      // Referala ödəniləcək komissiya (voided olmayan)
      prisma.order.aggregate({ _sum: { referralAmount: true }, where: { ...baseWhere, paymentStatus: 'PAID', referralVoided: false } }),
    ]);

    res.json({
      success: true,
      summary: {
        cardPaidTotal: cardPaid._sum.total || 0,   // bizə gələn pul (kart)
        cardPaidCount: cardPaid._count || 0,
        cashPaidTotal: cashPaid._sum.total || 0,    // elden (satıcıya birbaşa)
        cashPaidCount: cashPaid._count || 0,
        refundedTotal: refunded._sum.total || 0,
        refundedCount: refunded._count || 0,
        allPaidTotal: allPaid._sum.total || 0,      // ümumi dövriyyə
        allPaidCount: allPaid._count || 0,
        referralPayable: referralAgg._sum.referralAmount || 0, // referrerlara ödəniləcək
      },
      transactions: rows,
      total, page, totalPages: Math.ceil(total / take) || 1,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Assign Courier to Order
router.put('/admin/orders/:id/assign-courier', requirePermission('orders'), async (req: AuthRequest, res: Response) => {
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
router.get('/admin/returns', requirePermission('returns'), async (req: AuthRequest, res: Response) => {
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
router.put('/admin/returns/:id/override', requirePermission('returns'), async (req: AuthRequest, res: Response) => {
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
router.put('/admin/orders/:id/status', requirePermission('orders'), async (req: AuthRequest, res: Response) => {
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

router.put('/admin/users/:id/block', requirePermission('users'), async (req: AuthRequest, res: Response) => {
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

router.get('/admin/comments', requirePermission('comments'), async (req: AuthRequest, res: Response) => {
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

router.delete('/admin/comments/:id', requirePermission('comments'), async (req: AuthRequest, res: Response) => {
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
router.post('/admin/broadcast', requirePermission('broadcast'), async (req: AuthRequest, res: Response) => {
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

// ==================== KİMLİK YOXLAMASI (LƏĞV EDİLDİ) ====================
// Kimlik doğrulaması artıq Veriff ilə avtomatik aparılır — admin paneldə əl ilə
// təsdiq/rədd endpoint-lərinə ehtiyac yoxdur, ona görə silindi.

// ==================== PEŞƏ SƏNƏDLƏRİ (AI ad-soyad yoxlaması) ====================
router.get('/admin/credentials', requirePermission('credentials'), async (req: AuthRequest, res: Response) => {
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

router.post('/admin/credentials/:id/:action', requirePermission('credentials'), async (req: AuthRequest, res: Response) => {
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
router.get('/admin/social-links', requirePermission('social'), async (req: AuthRequest, res: Response) => {
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

router.post('/admin/social-links/:id/:action', requirePermission('social'), async (req: AuthRequest, res: Response) => {
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
      pBusinesses, pSellerApps, pCredentials, pSocial, pComplaints, pReturns, pListings,
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
      prisma.professionDocument.count({ where: { status: 'PENDING' } }),
      prisma.socialLink.count({ where: { verified: false } }),
      prisma.complaint.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
      prisma.returnRequest.count({ where: { status: 'REQUESTED' } }),
      prisma.listing.count({ where: { status: 'PENDING' } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { paymentStatus: 'PAID' } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { paymentStatus: 'PAID', createdAt: { gte: startOfDay } } }),
      prisma.order.count({ where: { createdAt: { gte: startOfDay } } }),
      prisma.user.count({ where: { role: 'USER', createdAt: { gte: weekAgo } } }),
      prisma.consultationSession.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
    ]);
    const pending = {
      businesses: pBusinesses, sellerApps: pSellerApps,
      credentials: pCredentials, socialLinks: pSocial, complaints: pComplaints, returns: pReturns,
      listings: pListings,
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

// ══════════════════════════════════════════════════════════════════════════
// ADMİN İDARƏETMƏSİ (RBAC) — yalnız super-admin (ADMIN_PHONES).
// İstifadəçiləri admin edir, icazə modullarını (adminPermissions) təyin edir.
// ══════════════════════════════════════════════════════════════════════════

function cleanPermissions(input: any): string[] {
  const arr = Array.isArray(input) ? input : [];
  const allowed = new Set<string>(ADMIN_MODULES as readonly string[]);
  // 'admins' modulunu adi adminə vermək olmaz — yalnız super-admin idarə edir.
  return Array.from(new Set(arr.map((x) => String(x)))).filter((m) => allowed.has(m) && m !== 'admins');
}

// Bütün adminləri (role ADMIN) siyahıla — super-admin işarəsi + icazələri ilə.
router.get('/admin/admins', requireSuperAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true, name: true, phone: true, avatar: true, adminPermissions: true, isBlocked: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json({
      success: true,
      modules: [...ADMIN_MODULES],
      admins: admins.map((a) => ({
        id: a.id, name: a.name, phone: a.phone, avatar: a.avatar, isBlocked: a.isBlocked,
        isSuperAdmin: isAdminPhone(a.phone),
        permissions: isAdminPhone(a.phone) ? [...ADMIN_MODULES] : (a.adminPermissions || []),
      })),
    });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
});

// Admin etmək üçün namizəd istifadəçi axtar (ad/telefon). Mövcud adminlər xaric.
router.get('/admin/admins/candidates', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) { res.json({ success: true, users: [] }); return; }
    const users = await prisma.user.findMany({
      where: { role: 'USER', OR: [{ name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }] },
      select: { id: true, name: true, phone: true, avatar: true },
      take: 10,
    });
    res.json({ success: true, users });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
});

// İstifadəçini admin et (və ya mövcud admini yenilə) — icazə modulları ilə.
router.post('/admin/admins', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const userId = parseInt(String(req.body?.userId));
    if (Number.isNaN(userId)) { res.status(400).json({ success: false, message: 'userId tələb olunur' }); return; }
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, phone: true } });
    if (!target) { res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' }); return; }
    const perms = cleanPermissions(req.body?.permissions);
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { role: 'ADMIN', adminPermissions: perms },
      select: { id: true, name: true, phone: true, adminPermissions: true },
    });
    res.json({ success: true, admin: { ...updated, isSuperAdmin: isAdminPhone(updated.phone) } });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
});

// Admin icazələrini yenilə. Super-adminin (ADMIN_PHONES) icazələri dəyişdirilə bilməz.
router.put('/admin/admins/:id/permissions', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, phone: true, role: true } });
    if (!target || target.role !== 'ADMIN') { res.status(404).json({ success: false, message: 'Admin tapılmadı' }); return; }
    if (isAdminPhone(target.phone)) { res.status(400).json({ success: false, message: 'Super-adminin icazələri dəyişdirilə bilməz' }); return; }
    const perms = cleanPermissions(req.body?.permissions);
    const updated = await prisma.user.update({ where: { id }, data: { adminPermissions: perms }, select: { id: true, name: true, phone: true, adminPermissions: true } });
    res.json({ success: true, admin: { ...updated, isSuperAdmin: false } });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
});

// Admin səlahiyyətini götür (role USER) — super-admini götürmək olmaz.
router.delete('/admin/admins/:id', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    if (id === req.adminId) { res.status(400).json({ success: false, message: 'Özünüzü admindən çıxara bilməzsiniz' }); return; }
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, phone: true, role: true } });
    if (!target || target.role !== 'ADMIN') { res.status(404).json({ success: false, message: 'Admin tapılmadı' }); return; }
    if (isAdminPhone(target.phone)) { res.status(400).json({ success: false, message: 'Super-admin (ADMIN_PHONES) səlahiyyəti panel üzərindən götürülə bilməz' }); return; }
    await prisma.user.update({ where: { id }, data: { role: 'USER', adminPermissions: [] } });
    res.json({ success: true });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
});

export default router;
