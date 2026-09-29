// Platformada olmayan şəxsə mesaj / Rəy sorğusu (services/pendingInvites).
// Hədəf iki cür ola bilər:
//   • NÖMRƏ — kontakta əlavə edilmiş qeydiyyatsız nömrə; həmin nömrə ilə qeydiyyatda çatır.
//   • SOSİAL HESAB — chat axtarışında internetdə tapılan profil (məs. Facebook); həmin
//     hesabı öz profilində TƏSDİQLƏYƏN istifadəçiyə çatır (bio kodu / admin yoxlaması).
import { Router, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { phoneKeyOf, socialKeyOf, DEFAULT_CONSULT_MIN } from '../services/pendingInvites';

const router = Router();
const prisma = new PrismaClient();
const inviteLimiter = rateLimit(60, 60 * 60 * 1000); // spam qoruması: 60 / saat
const MAX_PENDING_PER_TARGET = 50;
const MAX_SOCIAL_TARGETS_PER_DAY = 20; // tanımadığı çox adama yazmaq — spam

type Target = { phoneKey?: string; social?: string };

/** Nömrə platformada varmı (son 9 rəqəm). */
async function userByPhone(key: string) {
  const rows = await prisma.$queryRaw<{ id: number; name: string; avatar: string | null }[]>(
    Prisma.sql`SELECT id, name, avatar FROM "User"
               WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = ${key} AND type != 'COURIER' LIMIT 1`,
  );
  return rows[0] || null;
}
/** Bu sosial hesabı artıq TƏSDİQLƏMİŞ istifadəçi. */
async function userBySocial(key: string) {
  const [platform] = key.split(':');
  const links = await prisma.socialLink.findMany({
    where: { platform, verified: true },
    select: { url: true, platform: true, user: { select: { id: true, name: true, avatar: true } } },
  });
  return links.find((l) => socialKeyOf(l.platform, l.url) === key)?.user || null;
}
const registeredFor = (t: Target) => (t.phoneKey ? userByPhone(t.phoneKey) : userBySocial(t.social!));

/** URL-dəki açar: rəqəmlər → nömrə, «platforma:ad» → sosial hesab. */
function targetOfKey(raw: string): Target | null {
  const k = decodeURIComponent(raw || '').trim().toLowerCase();
  if (k.includes(':')) { const [p, h] = k.split(':'); return /^[a-z]+$/.test(p) && /^[a-z0-9._-]{2,80}$/.test(h || '') ? { social: k } : null; }
  const d = phoneKeyOf(k);
  return d.length >= 7 ? { phoneKey: d } : null;
}

// Gözləyən söhbətlər — hər hədəf bir sətir (çat siyahısında «⏳ qeydiyyatsız»).
router.get('/me/invites', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const list = await prisma.pendingInvite.findMany({ where: { senderId: req.adminId!, deliveredAt: null }, orderBy: { id: 'desc' }, take: 500 });
    const contacts = await prisma.contact.findMany({ where: { ownerId: req.adminId! }, select: { name: true, phoneDigits: true } });
    const nameOf = new Map(contacts.map((c) => [phoneKeyOf(c.phoneDigits), c.name]));
    const threads = new Map<string, any>();
    for (const i of list) {
      const key = i.social || i.phoneKey!;
      if (!threads.has(key)) {
        threads.set(key, i.social
          ? { key, social: i.social, platform: i.social.split(':')[0], url: i.targetUrl, name: i.targetName || i.social.split(':')[1], avatar: i.targetAvatar, last: i, count: 0, consults: 0 }
          : { key, phoneKey: i.phoneKey, phone: i.phone, name: nameOf.get(i.phoneKey!) || i.phone, last: i, count: 0, consults: 0 });
      }
      const t = threads.get(key); t.count++; if (i.kind === 'CONSULTATION') t.consults++;
    }
    res.json({ success: true, threads: [...threads.values()] });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Bir hədəfə yazılanlar (köhnədən yeniyə).
async function threadOf(req: AuthRequest, res: Response, t: Target | null) {
  try {
    if (!t) { res.status(400).json({ success: false, message: 'Hədəf düzgün deyil' }); return; }
    const u = await registeredFor(t);
    const items = await prisma.pendingInvite.findMany({ where: { senderId: req.adminId!, deliveredAt: null, ...t }, orderBy: { id: 'asc' } });
    res.json({ success: true, items, registered: u, key: t.social || t.phoneKey });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
}
// Axtarışda tapılan profil üçün: ?platform=facebook&url=https://facebook.com/ad
router.get('/me/invites/social', adminAuth, (req: AuthRequest, res: Response) => {
  const k = socialKeyOf(String(req.query.platform || ''), String(req.query.url || ''));
  return threadOf(req, res, k ? { social: k } : null);
});
// :key = nömrə və ya «facebook:ad».
router.get('/me/invites/:key', adminAuth, (req: AuthRequest, res: Response) => threadOf(req, res, targetOfKey(String(req.params.key))));

/**
 * Gözləyən mesaj yarat. b = { phone } və ya { social: { platform, url, name?, avatar? } },
 * kind = MESSAGE | CONSULTATION. payload — media/konum/kontakt mesajlarının sahələri
 * (çat pəncərəsindən adi mesaj kimi göndərilir, routes/messages.ts).
 */
export async function createPending(senderId: number, b: any, payload?: Record<string, any>): Promise<{ status: number; body: any }> {
  const kind = b.kind === 'CONSULTATION' ? 'CONSULTATION' : 'MESSAGE';
  const content = String(b.content || '').trim().slice(0, 2000);
  if (kind === 'MESSAGE' && !content && !payload) { return { status: 400, body: { success: false, message: 'Mesaj boş ola bilməz' } }; }

  let target: Target;
  const data: any = {};
  if (b.social) {
    const sp = b.social;
    const url = String(sp.url || '').trim().slice(0, 500);
    if (!/^https:\/\//i.test(url)) { return { status: 400, body: { success: false, message: 'Profil linki yanlışdır' } }; }
    const social = socialKeyOf(String(sp.platform || ''), url);
    if (!social) { return { status: 400, body: { success: false, message: 'Bu link şəxsi profil deyil (paylaşım/qrup/səhifə linkinə yazmaq olmaz)' } }; }
    target = { social };
    Object.assign(data, {
      social, targetUrl: url,
      targetName: String(sp.name || '').trim().slice(0, 120) || social.split(':')[1],
      targetAvatar: sp.avatar ? String(sp.avatar).slice(0, 500) : null,
    });
    const mine = await prisma.socialLink.findMany({ where: { userId: senderId }, select: { platform: true, url: true } });
    if (mine.some((l) => socialKeyOf(l.platform, l.url) === social)) { return { status: 400, body: { success: false, message: 'Bu sizin öz hesabınızdır' } }; }
    // Yeni (əvvəl yazılmamış) sosial hədəflər — gündə limit.
    const already = await prisma.pendingInvite.count({ where: { senderId: senderId, social } });
    if (!already) {
      const since = new Date(Date.now() - 864e5);
      const recent = await prisma.pendingInvite.findMany({ where: { senderId: senderId, social: { not: null }, createdAt: { gte: since } }, select: { social: true }, distinct: ['social'] });
      if (recent.length >= MAX_SOCIAL_TARGETS_PER_DAY) { return { status: 429, body: { success: false, message: `Gündə ən çox ${MAX_SOCIAL_TARGETS_PER_DAY} yeni sosial profilə yazmaq olar` } }; }
    }
  } else {
    const phone = String(b.phone || '').trim().slice(0, 30);
    const phoneKey = phoneKeyOf(phone);
    if (phoneKey.length < 7) { return { status: 400, body: { success: false, message: 'Düzgün nömrə yazın' } }; }
    const me = await prisma.user.findUnique({ where: { id: senderId }, select: { phone: true } });
    if (phoneKeyOf(me?.phone) === phoneKey) { return { status: 400, body: { success: false, message: 'Özünüzə yaza bilməzsiniz' } }; }
    target = { phoneKey };
    Object.assign(data, { phone, phoneKey });
  }

  // Artıq platformadadırsa — adi söhbət/Rəy yolu (frontend həmin istifadəçini açır).
  const u = await registeredFor(target);
  if (u) { return { status: 409, body: { success: false, code: 'REGISTERED', user: u, message: 'Bu şəxs artıq platformadadır' } }; }
  const pending = await prisma.pendingInvite.count({ where: { senderId: senderId, deliveredAt: null, ...target } });
  if (pending >= MAX_PENDING_PER_TARGET) { return { status: 429, body: { success: false, message: `Bu şəxsə ${MAX_PENDING_PER_TARGET} gözləyən mesaj həddi dolub` } }; }
  if (kind === 'CONSULTATION' && await prisma.pendingInvite.count({ where: { senderId: senderId, kind, deliveredAt: null, ...target } })) {
    return { status: 400, body: { success: false, message: 'Bu şəxsə artıq Rəy sorğusu göndərmisiniz — platformaya qoşulanda çatacaq' } };
  }
  const durationMinutes = kind === 'CONSULTATION' ? Math.max(5, Math.min(600, parseInt(String(b.durationMinutes)) || DEFAULT_CONSULT_MIN)) : null;
  const item = await prisma.pendingInvite.create({ data: { senderId, kind, content, durationMinutes, ...data, ...(payload ? { payload } : {}) } });
  return { status: 201, body: { success: true, item } };
}

// Yaz (mətn / Rəy sorğusu).
router.post('/me/invites', inviteLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const r = await createPending(req.adminId!, req.body);
    res.status(r.status).json(r.body);
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Hədəfə yazılmış bütün çatdırılmamış mesajları sil (söhbəti sil).
router.delete('/me/invites/thread/:key', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const t = targetOfKey(String(req.params.key));
    if (!t) { res.status(400).json({ success: false, message: 'Hədəf düzgün deyil' }); return; }
    const r = await prisma.pendingInvite.deleteMany({ where: { senderId: req.adminId!, deliveredAt: null, ...t } });
    res.json({ success: true, deleted: r.count });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Hələ çatdırılmamış mesajı / sorğunu geri götür.
router.delete('/me/invites/item/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const r = await prisma.pendingInvite.deleteMany({ where: { id: parseInt(String(req.params.id)), senderId: req.adminId!, deliveredAt: null } });
    res.json({ success: r.count > 0 });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
