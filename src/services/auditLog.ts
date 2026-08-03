// Admin audit jurnalı — bütün admin əməliyyatlarını (mutating) avtomatik qeyd edir.
// Tək middleware ilə: hər /api/admin/* POST/PUT/PATCH/DELETE sorğusu uğurla (2xx)
// başa çatanda kim (adminId/adminName), nə (method+path→action), hansı obyekt
// (targetType/targetId), status və redaktə olunmuş body qeydə alınır.
import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';

const prisma = new PrismaClient();

// Bədii-oxunaqlı əməliyyat etiketi + hədəf obyekti path-dən çıxarılır.
export function deriveAction(method: string, path: string): { action: string; targetType: string | null; targetId: string | null } {
  // /api/admin/listings/12/status → ['listings','12','status']
  const clean = path.split('?')[0].replace(/^\/api\//, '').split('/').filter(Boolean);
  const idx = clean.indexOf('admin');
  const parts = idx >= 0 ? clean.slice(idx + 1) : clean;
  const resource = parts[0] || 'admin';
  const idPart = parts.find((p) => /^\d+$/.test(p)) || null;
  const last = parts[parts.length - 1];
  let verb: string;
  if (last && last !== resource && !/^\d+$/.test(last)) verb = last;        // məs. "status", "resolve", "approve"
  else verb = method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'update';
  return { action: `${resource}.${verb}`, targetType: resource, targetId: idPart };
}

// Body-dən həssas sahələri təmizlə (parol/token/kod və s. saxlanmır).
const REDACT = new Set(['password', 'token', 'code', 'otp', 'secret', 'apiKey', 'api_key', 'card', 'cardNumber', 'cvv', 'pan']);
function redact(body: any): any {
  if (!body || typeof body !== 'object') return undefined;
  const out: Record<string, any> = {};
  for (const k of Object.keys(body)) {
    if (REDACT.has(k)) { out[k] = '***'; continue; }
    const v = (body as any)[k];
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20);
    else if (v && typeof v === 'object') out[k] = '[object]';
  }
  return Object.keys(out).length ? out : undefined;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Bu path-lar jurnala düşməsin (login cəhdləri, jurnalın özü, sağlamlıq).
function skip(path: string): boolean {
  return /\/admin\/(login|audit|service-health|me|overview|dashboard|analytics|search)\b/.test(path);
}

export function auditMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const path = req.originalUrl || req.url;
  if (!MUTATING.has(req.method) || !/\/api\/admin\//.test(path) || skip(path)) return next();

  // Cavab bitəndə (route handler-dən sonra) — req.adminId/adminName artıq təyin olunub.
  res.on('finish', () => {
    try {
      if (res.statusCode >= 400) return;         // yalnız uğurlu əməliyyatlar
      if (!req.adminId) return;                  // admin auth keçməyibsə (yəni admin deyil)
      const { action, targetType, targetId } = deriveAction(req.method, path);
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
      prisma.adminAuditLog.create({
        data: {
          adminId: req.adminId,
          adminName: req.adminName || 'Admin',
          method: req.method,
          path: path.slice(0, 300),
          action,
          targetType,
          targetId: targetId ? String(targetId) : null,
          status: res.statusCode,
          summary: `${req.method} ${path.replace(/^\/api/, '')}`.slice(0, 300),
          meta: redact(req.body) as any,
          ip: ip ? String(ip).slice(0, 60) : null,
        },
      }).catch(() => {});
    } catch { /* jurnal xətası əsas axını pozmasın */ }
  });
  next();
}
