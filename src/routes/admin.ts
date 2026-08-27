import { Router, Response } from 'express';
import { PrismaClient, Prisma, UserType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { adminAuth, requireAdmin, requirePermission, requireSuperAdmin, AuthRequest, generateToken, isAdminPhone, ADMIN_MODULES, SENSITIVE_MODULES, canAdminLogin, nationalPhone } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimiter';
import { createOtp } from '../services/otp';
import { refund as kapitalRefund } from '../services/kapital';
import { listFlags, setFlag, listNumbers, setNumber } from '../services/settings';
import { checkAllServices } from '../services/serviceHealth';
import { runWebSearchTest } from '../services/webSearchAI';
import { runAgent } from '../services/aiAgent';
import { getCommissionPercent, setCommissionPercent, createPayout, sellerBalance, getPayoutHoldDays, setPayoutHoldDays } from '../services/settlement';
import { recordSettlement } from '../services/settlement';
import { refundOrderSafe } from '../services/refunds';
import { checkPrice, isYangoConfigured, YANGO_TAXI_CLASS } from '../services/yangoDelivery';
import { infobipStatus, testWhatsApp } from '../services/infobipWhatsApp';
import { smsStatus, testSms } from '../services/infobipSms';
import { otpChannel } from '../services/otp';
import fs from 'fs';
import path from 'path';
import { archiveUserPayees } from '../services/payoutArchive';

const router = Router();
const prisma = new PrismaClient();

// ── Tənzimləmələr (feature-flags) ──
// Admin paneldəki "Tənzimləmələr" səhifəsi üçün. Bütün flag-lar meta + cari
// dəyər ilə qaytarılır; PATCH ilə tək açar aktiv/deaktiv edilir.
router.get('/admin/settings', requirePermission('settings'), async (_req: AuthRequest, res: Response) => {
  try {
    const [flags, numbers] = await Promise.all([listFlags(), listNumbers()]);
    res.json({ success: true, settings: flags, numbers });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Rəqəmli tənzimləmə (tarif) — məs. biznes yaratma haqqı.
router.patch('/admin/settings/number', requirePermission('settings'), async (req: AuthRequest, res: Response) => {
  try {
    const key = String(req.body?.key || '');
    const value = parseFloat(String(req.body?.value));
    if (!key) { res.status(400).json({ success: false, message: 'key tələb olunur' }); return; }
    if (!Number.isFinite(value)) { res.status(400).json({ success: false, message: 'Dəyər rəqəm olmalıdır' }); return; }
    res.json({ success: true, key, value: await setNumber(key, value) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Ödənilmiş biznes haqları — kim, nə vaxt, nə qədər ödəyib.
router.get('/admin/business-fees', requirePermission('finance'), async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.search || '').trim();
    const rows = await prisma.businessFee.findMany({
      where: q ? { user: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }] } } : {},
      // DİQQƏT: `include: { user: true }` YAZMAYIN — Prisma bütün skalyar
      // sahələri (parol heşi, kimlik şəkilləri) qaytarır. Yalnız lazım olanlar:
      select: {
        id: true, amount: true, status: true, businessId: true,
        gatewayProvider: true, gatewayRef: true, paidAt: true, usedAt: true, createdAt: true,
        user: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const paid = rows.filter((r) => r.status === 'PAID' || r.status === 'USED');
    res.json({
      success: true, rows,
      totalPaid: Math.round(paid.reduce((s, r) => s + r.amount, 0) * 100) / 100,
      countPaid: paid.length,
    });
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
// Kilidləmə tənzimləri — ardıcıl səhv koddan sonra hesab bağlanır.
const ADMIN_MAX_FAILED = 5;
const ADMIN_LOCK_MINUTES = 30;

// Nömrə ADMIN_PHONES (Railway env) siyahısında olmalıdır. İsim+şifrə girişi
// yedək olaraq qalır. Eyni nömrə ilə normal saytda giriş də admin verir.

// 1) Nömrəni göndər → siyahıdadırsa OTP göndərilir (SMS).
router.post('/admin/login/phone', authLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const raw = String(req.body?.phone || '').trim();
    // Nömrə env siyahılarından birində olmalıdır (ADMIN_PHONES və ya ADMIN_LOGIN_PHONES).
    if (!canAdminLogin(raw)) { res.status(403).json({ success: false, message: 'Bu nömrə admin siyahısında deyil' }); return; }
    const digits = raw.replace(/\D/g, '');
    const tail = digits.slice(-9);
    const superAdmin = isAdminPhone(raw);
    // Nömrə formatları müxtəlif saxlanıla bilər (+994.., 0.., boşluqlu), ona görə
    // əvvəlcə son 9 rəqəmə görə namizədlər tapılır, sonra TAM (milli hissə)
    // müqayisə edilir — `contains` tək başına yanlış hesabı seçə bilərdi.
    const candidates = await prisma.user.findMany({ where: { phone: { contains: tail } }, take: 20 });
    let user = candidates.find((c) => nationalPhone(c.phone) === tail) || null;

    if (superAdmin) {
      // SUPER-ADMIN (ADMIN_PHONES): yoxdursa yaradılır, varsa admin edilir.
      if (!user) {
        user = await prisma.user.create({
          data: { name: 'Admin', phone: digits.startsWith('994') ? `+${digits}` : (raw || `+${digits}`), type: 'CAR_OWNER', role: 'ADMIN', verified: true, profileComplete: true },
        });
      } else if (user.role !== 'ADMIN') {
        user = await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
      }
    } else {
      // ADMIN_LOGIN_PHONES: yalnız GİRİŞ icazəsidir. İstifadəçi əvvəlcədən panel
      // üzərindən admin edilməlidir — əks halda env-ə yazmaqla tam səlahiyyət
      // alınardı (boş icazə siyahısı "tam giriş" deməkdir).
      if (!user || user.role !== 'ADMIN') {
        res.status(403).json({ success: false, message: 'Bu nömrə hələ admin kimi əlavə edilməyib. Super-admin panel üzərindən əlavə etməlidir.' });
        return;
      }
    }

    if (user.isBlocked) { res.status(403).json({ success: false, message: 'Hesab bloklanıb' }); return; }
    // Kilid yoxlaması — ardıcıl səhv kodlardan sonra hesab müvəqqəti bağlanır.
    if (user.adminLockedUntil && user.adminLockedUntil > new Date()) {
      const mins = Math.ceil((user.adminLockedUntil.getTime() - Date.now()) / 60000);
      res.status(429).json({ success: false, message: `Hesab müvəqqəti kilidlənib. ${mins} dəqiqə sonra yenidən cəhd edin.` });
      return;
    }
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
    if (!user || !canAdminLogin(user.phone)) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (user.isBlocked) { res.status(403).json({ success: false, message: 'Hesab bloklanıb' }); return; }
    if (user.adminLockedUntil && user.adminLockedUntil > new Date()) {
      const mins = Math.ceil((user.adminLockedUntil.getTime() - Date.now()) / 60000);
      res.status(429).json({ success: false, message: `Hesab müvəqqəti kilidlənib. ${mins} dəqiqə sonra yenidən cəhd edin.` });
      return;
    }
    const record = await prisma.verificationCode.findFirst({
      where: { userId, verified: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!record || record.code !== code) {
      // SƏHV KOD → sayğacı artır; limit aşılanda hesabı kilidlə.
      // Bu, IP limitindən asılı deyil — fərqli IP-lərdən yavaş hücum da dayanır.
      const failed = user.adminFailedLogins + 1;
      const lock = failed >= ADMIN_MAX_FAILED;
      await prisma.user.update({
        where: { id: userId },
        data: {
          adminFailedLogins: lock ? 0 : failed,
          ...(lock ? { adminLockedUntil: new Date(Date.now() + ADMIN_LOCK_MINUTES * 60 * 1000) } : {}),
        },
      });
      if (lock) console.warn(`[admin] KİLİDLƏNDİ: user ${userId} (${ADMIN_MAX_FAILED} səhv kod) — ${ADMIN_LOCK_MINUTES} dəq.`);
      res.status(400).json({
        success: false,
        message: lock
          ? `Çox sayda səhv cəhd. Hesab ${ADMIN_LOCK_MINUTES} dəqiqə kilidləndi.`
          : `Kod yanlışdır və ya vaxtı keçib. Qalan cəhd: ${ADMIN_MAX_FAILED - failed}`,
      });
      return;
    }
    await prisma.verificationCode.update({ where: { id: record.id }, data: { verified: true } });
    // Uğurlu giriş → sayğac sıfırlanır.
    await prisma.user.update({ where: { id: userId }, data: { adminFailedLogins: 0, adminLockedUntil: null, ...(user.role !== 'ADMIN' ? { role: 'ADMIN' } : {}) } });
    const token = generateToken(user.id);
    res.json({ success: true, token, admin: { id: user.id, name: user.name } });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── İSİM + ŞİFRƏ GİRİŞİ BAĞLANIB ──────────────────────────────────────────
// Admin panelinə giriş YALNIZ nömrə + SMS kodu ilədir və nömrə env
// siyahısında (ADMIN_PHONES / ADMIN_LOGIN_PHONES) olmalıdır.
// Səbəb: şifrə tək faktordur — sızsa və ya təxmin edilsə panel açılırdı.
// Endpoint silinmir, 410 qaytarır ki, köhnə müştəri aydın mesaj görsün.
router.post('/admin/login', authLimiter, async (_req: AuthRequest, res: Response) => {
  res.status(410).json({
    success: false,
    message: 'Şifrə ilə giriş dayandırılıb. Admin panelinə yalnız nömrə + təsdiq kodu ilə daxil olun.',
  });
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
// Yalnız serverin çıxış IP-si — servis yoxlaması İŞLƏMİR (kredit xərclənmir).
// Yango kimi API-lər açarı IP-yə bağlayır; "Host is not allowed" xətasında
// bu ünvan onlara verilməlidir.
router.get('/admin/service-health/ip', requirePermission('ai'), async (_req: AuthRequest, res: Response) => {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
    res.json({ success: true, outboundIp: ((await r.json()) as any)?.ip ?? null });
  } catch {
    res.json({ success: true, outboundIp: null });
  }
});

router.get('/admin/service-health', requirePermission('ai'), async (_req: AuthRequest, res: Response) => {
  try {
    const services = await checkAllServices();
    // Serverin ÇIXIŞ IP-si. Yango kimi xidmətlər API açarını IP-yə bağlayır
    // ("Host is not allowed" xətası buradan gəlir) — həmin IP-ni onlara
    // vermək lazımdır. Railway-də IP deploy-dan deploy-a dəyişə bilər.
    let outboundIp: string | null = null;
    try {
      const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
      outboundIp = ((await r.json()) as any)?.ip ?? null;
    } catch { /* şəbəkə bağlıdırsa göstərilmir */ }
    res.json({ success: true, services, outboundIp });
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

// ── İSTİFADƏÇİNİN TƏHLÜKƏSİZ SİLİNMƏSİ ──────────────────────────────────────
// Həm tək (DELETE /admin/users/:id), həm toplu silmə bu funksiyadan keçir:
//   1) ödəniş ünvanının arxivi götürülür (borc ödənilə bilsin),
//   2) asılı sətirlər açıq şəkildə, düzgün sırayla silinir.
async function unpaidOwed(userId: number): Promise<number> {
  const rows = await prisma.sellerLedger.findMany({
    where: { sellerId: userId, heldByPlatform: true, status: { in: ['PENDING', 'AVAILABLE'] }, clawbackNeeded: false },
    select: { netAmount: true },
  });
  return Math.round(rows.reduce((s, l) => s + l.netAmount, 0) * 100) / 100;
}

async function deleteUserSafely(U: number, adminName?: string): Promise<{ archived: number; owed: number }> {
  const archived = await archiveUserPayees(U).catch(() => 0);
  const owed = await unpaidOwed(U);
  if (owed > 0) console.warn(`[admin] user ${U} silinir — ödənilməmiş borc ${owed} AZN ödəniş ekranında qalır (admin ${adminName || '?'})`);
  await prisma.$transaction(async (tx) => {
    await tx.order.updateMany({ where: { courierId: U }, data: { courierId: null } });
    await tx.order.updateMany({ where: { referrerId: U }, data: { referrerId: null } });
    await tx.messageReaction.deleteMany({ where: { userId: U } });
    await tx.returnRequest.deleteMany({ where: { OR: [{ buyerId: U }, { sellerId: U }] } });
    await tx.inquiryOffer.deleteMany({ where: { sellerId: U } });
    await tx.inquiryTarget.deleteMany({ where: { sellerId: U } });
    await tx.sellerRating.deleteMany({ where: { OR: [{ sellerId: U }, { buyerId: U }] } });
    await tx.comment.deleteMany({ where: { userId: U } });
    await tx.conversationMember.deleteMany({ where: { userId: U } });
    await tx.referralCart.deleteMany({ where: { referrerId: U } });
    await tx.consultationOffer.deleteMany({ where: { userId: U } });
    await tx.consultationSession.deleteMany({ where: { OR: [{ buyerId: U }, { professionalId: U }] } });
    await tx.order.deleteMany({ where: { OR: [{ buyerId: U }, { sellerId: U }] } });
    await tx.inquiry.deleteMany({ where: { buyerId: U } });
    await tx.message.deleteMany({ where: { OR: [{ senderId: U }, { receiverId: U }] } });
    await tx.cart.deleteMany({ where: { userId: U } });
    await tx.sharedCart.deleteMany({ where: { userId: U } });
    await tx.booking.deleteMany({ where: { OR: [{ guestId: U }, { hostId: U }] } });
    await tx.complaint.deleteMany({ where: { OR: [{ complainantId: U }, { targetUserId: U }] } });
    await tx.listing.deleteMany({ where: { userId: U } });
    await tx.business.deleteMany({ where: { userId: U } });
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
    await tx.user.delete({ where: { id: U } });
  }, { timeout: 20000 });
  return { archived, owed };
}

router.post('/admin/listings/bulk', requirePermission('listings'), async (req: AuthRequest, res: Response) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map((x: any) => parseInt(String(x))).filter((n: number) => !Number.isNaN(n)).slice(0, 500);
    const action = String(req.body?.action || '');
    if (!ids.length) { res.status(400).json({ success: false, message: 'Elan seçilməyib' }); return; }
    let count = 0;
    let archivedCount = 0;
    if (action === 'approve') count = (await prisma.listing.updateMany({ where: { id: { in: ids } }, data: { status: 'APPROVED' } })).count;
    else if (action === 'reject') count = (await prisma.listing.updateMany({ where: { id: { in: ids } }, data: { status: 'REJECTED' } })).count;
    else if (action === 'delete') {
      // Sifarişdə keçən elanlar silinmir — arxivlənir (sifariş sətirləri qorunur).
      const sold = await prisma.orderItem.findMany({ where: { listingId: { in: ids } }, select: { listingId: true }, distinct: ['listingId'] });
      const soldIds = new Set(sold.map((x) => x.listingId));
      const deletable = ids.filter((n: number) => !soldIds.has(n));
      if (soldIds.size) {
        const arch = await prisma.listing.updateMany({ where: { id: { in: Array.from(soldIds) } }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
        archivedCount = arch.count;
      }
      count = deletable.length ? (await prisma.listing.deleteMany({ where: { id: { in: deletable } } })).count : 0;
    }
    else { res.status(400).json({ success: false, message: 'Yanlış əməliyyat' }); return; }
    res.json({
      success: true, count, archived: archivedCount,
      ...(archivedCount ? { message: `${count} elan silindi, ${archivedCount} elan sifarişdə keçdiyi üçün arxivləndi.` } : {}),
    });
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
    else if (action === 'delete') {
      // ── TOPLU SİLMƏ ARTIQ "deleteMany" DEYİL ──
      // Əvvəl bir sətirlə silinirdi: ödəniş ünvanının arxivi götürülmür,
      // ödənilməmiş borc barədə xəbərdarlıq edilmirdi, sifarişlər isə kaskadla
      // yox olurdu. İndi hər istifadəçi tək-tək eyni təhlükəsiz axından keçir.
      const skipped: { id: number; owed: number }[] = [];
      for (const uid of targetIds) {
        const owed = await unpaidOwed(uid);
        if (owed > 0 && String(req.body?.force || '') !== '1') { skipped.push({ id: uid, owed }); continue; }
        await deleteUserSafely(uid, req.adminName);
        count++;
      }
      if (skipped.length) {
        res.status(409).json({
          success: false, needsConfirm: true, deleted: count, skipped,
          message: `${skipped.length} istifadəçiyə ödənilməmiş borcumuz var (${skipped.map((x) => `#${x.id}: ${x.owed} AZN`).join(', ')}). Hesab silinsə də borc ödəniş ekranında qalır — davam etmək üçün təsdiqləyin.`,
        });
        return;
      }
    }
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
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true, paymentStatus: true, total: true } });
    if (!order) { res.status(404).json({ success: false, message: 'Sifariş tapılmadı' }); return; }

    // ── MALİYYƏ TARİXÇƏSİ SİLİNMİR ──
    // Əvvəl bu endpoint sifarişlə birlikdə SellerLedger sətrini də silirdi:
    // satıcıya olan borcumuz və ödəniş tarixçəsi izsiz yox olurdu (ödənilmiş
    // sətir üçün Payout yetim qalırdı). Ödənilmiş və ya hesablaşması olan
    // sifariş yalnız uçotda qalmalıdır.
    const ledger = await prisma.sellerLedger.findUnique({ where: { orderId: id }, select: { status: true, netAmount: true } });
    if (order.paymentStatus === 'PAID' || order.paymentStatus === 'REFUNDED' || ledger) {
      res.status(409).json({
        success: false,
        code: 'FINANCIAL_RECORD',
        message: `Bu sifariş silinmir — maliyyə qeydi var (ödəniş: ${order.paymentStatus}${ledger ? `, hesablaşma: ${ledger.status}, ${ledger.netAmount} AZN` : ''}). Uçotun bütövlüyü üçün sifariş saxlanılır; lazım gələrsə statusunu «Ləğv edildi» edin.`,
      });
      return;
    }
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
      where: { heldByPlatform: true, status: { in: ['AVAILABLE', 'PENDING'] }, clawbackNeeded: false },
      select: {
        id: true, orderId: true, businessId: true, sellerId: true, status: true,
        netAmount: true, commission: true, grossAmount: true,
        // Hesab/biznes silinibsə ödəniş məlumatı bu surətdən oxunur.
        payeeName: true, payeeVoen: true, payeeOwner: true, payeePhone: true, payeeIban: true, payeeBank: true, payeeArchived: true,
      },
    });
    await backfillLedgerBusiness(ledgers);

    type Row = { businessId: number | null; sellerId: number; unpaid: number; pending: number; commission: number; gross: number; orders: number };
    const map = new Map<string, Row>();
    // Ödəniş ünvanının surəti (hesab silinibsə yeganə mənbədir).
    const snapByKey = new Map<string, { name: string | null; voen: string | null; owner: string | null; phone: string | null; iban: string | null; bank: string | null; archivedAt: Date | null }>();
    for (const l of ledgers) {
      const key = l.businessId ? `b${l.businessId}` : `u${l.sellerId}`;
      if (l.payeeArchived && !snapByKey.has(key)) {
        snapByKey.set(key, { name: l.payeeName, voen: l.payeeVoen, owner: l.payeeOwner, phone: l.payeePhone, iban: l.payeeIban, bank: l.payeeBank, archivedAt: l.payeeArchived });
      }
      const cur = map.get(key) || { businessId: l.businessId, sellerId: l.sellerId, unpaid: 0, pending: 0, commission: 0, gross: 0, orders: 0 };
      if (l.status === 'AVAILABLE') { cur.unpaid += l.netAmount; cur.orders++; cur.commission += l.commission; cur.gross += l.grossAmount; }
      else cur.pending += l.netAmount;
      map.set(key, cur);
    }

    const bizIds = Array.from(new Set(Array.from(map.values()).map((r) => r.businessId).filter(Boolean))) as number[];
    const userIds = Array.from(new Set(Array.from(map.values()).filter((r) => !r.businessId).map((r) => r.sellerId)));
    const [bizzes, users] = await Promise.all([
      // `deletedAt` də seçilir: biznes silinsə belə ona olan BORCUMUZ qalır və
      // bu ekranda ödənilməlidir — sətirdə "silinib" nişanı göstərilir.
      bizIds.length ? prisma.business.findMany({ where: { id: { in: bizIds } }, select: { id: true, name: true, voen: true, deletedAt: true, phone: true, ownerName: true, banks: { where: { isActive: true }, select: { iban: true, title: true, isPrimary: true } } } }) : [],
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, phone: true } }) : [],
    ]);
    const bById = new Map(bizzes.map((b) => [b.id, b]));
    const uById = new Map(users.map((u) => [u.id, u]));
    const r2 = (n: number) => Math.round(n * 100) / 100;

    let rows = Array.from(map.values()).map((r) => {
      const key = r.businessId ? `b${r.businessId}` : `u${r.sellerId}`;
      const b = r.businessId ? bById.get(r.businessId) : null;
      const u = uById.get(r.sellerId);
      const snap = snapByKey.get(key);
      const acc = b?.banks?.find((a: { isPrimary: boolean }) => a.isPrimary) || b?.banks?.[0] || null;
      // HESAB TAM SİLİNİB: Business/User sətri yoxdur, yalnız surət qalıb —
      // borc yenə ödənilməlidir, ona görə sətir siyahıdan çıxmır.
      const accountDeleted = r.businessId ? !b : !u;
      return {
        key,
        businessId: r.businessId, sellerId: r.sellerId,
        name: b?.name || u?.name || snap?.name || '—',
        voen: b?.voen || snap?.voen || null,
        isBusiness: !!r.businessId,
        // Sahibi biznesi silib — pulu yenə də ona köçürməliyik.
        deleted: !!b?.deletedAt,
        accountDeleted,
        archivedAt: snap?.archivedAt || null,
        ownerName: b?.ownerName || snap?.owner || null,
        phone: b?.phone || u?.phone || snap?.phone || null,
        iban: acc?.iban || snap?.iban || null,
        bankTitle: acc?.title || snap?.bank || null,
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

    const where: any = {
      heldByPlatform: true, status: 'AVAILABLE', clawbackNeeded: false,
      OR: [{ availableAt: null }, { availableAt: { lte: new Date() } }],
    };
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
      isBiz ? prisma.business.findUnique({ where: { id }, select: { id: true, name: true, voen: true, deletedAt: true, phone: true, ownerName: true, banks: { where: { isActive: true }, select: { id: true, iban: true, title: true, isPrimary: true } } } }) : null,
      !isBiz ? prisma.user.findUnique({ where: { id }, select: { id: true, name: true, phone: true } }) : null,
      prisma.payout.findMany({ where: isBiz ? { businessId: id } : { sellerId: id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const acc = biz?.banks?.find((a: { isPrimary: boolean }) => a.isPrimary) || biz?.banks?.[0] || null;
    // Hesab tam silinibsə ödəniş məlumatı ledger-dəki surətdən oxunur.
    const snapRow = ledgers.find((l) => l.payeeArchived) || null;
    const accountDeleted = isBiz ? !biz : !seller;
    res.json({
      success: true, key, isBusiness: isBiz,
      name: biz?.name || seller?.name || snapRow?.payeeName || '—',
      voen: biz?.voen || snapRow?.payeeVoen || null,
      deleted: !!biz?.deletedAt, deletedAt: biz?.deletedAt || null,
      accountDeleted, archivedAt: snapRow?.payeeArchived || null,
      ownerName: biz?.ownerName || snapRow?.payeeOwner || null,
      phone: biz?.phone || seller?.phone || snapRow?.payeePhone || null,
      iban: acc?.iban || snapRow?.payeeIban || null,
      bankTitle: acc?.title || snapRow?.payeeBank || null,
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
    const where: any = {
      id: { in: ids }, heldByPlatform: true, status: 'AVAILABLE',
      // Müdafiə: geri alınmalı sətir ödənilə bilməz.
      clawbackNeeded: false,
      // Müdafiə: alıcı müdafiəsi pəncərəsi bitməyibsə ödənilə bilməz.
      // (Job onsuz da vaxtı çatmayanı AVAILABLE etmir — bu ikinci qatdır.)
      OR: [{ availableAt: null }, { availableAt: { lte: new Date() } }],
    };
    if (isBiz) where.businessId = id; else { where.sellerId = id; where.businessId = null; }
    const ledgers = await prisma.sellerLedger.findMany({ where });
    if (!ledgers.length) { res.status(400).json({ success: false, message: 'Seçilmiş sətirlər artıq ödənilib və ya tapılmadı' }); return; }
    if (ledgers.length !== ids.length) {
      console.warn(`[payouts] ${ids.length} seçildi, ${ledgers.length} uyğun gəldi — bəziləri artıq ödənilib`);
    }

    const amount = Math.round(ledgers.reduce((s, l) => s + l.netAmount, 0) * 100) / 100;
    let iban: string | null = null;
    if (isBiz) {
      const acc = await prisma.bankAccount.findFirst({ where: { businessId: id, isActive: true }, orderBy: { isPrimary: 'desc' }, select: { iban: true } });
      // Hesab silinibsə bank sətri də yoxdur — ödəniş ünvanının arxiv surətindən götürülür.
      iban = acc?.iban || ledgers.find((l) => l.payeeIban)?.payeeIban || null;
    }

    // ── HƏR SATICI ÜÇÜN AYRICA ÖDƏNİŞ QEYDİ ──
    // Bir biznesdə bir neçə işçi sata bilər; əvvəl bütün məbləğ `ledgers[0]`-ın
    // sahibinə yazılırdı və qalanların "qazancım" tarixçəsi natamam qalırdı.
    const bySeller = new Map<number, typeof ledgers>();
    for (const l of ledgers) {
      const arr = bySeller.get(l.sellerId) || [];
      arr.push(l);
      bySeller.set(l.sellerId, arr);
    }
    const method = req.body?.method ? String(req.body.method).slice(0, 40) : 'BANK';
    const reference = req.body?.reference ? String(req.body.reference).slice(0, 200) : null;

    const payouts = await prisma.$transaction(async (tx) => {
      const created = [];
      for (const [sellerId, rows] of bySeller) {
        const sum = Math.round(rows.reduce((acc, l) => acc + l.netAmount, 0) * 100) / 100;
        const p = await tx.payout.create({
          data: {
            sellerId, businessId: isBiz ? id : null, iban, amount: sum, method, reference,
            createdById: req.adminId!, createdName: req.adminName || 'Admin',
          },
        });
        await tx.sellerLedger.updateMany({ where: { id: { in: rows.map((l) => l.id) } }, data: { status: 'PAID_OUT', payoutId: p.id } });
        created.push({ payout: p, count: rows.length });
      }
      return created;
    });

    for (const { payout: p, count } of payouts) {
      await prisma.notification.create({
        data: { userId: p.sellerId, type: 'SYSTEM', title: 'Ödəniş edildi 💸', body: `${p.amount} AZN bank hesabınıza köçürüldü (${count} sifariş).`, link: '/earnings' },
      }).catch(() => {});
    }

    res.json({ success: true, payout: payouts[0]?.payout, payouts: payouts.map((x) => x.payout), paidCount: ledgers.length, amount });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});


// ── ÖDƏNİŞİ GERİ AL — səhvən "ödənildi" işarələnibsə ──
// Sətirlər yenidən ödəniləcək (AVAILABLE) olur, payout isə tarixçədə qalır
// (silinmir — audit üçün) və "geri alındı" kimi işarələnir.
router.post('/admin/payouts/:id/reverse', requirePermission('finance_payouts'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    if (Number.isNaN(id)) { res.status(400).json({ success: false, message: 'Yanlış id' }); return; }
    const payout = await prisma.payout.findUnique({ where: { id } });
    if (!payout) { res.status(404).json({ success: false, message: 'Ödəniş tapılmadı' }); return; }
    if (payout.reversedAt) { res.status(400).json({ success: false, message: 'Bu ödəniş artıq geri alınıb' }); return; }
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (!reason) { res.status(400).json({ success: false, message: 'Səbəb yazılmalıdır' }); return; }

    const ledgers = await prisma.sellerLedger.findMany({ where: { payoutId: id }, select: { id: true, orderId: true } });
    await prisma.$transaction(async (tx) => {
      await tx.sellerLedger.updateMany({
        where: { id: { in: ledgers.map((l) => l.id) } },
        data: { status: 'AVAILABLE', payoutId: null },
      });
      await tx.payout.update({
        where: { id },
        data: { reversedAt: new Date(), reversedById: req.adminId!, reversedName: req.adminName || 'Admin', reversedReason: reason },
      });
    });
    // Sətirləri şərtsiz AVAILABLE etmək düz deyil: sifariş bu arada ləğv/iadə
    // olubsa pul yenidən ödəniş növbəsinə düşərdi. Hesablaşma hər sifariş üçün
    // yenidən hesablanır və düzgün statusu özü təyin edir.
    for (const l of ledgers) await recordSettlement(l.orderId).catch(() => {});
    console.warn(`[payouts] GERİ ALINDI: payout ${id}, ${payout.amount} AZN, ${ledgers.length} sətir, admin ${req.adminName}`);
    res.json({ success: true, restored: ledgers.length, amount: payout.amount });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── GERİ ALINMALI PULLAR — ödənişdən SONRA ləğv/qaytarma olan sifarişlər ──
// Bu pul satıcının bankındadır; sistem avtomatik geri ala bilmir, ona görə
// admin görüb satıcı ilə həll etməlidir. Görünməsə zərər bizim üzərimizdə qalır.
router.get('/admin/payouts/clawbacks', requirePermission('finance_payouts'), async (_req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.sellerLedger.findMany({
      where: { clawbackNeeded: true },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      select: { id: true, orderId: true, sellerId: true, businessId: true, netAmount: true, clawbackReason: true, updatedAt: true },
    });
    const sellerIds = Array.from(new Set(rows.map((r) => r.sellerId)));
    const bizIds = Array.from(new Set(rows.map((r) => r.businessId).filter(Boolean))) as number[];
    const [users, bizzes] = await Promise.all([
      sellerIds.length ? prisma.user.findMany({ where: { id: { in: sellerIds } }, select: { id: true, name: true, phone: true } }) : [],
      bizIds.length ? prisma.business.findMany({ where: { id: { in: bizIds } }, select: { id: true, name: true } }) : [],
    ]);
    const uById = new Map(users.map((u) => [u.id, u]));
    const bById = new Map(bizzes.map((b) => [b.id, b]));
    const total = Math.round(rows.reduce((s, r) => s + r.netAmount, 0) * 100) / 100;
    res.json({
      success: true, total,
      rows: rows.map((r) => ({
        ...r,
        sellerName: uById.get(r.sellerId)?.name || '—',
        sellerPhone: uById.get(r.sellerId)?.phone || '',
        businessName: r.businessId ? bById.get(r.businessId)?.name || null : null,
      })),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Geri alınma həll olundu — işarəni götür (admin satıcı ilə razılaşıb).
router.post('/admin/payouts/clawbacks/:id/resolve', requirePermission('finance_payouts'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const note = String(req.body?.note || '').trim().slice(0, 300);
    await prisma.sellerLedger.update({
      where: { id },
      data: { clawbackNeeded: false, clawbackReason: note ? `HƏLL OLUNDU (${req.adminName || 'Admin'}): ${note}` : null },
    });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Saxlama pəncərəsi (alıcı müdafiəsi) ayarı ──
router.get('/admin/payouts/hold-days', requirePermission('finance_payouts'), async (_req: AuthRequest, res: Response) => {
  res.json({ success: true, days: await getPayoutHoldDays() });
});
router.patch('/admin/payouts/hold-days', requirePermission('finance_payouts'), async (req: AuthRequest, res: Response) => {
  try {
    const d = parseInt(String(req.body?.days));
    if (!Number.isFinite(d) || d < 0 || d > 90) { res.status(400).json({ success: false, message: '0–90 gün arası olmalıdır' }); return; }
    res.json({ success: true, days: await setPayoutHoldDays(d) });
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
    // Sidebar server icazəsi ilə eyni olmalıdır: icazəsi təyin edilməmiş admin
    // HƏSSAS modulları (maliyyə, ödənişlər, istifadəçilər, tənzimləmə, audit,
    // adminlər) görmür — onlar yalnız açıq verilən icazə ilə açılır.
    const effective = req.isSuperAdmin
      ? [...ADMIN_MODULES]
      : unconfigured ? ADMIN_MODULES.filter((m) => !SENSITIVE_MODULES.includes(m)) : perms;
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
        // DİQQƏT: sahələr açıq seçilir. `include` bütün skalyar sahələri qaytarır
        // və şifrə hash-i ilə vəsiqə şəkilləri də cavaba düşürdü — siyahıda
        // onlara ehtiyac yoxdur, brauzerə göndərilməməlidir.
        select: {
          id: true, name: true, phone: true, email: true, avatar: true, type: true, role: true,
          verified: true, sellerVerified: true, isBlocked: true, profileComplete: true,
          city: true, profession: true, publicId: true, createdAt: true, lastSeen: true,
          avgRating: true, ratingCount: true, complaintFlags: true, idVerifyStatus: true,
          vehicles: true, workplaces: true,
          _count: { select: { listings: true, businesses: true, buyerOrders: true, sellerOrders: true } },
        },
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

// Bir istifadəçi haqqında HƏR ŞEY — profil, sənədlər, biznesləri, elanları,
// alış/satışları, pulu, reytinqi, sosial hesabları, əlaqə tarixçəsi.
//
// Ayrı endpoint-dir, siyahıya qoşulmayıb: bu qədər məlumatı 20 istifadəçi üçün
// birdən çəkmək siyahını ağırlaşdırardı. Yalnız kart açılanda bir dəfə çağırılır.
router.get('/admin/users/:id/full', requirePermission('users'), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) { res.status(400).json({ success: false, message: 'Yanlış id' }); return; }

    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        vehicles: true,
        workplaces: true,
        socialLinks: { select: { id: true, platform: true, url: true, verified: true } },
        // `code` sahəsi qəsdən seçilmir — o, canlı SMS doğrulama kodudur.
        phones: { select: { id: true, phone: true, isPrimary: true, verified: true } },
        addresses: { select: { id: true, label: true, address: true, phone: true, isDefault: true } },
        sellerApplication: { select: { id: true, status: true, businessName: true, taxId: true, submittedAt: true, reviewedAt: true, rejectionReason: true } },
        _count: {
          select: {
            listings: true, buyerOrders: true, sellerOrders: true, favorites: true,
            sentMessages: true, receivedMessages: true, complaintsMade: true, complaintsAgainst: true,
            sellerRatings: true, givenRatings: true, contacts: true, businesses: true,
            consultationsBought: true, consultationsSelling: true, notifications: true,
          },
        },
      },
    });
    if (!user) { res.status(404).json({ success: false, message: 'İstifadəçi tapılmadı' }); return; }

    const [
      businesses, memberships, listings, listingStats,
      buyerAgg, sellerAgg, ledgerAgg, recentBuyerOrders, recentSellerOrders, ratings, lastMessage,
    ] = await Promise.all([
      // Sahibi olduğu bizneslər + obyektləri
      prisma.business.findMany({
        where: { userId: id },
        select: {
          id: true, name: true, voen: true, status: true, phone: true, ownerName: true, founderName: true, createdAt: true,
          objects: { select: { id: true, name: true, city: true, address: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      // Başqasının biznesində işçidirsə
      prisma.businessMember.findMany({
        where: { userId: id },
        select: {
          id: true, status: true, canSell: true, canBuy: true,
          business: { select: { id: true, name: true, voen: true } },
          object: { select: { id: true, name: true } },
        },
      }),
      // Son elanları — şəkli ilə
      prisma.listing.findMany({
        where: { userId: id },
        select: { id: true, title: true, price: true, images: true, category: true, status: true, stock: true, city: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 12,
      }),
      // Elanların statusa görə bölgüsü
      prisma.listing.groupBy({ by: ['status'], where: { userId: id }, _count: { _all: true } }),
      // Alıcı kimi ödədiyi (yalnız ödənilmiş sifarişlər)
      prisma.order.aggregate({ where: { buyerId: id, paymentStatus: 'PAID' }, _sum: { total: true }, _count: { _all: true } }),
      // Satıcı kimi satdığı
      prisma.order.aggregate({ where: { sellerId: id, paymentStatus: 'PAID' }, _sum: { total: true }, _count: { _all: true } }),
      // Ona borclu olduğumuz / ödədiyimiz pul
      prisma.sellerLedger.groupBy({ by: ['status'], where: { sellerId: id }, _sum: { netAmount: true, commission: true }, _count: { _all: true } }),
      prisma.order.findMany({
        where: { buyerId: id },
        select: { id: true, total: true, status: true, paymentStatus: true, paymentMethod: true, createdAt: true, seller: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' }, take: 8,
      }),
      prisma.order.findMany({
        where: { sellerId: id },
        select: { id: true, total: true, status: true, paymentStatus: true, paymentMethod: true, createdAt: true, buyer: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' }, take: 8,
      }),
      prisma.sellerRating.findMany({
        where: { sellerId: id },
        select: { id: true, rating: true, comment: true, createdAt: true, buyer: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' }, take: 6,
      }),
      prisma.message.findFirst({
        where: { OR: [{ senderId: id }, { receiverId: id }] },
        select: { createdAt: true }, orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Şifrə heç vaxt göndərilmir — admin panelə düşsə brauzer yaddaşında qalardı.
    const { password, ...safe } = user as any;

    res.json({
      success: true,
      user: safe,
      businesses,
      memberships,
      listings,
      listingStats: listingStats.map((s) => ({ status: s.status, count: s._count._all })),
      money: {
        boughtTotal: buyerAgg._sum.total || 0,
        boughtOrders: buyerAgg._count._all,
        soldTotal: sellerAgg._sum.total || 0,
        soldOrders: sellerAgg._count._all,
        ledger: ledgerAgg.map((l) => ({ status: l.status, net: l._sum.netAmount || 0, commission: l._sum.commission || 0, count: l._count._all })),
      },
      recentBuyerOrders,
      recentSellerOrders,
      ratings,
      lastMessageAt: lastMessage?.createdAt || null,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── YANGO TARİF MÜQAYİSƏSİ ────────────────────────────────────────────────
// Eyni marşrut üçün bütün tarif siniflərinin qiymətini yan-yana göstərir.
// Qiymətin niyə baha olduğunu TƏXMİN etmək əvəzinə Yango-nun özündən soruşuruq.
//
// Marşrut verilməsə real bir sifarişin (ən sonuncu Yango sifarişi) marşrutu
// götürülür — süni koordinatla müqayisə aldadıcı olardı.
router.get('/admin/yango/tariffs', requirePermission('ai'), async (req: AuthRequest, res: Response) => {
  try {
    if (!isYangoConfigured()) { res.json({ success: false, message: 'YANGO_TOKEN qurulmayıb' }); return; }
    const num = (v: any) => (v != null && v !== '' && Number.isFinite(parseFloat(String(v))) ? parseFloat(String(v)) : null);
    let fromLat = num(req.query.fromLat), fromLng = num(req.query.fromLng);
    let toLat = num(req.query.toLat), toLng = num(req.query.toLng);
    let sourceNote = 'əl ilə verilmiş koordinatlar';

    if (fromLat == null || fromLng == null || toLat == null || toLng == null) {
      // Son real Yango sifarişindən marşrutu götür.
      const o = await prisma.order.findFirst({
        where: { yangoClaimId: { not: null }, latitude: { not: null }, longitude: { not: null } },
        orderBy: { id: 'desc' },
        select: {
          id: true, latitude: true, longitude: true, yangoPrice: true,
          seller: { select: { latitude: true, longitude: true } },
          items: { select: { listing: { select: { weightKg: true, businessObject: { select: { latitude: true, longitude: true } } } }, quantity: true } },
        },
      });
      if (!o) { res.json({ success: false, message: 'Müqayisə üçün Yango sifarişi tapılmadı — koordinatları əl ilə verin' }); return; }
      const obj = o.items.map((i) => i.listing?.businessObject).find((b) => b && b.latitude != null);
      fromLat = obj?.latitude ?? o.seller?.latitude ?? null;
      fromLng = obj?.longitude ?? o.seller?.longitude ?? null;
      toLat = o.latitude; toLng = o.longitude;
      sourceNote = `sifariş #${o.id} marşrutu (ödənilmiş Yango qiyməti: ${o.yangoPrice ?? '—'})`;
    }
    if (fromLat == null || fromLng == null || toLat == null || toLng == null) {
      res.json({ success: false, message: 'Marşrut koordinatları tapılmadı' }); return;
    }

    const weight = num(req.query.weight) ?? 1;
    // Sinif adları API-dən soruşulur: hansı qəbul olunmursa xətası göstərilir.
    const classes = ['courier', 'express', 'cargo', 'cargocorp'];
    const rows = await Promise.all(classes.map(async (taxiClass) => {
      const q = await checkPrice({
        source: [fromLng!, fromLat!], destination: [toLng!, toLat!], weightKg: weight, taxiClass,
      });
      return {
        taxiClass,
        ok: q.ok && !!q.data?.price,
        price: q.data?.price ? parseFloat(String(q.data.price)) : null,
        currency: q.data?.currency_rules?.code || null,
        eta: q.data?.eta ?? null,
        error: q.ok ? null : q.error,
      };
    }));

    res.json({
      success: true,
      active: YANGO_TAXI_CLASS,           // hazırda hansı sinif işlədilir
      route: { fromLat, fromLng, toLat, toLng, weight, note: sourceNote },
      rows,
    });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
});

// ── QAYTARILMALI PUL ──────────────────────────────────────────────────────
// Şlüzə edilən qaytarma sorğusu uğursuz olsa pul ALICIDA DEYİL, BİZDƏDİR.
// Bu siyahı həmin halları göstərir — heç bir sətir səssizcə itmir.
router.get('/admin/refunds', requirePermission('finance'), async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.query.status || 'OPEN').toUpperCase(); // OPEN | DONE | ALL
    const where: any = status === 'DONE' ? { status: 'DONE' }
      : status === 'ALL' ? {}
      : { status: { in: ['PENDING', 'FAILED'] } };
    const rows = await prisma.refundAttempt.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: {
        order: {
          select: {
            id: true, total: true, status: true, paymentStatus: true, paymentMethod: true,
            gatewayProvider: true, gatewayRef: true, createdAt: true,
            buyer: { select: { id: true, name: true, phone: true } },
            seller: { select: { id: true, name: true } },
          },
        },
      },
    });
    const open = rows.filter((r) => r.status !== 'DONE');
    res.json({
      success: true,
      rows,
      totals: { openCount: open.length, openAmount: open.reduce((s, r) => s + r.amount, 0) },
    });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
});

// Əl ilə təkrar cəhd — admin şlüz problemi həll olunandan sonra basır.
router.post('/admin/refunds/:orderId/retry', requirePermission('finance'), async (req: AuthRequest, res: Response) => {
  try {
    const orderId = parseInt(String(req.params.orderId));
    const row = await prisma.refundAttempt.findUnique({ where: { orderId } });
    if (!row) { res.status(404).json({ success: false, message: 'Qeyd tapılmadı' }); return; }
    // Cəhd sayğacı MAX-a çatıbsa avtomatik təkrar dayanır — əl ilə basılanda sıfırlanır.
    await prisma.refundAttempt.update({ where: { orderId }, data: { attempts: 0, status: 'FAILED' } });
    const r = await refundOrderSafe(orderId, row.reason as any, row.amount);
    if (!r.ok) { res.status(502).json({ success: false, message: r.error || 'Yenə alınmadı' }); return; }
    res.json({ success: true });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
});

// Əl ilə həll olundu (məs. bankdan köçürüldü) — sətir bağlanır.
// Şlüz onsuz da qaytara bilmirsə tək çıxış yolu budur; qeyd audit üçün qalır.
router.post('/admin/refunds/:orderId/resolve', requirePermission('finance'), async (req: AuthRequest, res: Response) => {
  try {
    const orderId = parseInt(String(req.params.orderId));
    const note = String(req.body?.note || '').trim();
    if (!note) { res.status(400).json({ success: false, message: 'Necə həll olunduğunu yazın' }); return; }
    await prisma.refundAttempt.update({
      where: { orderId },
      data: { status: 'DONE', doneAt: new Date(), adminNote: `${note} (admin #${req.adminId})` },
    });
    await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'REFUNDED', gatewayStatus: 'Refunded (manual)' } }).catch(() => {});
    res.json({ success: true });
  } catch (error: any) { res.status(400).json({ success: false, message: error.message }); }
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
    // Ödənilməmiş borc varsa admin bunu bilərək təsdiqləməlidir: hesab silinir,
    // borc isə ödəniş ekranında "hesab silinib" nişanı ilə qalır.
    const owed = await unpaidOwed(targetId);
    if (owed > 0 && String(req.query.force || '') !== '1') {
      res.status(409).json({
        success: false, needsConfirm: true, owed,
        message: `Bu satıcıya ödənilməmiş ${owed} AZN borcumuz var. Hesab silinsə də borc ödəniş ekranında qalacaq — davam etmək üçün təsdiqləyin.`,
      });
      return;
    }
    const r = await deleteUserSafely(targetId, req.adminName);
    res.json({ success: true, archivedLedgers: r.archived, owed: r.owed });
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
        include: {
          user: { select: { id: true, name: true, phone: true, type: true } },
          // Görünmə diaqnostikası üçün — aşağıda izah var.
          business: { select: { isActive: true, name: true } },
          businessObject: { select: { isActive: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.listing.count({ where }),
    ]);
    const pendingCount = await prisma.listing.count({ where: { status: 'PENDING' } });

    // NİYƏ SAYTDA GÖRÜNMÜR — hər elan üçün konkret səbəb.
    //
    // Təsdiqləmək TƏK şərt deyil: elan ictimai siyahıya düşmək üçün eyni anda
    // dörd şərti ödəməlidir. Admin bunu bilmədən "təsdiqlədim, amma görünmür"
    // vəziyyətində qalırdı. İndi səbəb sətrin yanında yazılır.
    const now = new Date();
    const withVisibility = listings.map((l: any) => {
      const reasons: string[] = [];
      if (l.status !== 'APPROVED') reasons.push(l.status === 'PENDING' ? 'Təsdiqlənməyib (gözləmədə)' : 'Rədd edilib');
      if (l.expiresAt && l.expiresAt <= now) reasons.push(`Müddəti bitib (${l.expiresAt.toLocaleDateString('az-AZ')})`);
      // Səbəbi göstərməklə kifayətlənmirik — nə etməli olduğunu da yazırıq.
      if (l.business && l.business.isActive === false) reasons.push(`Biznes deaktivdir: ${l.business.name} — Biznes bölməsindən yenidən təsdiqləyin`);
      if (l.businessObject && l.businessObject.isActive === false) reasons.push(`Obyekt deaktivdir: ${l.businessObject.name} — sahibi obyekti aktiv etməlidir`);
      // Görünür, amma BAŞQA sekmede: ana səhifə default olaraq "Məhsullar"
      // göstərir. Xidmət elanı orada heç vaxt çıxmır — "Xidmətlər"dədir.
      // Bu, nasazlıq deyil, ona görə ayrıca qeyd kimi verilir.
      const note = reasons.length === 0 && l.type === 'SERVICE'
        ? 'Ana səhifədə "Xidmətlər" sekmesindədir — "Məhsullar"da görünmür'
        : null;
      return { ...l, visibility: { visible: reasons.length === 0, reasons, note } };
    });

    res.json({ listings: withVisibility, total, pendingCount, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
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

    // ── SİFARİŞİ OLAN ELAN SİLİNMİR, ARXİVLƏNİR ──
    // `OrderItem.listing` kaskad olduğu üçün elan silinəndə sifarişin məhsul
    // sətirləri də silinirdi: sifariş qalır, içi boşalırdı (maliyyə detalı və
    // ödəniş ekranı boş görünürdü). Satılmış elan yalnız gizlədilir.
    const soldCount = await prisma.orderItem.count({ where: { listingId: listing.id } });
    if (soldCount > 0) {
      const archived = await prisma.listing.update({
        where: { id: listing.id },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });
      res.json({
        success: true, archived: true, orderItems: soldCount, listing: archived,
        message: `Bu elan ${soldCount} sifarişdə keçir — silinmədi, arxivləndi (saytda görünmür, sifariş tarixçəsi qorunur).`,
      });
      return;
    }

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

// ═══════════════════════════════════════════════════════════════════════════
// MALİYYƏ — QRUPLAŞDIRILMIŞ GÖRÜNÜŞ
//
// Düz siyahıda "kim kimə nə satdı" anlaşılmırdı. Burada iyerarxiya var:
//
//   Satıcı (istifadəçi)
//     └ Biznes (VÖEN, yaradan şəxs, ümumi satış)
//         └ Obyekt (filial/mağaza)
//             └ Sifariş → alıcı + məhsullar + qiymət
//
// Hər səviyyədə satış sayı və məbləği. Məhsulun hansı obyektə aid olduğu
// listing.businessObjectId ilə tapılır.
// Qeyd: `/admin/finance/:orderId` marşrutu ilə toqquşmasın deyə ad `finance-tree`.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/admin/finance-tree', requirePermission('finance'), async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    const payStatus = String(req.query.paymentStatus || 'PAID');
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;

    const where: Prisma.OrderWhereInput = {};
    if (payStatus !== 'all') where.paymentStatus = payStatus as any;
    if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    if (q) where.OR = [
      { buyer: { name: { contains: q, mode: 'insensitive' } } },
      { seller: { name: { contains: q, mode: 'insensitive' } } },
      { seller: { phone: { contains: q } } },
    ];

    const orders = await prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 2000,                       // qorunma limiti — çox böyük dövrdə səhifə donmasın
      select: {
        id: true, createdAt: true, total: true, paymentMethod: true, paymentStatus: true, status: true,
        buyer: { select: { id: true, name: true, phone: true } },
        seller: { select: { id: true, name: true, phone: true } },
        items: {
          select: {
            id: true, title: true, quantity: true, price: true,
            listing: { select: { id: true, businessId: true, businessObjectId: true } },
          },
        },
      },
    });

    // Sifarişdəki məhsulların hamısı eyni satıcıya aiddir; biznes/obyekt ilk
    // məhsuldan götürülür (checkout satıcı üzrə bölündüyü üçün eynidir).
    const bizIds = new Set<number>();
    const objIds = new Set<number>();
    for (const o of orders) {
      const l = o.items[0]?.listing;
      if (l?.businessId) bizIds.add(l.businessId);
      if (l?.businessObjectId) objIds.add(l.businessObjectId);
    }
    const [bizzes, objs] = await Promise.all([
      bizIds.size ? prisma.business.findMany({
        where: { id: { in: [...bizIds] } },
        select: {
          id: true, name: true, voen: true, ownerName: true, founderName: true,
          createdAt: true, status: true, isActive: true, phone: true,
          user: { select: { id: true, name: true, phone: true } },   // biznesi YARADAN şəxs
        },
      }) : [],
      objIds.size ? prisma.businessObject.findMany({
        where: { id: { in: [...objIds] } },
        select: { id: true, name: true, address: true, city: true, phone: true, isActive: true, businessId: true },
      }) : [],
    ]);
    const bById = new Map(bizzes.map((b) => [b.id, b]));
    const oById = new Map(objs.map((o) => [o.id, o]));

    // Hesablaşma vəziyyəti — hər sifarişin pulu satıcıya ödənilib, yoxsa yox.
    // Bu, admin maliyyə ekranından birbaşa "ödənildi" işarələyə bilsin deyə lazımdır.
    const ledgers = orders.length ? await prisma.sellerLedger.findMany({
      where: { orderId: { in: orders.map((o) => o.id) } },
      select: { id: true, orderId: true, status: true, netAmount: true, commission: true, availableAt: true, clawbackNeeded: true, heldByPlatform: true },
    }) : [];
    const lByOrder = new Map(ledgers.map((l) => [l.orderId, l]));

    // ── Ağac qur ──
    type Leaf = typeof orders[number];
    const sellers = new Map<number, any>();
    for (const o of orders) {
      if (!o.seller) continue;
      const l = o.items[0]?.listing;
      const bizKey = l?.businessId ?? 0;         // 0 → biznes yoxdur (şəxsi satış)
      const objKey = l?.businessObjectId ?? 0;   // 0 → obyekt təyin edilməyib

      let s = sellers.get(o.seller.id);
      if (!s) {
        s = { id: o.seller.id, name: o.seller.name, phone: o.seller.phone, orders: 0, amount: 0, businesses: new Map() };
        sellers.set(o.seller.id, s);
      }
      s.orders++; s.amount += o.total;

      let b = s.businesses.get(bizKey);
      if (!b) {
        const info = bizKey ? bById.get(bizKey) : null;
        b = {
          id: bizKey || null,
          name: info?.name || 'Şəxsi satış (biznes yoxdur)',
          voen: info?.voen || null, ownerName: info?.ownerName || null, founderName: info?.founderName || null,
          phone: info?.phone || null, status: info?.status || null, isActive: info?.isActive ?? null,
          createdAt: info?.createdAt || null,
          createdBy: info?.user ? { id: info.user.id, name: info.user.name } : null,
          orders: 0, amount: 0, objects: new Map(),
        };
        s.businesses.set(bizKey, b);
      }
      b.orders++; b.amount += o.total;

      let ob = b.objects.get(objKey);
      if (!ob) {
        const info = objKey ? oById.get(objKey) : null;
        ob = {
          id: objKey || null,
          name: info?.name || 'Obyekt təyin edilməyib',
          address: info?.address || null, city: info?.city || null,
          phone: info?.phone || null, isActive: info?.isActive ?? null,
          orders: 0, amount: 0, list: [] as Leaf[],
        };
        b.objects.set(objKey, ob);
      }
      ob.orders++; ob.amount += o.total;
      ob.list.push(o);
    }

    const r2 = (n: number) => Math.round(n * 100) / 100;
    const result = [...sellers.values()]
      .map((s) => ({
        ...s, amount: r2(s.amount),
        businesses: [...s.businesses.values()]
          .map((b: any) => ({
            ...b, amount: r2(b.amount),
            objects: [...b.objects.values()]
              .map((ob: any) => ({
                ...ob, amount: r2(ob.amount),
                list: ob.list.map((o: Leaf) => {
                  const lg = lByOrder.get(o.id);
                  return {
                    id: o.id, createdAt: o.createdAt, total: o.total,
                    paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus, status: o.status,
                    buyer: o.buyer,
                    items: o.items.map((it) => ({ id: it.id, title: it.title, quantity: it.quantity, price: it.price })),
                    // Satıcıya ödəniş vəziyyəti:
                    //   null        → hesablaşma sətri yoxdur (ödənilməmiş sifariş)
                    //   PENDING     → çatdırılmayıb və ya müdafiə pəncərəsi bitməyib
                    //   AVAILABLE   → ÖDƏNİLƏ BİLƏR (seçilib "ödənildi" edilir)
                    //   PAID_OUT    → artıq ödənilib
                    //   REVERSED    → ləğv/qaytarma
                    ledgerId: lg?.id ?? null,
                    ledgerStatus: lg?.status ?? null,
                    net: lg ? Math.round(lg.netAmount * 100) / 100 : null,
                    commission: lg ? Math.round(lg.commission * 100) / 100 : null,
                    payable: !!lg && lg.status === 'AVAILABLE' && lg.heldByPlatform && !lg.clawbackNeeded
                             && (!lg.availableAt || lg.availableAt <= new Date()),
                  };
                }),
              }))
              .sort((x: any, y: any) => y.amount - x.amount),
          }))
          .sort((x: any, y: any) => y.amount - x.amount),
      }))
      .sort((a, b) => b.amount - a.amount);

    res.json({
      success: true,
      sellers: result,
      totals: {
        sellers: result.length,
        orders: orders.length,
        amount: r2(orders.reduce((s, o) => s + o.total, 0)),
        capped: orders.length >= 2000,   // limitə çatdısa istifadəçiyə bildir
      },
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

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
    let refundFailed: string | null = null;
    if (status === 'CANCELLED' && order.status !== 'CANCELLED') {
      for (const item of order.items) {
        try {
          await prisma.listing.update({ where: { id: item.listingId }, data: { stock: { increment: item.quantity } } });
        } catch { /* listing silinmiş ola bilər */ }
      }
      // ALICIYA PULU QAYTAR. Əvvəl bu yox idi: admin paneldən ləğv edilən
      // kart sifarişində pul bizdə qalırdı və heç bir qeyd yaranmırdı
      // (istifadəçi özü ləğv edəndə isə qaytarılırdı).
      const r = await refundOrderSafe(orderId, 'ADMIN');
      if (!r.ok) {
        refundFailed = r.error || 'Qaytarma alınmadı';
        console.error(`[admin] sifariş #${orderId} ləğv edildi, LAKİN pul qaytarılmadı: ${refundFailed}`);
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
    res.json({
      success: true, order: updated,
      ...(refundFailed ? { refundPending: true, refundError: refundFailed, message: 'Sifariş ləğv edildi, lakin ödənişin qaytarılması alınmadı — avtomatik təkrar cəhd ediləcək.' } : {}),
    });
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
      pIdentity,
      revenueAgg, revenueTodayAgg, ordersToday, newUsers7d, activeConsult,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'USER', type: { not: 'COURIER' } } }),
      prisma.user.count({ where: { role: 'USER', isBlocked: true } }),
      prisma.listing.count(),
      prisma.order.count(),
      // Silinmiş bizneslər sayılmır: sətir yalnız maliyyə tarixçəsi üçün qalır.
      // Əvvəl sayılırdı — sidebar-da «1 gözləyir» nişanı çıxırdı, siyahı isə
      // (deletedAt: null süzgəci ilə) boş görünürdü.
      prisma.business.count({ where: { deletedAt: null } }),
      prisma.user.count({ where: { type: 'COURIER' } }),
      prisma.business.count({ where: { status: 'PENDING', deletedAt: null } }),
      prisma.sellerVerification.count({ where: { status: 'PENDING' } }),
      prisma.professionDocument.count({ where: { status: 'PENDING' } }),
      prisma.socialLink.count({ where: { verified: false } }),
      prisma.complaint.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
      prisma.returnRequest.count({ where: { status: 'REQUESTED' } }),
      prisma.listing.count({ where: { status: 'PENDING' } }),
      // Əl ilə kimlik yoxlaması növbəsi (Veriff söndürüləndə dolur).
      prisma.user.count({ where: { idVerifyStatus: 'PENDING', idCardImage: { not: null } } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { paymentStatus: 'PAID' } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { paymentStatus: 'PAID', createdAt: { gte: startOfDay } } }),
      prisma.order.count({ where: { createdAt: { gte: startOfDay } } }),
      prisma.user.count({ where: { role: 'USER', createdAt: { gte: weekAgo } } }),
      prisma.consultationSession.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
    ]);
    const pending = {
      businesses: pBusinesses, sellerApps: pSellerApps, identity: pIdentity,
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
