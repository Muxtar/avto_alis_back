import { Router, Response } from 'express';
import { PrismaClient, UserType } from '@prisma/client';
import { adminAuth, requireType, AuthRequest } from '../middleware/auth';
import { createPayment as createGatewayPayment, refundOrder as gatewayRefundOrder } from '../services/paymentGateway';
import { checkPrice as yangoCheckPrice, isYangoConfigured, YANGO_MAX_WEIGHT_KG } from '../services/yangoDelivery';
import { dispatchOrderToYango } from './yango';

const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 5001}`;

const BUYER_TYPES: UserType[] = [UserType.CAR_OWNER, UserType.MECHANIC, UserType.PARTS_SELLER];

const router = Router();
const prisma = new PrismaClient();

// Təhvil kodu — qarışmaması üçün oxşar simvollar (0/O, 1/I) çıxarılıb. Məs. "TX-7F3K".
function genPickupCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `TX-${s}`;
}

// Get my cart
router.get('/cart', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    let cart = await prisma.cart.findUnique({
      where: { userId: req.adminId! },
      include: {
        items: {
          include: {
            listing: { include: { user: { select: { id: true, name: true, phone: true } } } },
          },
        },
      },
    });
    if (!cart) {
      cart = await prisma.cart.create({
        data: { userId: req.adminId! },
        include: { items: { include: { listing: { include: { user: { select: { id: true, name: true, phone: true } } } } } } },
      });
    }
    const total = cart.items.reduce((sum, i) => sum + i.listing.price * i.quantity, 0);
    res.json({ cart, total, count: cart.items.length });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ====================== SƏBƏT PAYLAŞIMI ======================
const SHARE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function shareToken(len = 10): string {
  let s = '';
  for (let i = 0; i < len; i++) s += SHARE_ALPHABET[Math.floor(Math.random() * SHARE_ALPHABET.length)];
  return s;
}

// Səbəti paylaş — cari səbətin surətini link kimi yarat.
router.post('/cart/share', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const cart = await prisma.cart.findUnique({ where: { userId: req.adminId! }, include: { items: true } });
    if (!cart || cart.items.length === 0) { res.status(400).json({ success: false, message: 'Səbət boşdur' }); return; }
    // Yalnız seçilmiş məhsulları paylaş (itemIds verilməyibsə hamısı).
    const rawSel: any[] = Array.isArray(req.body.itemIds) ? req.body.itemIds : [];
    const selIds = new Set(rawSel.map((x) => parseInt(String(x))).filter((n) => n > 0));
    const chosen = selIds.size ? cart.items.filter((i) => selIds.has(i.id)) : cart.items;
    if (chosen.length === 0) { res.status(400).json({ success: false, message: 'Məhsul seçilməyib' }); return; }
    const items = chosen.map((i) => ({ listingId: i.listingId, quantity: i.quantity }));
    // Çatdırılma rejimi: SENDER (göndərənin ünvanına) və ya RECIPIENT (alıcı seçir).
    const deliveryMode = String(req.body.deliveryMode || '').toUpperCase() === 'SENDER' ? 'SENDER' : 'RECIPIENT';
    const num = (v: any) => (v != null && v !== '' ? parseFloat(String(v)) : null);
    const loc = deliveryMode === 'SENDER' ? {
      address: req.body.address?.trim() || null, city: req.body.city?.trim() || null,
      latitude: num(req.body.latitude), longitude: num(req.body.longitude), phone: req.body.phone?.trim() || null,
    } : {};
    let token = shareToken();
    for (let i = 0; i < 5; i++) {
      try { await prisma.sharedCart.create({ data: { token, userId: req.adminId!, title: req.body?.title?.trim() || null, items, deliveryMode, ...loc } }); break; }
      catch { token = shareToken(); }
    }
    res.json({ success: true, token });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Paylaşılan səbəti gör (açıq — linki açan giriş etmədən baxa bilər).
router.get('/shared-cart/:token', async (req: AuthRequest, res: Response) => {
  try {
    const sc = await prisma.sharedCart.findUnique({ where: { token: req.params.token } });
    if (!sc) { res.status(404).json({ success: false, message: 'Səbət tapılmadı' }); return; }
    const by = await prisma.user.findUnique({ where: { id: sc.userId }, select: { id: true, name: true } });
    const items = Array.isArray(sc.items) ? (sc.items as any[]) : [];
    const ids = items.map((i) => i.listingId);
    const listings = await prisma.listing.findMany({
      where: { id: { in: ids }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { id: true, title: true, price: true, images: true, stock: true, businessId: true, user: { select: { id: true, name: true } } },
    });
    const byId = new Map(listings.map((l) => [l.id, l]));
    const result = items
      .map((i) => { const l = byId.get(i.listingId); return l ? { ...l, quantity: i.quantity } : null; })
      .filter(Boolean);
    const total = result.reduce((s: number, x: any) => s + x.price * x.quantity, 0);
    res.json({
      success: true, title: sc.title, by, items: result, total, count: result.length,
      deliveryMode: sc.deliveryMode,
      // SENDER rejimində göndərənin çatdırılma ünvanı (alıcı görür, dəyişə bilmir).
      deliveryAddress: sc.deliveryMode === 'SENDER' ? { address: sc.address, city: sc.city, latitude: sc.latitude, longitude: sc.longitude, phone: sc.phone } : null,
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Paylaşılan səbəti birbaşa al (linki alan ödəyir). Rejimə görə çatdırılma:
// SENDER → göndərənin ünvanına; RECIPIENT → alıcının verdiyi ünvana.
router.post('/shared-cart/:token/checkout', requireType(BUYER_TYPES), async (req: AuthRequest, res: Response) => {
  try {
    const sc = await prisma.sharedCart.findUnique({ where: { token: req.params.token } });
    if (!sc) { res.status(404).json({ success: false, message: 'Səbət tapılmadı' }); return; }
    const buyerId = req.adminId!;
    const items = Array.isArray(sc.items) ? (sc.items as any[]) : [];
    const ids = items.map((i) => Number(i.listingId));
    const listings = await prisma.listing.findMany({
      where: { id: { in: ids }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { id: true, title: true, price: true, stock: true, userId: true },
    });
    const byId = new Map(listings.map((l) => [l.id, l]));
    const rows = items.map((i) => { const l = byId.get(Number(i.listingId)); return l ? { ...l, quantity: Math.max(1, Number(i.quantity) || 1) } : null; }).filter(Boolean) as any[];
    if (rows.length === 0) { res.status(400).json({ success: false, message: 'Bu səbətdə aktiv məhsul yoxdur' }); return; }

    // Çatdırılma ünvanı — rejimə görə.
    const num = (v: any) => (v != null && v !== '' ? parseFloat(String(v)) : null);
    const del = sc.deliveryMode === 'SENDER'
      ? { address: sc.address, city: sc.city, phone: sc.phone }
      : { address: req.body.address?.trim() || null, city: req.body.city?.trim() || null, phone: req.body.phone?.trim() || null };
    if (!del.address) { res.status(400).json({ success: false, message: 'Çatdırılma ünvanı tələb olunur' }); return; }
    void num;

    const bySeller = new Map<number, any[]>();
    for (const r of rows) { const a = bySeller.get(r.userId) || []; a.push(r); bySeller.set(r.userId, a); }

    const createdIds: number[] = [];
    await prisma.$transaction(async (tx) => {
      for (const [sellerId, its] of bySeller.entries()) {
        for (const it of its) {
          const upd = await tx.listing.updateMany({ where: { id: it.id, stock: { gte: it.quantity } }, data: { stock: { decrement: it.quantity } } });
          if (upd.count === 0) throw new Error(`"${it.title}" üçün kifayət qədər stok yoxdur`);
        }
        const total = its.reduce((s: number, it: any) => s + it.price * it.quantity, 0);
        const pickupCode = String(Math.floor(1000 + Math.random() * 9000));
        const order = await tx.order.create({
          data: {
            buyerId, sellerId, total, status: 'PENDING', paymentMethod: 'CASH', paymentStatus: 'PENDING',
            deliveryType: 'DELIVERY', address: del.address, phone: del.phone, pickupCode,
            items: { create: its.map((it: any) => ({ listingId: it.id, quantity: it.quantity, price: it.price, title: it.title })) },
          },
        });
        createdIds.push(order.id);
        await tx.notification.create({ data: { userId: sellerId, type: 'ORDER', title: 'Yeni sifariş', body: `Paylaşılan səbətdən sifariş: ${total} AZN`, link: '/orders' } });
      }
    });
    // Səbəti paylaşan şəxsə bildiriş.
    if (sc.userId !== buyerId) {
      await prisma.notification.create({
        data: { userId: sc.userId, type: 'SYSTEM', title: 'Paylaşdığınız səbət alındı ✅',
          body: sc.deliveryMode === 'SENDER' ? 'Ödəniş edildi — məhsullar sizin ünvanınıza göndərilir.' : 'Alıcı öz ünvanına sifariş verdi.', link: '/orders' },
      }).catch(() => {});
    }
    res.json({ success: true, orders: createdIds });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Paylaşılan səbəti öz səbətimə əlavə et (linki alan şəxs öz adından alır).
router.post('/cart/import/:token', requireType(BUYER_TYPES), async (req: AuthRequest, res: Response) => {
  try {
    const sc = await prisma.sharedCart.findUnique({ where: { token: req.params.token } });
    if (!sc) { res.status(404).json({ success: false, message: 'Səbət tapılmadı' }); return; }
    const items = Array.isArray(sc.items) ? (sc.items as any[]) : [];
    let cart = await prisma.cart.findUnique({ where: { userId: req.adminId! } });
    if (!cart) cart = await prisma.cart.create({ data: { userId: req.adminId! } });
    let added = 0;
    for (const it of items) {
      const lid = Number(it.listingId); const qty = Math.max(1, Number(it.quantity) || 1);
      const listing = await prisma.listing.findUnique({ where: { id: lid }, select: { id: true, expiresAt: true } });
      if (!listing || (listing.expiresAt && listing.expiresAt <= new Date())) continue;
      await prisma.cartItem.upsert({
        where: { cartId_listingId: { cartId: cart.id, listingId: lid } },
        update: { quantity: { increment: qty } },
        create: { cartId: cart.id, listingId: lid, quantity: qty },
      });
      added++;
    }
    res.json({ success: true, added });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Add to cart
router.post('/cart/add', requireType(BUYER_TYPES), async (req: AuthRequest, res: Response) => {
  try {
    const listingId = parseInt(req.body?.listingId);
    const quantity = parseInt(req.body?.quantity ?? 1);
    if (Number.isNaN(listingId)) {
      res.status(400).json({ success: false, message: 'Yanlış elan ID' }); return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      res.status(400).json({ success: false, message: 'Say 0-dan böyük olmalıdır' }); return;
    }
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) { res.status(404).json({ success: false, message: 'Elan tapılmadı' }); return; }
    if (listing.userId === req.adminId) { res.status(400).json({ success: false, message: 'Öz elanınızı ala bilməzsiniz' }); return; }

    let cart = await prisma.cart.findUnique({ where: { userId: req.adminId! } });
    if (!cart) cart = await prisma.cart.create({ data: { userId: req.adminId! } });

    const existing = await prisma.cartItem.findUnique({
      where: { cartId_listingId: { cartId: cart.id, listingId } },
    });

    // H2 fix: validate combined quantity (existing + new) against stock.
    const totalRequested = (existing?.quantity || 0) + quantity;
    if (listing.stock < totalRequested) {
      res.status(400).json({
        success: false,
        message: `Kifayət qədər stok yoxdur (mövcud: ${listing.stock})`,
      });
      return;
    }

    let item;
    if (existing) {
      item = await prisma.cartItem.update({
        where: { id: existing.id },
        data: { quantity: totalRequested },
      });
    } else {
      item = await prisma.cartItem.create({
        data: { cartId: cart.id, listingId, quantity },
      });
    }
    res.status(201).json({ success: true, item });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Update cart item quantity
router.put('/cart/item/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    // H12 fix: validate quantity > 0 and check stock.
    const itemId = parseInt(req.params.id);
    const quantity = parseInt(req.body?.quantity);
    if (Number.isNaN(itemId)) {
      res.status(400).json({ success: false, message: 'Yanlış ID' }); return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      res.status(400).json({ success: false, message: 'Say 0-dan böyük olmalıdır' }); return;
    }
    const item = await prisma.cartItem.findUnique({
      where: { id: itemId },
      include: { cart: true, listing: { select: { stock: true, title: true } } },
    });
    if (!item || item.cart.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    if (item.listing.stock < quantity) {
      res.status(400).json({
        success: false,
        message: `Kifayət qədər stok yoxdur (mövcud: ${item.listing.stock})`,
      });
      return;
    }
    // M11 fix: include listing data in response so frontend doesn't need to refetch.
    const updated = await prisma.cartItem.update({
      where: { id: item.id },
      data: { quantity },
      include: { listing: true },
    });
    res.json({ success: true, item: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Remove from cart
router.delete('/cart/item/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const item = await prisma.cartItem.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { cart: true },
    });
    if (!item || item.cart.userId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    await prisma.cartItem.delete({ where: { id: item.id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Checkout (Bolt Food benzeri: delivery/pickup + scheduled + promo + loyalty)
router.post('/cart/checkout', requireType(BUYER_TYPES), async (req: AuthRequest, res: Response) => {
  try {
    const {
      address, phone, note,
      deliveryType = 'DELIVERY',
      deliveryMethod = 'COURIER', // alıcının seçimi: COURIER (Yango) | SELF (satıcı özü)
      scheduledAt,
      paymentMethod = 'CASH',
      promoCode,
      usePoints = 0,
      latitude, longitude,
    } = req.body;
    const buyerLat = latitude != null && latitude !== '' ? parseFloat(latitude) : null;
    const buyerLng = longitude != null && longitude !== '' ? parseFloat(longitude) : null;
    const dMethod: 'COURIER' | 'SELF' = deliveryMethod === 'SELF' ? 'SELF' : 'COURIER';

    // Biznes adına alış — yalnız canBuy səlahiyyətli ACTIVE işçi (və ya sahib) obyekt seçə bilər.
    let buyerObjectId: number | null = null;
    if (req.body.buyerObjectId) {
      const objId = parseInt(String(req.body.buyerObjectId));
      const obj = await prisma.businessObject.findUnique({ where: { id: objId }, include: { business: { select: { userId: true } } } });
      if (!obj) { res.status(400).json({ success: false, message: 'Seçilmiş obyekt tapılmadı' }); return; }
      let allowed = obj.business.userId === req.adminId;
      if (!allowed) {
        const mem = await prisma.businessMember.findFirst({
          where: { businessId: obj.businessId, userId: req.adminId!, status: 'ACTIVE', canBuy: true, OR: [{ objectId: null }, { objectId: objId }] },
          select: { id: true },
        });
        allowed = !!mem;
      }
      if (!allowed) { res.status(403).json({ success: false, message: 'Bu obyekt adına alış səlahiyyətiniz yoxdur' }); return; }
      buyerObjectId = objId;
    }

    const cart = await prisma.cart.findUnique({
      where: { userId: req.adminId! },
      include: { items: { include: { listing: true } } },
    });
    if (!cart || cart.items.length === 0) {
      res.status(400).json({ success: false, message: 'Səbət boşdur' });
      return;
    }

    // Qismən checkout — yalnız seçilmiş məhsullar (itemIds verilməyibsə hamısı).
    const rawSel: any[] = Array.isArray(req.body.itemIds) ? req.body.itemIds : [];
    const selIds = new Set(rawSel.map((x) => parseInt(String(x))).filter((n) => n > 0));
    if (selIds.size) {
      cart.items = cart.items.filter((i) => selIds.has(i.id));
      if (cart.items.length === 0) { res.status(400).json({ success: false, message: 'Seçilmiş məhsul yoxdur' }); return; }
    }

    // Stok kontrolu (preliminary; final atomic check is inside the transaction below)
    for (const item of cart.items) {
      if (item.listing.stock < item.quantity) {
        res.status(400).json({ success: false, message: `"${item.listing.title}" üçün kifayət qədər stok yoxdur (mövcud: ${item.listing.stock})` });
        return;
      }
    }

    // KART ÖDƏNİŞİ yalnız BİZNESƏ bağlı elanlar üçün mümkündür (VÖEN + bank lazımdır).
    // Fərdi satıcının məhsulu kartla alına bilməz — yalnız nağd/əldən (tap.az kimi).
    if (paymentMethod === 'CARD') {
      // Kart yalnız biznesə bağlı elanlar üçün — businessId və ya (fallback) businessObjectId.
      const nonBusiness = cart.items.filter((i) => !(i.listing.businessId || i.listing.businessObjectId));
      if (nonBusiness.length > 0) {
        res.status(400).json({
          success: false,
          message: `Bu məhsul(lar) yalnız nağd alına bilər: ${nonBusiness.map((i) => `"${i.listing.title}"`).join(', ')}. Satıcı ilə birbaşa danışın.`,
        });
        return;
      }
      // Biznes id-lərini topla; elanda businessId yoxdursa obyektdən çıxar.
      const directBizIds = cart.items.map((i) => i.listing.businessId).filter((x): x is number => !!x);
      const objIds = cart.items.filter((i) => !i.listing.businessId && i.listing.businessObjectId).map((i) => i.listing.businessObjectId as number);
      let objBizIds: number[] = [];
      if (objIds.length) {
        const objs = await prisma.businessObject.findMany({ where: { id: { in: objIds } }, select: { businessId: true } });
        objBizIds = objs.map((o) => o.businessId);
      }
      // Biznes aktiv VƏ təsdiqli olmalıdır.
      const bizIds = Array.from(new Set([...directBizIds, ...objBizIds]));
      const okBiz = await prisma.business.findMany({ where: { id: { in: bizIds }, isActive: true, status: 'APPROVED' }, select: { id: true } });
      if (okBiz.length !== bizIds.length) {
        res.status(400).json({ success: false, message: 'Bu məhsulların biznesi hazırda aktiv deyil — kartla ödəniş mümkün deyil.' });
        return;
      }
    }

    // ── Çatdırılma seçiminin yoxlanması + Yango haqqının hesablanması (satıcı üzrə) ──
    const feeBySeller = new Map<number, number>();
    if (deliveryType === 'DELIVERY') {
      // "Yalnız götürmə" məhsulunda çatdırılma yoxdur (Yango + satıcı çatdırması bağlı).
      const pickupOnlyItem = cart.items.find((i) => (i.listing as any).pickupOnly);
      if (pickupOnlyItem) { res.status(400).json({ success: false, message: `"${pickupOnlyItem.listing.title}" yalnız götürmə ilə satılır — çatdırılma mümkün deyil.` }); return; }
      if (dMethod === 'SELF') {
        // Satıcı özü çatdırılma — bütün elanlar buna icazə verməlidir.
        const notAllowed = cart.items.find((i) => !(i.listing as any).allowSelfDelivery);
        if (notAllowed) { res.status(400).json({ success: false, message: `"${notAllowed.listing.title}" üçün satıcı özü çatdırılma təklif etmir` }); return; }
      } else {
        // Yango (kuryer) — alıcının koordinatı tələb olunur; haqqı check-price ilə hesablanır.
        if (buyerLat == null || buyerLng == null) { res.status(400).json({ success: false, message: 'Yango çatdırılması üçün xəritədən konum seçin' }); return; }
        const grp = new Map<number, typeof cart.items>();
        for (const it of cart.items) { const a = grp.get(it.listing.userId) || []; a.push(it); grp.set(it.listing.userId, a); }
        // Yük limiti (50 kq) — hər satıcı (bir claim) üzrə çəki yoxlanır.
        for (const [, items] of grp.entries()) {
          const w = items.reduce((s, i) => s + i.quantity * ((i.listing as any).weightKg || 0), 0);
          if (w > YANGO_MAX_WEIGHT_KG) {
            res.status(400).json({ success: false, message: `Sifariş çəkisi ${w} kq-dır — Yango limiti ${YANGO_MAX_WEIGHT_KG} kq. Kuryer mümkün deyil; "mağazadan götürmə" və ya "satıcı özü çatdırır" seçin.` });
            return;
          }
        }
        if (isYangoConfigured()) {
          const objIds = Array.from(new Set(cart.items.map((i) => (i.listing as any).businessObjectId).filter((x): x is number => !!x)));
          const objs = objIds.length ? await prisma.businessObject.findMany({ where: { id: { in: objIds } }, select: { id: true, latitude: true, longitude: true } }) : [];
          const objMap = new Map(objs.map((o) => [o.id, o]));
          for (const [sellerId, items] of grp.entries()) {
            const withObj = items.find((i) => (i.listing as any).businessObjectId && objMap.get((i.listing as any).businessObjectId)?.latitude != null);
            const obj = withObj ? objMap.get((withObj.listing as any).businessObjectId) : null;
            if (obj && obj.latitude != null && obj.longitude != null) {
              const weightKg = items.reduce((s, i) => s + i.quantity * ((i.listing as any).weightKg || 1), 0);
              const q = await yangoCheckPrice({ source: [obj.longitude, obj.latitude], destination: [buyerLng, buyerLat], weightKg });
              if (q.ok && q.data?.price) feeBySeller.set(sellerId, parseFloat(String(q.data.price)) || 0);
            }
          }
        }
      }
    }

    // Kullanici bilgilerini al (loyalty points kontrolu)
    const user = await prisma.user.findUnique({ where: { id: req.adminId! } });
    if (!user) {
      res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' });
      return;
    }
    const pointsToUse = Math.max(0, Math.min(parseInt(usePoints) || 0, user.loyaltyPoints));
    const pointsDiscount = pointsToUse * 0.01; // 1 puan = 0.01 AZN

    // Promo kod dogrulama
    let promoCodeRecord: any = null;
    let promoDiscount = 0;
    const subtotal = cart.items.reduce((sum, i) => sum + i.listing.price * i.quantity, 0);
    if (promoCode) {
      promoCodeRecord = await prisma.promoCode.findUnique({ where: { code: promoCode.toUpperCase() } });
      if (promoCodeRecord && promoCodeRecord.active) {
        const now = new Date();
        const valid = promoCodeRecord.validFrom <= now &&
                      (!promoCodeRecord.validUntil || promoCodeRecord.validUntil >= now) &&
                      (!promoCodeRecord.usageLimit || promoCodeRecord.usageCount < promoCodeRecord.usageLimit) &&
                      (!promoCodeRecord.minOrderAmount || subtotal >= promoCodeRecord.minOrderAmount);
        if (valid) {
          if (promoCodeRecord.discountType === 'PERCENT') {
            promoDiscount = (subtotal * promoCodeRecord.discountValue) / 100;
            if (promoCodeRecord.maxDiscount && promoDiscount > promoCodeRecord.maxDiscount) {
              promoDiscount = promoCodeRecord.maxDiscount;
            }
          } else {
            promoDiscount = promoCodeRecord.discountValue;
          }
        }
      }
    }

    // Group items by seller (preserve insertion order for deterministic discount allocation)
    const bySeller = new Map<number, typeof cart.items>();
    for (const item of cart.items) {
      const arr = bySeller.get(item.listing.userId) || [];
      arr.push(item);
      bySeller.set(item.listing.userId, arr);
    }
    const sellerCount = bySeller.size;

    const orders = await prisma.$transaction(async (tx) => {
      const createdOrders: any[] = [];

      // C7 fix: Allocate discount sequentially. Use leftover-rolling so the
      // full discount is applied even when one seller's subtotal is smaller
      // than its naive equal share.
      let promoRemaining = promoDiscount;
      let pointsRemaining = pointsToUse;

      // Distribute points fairly: integer pieces summing exactly to pointsToUse.
      // Last seller absorbs rounding remainder so total == pointsToUse exactly.
      const pointsBuckets: number[] = [];
      const evenShare = Math.floor(pointsToUse / sellerCount);
      let assigned = 0;
      for (let i = 0; i < sellerCount; i++) {
        if (i === sellerCount - 1) pointsBuckets.push(pointsToUse - assigned);
        else { pointsBuckets.push(evenShare); assigned += evenShare; }
      }

      let bucketIdx = 0;
      for (const [sellerId, items] of bySeller.entries()) {
        const sellerSubtotal = items.reduce((sum, i) => sum + i.listing.price * i.quantity, 0);
        const sellerPointsUsed = pointsBuckets[bucketIdx++];

        // Apply remaining promo first (capped by what this seller's subtotal can absorb).
        const promoApplied = Math.min(promoRemaining, sellerSubtotal);
        promoRemaining -= promoApplied;

        // Then apply remaining points.
        const remainingAfterPromo = sellerSubtotal - promoApplied;
        const pointsAppliedAzn = Math.min(pointsRemaining * 0.01, remainingAfterPromo);
        const pointsAppliedRaw = Math.round(pointsAppliedAzn * 100); // back to point units
        pointsRemaining -= pointsAppliedRaw;

        const actualDiscount = promoApplied + pointsAppliedRaw * 0.01;
        // Yango çatdırılma haqqı (yalnız kuryer+çatdırılma seçimində) cəmə əlavə olunur.
        const sellerDeliveryFee = deliveryType === 'DELIVERY' && dMethod === 'COURIER' ? (feeBySeller.get(sellerId) || 0) : 0;
        const total = Math.max(0, sellerSubtotal - actualDiscount) + sellerDeliveryFee;

        // C8 fix: Never mint loyalty points on portions of an order paid with points.
        // Only the cash-paid portion qualifies for new points.
        const cashPaidPortion = Math.max(0, sellerSubtotal - promoApplied - pointsAppliedRaw * 0.01);
        const pointsEarned = Math.floor(cashPaidPortion); // 1 AZN nağd ödənilən = 1 xal

        // C6 fix: atomic stock decrement + check via updateMany with stock>=qty guard.
        // If any update fails the predicate, we throw to roll back the whole transaction.
        for (const i of items) {
          // KART: stok ödəniş təsdiqlənəndə (payment callback → PAID) azalır — burada
          // yalnız mövcudluğu yoxlayırıq ki, tükənmiş məhsul satışa getməsin. Beləliklə
          // ödənilməmiş/tərk edilmiş kart sifarişi stoku bloklamır.
          if (paymentMethod === 'CARD') {
            if ((i.listing.stock ?? 0) < i.quantity) throw new Error(`"${i.listing.title}" üçün kifayət qədər stok yoxdur`);
            continue;
          }
          // NAĞD / CÜZDAN: elə indi azalt (öhdəlik/ödənilmiş satış).
          const result = await tx.listing.updateMany({
            where: { id: i.listingId, stock: { gte: i.quantity } },
            data: { stock: { decrement: i.quantity } },
          });
          if (result.count === 0) {
            throw new Error(`"${i.listing.title}" üçün kifayət qədər stok yoxdur`);
          }
        }

        const order = await tx.order.create({
          data: {
            buyerId: req.adminId!,
            sellerId,
            subtotal: sellerSubtotal,
            discountAmount: actualDiscount,
            total,
            pointsEarned,
            pointsUsed: sellerPointsUsed,
            address: address || null,
            phone: phone || null,
            note: note || null,
            deliveryType,
            // Çatdırılma metodu alıcının seçimidir (COURIER=Yango | SELF=satıcı özü).
            deliveryMethod: deliveryType === 'PICKUP' ? null : dMethod,
            deliveryFee: sellerDeliveryFee,
            buyerObjectId, // biznes adına alış (canBuy işçi)
            // Hər sifariş üçün unikal təhvil kodu.
            pickupCode: genPickupCode(),
            scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
            paymentMethod,
            // CARD → bank təsdiqləyənə qədər PENDING; WALLET → PAID; CASH → PENDING (çatdırılanda).
            paymentStatus: paymentMethod === 'WALLET' ? 'PAID' : 'PENDING',
            promoCodeId: promoCodeRecord?.id || null,
            latitude: latitude ? parseFloat(latitude) : null,
            longitude: longitude ? parseFloat(longitude) : null,
            items: {
              create: items.map((i) => ({
                listingId: i.listingId,
                quantity: i.quantity,
                price: i.listing.price,
                title: i.listing.title,
              })),
            },
          },
        });

        // Saticiya bildirim
        await tx.notification.create({
          data: {
            userId: sellerId,
            type: 'ORDER',
            title: 'Yeni sifariş',
            body: `Sizə yeni sifariş gəldi: ${total.toFixed(2)} AZN`,
            link: '/orders',
          },
        });

        createdOrders.push(order);
      }

      // M14: Single user.update for net loyalty change (was 2 round-trips).
      // CARD: qazanılan xal yalnız ödəniş təsdiqlənəndə (payment callback) hesablanır;
      // burada yalnız istifadə olunan xal çıxılır. CASH/WALLET: dərhal hesablanır.
      const totalPointsEarned = createdOrders.reduce((s, o) => s + o.pointsEarned, 0);
      const earnedNow = paymentMethod === 'CARD' ? 0 : totalPointsEarned;
      const netPointsDelta = earnedNow - pointsToUse;
      if (netPointsDelta !== 0) {
        await tx.user.update({
          where: { id: req.adminId! },
          data: {
            loyaltyPoints: netPointsDelta > 0
              ? { increment: netPointsDelta }
              : { decrement: -netPointsDelta },
          },
        });
      }

      // H10 fix: Promo usageCount is incremented inside the transaction with
      // an atomic check that we haven't exceeded the limit.
      if (promoCodeRecord) {
        if (promoCodeRecord.usageLimit) {
          const r = await tx.promoCode.updateMany({
            where: {
              id: promoCodeRecord.id,
              usageCount: { lt: promoCodeRecord.usageLimit },
            },
            data: { usageCount: { increment: 1 } },
          });
          if (r.count === 0) {
            throw new Error('Promo kodun istifadə limiti tükənib');
          }
        } else {
          await tx.promoCode.update({
            where: { id: promoCodeRecord.id },
            data: { usageCount: { increment: 1 } },
          });
        }
      }

      // Yalnız checkout edilən (seçilmiş) məhsulları səbətdən sil — qalanları qalır.
      await tx.cartItem.deleteMany({ where: { id: { in: cart.items.map((i) => i.id) } } });

      return createdOrders;
    });

    // KART ÖDƏNİŞİ: transaction commit olandan SONRA (xarici API çağırışı
    // tranzaksiya içində olmamalıdır) Kapital-də bir ödəniş yaradılır və
    // checkout-dakı bütün order-lər həmin gatewayOrderId ilə bağlanır.
    let paymentUrl: string | null = null;
    if (paymentMethod === 'CARD') {
      const grandTotal = orders.reduce((s, o) => s + o.total, 0);
      if (grandTotal <= 0) {
        // Tamamilə endirimlə örtülüb — ödənişə ehtiyac yoxdur.
        await prisma.order.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { paymentStatus: 'PAID' } });
      } else {
        try {
          // Şlüz facade YIĞIM (MAGNET) və ya Kapital-ı seçir (PAYMENT_GATEWAY env).
          const ref = `TX${orders[0].id}`;
          const pay = await createGatewayPayment({
            amount: grandTotal,
            reference: ref,
            title: 'tradixai',
            description: `Sifariş #${orders.map((o) => o.id).join(',')}`,
            callbackBase: PUBLIC_BACKEND_URL,
          });
          await prisma.order.updateMany({
            where: { id: { in: orders.map((o) => o.id) } },
            data: {
              gatewayProvider: pay.provider,
              gatewayRef: pay.ref,
              gatewayOrderId: pay.gatewayOrderId,
              gatewayPassword: pay.password,
              gatewayStatus: pay.status,
            },
          });
          paymentUrl = pay.redirectUrl;
        } catch (err: any) {
          // Ödəniş başlaya bilmədi → kompensasiya: istifadə olunan xal, promo və
          // order-ləri geri qaytar. (Kartda stok checkout-da AZALDILMIR, ona görə
          // burada stok bərpası YOXDUR — əks halda over-increment olardı.)
          console.error('[checkout] gateway createPayment failed:', err.message);
          try {
            await prisma.$transaction(async (tx) => {
              if (pointsToUse > 0) {
                await tx.user.update({ where: { id: req.adminId! }, data: { loyaltyPoints: { increment: pointsToUse } } });
              }
              if (promoCodeRecord) {
                await tx.promoCode.update({ where: { id: promoCodeRecord.id }, data: { usageCount: { decrement: 1 } } }).catch(() => {});
              }
              await tx.order.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { status: 'CANCELLED', paymentStatus: 'FAILED', referralVoided: true } });
            });
          } catch (rbErr: any) {
            console.error('[checkout] rollback failed:', rbErr.message);
          }
          res.status(502).json({ success: false, message: 'Ödəniş başladıla bilmədi: ' + err.message });
          return;
        }
      }
    }

    res.status(201).json({
      success: true,
      orders,
      paymentUrl, // CARD olduqda — frontend bura yönəltməlidir
      totalDiscount: orders.reduce((s, o) => s + (o.discountAmount || 0), 0),
      pointsEarned: orders.reduce((s, o) => s + o.pointsEarned, 0),
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get my orders (as buyer)
router.get('/orders/buying', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      // Ödənilməmiş KART sifarişi heç bir siyahıda görünmür — ödəniş uğursuzdursa sifariş
      // sanki heç yaranmayıb (nə alıcı, nə satıcı görür). Nağd/wallet normal görünür.
      where: { buyerId: req.adminId!, hiddenForBuyer: false, OR: [{ paymentMethod: { not: 'CARD' } }, { paymentStatus: 'PAID' }] },
      include: {
        items: true,
        seller: {
          select: {
            id: true, name: true, phone: true,
            workplaces: { select: { latitude: true, longitude: true, address: true } },
          },
        },
        courier: { select: { id: true, name: true, phone: true } },
        buyerObject: { select: { id: true, name: true } },
        returnRequests: { include: { orderItem: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ orders });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get orders for my listings (as seller) — MUST be before /orders/:id to
// avoid being shadowed by Express route matching (the param route would
// catch "selling" as :id and call findUnique({ id: NaN }) → 404).
router.get('/orders/selling', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      // Ödənilməmiş KART sifarişi satıcıya da görünmür (uğursuz ödənişdə qəbul/rədd çıxmasın).
      where: { sellerId: req.adminId!, hiddenForSeller: false, OR: [{ paymentMethod: { not: 'CARD' } }, { paymentStatus: 'PAID' }] },
      include: {
        items: true,
        buyer: { select: { id: true, name: true, phone: true } },
        buyerObject: { select: { id: true, name: true } },
        referrer: { select: { id: true, name: true, profession: true } },
        returnRequests: {
          include: {
            orderItem: true,
            buyer: { select: { id: true, name: true, phone: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ orders });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get single order detail with live location (buyer or seller or courier)
router.get('/orders/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, message: 'Yanlış ID' });
      return;
    }
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        items: { include: { listing: { select: { id: true, title: true, images: true } } } },
        buyer: { select: { id: true, name: true, phone: true } },
        seller: {
          select: {
            id: true, name: true, phone: true,
            workplaces: { select: { latitude: true, longitude: true, address: true, name: true } },
          },
        },
        courier: { select: { id: true, name: true, phone: true } },
      },
    });
    if (!order) {
      res.status(404).json({ success: false, message: 'Sifariş tapılmadı' });
      return;
    }
    // Yalniz alici, satici veya kurye goremez
    if (order.buyerId !== req.adminId && order.sellerId !== req.adminId && order.courierId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    // M5 fix: If caller is buyer, only show the workplace they actually
    // ordered from — not all of seller's workplaces (privacy leak).
    if (order.buyerId === req.adminId && order.seller?.workplaces) {
      // We don't know which exact workplace the buyer ordered from, but we
      // limit to the first one to avoid leaking the full list of seller addresses.
      order.seller.workplaces = order.seller.workplaces.slice(0, 1);
    }
    res.json({ order });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Update order status (seller only) + buyer bildirimi
// Enforces a state machine so a seller cannot skip statuses
// (e.g. PENDING → DELIVERED bypassing the courier).
const ORDER_TRANSITIONS: Record<string, string[]> = {
  PENDING:   ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SHIPPED', 'CANCELLED'],
  SHIPPED:   ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

router.put('/orders/:id/status', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, message: 'Yanlış ID' }); return;
    }
    const next = String(req.body?.status || '').toUpperCase();
    if (!ORDER_TRANSITIONS[next] && next !== 'PENDING') {
      // Allow only enum values defined in the transition map.
      res.status(400).json({ success: false, message: 'Yanlış status' }); return;
    }
    const order = await prisma.order.findUnique({ where: { id } });
    const isSeller = !!order && order.sellerId === req.adminId;
    const isBuyer = !!order && order.buyerId === req.adminId;
    if (!order || (!isSeller && !isBuyer)) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    // Satıcı bütün keçidləri edə bilər; alıcı yalnız: gözləyəni ləğv, göndərilən sifarişi "təhvil aldım".
    const BUYER_TRANSITIONS: Record<string, string[]> = { PENDING: ['CANCELLED'], SHIPPED: ['DELIVERED'] };
    const allowed = isSeller ? (ORDER_TRANSITIONS[order.status] || []) : (BUYER_TRANSITIONS[order.status] || []);
    if (!allowed.includes(next)) {
      res.status(400).json({
        success: false,
        message: `${order.status} → ${next} keçidi icazə verilmir`,
      });
      return;
    }
    // Kartla ödənilən sifarişi ödəniş təsdiqlənmədən göndərmək olmaz.
    if (order.paymentMethod === 'CARD' && order.paymentStatus !== 'PAID' && (next === 'SHIPPED' || next === 'DELIVERED')) {
      res.status(400).json({ success: false, message: 'Ödəniş təsdiqlənməyib — sifarişi göndərmək olmaz' });
      return;
    }
    // DELIVERED üçün təhvil kodu YALNIZ satıcı təsdiqləyəndə tələb olunur (səhv adama təhvilin
    // qarşısı). Alıcı özü "təhvil aldım" deyəndə kod lazım deyil — özü təsdiqləyir.
    if (next === 'DELIVERED' && isSeller && order.pickupCode) {
      const provided = String(req.body?.code || '').trim().toUpperCase();
      if (provided !== order.pickupCode.toUpperCase()) {
        res.status(400).json({ success: false, message: 'Təhvil kodu yanlışdır. Alıcıdan kodu soruşun.' });
        return;
      }
    }
    const updated = await prisma.order.update({
      where: { id },
      data: { status: next as any },
    });

    // Satıcı təsdiqləyəndə Yango sifarişini avtomatik kuryerə göndər (best-effort).
    if (next === 'CONFIRMED' && order.deliveryType !== 'PICKUP' && order.deliveryMethod === 'COURIER' && !order.yangoClaimId && isYangoConfigured()) {
      dispatchOrderToYango(order.id).catch(() => {});
    }

    // Sifariş ləğv edildikdə referal komissiyasını ləğv et (ləğv olunan sifariş üçün komissiya ödənilmir).
    if (next === 'CANCELLED' && order.referrerId && !order.referralVoided) {
      await prisma.order.update({ where: { id }, data: { referralVoided: true } });
      await prisma.notification.create({
        data: { userId: order.referrerId, type: 'REFERRAL', title: 'Referal komissiyası ləğv edildi', body: `Sifariş #${order.id} ləğv edildiyi üçün komissiya ləğv olundu.`, link: '/referral-earnings' },
      }).catch(() => {});
    }

    // Aliciya bildirim
    const statusLabels: Record<string, string> = {
      CONFIRMED: 'qəbul edildi',
      SHIPPED: 'yola çıxdı',
      DELIVERED: 'çatdırıldı',
      CANCELLED: 'rədd/ləğv edildi',
    };
    const label = statusLabels[next];
    if (label) {
      // Statusu satıcı dəyişibsə alıcıya, alıcı dəyişibsə (təhvil aldım/ləğv) satıcıya bildir.
      await prisma.notification.create({
        data: {
          userId: isBuyer ? order.sellerId : order.buyerId,
          type: 'ORDER',
          title: `Sifariş #${order.id}`,
          body: isBuyer && next === 'DELIVERED' ? 'Alıcı sifarişi təhvil aldı.' : `Sifariş ${label}.`,
          link: '/orders',
        },
      });
    }

    res.json({ success: true, order: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Sifarişi öz siyahından sil (soft-hide) — yalnız tamamlanmış/ləğv olunmuş sifarişlər.
// Sifariş qarşı tərəf üçün qalır; yalnız silən şəxsin siyahısından gizlədilir.
router.delete('/orders/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ success: false, message: 'Yanlış ID' }); return; }
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true, buyerId: true, sellerId: true, status: true } });
    const isSeller = !!order && order.sellerId === req.adminId;
    const isBuyer = !!order && order.buyerId === req.adminId;
    if (!order || (!isSeller && !isBuyer)) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (!['CANCELLED', 'DELIVERED'].includes(order.status)) {
      res.status(400).json({ success: false, message: 'Yalnız tamamlanmış və ya ləğv olunmuş sifarişi silə bilərsiniz' }); return;
    }
    await prisma.order.update({ where: { id }, data: isBuyer ? { hiddenForBuyer: true } : { hiddenForSeller: true } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Kurye canli konumu guncelle (kurye)
router.put('/orders/:id/courier-location', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!order || order.courierId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    const { lat, lng } = req.body;
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        courierLat: lat ? parseFloat(lat) : null,
        courierLng: lng ? parseFloat(lng) : null,
      },
    });
    res.json({ success: true, order: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== RETURN / REFUND SYSTEM =====================

// Create return request (buyer)
router.post('/returns', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { orderId, orderItemId, reason, reasonText, quantity } = req.body;
    const order = await prisma.order.findUnique({
      where: { id: parseInt(orderId) },
      include: { items: true },
    });
    if (!order || order.buyerId !== req.adminId) {
      res.status(403).json({ success: false, message: 'Bu sifariş sizə aid deyil' }); return;
    }
    if (order.status !== 'DELIVERED') {
      res.status(400).json({ success: false, message: 'Yalnız çatdırılmış sifarişlər üçün iadə tələb edə bilərsiniz' }); return;
    }

    let refundAmount: number;
    let itemId: number | null = null;

    if (orderItemId) {
      const item = order.items.find((i) => i.id === parseInt(orderItemId));
      if (!item) { res.status(404).json({ success: false, message: 'Məhsul tapılmadı' }); return; }
      const qty = parseInt(quantity) || item.quantity;
      if (qty > item.quantity) { res.status(400).json({ success: false, message: 'Miqdar orijinaldan çox ola bilməz' }); return; }
      refundAmount = item.price * qty;
      itemId = item.id;

      // Check no active return for same item
      const existing = await prisma.returnRequest.findFirst({
        where: { orderItemId: item.id, status: { notIn: ['CANCELLED', 'REJECTED'] } },
      });
      if (existing) { res.status(400).json({ success: false, message: 'Bu məhsul üçün aktiv iadə sorğusu var' }); return; }
    } else {
      refundAmount = order.total;
      const existing = await prisma.returnRequest.findFirst({
        where: { orderId: order.id, orderItemId: null, status: { notIn: ['CANCELLED', 'REJECTED'] } },
      });
      if (existing) { res.status(400).json({ success: false, message: 'Bu sifariş üçün aktiv iadə sorğusu var' }); return; }
    }

    // H14 fix: when orderItemId is null (full-order return), force quantity
    // to be the sum of all items — ignore any user-provided value.
    const returnQuantity = orderItemId
      ? (parseInt(quantity) || order.items.find((i) => i.id === parseInt(orderItemId))!.quantity)
      : order.items.reduce((s, i) => s + i.quantity, 0);

    const returnReq = await prisma.returnRequest.create({
      data: {
        orderId: order.id,
        orderItemId: itemId,
        buyerId: req.adminId!,
        sellerId: order.sellerId,
        reason,
        reasonText: reasonText || null,
        quantity: returnQuantity,
        refundAmount,
      },
    });
    res.status(201).json({ success: true, returnRequest: returnReq });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get buyer's return requests
router.get('/returns/buying', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const returns = await prisma.returnRequest.findMany({
      where: { buyerId: req.adminId! },
      include: { order: { include: { items: true } }, orderItem: true, seller: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ returns });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get seller's return requests
router.get('/returns/selling', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const returns = await prisma.returnRequest.findMany({
      where: { sellerId: req.adminId! },
      include: { order: { include: { items: true } }, orderItem: true, buyer: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ returns });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Cancel return (buyer, only REQUESTED)
router.put('/returns/:id/cancel', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!ret || ret.buyerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ret.status !== 'REQUESTED') { res.status(400).json({ success: false, message: 'Yalnız gözləyən sorğuları ləğv edə bilərsiniz' }); return; }
    const updated = await prisma.returnRequest.update({ where: { id: ret.id }, data: { status: 'CANCELLED' } });
    res.json({ success: true, returnRequest: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Mark return as shipped (buyer, only APPROVED)
router.put('/returns/:id/ship', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!ret || ret.buyerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ret.status !== 'APPROVED') { res.status(400).json({ success: false, message: 'Sorğu hələ təsdiqlənməyib' }); return; }
    const updated = await prisma.returnRequest.update({ where: { id: ret.id }, data: { status: 'RETURN_SHIPPED' } });
    res.json({ success: true, returnRequest: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Approve return (seller, only REQUESTED)
router.put('/returns/:id/approve', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!ret || ret.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ret.status !== 'REQUESTED') { res.status(400).json({ success: false, message: 'Bu sorğu artıq cavablandırılıb' }); return; }
    const { refundAmount } = req.body;
    const updated = await prisma.returnRequest.update({
      where: { id: ret.id },
      data: { status: 'APPROVED', refundAmount: refundAmount ? parseFloat(refundAmount) : ret.refundAmount },
    });
    res.json({ success: true, returnRequest: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Reject return (seller, only REQUESTED)
router.put('/returns/:id/reject', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!ret || ret.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ret.status !== 'REQUESTED') { res.status(400).json({ success: false, message: 'Bu sorğu artıq cavablandırılıb' }); return; }
    const updated = await prisma.returnRequest.update({
      where: { id: ret.id },
      data: { status: 'REJECTED', sellerNote: req.body.sellerNote || null },
    });
    res.json({ success: true, returnRequest: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Confirm return received (seller, only RETURN_SHIPPED)
router.put('/returns/:id/receive', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!ret || ret.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ret.status !== 'RETURN_SHIPPED') { res.status(400).json({ success: false, message: 'Məhsul hələ göndərilməyib' }); return; }
    const updated = await prisma.returnRequest.update({ where: { id: ret.id }, data: { status: 'RETURN_RECEIVED' } });
    res.json({ success: true, returnRequest: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Issue refund + restore stock (seller, only RETURN_RECEIVED) - uses transaction
router.put('/returns/:id/refund', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ret = await prisma.returnRequest.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { orderItem: true, order: { include: { items: true } } },
    });
    if (!ret || ret.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (ret.status !== 'RETURN_RECEIVED') { res.status(400).json({ success: false, message: 'Məhsul hələ qəbul edilməyib' }); return; }

    // Kart ödənişidirsə — pulu BANK vasitəsilə geri qaytar (DB dəyişməzdən əvvəl).
    const ord = ret.order;
    const isCardPaid = !!((ord.gatewayRef || ord.gatewayOrderId) && ord.paymentStatus === 'PAID');
    if (isCardPaid) {
      const amt = ret.refundAmount ?? ord.total;
      try {
        await gatewayRefundOrder(ord, amt);
      } catch (err: any) {
        res.status(502).json({ success: false, message: 'Bank iadəsi alınmadı: ' + err.message }); return;
      }
    }

    const stockWarnings: string[] = [];

    // Transaction ile refund + stock restore atomik yap
    const updated = await prisma.$transaction(async (tx) => {
      // Restore stock
      if (ret.orderItem) {
        const listing = await tx.listing.findUnique({ where: { id: ret.orderItem.listingId } });
        if (listing) {
          await tx.listing.update({
            where: { id: ret.orderItem.listingId },
            data: { stock: { increment: ret.quantity } },
          });
        } else {
          stockWarnings.push(`Elan #${ret.orderItem.listingId} silinib, stok bərpa edilə bilmədi`);
        }
      } else {
        // Full order return - restore all items
        for (const item of ret.order.items) {
          const listing = await tx.listing.findUnique({ where: { id: item.listingId } });
          if (listing) {
            await tx.listing.update({
              where: { id: item.listingId },
              data: { stock: { increment: item.quantity } },
            });
          } else {
            stockWarnings.push(`Elan #${item.listingId} silinib, stok bərpa edilə bilmədi`);
          }
        }
      }

      if (isCardPaid) {
        await tx.order.update({ where: { id: ord.id }, data: { paymentStatus: 'REFUNDED', gatewayStatus: 'Refunded' } });
      }

      // Referal komissiyasını ləğv et (qaytarılmış mal üçün komissiya ödənilmir).
      if (ord.referrerId && !ord.referralVoided) {
        await tx.order.update({ where: { id: ord.id }, data: { referralVoided: true } });
        await tx.notification.create({
          data: { userId: ord.referrerId, type: 'REFERRAL', title: 'Referal komissiyası ləğv edildi', body: `Sifariş #${ord.id} qaytarıldığı üçün komissiya ləğv olundu.`, link: '/referral-earnings' },
        }).catch(() => {});
      }

      return await tx.returnRequest.update({ where: { id: ret.id }, data: { status: 'REFUNDED' } });
    });

    if (stockWarnings.length > 0) {
      console.warn(`Refund #${ret.id} stock warnings:`, stockWarnings);
    }

    res.json({ success: true, returnRequest: updated, stockWarnings: stockWarnings.length > 0 ? stockWarnings : undefined });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
