import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient, UserType } from '@prisma/client';

// Hard fail if JWT_SECRET is not configured. Falling back to a hardcoded
// default in production (or staging) lets anyone forge tokens and impersonate
// any user. Only NODE_ENV='development' (or test) accepts the dev fallback.
const JWT_SECRET = process.env.JWT_SECRET;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_DEV_OR_TEST = NODE_ENV === 'development' || NODE_ENV === 'test';
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  if (!IS_DEV_OR_TEST) {
    throw new Error(
      `JWT_SECRET env-i mütləq qoyulmalıdır (minimum 32 simvol). NODE_ENV="${NODE_ENV}".`
    );
  }
  console.warn('[security] JWT_SECRET zəifdir və ya yoxdur — yalnız development üçün qəbul edilir.');
}
const SIGNING_KEY = JWT_SECRET || 'dev-only-not-for-production-XXXXXXXXXXXX';
const prisma = new PrismaClient();

export interface AuthRequest extends Request {
  adminId?: number;
  userType?: UserType;
  userSellerVerified?: boolean;
  userProfileComplete?: boolean;
  sessionId?: string; // cari cihaz sessiyası (JWT-dəki `sid`)
}

export function generateToken(userId: number): string {
  return jwt.sign({ userId }, SIGNING_KEY, { expiresIn: '24h' });
}

// İcazə verilmiş admin nömrələri — Railway env: ADMIN_PHONES="+99450...,+99451..."
// Yalnız env-dən idarə olunur (panel yox) — təhlükəsizlik üçün.
export function adminPhoneList(): string[] {
  return (process.env.ADMIN_PHONES || '')
    .split(',').map((s) => s.replace(/\D/g, '')).filter((s) => s.length >= 7);
}
// Nömrə admin siyahısındadırmı? Format-dan asılı olmamaq üçün son 9 rəqəmlə
// (milli nömrə) müqayisə edilir — +994, boşluq, 0 prefiksi fərqi problem olmasın.
export function isAdminPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const d = String(phone).replace(/\D/g, '');
  if (d.length < 7) return false;
  const tail = d.slice(-9);
  return adminPhoneList().some((a) => a === d || a.endsWith(tail) || d.endsWith(a.slice(-9)));
}

// User-Agent-dən cihaz məlumatını çıxar (WhatsApp "bağlı cihazlar" üçün).
// Xarici asılılıq yoxdur — sadə imza uyğunlaşması.
export function parseDevice(ua: string | undefined): { os: string | null; browser: string | null; deviceType: string } {
  const s = ua || '';
  let os: string | null = null;
  if (/Windows NT/i.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(s)) os = /iPad/i.test(s) ? 'iPadOS' : 'iOS';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/CrOS/i.test(s)) os = 'ChromeOS';
  else if (/Linux/i.test(s)) os = 'Linux';

  let browser: string | null = null;
  if (/Edg[A-Z]?\//i.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(s)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS/i.test(s)) browser = 'Firefox';
  else if (/Chrome\/|CriOS/i.test(s)) browser = 'Chrome';
  else if (/Safari\//i.test(s)) browser = 'Safari';

  const deviceType = /Mobile|iPhone|Android(?!.*Tablet)/i.test(s)
    ? 'Mobile'
    : /iPad|Tablet/i.test(s)
    ? 'Tablet'
    : 'Desktop';
  return { os, browser, deviceType };
}

function clientIp(req: Request): string | null {
  const xff = (req.headers['x-forwarded-for'] as string) || '';
  return xff.split(',')[0].trim() || req.ip || null;
}

// Yeni cihaz sessiyası yarat və həmin sessiyaya bağlı JWT qaytar (login-lərdə çağırılır).
export async function createSession(userId: number, req: Request): Promise<string> {
  const ua = req.headers['user-agent'];
  const { os, browser, deviceType } = parseDevice(ua);
  const session = await prisma.session.create({
    data: { userId, os, browser, deviceType, userAgent: ua ? String(ua).slice(0, 400) : null, ip: clientIp(req) },
    select: { id: true },
  });
  return jwt.sign({ userId, sid: session.id }, SIGNING_KEY, { expiresIn: '24h' });
}

// Sessiya aktivdirmi? (revoke olunmayıb və mövcuddur). Köhnə tokenlərdə `sid` yoxdur — icazə verilir.
export async function isSessionActive(sid: string | undefined): Promise<boolean> {
  if (!sid) return true;
  try {
    const s = await prisma.session.findUnique({ where: { id: sid }, select: { revokedAt: true, lastSeenAt: true } });
    if (!s) return false; // sessiya silinib
    if (s.revokedAt) return false; // uzaqdan bağlanıb
    // "Son aktiv" vaxtını yenilə — 5 dəqiqədə bir (yazı yükünü azaltmaq üçün throttle).
    if (Date.now() - new Date(s.lastSeenAt).getTime() > 5 * 60 * 1000) {
      prisma.session.update({ where: { id: sid }, data: { lastSeenAt: new Date() } }).catch(() => {});
    }
    return true;
  } catch {
    return true; // DB xətasında əlçatanlıq üçün fail-open
  }
}

// Token-i yoxla və userId qaytar (socket.io kimi HTTP-dən kənar auth üçün).
export function verifyTokenUserId(token: string | undefined): number | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, SIGNING_KEY) as { userId: number };
    return decoded.userId || null;
  } catch {
    return null;
  }
}

// General auth - any logged in user
export async function adminAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ success: false, message: 'Token tələb olunur' });
    return;
  }

  try {
    const decoded = jwt.verify(token, SIGNING_KEY) as { userId: number; sid?: string };
    // Cihaz uzaqdan çıxarılıbsa (revoke) — girişi rədd et.
    if (!(await isSessionActive(decoded.sid))) {
      res.status(401).json({ success: false, message: 'Bu cihazın girişi bağlanıb', sessionRevoked: true });
      return;
    }
    req.adminId = decoded.userId;
    req.sessionId = decoded.sid;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Etibarsız token' });
  }
}

// Restricts to users whose type is in the allowed list
export function requireType(allowed: UserType[]) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) { res.status(401).json({ success: false, message: 'Token tələb olunur' }); return; }
    try {
      const decoded = jwt.verify(token, SIGNING_KEY) as { userId: number; sid?: string };
      if (!(await isSessionActive(decoded.sid))) {
        res.status(401).json({ success: false, message: 'Bu cihazın girişi bağlanıb', sessionRevoked: true });
        return;
      }
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, type: true, sellerVerified: true, profileComplete: true, isBlocked: true },
      });
      if (!user) { res.status(401).json({ success: false, message: 'İstifadəçi tapılmadı' }); return; }
      if (user.isBlocked) { res.status(403).json({ success: false, message: 'Hesabınız bloklanıb' }); return; }
      req.sessionId = decoded.sid;
      if (!allowed.includes(user.type)) {
        res.status(403).json({ success: false, message: 'Bu əməliyyat üçün icazəniz yoxdur' });
        return;
      }
      req.adminId = user.id;
      req.userType = user.type;
      req.userSellerVerified = user.sellerVerified;
      req.userProfileComplete = user.profileComplete;
      next();
    } catch {
      res.status(401).json({ success: false, message: 'Etibarsız token' });
    }
  };
}

// Requires seller verification (KYC approved)
export function requireSellerVerified(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ success: false, message: 'Token tələb olunur' }); return; }
  try {
    const decoded = jwt.verify(token, SIGNING_KEY) as { userId: number; sid?: string };
    isSessionActive(decoded.sid).then((active) => {
      if (!active) { res.status(401).json({ success: false, message: 'Bu cihazın girişi bağlanıb', sessionRevoked: true }); return; }
    prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, type: true, sellerVerified: true, profileComplete: true },
    }).then((user) => {
      if (!user) { res.status(401).json({ success: false, message: 'İstifadəçi tapılmadı' }); return; }
      if (!user.sellerVerified) {
        res.status(403).json({ success: false, message: 'Satıcı kimlik təsdiqi tələb olunur', needsVerification: true });
        return;
      }
      req.adminId = user.id;
      req.userType = user.type;
      req.userSellerVerified = user.sellerVerified;
      req.userProfileComplete = user.profileComplete;
      req.sessionId = decoded.sid;
      next();
    }).catch(() => res.status(401).json({ success: false, message: 'Auth xətası' }));
    }).catch(() => res.status(401).json({ success: false, message: 'Auth xətası' }));
  } catch {
    res.status(401).json({ success: false, message: 'Etibarsız token' });
  }
}

// Admin-only auth - checks role is ADMIN
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ success: false, message: 'Token tələb olunur' });
    return;
  }

  try {
    const decoded = jwt.verify(token, SIGNING_KEY) as { userId: number };
    req.adminId = decoded.userId;

    prisma.user.findUnique({ where: { id: decoded.userId }, select: { role: true } })
      .then((user) => {
        if (!user || user.role !== 'ADMIN') {
          res.status(403).json({ success: false, message: 'Admin icazəsi tələb olunur' });
          return;
        }
        next();
      })
      .catch(() => {
        res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      });
  } catch {
    res.status(401).json({ success: false, message: 'Etibarsız token' });
  }
}
