import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { isYangoConfigured, createClaim, acceptClaim, getClaimInfo, cancelClaim, mapYangoStatus, type Geo } from '../services/yangoDelivery';

const router = Router();
const prisma = new PrismaClient();

const orderInclude = {
  items: { include: { listing: { include: { businessObject: true } } } },
  buyer: { select: { id: true, name: true, phone: true } },
  seller: { select: { id: true, name: true, phone: true, latitude: true, longitude: true, address: true } },
};

// Sifarişin status sırası — yalnız irəli sinxron (geri qaytarma yox).
const RANK: Record<string, number> = { PENDING: 0, CONFIRMED: 1, SHIPPED: 2, DELIVERED: 3, CANCELLED: 3 };
async function syncOrderStatus(orderId: number, current: string, yangoStatus: string) {
  const mapped = mapYangoStatus(yangoStatus);
  if (!mapped) return;
  if (current === 'DELIVERED' || current === 'CANCELLED') return; // terminal
  if (mapped === 'CANCELLED' || (RANK[mapped] ?? 0) > (RANK[current] ?? 0)) {
    await prisma.order.update({ where: { id: orderId }, data: { status: mapped as any } }).catch(() => {});
  }
}

// ── Satıcı: sifarişi Yango ilə göndər (claim yarat + təsdiqlə) ─────────────────
router.post('/orders/:id/yango/dispatch', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!isYangoConfigured()) { res.status(400).json({ success: false, message: 'Yango qoşulmayıb (YANGO_TOKEN yoxdur)' }); return; }
    const id = parseInt(String(req.params.id));
    const order = await prisma.order.findUnique({ where: { id }, include: orderInclude });
    if (!order || order.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (order.deliveryType === 'PICKUP') { res.status(400).json({ success: false, message: 'Götürmə sifarişi üçün kuryer lazım deyil' }); return; }
    if (order.yangoClaimId) { res.status(400).json({ success: false, message: 'Bu sifariş artıq Yango-ya göndərilib' }); return; }

    // Mənbə (götürülmə) — biznes obyekti, yoxdursa satıcının ünvanı.
    const obj = order.items.map((i) => i.listing?.businessObject).find((o) => o && o.latitude != null && o.longitude != null);
    const srcLat = obj?.latitude ?? order.seller.latitude;
    const srcLng = obj?.longitude ?? order.seller.longitude;
    const srcAddr = obj?.address || order.seller.address || '';
    const srcName = obj?.name || order.seller.name || 'Satıcı';
    const srcPhone = obj?.phone || order.seller.phone || '';
    if (srcLat == null || srcLng == null) { res.status(400).json({ success: false, message: 'Obyektin/satıcının koordinatı yoxdur — obyekt ünvanını xəritədən seçin' }); return; }

    // Təyinat (çatdırılma) — alıcının ünvanı + koordinatı.
    if (order.latitude == null || order.longitude == null) { res.status(400).json({ success: false, message: 'Alıcı ünvanının koordinatı yoxdur — çatdırılma mümkün deyil' }); return; }
    const dstPhone = order.phone || order.buyer.phone || '';
    if (!srcPhone || !dstPhone) { res.status(400).json({ success: false, message: 'Göndərən və ya alıcı telefonu yoxdur' }); return; }

    const claim = await createClaim({
      requestId: `order-${order.id}`,
      source: { fullname: srcAddr, coordinates: [srcLng, srcLat] as Geo, contact: { name: srcName, phone: srcPhone } },
      destination: { fullname: order.address || 'Çatdırılma ünvanı', coordinates: [order.longitude, order.latitude] as Geo, contact: { name: order.buyer.name || 'Alıcı', phone: dstPhone } },
      items: order.items.map((i) => ({ title: i.title, quantity: i.quantity, costValue: i.price.toFixed(2), costCurrency: 'AZN', weightKg: 1 })),
      emergencyContact: { name: srcName, phone: srcPhone },
      comment: `tradixai sifariş #${order.id}`,
    });
    if (!claim.ok || !claim.data?.id) { res.status(502).json({ success: false, message: claim.error || 'Yango claim yaradıla bilmədi' }); return; }

    const claimId = claim.data.id as string;
    const version = (claim.data.version as number) ?? 1;
    // Təsdiqlə (kuryer axtarışı başlasın).
    const accept = await acceptClaim(claimId, version);
    const info = await getClaimInfo(claimId);
    const status = info.data?.status || claim.data.status || 'new';
    const price = info.data?.pricing?.offer?.price ? parseFloat(info.data.pricing.offer.price) : null;
    const currency = info.data?.pricing?.currency || null;

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        yangoClaimId: claimId,
        yangoStatus: status,
        yangoVersion: (info.data?.version as number) ?? version,
        yangoPrice: price,
        yangoCurrency: currency,
      },
    });
    res.json({ success: true, claimId, status, accepted: accept.ok, price, currency, order: updated });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Status + kuryer məlumatı (alıcı və ya satıcı) ─────────────────────────────
router.get('/orders/:id/yango/status', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true, buyerId: true, sellerId: true, status: true, yangoClaimId: true } });
    if (!order || (order.buyerId !== req.adminId && order.sellerId !== req.adminId)) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (!order.yangoClaimId) { res.json({ success: true, dispatched: false }); return; }

    const info = await getClaimInfo(order.yangoClaimId);
    if (!info.ok || !info.data) { res.status(502).json({ success: false, message: info.error || 'Yango status alına bilmədi' }); return; }
    const status = info.data.status as string;
    const performer = info.data.performer_info || null;
    const version = (info.data.version as number) ?? undefined;

    await prisma.order.update({ where: { id: order.id }, data: { yangoStatus: status, ...(version != null ? { yangoVersion: version } : {}) } }).catch(() => {});
    await syncOrderStatus(order.id, order.status, status);

    res.json({
      success: true,
      dispatched: true,
      status,
      performer, // courier_name, car_model, car_number, transport_type...
      routePoints: info.data.route_points || [],
      pricing: info.data.pricing || null,
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Satıcı: Yango çatdırılmasını ləğv et ──────────────────────────────────────
router.post('/orders/:id/yango/cancel', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true, sellerId: true, yangoClaimId: true, yangoVersion: true } });
    if (!order || order.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (!order.yangoClaimId) { res.status(400).json({ success: false, message: 'Bu sifariş Yango-ya göndərilməyib' }); return; }

    // Cari versiyanı al.
    const info = await getClaimInfo(order.yangoClaimId);
    const version = (info.data?.version as number) ?? order.yangoVersion ?? 1;
    const cancel = await cancelClaim(order.yangoClaimId, version, 'free');
    if (!cancel.ok) { res.status(502).json({ success: false, message: cancel.error || 'Yango ləğvi alınmadı' }); return; }

    await prisma.order.update({ where: { id: order.id }, data: { yangoStatus: cancel.data?.status || 'cancelled' } }).catch(() => {});
    res.json({ success: true, status: cancel.data?.status || 'cancelled' });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
