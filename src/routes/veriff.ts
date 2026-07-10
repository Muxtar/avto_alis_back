import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { isVeriffConfigured, createVeriffSession, verifyWebhookSignature, getVeriffDecision } from '../services/veriff';

const router = Router();
const prisma = new PrismaClient();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Veriff qərarını istifadəçiyə tətbiq et (webhook + əl ilə yoxlama üçün ortaq).
// approved → APPROVED + ad/FIN/doğum tarixi Veriff-dən; declined → REJECTED;
// resubmission/expired/abandoned → null (yenidən cəhd mümkün olsun).
async function applyDecision(userId: number, v: any): Promise<string> {
  const status = String(v?.status || '');
  const person = v?.person || {};
  const doc = v?.document || {};

  if (status === 'approved') {
    const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
    const bd = person.dateOfBirth && /^\d{4}-\d{2}-\d{2}/.test(String(person.dateOfBirth)) ? new Date(person.dateOfBirth) : null;
    await prisma.user.update({
      where: { id: userId },
      data: {
        idVerifyStatus: 'APPROVED',
        veriffStatus: status,
        ...(fullName ? { name: fullName } : {}),
        ...(person.idNumber || doc.number ? { idNumber: String(person.idNumber || doc.number) } : {}),
        ...(bd ? { birthDate: bd } : {}),
        ...(person.gender ? { gender: String(person.gender).toUpperCase().startsWith('M') ? 'Kişi' : 'Qadın' } : {}),
        idAiReason: 'Veriff: təsdiqləndi',
      },
    });
    await prisma.notification.create({
      data: { userId, type: 'SYSTEM', title: 'Kimlik təsdiqləndi ✅', body: 'Şəxsiyyətiniz Veriff ilə uğurla təsdiqləndi.', link: '/profile' },
    }).catch(() => {});
  } else if (status === 'declined') {
    await prisma.user.update({
      where: { id: userId },
      data: { idVerifyStatus: 'REJECTED', veriffStatus: status, idAiReason: `Veriff: rədd edildi${v?.reason ? ` — ${v.reason}` : ''}` },
    });
    await prisma.notification.create({
      data: { userId, type: 'SYSTEM', title: 'Kimlik təsdiqi alınmadı', body: 'Veriff doğrulaması rədd edildi. Yenidən cəhd edə bilərsiniz.', link: '/profile' },
    }).catch(() => {});
  } else if (['resubmission_requested', 'expired', 'abandoned'].includes(status)) {
    await prisma.user.update({
      where: { id: userId },
      data: { idVerifyStatus: null, veriffStatus: status, idAiReason: 'Veriff: yenidən təqdim tələb olunur' },
    });
    if (status === 'resubmission_requested') {
      await prisma.notification.create({
        data: { userId, type: 'SYSTEM', title: 'Kimlik: yenidən cəhd lazımdır', body: 'Veriff sənədi/selfieni yenidən çəkməyi xahiş edir. Profilinizdən təkrar başladın.', link: '/profile' },
      }).catch(() => {});
    }
  } else {
    // submitted/started və s. aralıq statuslar — yalnız xam statusu saxla.
    await prisma.user.update({ where: { id: userId }, data: { veriffStatus: status || null } }).catch(() => {});
  }
  return status;
}

// Frontend: Veriff qoşulub-qoşulmadığını öyrənir (hansı axını göstərmək üçün).
router.get('/veriff/status', adminAuth, async (_req: AuthRequest, res: Response) => {
  res.json({ success: true, configured: isVeriffConfigured() });
});

// İstifadəçi: doğrulama sessiyası yarat — qaytarılan URL-də sənəd + video-selfie çəkilir.
router.post('/me/veriff/session', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!isVeriffConfigured()) { res.status(400).json({ success: false, message: 'Veriff hazırda aktiv deyil' }); return; }
    const me = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { name: true, idVerifyStatus: true } });
    if (me?.idVerifyStatus === 'APPROVED') { res.status(400).json({ success: false, message: 'Kimliyiniz artıq təsdiqlənib' }); return; }

    const parts = (me?.name || '').trim().split(/\s+/);
    const r = await createVeriffSession({
      userId: req.adminId!,
      firstName: parts[0] || undefined,
      lastName: parts.slice(1).join(' ') || undefined,
      callbackUrl: `${FRONTEND_URL}/profile?veriff=done`,
    });
    if (!r.ok) { res.status(502).json({ success: false, message: r.error }); return; }

    await prisma.user.update({
      where: { id: req.adminId! },
      data: { veriffSessionId: r.sessionId, veriffStatus: 'created', idVerifyStatus: 'PENDING' },
    });
    res.json({ success: true, url: r.url, sessionId: r.sessionId });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// İstifadəçi: nəticəni əl ilə yoxla (webhook gecikərsə).
router.post('/me/veriff/check', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const me = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { veriffSessionId: true } });
    if (!me?.veriffSessionId) { res.status(400).json({ success: false, message: 'Aktiv Veriff sessiyası yoxdur' }); return; }
    const d = await getVeriffDecision(me.veriffSessionId);
    if (!d.ok) { res.status(502).json({ success: false, message: d.error }); return; }
    const v = d.data?.verification;
    if (!v || !v.status) { res.json({ success: true, status: 'pending' }); return; }
    const status = await applyDecision(req.adminId!, v);
    res.json({ success: true, status });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Veriff webhook — qərar bildirişi. HMAC imzası MÜTLƏQ yoxlanır.
// Veriff kabinetində Decision webhook URL: https://<backend>/api/veriff/callback
router.post('/veriff/callback', async (req: Request, res: Response) => {
  try {
    const signature = req.header('x-hmac-signature');
    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (!verifyWebhookSignature(rawBody, signature)) {
      // İmza yanlışdırsa qəbul etmə (saxta webhook qarşısı).
      res.status(401).json({ success: false, message: 'Yanlış imza' });
      return;
    }

    const v = req.body?.verification;
    if (v) {
      // İstifadəçini vendorData (bizim user id) və ya sessiya id ilə tap.
      let userId = v.vendorData ? parseInt(String(v.vendorData)) : NaN;
      if (Number.isNaN(userId) && v.id) {
        const u = await prisma.user.findFirst({ where: { veriffSessionId: String(v.id) }, select: { id: true } });
        if (u) userId = u.id;
      }
      if (!Number.isNaN(userId) && userId > 0) {
        await applyDecision(userId, v);
      }
    }
    // Veriff 5 saniyə ərzində 200 gözləyir (at-least-once — təkrarlar idempotentdir).
    res.json({ success: true });
  } catch {
    res.json({ success: true });
  }
});

export default router;
