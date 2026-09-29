// Qeydiyyatsız nömrəyə mesaj / Rəy sorğusu (services/pendingInvites).
import { Router, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { phoneKeyOf, DEFAULT_CONSULT_MIN } from '../services/pendingInvites';

const router = Router();
const prisma = new PrismaClient();
const inviteLimiter = rateLimit(60, 60 * 60 * 1000); // spam qoruması: 60 / saat
const MAX_PENDING_PER_PHONE = 50;

/** Nömrə platformada varmı (son 9 rəqəm) — varsa adi söhbət açılmalıdır. */
async function registeredUser(key: string) {
  const rows = await prisma.$queryRaw<{ id: number; name: string; avatar: string | null }[]>(
    Prisma.sql`SELECT id, name, avatar FROM "User"
               WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = ${key} AND type != 'COURIER' LIMIT 1`,
  );
  return rows[0] || null;
}

// Gözləyən söhbətlər — hər nömrə bir sətir (çat siyahısında «⏳ qeydiyyat gözlənilir»).
router.get('/me/invites', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const list = await prisma.pendingInvite.findMany({ where: { senderId: req.adminId!, deliveredAt: null }, orderBy: { id: 'desc' }, take: 500 });
    const contacts = await prisma.contact.findMany({ where: { ownerId: req.adminId! }, select: { name: true, phoneDigits: true } });
    const nameOf = new Map(contacts.map((c) => [phoneKeyOf(c.phoneDigits), c.name]));
    const threads = new Map<string, any>();
    for (const i of list) {
      if (!threads.has(i.phoneKey)) threads.set(i.phoneKey, { phoneKey: i.phoneKey, phone: i.phone, name: nameOf.get(i.phoneKey) || i.phone, last: i, count: 0, consults: 0 });
      const t = threads.get(i.phoneKey); t.count++; if (i.kind === 'CONSULTATION') t.consults++;
    }
    res.json({ success: true, threads: [...threads.values()] });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Bir nömrəyə yazılanlar (köhnədən yeniyə).
router.get('/me/invites/:phone', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const key = phoneKeyOf(String(req.params.phone));
    if (key.length < 7) { res.status(400).json({ success: false, message: 'Nömrə düzgün deyil' }); return; }
    const u = await registeredUser(key);
    const items = await prisma.pendingInvite.findMany({ where: { senderId: req.adminId!, phoneKey: key, deliveredAt: null }, orderBy: { id: 'asc' } });
    res.json({ success: true, items, registered: u });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Yaz: kind = MESSAGE (content) | CONSULTATION (content = qeyd, durationMinutes).
router.post('/me/invites', inviteLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const phone = String(req.body.phone || '').trim().slice(0, 30);
    const key = phoneKeyOf(phone);
    const kind = req.body.kind === 'CONSULTATION' ? 'CONSULTATION' : 'MESSAGE';
    const content = String(req.body.content || '').trim().slice(0, 2000);
    if (key.length < 7) { res.status(400).json({ success: false, message: 'Düzgün nömrə yazın' }); return; }
    if (kind === 'MESSAGE' && !content) { res.status(400).json({ success: false, message: 'Mesaj boş ola bilməz' }); return; }
    const me = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { phone: true } });
    if (phoneKeyOf(me?.phone) === key) { res.status(400).json({ success: false, message: 'Özünüzə yaza bilməzsiniz' }); return; }
    // Artıq qeydiyyatlıdırsa — adi söhbət/Rəy yolu (frontend həmin istifadəçini açır).
    const u = await registeredUser(key);
    if (u) { res.status(409).json({ success: false, code: 'REGISTERED', user: u, message: 'Bu nömrə artıq platformadadır' }); return; }
    const pending = await prisma.pendingInvite.count({ where: { senderId: req.adminId!, phoneKey: key, deliveredAt: null } });
    if (pending >= MAX_PENDING_PER_PHONE) { res.status(429).json({ success: false, message: `Bu nömrəyə ${MAX_PENDING_PER_PHONE} gözləyən mesaj həddi dolub` }); return; }
    if (kind === 'CONSULTATION' && await prisma.pendingInvite.count({ where: { senderId: req.adminId!, phoneKey: key, kind, deliveredAt: null } })) {
      res.status(400).json({ success: false, message: 'Bu nömrəyə artıq Rəy sorğusu göndərmisiniz — qeydiyyatdan keçəndə çatacaq' }); return;
    }
    const durationMinutes = kind === 'CONSULTATION' ? Math.max(5, Math.min(600, parseInt(String(req.body.durationMinutes)) || DEFAULT_CONSULT_MIN)) : null;
    const item = await prisma.pendingInvite.create({ data: { senderId: req.adminId!, phone, phoneKey: key, kind, content, durationMinutes } });
    res.status(201).json({ success: true, item });
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
