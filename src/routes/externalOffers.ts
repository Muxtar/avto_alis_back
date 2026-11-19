// KƏNAR ELANA TƏKLİF — internet axtarışında tapılan elana (tap.az, turbo.az, bina.az,
// lalafo.az) qiymət təklifi.
//
// Axın:
//   1) Alıcı kartdakı «Təklif göndər»i basır → POST /external-offers.
//      Nömrə YALNIZ bu anda və yalnız bu elan üçün axtarılır (services/externalPhone).
//   2) Nömrə saytda qeydiyyatlıdırsa — təklif ona dərhal çatır (bildiriş).
//      Deyilsə — admin panelinə düşür: admin nömrəni (lazımsa) daxil edir və satıcıya
//      SMS / WhatsApp ilə BİR dəfə xəbər verir.
//   3) Satıcı həmin nömrə ilə qeydiyyatdan keçəndə təkliflər «Təkliflər» səhifəsində
//      görünür (GET /me/external-offers → received).
//
// Sui-istifadəyə qarşı: alıcı gündə 10 təklif; eyni elana bir təklif; eyni nömrəyə eyni
// elan üçün bir xəbər; «bir daha yazmayın» siyahısı (PhoneOptOut). Nömrə alıcıya heç
// vaxt qaytarılmır.
import { Router, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { adminAuth, requirePermission, AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { lookupListingPhone, normalizeAzPhone, normalizeListingUrl, phoneKeyOf, siteOfUrl } from '../services/externalPhone';
import { sendSmsText, isSmsConfigured } from '../services/infobipSms';

const router = Router();
const prisma = new PrismaClient();

const offerLimiter = rateLimit(20, 60 * 60 * 1000);   // IP üzrə
const MAX_PER_DAY = 10;                               // istifadəçi üzrə
const SITE = (process.env.FRONTEND_URL || 'https://tradixai.io').replace(/\/$/, '');
const SITE_LABEL = SITE.replace(/^https?:\/\//, '');

/** Nömrə saytda qeydiyyatlıdırmı (son 9 rəqəm). */
async function userByPhoneKey(key: string): Promise<{ id: number; name: string } | null> {
  if (key.length !== 9) return null;
  const rows = await prisma.$queryRaw<{ id: number; name: string }[]>(
    Prisma.sql`SELECT id, name FROM "User"
               WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = ${key} AND type != 'COURIER' LIMIT 1`,
  );
  return rows[0] || null;
}

const money = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** Satıcıya gedəcək mətn — reklam yox, konkret fakt + imtina imkanı. */
function outgoingText(o: { listingTitle: string; listingSite: string; offerPrice: number }): string {
  const title = o.listingTitle.length > 60 ? o.listingTitle.slice(0, 57) + '…' : o.listingTitle;
  return `Salam! ${o.listingSite} saytındakı "${title}" elanınıza ${SITE_LABEL} üzərindən ${money(o.offerPrice)} AZN təklif gəldi. `
    + `Baxmaq və cavab vermək üçün bu nömrə ilə daxil olun: ${SITE}/offers\n`
    + `Belə mesaj almaq istəmirsinizsə "STOP" yazın.`;
}

/**
 * Nömrə məlum olanda təklifin vəziyyətini təyin edir:
 *  • imtina edib → REJECTED
 *  • saytda qeydiyyatlıdır → SENT (site) + bildiriş
 *  • bu elan üçün həmin nömrəyə artıq yazılıb → SENT (covered) — ikinci mesaj getmir
 *  • əks halda PENDING (admin xəbər verməlidir)
 */
async function settle(offerId: number): Promise<void> {
  const o = await prisma.externalOffer.findUnique({ where: { id: offerId } });
  if (!o || o.status !== 'PENDING' || !o.phoneKey) return;
  if (await prisma.phoneOptOut.findUnique({ where: { phoneKey: o.phoneKey } })) {
    await prisma.externalOffer.update({ where: { id: o.id }, data: { status: 'REJECTED', adminNote: 'Nömrə sahibi mesaj almaqdan imtina edib' } });
    return;
  }
  const user = await userByPhoneKey(o.phoneKey);
  if (user) {
    await prisma.externalOffer.update({ where: { id: o.id }, data: { status: 'SENT', sentVia: 'site', sentAt: new Date() } });
    await prisma.notification.create({
      data: {
        userId: user.id, type: 'SYSTEM', title: 'Elanınıza təklif gəldi',
        body: `${o.listingSite} saytındakı "${o.listingTitle.slice(0, 80)}" elanınıza ${money(o.offerPrice)} AZN təklif edildi.`,
        link: '/offers?tab=external',
      },
    }).catch(() => {});
    return;
  }
  const already = await prisma.externalOffer.findFirst({
    where: { id: { not: o.id }, phoneKey: o.phoneKey, listingUrl: o.listingUrl, status: 'SENT', sentVia: { in: ['whatsapp', 'sms', 'other'] } },
    select: { id: true },
  });
  if (already) {
    await prisma.externalOffer.update({ where: { id: o.id }, data: { status: 'SENT', sentVia: 'covered', sentAt: new Date(), adminNote: 'Bu elan üçün satıcıya artıq xəbər verilib' } });
  }
}

// ── Alıcı: təklif göndər ─────────────────────────────────────────────────────
router.post('/external-offers', offerLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const url = normalizeListingUrl(String(req.body?.url || '').trim());
    if (!url) { res.status(400).json({ success: false, message: 'Bu elana təklif göndərmək mümkün deyil' }); return; }
    const title = String(req.body?.title || '').trim().slice(0, 200);
    if (title.length < 2) { res.status(400).json({ success: false, message: 'Elanın adı tapılmadı' }); return; }
    const offerPrice = Number(req.body?.offerPrice);
    if (!Number.isFinite(offerPrice) || offerPrice <= 0 || offerPrice > 100_000_000) {
      res.status(400).json({ success: false, message: 'Təklif qiymətini düzgün yazın' }); return;
    }
    const note = String(req.body?.note || '').trim().slice(0, 500) || null;
    const listingPrice = Number(req.body?.price);
    const image = String(req.body?.image || '').trim();

    const me = req.adminId!;
    const dup = await prisma.externalOffer.findFirst({ where: { buyerId: me, listingUrl: url, status: { in: ['PENDING', 'SENT'] } }, select: { id: true } });
    if (dup) { res.status(400).json({ success: false, message: 'Bu elana artıq təklif göndərmisiniz' }); return; }
    const today = await prisma.externalOffer.count({ where: { buyerId: me, createdAt: { gt: new Date(Date.now() - 24 * 3600 * 1000) } } });
    if (today >= MAX_PER_DAY) { res.status(429).json({ success: false, message: `Gündə ən çox ${MAX_PER_DAY} təklif göndərmək olar` }); return; }

    // Nömrə yalnız İNDİ, yalnız bu elan üçün axtarılır (açıq yazıldığı saytlarda).
    const phone = await lookupListingPhone(url).catch(() => null);
    const phoneKey = phone ? phoneKeyOf(phone) : null;

    if (phoneKey) {
      const self = await prisma.user.findUnique({ where: { id: me }, select: { phone: true } });
      if (phoneKeyOf(self?.phone) === phoneKey) { res.status(400).json({ success: false, message: 'Bu sizin öz elanınızdır' }); return; }
      if (await prisma.phoneOptOut.findUnique({ where: { phoneKey } })) {
        res.status(400).json({ success: false, message: 'Bu elanın sahibi sayt üzərindən təklif almaqdan imtina edib' }); return;
      }
    }

    const offer = await prisma.externalOffer.create({
      data: {
        buyerId: me, listingUrl: url, listingSite: siteOfUrl(url), listingTitle: title,
        listingImage: /^https?:\/\//i.test(image) ? image.slice(0, 600) : null,
        listingPrice: Number.isFinite(listingPrice) && listingPrice > 0 ? listingPrice : null,
        listingCurrency: req.body?.currency ? String(req.body.currency).slice(0, 5) : null,
        offerPrice, note, phone, phoneKey, phoneSource: phone ? 'auto' : null,
      },
    });
    await settle(offer.id);
    const fresh = await prisma.externalOffer.findUnique({ where: { id: offer.id }, select: { id: true, status: true, sentVia: true } });
    res.json({
      success: true, offer: fresh,
      // Alıcıya nömrə QAYTARILMIR — yalnız nə baş verdiyi.
      message: fresh?.sentVia === 'site'
        ? 'Təklifiniz satıcıya çatdırıldı — o, saytımızdadır.'
        : 'Təklifiniz qəbul edildi. Satıcıya xəbər veriləcək; cavab yazanda sizə bildiriş gələcək.',
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Mənim kənar təkliflərim: göndərdiklərim + mənə gələnlər ──────────────────
router.get('/me/external-offers', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const me = req.adminId!;
    const user = await prisma.user.findUnique({ where: { id: me }, select: { phone: true } });
    const myKey = phoneKeyOf(user?.phone);
    const pub = {
      id: true, listingUrl: true, listingSite: true, listingTitle: true, listingImage: true,
      listingPrice: true, listingCurrency: true, offerPrice: true, note: true, status: true, sentVia: true, createdAt: true,
    } as const;
    const [sent, received] = await Promise.all([
      prisma.externalOffer.findMany({ where: { buyerId: me }, orderBy: { createdAt: 'desc' }, take: 100, select: pub }),
      // Mənim (OTP ilə təsdiqlənmiş) nömrəmə bağlanmış təkliflər — qeydiyyatdan əvvəl gələnlər də.
      myKey.length === 9
        ? prisma.externalOffer.findMany({
            where: { phoneKey: myKey, status: { not: 'REJECTED' }, buyerId: { not: me } },
            orderBy: { createdAt: 'desc' }, take: 100,
            select: { ...pub, buyer: { select: { id: true, name: true, avatar: true } } },
          })
        : Promise.resolve([]),
    ]);
    res.json({ success: true, sent, received });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Admin ────────────────────────────────────────────────────────────────────
router.get('/admin/external-offers', requirePermission('outreach'), async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const where = ['PENDING', 'SENT', 'REJECTED'].includes(status) ? { status } : {};
    const rows = await prisma.externalOffer.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 200,
      include: { buyer: { select: { id: true, name: true, phone: true } } },
    });
    const pending = await prisma.externalOffer.count({ where: { status: 'PENDING' } });
    res.json({
      success: true, pending, smsConfigured: isSmsConfigured(),
      items: rows.map((o) => ({
        ...o,
        text: outgoingText(o),
        // WhatsApp-da hazır mətnlə açılan link (admin öz hesabından göndərir).
        waLink: o.phone ? `https://wa.me/${o.phone.replace(/\D/g, '')}?text=${encodeURIComponent(outgoingText(o))}` : null,
      })),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

async function pendingOffer(req: AuthRequest, res: Response) {
  const id = parseInt(String(req.params.id));
  const o = await prisma.externalOffer.findUnique({ where: { id } });
  if (!o) { res.status(404).json({ success: false, message: 'Tapılmadı' }); return null; }
  if (o.status !== 'PENDING') { res.status(400).json({ success: false, message: 'Bu təklif artıq bağlanıb' }); return null; }
  return o;
}

// Admin: nömrəni daxil et / düzəlt (tap.az, bina.az — nömrə klik arxasındadır).
router.put('/admin/external-offers/:id/phone', requirePermission('outreach'), async (req: AuthRequest, res: Response) => {
  try {
    const o = await pendingOffer(req, res); if (!o) return;
    const phone = normalizeAzPhone(String(req.body?.phone || ''));
    if (!phone) { res.status(400).json({ success: false, message: 'Mobil nömrəni düzgün yazın (məs. 050 123 45 67)' }); return; }
    await prisma.externalOffer.update({ where: { id: o.id }, data: { phone, phoneKey: phoneKeyOf(phone), phoneSource: 'admin' } });
    await settle(o.id);
    const fresh = await prisma.externalOffer.findUnique({ where: { id: o.id }, select: { status: true, sentVia: true, adminNote: true } });
    res.json({ success: true, ...fresh });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

async function markSent(o: { id: number; buyerId: number; listingTitle: string }, via: string, req: AuthRequest, note: string | null) {
  await prisma.externalOffer.update({
    where: { id: o.id },
    data: { status: 'SENT', sentVia: via, adminNote: note, sentById: req.adminId!, sentByName: req.adminName || 'Admin', sentAt: new Date() },
  });
  await prisma.notification.create({
    data: {
      userId: o.buyerId, type: 'SYSTEM', title: 'Təklifiniz satıcıya çatdırıldı',
      body: `"${o.listingTitle.slice(0, 80)}" elanının sahibinə təklifiniz barədə xəbər verildi.`,
      link: '/offers?tab=external',
    },
  }).catch(() => {});
}

// Admin: SMS ilə göndər (Infobip) — uğurlu olsa «göndərildi».
router.post('/admin/external-offers/:id/sms', requirePermission('outreach'), async (req: AuthRequest, res: Response) => {
  try {
    const o = await pendingOffer(req, res); if (!o) return;
    if (!o.phone || !o.phoneKey) { res.status(400).json({ success: false, message: 'Əvvəlcə nömrəni daxil edin' }); return; }
    if (await prisma.phoneOptOut.findUnique({ where: { phoneKey: o.phoneKey } })) { res.status(400).json({ success: false, message: 'Bu nömrə mesaj almaqdan imtina edib' }); return; }
    const r = await sendSmsText(o.phone, outgoingText(o));
    if (!r.ok) { res.status(400).json({ success: false, message: `SMS göndərilmədi: ${r.detail || r.error || 'xəta'}` }); return; }
    await markSent(o, 'sms', req, null);
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Admin: əl ilə göndərdim (WhatsApp və s.) → «göndərildi».
router.post('/admin/external-offers/:id/sent', requirePermission('outreach'), async (req: AuthRequest, res: Response) => {
  try {
    const o = await pendingOffer(req, res); if (!o) return;
    if (!o.phoneKey) { res.status(400).json({ success: false, message: 'Əvvəlcə nömrəni daxil edin' }); return; }
    const via = ['whatsapp', 'sms', 'other'].includes(String(req.body?.via)) ? String(req.body.via) : 'whatsapp';
    await markSent(o, via, req, String(req.body?.adminNote || '').trim().slice(0, 500) || null);
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Admin: rədd et (spam / uyğunsuz / nömrə tapılmadı).
router.post('/admin/external-offers/:id/reject', requirePermission('outreach'), async (req: AuthRequest, res: Response) => {
  try {
    const o = await pendingOffer(req, res); if (!o) return;
    const note = String(req.body?.adminNote || '').trim().slice(0, 500) || 'Satıcıya çatdırmaq mümkün olmadı';
    await prisma.externalOffer.update({ where: { id: o.id }, data: { status: 'REJECTED', adminNote: note, sentById: req.adminId!, sentByName: req.adminName || 'Admin' } });
    await prisma.notification.create({
      data: { userId: o.buyerId, type: 'SYSTEM', title: 'Təklifiniz çatdırılmadı', body: `"${o.listingTitle.slice(0, 80)}": ${note}`, link: '/offers?tab=external' },
    }).catch(() => {});
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Admin: nömrə sahibi «bir daha yazmayın» dedi → imtina siyahısı; gözləyən təklifləri bağlanır.
router.post('/admin/external-offers/optout', requirePermission('outreach'), async (req: AuthRequest, res: Response) => {
  try {
    const key = phoneKeyOf(String(req.body?.phone || ''));
    if (key.length !== 9) { res.status(400).json({ success: false, message: 'Nömrəni düzgün yazın' }); return; }
    await prisma.phoneOptOut.upsert({ where: { phoneKey: key }, create: { phoneKey: key, note: String(req.body?.note || '').slice(0, 200) || null }, update: {} });
    const closed = await prisma.externalOffer.updateMany({
      where: { phoneKey: key, status: 'PENDING' },
      data: { status: 'REJECTED', adminNote: 'Nömrə sahibi mesaj almaqdan imtina edib' },
    });
    res.json({ success: true, closed: closed.count });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
