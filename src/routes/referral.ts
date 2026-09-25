// REFERAL SATIŞ marşrutları. Məntiq: services/referral.ts.
import { Router, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { adminAuth, requirePermission, AuthRequest } from '../middleware/auth';
import { referralLimiter } from '../middleware/rateLimiter';
import { pushLive } from '../services/live';
import {
  AUDIENCES, PRODUCT_SCOPES, DOC_TYPES, getOrCreateProgram, loadProgram, programForListing, listingIncluded,
  eligibility, percentFor, validateLink, referralBalance, createReferralPayout,
} from '../services/referral';

const router = Router();
const prisma = new PrismaClient();
const r2 = (n: number) => Math.round(n * 100) / 100;

async function notify(userId: number, title: string, body: string, link: string) {
  await prisma.notification.create({ data: { userId, type: 'REFERRAL', title, body, link } }).catch(() => {});
  pushLive(userId, { kind: 'notification', toast: title, tone: 'info' });
}

/** Satıcının idarə etdiyi proqram: ?objectId= verilərsə mağaza sahibi yoxlanır, yoxsa fərdi proqram. */
async function myProgram(req: AuthRequest) {
  const raw = req.query.objectId ?? req.body?.objectId;
  const objectId = raw !== undefined && raw !== null && raw !== '' ? parseInt(String(raw)) : null;
  if (objectId) {
    const obj = await prisma.businessObject.findUnique({ where: { id: objectId }, include: { business: { select: { userId: true } } } });
    if (!obj || obj.business.userId !== req.adminId) return null;
    return getOrCreateProgram(req.adminId!, objectId);
  }
  return getOrCreateProgram(req.adminId!, null);
}

function programListingWhere(p: { sellerId: number; objectId: number | null }): Prisma.ListingWhereInput {
  return p.objectId ? { businessObjectId: p.objectId } : { userId: p.sellerId, businessObjectId: null };
}

// ════════════════════ SATICI: PROQRAM ════════════════════

// Mənim proqramlarım (fərdi + hər mağazam) — xülasə.
router.get('/me/referral/programs', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const me = req.adminId!;
    const objects = await prisma.businessObject.findMany({
      where: { business: { userId: me }, deletedAt: null },
      select: { id: true, name: true, city: true, business: { select: { name: true } } },
      orderBy: { id: 'asc' },
    });
    const programs = await prisma.referralProgram.findMany({ where: { sellerId: me } });
    const stats = await prisma.order.groupBy({
      by: ['referralCartId'], where: { sellerId: me, referrerId: { not: null }, status: { not: 'CANCELLED' } },
      _count: { _all: true }, _sum: { referralAmount: true },
    }).catch(() => []);
    void stats;
    const personalCount = await prisma.listing.count({ where: { userId: me, businessObjectId: null } });
    const rows = [
      ...(personalCount ? [{ objectId: null, name: 'Şəxsi elanlarım', city: null, listingCount: personalCount }] : []),
      ...(await Promise.all(objects.map(async (o) => ({ objectId: o.id, name: `${o.name} (${o.business.name})`, city: o.city, listingCount: await prisma.listing.count({ where: { businessObjectId: o.id } }) })))),
    ].map((r) => {
      const p = programs.find((x) => (x.objectId ?? null) === r.objectId);
      return { ...r, programId: p?.id ?? null, enabled: !!p?.enabled, audience: p?.audience ?? null, defaultPercent: p?.defaultPercent ?? null };
    });
    res.json({ success: true, programs: rows });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Proqramın tam məlumatı: ayarlar, qaydalar, partnyorlar (statistika ilə), məhsullar.
router.get('/me/referral/program', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const p = await myProgram(req);
    if (!p) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const [partners, listings, orders] = await Promise.all([
      prisma.referralPartner.findMany({ where: { programId: p.id }, orderBy: { updatedAt: 'desc' } }),
      prisma.listing.findMany({
        where: { ...programListingWhere(p), status: { in: ['APPROVED', 'PENDING'] } },
        select: { id: true, title: true, price: true, images: true, stock: true, status: true, referralMode: true, referralPercent: true },
        orderBy: { createdAt: 'desc' }, take: 300,
      }),
      prisma.order.findMany({
        where: { sellerId: p.sellerId, referrerId: { not: null }, items: { some: { listing: programListingWhere(p) } } },
        select: { id: true, referrerId: true, status: true, total: true, referralAmount: true, referralVoided: true, createdAt: true },
        orderBy: { createdAt: 'desc' }, take: 500,
      }),
    ]);
    // Satan hər kəs (partnyor olsun-olmasın) — statistika.
    const referrerIds = Array.from(new Set([...partners.map((x) => x.userId), ...orders.map((o) => o.referrerId!)]));
    const users = await prisma.user.findMany({ where: { id: { in: referrerIds } }, select: { id: true, name: true, phone: true, profession: true, avatar: true } });
    const statFor = (uid: number) => {
      const mine = orders.filter((o) => o.referrerId === uid);
      const live = mine.filter((o) => o.status !== 'CANCELLED' && !o.referralVoided);
      return {
        orders: live.length,
        delivered: live.filter((o) => o.status === 'DELIVERED').length,
        sales: r2(live.reduce((s, o) => s + o.total, 0)),
        commission: r2(live.reduce((s, o) => s + (o.referralAmount || 0), 0)),
      };
    };
    const sellers = referrerIds.map((uid) => {
      const u = users.find((x) => x.id === uid);
      const partner = partners.find((x) => x.userId === uid) || null;
      return {
        userId: uid, name: u?.name || '—', profession: u?.profession || null, avatar: u?.avatar || null,
        // Telefon yalnız partnyorluq əlaqəsi olanda göstərilir.
        phone: partner && partner.status === 'ACTIVE' ? u?.phone || null : null,
        partner: partner && { id: partner.id, status: partner.status, percent: partner.percent, note: partner.note, updatedAt: partner.updatedAt },
        stats: statFor(uid),
      };
    });
    const links = await prisma.referralCart.findMany({ where: { programId: p.id }, select: { id: true, referrerId: true, active: true, expiresAt: true, clicks: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({
      success: true,
      program: { id: p.id, objectId: p.objectId, enabled: p.enabled, audience: p.audience, productScope: p.productScope, defaultPercent: p.defaultPercent, linkDays: p.linkDays, rules: p.rules },
      listings: listings.map((l) => ({ ...l, image: l.images?.[0] || null, images: undefined, included: listingIncluded({ enabled: true, productScope: p.productScope }, l) })),
      sellers,
      links: links.map((l) => ({ ...l, referrer: users.find((u) => u.id === l.referrerId)?.name || null })),
      totals: {
        orders: orders.filter((o) => o.status !== 'CANCELLED' && !o.referralVoided).length,
        commission: r2(orders.filter((o) => o.status !== 'CANCELLED' && !o.referralVoided).reduce((s, o) => s + (o.referralAmount || 0), 0)),
      },
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Proqram ayarları + ixtisas qaydaları.
router.put('/me/referral/program', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const p = await myProgram(req);
    if (!p) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const b = req.body || {};
    const data: any = {};
    if (b.enabled !== undefined) data.enabled = !!b.enabled;
    if (AUDIENCES.includes(b.audience)) data.audience = b.audience;
    if (PRODUCT_SCOPES.includes(b.productScope)) data.productScope = b.productScope;
    if (b.defaultPercent !== undefined) {
      const v = parseFloat(String(b.defaultPercent));
      if (!Number.isFinite(v) || v < 0 || v > 90) { res.status(400).json({ success: false, message: 'Faiz 0–90 aralığında olmalıdır' }); return; }
      data.defaultPercent = v;
    }
    if (b.linkDays !== undefined) data.linkDays = Math.max(1, Math.min(365, parseInt(String(b.linkDays)) || 30));
    const ops: any[] = [prisma.referralProgram.update({ where: { id: p.id }, data })];
    if (Array.isArray(b.rules)) {
      const rules = b.rules.slice(0, 10).map((r: any) => ({
        profession: String(r.profession || '').trim().slice(0, 80),
        commissionPercent: Math.max(0, Math.min(90, parseFloat(String(r.commissionPercent)) || 0)),
        requiredDoc: DOC_TYPES.includes(r.requiredDoc) ? r.requiredDoc : 'NONE',
      })).filter((r: any) => r.profession && r.commissionPercent > 0);
      ops.push(prisma.referralRule.deleteMany({ where: { programId: p.id } }));
      if (rules.length) ops.push(prisma.referralRule.createMany({ data: rules.map((r: any) => ({ ...r, programId: p.id, objectId: p.objectId })) }));
    }
    await prisma.$transaction(ops);
    // Köhnə sahə (mağaza səhifəsindəki nişan) sinxron qalsın.
    if (p.objectId && data.enabled !== undefined) await prisma.businessObject.update({ where: { id: p.objectId }, data: { referralEnabled: data.enabled } });
    const saved = await loadProgram(p.id);
    res.json({ success: true, program: saved });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Məhsul seçimi: [{listingId, mode: DEFAULT|ON|OFF, percent|null}]
router.put('/me/referral/listings', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const p = await myProgram(req);
    if (!p) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 500) : [];
    const ids = items.map((i: any) => parseInt(String(i.listingId))).filter((n: number) => Number.isFinite(n));
    const owned = new Set((await prisma.listing.findMany({ where: { id: { in: ids }, ...programListingWhere(p) }, select: { id: true } })).map((l) => l.id));
    let updated = 0;
    for (const i of items) {
      const id = parseInt(String(i.listingId));
      if (!owned.has(id)) continue;
      const mode = ['DEFAULT', 'ON', 'OFF'].includes(i.mode) ? i.mode : 'DEFAULT';
      const pct = i.percent === null || i.percent === '' || i.percent === undefined ? null : Math.max(0, Math.min(90, parseFloat(String(i.percent)) || 0));
      await prisma.listing.update({ where: { id }, data: { referralMode: mode, referralPercent: pct } });
      updated++;
    }
    res.json({ success: true, updated });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Partnyor dəvət et — telefon nömrəsi ilə (və ya userId).
router.post('/me/referral/partners', referralLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const p = await myProgram(req);
    if (!p) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    let userId = req.body?.userId ? parseInt(String(req.body.userId)) : NaN;
    if (Number.isNaN(userId) && req.body?.phone) {
      const d9 = String(req.body.phone).replace(/\D/g, '').slice(-9);
      if (d9.length < 9) { res.status(400).json({ success: false, message: 'Nömrəni tam yazın' }); return; }
      const u = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`SELECT id FROM "User" WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = ${d9} LIMIT 1`);
      userId = u[0]?.id ?? NaN;
      if (Number.isNaN(userId)) { res.status(404).json({ success: false, message: 'Bu nömrə ilə istifadəçi tapılmadı — əvvəlcə saytda qeydiyyatdan keçməlidir' }); return; }
    }
    if (Number.isNaN(userId)) { res.status(400).json({ success: false, message: 'Telefon nömrəsi tələb olunur' }); return; }
    if (userId === p.sellerId) { res.status(400).json({ success: false, message: 'Özünüzü dəvət edə bilməzsiniz' }); return; }
    const percent = req.body?.percent !== undefined && req.body.percent !== '' && req.body.percent !== null ? Math.max(0, Math.min(90, parseFloat(String(req.body.percent)) || 0)) : null;
    const existing = await prisma.referralPartner.findUnique({ where: { programId_userId: { programId: p.id, userId } } });
    // Artıq müraciət edibsə dəvət = təsdiq.
    const status = existing?.status === 'REQUESTED' || existing?.status === 'ACTIVE' ? 'ACTIVE' : 'INVITED';
    const partner = await prisma.referralPartner.upsert({
      where: { programId_userId: { programId: p.id, userId } },
      update: { status, percent },
      create: { programId: p.id, userId, status, percent },
    });
    const seller = await prisma.user.findUnique({ where: { id: p.sellerId }, select: { name: true } });
    const store = p.objectId ? (await prisma.businessObject.findUnique({ where: { id: p.objectId }, select: { name: true } }))?.name : null;
    await notify(userId, status === 'ACTIVE' ? 'Referal partnyorluğunuz təsdiqləndi' : 'Referal satış dəvəti',
      `${store || seller?.name || 'Satıcı'} sizi onun məhsullarını komissiya ilə satmağa ${status === 'ACTIVE' ? 'qəbul etdi' : 'dəvət edir'}${percent != null ? ` (${percent}%)` : ''}.`, '/referral');
    res.json({ success: true, partner });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Partnyoru idarə et: approve | reject | revoke | reactivate | percent
router.put('/me/referral/partners/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const partner = await prisma.referralPartner.findUnique({ where: { id: parseInt(String(req.params.id)) }, include: { program: true } });
    if (!partner || partner.program.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const action = String(req.body?.action || '');
    const data: any = {};
    if (req.body?.percent !== undefined) data.percent = req.body.percent === null || req.body.percent === '' ? null : Math.max(0, Math.min(90, parseFloat(String(req.body.percent)) || 0));
    if (req.body?.note !== undefined) data.note = req.body.note ? String(req.body.note).slice(0, 300) : null;
    if (action === 'approve' || action === 'reactivate') data.status = 'ACTIVE';
    else if (action === 'reject') data.status = 'REJECTED';
    else if (action === 'revoke') data.status = 'REVOKED';
    const updated = await prisma.referralPartner.update({ where: { id: partner.id }, data });
    if (data.status === 'REVOKED') {
      // Dayandırılan şəxsin bu proqramdakı linkləri də dayanır.
      await prisma.referralCart.updateMany({ where: { programId: partner.programId, referrerId: partner.userId }, data: { active: false } });
      await notify(partner.userId, 'Referal satış dayandırıldı', 'Satıcı sizin onun məhsullarını referal ilə satmağınızı dayandırdı. Aktiv linkləriniz bağlandı.', '/referral');
    } else if (data.status === 'ACTIVE' && partner.status !== 'ACTIVE') {
      await notify(partner.userId, 'Referal müraciətiniz təsdiqləndi', 'İndi satıcının məhsulları üçün referal link yarada bilərsiniz.', '/referral');
    } else if (data.status === 'REJECTED') {
      await notify(partner.userId, 'Referal müraciətiniz rədd edildi', 'Satıcı müraciətinizi qəbul etmədi.', '/referral');
    }
    res.json({ success: true, partner: updated });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Satıcı konkret linki dayandırır.
router.put('/me/referral/program-links/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const link = await prisma.referralCart.findUnique({ where: { id: parseInt(String(req.params.id)) } });
    if (!link?.programId) { res.status(404).json({ success: false, message: 'Link tapılmadı' }); return; }
    const p = await prisma.referralProgram.findUnique({ where: { id: link.programId } });
    if (!p || p.sellerId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const updated = await prisma.referralCart.update({ where: { id: link.id }, data: { active: !!req.body?.active } });
    res.json({ success: true, link: updated });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Köhnə API (mağaza redaktoru) — proqrama yönləndirilir.
router.get('/me/objects/:id/referral', adminAuth, async (req: AuthRequest, res: Response) => {
  req.query.objectId = String(req.params.id);
  const p = await myProgram(req);
  if (!p) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
  res.json({ success: true, referralEnabled: p.enabled, rules: p.rules, program: p });
});
router.put('/me/objects/:id/referral', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    req.query.objectId = String(req.params.id);
    const p = await myProgram(req);
    if (!p) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const rules = (Array.isArray(req.body.rules) ? req.body.rules : []).slice(0, 10).map((r: any) => ({
      profession: String(r.profession || '').trim(), commissionPercent: Math.max(0, Math.min(90, parseFloat(String(r.commissionPercent)) || 0)),
      requiredDoc: DOC_TYPES.includes(r.requiredDoc) ? r.requiredDoc : 'NONE',
    })).filter((r: any) => r.profession && r.commissionPercent > 0);
    await prisma.$transaction([
      prisma.referralProgram.update({ where: { id: p.id }, data: { enabled: !!req.body.enabled } }),
      prisma.businessObject.update({ where: { id: p.objectId! }, data: { referralEnabled: !!req.body.enabled } }),
      prisma.referralRule.deleteMany({ where: { programId: p.id } }),
      ...(rules.length ? [prisma.referralRule.createMany({ data: rules.map((r: any) => ({ ...r, programId: p.id, objectId: p.objectId })) })] : []),
    ]);
    const saved = await loadProgram(p.id);
    res.json({ success: true, referralEnabled: saved!.enabled, rules: saved!.rules });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ════════════════════ REFERAL SATICI ════════════════════

// Kəşf: sata biləcəyim proqramlar + dəvətlərim + müraciət edə biləcəklərim.
router.get('/referral/stores', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const me = req.adminId!;
    const [programs, myPartners] = await Promise.all([
      prisma.referralProgram.findMany({ where: { enabled: true, sellerId: { not: me } }, include: { rules: true }, take: 300 }),
      prisma.referralPartner.findMany({ where: { userId: me } }),
    ]);
    const objIds = programs.map((p) => p.objectId).filter((x): x is number => !!x);
    const sellerIds = programs.map((p) => p.sellerId);
    const [objs, sellers] = await Promise.all([
      prisma.businessObject.findMany({ where: { id: { in: objIds } }, select: { id: true, name: true, city: true, address: true, isActive: true, deletedAt: true, business: { select: { name: true, isActive: true } } } }),
      prisma.user.findMany({ where: { id: { in: sellerIds } }, select: { id: true, name: true, city: true, avgRating: true } }),
    ]);
    const out: any[] = [];
    for (const p of programs) {
      const o = p.objectId ? objs.find((x) => x.id === p.objectId) : null;
      if (p.objectId && (!o || !o.isActive || o.deletedAt || o.business?.isActive === false)) continue;
      const partner = myPartners.find((x) => x.programId === p.id) || null;
      const el = await eligibility(p, me);
      // INVITED/PROFESSION proqramında uyğun deyilsə — yalnız dəvət/müraciət varsa və ya INVITED-dirsə göstər.
      if (!el.ok && p.audience === 'PROFESSION' && !partner) continue;
      if (partner?.status === 'REVOKED') continue;
      const listingCount = await prisma.listing.count({
        where: {
          ...programListingWhere(p), status: 'APPROVED',
          ...(p.productScope === 'SELECTED' ? { referralMode: 'ON' } : { referralMode: { not: 'OFF' } }),
        },
      });
      if (!listingCount) continue;
      const s = sellers.find((x) => x.id === p.sellerId);
      out.push({
        programId: p.id, objectId: p.objectId, sellerId: p.sellerId,
        name: o ? o.name : s?.name || 'Satıcı', businessName: o?.business?.name || null, city: o?.city || s?.city || null, address: o?.address || null,
        audience: p.audience, eligible: el.ok, reason: el.reason, partnerId: partner?.id ?? null, partnerStatus: partner?.status ?? null,
        percent: el.ok ? (el.partnerPercent ?? el.rulePercent ?? p.defaultPercent) : (p.audience === 'PROFESSION' ? Math.max(...p.rules.map((r) => r.commissionPercent), 0) : p.defaultPercent),
        listingCount,
      });
    }
    out.sort((a, b) => Number(b.eligible) - Number(a.eligible) || (b.percent - a.percent));
    const me2 = await prisma.user.findUnique({ where: { id: me }, select: { profession: true, professions: true } });
    res.json({ success: true, profession: me2?.profession || null, professions: me2?.professions || [], stores: out });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Müraciət: «bu satıcının məhsullarını satmaq istəyirəm».
router.post('/referral/programs/:id/apply', referralLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const p = await prisma.referralProgram.findUnique({ where: { id: parseInt(String(req.params.id)) } });
    if (!p || !p.enabled) { res.status(404).json({ success: false, message: 'Proqram tapılmadı' }); return; }
    if (p.sellerId === req.adminId) { res.status(400).json({ success: false, message: 'Öz proqramınıza müraciət edə bilməzsiniz' }); return; }
    const ex = await prisma.referralPartner.findUnique({ where: { programId_userId: { programId: p.id, userId: req.adminId! } } });
    if (ex?.status === 'REVOKED') { res.status(403).json({ success: false, message: 'Satıcı sizinlə əməkdaşlığı dayandırıb' }); return; }
    if (ex?.status === 'ACTIVE') { res.json({ success: true, partner: ex }); return; }
    if (ex?.status === 'INVITED') {
      const partner = await prisma.referralPartner.update({ where: { id: ex.id }, data: { status: 'ACTIVE' } });
      res.json({ success: true, partner }); return;
    }
    const note = req.body?.note ? String(req.body.note).slice(0, 300) : null;
    const partner = await prisma.referralPartner.upsert({
      where: { programId_userId: { programId: p.id, userId: req.adminId! } },
      update: { status: 'REQUESTED', note }, create: { programId: p.id, userId: req.adminId!, status: 'REQUESTED', note },
    });
    const u = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { name: true, profession: true } });
    await notify(p.sellerId, 'Referal satış müraciəti', `${u?.name || 'İstifadəçi'}${u?.profession ? ` (${u.profession})` : ''} məhsullarınızı komissiya ilə satmaq istəyir.${note ? ` Qeyd: ${note}` : ''}`, `/referral/manage${p.objectId ? `?objectId=${p.objectId}` : ''}`);
    res.json({ success: true, partner });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Dəvəti qəbul et / rədd et.
router.post('/referral/partners/:id/respond', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const partner = await prisma.referralPartner.findUnique({ where: { id: parseInt(String(req.params.id)) }, include: { program: true } });
    if (!partner || partner.userId !== req.adminId) { res.status(404).json({ success: false, message: 'Dəvət tapılmadı' }); return; }
    if (partner.status !== 'INVITED') { res.status(400).json({ success: false, message: 'Bu dəvət artıq cavablandırılıb' }); return; }
    const accept = !!req.body?.accept;
    const updated = await prisma.referralPartner.update({ where: { id: partner.id }, data: { status: accept ? 'ACTIVE' : 'REJECTED' } });
    const u = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { name: true } });
    await notify(partner.program.sellerId, accept ? 'Referal dəvəti qəbul edildi' : 'Referal dəvəti rədd edildi', `${u?.name || 'İstifadəçi'} dəvətinizi ${accept ? 'qəbul etdi' : 'rədd etdi'}.`, `/referral/manage${partner.program.objectId ? `?objectId=${partner.program.objectId}` : ''}`);
    res.json({ success: true, partner: updated });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Məhsul səhifəsi üçün: bu məhsulu referal ilə sata bilərəmmi?
router.get('/listings/:id/referral', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const l = await prisma.listing.findUnique({ where: { id: parseInt(String(req.params.id)) }, select: { id: true, userId: true, businessObjectId: true, referralMode: true, referralPercent: true, status: true } });
    if (!l) { res.status(404).json({ success: false, message: 'Elan tapılmadı' }); return; }
    const p = await programForListing(l);
    if (!p || !listingIncluded(p, l) || l.status !== 'APPROVED') { res.json({ success: true, available: false }); return; }
    const el = await eligibility(p, req.adminId!);
    res.json({ success: true, available: true, programId: p.id, audience: p.audience, eligible: el.ok, reason: el.reason, partnerStatus: el.partnerStatus, percent: el.ok ? percentFor(p, l, el) : null, linkDays: p.linkDays });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Mağaza səhifəsi üçün (köhnə API saxlanılır).
router.get('/objects/:id/referral-eligibility', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const p = await prisma.referralProgram.findUnique({ where: { objectId: parseInt(String(req.params.id)) }, include: { rules: true } });
    if (!p || !p.enabled) { res.json({ success: true, eligible: false, reason: 'Bu mağazada referal satış yoxdur' }); return; }
    const el = await eligibility(p, req.adminId!);
    const included = await prisma.listing.findMany({
      where: { businessObjectId: p.objectId!, status: 'APPROVED', ...(p.productScope === 'SELECTED' ? { referralMode: 'ON' } : { referralMode: { not: 'OFF' } }) },
      select: { id: true },
    });
    res.json({ success: true, programId: p.id, audience: p.audience, eligible: el.ok, reason: el.reason, partnerStatus: el.partnerStatus, commissionPercent: el.ok ? (el.partnerPercent ?? el.rulePercent ?? p.defaultPercent) : null, listingIds: included.map((x) => x.id) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Referal link yarat — bir proqramın (bir satıcının/mağazanın) məhsulları.
router.post('/referral/cart', referralLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const rawItems = Array.isArray(req.body.items) ? req.body.items.slice(0, 30) : [];
    const ids = rawItems.map((i: any) => parseInt(String(i.listingId))).filter((n: number) => Number.isFinite(n));
    if (!ids.length) { res.status(400).json({ success: false, message: 'Ən azı bir məhsul seçin' }); return; }
    const listings = await prisma.listing.findMany({ where: { id: { in: ids } }, select: { id: true, userId: true, businessObjectId: true, businessId: true, referralMode: true, referralPercent: true, status: true, title: true } });
    const first = listings[0];
    if (!first) { res.status(404).json({ success: false, message: 'Məhsul tapılmadı' }); return; }
    const p = await programForListing(first);
    if (!p || !p.enabled) { res.status(400).json({ success: false, message: 'Bu satıcı referal satışa icazə vermir' }); return; }
    const el = await eligibility(p, req.adminId!);
    if (!el.ok) { res.status(403).json({ success: false, message: el.reason }); return; }
    const items: { listingId: number; quantity: number }[] = [];
    const pcts: number[] = [];
    for (const it of rawItems) {
      const l = listings.find((x) => x.id === parseInt(String(it.listingId)));
      if (!l || l.status !== 'APPROVED') continue;
      const same = p.objectId ? l.businessObjectId === p.objectId : (l.userId === p.sellerId && !l.businessObjectId);
      if (!same || !listingIncluded(p, l)) continue;
      items.push({ listingId: l.id, quantity: Math.max(1, Math.min(999, parseInt(String(it.quantity)) || 1)) });
      pcts.push(percentFor(p, l, el));
    }
    if (!items.length) { res.status(400).json({ success: false, message: 'Seçilən məhsullar bu satıcının referal proqramına daxil deyil' }); return; }
    const token = crypto.randomBytes(8).toString('hex');
    const link = await prisma.referralCart.create({
      data: {
        token, referrerId: req.adminId!, programId: p.id, sellerId: p.sellerId, objectId: p.objectId, businessId: first.businessId,
        percent: Math.max(...pcts), items, title: req.body?.title ? String(req.body.title).slice(0, 80) : null,
        expiresAt: new Date(Date.now() + p.linkDays * 24 * 3600 * 1000),
      },
    });
    res.json({ success: true, token, percent: link.percent, expiresAt: link.expiresAt });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Mənim linklərim + statistika.
router.get('/me/referral/links', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const links = await prisma.referralCart.findMany({ where: { referrerId: req.adminId! }, orderBy: { createdAt: 'desc' }, take: 200 });
    const orders = await prisma.order.findMany({ where: { referrerId: req.adminId!, referralCartId: { in: links.map((l) => l.id) } }, select: { referralCartId: true, status: true, referralAmount: true, referralVoided: true } });
    const progIds = Array.from(new Set(links.map((l) => l.programId).filter((x): x is number => !!x)));
    const progs = await prisma.referralProgram.findMany({ where: { id: { in: progIds } }, select: { id: true, objectId: true, sellerId: true } });
    const objs = await prisma.businessObject.findMany({ where: { id: { in: progs.map((x) => x.objectId).filter((x): x is number => !!x) } }, select: { id: true, name: true } });
    const sellers = await prisma.user.findMany({ where: { id: { in: progs.map((x) => x.sellerId) } }, select: { id: true, name: true } });
    const now = new Date();
    res.json({
      success: true,
      links: links.map((l) => {
        const mine = orders.filter((o) => o.referralCartId === l.id && o.status !== 'CANCELLED' && !o.referralVoided);
        const pr = progs.find((x) => x.id === l.programId);
        return {
          id: l.id, token: l.token, title: l.title, percent: l.percent, active: l.active, expiresAt: l.expiresAt, clicks: l.clicks, createdAt: l.createdAt,
          expired: !!(l.expiresAt && l.expiresAt < now), itemCount: ((l.items as any[]) || []).length,
          store: pr?.objectId ? objs.find((o) => o.id === pr.objectId)?.name : sellers.find((s) => s.id === pr?.sellerId)?.name || null,
          orders: mine.length, commission: r2(mine.reduce((s, o) => s + (o.referralAmount || 0), 0)),
        };
      }),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.put('/me/referral/links/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const l = await prisma.referralCart.findUnique({ where: { id: parseInt(String(req.params.id)) } });
    if (!l || l.referrerId !== req.adminId) { res.status(404).json({ success: false, message: 'Link tapılmadı' }); return; }
    const updated = await prisma.referralCart.update({ where: { id: l.id }, data: { active: !!req.body?.active } });
    res.json({ success: true, link: updated });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Qazanc: balans + sifarişlər + ödənişlər + ödəniş hesabı.
router.get('/me/referral-earnings', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const me = req.adminId!;
    const [orders, balance, payouts, ledgers, u] = await Promise.all([
      prisma.order.findMany({
        where: { referrerId: me }, orderBy: { createdAt: 'desc' }, take: 300,
        select: { id: true, total: true, referralPercent: true, referralAmount: true, referralVoided: true, status: true, createdAt: true, deliveredAt: true, seller: { select: { id: true, name: true } } },
      }),
      referralBalance(me),
      prisma.referralPayout.findMany({ where: { referrerId: me }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.referralLedger.findMany({ where: { referrerId: me }, select: { orderId: true, status: true, amount: true, availableAt: true } }),
      prisma.user.findUnique({ where: { id: me }, select: { referralIban: true, referralPayeeName: true, name: true } }),
    ]);
    const inProgress = orders.filter((o) => !['DELIVERED', 'CANCELLED'].includes(o.status) && !o.referralVoided).reduce((s, o) => s + (o.referralAmount || 0), 0);
    res.json({
      success: true,
      balance: { ...balance, inProgress: r2(inProgress) },
      orders: orders.map((o) => ({ ...o, ledger: ledgers.find((l) => l.orderId === o.id) || null })),
      payouts,
      payoutInfo: { iban: u?.referralIban || '', payeeName: u?.referralPayeeName || u?.name || '' },
      // Köhnə frontend üçün.
      confirmedTotal: r2(balance.available + balance.pending + balance.paidOut), pendingTotal: r2(inProgress),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.put('/me/referral-payout-info', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const iban = String(req.body?.iban || '').replace(/\s+/g, '').toUpperCase();
    if (iban && !/^AZ\d{2}[A-Z]{4}[A-Z0-9]{20}$/.test(iban)) { res.status(400).json({ success: false, message: 'IBAN düzgün deyil (AZ + 26 simvol)' }); return; }
    const payeeName = String(req.body?.payeeName || '').trim().slice(0, 120) || null;
    await prisma.user.update({ where: { id: req.adminId! }, data: { referralIban: iban || null, referralPayeeName: payeeName } });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ════════════════════ ALICI ════════════════════

// Linki aç (public). Məhsullar HAZIRKİ vəziyyəti ilə (satışda, stok).
router.get('/referral/:token', async (req, res: Response) => {
  try {
    const token = String(req.params.token);
    const v = await validateLink(token);
    const cart = v.cart || await prisma.referralCart.findUnique({ where: { token } });
    if (!cart) { res.status(404).json({ success: false, message: 'Link tapılmadı' }); return; }
    await prisma.referralCart.update({ where: { id: cart.id }, data: { clicks: { increment: 1 } } }).catch(() => {});
    const referrer = await prisma.user.findUnique({ where: { id: cart.referrerId }, select: { id: true, name: true, profession: true, avatar: true } });
    const store = cart.objectId
      ? await prisma.businessObject.findUnique({ where: { id: cart.objectId }, select: { id: true, name: true, city: true } })
      : cart.sellerId ? await prisma.user.findUnique({ where: { id: cart.sellerId }, select: { id: true, name: true, city: true } }) : null;
    const items = v.ok ? v.items.map(({ percent: _p, ...i }: any) => i) : [];
    const total = r2(items.filter((i: any) => i.available).reduce((s: number, i: any) => s + i.price * i.quantity, 0));
    res.json({
      success: true, token, valid: v.ok, reason: v.ok ? null : v.reason, title: cart.title, expiresAt: cart.expiresAt,
      items, total, referrer, store: store ? { ...store, isObject: !!cart.objectId } : null,
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Linkdəki məhsulları ADİ SƏBƏTƏ at (referal bağlantısı ilə) — ödəniş/çatdırılma adi checkout-da.
async function addLinkToCart(req: AuthRequest, res: Response) {
  try {
    const v = await validateLink(String(req.params.token), req.adminId!);
    if (!v.ok) { res.status(400).json({ success: false, message: v.reason }); return; }
    const pick: number[] | null = Array.isArray(req.body?.listingIds) ? req.body.listingIds.map((x: any) => parseInt(String(x))) : null;
    let cart = await prisma.cart.findUnique({ where: { userId: req.adminId! } });
    if (!cart) cart = await prisma.cart.create({ data: { userId: req.adminId! } });
    let added = 0; const skipped: string[] = [];
    for (const it of v.items) {
      if (pick && !pick.includes(it.listingId)) continue;
      if (!it.available) { skipped.push(`${it.title}: ${it.unavailableReason}`); continue; }
      const existing = await prisma.cartItem.findFirst({ where: { cartId: cart.id, listingId: it.listingId } });
      const qty = Math.min(it.quantity + (existing?.quantity || 0), it.stock);
      if (existing) await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity: qty, referralCartId: v.cart.id } });
      else await prisma.cartItem.create({ data: { cartId: cart.id, listingId: it.listingId, quantity: Math.min(it.quantity, it.stock), referralCartId: v.cart.id } });
      added++;
    }
    if (!added) { res.status(400).json({ success: false, message: skipped.length ? `Heç bir məhsul əlavə olunmadı — ${skipped.join('; ')}` : 'Məhsul seçin' }); return; }
    res.json({ success: true, added, skipped, redirect: '/cart' });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
}
router.post('/referral/:token/add-to-cart', referralLimiter, adminAuth, addLinkToCart);
// Köhnə «nağd sifariş» düyməsi — indi səbətə yönləndirir.
router.post('/referral/:token/checkout', referralLimiter, adminAuth, addLinkToCart);

// ════════════════════ ADMİN: REFERAL ÖDƏNİŞLƏRİ ════════════════════

router.get('/admin/referral/payables', requirePermission('finance_payouts'), async (_req: AuthRequest, res: Response) => {
  try {
    const grouped = await prisma.referralLedger.groupBy({ by: ['referrerId', 'status'], _sum: { amount: true }, _count: { _all: true } });
    const ids = Array.from(new Set(grouped.map((g) => g.referrerId)));
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true, referralIban: true, referralPayeeName: true } });
    const clawbacks = await prisma.referralLedger.findMany({ where: { clawbackNeeded: true }, select: { orderId: true, referrerId: true, amount: true } });
    const cashDue = await prisma.referralLedger.groupBy({ by: ['sellerId'], where: { heldByPlatform: false, status: { not: 'REVERSED' } }, _sum: { amount: true } });
    const sellerUsers = await prisma.user.findMany({ where: { id: { in: cashDue.map((c) => c.sellerId) } }, select: { id: true, name: true, phone: true } });
    res.json({
      success: true,
      referrers: ids.map((id) => {
        const u = users.find((x) => x.id === id);
        const sum = (st: string) => r2(grouped.filter((g) => g.referrerId === id && g.status === st).reduce((s, g) => s + (g._sum.amount || 0), 0));
        return { referrerId: id, name: u?.name, phone: u?.phone, iban: u?.referralIban || null, payeeName: u?.referralPayeeName || null, available: sum('AVAILABLE'), pending: sum('PENDING'), paidOut: sum('PAID_OUT') };
      }).sort((a, b) => b.available - a.available),
      clawbacks,
      // Nağd referal satışlarında satıcıların platformaya borcu (komissiya onların əlindədir).
      sellersOwe: cashDue.map((c) => ({ sellerId: c.sellerId, name: sellerUsers.find((u) => u.id === c.sellerId)?.name, phone: sellerUsers.find((u) => u.id === c.sellerId)?.phone, amount: r2(c._sum.amount || 0) })).filter((x) => x.amount > 0),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.post('/admin/referral/payouts', requirePermission('finance_payouts'), async (req: AuthRequest, res: Response) => {
  try {
    const referrerId = parseInt(String(req.body?.referrerId));
    if (Number.isNaN(referrerId)) { res.status(400).json({ success: false, message: 'referrerId tələb olunur' }); return; }
    const payout = await createReferralPayout(referrerId, req.adminId!, req.adminName || 'Admin',
      req.body?.method ? String(req.body.method).slice(0, 40) : undefined, req.body?.reference ? String(req.body.reference).slice(0, 200) : undefined);
    res.json({ success: true, payout });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.get('/admin/referral/payouts', requirePermission('finance_payouts'), async (_req: AuthRequest, res: Response) => {
  try {
    const payouts = await prisma.referralPayout.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    const users = await prisma.user.findMany({ where: { id: { in: payouts.map((p) => p.referrerId) } }, select: { id: true, name: true } });
    res.json({ success: true, payouts: payouts.map((p) => ({ ...p, referrerName: users.find((u) => u.id === p.referrerId)?.name || null })) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
