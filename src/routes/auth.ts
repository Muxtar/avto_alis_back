import { Router, Request, Response } from 'express';
import { PrismaClient, UserType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { upload } from '../middleware/upload';
import { generateToken, adminAuth, AuthRequest } from '../middleware/auth';
import { authLimiter, registerLimiter, verifyLimiter } from '../middleware/rateLimiter';

const router = Router();
const prisma = new PrismaClient();

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Validation helpers
function validateName(name: string): string | null {
  if (!name || typeof name !== 'string') return 'Ad tələb olunur';
  const trimmed = name.trim();
  if (trimmed.length < 2) return 'Ad ən azı 2 simvol olmalıdır';
  if (trimmed.length > 100) return 'Ad 100 simvoldan çox ola bilməz';
  return null;
}

function validatePhone(phone: string): string | null {
  if (!phone || typeof phone !== 'string') return 'Telefon nömrəsi tələb olunur';
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');
  if (cleaned.length < 7) return 'Telefon nömrəsi ən azı 7 rəqəm olmalıdır';
  if (cleaned.length > 20) return 'Telefon nömrəsi çox uzundur';
  if (!/^\+?[0-9]+$/.test(cleaned)) return 'Telefon nömrəsi yalnız rəqəmlərdən ibarət olmalıdır';
  return null;
}

function validateTelegramId(telegramId: any): string | null {
  if (!telegramId) return 'telegramId tələb olunur';
  const str = String(telegramId);
  if (!/^\d{5,15}$/.test(str)) return 'telegramId yalnız rəqəmlərdən ibarət olmalıdır (5-15 rəqəm)';
  return null;
}

function safeJsonParse(str: string): { data: any; error: string | null } {
  try {
    return { data: JSON.parse(str), error: null };
  } catch {
    return { data: null, error: 'JSON formatı yanlışdır' };
  }
}

async function createVerificationCode(userId: number) {
  const code = generateCode();
  await prisma.verificationCode.create({
    data: { userId, code, expiresAt: new Date(Date.now() + 5 * 60 * 1000) },
  });
  return code;
}

// Phone-only registration/login (unified). Creates user if new, returns userId + verification code
router.post('/register/phone', registerLimiter, async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;
    const phoneErr = validatePhone(phone);
    if (phoneErr) { res.status(400).json({ success: false, message: phoneErr }); return; }

    let user = await prisma.user.findFirst({ where: { phone, type: { not: UserType.COURIER } } });
    if (!user) {
      user = await prisma.user.create({ data: { phone } });
    }

    const verificationCode = await createVerificationCode(user.id);
    // TEST MODE: always return verificationCode until Twilio is integrated
    const isDev = process.env.SMS_PROVIDER !== 'twilio';
    res.status(201).json({
      success: true,
      userId: user.id,
      isNew: !user.profileComplete,
      ...(isDev && { verificationCode }),
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Complete profile after phone verification (auth required). Sets type + type-specific data.
router.post('/register/complete', adminAuth, upload.array('passportImages', 5), async (req: AuthRequest, res: Response) => {
  try {
    const { name, type, vehicles: vehiclesJson, workplaces: workplacesJson } = req.body;

    const nameErr = validateName(name);
    if (nameErr) { res.status(400).json({ success: false, message: nameErr }); return; }

    if (!type || !['CAR_OWNER', 'MECHANIC', 'PARTS_SELLER'].includes(type)) {
      res.status(400).json({ success: false, message: 'Düzgün istifadəçi tipi seçin' });
      return;
    }

    const userId = req.adminId!;
    const updateData: any = { name: name.trim(), type, profileComplete: true };

    if (type === 'CAR_OWNER') {
      const { data: vehicles, error: jsonErr } = safeJsonParse(vehiclesJson || '[]');
      if (jsonErr) { res.status(400).json({ success: false, message: jsonErr }); return; }
      if (!Array.isArray(vehicles) || vehicles.length === 0) {
        res.status(400).json({ success: false, message: 'Ən azı bir avtomobil əlavə edin' }); return;
      }
      const files = (req.files as Express.Multer.File[]) || [];
      await prisma.vehicle.deleteMany({ where: { userId } });
      updateData.vehicles = {
        create: vehicles.map((v: any, i: number) => ({
          brand: v.brand, model: v.model, year: parseInt(v.year),
          passportImage: files[i]?.filename || '',
        })),
      };
    } else {
      const { data: workplaces, error: jsonErr } = safeJsonParse(workplacesJson || '[]');
      if (jsonErr) { res.status(400).json({ success: false, message: jsonErr }); return; }
      if (!Array.isArray(workplaces) || workplaces.length === 0) {
        res.status(400).json({ success: false, message: 'Ən azı bir iş yeri əlavə edin' }); return;
      }
      await prisma.workplace.deleteMany({ where: { userId } });
      updateData.workplaces = {
        create: workplaces.map((w: any) => ({
          name: w.name, address: w.address,
          latitude: w.latitude ? parseFloat(w.latitude) : null,
          longitude: w.longitude ? parseFloat(w.longitude) : null,
        })),
      };
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: { id: true, name: true, phone: true, email: true, type: true, role: true, verified: true, profileComplete: true, sellerVerified: true },
    });

    res.json({ success: true, user });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Resend verification code for a given phone (used on OTP screen)
router.post('/verify/resend', verifyLimiter, async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    const uid = parseInt(userId);
    if (!uid) { res.status(400).json({ success: false, message: 'userId tələb olunur' }); return; }
    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) { res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' }); return; }
    const verificationCode = await createVerificationCode(uid);
    // TEST MODE: always return verificationCode until Twilio is integrated
    const isDev = process.env.SMS_PROVIDER !== 'twilio';
    res.json({ success: true, ...(isDev && { verificationCode }) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Register Car Owner (legacy - kept for backwards compatibility)
router.post('/register/car-owner', registerLimiter, upload.array('passportImages', 5), async (req: Request, res: Response) => {
  try {
    const { name, phone, vehicles: vehiclesJson } = req.body;

    const nameErr = validateName(name);
    if (nameErr) { res.status(400).json({ success: false, message: nameErr }); return; }
    const phoneErr = validatePhone(phone);
    if (phoneErr) { res.status(400).json({ success: false, message: phoneErr }); return; }

    const { data: vehicles, error: jsonErr } = safeJsonParse(vehiclesJson || '[]');
    if (jsonErr) { res.status(400).json({ success: false, message: jsonErr }); return; }
    if (!Array.isArray(vehicles) || vehicles.length === 0) {
      res.status(400).json({ success: false, message: 'Ən azı bir avtomobil əlavə edin' }); return;
    }

    const files = req.files as Express.Multer.File[];

    const user = await prisma.user.create({
      data: {
        name,
        phone,
        type: UserType.CAR_OWNER,
        vehicles: {
          create: vehicles.map((v: any, i: number) => ({
            brand: v.brand,
            model: v.model,
            year: parseInt(v.year),
            passportImage: files[i]?.filename || '',
          })),
        },
      },
      include: { vehicles: true },
    });

    const verificationCode = await createVerificationCode(user.id);
    // Dev modunda kodu dondur (test icin), production'da dondurme
    // TEST MODE: always return verificationCode until Twilio is integrated
    const isDev = process.env.SMS_PROVIDER !== 'twilio';
    res.status(201).json({ success: true, user, userId: user.id, ...(isDev && { verificationCode }) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Register Mechanic
router.post('/register/mechanic', registerLimiter, async (req: Request, res: Response) => {
  try {
    const { name, phone, workplaces } = req.body;

    const nameErr = validateName(name);
    if (nameErr) { res.status(400).json({ success: false, message: nameErr }); return; }
    const phoneErr = validatePhone(phone);
    if (phoneErr) { res.status(400).json({ success: false, message: phoneErr }); return; }
    if (!workplaces || !Array.isArray(workplaces) || workplaces.length === 0) {
      res.status(400).json({ success: false, message: 'Ən azı bir iş yeri əlavə edin' }); return;
    }

    const user = await prisma.user.create({
      data: {
        name,
        phone,
        type: UserType.MECHANIC,
        workplaces: {
          create: workplaces.map((w: any) => ({
            name: w.name,
            address: w.address,
            latitude: w.latitude ? parseFloat(w.latitude) : null,
            longitude: w.longitude ? parseFloat(w.longitude) : null,
          })),
        },
      },
      include: { workplaces: true },
    });

    const verificationCode = await createVerificationCode(user.id);
    // Dev modunda kodu dondur (test icin), production'da dondurme
    // TEST MODE: always return verificationCode until Twilio is integrated
    const isDev = process.env.SMS_PROVIDER !== 'twilio';
    res.status(201).json({ success: true, user, userId: user.id, ...(isDev && { verificationCode }) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Register Parts Seller
router.post('/register/parts-seller', async (req: Request, res: Response) => {
  try {
    const { name, phone, workplaces } = req.body;

    const nameErr = validateName(name);
    if (nameErr) { res.status(400).json({ success: false, message: nameErr }); return; }
    const phoneErr = validatePhone(phone);
    if (phoneErr) { res.status(400).json({ success: false, message: phoneErr }); return; }
    if (!workplaces || !Array.isArray(workplaces) || workplaces.length === 0) {
      res.status(400).json({ success: false, message: 'Ən azı bir iş yeri əlavə edin' }); return;
    }

    const user = await prisma.user.create({
      data: {
        name,
        phone,
        type: UserType.PARTS_SELLER,
        workplaces: {
          create: workplaces.map((w: any) => ({
            name: w.name,
            address: w.address,
            latitude: w.latitude ? parseFloat(w.latitude) : null,
            longitude: w.longitude ? parseFloat(w.longitude) : null,
          })),
        },
      },
      include: { workplaces: true },
    });

    const verificationCode = await createVerificationCode(user.id);
    // Dev modunda kodu dondur (test icin), production'da dondurme
    // TEST MODE: always return verificationCode until Twilio is integrated
    const isDev = process.env.SMS_PROVIDER !== 'twilio';
    res.status(201).json({ success: true, user, userId: user.id, ...(isDev && { verificationCode }) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Courier Login
router.post('/courier/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      res.status(400).json({ success: false, message: 'Telefon və şifrə tələb olunur' }); return;
    }
    const courier = await prisma.user.findFirst({
      where: { phone, type: UserType.COURIER },
    });
    if (!courier || !courier.password) {
      res.status(401).json({ success: false, message: 'Yanlış telefon və ya şifrə' });
      return;
    }
    const valid = await bcrypt.compare(password, courier.password);
    if (!valid) {
      res.status(401).json({ success: false, message: 'Yanlış telefon və ya şifrə' });
      return;
    }
    const token = generateToken(courier.id);
    res.json({ success: true, token, courier: { id: courier.id, name: courier.name, phone: courier.phone, type: courier.type } });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Telegram Login - check if telegramId is registered
router.post('/auth/telegram', authLimiter, async (req: Request, res: Response) => {
  try {
    const { telegramId } = req.body;
    const tgErr = validateTelegramId(telegramId);
    if (tgErr) { res.status(400).json({ success: false, message: tgErr }); return; }

    const user = await prisma.user.findUnique({
      where: { telegramId: String(telegramId) },
      select: { id: true, name: true, phone: true, type: true, role: true, verified: true },
    });

    if (!user) {
      res.json({ success: false, registered: false });
      return;
    }

    if (!user.verified) {
      res.json({ success: false, registered: true, verified: false, userId: user.id });
      return;
    }

    const token = generateToken(user.id);
    res.json({ success: true, token, user });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Telegram Register
router.post('/register/telegram', registerLimiter, async (req: Request, res: Response) => {
  try {
    const { telegramId, name, phone, type, vehicles, workplaces } = req.body;

    const tgErr = validateTelegramId(telegramId);
    if (tgErr) { res.status(400).json({ success: false, message: tgErr }); return; }
    const nameErr = validateName(name);
    if (nameErr) { res.status(400).json({ success: false, message: nameErr }); return; }
    const phoneErr = validatePhone(phone);
    if (phoneErr) { res.status(400).json({ success: false, message: phoneErr }); return; }
    if (!type || !['CAR_OWNER', 'MECHANIC', 'PARTS_SELLER'].includes(type)) {
      res.status(400).json({ success: false, message: 'Düzgün istifadəçi tipi seçin (CAR_OWNER, MECHANIC, PARTS_SELLER)' });
      return;
    }

    // Check if telegramId already exists
    const existing = await prisma.user.findUnique({ where: { telegramId: String(telegramId) } });
    if (existing) {
      res.status(400).json({ success: false, message: 'Bu Telegram hesabı artıq qeydiyyatdan keçib' });
      return;
    }

    let userData: any = {
      name,
      phone,
      type: type as UserType,
      telegramId: String(telegramId),
    };

    if (type === 'CAR_OWNER' && vehicles && vehicles.length > 0) {
      userData.vehicles = {
        create: vehicles.map((v: any) => ({
          brand: v.brand,
          model: v.model,
          year: parseInt(v.year),
          passportImage: '',
        })),
      };
    }

    if ((type === 'MECHANIC' || type === 'PARTS_SELLER') && workplaces && workplaces.length > 0) {
      userData.workplaces = {
        create: workplaces.map((w: any) => ({
          name: w.name,
          address: w.address,
          latitude: w.latitude ? parseFloat(w.latitude) : null,
          longitude: w.longitude ? parseFloat(w.longitude) : null,
        })),
      };
    }

    const user = await prisma.user.create({
      data: userData,
      include: { vehicles: true, workplaces: true },
    });

    const verificationCode = await createVerificationCode(user.id);
    // Dev modunda kodu dondur (test icin), production'da dondurme
    // TEST MODE: always return verificationCode until Twilio is integrated
    const isDev = process.env.SMS_PROVIDER !== 'twilio';
    res.status(201).json({ success: true, user, userId: user.id, ...(isDev && { verificationCode }) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
