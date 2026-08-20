import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, requirePermission, AuthRequest } from '../middleware/auth';
import { activeDocuments, missingRequiredConsents, recordConsents, clientIp } from '../services/legal';
import { buildContract, PLATFORM } from '../services/sellerContract';
import { isDocusignConfigured, sendContractForSignature, downloadSignedPdf, mapEnvelopeStatus } from '../services/docusign';

const router = Router();
const prisma = new PrismaClient();

// ── AÇIQ: sənədlərin mətni ────────────────────────────────────────────────
// Giriş tələb olunmur — hüquqi sənədlər hamıya açıq olmalıdır.
router.get('/legal', async (_req: Request, res: Response) => {
  try {
    const docs = await activeDocuments();
    res.json({ success: true, documents: docs.map((d) => ({ slug: d.slug, title: d.title, version: d.version, publishedAt: d.publishedAt, requiredForPurchase: d.requiredForPurchase })) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.get('/legal/:slug', async (req: Request, res: Response) => {
  try {
    const doc = await prisma.legalDocument.findFirst({
      where: { slug: String(req.params.slug), isActive: true },
      orderBy: { version: 'desc' },
    });
    if (!doc) { res.status(404).json({ success: false, message: 'Sənəd tapılmadı' }); return; }
    res.json({ success: true, document: doc });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── İSTİFADƏÇİ: qəbul ─────────────────────────────────────────────────────
// Nə qəbul etmişəm, nə qalıb.
router.get('/me/consents', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const [accepted, missing] = await Promise.all([
      prisma.userConsent.findMany({
        where: { userId: req.adminId! },
        select: { slug: true, version: true, acceptedAt: true },
        orderBy: { acceptedAt: 'desc' },
      }),
      missingRequiredConsents(req.adminId!),
    ]);
    res.json({ success: true, accepted, missing, canPurchase: missing.length === 0 });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Qəbul et. Body: { slugs: ["user-agreement", ...] } — boş buraxılsa BÜTÜN
// məcburi sənədlər qəbul edilmiş sayılır (bir qutu = üç sənəd).
router.post('/me/consents', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    let slugs: string[] = Array.isArray(req.body?.slugs) ? req.body.slugs.map(String) : [];
    if (!slugs.length) {
      const req_ = await missingRequiredConsents(req.adminId!);
      slugs = req_.map((d) => d.slug);
      // Hamısı artıq qəbul edilibsə də sorğu uğurlu sayılır (idempotent).
      if (!slugs.length) { res.json({ success: true, recorded: 0, canPurchase: true }); return; }
    }
    const n = await recordConsents(req.adminId!, slugs, clientIp(req), String(req.headers['user-agent'] || ''));
    const missing = await missingRequiredConsents(req.adminId!);
    res.json({ success: true, recorded: n, missing, canPurchase: missing.length === 0 });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── ADMIN: kim nəyi nə vaxt qəbul edib ────────────────────────────────────
router.get('/admin/consents', requirePermission('users'), async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.search || '').trim();
    const rows = await prisma.userConsent.findMany({
      where: q ? { user: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }] } } : {},
      include: { user: { select: { id: true, name: true, phone: true } } },
      orderBy: { acceptedAt: 'desc' },
      take: 300,
    });
    res.json({ success: true, rows });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Sənədin mətnini yenilə — YENİ VERSİYA yaradır, köhnəsi tarixçə üçün qalır.
// Köhnə versiyanı əzmək olmaz: ona istinad edən qəbul qeydləri var.
router.put('/admin/legal/:slug', requirePermission('content'), async (req: AuthRequest, res: Response) => {
  try {
    const slug = String(req.params.slug);
    const body = String(req.body?.body || '');
    const title = String(req.body?.title || '').trim();
    if (!body.trim()) { res.status(400).json({ success: false, message: 'Mətn boş ola bilməz' }); return; }
    const cur = await prisma.legalDocument.findFirst({ where: { slug }, orderBy: { version: 'desc' } });
    if (!cur) { res.status(404).json({ success: false, message: 'Sənəd tapılmadı' }); return; }
    if (cur.body === body && (!title || cur.title === title)) {
      res.json({ success: true, unchanged: true, document: cur }); return;
    }
    const [, created] = await prisma.$transaction([
      prisma.legalDocument.updateMany({ where: { slug }, data: { isActive: false } }),
      prisma.legalDocument.create({
        data: {
          slug, version: cur.version + 1, title: title || cur.title, body,
          requiredForPurchase: cur.requiredForPurchase, isActive: true,
        },
      }),
    ]);
    res.json({ success: true, document: created });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── SATICI MÜQAVİLƏSİ (DocuSign) ─────────────────────────────────────────

// Dolmuş müqavilə mətni — satıcı imzalamazdan ƏVVƏL görür.
router.get('/me/businesses/:id/contract', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const biz = await prisma.business.findUnique({
      where: { id },
      select: { userId: true, status: true, contractStatus: true, contractSignedAt: true, contractSentAt: true, contractPdf: true },
    });
    if (!biz || biz.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const c = await buildContract(id);
    res.json({
      success: true,
      contractStatus: biz.contractStatus,
      sentAt: biz.contractSentAt, signedAt: biz.contractSignedAt, hasPdf: !!biz.contractPdf,
      businessApproved: biz.status === 'APPROVED',
      docusignReady: isDocusignConfigured(),
      ready: c.ok, missing: c.missing || [], message: c.message,
      text: c.text || null, party: c.party || null,
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// İmzaya göndər. Biznes ADMİN TƏRƏFİNDƏN TƏSDİQLƏNMƏYİNCƏ göndərilmir —
// yoxlanmamış biznesə müqavilə göndərmək düzgün deyil.
router.post('/me/businesses/:id/contract/send', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const biz = await prisma.business.findUnique({
      where: { id },
      select: { userId: true, name: true, status: true, contractStatus: true, user: { select: { name: true, email: true } } },
    });
    if (!biz || biz.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (biz.status !== 'APPROVED') { res.status(400).json({ success: false, message: 'Biznes təsdiqlənməyincə müqavilə imzaya göndərilmir' }); return; }
    if (biz.contractStatus === 'SIGNED') { res.status(400).json({ success: false, message: 'Müqavilə artıq imzalanıb' }); return; }
    if (!biz.user.email) { res.status(400).json({ success: false, message: 'İmza dəvəti üçün e-poçt ünvanı lazımdır — profilinizə əlavə edin' }); return; }

    const c = await buildContract(id);
    if (!c.ok || !c.text || !c.party) {
      res.status(400).json({ success: false, message: c.message || 'Müqavilə hazır deyil', missing: c.missing || [] });
      return;
    }
    const platformEmail = process.env.PLATFORM_EMAIL || '';
    if (!platformEmail) { res.status(500).json({ success: false, message: 'PLATFORM_EMAIL təyin edilməyib' }); return; }

    const r = await sendContractForSignature({
      title: `Satıcı ilə Əməkdaşlıq Müqaviləsi — ${biz.name}`,
      text: c.text,
      // Əvvəlcə satıcı, sonra platforma imzalayır.
      seller: { name: c.party.signerName || biz.user.name, email: biz.user.email, order: 1 },
      platform: { name: PLATFORM.director, email: platformEmail, order: 2 },
    });
    if (!r.ok) { res.status(502).json({ success: false, message: r.message }); return; }

    await prisma.business.update({
      where: { id },
      data: { contractStatus: 'SENT', contractEnvelopeId: r.envelopeId, contractSentAt: new Date(), contractVersion: c.version },
    });
    res.json({ success: true, envelopeId: r.envelopeId });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// İmzalanmış PDF-i endir.
router.get('/me/businesses/:id/contract/pdf', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const biz = await prisma.business.findUnique({ where: { id }, select: { userId: true, contractEnvelopeId: true, contractStatus: true } });
    if (!biz || biz.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (!biz.contractEnvelopeId) { res.status(404).json({ success: false, message: 'Müqavilə göndərilməyib' }); return; }
    const r = await downloadSignedPdf(biz.contractEnvelopeId);
    if (!r.ok || !r.buffer) { res.status(502).json({ success: false, message: r.message }); return; }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="muqavile-${id}.pdf"`);
    res.send(r.buffer);
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// DocuSign webhook (Connect). Zərf statusu dəyişəndə çağırılır.
router.post('/docusign/callback', async (req: Request, res: Response) => {
  res.status(200).send('OK');   // DocuSign 200 gözləyir — emal fonda
  try {
    const b: any = req.body || {};
    const envelopeId = b?.data?.envelopeId || b?.envelopeId;
    const status = b?.data?.envelopeSummary?.status || b?.status || b?.event;
    if (!envelopeId) return;
    const mapped = mapEnvelopeStatus(String(status || ''));
    if (!mapped) return;
    const biz = await prisma.business.findFirst({ where: { contractEnvelopeId: String(envelopeId) }, select: { id: true, userId: true, name: true } });
    if (!biz) return;
    await prisma.business.update({
      where: { id: biz.id },
      data: { contractStatus: mapped, ...(mapped === 'SIGNED' ? { contractSignedAt: new Date() } : {}) },
    });
    if (mapped === 'SIGNED') {
      await prisma.notification.create({
        data: { userId: biz.userId, type: 'SYSTEM', title: 'Müqavilə imzalandı ✅', body: `"${biz.name}" üçün Satıcı Müqaviləsi hər iki tərəf tərəfindən imzalandı.`, link: '/business' },
      }).catch(() => {});
    }
  } catch (e: any) { console.error('[docusign callback]', e?.message); }
});

export default router;
