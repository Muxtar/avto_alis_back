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

// Token mütləq müddəti — istifadə olunan sessiya bu müddət bitənə qədər logout OLMUR
// (default 90 gün). Hərəkətsizlik yoxlaması (aşağıda) əsl "1 həftə logout" məntiqidir.
const TOKEN_EXPIRY = Math.max(1, Number(process.env.JWT_EXPIRES_DAYS) || 90) * 24 * 60 * 60; // saniyə
// Hərəkətsizlik: bu qədər gün heç bir istifadə/giriş olmasa sessiya bağlanır (default 7 gün).
// İstifadə olunduqca lastSeenAt yenilənir → sürüşən müddət, active istifadəçi çıxarılmır.
const SESSION_IDLE_MS = Math.max(1, Number(process.env.SESSION_IDLE_DAYS) || 7) * 24 * 60 * 60 * 1000;

export interface AuthRequest extends Request {
  adminId?: number;
  userType?: UserType;
  userSellerVerified?: boolean;
  userProfileComplete?: boolean;
  sessionId?: string; // cari cihaz sessiyası (JWT-dəki `sid`)
  isSuperAdmin?: boolean;       // ADMIN_PHONES-dakı admin — hər modula icazəli
  adminPermissions?: string[];  // adi adminin icazəli modulları
  adminName?: string;           // audit jurnalı üçün admin adı (surət)
}

export function generateToken(userId: number): string {
  return jwt.sign({ userId }, SIGNING_KEY, { expiresIn: TOKEN_EXPIRY });
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

// ── ADMİN PANELİNƏ GİRİŞ İCAZƏSİ ────────────────────────────────────────────
// İki ayrı env siyahısı var və fərqi vacibdir:
//
//   ADMIN_PHONES        → SUPER-ADMIN. Hər modula icazəlidir, panel üzərindən
//                         səlahiyyəti götürülə bilməz.
//   ADMIN_LOGIN_PHONES  → yalnız GİRİŞ icazəsi. Bu nömrənin sahibi əvvəlcədən
//                         panel üzərindən admin kimi əlavə edilməli və
//                         icazələri təyin edilməlidir (RBAC). Sadəcə env-ə
//                         yazmaqla tam səlahiyyət ALMIR.
//
// Belə bölgü olmasa məhdud icazəli adminlər (RBAC) girə bilməzdi, yaxud
// əksinə — env-ə yazılan hər nömrə avtomatik tam səlahiyyət alardı.
export function adminLoginPhoneList(): string[] {
  const extra = (process.env.ADMIN_LOGIN_PHONES || '')
    .split(',').map((s) => s.replace(/\D/g, '')).filter((s) => s.length >= 7);
  return [...adminPhoneList(), ...extra];
}
function matchesAny(phone: string | null | undefined, list: string[]): boolean {
  if (!phone) return false;
  const d = String(phone).replace(/\D/g, '');
  if (d.length < 7) return false;
  const tail = d.slice(-9);
  return list.some((a) => a === d || a.endsWith(tail) || d.endsWith(a.slice(-9)));
}
// Bu nömrə ümumiyyətlə admin panelinə giriş cəhdi edə bilərmi?
export function canAdminLogin(phone: string | null | undefined): boolean {
  return matchesAny(phone, adminLoginPhoneList());
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
  return jwt.sign({ userId, sid: session.id }, SIGNING_KEY, { expiresIn: TOKEN_EXPIRY });
}

// Sessiya aktivdirmi? (revoke olunmayıb və mövcuddur). Köhnə tokenlərdə `sid` yoxdur — icazə verilir.
export async function isSessionActive(sid: string | undefined): Promise<boolean> {
  if (!sid) return true;
  try {
    const s = await prisma.session.findUnique({ where: { id: sid }, select: { revokedAt: true, lastSeenAt: true } });
    if (!s) return false; // sessiya silinib
    if (s.revokedAt) return false; // uzaqdan bağlanıb
    // Hərəkətsizlik: 7 gün (default) heç bir istifadə olmayıbsa → sessiya bağlanır.
    // İstifadə olunduqda lastSeenAt yenilənir, ona görə active istifadəçi çıxarılmır.
    const idleMs = Date.now() - new Date(s.lastSeenAt).getTime();
    if (idleMs > SESSION_IDLE_MS) return false;
    // "Son aktiv" vaxtını yenilə — 5 dəqiqədə bir (yazı yükünü azaltmaq üçün throttle).
    if (idleMs > 5 * 60 * 1000) {
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

// ── Admin RBAC (icazə modulları) ─────────────────────────────────────────────
// Admin panelindəki bölmələrə uyğun modul açarları. Frontend sidebar və backend
// icazə yoxlaması bu siyahıya söykənir. Yeni bölmə əlavə edəndə buranı yenilə.
export const ADMIN_MODULES = [
  'users', 'listings', 'orders', 'returns', 'finance', 'businesses', 'kyc',
  'credentials', 'complaints', 'social', 'promo', 'comments', 'broadcast',
  'banners', 'couriers', 'settings', 'ai', 'finance_payouts', 'audit',
  'content', 'support', 'outreach', 'admins',
] as const;
export type AdminModule = typeof ADMIN_MODULES[number];

// Ortaq admin yoxlaması: token → user (role/phone/adminPermissions).
// Qaytarır: null (icazə yox, cavab artıq göndərildi) və ya user məlumatı.
async function loadAdmin(req: AuthRequest, res: Response): Promise<{ id: number; isSuper: boolean; perms: string[] } | null> {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ success: false, message: 'Token tələb olunur' }); return null; }
  let decoded: { userId: number };
  try { decoded = jwt.verify(token, SIGNING_KEY) as { userId: number }; }
  catch { res.status(401).json({ success: false, message: 'Etibarsız token' }); return null; }
  req.adminId = decoded.userId;
  const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { role: true, phone: true, name: true, adminPermissions: true, isBlocked: true } });
  if (!user || user.role !== 'ADMIN' || user.isBlocked) {
    res.status(403).json({ success: false, message: 'Admin icazəsi tələb olunur' }); return null;
  }
  const isSuper = isAdminPhone(user.phone);           // ADMIN_PHONES → super-admin
  req.isSuperAdmin = isSuper;
  req.adminPermissions = user.adminPermissions || [];
  req.adminName = user.name || 'Admin';
  return { id: decoded.userId, isSuper, perms: user.adminPermissions || [] };
}

// Admin-only auth — yalnız role ADMIN yoxlanır (modul tələb olunmayan endpointlər:
// dashboard, overview, axtarış). İcazə bölgüsündən asılı deyil.
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  loadAdmin(req, res).then((a) => { if (a) next(); }).catch(() => {
    if (!res.headersSent) res.status(403).json({ success: false, message: 'İcazə yoxdur' });
  });
}

// Modul-səviyyəli icazə: super-admin hər şeyə, adi admin yalnız təyin olunmuş
// modula girə bilər. İstifadə: router.get('/admin/x', requirePermission('listings'), ...)
export function requirePermission(module: AdminModule) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    loadAdmin(req, res).then((a) => {
      if (!a) return;
      // İcazəsi TƏYİN EDİLMƏMİŞ admin (boş siyahı) köhnə/konfiqurasiya olunmamış
      // sayılır və hər şeyə icazəlidir — RBAC-dan əvvəlki adminlər bloklanmasın.
      // Yalnız super-admin başqasına konkret modul verəndə (siyahı dolur) məhdudlaşır.
      if (a.isSuper || a.perms.length === 0 || a.perms.includes(module)) { next(); return; }
      res.status(403).json({ success: false, message: 'Bu bölmə üçün icazəniz yoxdur' });
    }).catch(() => { if (!res.headersSent) res.status(403).json({ success: false, message: 'İcazə yoxdur' }); });
  };
}

// Yalnız super-admin (ADMIN_PHONES) — admin idarəetməsi/icazə paylaşımı üçün.
export function requireSuperAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  loadAdmin(req, res).then((a) => {
    if (!a) return;
    if (a.isSuper) { next(); return; }
    res.status(403).json({ success: false, message: 'Yalnız super-admin icazəlidir' });
  }).catch(() => { if (!res.headersSent) res.status(403).json({ success: false, message: 'İcazə yoxdur' }); });
}
