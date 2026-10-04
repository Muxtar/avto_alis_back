// İXTİSAS ENDİRİMİ marşrutları. Məntiq: services/professionDiscount.ts.
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest, viewerIdFromReq } from '../middleware/auth';
import { activeRules, listingProDiscountInfo, normProf, PRO_DISCOUNT_MAX, verifiedProfessions, buyerProfessions, ruleApplies } from '../services/professionDiscount';
import { getOrCreateProgram, eligibility, DOC_TYPES } from '../services/referral';

const router = Router();
const prisma = new PrismaClient();
const r2 = (n: number) => Math.round(n * 100) / 100;
const MAX_RULES = 20;

/** Obyekt bu istifadəçiyə məxsusdurmu (biznes sahibi). */
async function ownObject(objectId: number, userId: number) {
  const o = await prisma.businessObject.findUnique({ where: { id: objectId }, select: { id: true, name: true, deletedAt: true, business: { select: { userId: true, status: true, isActive: true } } } });
  return o && !o.deletedAt && o.business.userId === userId ? o : null;
}

// Mağaza sahibi: qaydalar + obyektin məhsulları + statistika.
router.get('/me/objects/:id/pro-discounts', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const obj = await ownObject(id, req.adminId!);
    if (!obj) { res.status(403).json({ success: false, message: 'Bu mağaza sizə aid deyil' }); return; }
    const [rules, listings, stats] = await Promise.all([
      prisma.professionDiscount.findMany({ where: { businessObjectId: id }, orderBy: { percent: 'desc' } }),
      prisma.listing.findMany({ where: { businessObjectId: id, status: 'APPROVED', archivedAt: null }, select: { id: true, title: true, price: true, images: true }, orderBy: { createdAt: 'desc' }, take: 300 }),
      prisma.orderItem.findMany({
        where: { proDiscountAmount: { gt: 0 }, listing: { businessObjectId: id }, order: { status: { notIn: ['CANCELLED'] } } },
        select: { proDiscountAmount: true, proDiscountProfession: true, orderId: true },
      }),
    ]);
    const byProf: Record<string, { orders: number; amount: number }> = {};
    const orderSet = new Set<number>();
    for (const s of stats) {
      const k = s.proDiscountProfession || '—';
      byProf[k] = byProf[k] || { orders: 0, amount: 0 };
      byProf[k].amount = r2(byProf[k].amount + (s.proDiscountAmount || 0));
      byProf[k].orders += 1; orderSet.add(s.orderId);
    }
    res.json({
      success: true, object: { id: obj.id, name: obj.name, businessApproved: obj.business.status === 'APPROVED' && obj.business.isActive },
      rules, listings, maxPercent: PRO_DISCOUNT_MAX,
      stats: { orders: orderSet.size, totalDiscount: r2(stats.reduce((a, s) => a + (s.proDiscountAmount || 0), 0)), byProfession: byProf },
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Mağaza sahibi: qaydaları saxla (tam siyahı — göndərilməyənlər silinir).
router.put('/me/objects/:id/pro-discounts', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const obj = await ownObject(id, req.adminId!);
    if (!obj) { res.status(403).json({ success: false, message: 'Bu mağaza sizə aid deyil' }); return; }
    const raw: any[] = Array.isArray(req.body?.rules) ? req.body.rules : [];
    if (raw.length > MAX_RULES) { res.status(400).json({ success: false, message: `Ən çox ${MAX_RULES} ixtisas qaydası` }); return; }
    const own = new Set((await prisma.listing.findMany({ where: { businessObjectId: id }, select: { id: true } })).map((l) => l.id));
    const seen = new Set<string>();
    const clean: any[] = [];
    for (const r of raw) {
      const profession = String(r.profession || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!profession) { res.status(400).json({ success: false, message: 'Hər qayda üçün ixtisas seçin' }); return; }
      if (seen.has(normProf(profession))) { res.status(400).json({ success: false, message: `«${profession}» iki dəfə yazılıb` }); return; }
      seen.add(normProf(profession));
      const percent = r2(parseFloat(String(r.percent)));
      if (!Number.isFinite(percent) || percent < 1 || percent > PRO_DISCOUNT_MAX) { res.status(400).json({ success: false, message: `«${profession}»: endirim 1–${PRO_DISCOUNT_MAX}% arası olmalıdır` }); return; }
      const scope = r.scope === 'SELECTED' ? 'SELECTED' : 'ALL';
      const listingIds = scope === 'SELECTED' ? Array.from(new Set((Array.isArray(r.listingIds) ? r.listingIds : []).map((x: any) => parseInt(String(x))).filter((x: number) => own.has(x)))) : [];
      if (scope === 'SELECTED' && !listingIds.length) { res.status(400).json({ success: false, message: `«${profession}»: endirim veriləcək məhsulları seçin` }); return; }
      const maxU = r.maxUnitsPerOrder ? parseInt(String(r.maxUnitsPerOrder)) : null;
      const maxD = r.maxDiscountPerOrder ? r2(parseFloat(String(r.maxDiscountPerOrder))) : null;
      const until = r.validUntil ? new Date(r.validUntil) : null;
      clean.push({
        profession, percent, scope, listingIds,
        maxUnitsPerOrder: maxU && maxU > 0 ? Math.min(maxU, 999) : null,
        maxDiscountPerOrder: maxD && maxD > 0 ? maxD : null,
        active: r.active !== false,
        requireDoc: r.requireDoc === true,
        validUntil: until && !isNaN(until.getTime()) ? until : null,
      });
    }
    await prisma.$transaction([
      prisma.professionDiscount.deleteMany({ where: { businessObjectId: id } }),
      ...clean.map((c) => prisma.professionDiscount.create({ data: { businessObjectId: id, ...c } })),
    ]);
    const rules = await prisma.professionDiscount.findMany({ where: { businessObjectId: id }, orderBy: { percent: 'desc' } });
    res.json({ success: true, rules });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── İXTİSAS GÜZƏŞTLƏRİ (obyekt səviyyəsində, bir yerdə) ──────────────────────
// Bir ixtisas üçün İKİ güzəşt: ALANDA endirim (ProfessionDiscount) və SATANDA
// komissiya (ReferralRule). Əvvəl bunlar iki ayrı səhifədə qurulurdu və eyni
// ixtisas iki yerdə ayrıca yazılırdı; obyekt əlavə edəndə isə heç soruşulmurdu.
// Bu ünvan ikisini bir sətirdə oxuyub-yazır (obyekt forması bunu işlədir).
// Ətraflı ayarlar (endirimin məhsul seçimi / limitləri, referal partnyorları)
// öz səhifələrində qalır və burada saxlananda pozulmur.
router.get('/me/objects/:id/profession-terms', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const obj = await ownObject(id, req.adminId!);
    if (!obj) { res.status(403).json({ success: false, message: 'Bu mağaza sizə aid deyil' }); return; }
    const [discounts, program] = await Promise.all([
      prisma.professionDiscount.findMany({ where: { businessObjectId: id } }),
      prisma.referralProgram.findUnique({ where: { objectId: id }, include: { rules: { orderBy: { id: 'asc' } } } }),
    ]);
    const map = new Map<string, { profession: string; discountPercent: number | null; discountRequiresDoc: boolean; commissionPercent: number | null; requiredDoc: string }>();
    for (const d of discounts) map.set(normProf(d.profession), { profession: d.profession, discountPercent: d.active ? d.percent : null, discountRequiresDoc: d.requireDoc, commissionPercent: null, requiredDoc: 'DIPLOMA' });
    for (const r of program?.rules || []) {
      const k = normProf(r.profession);
      const cur = map.get(k) || { profession: r.profession, discountPercent: null, discountRequiresDoc: false, commissionPercent: null, requiredDoc: 'DIPLOMA' };
      cur.commissionPercent = r.commissionPercent; cur.requiredDoc = r.requiredDoc;
      map.set(k, cur);
    }
    res.json({
      success: true,
      terms: Array.from(map.values()).filter((t) => t.discountPercent != null || t.commissionPercent != null),
      referral: { enabled: !!program?.enabled, audience: program?.audience || 'PROFESSION' },
      maxDiscount: PRO_DISCOUNT_MAX,
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.put('/me/objects/:id/profession-terms', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const obj = await ownObject(id, req.adminId!);
    if (!obj) { res.status(403).json({ success: false, message: 'Bu mağaza sizə aid deyil' }); return; }
    const raw: any[] = Array.isArray(req.body?.terms) ? req.body.terms : [];
    if (raw.length > MAX_RULES) { res.status(400).json({ success: false, message: `Ən çox ${MAX_RULES} ixtisas` }); return; }
    const pct = (v: any) => (v === null || v === undefined || v === '' ? null : r2(parseFloat(String(v).replace(',', '.'))));
    const seen = new Set<string>();
    const clean: { profession: string; discount: number | null; discountDoc: boolean; commission: number | null; requiredDoc: string }[] = [];
    for (const t of raw) {
      const profession = String(t.profession || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!profession) { res.status(400).json({ success: false, message: 'Hər sətir üçün ixtisas seçin' }); return; }
      if (seen.has(normProf(profession))) { res.status(400).json({ success: false, message: `«${profession}» iki dəfə yazılıb` }); return; }
      seen.add(normProf(profession));
      const discount = pct(t.discountPercent);
      const commission = pct(t.commissionPercent);
      if (discount != null && (!Number.isFinite(discount) || discount < 1 || discount > PRO_DISCOUNT_MAX)) { res.status(400).json({ success: false, message: `«${profession}»: alış endirimi 1–${PRO_DISCOUNT_MAX}% arası olmalıdır` }); return; }
      if (commission != null && (!Number.isFinite(commission) || commission <= 0 || commission > 90)) { res.status(400).json({ success: false, message: `«${profession}»: satış komissiyası 0-dan böyük, 90%-dən çox olmamalıdır` }); return; }
      if (discount == null && commission == null) { res.status(400).json({ success: false, message: `«${profession}»: endirim və ya komissiya faizindən ən azı birini yazın` }); return; }
      clean.push({ profession, discount, discountDoc: t.discountRequiresDoc === true, commission, requiredDoc: DOC_TYPES.includes(t.requiredDoc) ? t.requiredDoc : 'DIPLOMA' });
    }

    // ALIŞ ENDİRİMİ: mövcud qaydanın əlavə ayarları (məhsul seçimi, limitlər,
    // son tarix) saxlanır — yalnız faiz yenilənir; siyahıdan çıxan ixtisas silinir.
    const existing = await prisma.professionDiscount.findMany({ where: { businessObjectId: id } });
    const ops: any[] = [];
    const keep = new Set<number>();
    for (const c of clean) {
      if (c.discount == null) continue;
      const old = existing.find((e) => normProf(e.profession) === normProf(c.profession));
      if (old) { keep.add(old.id); ops.push(prisma.professionDiscount.update({ where: { id: old.id }, data: { percent: c.discount, active: true, profession: c.profession, requireDoc: c.discountDoc } })); }
      else ops.push(prisma.professionDiscount.create({ data: { businessObjectId: id, profession: c.profession, percent: c.discount, requireDoc: c.discountDoc } }));
    }
    const drop = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
    if (drop.length) ops.unshift(prisma.professionDiscount.deleteMany({ where: { id: { in: drop } } }));

    // SATIŞ KOMİSSİYASI: obyektin referal proqramının ixtisas qaydaları.
    const program = await getOrCreateProgram(req.adminId!, id);
    const rules = clean.filter((c) => c.commission != null);
    ops.push(prisma.referralRule.deleteMany({ where: { programId: program.id } }));
    if (rules.length) {
      ops.push(prisma.referralRule.createMany({ data: rules.map((c) => ({ programId: program.id, objectId: id, profession: c.profession, commissionPercent: c.commission!, requiredDoc: c.requiredDoc })) }));
      // Komissiya yazılıbsa proqram «ixtisasa görə» rejimində açılır.
      ops.push(prisma.referralProgram.update({ where: { id: program.id }, data: { enabled: true, audience: 'PROFESSION' } }));
      ops.push(prisma.businessObject.update({ where: { id }, data: { referralEnabled: true } }));
    } else if (program.audience === 'PROFESSION' && program.enabled) {
      // İxtisas qaydası qalmadı — «ixtisasa görə» proqramın satacaq kimsəsi yoxdur.
      ops.push(prisma.referralProgram.update({ where: { id: program.id }, data: { enabled: false } }));
      ops.push(prisma.businessObject.update({ where: { id }, data: { referralEnabled: false } }));
    }
    await prisma.$transaction(ops);
    res.json({ success: true, count: clean.length });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Elan kartlarında «sizin üçün» qiyməti göstərmək üçün: mənə şamil olunan bütün
// aktiv qaydalar (obyekt → faiz). Bir sorğu, bütün siyahılar üçün.
router.get('/me/pro-discounts', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const bp = await buyerProfessions(req.adminId!);
    if (!bp.declared.size && !bp.verified.size) { res.json({ success: true, rules: [] }); return; }
    const now = new Date();
    const all = await prisma.professionDiscount.findMany({
      where: { active: true, OR: [{ validUntil: null }, { validUntil: { gt: now } }], object: { isActive: true, deletedAt: null, business: { userId: { not: req.adminId! } } } },
      select: { businessObjectId: true, profession: true, percent: true, scope: true, listingIds: true, requireDoc: true },
      take: 3000,
    });
    res.json({ success: true, rules: all.filter((r) => ruleApplies(r, bp)).map((r) => ({ objectId: r.businessObjectId, profession: r.profession, percent: r.percent, listingIds: r.scope === 'SELECTED' ? r.listingIds : null })) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── MƏNƏ GÜZƏŞT VERƏN OBYEKTLƏR ─────────────────────────────────────────────
// İxtisas sahibi üçün: hansı mağazalar onun ixtisasına ALANDA endirim, SATANDA
// (referal) komissiya verir. Hər güzəşt üçün «indi istifadə edə bilərəmmi» və
// yoxdursa nə çatışmır (təsdiqli sənəd, CV və s.) göstərilir.
router.get('/me/profession-benefits', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const me = req.adminId!;
    const u = await prisma.user.findUnique({ where: { id: me }, select: { profession: true, professions: true } });
    const declared = Array.from(new Set([u?.profession, ...(u?.professions || [])].map((x) => (x || '').trim()).filter(Boolean)));
    const verified = await verifiedProfessions(me);
    const mine = new Set([...declared.map(normProf), ...verified]);
    if (!mine.size) { res.json({ success: true, professions: declared, verified: [], objects: [] }); return; }

    const liveObject = { isActive: true, deletedAt: null, business: { status: 'APPROVED' as const, isActive: true, deletedAt: null, userId: { not: me } } };
    const now = new Date();
    const [discounts, programs] = await Promise.all([
      prisma.professionDiscount.findMany({
        where: { active: true, OR: [{ validUntil: null }, { validUntil: { gt: now } }], object: liveObject },
        select: { businessObjectId: true, profession: true, percent: true, scope: true, listingIds: true, requireDoc: true },
        take: 2000,
      }),
      prisma.referralProgram.findMany({
        where: { enabled: true, objectId: { not: null }, sellerId: { not: me }, rules: { some: {} } },
        include: { rules: true },
        take: 500,
      }),
    ]);

    type Row = { profession: string; discountPercent: number | null; discountProducts: number | null; discountReady: boolean; commissionPercent: number | null; requiredDoc: string | null; commissionReady: boolean; commissionReason: string | null };
    const byObj = new Map<number, Map<string, Row>>();
    const rowOf = (objId: number, profession: string) => {
      const m = byObj.get(objId) || new Map<string, Row>();
      byObj.set(objId, m);
      const k = normProf(profession);
      const r = m.get(k) || { profession, discountPercent: null, discountProducts: null, discountReady: false, commissionPercent: null, requiredDoc: null, commissionReady: false, commissionReason: null };
      m.set(k, r);
      return r;
    };
    for (const d of discounts) {
      if (!mine.has(normProf(d.profession))) continue;
      const r = rowOf(d.businessObjectId, d.profession);
      r.discountPercent = d.percent;
      r.discountProducts = d.scope === 'SELECTED' ? d.listingIds.length : null;
      // Standart: ixtisas profildə olan kimi aktivdir; mağaza sənəd tələb edibsə — təsdiqli sənədlə.
      r.discountReady = verified.has(normProf(d.profession)) || (!d.requireDoc && declared.map(normProf).includes(normProf(d.profession)));
    }
    for (const p of programs) {
      const rules = p.rules.filter((x) => mine.has(normProf(x.profession)));
      if (!rules.length) continue;
      const el = await eligibility(p, me);
      for (const x of rules) {
        const r = rowOf(p.objectId!, x.profession);
        r.commissionPercent = x.commissionPercent;
        r.requiredDoc = x.requiredDoc;
        r.commissionReady = el.ok;
        r.commissionReason = el.ok ? null : el.reason;
      }
    }

    const ids = Array.from(byObj.keys());
    const [objs, counts] = await Promise.all([
      prisma.businessObject.findMany({ where: { id: { in: ids }, ...liveObject }, select: { id: true, name: true, city: true, address: true, business: { select: { name: true } } } }),
      prisma.listing.groupBy({ by: ['businessObjectId'], where: { businessObjectId: { in: ids }, status: 'APPROVED', archivedAt: null }, _count: { _all: true } }),
    ]);
    const objects = objs.map((o) => {
      const benefits = Array.from(byObj.get(o.id)!.values());
      return {
        id: o.id, name: o.name, city: o.city, address: o.address, businessName: o.business?.name || null,
        listingCount: counts.find((c) => c.businessObjectId === o.id)?._count._all || 0,
        benefits,
        ready: benefits.some((b) => b.discountReady || b.commissionReady),
      };
    }).filter((o) => o.listingCount > 0)
      .sort((a, b) => Number(b.ready) - Number(a.ready) || b.listingCount - a.listingCount);

    res.json({ success: true, professions: declared, verified: declared.filter((d) => verified.has(normProf(d))), objects });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Elan səhifəsi: bu mağazanın ixtisas endirimləri + baxanın statusu (daxil olmasa da görünür).
router.get('/listings/:id/pro-discount', async (req: Request, res: Response) => {
  try {
    const l = await prisma.listing.findUnique({ where: { id: parseInt(String(req.params.id)) }, select: { id: true, businessObjectId: true, userId: true } });
    if (!l) { res.status(404).json({ success: false, message: 'Elan tapılmadı' }); return; }
    const viewer = await viewerIdFromReq(req);
    res.json({ success: true, ...(await listingProDiscountInfo(l, viewer)) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Mağaza səhifəsi: aktiv ixtisas endirimləri.
router.get('/objects/:id/pro-discounts', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const rules = (await activeRules([id])).sort((a, b) => b.percent - a.percent);
    const viewer = await viewerIdFromReq(req);
    const bp = viewer ? await buyerProfessions(viewer) : { declared: new Set<string>(), verified: new Set<string>() };
    res.json({
      success: true,
      rules: rules.map((r) => ({ profession: r.profession, percent: r.percent, scope: r.scope, productCount: r.scope === 'SELECTED' ? r.listingIds.length : null, requireDoc: r.requireDoc, mine: ruleApplies(r, bp) })),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// İstifadəçi: sənədlə təsdiqli ixtisaslarım (profil və alış üçün).
router.get('/me/verified-professions', adminAuth, async (req: AuthRequest, res: Response) => {
  const set = await verifiedProfessions(req.adminId!);
  const u = await prisma.user.findUnique({ where: { id: req.adminId! }, select: { profession: true, professions: true } });
  const claimed = Array.from(new Set([u?.profession, ...(u?.professions || [])].filter(Boolean) as string[]));
  res.json({ success: true, verified: claimed.filter((p) => set.has(normProf(p))), unverified: claimed.filter((p) => !set.has(normProf(p))) });
});

export default router;
