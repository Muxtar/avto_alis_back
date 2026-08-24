import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/* ──────────────────────────────────────────────────────────────────────────
   ÖDƏNİŞ ÜNVANININ ARXİVİ

   Satıcı biznesini, hətta bütün hesabını silə bilər — amma bizim ona olan
   BORCUMUZ qalır və ödənilməlidir. `SellerLedger` sətirlərinin User/Business
   ilə FK əlaqəsi yoxdur (kaskadla silinmir), lakin ödəniş üçün lazım olan
   məlumat (ad, VÖEN, telefon, IBAN) Business/BankAccount sətirlərində idi —
   hesab silinəndə onlar kaskadla gedirdi və admin panelində "—" qalırdı.

   Ona görə silmədən ƏVVƏL bu məlumatın surəti ledger sətirlərinə yazılır.
   Admin ödəniş ekranı biznes/istifadəçi sətri tapılmasa bu surəti göstərir.
   ────────────────────────────────────────────────────────────────────────── */

type Snapshot = {
  payeeName?: string | null;
  payeeVoen?: string | null;
  payeeOwner?: string | null;
  payeePhone?: string | null;
  payeeIban?: string | null;
  payeeBank?: string | null;
};

const bizSnapshot = (b: {
  name: string; voen: string; ownerName: string; phone: string | null;
  banks: { iban: string; title: string | null; isPrimary: boolean }[];
}): Snapshot => {
  const acc = b.banks.find((x) => x.isPrimary) || b.banks[0] || null;
  return {
    payeeName: b.name,
    payeeVoen: b.voen,
    payeeOwner: b.ownerName,
    payeePhone: b.phone,
    payeeIban: acc?.iban || null,
    payeeBank: acc?.title || null,
  };
};

// Bir biznesin bütün hesablaşma sətirlərinə ödəniş məlumatının surətini yazır.
export async function archiveBusinessPayee(businessId: number): Promise<number> {
  const biz = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      name: true, voen: true, ownerName: true, phone: true,
      banks: { where: { isActive: true }, select: { iban: true, title: true, isPrimary: true } },
    },
  });
  if (!biz) return 0;
  const r = await prisma.sellerLedger.updateMany({
    where: { businessId, payeeArchived: null },
    data: { ...bizSnapshot(biz), payeeArchived: new Date() },
  });
  return r.count;
}

// Bütün hesab silinir: istifadəçinin HƏR biznesi + şəxsi (biznessiz) satışları.
export async function archiveUserPayees(userId: number): Promise<number> {
  let n = 0;
  const bizzes = await prisma.business.findMany({ where: { userId }, select: { id: true } });
  for (const b of bizzes) n += await archiveBusinessPayee(b.id);

  // Şəxsi satıcı sətirləri (businessId = null) — ad/telefon istifadəçidən gəlir.
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, phone: true } });
  if (u) {
    const r = await prisma.sellerLedger.updateMany({
      where: { sellerId: userId, businessId: null, payeeArchived: null },
      data: { payeeName: u.name, payeePhone: u.phone, payeeArchived: new Date() },
    });
    n += r.count;
  }
  return n;
}
