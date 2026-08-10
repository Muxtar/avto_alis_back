import { Router, Response } from 'express';
import { PrismaClient, Prisma, UserType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { adminAuth, requireAdmin, requirePermission, requireSuperAdmin, AuthRequest, generateToken, isAdminPhone, ADMIN_MODULES } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimiter';
import { createOtp } from '../services/otp';
import { refund as kapitalRefund } from '../services/kapital';
import { listFlags, setFlag } from '../services/settings';
import { checkAllServices } from '../services/serviceHealth';
import { runWebSearchTest } from '../services/webSearchAI';
import { runAgent } from '../services/aiAgent';
import { getCommissionPercent, setCommissionPercent, createPayout, sellerBalance } from '../services/settlement';
import { recordSettlement } from '../services/settlement';
import { infobipStatus, testWhatsApp } from '../services/infobipWhatsApp';
import { smsStatus, testSms } from '../services/infobipSms';
import { otpChannel } from '../services/otp';
import fs from 'fs';
import path from 'path';

const router = Router();
const prisma = new PrismaClient();

// ── Tənzimləmələr (feature-flags) ──
// Admin paneldəki "Tənzimləmələr" səhifəsi üçün. Bütün flag-lar meta + cari
// dəyər ilə qaytarılır; PATCH ilə tək açar aktiv/deaktiv edilir.
router.get('/admin/settings', requirePermission('settings'), async (_req: AuthRequest, res: Response) => {
  try {
    const flags = await listFlags();
    res.json({ success: true, settings: flags });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.patch('/admin/settings', requirePermission('settings'), async (req: AuthRequest, res: Response) => {
  try {
    const key = String(req.body?.key || '');
    const value = req.body?.value === true || req.body?.value === 'true';
    if (!key) { res.status(400).json({ success: false, message: 'key tələb olunur' }); return; }
    await setFlag(key, value);
    res.json({ success: true, key, value });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// OTP konfiqurasiya vəziyyəti — aktiv kanal + Infobip SMS/WhatsApp env-ləri.
router.get('/admin/whatsapp-status', requirePermission('settings'), async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ success: true, channel: otpChannel(), sms: smsStatus(), whatsapp: infobipStatus() });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Test OTP mesajı göndər — WhatsApp və/və ya SMS ayrıca sınanır (channel:
// 'whatsapp' | 'sms' | 'both'). Provayderin real cavabını/xətasını qaytarır.
router.post('/admin/whatsapp-test', requirePermission('settings'), async (req: AuthRequest, res: Response) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    if (!phone) { res.status(400).json({ success: false, message: 'phone tələb olunur' }); return; }
    const which = String(req.body?.channel || 'both').toLowerCase();
    const result: any = {};
    if (which === 'whatsapp' || which === 'both') result.whatsapp = await testWhatsApp(phone);
    if (which === 'sms' || which === 'both') result.sms = await testSms(phone);
    res.json({ success: true, channel: otpChannel(), result });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── ADMIN: nömrə + OTP ilə giriş ──
// Nömrə ADMIN_PHONES (Railway env) siyahısında olmalıdır. İsim+şifrə girişi
// yedək olaraq qalır. Eyni nömrə ilə normal saytda giriş də admin verir.

// 1) Nömrəni göndər → siyahıdadırsa OTP göndərilir (SMS).
router.post('/admin/login/phone', authLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const raw = String(req.body?.phone || '').trim();
    if (!isAdminPhone(raw)) { res.status(403).json({ success: false, message: 'Bu nömrə admin siyahısında deyil' }); return; }
    const digits = raw.replace(/\D/g, '');
    const tail = digits.slice(-9);
    // Mövcud istifadəçini formatdan asılı olmadan tap, yoxdursa yarat — hər ikisinə admin rolu.
    let user = await prisma.user.findFirst({ where: { phone: { contains: tail } } });
    if (!user) {
      user = await prisma.user.create({
        data: { name: 'Admin', phone: digits.startsWith('994') ? `+${digits}` : (raw || `+${digits}`), type: 'CAR_OWNER', role: 'ADMIN', verified: true, profileComplete: true },
      });
    } else if (user.role !== 'ADMIN') {
      user = await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    }
    if (user.isBlocked) { res.status(403).json({ success: false, message: 'Hesab bloklanıb' }); return; }
    const otp = await createOtp(user.id); // otp_real aktivdirsə SMS gedir
    res.json({ success: true, userId: user.id, delivered: otp.delivered, ...(otp.showCode ? { code: otp.code } : {}) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// 2) Kodu təsdiqlə → admin token qaytarılır.
router.post('/admin/login/phone/verify', authLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const userId = parseInt(String(req.body?.userId || ''));
    const code = String(req.body?.code || '');
    if (!userId || !code) { res.status(400).json({ success: false, message: 'userId və kod tələb olunur' }); return; }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !isAdminPhone(user.phone)) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (user.isBlocked) { res.status(403).json({ success: false, message: 'Hesab bloklanıb' }); return; }
    const record = await prisma.verificationCode.findFirst({
      where: { userId, verified: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!record || record.code !== code) { res.status(400).json({ success: false, message: 'Kod yanlışdır və ya vaxtı keçib' }); return; }
    await prisma.verificationCode.update({ where: { id: record.id }, data: { verified: true } });
    if (user.role !== 'ADMIN') await prisma.user.update({ where: { id: userId }, data: { role: 'ADMIN' } });
    const token = generateToken(user.id);
    res.json({ success: true, token, admin: { id: user.id, name: user.name } });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin Login
router.post('/admin/login', authLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { username, password } = req.body;

    const admin = await prisma.user.findFirst({
      where: { name: username, role: 'ADMIN' },
    });

    if (!admin || !admin.password) {
      res.status(401).json({ success: false, message: 'Yanlış istifadəçi adı və ya şifrə' });
      return;
    }

    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) {
      res.status(401).json({ success: false, message: 'Yanlış istifadəçi adı və ya şifrə' });
      return;
    }

    const token = generateToken(admin.id);
    res.json({ success: true, token, admin: { id: admin.id, name: admin.name } });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Dashboard Stats
router.get('/admin/dashboard', requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const [totalUsers, totalListings, totalProducts, totalServices, recentUsers, recentListings] = await Promise.all([
      prisma.user.count({ where: { role: 'USER' } }),
      prisma.listing.count(),
      prisma.listing.count({ where: { type: 'PRODUCT' } }),
      prisma.listing.count({ where: { type: 'SERVICE' } }),
      prisma.user.findMany({ where: { role: 'USER' }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, name: true, phone: true, type: true, verified: true, createdAt: true } }),
      prisma.listing.findMany({ orderBy: { createdAt: 'desc' }, take: 5, include: { user: { select: { name: true } } } }),
    ]);

    const categoryCounts = await prisma.listing.groupBy({ by: ['category'], _count: true, orderBy: { _count: { category: 'desc' } } });

    res.json({
      stats: { totalUsers, totalListings, totalProducts, totalServices },
      categoryCounts: categoryCounts.map((c) => ({ category: c.category, count: c._count })),
      recentUsers,
      recentListings,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── Süni intellekt idarəetməsi — hansı AI harada aktivdir + ayrıca aç/söndür ──
// Bütün AI motorları 'ai' bölməsindəki flag-larla idarə olunur (settings.ts).
// Ayrıca 'ai' icazə moduluna bağlıdır (super-admin və ya icazə verilən admin).
router.get('/admin/ai', requirePermission('ai'), async (_req: AuthRequest, res: Response) => {
  try {
    const flags = (await listFlags()).filter((f) => f.section === 'ai');
    // Env açarlarının mövcudluğu — açar yoxdursa flag aktiv olsa belə işləməz;
    // panel bunu göstərsin ki, "aça bilmirəm" qarışıqlığı olmasın.
    const env = {
      anthropic: !!process.env.ANTHROPIC_API_KEY,   // Claude (köməkçi, vision, KYC, ehtiyat axtarış)
      tavily: !!process.env.TAVILY_API_KEY,          // Tavily (məhsul + şəxs axtarışı)
    };
    res.json({ success: true, flags, env });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.patch('/admin/ai', requirePermission('ai'), async (req: AuthRequest, res: Response) => {
  try {
    const key = String(req.body?.key || '');
    const value = req.body?.value === true || req.body?.value === 'true';
    if (!key) { res.status(400).json({ success: false, message: 'key tələb olunur' }); return; }
    // Yalnız 'ai' bölməsindəki açarlar bu endpointdən dəyişdirilə bilər.
    const flag = (await listFlags()).find((f) => f.key === key);
    if (!flag || flag.section !== 'ai') { res.status(400).json({ success: false, message: 'Bu açar AI bölməsinə aid deyil' }); return; }
    await setFlag(key, value);
    res.json({ success: true, key, value });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Konkret AI-ı canlı SINAQDAN keçir — real nümunə giriş verib nəticəni qaytarır
// (admin AI-ın həqiqətən işlədiyini gözlə görsün). Az miqdar token/kredit xərcləyir.
router.post('/admin/ai/test', requirePermission('ai'), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.body?.id || '');
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const trim = (s: string, n = 400) => (s || '').slice(0, n);

    if (id === 'ai_websearch_tavily' || id === 'ai_websearch_claude' || id === 'ai_person_search') {
      if (!process.env.TAVILY_API_KEY && !process.env.ANTHROPIC_API_KEY) { res.json({ success: true, ok: false, output: 'Açar yoxdur (TAVILY/ANTHROPIC).' }); return; }
      const engine = id === 'ai_person_search' ? 'person' : id === 'ai_websearch_claude' ? 'claude' : 'tavily';
      const q = engine === 'person' ? 'İlham Əliyev' : 'iPhone 15';
      const r = await runWebSearchTest(engine as any, q);
      const lines = (r.results || []).slice(0, 3).map((x) => `• ${trim(x.title, 70)}${x.price ? ` — ${x.price} AZN` : ''}${x.platform ? ` (${x.platform})` : ''} [${x.site}]`);
      res.json({
        success: true, ok: r.ok && (r.results?.length ?? 0) > 0,
        query: q,
        output: r.results?.length ? `${r.results.length} nəticə tapıldı:\n${lines.join('\n')}` : (r.error || 'Nəticə tapılmadı'),
      });
      return;
    }

    if (id === 'ai_assistant' || id === 'ai_assistant_opus') {
      if (!process.env.ANTHROPIC_API_KEY) { res.json({ success: true, ok: false, output: 'ANTHROPIC_API_KEY yoxdur.' }); return; }
      const prompt = id === 'ai_assistant_opus'
        ? 'İki fərqli məhsulu qiymət və keyfiyyət baxımından müqayisə et və hansının daha sərfəli olduğunu izah et (nümunə).'
        : 'Salam! Bir qısa cümlə ilə özünü təqdim et.';
      const { reply } = await runAgent(req.adminId!, token, [{ role: 'user', content: prompt }]);
      res.json({ success: true, ok: !!reply, query: prompt, output: trim(reply || 'Cavab alınmadı', 600) });
      return;
    }

    // Şəkil/sənəd tələb edən AI-lar avtomatik test oluna bilmir.
    if (id === 'ai_vision_search') { res.json({ success: true, manual: true, output: 'Şəkillə axtarışı test etmək üçün saytdakı axtarış çubuğunun kamera düyməsi ilə şəkil yükləyin.' }); return; }
    if (id === 'ai_identity') { res.json({ success: true, manual: true, output: 'Kimlik AI-ı real şəxsiyyət vəsiqəsi + selfi ilə (KYC axını) test olunur.' }); return; }
    if (id === 'ai_business_docs') { res.json({ success: true, manual: true, output: 'Biznes AI-ı real VÖEN/etibarnamə sənədi yüklənərək (biznes təsdiqi) test olunur.' }); return; }
    if (id === 'internet_search') { res.json({ success: true, manual: true, output: 'Bu master açardır — alt motorları (Tavily/Claude) ayrıca test edin.' }); return; }

    res.status(400).json({ success: false, message: 'Bu AI üçün test yoxdur' });
  } catch (error: any) {
    res.json({ success: true, ok: false, output: 'Test xətası: ' + (error?.message || 'naməlum') });
  }
});

// Xarici servislərin canlı sağlamlıq yoxlaması — hansı işləyir, hansı yox
// (Claude kredit vəziyyəti, Tavily, Infobip balans və s.). Canlı sınaq az
// token/kredit xərcləyə bilər — ona görə yalnız bu endpoint çağırılanda işləyir.
router.get('/admin/service-health', requirePermission('ai'), async (_req: AuthRequest, res: Response) => {
  try {
    const services = await checkAllServices();
    res.json({ success: true, services });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Genişləndirilmiş analitika — ən çox satan satıcılar/məhsullar, konversiya, AOV.
router.get('/admin/analytics/advanced', requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const [paidAgg, sellerGroups, totalUsers, buyerGroups, items] = await Promise.all([
      prisma.order.aggregate({ _sum: { total: true }, _count: true, where: { paymentStatus: 'PAID' } }),
      prisma.order.groupBy({ by: ['sellerId'], where: { paymentStatus: 'PAID' }, _sum: { total: true }, _count: true }),
      prisma.user.count({ where: { role: 'USER' } }),
      prisma.order.groupBy({ by: ['buyerId'], where: { paymentStatus: 'PAID' }, _count: true }),
      // Satılan məhsullar (ödənilmiş sifarişlərdən) — məhdud, yaddaşda toplanır.
      prisma.orderItem.findMany({ where: { order: { paymentStatus: 'PAID' } }, select: { listingId: true, title: true, quantity: true, price: true, listing: { select: { category: true } } }, take: 20000 }),
    ]);

    const r2 = (n: number) => Math.round((n || 0) * 100) / 100;
    const paidTotal = paidAgg._sum.total || 0;
    const paidCount = paidAgg._count || 0;

    // Ən çox satan satıcılar (top 10).
    const topSellerIds = sellerGroups.map((g) => g.sellerId);
    const sellerUsers = topSellerIds.length ? await prisma.user.findMany({ where: { id: { in: topSellerIds } }, select: { id: true, name: true } }) : [];
    const sNameById = new Map(sellerUsers.map((u) => [u.id, u.name]));
    const topSellers = sellerGroups
      .map((g) => ({ sellerId: g.sellerId, name: sNameById.get(g.sellerId) || '—', revenue: r2(g._sum.total || 0), orders: g._count }))
      .sort((a, b) => b.revenue - a.revenue).slice(0, 10);

    // Ən çox satan məhsullar (revenue = price*quantity, yaddaşda).
    const prodMap = new Map<number, { listingId: number; title: string; units: number; revenue: number }>();
    const catMap = new Map<string, number>();
    for (const it of items) {
      const cur = prodMap.get(it.listingId) || { listingId: it.listingId, title: it.title, units: 0, revenue: 0 };
      cur.units += it.quantity; cur.revenue += it.price * it.quantity;
      prodMap.set(it.listingId, cur);
      const cat = it.listing?.category || 'Digər';
      catMap.set(cat, (catMap.get(cat) || 0) + it.price * it.quantity);
    }
    const topProducts = Array.from(prodMap.values()).map((p) => ({ ...p, revenue: r2(p.revenue) })).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
    const categorySales = Array.from(catMap.entries()).map(([category, revenue]) => ({ category, revenue: r2(revenue) })).sort((a, b) => b.revenue - a.revenue).slice(0, 8);

    // Konversiya + təkrar alıcı.
    const buyersOrdered = buyerGroups.length;
    const returningBuyers = buyerGroups.filter((g) => g._count > 1).length;

    res.json({
      success: true,
      revenue: r2(paidTotal),
      paidOrders: paidCount,
      avgOrderValue: paidCount ? r2(paidTotal / paidCount) : 0,
      totalUsers,
      buyersOrdered,
      conversionPercent: totalUsers ? Math.round((buyersOrdered / totalUsers) * 1000) / 10 : 0,
      returningBuyers,
      returningPercent: buyersOrdered ? Math.round((returningBuyers / buyersOrdered) * 1000) / 10 : 0,
      topSellers, topProducts, categorySales,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── Toplu əməliyyatlar (bulk) ────────────────────────────────────────────────
router.post('/admin/listings/bulk', requirePermission('listings'), async (req: AuthRequest, res: Response) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map((x: any) => parseInt(String(x))).filter((n: number) => !Number.isNaN(n)).slice(0, 500);
    const action = String(req.body?.action || '');
    if (!ids.length) { res.status(400).json({ success: false, message: 'Elan seçilməyib' }); return; }
    let count = 0;
    if (action === 'approve') count = (await prisma.listing.updateMany({ where: { id: { in: ids } }, data: { status: 'APPROVED' } })).count;
    else if (action === 'reject') count = (await prisma.listing.updateMany({ where: { id: { in: ids } }, data: { status: 'REJECTED' } })).count;
    else if (action === 'delete') count = (await prisma.listing.deleteMany({ where: { id: { in: ids } } })).count;
    else { res.status(400).json({ success: false, message: 'Yanlış əməliyyat' }); return; }
    res.json({ success: true, count });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.post('/admin/users/bulk', requirePermission('users'), async (req: AuthRequest, res: Response) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map((x: any) => parseInt(String(x))).filter((n: number) => !Number.isNaN(n)).slice(0, 500);
    const action = String(req.body?.action || '');
    if (!ids.length) { res.status(400).json({ success: false, message: 'İstifadəçi seçilməyib' }); return; }
    // Özünü və adminləri toplu əməliyyatdan qoru.
    const safeIds = ids.filter((id: number) => id !== req.adminId);
    const admins = await prisma.user.findMany({ where: { id: { in: safeIds }, role: 'ADMIN' }, select: { id: true } });
    const adminSet = new Set(admins.map((a) => a.id));
    const targetIds = safeIds.filter((id: number) => !adminSet.has(id));
    if (!targetIds.length) { res.status(400).json({ success: false, message: 'Uyğun istifadəçi yoxdur (admin/özünüz xaric)' }); return; }
    let count = 0;
    if (action === 'block') count = (await prisma.user.updateMany({ where: { id: { in: targetIds } }, data: { isBlocked: true } })).count;
    else if (action === 'unblock') count = (await prisma.user.updateMany({ where: { id: { in: targetIds } }, data: { isBlocked: false } })).count;
    else if (action === 'delete') count = (await prisma.user.deleteMany({ where: { id: { in: targetIds } } })).count;
    else { res.status(400).json({ success: false, message: 'Yanlış əməliyyat' }); return; }
    res.json({ success: true, count });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Maliyyə — bir sifarişin TAM detalı (kim, kimdən, hansı məhsul, çatdı-çatmadı və s.).
router.get('/admin/finance/:orderId', requirePermission('finance'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.orderId));
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        items: { include: { listing: { select: { id: true, images: true, category: true } } } },
        buyer: { select: { id: true, name: true, phone: true, email: true } },
        seller: { select: { id: true, name: true, phone: true, email: true } },
        courier: { select: { id: true, name: true, phone: true } },
        buyerObject: { select: { id: true, name: true } },
        returnRequests: { include: { orderItem: { select: { title: true } } } },
      },
    });
    if (!order) { res.status(404).json({ success: false, message: 'Sifariş tapılmadı' }); return; }
    // Satıcı hesablaşması (komissiya/net) — varsa.
    const ledger = await prisma.sellerLedger.findUnique({ where: { orderId: id } }).catch(() => null);
    res.json({ success: true, order, ledger });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Maliyyə — sifarişi tamamilə sil (admin təmizliyi). Əlaqəli ledger də silinir.
router.delete('/admin/finance/:orderId', requirePermission('finance'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.orderId));
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true } });
    if (!order) { res.status(404).json({ success: false, message: 'Sifariş tapılmadı' }); return; }
    await prisma.sellerLedger.deleteMany({ where: { orderId: id } }).catch(() => {});
    await prisma.order.delete({ where: { id } });   // OrderItem/returnRequest cascade ilə silinir
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// CSV EXPORT — sifariş/istifadəçi/maliyyə/payout/audit cədvəllərini yüklə
// ══════════════════════════════════════════════════════════════════════════
function toCsv(rows: any[], columns: { key: string; label: string }[]): string {
  const esc = (v: any) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[",\n;]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const header = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(r[c.key])).join(',')).join('\n');
  return '﻿' + header + '\n' + body;   // BOM — Excel Azərbaycan hərflərini düz göstərsin
}
function sendCsv(res: Response, name: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(csv);
}

router.get('/admin/export/orders.csv', requirePermission('orders'), async (_req: AuthRequest, res: Response) => {
  try {
    const orders = await prisma.order.findMany({ orderBy: { createdAt: 'desc' }, take: 5000, include: { buyer: { select: { name: true } }, seller: { select: { name: true } } } });
    const rows = orders.map((o) => ({ id: o.id, buyer: o.buyer?.name, seller: o.seller?.name, total: o.total, status: o.status, paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus, createdAt: o.createdAt.toISOString() }));
    sendCsv(res, 'orders.csv', toCsv(rows, [
      { key: 'id', label: 'Sifariş' }, { key: 'buyer', label: 'Alıcı' }, { key: 'seller', label: 'Satıcı' },
      { key: 'total', label: 'Məbləğ' }, { key: 'status', label: 'Status' }, { key: 'paymentMethod', label: 'Ödəniş üsulu' },
      { key: 'paymentStatus', label: 'Ödəniş statusu' }, { key: 'createdAt', label: 'Tarix' },
    ]));
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.get('/admin/export/users.csv', requirePermission('users'), async (_req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 10000, select: { id: true, name: true, phone: true, email: true, type: true, role: true, isBlocked: true, sellerVerified: true, createdAt: true } });
    const rows = users.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() }));
    sendCsv(res, 'users.csv', toCsv(rows, [
      { key: 'id', label: 'ID' }, { key: 'name', label: 'Ad' }, { key: 'phone', label: 'Telefon' }, { key: 'email', label: 'Email' },
      { key: 'type', label: 'Tip' }, { key: 'role', label: 'Rol' }, { key: 'isBlocked', label: 'Bloklu' }, { key: 'sellerVerified', label: 'Satıcı təsdiqli' }, { key: 'createdAt', label: 'Qeydiyyat' },
    ]));
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.get('/admin/export/payouts.csv', requirePermission('finance_payouts'), async (_req: AuthRequest, res: Response) => {
  try {
    const payouts = await prisma.payout.findMany({ orderBy: { createdAt: 'desc' }, take: 10000 });
    const ids = Array.from(new Set(payouts.map((p) => p.sellerId)));
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const uById = new Map(users.map((u) => [u.id, u.name]));
    const rows = payouts.map((p) => ({ id: p.id, seller: uById.get(p.sellerId) || p.sellerId, amount: p.amount, method: p.method, reference: p.reference, admin: p.createdName, createdAt: p.createdAt.toISOString() }));
    sendCsv(res, 'payouts.csv', toCsv(rows, [
      { key: 'id', label: 'Payout' }, { key: 'seller', label: 'Satıcı' }, { key: 'amount', label: 'Məbləğ' },
      { key: 'method', label: 'Üsul' }, { key: 'reference', label: 'Referans' }, { key: 'admin', label: 'Admin' }, { key: 'createdAt', label: 'Tarix' },
    ]));
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.get('/admin/export/audit.csv', requirePermission('audit'), async (_req: AuthRequest, res: Response) => {
  try {
    const logs = await prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 10000 });
    const rows = logs.map((l) => ({ id: l.id, admin: l.adminName, action: l.action, method: l.method, path: l.path, target: l.targetType ? `${l.targetType}${l.targetId ? '#' + l.targetId : ''}` : '', status: l.status, ip: l.ip, createdAt: l.createdAt.toISOString() }));
    sendCsv(res, 'audit.csv', toCsv(rows, [
      { key: 'id', label: 'ID' }, { key: 'admin', label: 'Admin' }, { key: 'action', label: 'Əməliyyat' }, { key: 'method', label: 'Metod' },
      { key: 'path', label: 'Path' }, { key: 'target', label: 'Hədəf' }, { key: 'status', label: 'Status' }, { key: 'ip', label: 'IP' }, { key: 'createdAt', label: 'Tarix' },
    ]));
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// SATICI ÖDƏNİŞLƏRİ (PAYOUTS) + PLATFORMA KOMİSSİYASI
// ══════════════════════════════════════════════════════════════════════════

// Komissiya faizini oxu/yaz.
router.get('/admin/payouts/commission', requirePermission('finance_payouts'), async (_req: AuthRequest, res: Response) => {
  try { res.json({ success: true, percent: await getCommissionPercent() }); }
  catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});
router.patch('/admin/payouts/commission', requirePermission('finance_payouts'), async (req: AuthRequest, res: Response) => {
  try {
    const percent = parseFloat(String(req.body?.percent));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) { res.status(400).json({ success: false, message: 'Faiz 0-100 aralığında olmalıdır' }); return; }
    res.json({ success: true, percent: await setCommissionPercent(percent) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Satıcıların balans siyahısı (ödəniləcək / gözləyən / ödənilmiş + nağd komissiya borcu).
router.get('/admin/payouts/sellers', requirePermission('finance_payouts'), async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    const ledgers = await prisma.sellerLedger.findMany({ select: { sellerId: true, status: true, netAmount: true, commission: true, heldByPlatform: true } });
    const map = new Map<number, { sellerId: number; available: number; pending: number; paidOut: number; commissionDueCash: number }>();
    for (const l of ledgers) {
      const cur = map.get(l.sellerId) || { sellerId: l.sellerId, available: 0, pending: 0, paidOut: 0, commissionDueCash: 0 };
      if (!l.heldByPlatform) { if (l.status !== 'REVERSED') cur.commissionDueCash += l.commission; }
      else if (l.status === 'AVAILABLE') cur.available += l.netAmount;
      else if (l.status === 'PENDING') cur.pending += l.netAmount;
      else if (l.status === 'PAID_OUT') cur.paidOut += l.netAmount;
      map.set(l.sellerId, cur);
    }
    const ids = Array.from(map.keys());
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true } }) : [];
    const uById = new Map(users.map((u) => [u.id, u]));
    const r2 = (n: number) => Math.round(n * 100) / 100;
    let rows = Array.from(map.values()).map((s) => ({
      ...s, available: r2(s.available), pending: r2(s.pending), paidOut: r2(s.paidOut), commissionDueCash: r2(s.commissionDueCash),
      name: uById.get(s.sellerId)?.name || '—', phone: uById.get(s.sellerId)?.phone || '',
    }));
    if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q.toLowerCase()) || r.phone.includes(q));
    rows.sort((a, b) => b.available - a.available);
    res.json({ success: true, sellers: rows });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Bir satıcının detalı — ledger + payout tarixçəsi.
router.get('/admin/payouts/sellers/:id', requirePermission('finance_payouts'), async (req: AuthRequest, res: Response) => {
  try {
    const sellerId = parseInt(String(req.params.id));
    const [balance, ledgers, payouts, seller] = await Promise.all([
      sellerBalance(sellerId),
      prisma.sellerLedger.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.payout.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.user.findUnique({ where: { id: sellerId }, select: { id: true, name: true, phone: true } }),
    ]);
    res.json({ success: true, seller, balance, ledgers, payouts });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════
// BİZNES ÜZRƏ HESABLAŞMA (satıcıya ödəniləcək pul)
//
// Axın: müştəri kartla ödəyir → pul PLATFORMANIN hesabına gəlir → biz burada
// hansı biznesə nə qədər borclu olduğumuzu görürük → işçimiz BANKDAN həmin
// biznesin IBAN-ına köçürür → burada həmin sətirləri "ödənildi" işarələyir.
// Bu ekran YALNIZ uçotdur; pul köçürməsini özü etmir.
//
// Yeni alışlar avtomatik "ödənilməmiş" kimi yenidən görünür.
// ═══════════════════════════════════════════════════════════════════════════

// Köhnə ledger sətirlərində businessId boşdur — ilk oxunuşda doldururuq.
async function backfillLedgerBusiness(ledgers: { id: number; orderId: number; businessId: number | null }[]) {
  const missing = ledgers.filter((l) => l.businessId === null).slice(0, 200);
  if (!missing.length) return;
  const orders = await prisma.order.findMany({
    where: { id: { in: missing.map((l) => l.orderId) } },
    select: { id: true, items: { select: { listing: { select: { businessId: true } } }, take: 1 } },
  });
  const bizByOrder = new Map(orders.map((o) => [o.id, o.items[0]?.listing?.businessId ?? null]));
  for (const l of missing) {
    const biz = bizByOrder.get(l.orderId) ?? null;
    if (biz === null) continue;
    l.businessId = biz;
    await prisma.sellerLedger.update({ where: { id: l.id }, data: { businessId: biz } }).catch(() => {});
  }
}

// Kart siyahısı — hər biznes üçün ödəniləcək məbləğ və neçə sifariş.
router.get('/admin/payouts/businesses', requirePermission('finance_payouts'), async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const ledgers = await prisma.sellerLedger.findMany({
      where: { heldByPlatform: true, status: { in: ['AVAILABLE', 'PENDING'] } },
      select: { id: true, orderId: true, businessId: true, sellerId: true, status: true, netAmount: true, commission: true, grossAmount: true },
    });
    await backfillLedgerBusiness(ledgers);

    type Row = { businessId: number | null; sellerId: number; unpaid: number; pending: number; commission: number; gross: number; orders: number };
    const map = new Map<string, Row>();
    for (const l of ledgers) {
      const key = l.businessId ? `b${l.businessId}` : `u${l.sellerId}`;
      const cur = map.get(key) || { businessId: l.businessId, sellerId: l.sellerId, unpaid: 0, pending: 0, commission: 0, gross: 0, orders: 0 };
      if (l.status === 'AVAILABLE') { cur.unpaid += l.netAmount; cur.orders++; cur.commission += l.commission; cur.gross += l.grossAmount; }
      else cur.pending += l.netAmount;
      map.set(key, cur);
    }

    const bizIds = Array.from(new Set(Array.from(map.values()).map((r) => r.businessId).filter(Boolean))) as number[];
    const userIds = Array.from(new Set(Array.from(map.values()).filter((r) => !r.businessId).map((r) => r.sellerId)));
    const [bizzes, users] = await Promise.all([
      bizIds.length ? prisma.business.findMany({ where: { id: { in: bizIds } }, select: { id: true, name: true, voen: true, banks: { where: { isActive: true }, select: { iban: true, title: true, isPrimary: true } } } }) : [],
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, phone: true } }) : [],
    ]);
    const bById = new Map(bizzes.map((b) => [b.id, b]));
    const uById = new Map(users.map((u) => [u.id, u]));
    const r2 = (n: number) => Math.round(n * 100) / 100;

    let rows = Array.from(map.values()).map((r) => {
      const b = r.businessId ? bById.get(r.businessId) : null;
      const acc = b?.banks?.find((a: { isPrimary: boolean }) => a.isPrimary) || b?.banks?.[0] || null;
      return {
        key: r.businessId ? `b${r.businessId}` : `u${r.sellerId}`,
        businessId: r.businessId, sellerId: r.sellerId,
        name: b?.name || uById.get(r.sellerId)?.name || '—',
        voen: b?.voen || null,
        isBusiness: !!r.businessId,
        iban: acc?.iban || null, bankTitle: acc?.title || null,
        unpaid: r2(r.unpaid), pending: r2(r.pending),
        commission: r2(r.commission), gross: r2(r.gross), orders: r.orders,
      };
    });
    if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || (r.iban || '').toLowerCase().includes(q));
    rows.sort((a, b) => b.unpaid - a.unpaid);
    const totals = {
      unpaid: r2(rows.reduce((s, r) => s + r.unpaid, 0)),
      pending: r2(rows.reduce((s, r) => s + r.pending, 0)),
      commission: r2(rows.reduce((s, r) => s + r.commission, 0)),
    };
    res.json({ success: true, rows, totals });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Bir biznesin detalı — ÖDƏNİLMƏMİŞ sətirlər məhsul-məhsul açılır.
router.get('/admin/payouts/businesses/:key', requirePermission('finance_payouts'), async (req: AuthRequest, res: Response) => {
  try {
    const key = String(req.params.key);
    const isBiz = key.startsWith('b');
    const id = parseInt(key.slice(1));
    if (Number.isNaN(id)) { res.status(400).json({ success: false, message: 'Yanlış açar' }); return; }

    const where: any = { heldByPlatform: true, status: 'AVAILABLE' };
    if (isBiz) where.businessId = id; else { where.sellerId = id; where.businessId = null; }

    const ledgers = await prisma.sellerLedger.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 });
    const orders = ledgers.length ? await prisma.order.findMany({
      where: { id: { in: ledgers.map((l) => l.orderId) } },
      select: {
        id: true, createdAt: true, total: true, status: true, paymentMethod: true,
        buyer: { select: { id: true, name: true, phone: true } },
        items: { select: { id: true, title: true, quantity: true, price: true } },
      },
    }) : [];
    const oById = new Map(orders.map((o) => [o.id, o]));

    const lines = ledgers.map((l) => {
      const o = oById.get(l.orderId);
      return {
        ledgerId: l.id, orderId: l.orderId, createdAt: o?.createdAt || l.createdAt,
        buyer: o?.buyer ? { id: o.buyer.id, name: o.buyer.name } : null,
        items: o?.items || [],
        gross: l.grossAmount, commission: l.commission, commissionRate: l.commissionRate,
        net: l.netAmount, orderStatus: o?.status || null, paymentMethod: o?.paymentMethod || null,
      };
    });

    const [biz, seller, payouts] = await Promise.all([
      isBiz ? prisma.business.findUnique({ where: { id }, select: { id: true, name: true, voen: true, banks: { where: { isActive: true }, select: { id: true, iban: true, title: true, isPrimary: true } } } }) : null,
      !isBiz ? prisma.user.findUnique({ where: { id }, select: { id: true, name: true, phone: true } }) : null,
      prisma.payout.findMany({ where: isBiz ? { businessId: id } : { sellerId: id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const acc = biz?.banks?.find((a: { isPrimary: boolean }) => a.isPrimary) || biz?.banks?.[0] || null;
    res.json({
      success: true, key, isBusiness: isBiz,
      name: biz?.name || seller?.name || '—', voen: biz?.voen || null,
      iban: acc?.iban || null, bankTitle: acc?.title || null,
      bankAccounts: biz?.banks || [],
      lines, payouts,
      totals: {
        net: r2(lines.reduce((s, l) => s + l.net, 0)),
        gross: r2(lines.reduce((s, l) => s + l.gross, 0)),
        commission: r2(lines.reduce((s, l) => s + l.commission, 0)),
        count: lines.length,
      },
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// SEÇİLMİŞ sətirləri "ödənildi" işarələ. Pul köçürməsi BANKDA edilir —
// bu endpoint yalnız uçotu bağlayır.
router.post('/admin/payouts/businesses/:key/pay', requirePermission('finance_payouts'), async (req: AuthRequest, res: Response) => {
  try {
    const key = String(req.params.key);
    const isBiz = key.startsWith('b');
    const id = parseInt(key.slice(1));
    const rawIds: any[] = Array.isArray(req.body?.ledgerIds) ? req.body.ledgerIds : [];
    const ids = Array.from(new Set(rawIds.map((x) => parseInt(String(x))).filter((n) => n > 0)));
    if (!ids.length) { res.status(400).json({ success: false, message: 'Heç bir sətir seçilməyib' }); return; }

    // Yalnız BU biznesə aid və hələ ödənilməmiş sətirlər — səhv ödənişin qarşısı.
    const where: any = { id: { in: ids }, heldByPlatform: true, status: 'AVAILABLE' };
    if (isBiz) where.businessId = id; else { where.sellerId = id; where.businessId = null; }
    const ledgers = await prisma.sellerLedger.findMany({ where });
    if (!ledgers.length) { res.status(400).json({ success: false, message: 'Seçilmiş sətirlər artıq ödənilib və ya tapılmadı' }); return; }
    if (ledgers.length !== ids.length) {
      console.warn(`[payouts] ${ids.length} seçildi, ${ledgers.length} uyğun gəldi — bəziləri artıq ödənilib`);
    }

    const amount = Math.round(ledgers.reduce((s, l) => s + l.netAmount, 0) * 100) / 100;
    const sellerId = ledgers[0].sellerId;
    let iban: string | null = null;
    if (isBiz) {
      const acc = await prisma.bankAccount.findFirst({ where: { businessId: id, isActive: true }, orderBy: { isPrimary: 'desc' }, select: { iban: true } });
      iban = acc?.iban || null;
    }

    const payout = await prisma.$transaction(async (tx) => {
      const p = await tx.payout.create({
        data: {
          sellerId, businessId: isBiz ? id : null, iban,
          amount,
          method: req.body?.method ? String(req.body.method).slice(0, 40) : 'BANK',
          reference: req.body?.reference ? String(req.body.reference).slice(0, 200) : null,
          createdById: req.adminId!, createdName: req.adminName || 'Admin',
        },
      });
      await tx.sellerLedger.updateMany({ where: { id: { in: ledgers.map((l) => l.id) } }, data: { status: 'PAID_OUT', payoutId: p.id } });
      return p;
    });

    await prisma.notification.create({
      data: { userId: sellerId, type: 'SYSTEM', title: 'Ödəniş edildi 💸', body: `${amount} AZN bank hesabınıza köçürüldü (${ledgers.length} sifariş).`, link: '/earnings' },
    }).catch(() => {});

    res.json({ success: true, payout, paidCount: ledgers.length, amount });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Payout yarat — satıcının mövcud (AVAILABLE) balansını ödə.
router.post('/admin/payouts', requirePermission('finance_payouts'), async (req: AuthRequest, res: Response) => {
  try {
    const sellerId = parseInt(String(req.body?.sellerId));
    if (Number.isNaN(sellerId)) { res.status(400).json({ success: false, message: 'sellerId tələb olunur' }); return; }
    const method = req.body?.method ? String(req.body.method).slice(0, 40) : undefined;
    const reference = req.body?.reference ? String(req.body.reference).slice(0, 200) : undefined;
    const payout = await createPayout(sellerId, req.adminId!, req.adminName || 'Admin', method, reference);
    await prisma.notification.create({
      data: { userId: sellerId, type: 'SYSTEM', title: 'Ödəniş edildi', body: `Hesabınıza ${payout.amount} AZN ödəniş edildi.`, link: '/earnings' },
    }).catch(() => {});
    res.json({ success: true, payout });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Bütün payout tarixçəsi.
router.get('/admin/payouts', requirePermission('finance_payouts'), async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1')) || 1);
    const take = 50;
    const [payouts, total] = await Promise.all([
      prisma.payout.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * take, take }),
      prisma.payout.count(),
    ]);
    const ids = Array.from(new Set(payouts.map((p) => p.sellerId)));
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const uById = new Map(users.map((u) => [u.id, u.name]));
    res.json({ success: true, payouts: payouts.map((p) => ({ ...p, sellerName: uById.get(p.sellerId) || '—' })), total, page, totalPages: Math.ceil(total / take) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Audit jurnalı — admin əməliyyatları tarixçəsi (filtr: admin, action, tarix).
router.get('/admin/audit', requirePermission('audit'), async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1')) || 1);
    const take = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50')) || 50));
    const where: any = {};
    if (req.query.adminId) where.adminId = parseInt(String(req.query.adminId));
    if (req.query.action) where.action = { contains: String(req.query.action) };
    if (req.query.targetType) where.targetType = String(req.query.targetType);
    if (req.query.q) {
      const q = String(req.query.q);
      where.OR = [{ adminName: { contains: q, mode: 'insensitive' } }, { path: { contains: q } }, { action: { contains: q } }];
    }
    const [logs, total] = await Promise.all([
      prisma.adminAuditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * take, take }),
      prisma.adminAuditLog.count({ where }),
    ]);
    // Filtr üçün fərqli əməliyyat növləri + adminlər.
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true, name: true } });
    res.json({ success: true, logs, total, page, totalPages: Math.ceil(total / take), admins });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Cari admin haqqında — frontend sidebar-ı icazələrə görə süzsün deyə.
// isSuperAdmin=true olan hər modula girə bilir; digərləri yalnız permissions-a.
router.get('/admin/me', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const me = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { id: true, name: true, avatar: true, adminPermissions: true } });
    const perms = me?.adminPermissions || [];
    // İcazəsi təyin edilməmiş (boş) admin köhnə/konfiqurasiya olunmamış sayılır —
    // 'admins' (yalnız super-admin) xaric hər modula girişi var (kimsə bloklanmasın).
    const unconfigured = !req.isSuperAdmin && perms.length === 0;
    const effective = req.isSuperAdmin
      ? [...ADMIN_MODULES]
      : unconfigured ? ADMIN_MODULES.filter((m) => m !== 'admins') : perms;
    res.json({
      success: true,
      id: me?.id, name: me?.name, avatar: me?.avatar,
      isSuperAdmin: !!req.isSuperAdmin,
      unconfigured,
      permissions: effective,
      modules: [...ADMIN_MODULES],
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get All Users
router.get('/admin/users', requirePermission('users'), async (req: AuthRequest, res: Response) => {
  try {
    const { search, type, page = '1', limit = '20' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: Prisma.UserWhereInput = { role: 'USER' };
    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { phone: { contains: search as string } },
      ];
    }
    if (type) where.type = type as any;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: { vehicles: true, workplaces: true, _count: { select: { listings: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ users, total, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Create User (admin əl ilə istifadəçi əlavə edir)
router.post('/admin/users', requirePermission('users'), async (req: AuthRequest, res: Response) => {
  try {
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    if (!name || !phone) { res.status(400).json({ success: false, message: 'Ad və telefon tələb olunur' }); return; }
    const validTypes = ['CAR_OWNER', 'MECHANIC', 'PARTS_SELLER', 'COURIER'];
    const type = validTypes.includes(req.body.type) ? req.body.type : 'CAR_OWNER';
    const exists = await prisma.user.findFirst({ where: { phone } });
    if (exists) { res.status(400).json({ success: false, message: 'Bu telefon artıq qeydiyyatdadır' }); return; }
    const data: any = {
      name, phone, type: type as UserType,
      role: req.body.role === 'ADMIN' ? 'ADMIN' : 'USER',
      verified: req.body.verified === true || req.body.verified === 'true',
      profileComplete: true,
    };
    if (req.body.email) data.email = String(req.body.email).trim();
    if (req.body.password) data.password = await bcrypt.hash(String(req.body.password), 10);
    const user = await prisma.user.create({
      data,
      select: { id: true, name: true, phone: true, email: true, type: true, role: true, verified: true, isBlocked: true, createdAt: true },
    });
    res.status(201).json({ success: true, user });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Update User
router.put('/admin/users/:id', requirePermission('users'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, phone, type, verified, role } = req.body;

    const targetId = parseInt(req.params.id);
    // Admin başqa istifadəçiyə admin rolu VERƏ bilər (owner istəyi).
    // Yalnız öz admin rolunu düşürməsinin qarşısı alınır (özünü kilidləməsin).
    if (targetId === req.adminId && role && role !== 'ADMIN') {
      res.status(403).json({ success: false, message: 'Öz admin rolunuzu dəyişə bilməzsiniz' });
      return;
    }

    try {
      const user = await prisma.user.update({
        where: { id: targetId },
        data: {
          ...(name !== undefined && { name }),
          ...(phone !== undefined && { phone }),
          ...(type !== undefined && { type }),
          ...(verified !== undefined && { verified }),
          ...(role !== undefined && { role }),
        },
      });
      res.json({ success: true, user });
    } catch (err: any) {
      // H11 fix: catch unique-violation on phone
      if (err?.code === 'P2002') {
        res.status(400).json({ success: false, message: 'Bu telefon nömrəsi artıq başqa istifadəçi tərəfindən istifadə olunur' });
        return;
      }
      throw err;
    }
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Delete User
router.delete('/admin/users/:id', requirePermission('users'), async (req: AuthRequest, res: Response) => {
  try {
    const targetId = parseInt(req.params.id);
    if (Number.isNaN(targetId)) {
      res.status(400).json({ success: false, message: 'Yanlış ID' }); return;
    }
    // C13 fix: prevent admin self-deletion (would lock them out & cascade-delete their data)
    if (targetId === req.adminId) {
      res.status(403).json({ success: false, message: 'Öz hesabınızı silə bilməzsiniz' });
      return;
    }
    // Açıq (explicit) cascade — DB-dəki FK onDelete "NO ACTION" qalmışsa belə
    // (köhnə db push) silmə işləsin deyə bütün asılı qeydləri sıra ilə silirik.
    const U = targetId;
    await prisma.$transaction(async (tx) => {
      // SetNull tərəflər: bu istifadəçi kuryer/referrer olan sifarişlərdə əlaqəni sıfırla
      await tx.order.updateMany({ where: { courierId: U }, data: { courierId: null } });
      await tx.order.updateMany({ where: { referrerId: U }, data: { referrerId: null } });
      // 1) Başqa entity-lərə istinad edən uşaq cədvəllər (əvvəl silinir)
      await tx.messageReaction.deleteMany({ where: { userId: U } });
      await tx.returnRequest.deleteMany({ where: { OR: [{ buyerId: U }, { sellerId: U }] } });
      await tx.inquiryOffer.deleteMany({ where: { sellerId: U } });
      await tx.inquiryTarget.deleteMany({ where: { sellerId: U } });
      await tx.sellerRating.deleteMany({ where: { OR: [{ sellerId: U }, { buyerId: U }] } });
      await tx.comment.deleteMany({ where: { userId: U } });
      await tx.conversationMember.deleteMany({ where: { userId: U } });
      await tx.referralCart.deleteMany({ where: { referrerId: U } });
      await tx.consultationOffer.deleteMany({ where: { userId: U } });
      // 2) Orta səviyyə entity-lər
      await tx.consultationSession.deleteMany({ where: { OR: [{ buyerId: U }, { professionalId: U }] } });
      await tx.order.deleteMany({ where: { OR: [{ buyerId: U }, { sellerId: U }] } });
      await tx.inquiry.deleteMany({ where: { buyerId: U } });
      await tx.message.deleteMany({ where: { OR: [{ senderId: U }, { receiverId: U }] } });
      await tx.cart.deleteMany({ where: { userId: U } });
      await tx.sharedCart.deleteMany({ where: { userId: U } });
      await tx.booking.deleteMany({ where: { OR: [{ guestId: U }, { hostId: U }] } });
      await tx.complaint.deleteMany({ where: { OR: [{ complainantId: U }, { targetUserId: U }] } });
      await tx.listing.deleteMany({ where: { userId: U } });   // OrderItem/Favorite/Comment cascade
      await tx.business.deleteMany({ where: { userId: U } });   // BusinessObject/bank/member cascade
      // 3) Sadə uşaq cədvəllər
      await tx.vehicle.deleteMany({ where: { userId: U } });
      await tx.workplace.deleteMany({ where: { userId: U } });
      await tx.verificationCode.deleteMany({ where: { userId: U } });
      await tx.phoneNumber.deleteMany({ where: { userId: U } });
      await tx.emailVerification.deleteMany({ where: { userId: U } });
      await tx.socialLink.deleteMany({ where: { userId: U } });
      await tx.professionDocument.deleteMany({ where: { userId: U } });
      await tx.favorite.deleteMany({ where: { userId: U } });
      await tx.savedAddress.deleteMany({ where: { userId: U } });
      await tx.sellerVerification.deleteMany({ where: { userId: U } });
      await tx.notification.deleteMany({ where: { userId: U } });
      await tx.businessMember.deleteMany({ where: { userId: U } });
      await tx.contact.deleteMany({ where: { ownerId: U } });
      await tx.session.deleteMany({ where: { userId: U } });
      // 4) Nəhayət istifadəçinin özü
      await tx.user.delete({ where: { id: U } });
    }, { timeout: 20000 });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get All Listings
router.get('/admin/listings', requirePermission('listings'), async (req: AuthRequest, res: Response) => {
  try {
    const { search, category, type, status, page = '1', limit = '20' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: Prisma.ListingWhereInput = {};
    // ?status=PENDING — moderasiya növbəsi
    if (status && status !== 'all') where.status = status as any;
    // ?ownerType=object|user&ownerId=N — konkret sahibin elanları
    const ownerType = String(req.query.ownerType || '');
    const ownerId = parseInt(String(req.query.ownerId || ''));
    if (ownerType === 'object' && !Number.isNaN(ownerId)) where.businessObjectId = ownerId;
    else if (ownerType === 'user' && !Number.isNaN(ownerId)) { where.userId = ownerId; where.businessObjectId = null; }
    if (search) {
      where.OR = [
        { title: { contains: search as string, mode: 'insensitive' } },
        { description: { contains: search as string, mode: 'insensitive' } },
      ];
    }
    if (category) where.category = category as string;
    if (type && type !== 'all') where.type = type as any;

    const [listings, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        include: { user: { select: { id: true, name: true, phone: true, type: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.listing.count({ where }),
    ]);
    const pendingCount = await prisma.listing.count({ where: { status: 'PENDING' } });

    res.json({ listings, total, pendingCount, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// GET /admin/listing-owners — elanları SAHİBİNƏ görə qruplaşdırır.
// VÖEN-li elan biznes obyektinə, digərləri şəxsə aid sayılır.
// Cavab: hər sahib üçün ad, VÖEN/şirkət və elan sayları (ümumi/gözləmədə/...).
router.get('/admin/listing-owners', requirePermission('listings'), async (req: AuthRequest, res: Response) => {
  try {
    const { status, search } = req.query;
    const base: Prisma.ListingWhereInput = {};
    if (status && status !== 'all') base.status = status as any;

    const [objRows, userRows] = await Promise.all([
      prisma.listing.groupBy({
        by: ['businessObjectId', 'status'],
        where: { ...base, businessObjectId: { not: null } },
        _count: { _all: true },
      }),
      prisma.listing.groupBy({
        by: ['userId', 'status'],
        where: { ...base, businessObjectId: null },
        _count: { _all: true },
      }),
    ]);

    type Owner = {
      key: string; kind: 'OBJECT' | 'USER'; id: number;
      name: string; subtitle: string | null; voen: string | null;
      total: number; pending: number; approved: number; rejected: number;
    };
    const owners = new Map<string, Owner>();
    const bump = (o: Owner, st: string, n: number) => {
      o.total += n;
      if (st === 'PENDING') o.pending += n;
      else if (st === 'APPROVED') o.approved += n;
      else if (st === 'REJECTED') o.rejected += n;
    };

    const objIds = [...new Set(objRows.map((r) => r.businessObjectId!).filter((x) => x != null))];
    const userIds = [...new Set(userRows.map((r) => r.userId))];
    const [objects, users] = await Promise.all([
      objIds.length
        ? prisma.businessObject.findMany({
            where: { id: { in: objIds } },
            select: { id: true, name: true, city: true, business: { select: { name: true, voen: true } } },
          })
        : Promise.resolve([]),
      userIds.length
        ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, phone: true, type: true } })
        : Promise.resolve([]),
    ]);
    const objById = new Map(objects.map((o) => [o.id, o]));
    const userById = new Map(users.map((u) => [u.id, u]));

    for (const r of objRows) {
      const o = objById.get(r.businessObjectId!);
      if (!o) continue;
      const key = `OBJECT:${o.id}`;
      if (!owners.has(key)) {
        owners.set(key, {
          key, kind: 'OBJECT', id: o.id,
          name: `${o.name} (Obyekt №${o.id})`,
          subtitle: [o.business?.name, o.city].filter(Boolean).join(' · ') || null,
          voen: o.business?.voen || null,
          total: 0, pending: 0, approved: 0, rejected: 0,
        });
      }
      bump(owners.get(key)!, r.status, r._count._all);
    }
    for (const r of userRows) {
      const u = userById.get(r.userId);
      if (!u) continue;
      const key = `USER:${u.id}`;
      if (!owners.has(key)) {
        owners.set(key, {
          key, kind: 'USER', id: u.id,
          name: u.name || `İstifadəçi №${u.id}`,
          subtitle: u.phone || null,
          voen: null,
          total: 0, pending: 0, approved: 0, rejected: 0,
        });
      }
      bump(owners.get(key)!, r.status, r._count._all);
    }

    let list = [...owners.values()];
    if (search) {
      const q = String(search).toLowerCase();
      list = list.filter((o) =>
        o.name.toLowerCase().includes(q) ||
        (o.subtitle || '').toLowerCase().includes(q) ||
        (o.voen || '').includes(q));
    }
    // Gözləyəni çox olan sahib yuxarıda — moderasiya növbəsi üçün rahat.
    list.sort((a, b) => b.pending - a.pending || b.total - a.total || a.name.localeCompare(b.name));

    res.json({ success: true, owners: list });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Elan moderasiyası — təsdiqlə / rədd et.
// body: { status: 'APPROVED' | 'REJECTED' | 'PENDING', rejectReason?: string }
router.patch('/admin/listings/:id/status', requirePermission('listings'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const status = String(req.body?.status || '').toUpperCase();
    if (!['APPROVED', 'REJECTED', 'PENDING'].includes(status)) {
      res.status(400).json({ success: false, message: 'status yalnız APPROVED, REJECTED və ya PENDING ola bilər' });
      return;
    }
    const listing = await prisma.listing.update({
      where: { id },
      data: {
        status: status as any,
        rejectReason: status === 'REJECTED' ? (String(req.body?.rejectReason || '').trim() || null) : null,
        reviewedAt: status === 'PENDING' ? null : new Date(),
      },
      select: { id: true, title: true, status: true, rejectReason: true, userId: true },
    });
    res.json({ success: true, listing });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Update Listing
router.put('/admin/listings/:id', requirePermission('listings'), async (req: AuthRequest, res: Response) => {
  try {
    const { title, description, price, category, type } = req.body;
    const listing = await prisma.listing.update({
      where: { id: parseInt(req.params.id) },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(price !== undefined && { price: parseFloat(price) }),
        ...(category !== undefined && { category }),
        ...(type !== undefined && { type }),
      },
    });
    res.json({ success: true, listing });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Delete Listing
router.delete('/admin/listings/:id', requirePermission('listings'), async (req: AuthRequest, res: Response) => {
  try {
    const listing = await prisma.listing.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!listing) { res.status(404).json({ success: false, message: 'Elan tapılmadı' }); return; }

    // Resimleri diskten sil
    if (listing.images && listing.images.length > 0) {
      for (const img of listing.images) {
        const filePath = path.join(__dirname, '../../uploads', img);
        fs.unlink(filePath, () => {});
      }
    }

    await prisma.listing.delete({ where: { id: listing.id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Bulk reactivate — bütün vaxtı bitmiş (və ya expiresAt = null) elanların
// müddətini indidən 30 gün uzadır. Bir dəfəlik admin əməliyyatı: marketplace-də
// köhnə elanlar yenidən görünsün.
router.post('/admin/listings/reactivate-expired', requirePermission('listings'), async (_req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const result = await prisma.listing.updateMany({
      where: {
        OR: [
          { expiresAt: null },
          { expiresAt: { lte: now } },
        ],
      },
      data: { expiresAt: newExpiresAt },
    });

    res.json({
      success: true,
      updatedCount: result.count,
      newExpiresAt,
      message: `${result.count} elan 30 gün üçün yeniləndi.`,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== COURIER MANAGEMENT =====================

// Create Courier
router.post('/admin/couriers', requirePermission('couriers'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, phone, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const courier = await prisma.user.create({
      data: { name, phone, password: hashedPassword, type: UserType.COURIER, role: 'USER', verified: true },
    });
    res.status(201).json({ success: true, courier: { id: courier.id, name: courier.name, phone: courier.phone } });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get All Couriers
router.get('/admin/couriers', requirePermission('couriers'), async (_req: AuthRequest, res: Response) => {
  try {
    const couriers = await prisma.user.findMany({
      where: { type: 'COURIER' },
      select: { id: true, name: true, phone: true, createdAt: true, _count: { select: { courierOrders: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ couriers });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Update Courier
router.put('/admin/couriers/:id', requirePermission('couriers'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, phone, password } = req.body;
    const data: any = {};
    if (name !== undefined) data.name = name;
    if (phone !== undefined) data.phone = phone;
    if (password) data.password = await bcrypt.hash(password, 10);
    const courier = await prisma.user.update({
      where: { id: parseInt(req.params.id) },
      data,
      select: { id: true, name: true, phone: true },
    });
    res.json({ success: true, courier });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Delete Courier
router.delete('/admin/couriers/:id', requirePermission('couriers'), async (req: AuthRequest, res: Response) => {
  try {
    await prisma.user.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== ORDER MANAGEMENT =====================

// Get All Orders (admin)
router.get('/admin/orders', requirePermission('orders'), async (req: AuthRequest, res: Response) => {
  try {
    const { status, page = '1', limit = '20' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: Prisma.OrderWhereInput = {};
    if (status && status !== 'all') where.status = status as any;

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          items: true,
          buyer: { select: { id: true, name: true, phone: true } },
          seller: { select: { id: true, name: true, phone: true } },
          courier: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.order.count({ where }),
    ]);

    res.json({ orders, total, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── Maliyyə / Ödənişlər hesabatı ──
// Kim kimdən aldı, nə qədər ödədi, platformaya (bizə) nə qədər pul gəldi.
// "Bizə gələn pul" = KART ödənişləri (PAID) — YIĞIM/Kapital merchant hesabımıza
// düşür. NAĞD ödənişlər alıcı→satıcı birbaşa gedir (bizə gəlmir).
router.get('/admin/finance', requirePermission('finance'), async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page || '1')) || 1;
    const take = Math.min(parseInt(String(req.query.limit || '25')) || 25, 100);
    const skip = (page - 1) * take;
    const method = String(req.query.method || 'all');       // all | CARD | CASH | WALLET
    const payStatus = String(req.query.paymentStatus || 'all'); // all | PAID | PENDING | FAILED | REFUNDED
    const q = String(req.query.q || '').trim();
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;

    // Ortaq filtr (tarix + axtarış) — özet kartları bunun üzərindən hesablanır.
    const baseWhere: Prisma.OrderWhereInput = {};
    if (from || to) baseWhere.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    if (q) baseWhere.OR = [
      { buyer: { name: { contains: q, mode: 'insensitive' } } },
      { buyer: { phone: { contains: q } } },
      { seller: { name: { contains: q, mode: 'insensitive' } } },
      { seller: { phone: { contains: q } } },
    ];

    // Cədvəl filtri (üstünə metod + ödəniş statusu).
    const tableWhere: Prisma.OrderWhereInput = { ...baseWhere };
    if (method !== 'all') tableWhere.paymentMethod = method as any;
    if (payStatus !== 'all') tableWhere.paymentStatus = payStatus as any;

    const [rows, total, cardPaid, cashPaid, refunded, allPaid, referralAgg] = await Promise.all([
      prisma.order.findMany({
        where: tableWhere,
        include: {
          items: { select: { title: true, quantity: true, price: true } },
          buyer: { select: { id: true, name: true, phone: true } },
          seller: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip, take,
      }),
      prisma.order.count({ where: tableWhere }),
      // Bizə gələn pul: KART + PAID
      prisma.order.aggregate({ _sum: { total: true }, _count: true, where: { ...baseWhere, paymentMethod: 'CARD', paymentStatus: 'PAID' } }),
      // Nağd (elden): CASH + PAID — bizə gəlmir, satıcıya birbaşa
      prisma.order.aggregate({ _sum: { total: true }, _count: true, where: { ...baseWhere, paymentMethod: 'CASH', paymentStatus: 'PAID' } }),
      // İadə edilmiş
      prisma.order.aggregate({ _sum: { total: true }, _count: true, where: { ...baseWhere, paymentStatus: 'REFUNDED' } }),
      // Bütün ödənilmiş (kart+nağd)
      prisma.order.aggregate({ _sum: { total: true }, _count: true, where: { ...baseWhere, paymentStatus: 'PAID' } }),
      // Referala ödəniləcək komissiya (voided olmayan)
      prisma.order.aggregate({ _sum: { referralAmount: true }, where: { ...baseWhere, paymentStatus: 'PAID', referralVoided: false } }),
    ]);

    res.json({
      success: true,
      summary: {
        cardPaidTotal: cardPaid._sum.total || 0,   // bizə gələn pul (kart)
        cardPaidCount: cardPaid._count || 0,
        cashPaidTotal: cashPaid._sum.total || 0,    // elden (satıcıya birbaşa)
        cashPaidCount: cashPaid._count || 0,
        refundedTotal: refunded._sum.total || 0,
        refundedCount: refunded._count || 0,
        allPaidTotal: allPaid._sum.total || 0,      // ümumi dövriyyə
        allPaidCount: allPaid._count || 0,
        referralPayable: referralAgg._sum.referralAmount || 0, // referrerlara ödəniləcək
      },
      transactions: rows,
      total, page, totalPages: Math.ceil(total / take) || 1,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Assign Courier to Order
router.put('/admin/orders/:id/assign-courier', requirePermission('orders'), async (req: AuthRequest, res: Response) => {
  try {
    const orderId = parseInt(req.params.id);
    if (Number.isNaN(orderId)) {
      res.status(400).json({ success: false, message: 'Yanlış sifariş ID' }); return;
    }
    const { courierId } = req.body;
    const cid = courierId ? parseInt(courierId) : null;
    // C10 fix: when assigning, verify the user is actually a COURIER —
    // otherwise admin could mistakenly assign any user to deliver.
    if (cid !== null) {
      const courier = await prisma.user.findUnique({
        where: { id: cid },
        select: { id: true, type: true },
      });
      if (!courier || courier.type !== 'COURIER') {
        res.status(400).json({ success: false, message: 'Seçilmiş istifadəçi kuryer deyil' });
        return;
      }
    }
    const order = await prisma.order.update({
      where: { id: orderId },
      data: { courierId: cid },
      include: { courier: { select: { id: true, name: true, phone: true } } },
    });
    res.json({ success: true, order });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== RETURN MANAGEMENT =====================

// Get All Returns
router.get('/admin/returns', requirePermission('returns'), async (req: AuthRequest, res: Response) => {
  try {
    const { status, page = '1', limit = '20' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: Prisma.ReturnRequestWhereInput = {};
    if (status && status !== 'all') where.status = status as any;

    const [returns, total] = await Promise.all([
      prisma.returnRequest.findMany({
        where,
        include: {
          order: { include: { items: true } },
          orderItem: true,
          buyer: { select: { id: true, name: true, phone: true } },
          seller: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.returnRequest.count({ where }),
    ]);

    res.json({ returns, total, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Admin override return status
router.put('/admin/returns/:id/override', requirePermission('returns'), async (req: AuthRequest, res: Response) => {
  try {
    const { status, adminNote, refundAmount } = req.body;
    if (!['APPROVED', 'REJECTED', 'REFUNDED'].includes(status)) {
      res.status(400).json({ success: false, message: 'Yalnız APPROVED, REJECTED və ya REFUNDED statusu təyin edə bilərsiniz' }); return;
    }

    const ret = await prisma.returnRequest.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { orderItem: true, order: { include: { items: true } } },
    });
    if (!ret) { res.status(404).json({ success: false, message: 'İadə sorğusu tapılmadı' }); return; }

    // If forcing refund, restore stock
    if (status === 'REFUNDED') {
      if (ret.orderItem) {
        try {
          await prisma.listing.update({
            where: { id: ret.orderItem.listingId },
            data: { stock: { increment: ret.quantity } },
          });
        } catch { /* listing may be deleted */ }
      } else {
        for (const item of ret.order.items) {
          try {
            await prisma.listing.update({
              where: { id: item.listingId },
              data: { stock: { increment: item.quantity } },
            });
          } catch { /* listing may be deleted */ }
        }
      }

      // Kart ödənişidirsə — pulu Kapital Bank vasitəsilə həqiqətən geri qaytar.
      const order = ret.order;
      if (order.gatewayOrderId && order.gatewayPassword && order.paymentStatus === 'PAID') {
        const amt = refundAmount !== undefined ? parseFloat(refundAmount) : (ret.refundAmount ?? order.total);
        try {
          await kapitalRefund(order.gatewayOrderId, order.gatewayPassword, amt);
          await prisma.order.update({
            where: { id: order.id },
            data: { paymentStatus: 'REFUNDED', gatewayStatus: 'Refunded' },
          });
        } catch (err: any) {
          res.status(502).json({ success: false, message: 'Bank iadəsi alınmadı: ' + err.message }); return;
        }
      }
    }

    const updated = await prisma.returnRequest.update({
      where: { id: ret.id },
      data: {
        status,
        adminNote: adminNote || null,
        ...(refundAmount !== undefined && { refundAmount: parseFloat(refundAmount) }),
      },
    });
    res.json({ success: true, returnRequest: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== ORDER STATUS (admin override) =====================

const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;

// Admin sifariş statusunu dəyişir. CANCELLED olduqda stok geri qaytarılır.
router.put('/admin/orders/:id/status', requirePermission('orders'), async (req: AuthRequest, res: Response) => {
  try {
    const orderId = parseInt(req.params.id);
    if (Number.isNaN(orderId)) { res.status(400).json({ success: false, message: 'Yanlış sifariş ID' }); return; }
    const { status } = req.body;
    if (!ORDER_STATUSES.includes(status)) {
      res.status(400).json({ success: false, message: 'Yanlış status' }); return;
    }
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) { res.status(404).json({ success: false, message: 'Sifariş tapılmadı' }); return; }

    // Ləğv olunduqda və əvvəl ləğv olunmayıbsa — stoku geri qaytar.
    if (status === 'CANCELLED' && order.status !== 'CANCELLED') {
      for (const item of order.items) {
        try {
          await prisma.listing.update({ where: { id: item.listingId }, data: { stock: { increment: item.quantity } } });
        } catch { /* listing silinmiş ola bilər */ }
      }
    }
    const updated = await prisma.order.update({ where: { id: orderId }, data: { status } });
    await recordSettlement(orderId).catch(() => {});   // satıcı ledger yenilə
    // Alıcıya bildiriş
    try {
      await prisma.notification.create({
        data: { userId: order.buyerId, type: 'ORDER', title: 'Sifariş statusu yeniləndi', body: `Sifariş #${order.id}: ${status}`, link: `/orders/${order.id}` },
      });
    } catch { /* ignore */ }
    res.json({ success: true, order: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== USER BLOCK / UNBLOCK =====================

router.put('/admin/users/:id/block', requirePermission('users'), async (req: AuthRequest, res: Response) => {
  try {
    const targetId = parseInt(req.params.id);
    if (Number.isNaN(targetId)) { res.status(400).json({ success: false, message: 'Yanlış ID' }); return; }
    if (targetId === req.adminId) { res.status(403).json({ success: false, message: 'Öz hesabınızı bloklaya bilməzsiniz' }); return; }
    const { blocked } = req.body;
    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { role: true } });
    if (!target) { res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' }); return; }
    if (target.role === 'ADMIN') { res.status(403).json({ success: false, message: 'Admini bloklamaq olmaz' }); return; }
    const user = await prisma.user.update({
      where: { id: targetId },
      data: { isBlocked: blocked === true },
      select: { id: true, name: true, isBlocked: true },
    });
    res.json({ success: true, user });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== COMMENT / RATING MODERATION =====================

router.get('/admin/comments', requirePermission('comments'), async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', limit = '20' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);
    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        include: {
          user: { select: { id: true, name: true, phone: true } },
          listing: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip, take,
      }),
      prisma.comment.count(),
    ]);
    res.json({ comments, total, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/admin/comments/:id', requirePermission('comments'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ success: false, message: 'Yanlış ID' }); return; }
    await prisma.comment.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== BROADCAST NOTIFICATIONS =====================

// Bütün (və ya tipə görə) istifadəçilərə bildiriş göndər.
router.post('/admin/broadcast', requirePermission('broadcast'), async (req: AuthRequest, res: Response) => {
  try {
    const { title, body, link, userType } = req.body;
    if (!title || !body) { res.status(400).json({ success: false, message: 'Başlıq və mətn tələb olunur' }); return; }
    const where: Prisma.UserWhereInput = { role: 'USER', isBlocked: false };
    if (userType && ['CAR_OWNER', 'MECHANIC', 'PARTS_SELLER', 'COURIER'].includes(userType)) {
      where.type = userType as UserType;
    }
    const users = await prisma.user.findMany({ where, select: { id: true } });
    if (users.length === 0) { res.json({ success: true, count: 0 }); return; }
    const result = await prisma.notification.createMany({
      data: users.map((u) => ({
        userId: u.id, type: 'SYSTEM', title: String(title), body: String(body), link: link ? String(link) : null,
      })),
    });
    res.json({ success: true, count: result.count });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ===================== ANALYTICS =====================

router.get('/admin/analytics', requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const last30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [ordersByStatus, paidAgg, deliveredCount, last30Orders, newUsers30, blockedUsers, pendingKyc, openReturns] = await Promise.all([
      prisma.order.groupBy({ by: ['status'], _count: true }),
      prisma.order.aggregate({ _sum: { total: true }, where: { paymentStatus: 'PAID' } }),
      prisma.order.count({ where: { status: 'DELIVERED' } }),
      prisma.order.findMany({ where: { createdAt: { gte: last30 } }, select: { total: true, createdAt: true, status: true } }),
      prisma.user.count({ where: { role: 'USER', createdAt: { gte: last30 } } }),
      prisma.user.count({ where: { isBlocked: true } }),
      prisma.sellerVerification.count({ where: { status: 'PENDING' } }),
      prisma.returnRequest.count({ where: { status: { in: ['REQUESTED', 'APPROVED', 'RETURN_SHIPPED', 'RETURN_RECEIVED'] } } }),
    ]);

    // Son 30 gün — günlük gəlir/sifariş
    const dailyMap = new Map<string, { revenue: number; orders: number }>();
    for (const o of last30Orders) {
      const day = o.createdAt.toISOString().slice(0, 10);
      const cur = dailyMap.get(day) || { revenue: 0, orders: 0 };
      cur.orders += 1;
      if (o.status !== 'CANCELLED') cur.revenue += o.total;
      dailyMap.set(day, cur);
    }
    const daily = Array.from(dailyMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v }));

    res.json({
      revenueTotal: paidAgg._sum.total || 0,
      deliveredCount,
      ordersByStatus: ordersByStatus.map((s) => ({ status: s.status, count: s._count })),
      newUsers30,
      blockedUsers,
      pendingKyc,
      openReturns,
      daily,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==================== KİMLİK YOXLAMASI (LƏĞV EDİLDİ) ====================
// Kimlik doğrulaması artıq Veriff ilə avtomatik aparılır — admin paneldə əl ilə
// təsdiq/rədd endpoint-lərinə ehtiyac yoxdur, ona görə silindi.

// ==================== PEŞƏ SƏNƏDLƏRİ (AI ad-soyad yoxlaması) ====================
router.get('/admin/credentials', requirePermission('credentials'), async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const where: Prisma.ProfessionDocumentWhereInput = status === 'ALL' ? {} : { status: status as any };
    const documents = await prisma.professionDocument.findMany({
      where, orderBy: { id: 'desc' }, take: 200,
      select: {
        id: true, title: true, image: true, documentType: true, issuer: true, holderName: true,
        nameMatch: true, nameMatchScore: true, professionMatch: true, confidence: true,
        fraudSignals: true, aiReason: true, status: true, createdAt: true,
        user: { select: { id: true, name: true, phone: true, profession: true } },
      },
    });
    res.json({ success: true, documents });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/admin/credentials/:id/:action', requirePermission('credentials'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const action = String(req.params.action);
    if (!['approve', 'reject'].includes(action)) { res.status(400).json({ success: false, message: 'Yanlış əməliyyat' }); return; }
    const doc = await prisma.professionDocument.update({
      where: { id },
      data: { status: action === 'approve' ? 'APPROVED' : 'REJECTED' },
      select: { id: true, status: true, userId: true, title: true },
    });
    await prisma.notification.create({
      data: {
        userId: doc.userId,
        type: 'SYSTEM',
        title: 'Peşə sənədi',
        body: action === 'approve' ? `"${doc.title}" sənədiniz təsdiqləndi ✓` : `"${doc.title}" sənədiniz rədd edildi.`,
        link: '/profile',
      },
    }).catch(() => {});
    res.json({ success: true, document: doc });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==================== SOSIAL MEDIA TƏSDİQİ ====================
router.get('/admin/social-links', requirePermission('social'), async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const where: Prisma.SocialLinkWhereInput = status === 'VERIFIED' ? { verified: true } : status === 'ALL' ? {} : { verified: false };
    const links = await prisma.socialLink.findMany({
      where, orderBy: { id: 'desc' }, take: 200,
      include: { user: { select: { id: true, name: true, phone: true } } },
    });
    res.json({ success: true, links });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/admin/social-links/:id/:action', requirePermission('social'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const action = String(req.params.action);
    if (!['verify', 'reject'].includes(action)) { res.status(400).json({ success: false, message: 'Yanlış əməliyyat' }); return; }
    const link = await prisma.socialLink.update({ where: { id }, data: { verified: action === 'verify' } });
    res.json({ success: true, link });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ───────── İrəli səviyyə admin: ümumi baxış (badge sayları + canlı statistika) ─────────
router.get('/admin/overview', requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [
      users, blockedUsers, listings, orders, businesses, couriers,
      pBusinesses, pSellerApps, pCredentials, pSocial, pComplaints, pReturns, pListings,
      revenueAgg, revenueTodayAgg, ordersToday, newUsers7d, activeConsult,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'USER', type: { not: 'COURIER' } } }),
      prisma.user.count({ where: { role: 'USER', isBlocked: true } }),
      prisma.listing.count(),
      prisma.order.count(),
      prisma.business.count(),
      prisma.user.count({ where: { type: 'COURIER' } }),
      prisma.business.count({ where: { status: 'PENDING' } }),
      prisma.sellerVerification.count({ where: { status: 'PENDING' } }),
      prisma.professionDocument.count({ where: { status: 'PENDING' } }),
      prisma.socialLink.count({ where: { verified: false } }),
      prisma.complaint.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
      prisma.returnRequest.count({ where: { status: 'REQUESTED' } }),
      prisma.listing.count({ where: { status: 'PENDING' } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { paymentStatus: 'PAID' } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { paymentStatus: 'PAID', createdAt: { gte: startOfDay } } }),
      prisma.order.count({ where: { createdAt: { gte: startOfDay } } }),
      prisma.user.count({ where: { role: 'USER', createdAt: { gte: weekAgo } } }),
      prisma.consultationSession.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
    ]);
    const pending = {
      businesses: pBusinesses, sellerApps: pSellerApps,
      credentials: pCredentials, socialLinks: pSocial, complaints: pComplaints, returns: pReturns,
      listings: pListings,
    };
    const pendingTotal = Object.values(pending).reduce((a, b) => a + b, 0);
    res.json({
      success: true,
      stats: {
        users, blockedUsers, listings, orders, businesses, couriers,
        revenueTotal: revenueAgg._sum.total || 0,
        revenueToday: revenueTodayAgg._sum.total || 0,
        ordersToday, newUsers7d, activeConsult,
      },
      pending,
      pendingTotal,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ───────── İrəli səviyyə admin: qlobal axtarış (istifadəçi/elan/biznes/sifariş) ─────────
router.get('/admin/search', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) { res.json({ success: true, results: { users: [], listings: [], businesses: [], orders: [] } }); return; }
    const idNum = parseInt(q);
    const hasId = Number.isFinite(idNum) && idNum > 0;
    const userOr: any[] = [{ name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }];
    if (hasId) userOr.push({ id: idNum });
    const listOr: any[] = [{ title: { contains: q, mode: 'insensitive' } }];
    if (hasId) listOr.push({ id: idNum });
    const bizOr: any[] = [{ name: { contains: q, mode: 'insensitive' } }, { voen: { contains: q } }];
    if (hasId) bizOr.push({ id: idNum });

    const [usersRes, listingsRes, businessesRes, ordersRes] = await Promise.all([
      prisma.user.findMany({ where: { role: 'USER', OR: userOr }, take: 6, select: { id: true, name: true, phone: true, type: true, isBlocked: true, avatar: true } }),
      prisma.listing.findMany({ where: { OR: listOr }, take: 6, select: { id: true, title: true, price: true, type: true } }),
      prisma.business.findMany({ where: { OR: bizOr }, take: 5, select: { id: true, name: true, voen: true, status: true } }),
      hasId ? prisma.order.findMany({ where: { id: idNum }, take: 3, select: { id: true, status: true, total: true, paymentStatus: true } }) : Promise.resolve([]),
    ]);
    res.json({ success: true, results: { users: usersRes, listings: listingsRes, businesses: businessesRes, orders: ordersRes } });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMİN İDARƏETMƏSİ (RBAC) — yalnız super-admin (ADMIN_PHONES).
// İstifadəçiləri admin edir, icazə modullarını (adminPermissions) təyin edir.
// ══════════════════════════════════════════════════════════════════════════

function cleanPermissions(input: any): string[] {
  const arr = Array.isArray(input) ? input : [];
  const allowed = new Set<string>(ADMIN_MODULES as readonly string[]);
  // 'admins' modulunu adi adminə vermək olmaz — yalnız super-admin idarə edir.
  return Array.from(new Set(arr.map((x) => String(x)))).filter((m) => allowed.has(m) && m !== 'admins');
}

// Bütün adminləri (role ADMIN) siyahıla — super-admin işarəsi + icazələri ilə.
router.get('/admin/admins', requireSuperAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true, name: true, phone: true, avatar: true, adminPermissions: true, isBlocked: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json({
      success: true,
      modules: [...ADMIN_MODULES],
      admins: admins.map((a) => ({
        id: a.id, name: a.name, phone: a.phone, avatar: a.avatar, isBlocked: a.isBlocked,
        isSuperAdmin: isAdminPhone(a.phone),
        // Boş icazə + super deyil → köhnə/konfiqurasiya olunmamış (tam giriş).
        unconfigured: !isAdminPhone(a.phone) && (a.adminPermissions || []).length === 0,
        permissions: isAdminPhone(a.phone) ? [...ADMIN_MODULES] : (a.adminPermissions || []),
      })),
    });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
});

// Admin etmək üçün namizəd istifadəçi axtar (ad/telefon). Mövcud adminlər xaric.
router.get('/admin/admins/candidates', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) { res.json({ success: true, users: [] }); return; }
    const users = await prisma.user.findMany({
      where: { role: 'USER', OR: [{ name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }] },
      select: { id: true, name: true, phone: true, avatar: true },
      take: 10,
    });
    res.json({ success: true, users });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
});

// İstifadəçini admin et (və ya mövcud admini yenilə) — icazə modulları ilə.
router.post('/admin/admins', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const userId = parseInt(String(req.body?.userId));
    if (Number.isNaN(userId)) { res.status(400).json({ success: false, message: 'userId tələb olunur' }); return; }
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, phone: true } });
    if (!target) { res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' }); return; }
    const perms = cleanPermissions(req.body?.permissions);
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { role: 'ADMIN', adminPermissions: perms },
      select: { id: true, name: true, phone: true, adminPermissions: true },
    });
    res.json({ success: true, admin: { ...updated, isSuperAdmin: isAdminPhone(updated.phone) } });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
});

// Admin icazələrini yenilə. Super-adminin (ADMIN_PHONES) icazələri dəyişdirilə bilməz.
router.put('/admin/admins/:id/permissions', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, phone: true, role: true } });
    if (!target || target.role !== 'ADMIN') { res.status(404).json({ success: false, message: 'Admin tapılmadı' }); return; }
    if (isAdminPhone(target.phone)) { res.status(400).json({ success: false, message: 'Super-adminin icazələri dəyişdirilə bilməz' }); return; }
    const perms = cleanPermissions(req.body?.permissions);
    const updated = await prisma.user.update({ where: { id }, data: { adminPermissions: perms }, select: { id: true, name: true, phone: true, adminPermissions: true } });
    res.json({ success: true, admin: { ...updated, isSuperAdmin: false } });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
});

// Admin səlahiyyətini götür (role USER) — super-admini götürmək olmaz.
router.delete('/admin/admins/:id', requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    if (id === req.adminId) { res.status(400).json({ success: false, message: 'Özünüzü admindən çıxara bilməzsiniz' }); return; }
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, phone: true, role: true } });
    if (!target || target.role !== 'ADMIN') { res.status(404).json({ success: false, message: 'Admin tapılmadı' }); return; }
    if (isAdminPhone(target.phone)) { res.status(400).json({ success: false, message: 'Super-admin (ADMIN_PHONES) səlahiyyəti panel üzərindən götürülə bilməz' }); return; }
    await prisma.user.update({ where: { id }, data: { role: 'USER', adminPermissions: [] } });
    res.json({ success: true });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
});

export default router;
