// Sosial media müraciəti (outreach) — istifadəçi websearch-də tapdığı şəxsə
// mesaj yazır, mesaj ADMİN PANELƏ düşür, admin həmin hesaba ƏLLƏ göndərir.
import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, requirePermission, AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { socialKeyOf } from '../services/pendingInvites';

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

// ── Admin: SOSİAL PROFİLLƏRƏ YAZILAN (hələ çatdırılmamış) MESAJLAR ─────────────
// İstifadəçi çat axtarışında internetdə tapdığı profilə yazır → mesaj gözləyir.
// Adminin işi: saytın rəsmi sosial hesabından həmin profilə xəbər vermək
// («sizə N nəfər yazıb, qeydiyyatdan keçib hesabınızı təsdiqləyin»).
// Hər profil bir sətirdir: kim yazıb, neçə mesaj, Rəy sorğusu, xəbər verilibmi.
type SocialRow = {
  key: string; platform: string; handle: string; url: string | null; name: string | null; avatar: string | null;
  senders: Map<number, number>; messages: number; consults: number; media: number;
  firstAt: Date; lastAt: Date; pending: number; deliveredTo: number | null; deliveredAt: Date | null; previews: string[];
};
async function socialRows(): Promise<SocialRow[]> {
  const list = await prisma.pendingInvite.findMany({ where: { social: { not: null } }, orderBy: { id: 'asc' }, take: 5000 });
  const rows = new Map<string, SocialRow>();
  for (const i of list) {
    const key = i.social!;
    let r = rows.get(key);
    if (!r) {
      const [platform, handle] = key.split(':');
      r = { key, platform, handle, url: i.targetUrl, name: i.targetName, avatar: i.targetAvatar, senders: new Map(), messages: 0, consults: 0, media: 0, firstAt: i.createdAt, lastAt: i.createdAt, pending: 0, deliveredTo: null, deliveredAt: null, previews: [] };
      rows.set(key, r);
    }
    r.senders.set(i.senderId, (r.senders.get(i.senderId) || 0) + 1);
    if (i.kind === 'CONSULTATION') r.consults++; else r.messages++;
    if (i.payload) r.media++;
    r.lastAt = i.createdAt;
    if (i.targetAvatar) r.avatar = i.targetAvatar;
    if (i.targetName) r.name = i.targetName;
    if (!i.deliveredAt) { r.pending++; if (i.content && r.previews.length < 3) r.previews.push(i.content.slice(0, 160)); }
    else if (i.deliveredToId) { r.deliveredTo = i.deliveredToId; r.deliveredAt = i.deliveredAt; }
  }
  return [...rows.values()];
}

router.get('/admin/social-invites', requirePermission('outreach'), async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.query.status || 'TODO'); // TODO | NOTIFIED | DELIVERED | ALL
    const q = String(req.query.q || '').trim().toLowerCase();
    const rows = await socialRows();
    const notices = await prisma.socialTargetNotice.findMany({ where: { social: { in: rows.map((r) => r.key) } } });
    const nById = new Map(notices.map((n) => [n.social, n]));
    // İstifadəçilərin xüsusi «Adminlər xəbər versin» müraciətləri (köhnə axın) — eyni profil.
    const outreach = await prisma.socialOutreach.findMany({ where: { status: 'PENDING' }, select: { targetPlatform: true, targetUrl: true } });
    const reqCount = new Map<string, number>();
    for (const o of outreach) { const k = socialKeyOf(o.targetPlatform, o.targetUrl); if (k) reqCount.set(k, (reqCount.get(k) || 0) + 1); }

    const userIds = new Set<number>();
    rows.forEach((r) => { r.senders.forEach((_, id) => userIds.add(id)); if (r.deliveredTo) userIds.add(r.deliveredTo); });
    const users = userIds.size ? await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, phone: true } }) : [];
    const uById = new Map(users.map((u) => [u.id, u]));

    const all = rows.map((r) => {
      const n = nById.get(r.key);
      const state = r.pending === 0 && r.deliveredTo ? 'DELIVERED' : n?.notifiedAt && n.notifiedAt >= r.lastAt ? 'NOTIFIED' : 'TODO';
      return {
        key: r.key, platform: r.platform, handle: r.handle, url: r.url, name: r.name, avatar: r.avatar,
        senders: [...r.senders.entries()].map(([id, count]) => ({ id, count, name: uById.get(id)?.name || `#${id}`, phone: uById.get(id)?.phone || null })),
        messages: r.messages, consults: r.consults, media: r.media, pending: r.pending,
        firstAt: r.firstAt, lastAt: r.lastAt, previews: r.previews, requested: reqCount.get(r.key) || 0,
        state, notice: n ? { notifiedAt: n.notifiedAt, by: n.notifiedByName, times: n.timesNotified, note: n.note } : null,
        deliveredTo: r.deliveredTo ? { id: r.deliveredTo, name: uById.get(r.deliveredTo)?.name || null, at: r.deliveredAt } : null,
      };
    });
    const counts = { TODO: 0, NOTIFIED: 0, DELIVERED: 0, ALL: all.length };
    all.forEach((x) => { (counts as any)[x.state]++; });
    const items = all
      .filter((x) => status === 'ALL' || x.state === status)
      .filter((x) => !q || [x.name, x.handle, x.platform, ...x.senders.map((s) => s.name)].some((v) => String(v || '').toLowerCase().includes(q)))
      .sort((a, b) => (b.requested - a.requested) || (+new Date(b.lastAt) - +new Date(a.lastAt)));
    res.json({ success: true, items, counts });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Admin rəsmi hesabdan xəbər verdi → qeyd olunur, yazanlara bildiriş gedir,
// həmin profilə aid «Adminlər xəbər versin» müraciətləri də bağlanır.
router.post('/admin/social-invites/notified', requirePermission('outreach'), async (req: AuthRequest, res: Response) => {
  try {
    const key = String(req.body?.key || '').toLowerCase();
    const note = String(req.body?.note || '').trim().slice(0, 500) || null;
    const invites = await prisma.pendingInvite.findMany({ where: { social: key, deliveredAt: null }, select: { senderId: true, targetName: true, targetUrl: true } });
    if (!invites.length) { res.status(404).json({ success: false, message: 'Bu profilə gözləyən mesaj yoxdur' }); return; }
    const by = req.adminName || 'Admin';
    await prisma.socialTargetNotice.upsert({
      where: { social: key },
      update: { notifiedAt: new Date(), notifiedById: req.adminId!, notifiedByName: by, timesNotified: { increment: 1 }, note },
      create: { social: key, notifiedAt: new Date(), notifiedById: req.adminId!, notifiedByName: by, timesNotified: 1, note },
    });
    const name = invites[0].targetName || key.split(':')[1];
    const senders = [...new Set(invites.map((i) => i.senderId))];
    await prisma.notification.createMany({ data: senders.map((userId) => ({ userId, type: 'SYSTEM', title: 'Xəbər verildi ✓', body: `«${name}» profilinə saytın rəsmi hesabından yazdığınız barədə xəbər verildi. O qoşulanda mesajlarınız çatacaq.`, link: '/messages' })) }).catch(() => {});
    const out = await prisma.socialOutreach.findMany({ where: { status: 'PENDING' }, select: { id: true, targetPlatform: true, targetUrl: true } });
    const ids = out.filter((o) => socialKeyOf(o.targetPlatform, o.targetUrl) === key).map((o) => o.id);
    if (ids.length) await prisma.socialOutreach.updateMany({ where: { id: { in: ids } }, data: { status: 'SENT', sentById: req.adminId!, sentByName: by, sentAt: new Date(), adminNote: note } });
    res.json({ success: true, notifiedSenders: senders.length, closedRequests: ids.length });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
