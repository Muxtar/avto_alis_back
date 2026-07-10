import { Router, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';

const router = Router();
const prisma = new PrismaClient();

// Kontakt əməliyyatları — spam qoruması: 60 istek / saat (bulk sinxron nəzərə alınıb).
const contactLimiter = rateLimit(60, 60 * 60 * 1000);

// Yalnız rəqəmlər (uyğunlaşdırma açarı). Ən azı 7 rəqəm tələb olunur.
function digits(s: any): string {
  return String(s || '').replace(/\D/g, '');
}
// Uyğunlaşdırma son 9 rəqəm üzərindən gedir (AZ nömrələri +994 ilə/siz, boşluqlu/suz
// fərqli formatlarda saxlanıla bilər — son 9 rəqəm hamısında eynidir).
function last9(s: string): string {
  return s.slice(-9);
}

// Kontaktlara qeydiyyatlı istifadəçiləri bağla (bir sorğu ilə, son 9 rəqəm üzrə).
async function attachMatches(contacts: { id: number; name: string; phone: string; phoneDigits: string; createdAt: Date }[]) {
  if (contacts.length === 0) return [];
  const keys = Array.from(new Set(contacts.map((c) => last9(c.phoneDigits)).filter((k) => k.length >= 7)));
  let matched: { id: number; name: string; avatar: string | null; d9: string }[] = [];
  if (keys.length > 0) {
    // Köhnə istifadəçilərdə telefon boşluqlu saxlanıla bilər — SQL-də rəqəmlərə salıb müqayisə edirik.
    matched = await prisma.$queryRaw<{ id: number; name: string; avatar: string | null; d9: string }[]>(
      Prisma.sql`SELECT id, name, avatar, right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) AS d9
                 FROM "User"
                 WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = ANY(${keys})
                   AND type != 'COURIER'`
    );
  }
  const byKey = new Map(matched.map((u) => [u.d9, u]));
  return contacts.map((c) => {
    const u = byKey.get(last9(c.phoneDigits));
    return {
      id: c.id, name: c.name, phone: c.phone, createdAt: c.createdAt,
      // Platformada qeydiyyatlıdırsa — profil/mesaj üçün istifadəçi məlumatı.
      user: u ? { id: u.id, name: u.name, avatar: u.avatar } : null,
    };
  });
}

// Kontaktlarım — qeydiyyat uyğunluğu ilə birlikdə.
router.get('/me/contacts', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const contacts = await prisma.contact.findMany({
      where: { ownerId: req.adminId! },
      orderBy: { name: 'asc' },
    });
    res.json({ success: true, contacts: await attachMatches(contacts) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Kontakt əlavə et.
router.post('/me/contacts', contactLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80);
    const phone = String(req.body.phone || '').trim().slice(0, 30);
    const pd = digits(phone);
    if (!name) { res.status(400).json({ success: false, message: 'Ad tələb olunur' }); return; }
    if (pd.length < 7) { res.status(400).json({ success: false, message: 'Düzgün nömrə yazın (ən azı 7 rəqəm)' }); return; }
    const contact = await prisma.contact.create({
      data: { ownerId: req.adminId!, name, phone, phoneDigits: pd },
    });
    const [withMatch] = await attachMatches([contact]);
    res.status(201).json({ success: true, contact: withMatch });
  } catch (e: any) {
    if (e?.code === 'P2002') { res.status(400).json({ success: false, message: 'Bu nömrə artıq kontaktlarınızdadır' }); return; }
    res.status(400).json({ success: false, message: e.message });
  }
});

// Toplu əlavə — gələcəkdə telefon kontaktlarının sinxronu üçün.
// Mövcud nömrələr atlanır (idempotent), maksimum 500 kontakt / sorğu.
router.post('/me/contacts/bulk', contactLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const raw = Array.isArray(req.body.contacts) ? req.body.contacts.slice(0, 500) : [];
    const clean = raw
      .map((c: any) => ({
        name: String(c?.name || '').trim().slice(0, 80),
        phone: String(c?.phone || '').trim().slice(0, 30),
        phoneDigits: digits(c?.phone),
      }))
      .filter((c: any) => c.name && c.phoneDigits.length >= 7);
    if (clean.length === 0) { res.status(400).json({ success: false, message: 'Əlavə ediləcək kontakt yoxdur' }); return; }
    const result = await prisma.contact.createMany({
      data: clean.map((c: any) => ({ ...c, ownerId: req.adminId! })),
      skipDuplicates: true,
    });
    res.json({ success: true, added: result.count, total: clean.length });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Kontaktı redaktə et (ad/nömrə).
router.put('/me/contacts/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const c = await prisma.contact.findUnique({ where: { id }, select: { ownerId: true } });
    if (!c || c.ownerId !== req.adminId) { res.status(404).json({ success: false, message: 'Kontakt tapılmadı' }); return; }
    const data: any = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim().slice(0, 80);
      if (!name) { res.status(400).json({ success: false, message: 'Ad boş ola bilməz' }); return; }
      data.name = name;
    }
    if (req.body.phone !== undefined) {
      const phone = String(req.body.phone).trim().slice(0, 30);
      const pd = digits(phone);
      if (pd.length < 7) { res.status(400).json({ success: false, message: 'Düzgün nömrə yazın' }); return; }
      data.phone = phone;
      data.phoneDigits = pd;
    }
    const updated = await prisma.contact.update({ where: { id }, data });
    const [withMatch] = await attachMatches([updated]);
    res.json({ success: true, contact: withMatch });
  } catch (e: any) {
    if (e?.code === 'P2002') { res.status(400).json({ success: false, message: 'Bu nömrə artıq kontaktlarınızdadır' }); return; }
    res.status(400).json({ success: false, message: e.message });
  }
});

// Kontaktı sil.
router.delete('/me/contacts/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const c = await prisma.contact.findUnique({ where: { id }, select: { ownerId: true } });
    if (!c || c.ownerId !== req.adminId) { res.status(404).json({ success: false, message: 'Kontakt tapılmadı' }); return; }
    await prisma.contact.delete({ where: { id } });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
