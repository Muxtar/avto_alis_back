import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createSession, isAdminPhone } from '../middleware/auth';
import { verifyLimiter } from '../middleware/rateLimiter';
import { createOtp } from '../services/otp';

const router = Router();
const prisma = new PrismaClient();

// Send verification code — admin `otp_real` flag-ına görə WhatsApp və ya fake.
router.post('/verify/send', verifyLimiter, async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    const uid = parseInt(userId);
    const { code, delivered, showCode } = await createOtp(uid);
    res.json({ success: true, message: 'Doğrulama kodu göndərildi', delivered, ...(showCode && { code }) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Check verification code - returns JWT token on success
router.post('/verify/check', verifyLimiter, async (req: Request, res: Response) => {
  try {
    const { userId, code } = req.body;
    const uid = parseInt(userId);

    const record = await prisma.verificationCode.findFirst({
      where: { userId: uid, verified: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!record || record.code !== code) {
      res.status(400).json({ success: false, message: 'Kod yanlışdır və ya vaxtı keçib' });
      return;
    }

    // Bloklanmış istifadəçi daxil ola bilməz.
    const existing = await prisma.user.findUnique({ where: { id: uid }, select: { isBlocked: true, phone: true } });
    if (existing?.isBlocked) {
      res.status(403).json({ success: false, message: 'Hesabınız bloklanıb. Adminlə əlaqə saxlayın.' });
      return;
    }

    await prisma.verificationCode.update({ where: { id: record.id }, data: { verified: true } });
    // Nömrə ADMIN_PHONES-dadırsa istifadəçiyə admin rolu ver — eyni nömrə ilə
    // normal giriş də admin panelə çıxış verir.
    const promoteAdmin = isAdminPhone(existing?.phone);
    const user = await prisma.user.update({
      where: { id: uid },
      data: { verified: true, ...(promoteAdmin ? { role: 'ADMIN' } : {}) },
      select: { id: true, name: true, phone: true, type: true, role: true, profileComplete: true, sellerVerified: true },
    });

    const token = await createSession(user.id, req);
    res.json({ success: true, token, user, profileComplete: user.profileComplete });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Verify via Telegram ID
router.post('/verify/telegram', verifyLimiter, async (req: Request, res: Response) => {
  try {
    const { telegramId, code } = req.body;
    if (!telegramId || !code) {
      res.status(400).json({ success: false, message: 'telegramId və code tələb olunur' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { telegramId: String(telegramId) } });
    if (!user) {
      res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' });
      return;
    }

    const record = await prisma.verificationCode.findFirst({
      where: { userId: user.id, verified: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!record || record.code !== code) {
      res.status(400).json({ success: false, message: 'Kod yanlışdır və ya vaxtı keçib' });
      return;
    }

    await prisma.verificationCode.update({ where: { id: record.id }, data: { verified: true } });
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { verified: true },
      select: { id: true, name: true, phone: true, type: true, role: true },
    });

    const token = await createSession(updatedUser.id, req);
    res.json({ success: true, token, user: updatedUser });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
