// PAYLAŞIM ÖNİZLƏMƏSİ (Open Graph) üçün yüngül, açıq məlumat.
//
// Linki WhatsApp / Telegram / Facebook-a atanda görünən başlıq, mətn və ŞƏKİL
// buradan gəlir (frontend-in server tərəfi `generateMetadata`-da oxuyur).
// Elanın əsas ünvanı (/listings/:id) baxış sayını artırır — önizləmə botları
// saygacı şişirtməsin deyə ayrıca, yalnız-oxu ünvan işlədilir.
// Yalnız onsuz da hamıya açıq olan sahələr qaytarılır.
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();
const cut = (s: string | null | undefined, n: number) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const azn = (n: number) => `${Math.round(n * 100) / 100} AZN`;

router.get('/og/:kind/:id', async (req: Request, res: Response) => {
  try {
    const kind = String(req.params.kind);
    const raw = String(req.params.id);
    const id = parseInt(raw);
    let out: { title: string; description: string; image: string | null } | null = null;

    if (kind === 'listing' && Number.isFinite(id)) {
      const l = await prisma.listing.findUnique({ where: { id }, select: { title: true, price: true, images: true, description: true, status: true, businessObject: { select: { name: true } }, user: { select: { name: true } } } });
      if (l && l.status === 'APPROVED') out = { title: `${l.title} — ${azn(l.price)}`, description: cut(`${l.businessObject?.name || l.user?.name || ''} · ${l.description}`, 180), image: l.images?.[0] || null };
    } else if (kind === 'group') {
      const g = await prisma.groupBuy.findUnique({ where: { code: raw }, select: { listing: { select: { title: true, price: true, images: true, priceTiers: { select: { price: true } } } } } });
      if (g) {
        const min = g.listing.priceTiers.length ? Math.min(...g.listing.priceTiers.map((t) => t.price)) : g.listing.price;
        out = {
          title: `Birgə alış: ${g.listing.title}`,
          description: min < g.listing.price ? `Birlikdə alaq — qiymət ${azn(g.listing.price)}-dən ${azn(min)}-ə qədər düşür. Qoşul, daha ucuz olsun!` : `Birlikdə alaq — ${azn(g.listing.price)}. Qoşul!`,
          image: g.listing.images?.[0] || null,
        };
      }
    } else if (kind === 'seller' && Number.isFinite(id)) {
      const u = await prisma.user.findUnique({ where: { id }, select: { name: true, avatar: true, profession: true, professions: true, bio: true } });
      if (u) {
        const prof = (u.professions?.length ? u.professions : u.profession ? [u.profession] : []).join(', ');
        out = { title: `${u.name}${prof ? ` — ${prof}` : ''}`, description: cut(u.bio || 'tradixai profili — elanlar, rəylər və əlaqə.', 180), image: u.avatar || null };
      }
    } else if (kind === 'object' && Number.isFinite(id)) {
      const o = await prisma.businessObject.findUnique({ where: { id }, select: { name: true, city: true, address: true, activityAreas: true, deletedAt: true, business: { select: { name: true } } } });
      if (o && !o.deletedAt) {
        // Obyektin öz şəkli yoxdur — ən yeni məhsulunun şəkli göstərilir.
        const l = await prisma.listing.findFirst({ where: { businessObjectId: id, status: 'APPROVED', archivedAt: null, NOT: { images: { isEmpty: true } } }, orderBy: { createdAt: 'desc' }, select: { images: true } });
        out = { title: `${o.name} — ${o.business?.name || 'mağaza'}`, description: cut([o.city, o.address, (o.activityAreas || []).slice(0, 3).join(', ')].filter(Boolean).join(' · ') || 'tradixai mağazası', 180), image: l?.images?.[0] || null };
      }
    } else if (kind === 'shared' || kind === 'referral') {
      // Paylaşılan səbət / referal link — ilk məhsulun şəkli və məhsul sayı.
      const row = kind === 'shared'
        ? await prisma.sharedCart.findUnique({ where: { token: raw }, select: { title: true, items: true, kind: true, user: { select: { name: true } } } }).catch(() => null)
        : await prisma.referralCart.findUnique({ where: { token: raw }, select: { title: true, items: true, referrer: { select: { name: true } } } }).catch(() => null);
      if (row) {
        const items = (Array.isArray(row.items) ? (row.items as any[]) : []).map((i) => Number(i.listingId)).filter((n) => Number.isFinite(n));
        const ls = items.length ? await prisma.listing.findMany({ where: { id: { in: items } }, select: { id: true, title: true, images: true } }) : [];
        const first = items.map((i) => ls.find((l) => l.id === i)).find((l) => l && l.images?.length) || ls[0];
        const by = (row as any).user?.name || (row as any).referrer?.name || '';
        const bundle = (row as any).kind === 'BUNDLE';
        out = {
          title: row.title || (bundle ? 'Sizin üçün məhsul paketi' : kind === 'referral' ? 'Tövsiyə olunan məhsullar' : 'Paylaşılan səbət'),
          description: cut(`${by ? `${by} göndərdi · ` : ''}${items.length} məhsul${first ? `: ${first.title}${items.length > 1 ? ' və digərləri' : ''}` : ''}`, 180),
          image: first?.images?.[0] || null,
        };
      }
    }
    if (!out) { res.status(404).json({ success: false }); return; }
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ success: true, ...out });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
