// Sosial media müraciəti (outreach) — istifadəçi websearch-də tapdığı şəxsə
// mesaj yazır, mesaj ADMİN PANELƏ düşür, admin həmin hesaba ƏLLƏ göndərir.
import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, requirePermission, AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';

const router = Router();
const prisma = new PrismaClient();

// Spam qoruması — saatda 10 müraciət / IP.
const outreachLimiter = rateLimit(10, 60 * 60 * 1000);

const PLATFORMS = ['instagram', 'facebook', 'linkedin', 'tiktok', 'x', 'twitter', 'youtube', 'telegram'];

// ── İstifadəçi: mesaj göndərmə tələbi yarat ──────────────────────────────────
router.post('/social-outreach', outreachLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const targetUrl = String(req.body?.targetUrl || '').trim();
    const targetPlatform = String(req.body?.targetPlatform || '').trim().toLowerCase();
    const targetHandle = String(req.body?.targetHandle || '').trim();
    const targetName = String(req.body?.targetName || '').trim().slice(0, 120) || targetHandle;
    const targetAvatar = req.body?.targetAvatar ? String(req.body.targetAvatar).slice(0, 500) : null;
    const matchedUserId = req.body?.matchedUserId ? parseInt(String(req.body.matchedUserId)) : null;
    const message = String(req.body?.message || '').trim();

    if (!/^https?:\/\//i.test(targetUrl)) { res.status(400).json({ success: false, message: 'Profil linki yanlışdır' }); return; }
    if (!PLATFORMS.includes(targetPlatform)) { res.status(400).json({ success: false, message: 'Platforma dəstəklənmir' }); return; }
    if (!targetHandle) { res.status(400).json({ success: false, message: 'Profil istifadəçi adı tapılmadı' }); return; }
    if (message.length < 5) { res.status(400).json({ success: false, message: 'Mesaj ən azı 5 simvol olmalıdır' }); return; }
    if (message.length > 1000) { res.status(400).json({ success: false, message: 'Mesaj çox uzundur (maks. 1000 simvol)' }); return; }

    // Eyni profilə təkrar gözləyən müraciət olmasın.
    const dup = await prisma.socialOutreach.findFirst({
      where: { requesterId: req.adminId!, targetPlatform, targetHandle, status: 'PENDING' },
      select: { id: true },
    });
    if (dup) { res.status(400).json({ success: false, message: 'Bu profilə göndərilməmiş müraciətiniz artıq var' }); return; }

    const item = await prisma.socialOutreach.create({
      data: {
        requesterId: req.adminId!,
        targetName, targetPlatform, targetHandle, targetUrl, targetAvatar,
        matchedUserId: Number.isNaN(matchedUserId as any) ? null : matchedUserId,
        message,
      },
    });
    res.json({ success: true, outreach: { id: item.id, status: item.status } });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// İstifadəçi: öz müraciətləri (status izləmə).
router.get('/me/social-outreach', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const items = await prisma.socialOutreach.findMany({
      where: { requesterId: req.adminId! },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, targetName: true, targetPlatform: true, targetHandle: true, targetUrl: true,
        targetAvatar: true, message: true, status: true, adminNote: true, sentAt: true, createdAt: true,
      },
    });
    res.json({ success: true, items });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get('/admin/social-outreach', requirePermission('outreach'), async (req: AuthRequest, res: Response) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const where = status && status !== 'all' ? { status: status as any } : undefined;
    const [items, pendingCount] = await Promise.all([
      prisma.socialOutreach.findMany({
        where, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 200,
      }),
      prisma.socialOutreach.count({ where: { status: 'PENDING' } }),
    ]);
    // Müraciət edənlərin adı.
    const ids = Array.from(new Set(items.map((i) => i.requesterId)));
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true } }) : [];
    const uById = new Map(users.map((u) => [u.id, u]));
    res.json({
      success: true, pendingCount,
      items: items.map((i) => ({ ...i, requester: uById.get(i.requesterId) || null })),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Admin: göndərildi olaraq işarələ (əl ilə göndərdikdən sonra).
router.post('/admin/social-outreach/:id/sent', requirePermission('outreach'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const note = String(req.body?.adminNote || '').trim().slice(0, 500) || null;
    const item = await prisma.socialOutreach.findUnique({ where: { id }, select: { id: true, requesterId: true, targetName: true, status: true } });
    if (!item) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    if (item.status !== 'PENDING') { res.status(400).json({ success: false, message: 'Bu müraciət artıq bağlanıb' }); return; }
    await prisma.socialOutreach.update({
      where: { id },
      data: { status: 'SENT', adminNote: note, sentById: req.adminId!, sentByName: req.adminName || 'Admin', sentAt: new Date() },
    });
    await prisma.notification.create({
      data: {
        userId: item.requesterId, type: 'SYSTEM',
        title: 'Mesajınız göndərildi',
        body: `"${item.targetName}" adlı şəxsə mesajınız göndərildi.`,
        link: '/social-outreach',
      },
    }).catch(() => {});
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Admin: rədd et (uyğunsuz/spam).
router.post('/admin/social-outreach/:id/reject', requirePermission('outreach'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const note = String(req.body?.adminNote || '').trim().slice(0, 500) || null;
    const item = await prisma.socialOutreach.findUnique({ where: { id }, select: { id: true, requesterId: true, targetName: true, status: true } });
    if (!item) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    if (item.status !== 'PENDING') { res.status(400).json({ success: false, message: 'Bu müraciət artıq bağlanıb' }); return; }
    await prisma.socialOutreach.update({
      where: { id },
      data: { status: 'REJECTED', adminNote: note, sentById: req.adminId!, sentByName: req.adminName || 'Admin', sentAt: new Date() },
    });
    await prisma.notification.create({
      data: {
        userId: item.requesterId, type: 'SYSTEM',
        title: 'Mesaj göndərilmədi',
        body: note ? `"${item.targetName}": ${note}` : `"${item.targetName}" adlı şəxsə mesajınız göndərilmədi.`,
        link: '/social-outreach',
      },
    }).catch(() => {});
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
