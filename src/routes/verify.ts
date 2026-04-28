import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { generateToken } from '../middleware/auth';
import { verifyLimiter } from '../middleware/rateLimiter';

const router = Router();
const prisma = new PrismaClient();

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send verification code
router.post('/verify/send', verifyLimiter, async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await prisma.verificationCode.create({
      data: { userId: parseInt(userId), code, expiresAt },
    });

    // TEST MODE: kodu cavabda qaytarir. SMS_PROVIDER=twilio qoyulanda gizlədilir
    const isDev = process.env.SMS_PROVIDER !== 'twilio';
    res.json({ success: true, message: 'Doğrulama kodu göndərildi', ...(isDev && { code }) });
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

    await prisma.verificationCode.update({ where: { id: record.id }, data: { verified: true } });
    const user = await prisma.user.update({
      where: { id: uid },
      data: { verified: true },
      select: { id: true, name: true, phone: true, type: true, role: true, profileComplete: true, sellerVerified: true },
    });

    const token = generateToken(user.id);
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

    const token = generateToken(updatedUser.id);
    res.json({ success: true, token, user: updatedUser });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
