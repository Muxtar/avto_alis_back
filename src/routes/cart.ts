import { Router, Response } from 'express';
import { PrismaClient, UserType } from '@prisma/client';
import { adminAuth, requireType, AuthRequest } from '../middleware/auth';

const BUYER_TYPES: UserType[] = [UserType.CAR_OWNER, UserType.MECHANIC, UserType.PARTS_SELLER];

const router = Router();
const prisma = new PrismaClient();

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
      scheduledAt,
      paymentMethod = 'CASH',
      promoCode,
      usePoints = 0,
      latitude, longitude,
    } = req.body;

    const cart = await prisma.cart.findUnique({
      where: { userId: req.adminId! },
      include: { items: { include: { listing: true } } },
    });
    if (!cart || cart.items.length === 0) {
      res.status(400).json({ success: false, message: 'Səbət boşdur' });
      return;
    }

    // Stok kontrolu (preliminary; final atomic check is inside the transaction below)
    for (const item of cart.items) {
      if (item.listing.stock < item.quantity) {
        res.status(400).json({ success: false, message: `"${item.listing.title}" üçün kifayət qədər stok yoxdur (mövcud: ${item.listing.stock})` });
        return;
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
        const total = Math.max(0, sellerSubtotal - actualDiscount);

        // C8 fix: Never mint loyalty points on portions of an order paid with points.
        // Only the cash-paid portion qualifies for new points.
        const cashPaidPortion = Math.max(0, sellerSubtotal - promoApplied - pointsAppliedRaw * 0.01);
        const pointsEarned = Math.floor(cashPaidPortion); // 1 AZN nağd ödənilən = 1 xal

        // C6 fix: atomic stock decrement + check via updateMany with stock>=qty guard.
        // If any update fails the predicate, we throw to roll back the whole transaction.
        for (const i of items) {
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
            scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
            paymentMethod,
            paymentStatus: paymentMethod === 'CASH' ? 'PENDING' : 'PAID',
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
      const totalPointsEarned = createdOrders.reduce((s, o) => s + o.pointsEarned, 0);
      const netPointsDelta = totalPointsEarned - pointsToUse;
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

      // Sepeti temizle
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      return createdOrders;
    });

    res.status(201).json({
      success: true,
      orders,
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
      where: { buyerId: req.adminId! },
      include: {
        items: true,
        seller: {
          select: {
            id: true, name: true, phone: true,
            workplaces: { select: { latitude: true, longitude: true, address: true } },
          },
        },
        courier: { select: { id: true, name: true, phone: true } },
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
      where: { sellerId: req.adminId! },
      include: {
        items: true,
        buyer: { select: { id: true, name: true, phone: true } },
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
    if (!order || order.sellerId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    const allowed = ORDER_TRANSITIONS[order.status] || [];
    if (!allowed.includes(next)) {
      res.status(400).json({
        success: false,
        message: `${order.status} → ${next} keçidi icazə verilmir`,
      });
      return;
    }
    const updated = await prisma.order.update({
      where: { id },
      data: { status: next as any },
    });

    // Aliciya bildirim
    const statusLabels: Record<string, string> = {
      CONFIRMED: 'təsdiqləndi',
      SHIPPED: 'yola çıxdı',
      DELIVERED: 'çatdırıldı',
      CANCELLED: 'ləğv edildi',
    };
    const label = statusLabels[next];
    if (label) {
      await prisma.notification.create({
        data: {
          userId: order.buyerId,
          type: 'ORDER',
          title: `Sifariş #${order.id}`,
          body: `Sifarişiniz ${label}.`,
          link: '/orders',
        },
      });
    }

    res.json({ success: true, order: updated });
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
