// BİRGƏ ALIŞ marşrutları — pəncərəyə baxmaq (yaratmaq AVTOMATİKdir).
//
// Pəncərə alıcı tərəfindən YARADILMIR: elanda birgə alış açıqdırsa ilk sifariş
// verilən anda server özü açır (services/groupBuy → ensureActiveGroup).
// Ona görə burada yalnız OXUMA marşrutları var.
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { groupState, listingGroupState, groupBuyEnabled, RETURN_WINDOW_DAYS } from '../services/groupBuy';
import { priceInfo, type Tier } from '../services/tierPricing';

const router = Router();
const prisma = new PrismaClient();

// ── Elanın say-qiymət cədvəli + verilmiş say üçün qiymət (ictimai) ──
// Frontend «50 ədəd alsam neçəyə düşür?» sualını BURADAN soruşur; düstur
// yalnız serverdə saxlanılır ki, qiymət hər yerdə eyni hesablansın.
router.get('/listings/:id/price', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const qty = Math.max(1, parseInt(String(req.query.qty || '1')) || 1);
    const listing = await prisma.listing.findUnique({
      where: { id },
      select: { id: true, price: true, stock: true, groupBuyDays: true, priceTiers: { orderBy: { minQty: 'asc' } } },
    });
    if (!listing) { res.status(404).json({ success: false, message: 'Elan tapılmadı' }); return; }
    const tiers: Tier[] = listing.priceTiers.map((t) => ({ minQty: t.minQty, price: t.price }));
    res.json({
      success: true,
      tiers,
      // Birgə alış: satıcı açıbsa (müddət seçib), pillə varsa və stok 1-dən çoxdursa.
      groupBuyAvailable: groupBuyEnabled(listing as any),
      groupBuyDays: listing.groupBuyDays || null,
      returnWindowDays: RETURN_WINDOW_DAYS,
      ...priceInfo(listing.price, tiers, qty),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Elanın AKTİV birgə alış pəncərəsi (ictimai) ──
// Məhsul səhifəsindəki geri sayım bunu oxuyur. Pəncərə hələ açılmayıbsa
// (heç kim almayıb) `group: null` qayıdır, amma şərtlər göndərilir ki,
// səhifə «ilk alan pəncərəni başladır» izahını göstərə bilsin.
router.get('/listings/:id/group-buy', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const listing = await prisma.listing.findUnique({
      where: { id },
      select: { id: true, price: true, stock: true, groupBuyDays: true, priceTiers: { orderBy: { minQty: 'asc' } } },
    });
    if (!listing) { res.status(404).json({ success: false, message: 'Elan tapılmadı' }); return; }
    const enabled = groupBuyEnabled(listing as any);
    const tiers: Tier[] = listing.priceTiers.map((t) => ({ minQty: t.minQty, price: t.price }));
    res.json({
      success: true,
      enabled,
      windowDays: listing.groupBuyDays || null,
      returnWindowDays: RETURN_WINDOW_DAYS,
      stock: listing.stock,
      tiers,
      bestPrice: tiers.length ? tiers[tiers.length - 1].price : listing.price,
      group: enabled ? await listingGroupState(id) : null,
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Qrupun vəziyyəti (kod ilə) ──
// Açıqdır: linki alan hər kəs (qeydiyyatsız da) görə bilməlidir.
router.get('/group-buy/:code', async (req: Request, res: Response) => {
  try {
    const st = await groupState(String(req.params.code));
    if (!st) { res.status(404).json({ success: false, message: 'Birgə alış tapılmadı' }); return; }
    res.json({ success: true, group: st });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Mənim birgə alışlarım (iştirak etdiyim pəncərələr) ──
router.get('/me/group-buys', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const mine = await prisma.groupBuy.findMany({
      where: { orders: { some: { buyerId: req.adminId!, status: { not: 'CANCELLED' } } } },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { code: true },
    });
    const list = [];
    for (const m of mine) { const st = await groupState(m.code); if (st) list.push(st); }
    res.json({ success: true, groups: list });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
