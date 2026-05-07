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
}

export function generateToken(userId: number): string {
  return jwt.sign({ userId }, SIGNING_KEY, { expiresIn: '24h' });
}

// General auth - any logged in user
export function adminAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ success: false, message: 'Token tələb olunur' });
    return;
  }

  try {
    const decoded = jwt.verify(token, SIGNING_KEY) as { userId: number };
    req.adminId = decoded.userId;
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
      const decoded = jwt.verify(token, SIGNING_KEY) as { userId: number };
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, type: true, sellerVerified: true, profileComplete: true },
      });
      if (!user) { res.status(401).json({ success: false, message: 'İstifadəçi tapılmadı' }); return; }
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
    const decoded = jwt.verify(token, SIGNING_KEY) as { userId: number };
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
      next();
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
