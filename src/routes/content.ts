// CMS səhifələri — admin paneldən redaktə olunan məzmun (about/terms/privacy/faq).
// Public: GET /pages/:slug (yalnız published). Admin: CRUD ('content' icazəsi).
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { requirePermission, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

function slugify(s: string): string {
  return String(s || '').toLowerCase().trim()
    .replace(/[əğıöşçü]/g, (c) => ({ ə: 'e', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ç: 'c', ü: 'u' } as any)[c] || c)
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// ── Public ──
router.get('/pages/:slug', async (req: Request, res: Response) => {
  try {
    const page = await prisma.page.findUnique({ where: { slug: String(req.params.slug) } });
    if (!page || !page.published) { res.status(404).json({ success: false, message: 'Səhifə tapılmadı' }); return; }
    res.json({ success: true, page: { slug: page.slug, title: page.title, content: page.content, updatedAt: page.updatedAt } });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Public: bütün açıq səhifələrin siyahısı (footer üçün).
router.get('/pages', async (_req: Request, res: Response) => {
  try {
    const pages = await prisma.page.findMany({ where: { published: true }, select: { slug: true, title: true }, orderBy: { title: 'asc' } });
    res.json({ success: true, pages });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Admin ──
router.get('/admin/pages', requirePermission('content'), async (_req: AuthRequest, res: Response) => {
  try {
    const pages = await prisma.page.findMany({ orderBy: { updatedAt: 'desc' } });
    res.json({ success: true, pages });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.get('/admin/pages/:id', requirePermission('content'), async (req: AuthRequest, res: Response) => {
  try {
    const page = await prisma.page.findUnique({ where: { id: parseInt(String(req.params.id)) } });
    if (!page) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    res.json({ success: true, page });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.post('/admin/pages', requirePermission('content'), async (req: AuthRequest, res: Response) => {
  try {
    const title = String(req.body?.title || '').trim().slice(0, 200);
    const content = String(req.body?.content || '');
    let slug = String(req.body?.slug || '').trim() || slugify(title);
    slug = slugify(slug);
    if (!title || !slug) { res.status(400).json({ success: false, message: 'Başlıq və slug tələb olunur' }); return; }
    const published = req.body?.published !== false;
    const page = await prisma.page.create({ data: { slug, title, content, published, updatedById: req.adminId! } });
    res.json({ success: true, page });
  } catch (e: any) {
    if (e?.code === 'P2002') { res.status(400).json({ success: false, message: 'Bu slug artıq mövcuddur' }); return; }
    res.status(400).json({ success: false, message: e.message });
  }
});

router.put('/admin/pages/:id', requirePermission('content'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const data: any = { updatedById: req.adminId! };
    if (req.body?.title !== undefined) data.title = String(req.body.title).trim().slice(0, 200);
    if (req.body?.content !== undefined) data.content = String(req.body.content);
    if (req.body?.slug !== undefined) data.slug = slugify(String(req.body.slug));
    if (req.body?.published !== undefined) data.published = !!req.body.published;
    const page = await prisma.page.update({ where: { id }, data });
    res.json({ success: true, page });
  } catch (e: any) {
    if (e?.code === 'P2002') { res.status(400).json({ success: false, message: 'Bu slug artıq mövcuddur' }); return; }
    res.status(400).json({ success: false, message: e.message });
  }
});

router.delete('/admin/pages/:id', requirePermission('content'), async (req: AuthRequest, res: Response) => {
  try {
    await prisma.page.delete({ where: { id: parseInt(String(req.params.id)) } });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
