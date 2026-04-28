import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient, UserType } from '@prisma/client';

const JWT_SECRET = process.env.JWT_SECRET || 'avto_bazar_secret_key_2024';
const prisma = new PrismaClient();

export interface AuthRequest extends Request {
  adminId?: number;
  userType?: UserType;
  userSellerVerified?: boolean;
  userProfileComplete?: boolean;
}

export function generateToken(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '24h' });
}

// General auth - any logged in user
export function adminAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ success: false, message: 'Token tələb olunur' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };
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
      const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };
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
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };
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
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };
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
