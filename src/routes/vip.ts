import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { consultationLimiter } from '../middleware/rateLimiter';
import { createPayment as createGatewayPayment } from '../services/paymentGateway';
import { vipPackages, activateVip, VIP_DAYS } from '../services/vip';
import { visibilityOf } from '../services/listingVisibility';

const router = Router();
const prisma = new PrismaClient();
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 5001}`;

// VIP paketləri və qiymətləri (hamıya açıq).
router.get('/vip/packages', async (_req, res: Response) => {
  try { res.json({ success: true, packages: await vipPackages() }); }
  catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Öz elanımı VIP et — pulludursa bank səhifəsinə yönləndirmə, pulsuzdursa dərhal.
router.post('/me/listings/:id/vip', consultationLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const days = parseInt(String(req.body?.days));
    if (!VIP_DAYS.includes(days as any)) { res.status(400).json({ success: false, message: 'Paket seçin' }); return; }
    const l = await prisma.listing.findUnique({
      where: { id },
      select: { id: true, userId: true, title: true, status: true, type: true, archivedAt: true, expiresAt: true, business: { select: { isActive: true, name: true } }, businessObject: { select: { isActive: true, name: true } } },
    });
    if (!l || l.userId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    // Saytda GÖRÜNMƏYƏN elana VIP satılmır — əvvəl yalnız status yoxlanırdı:
    // deaktiv obyektin elanına pul ödənilir, amma elan ana səhifədə çıxmırdı.
    const vis = visibilityOf(l);
    if (!vis.visible) {
      res.status(400).json({ success: false, message: `Elan hazırda saytda görünmür, VIP mənasızdır: ${vis.reasons.join('; ')}` }); return;
    }
    const price = (await vipPackages()).find((p) => p.days === days)!.price;
    if (price <= 0) {
      const listing = await activateVip(l.id, days);
      res.json({ success: true, free: true, listing });
      return;
    }
    const reference = `VIP${l.id}-${Date.now()}`;
    const pay = await createGatewayPayment({
      amount: price, reference,
      title: `VIP elan — ${days} gün`,
      description: `«${l.title.slice(0, 60)}» elanını ${days} gün VIP etmək`,
      callbackBase: PUBLIC_BACKEND_URL, language: 'az',
    });
    await prisma.businessFee.create({
      data: {
        userId: req.adminId!, amount: price, status: 'UNPAID', purpose: 'VIP', listingId: l.id, vipDays: days,
        gatewayProvider: pay.provider, gatewayRef: pay.ref, gatewayOrderId: pay.gatewayOrderId, gatewayPassword: pay.password,
      },
    });
    res.json({ success: true, amount: price, redirectUrl: pay.redirectUrl, reference: pay.ref });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
