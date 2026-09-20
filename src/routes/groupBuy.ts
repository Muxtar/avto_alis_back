// BİRGƏ ALIŞ marşrutları — qrup yaratmaq, qrupa baxmaq, qrupu bağlamaq.
// Məntiq services/groupBuy.ts-dədir.
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { groupCode, groupState, GROUP_DAYS } from '../services/groupBuy';
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
      select: { id: true, price: true, stock: true, priceTiers: { orderBy: { minQty: 'asc' } } },
    });
    if (!listing) { res.status(404).json({ success: false, message: 'Elan tapılmadı' }); return; }
    const tiers: Tier[] = listing.priceTiers.map((t) => ({ minQty: t.minQty, price: t.price }));
    res.json({
      success: true,
      tiers,
      // Birgə alış YALNIZ pilləsi olan elanda mümkündür.
      groupBuyAvailable: tiers.length > 0,
      ...priceInfo(listing.price, tiers, qty),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Birgə alış yarat (alıcı) ──
router.post('/listings/:id/group-buy', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const listing = await prisma.listing.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true, stock: true, priceTiers: { select: { id: true } } },
    });
    if (!listing) { res.status(404).json({ success: false, message: 'Elan tapılmadı' }); return; }
    if (!listing.priceTiers.length) {
      res.status(400).json({ success: false, message: 'Bu məhsulda çox alanda endirim yoxdur — birgə alış mümkün deyil' }); return;
    }
    if (listing.status !== 'APPROVED') { res.status(400).json({ success: false, message: 'Elan aktiv deyil' }); return; }
    if (listing.userId === req.adminId) { res.status(400).json({ success: false, message: 'Öz elanınıza birgə alış aça bilməzsiniz' }); return; }

    // Eyni istifadəçinin həmin elan üçün AÇIQ qrupu varsa onu qaytar —
    // hər dəfə yeni link yaradılsa iştirakçılar müxtəlif qruplara dağılardı.
    const existing = await prisma.groupBuy.findFirst({
      where: { listingId: id, creatorId: req.adminId!, status: 'OPEN', expiresAt: { gt: new Date() } },
    });
    if (existing) { res.json({ success: true, code: existing.code, expiresAt: existing.expiresAt, reused: true }); return; }

    const days = Math.min(30, Math.max(1, parseInt(String(req.body?.days || GROUP_DAYS)) || GROUP_DAYS));
    let code = groupCode();
    for (let i = 0; i < 5 && (await prisma.groupBuy.findUnique({ where: { code } })); i++) code = groupCode();
    const g = await prisma.groupBuy.create({
      data: {
        code, listingId: id, creatorId: req.adminId!,
        expiresAt: new Date(Date.now() + days * 24 * 3600 * 1000),
      },
    });
    res.status(201).json({ success: true, code: g.code, expiresAt: g.expiresAt });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Qrupun vəziyyəti (link açılanda) ──
// Açıqdır: linki alan hər kəs (qeydiyyatsız da) görə bilməlidir.
router.get('/group-buy/:code', async (req: Request, res: Response) => {
  try {
    const st = await groupState(String(req.params.code));
    if (!st) { res.status(404).json({ success: false, message: 'Birgə alış tapılmadı' }); return; }
    res.json({ success: true, group: st });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Mənim birgə alışlarım (yaratdığım + qoşulduğum) ──
router.get('/me/group-buys', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const mine = await prisma.groupBuy.findMany({
      where: { OR: [{ creatorId: req.adminId! }, { orders: { some: { buyerId: req.adminId! } } }] },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { code: true },
    });
    const list = [];
    for (const m of mine) { const st = await groupState(m.code); if (st) list.push(st); }
    res.json({ success: true, groups: list });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Qrupu bağla (yaradan) ──
router.post('/group-buy/:code/close', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const g = await prisma.groupBuy.findUnique({ where: { code: String(req.params.code) } });
    if (!g) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return; }
    if (g.creatorId !== req.adminId) { res.status(403).json({ success: false, message: 'Yalnız qrupu yaradan bağlaya bilər' }); return; }
    await prisma.groupBuy.update({ where: { id: g.id }, data: { status: 'CLOSED' } });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
