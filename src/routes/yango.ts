import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { emitToUser } from '../services/callSignaling';
import {
  isYangoConfigured, checkPrice, createClaim, acceptClaim, getClaimInfo,
  getPerformerPosition, getCancelInfo, cancelClaim, mapYangoStatus, YANGO_MAX_WEIGHT_KG, type Geo,
  getTrackingLinks, getPointsEta, getDriverPhone, getConfirmationCode,
} from '../services/yangoDelivery';

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

// ── Ortaq: sifarişi Yango-ya göndər (claim yarat + təsdiqlə). Həm route, həm
//    avtomatik dispatch (satıcı təsdiqləyəndə) bunu çağırır. ──────────────────
export async function dispatchOrderToYango(orderId: number): Promise<{ ok: boolean; message?: string; claimId?: string; status?: string }> {
  if (!isYangoConfigured()) return { ok: false, message: 'Yango qoşulmayıb (YANGO_TOKEN yoxdur)' };
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) return { ok: false, message: 'Sifariş tapılmadı' };
  if (order.yangoClaimId) return { ok: true, claimId: order.yangoClaimId, status: order.yangoStatus || undefined };
  if (order.deliveryType === 'PICKUP') return { ok: false, message: 'Götürmə sifarişi üçün kuryer lazım deyil' };
  if (order.deliveryMethod !== 'COURIER') return { ok: false, message: 'Bu sifariş Yango ilə deyil' };

  // Uğursuzluq səbəbini sifarişdə saxla (satıcıya göstərmək + təkrar cəhd üçün).
  const fail = async (message: string) => {
    await prisma.order.update({ where: { id: order.id }, data: { yangoError: message } }).catch(() => {});
    return { ok: false as const, message };
  };

  const obj = order.items.map((i) => i.listing?.businessObject).find((o) => o && o.latitude != null && o.longitude != null);
  const srcLat = obj?.latitude ?? order.seller.latitude;
  const srcLng = obj?.longitude ?? order.seller.longitude;
  const srcAddr = obj?.address || order.seller.address || '';
  const srcName = obj?.name || order.seller.name || 'Satıcı';
  const srcPhone = obj?.phone || order.seller.phone || '';
  if (srcLat == null || srcLng == null) return fail('Obyektin/satıcının koordinatı yoxdur');
  if (order.latitude == null || order.longitude == null) return fail('Alıcı ünvanının koordinatı yoxdur');
  const dstPhone = order.phone || order.buyer.phone || '';
  if (!srcPhone || !dstPhone) return fail('Göndərən və ya alıcı telefonu yoxdur');

  // Yük limiti — 50 kq-dan ağır sifariş Yango ilə göndərilə bilməz.
  const totalWeight = order.items.reduce((s, i) => s + i.quantity * ((i.listing as any)?.weightKg || 0), 0);
  if (totalWeight > YANGO_MAX_WEIGHT_KG) return fail(`Sifariş çəkisi ${totalWeight} kq — Yango limiti ${YANGO_MAX_WEIGHT_KG} kq`);

  const claim = await createClaim({
    requestId: `order-${order.id}`,
    source: { fullname: srcAddr, coordinates: [srcLng, srcLat] as Geo, contact: { name: srcName, phone: srcPhone } },
    destination: { fullname: order.address || 'Çatdırılma ünvanı', coordinates: [order.longitude, order.latitude] as Geo, contact: { name: order.buyer.name || 'Alıcı', phone: dstPhone } },
    items: order.items.map((i) => ({ title: i.title, quantity: i.quantity, costValue: i.price.toFixed(2), costCurrency: 'AZN', weightKg: (i.listing as any)?.weightKg || 1 })),
    emergencyContact: { name: srcName, phone: srcPhone },
    comment: `tradixai sifariş #${order.id}`,
  });
  if (!claim.ok || !claim.data?.id) return fail(claim.error || 'Yango claim yaradıla bilmədi (kuryer tapılmadı ola bilər)');

  const claimId = claim.data.id as string;
  const version = (claim.data.version as number) ?? 1;
  await acceptClaim(claimId, version);
  const info = await getClaimInfo(claimId);
  const status = info.data?.status || claim.data.status || 'new';
  const price = info.data?.pricing?.offer?.price ? parseFloat(info.data.pricing.offer.price) : (order.deliveryFee || null);
  const currency = info.data?.pricing?.currency || order.yangoCurrency || 'AZN';

  await prisma.order.update({
    where: { id: order.id },
    data: { yangoClaimId: claimId, yangoStatus: status, yangoVersion: (info.data?.version as number) ?? version, yangoPrice: price, yangoCurrency: currency, yangoError: null },
  });
  return { ok: true, claimId, status };
}

// ── Qiymət təxmini (checkout-da göstərmək üçün) ───────────────────────────────
router.post('/yango/quote', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!isYangoConfigured()) { res.json({ success: true, available: false, fee: 0 }); return; }
    const businessObjectId = req.body.businessObjectId ? parseInt(String(req.body.businessObjectId)) : null;
    const sellerId = req.body.sellerId ? parseInt(String(req.body.sellerId)) : null;
    const lat = req.body.latitude != null ? parseFloat(String(req.body.latitude)) : null;
    const lng = req.body.longitude != null ? parseFloat(String(req.body.longitude)) : null;
    if (lat == null || lng == null || (!businessObjectId && !sellerId)) { res.status(400).json({ success: false, message: 'Konum tələb olunur' }); return; }
    // Götürmə (pickup) yeri: biznes obyektinin koordinatı, yoxdursa satıcının profil konumu.
    let pickup: { latitude: number | null; longitude: number | null } | null = null;
    if (businessObjectId) {
      pickup = await prisma.businessObject.findUnique({ where: { id: businessObjectId }, select: { latitude: true, longitude: true } });
    } else if (sellerId) {
      pickup = await prisma.user.findUnique({ where: { id: sellerId }, select: { latitude: true, longitude: true } });
    }
    if (!pickup?.latitude || !pickup?.longitude) { res.json({ success: true, available: false, fee: 0, message: 'Satıcının/obyektin koordinatı yoxdur' }); return; }
    const q = await checkPrice({ source: [pickup.longitude, pickup.latitude], destination: [lng, lat], weightKg: req.body.weight ? parseFloat(String(req.body.weight)) : 1 });
    if (!q.ok || !q.data?.price) { res.json({ success: true, available: false, fee: 0, message: q.error }); return; }
    res.json({ success: true, available: true, fee: parseFloat(String(q.data.price)), currency: q.data.currency_rules?.code || 'AZN', eta: q.data.eta });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Satıcı: sifarişi Yango ilə göndər ─────────────────────────────────────────
router.post('/orders/:id/yango/dispatch', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const order = await prisma.order.findUnique({ where: { id }, select: { sellerId: true } });
    if (!order || order.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const r = await dispatchOrderToYango(id);
    if (!r.ok) { res.status(502).json({ success: false, message: r.message }); return; }
    res.json({ success: true, claimId: r.claimId, status: r.status });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Status + kuryer məlumatı (alıcı və ya satıcı) ─────────────────────────────
router.get('/orders/:id/yango/status', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true, buyerId: true, sellerId: true, status: true, yangoClaimId: true, yangoStatus: true } });
    if (!order || (order.buyerId !== req.adminId && order.sellerId !== req.adminId)) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (!order.yangoClaimId) { res.json({ success: true, dispatched: false }); return; }

    const info = await getClaimInfo(order.yangoClaimId);
    if (!info.ok || !info.data) { res.status(502).json({ success: false, message: info.error || 'Yango status alına bilmədi' }); return; }
    const status = info.data.status as string;
    const version = (info.data.version as number) ?? undefined;

    // Kuryer aktiv mərhələ? (Wolt-tipli canlı izləmə/ETA/təhvil kodu bu mərhələdə lazımdır.)
    const ACTIVE = ['accepted', 'performer_found', 'performer_draft', 'pickup_arrived', 'ready_for_pickup_confirmation', 'pickuped', 'delivery_arrived', 'ready_for_delivery_confirmation'];
    const active = ACTIVE.includes(status);

    // Canlı GPS mövqeyi + izləmə linki + ETA-nı paralel al (aktiv mərhələdə).
    let courierPosition: any = null;
    let trackingUrl: string | null = null;
    let etaExpected: string | null = null;
    let etaSeconds: number | null = null;
    if (active) {
      const [pos, tl, eta] = await Promise.all([
        getPerformerPosition(order.yangoClaimId),
        getTrackingLinks(order.yangoClaimId),
        getPointsEta(order.yangoClaimId),
      ]);
      if (pos.ok && pos.data?.position?.lat != null && pos.data.position.lon != null) courierPosition = pos.data.position;
      // İzləmə linki — destination (təhvil) nöqtəsinin sharing_link-i.
      const destTl = (tl.data?.route_points || []).find((p: any) => p.type === 'destination' && p.sharing_link);
      trackingUrl = destTl?.sharing_link || null;
      // ETA — sonuncu (təhvil) nöqtəsinin gözlənilən çatma vaxtı.
      const pts = eta.data?.route_points || [];
      const destEta = pts.length ? pts[pts.length - 1] : null;
      etaExpected = destEta?.visited_at?.expected || null;
      if (etaExpected) etaSeconds = Math.max(0, Math.round((new Date(etaExpected).getTime() - Date.now()) / 1000));
    }

    // Təhvil təsdiq kodu — YALNIZ alıcıya və çatdırılma mərhələsində (kuryerə deyir).
    let confirmationCode: string | null = null;
    if (order.buyerId === req.adminId && ['pickuped', 'delivery_arrived', 'ready_for_delivery_confirmation'].includes(status)) {
      const cc = await getConfirmationCode(order.yangoClaimId);
      confirmationCode = cc.data?.code || null;
    }

    await prisma.order.update({
      where: { id: order.id },
      data: {
        yangoStatus: status,
        ...(version != null ? { yangoVersion: version } : {}),
        ...(courierPosition ? { courierLat: courierPosition.lat, courierLng: courierPosition.lon } : {}),
      },
    }).catch(() => {});
    await syncOrderStatus(order.id, order.status, status);

    // Status dəyişibsə — alıcı və satıcıya real-time bildiriş (hansı səhifədə olsa da).
    if (status && status !== order.yangoStatus) {
      const payload = { orderId: order.id, yangoStatus: status };
      emitToUser(order.buyerId, 'order:yango', payload);
      emitToUser(order.sellerId, 'order:yango', payload);
    }

    res.json({
      success: true, dispatched: true, status,
      performer: info.data.performer_info || null,
      courierPosition, trackingUrl, etaExpected, etaSeconds, confirmationCode,
      routePoints: info.data.route_points || [], pricing: info.data.pricing || null,
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Satıcı: Yango çatdırılmasını ləğv et (əvvəlcə cancel-info ilə pulsuzmu yoxla) ──
router.post('/orders/:id/yango/cancel', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true, sellerId: true, yangoClaimId: true, yangoVersion: true } });
    if (!order || order.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (!order.yangoClaimId) { res.status(400).json({ success: false, message: 'Bu sifariş Yango-ya göndərilməyib' }); return; }

    const info = await getClaimInfo(order.yangoClaimId);
    const version = (info.data?.version as number) ?? order.yangoVersion ?? 1;
    // Pulsuz ləğv mümkündürmü?
    const ci = await getCancelInfo(order.yangoClaimId);
    const cancelState: 'free' | 'paid' = ci.data?.cancel_state === 'paid' ? 'paid' : 'free';
    const cancel = await cancelClaim(order.yangoClaimId, version, cancelState);
    if (!cancel.ok) { res.status(502).json({ success: false, message: cancel.error || 'Yango ləğvi alınmadı' }); return; }
    await prisma.order.update({ where: { id: order.id }, data: { yangoStatus: cancel.data?.status || 'cancelled' } }).catch(() => {});
    res.json({ success: true, status: cancel.data?.status || 'cancelled', cancelState });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Kuryerə zəng (proksi nömrə) — alıcı və ya satıcı, Wolt kimi ──────────────
router.post('/orders/:id/yango/call', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true, buyerId: true, sellerId: true, yangoClaimId: true } });
    if (!order || (order.buyerId !== req.adminId && order.sellerId !== req.adminId)) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (!order.yangoClaimId) { res.status(400).json({ success: false, message: 'Bu sifariş Yango-ya göndərilməyib' }); return; }
    const r = await getDriverPhone(order.yangoClaimId);
    if (!r.ok || !r.data?.phone) { res.status(502).json({ success: false, message: r.error || 'Kuryer nömrəsi hələ əlçatan deyil (kuryer təyin olunmayıb ola bilər)' }); return; }
    res.json({ success: true, phone: r.data.phone, ext: r.data.ext || null, ttlSeconds: r.data.ttl_seconds || null });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Yango webhook (status push). Yango kabinetində bu URL qeyd olunur. ─────────
// Auth yoxdur (Yango bizim JWT göndərmir) — claim_id üzrə uyğunlaşdırırıq.
router.post('/yango/callback', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const claimId = body.claim_id || body.id || body.order_id;
    const status = body.status || body.claim_status;
    if (claimId && status) {
      const order = await prisma.order.findFirst({ where: { yangoClaimId: String(claimId) }, select: { id: true, status: true } });
      if (order) {
        await prisma.order.update({ where: { id: order.id }, data: { yangoStatus: String(status) } }).catch(() => {});
        await syncOrderStatus(order.id, order.status, String(status));
      }
    }
    // Yango 200 gözləyir.
    res.json({ success: true });
  } catch {
    res.json({ success: true });
  }
});

export default router;
