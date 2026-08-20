// SATICI MÜQAVİLƏSİNİN AVTOMATİK DOLDURULMASI.
//
// Müqavilənin MƏTNİ dəyişdirilmir — bazadakı `seller-agreement` sənədi olduğu
// kimi götürülür, yalnız boş xanalar (____) real dəyərlərlə əvəz olunur.
//
// Xanalar hansı mənbədən dolur:
//   Satıcı adı / VÖEN / Direktor  ← vergi sənədindən (AI oxuyub biznesə yazıb)
//   Ad-soyad, FİN                 ← VERİFF (şəxsiyyət vəsiqəsindən)
//   Telefon, e-poçt               ← istifadəçinin profili
//   IBAN                          ← bank sənədindən (biznesin əsas hesabı)
//   Ünvan                         ← biznesin hüquqi ünvanı
//   Platforma rekvizitləri        ← env (sənəddəki dəyərlər default-dur)

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Platformanın rekvizitləri — sənəddəki dəyərlər. Dəyişməsi lazım gələrsə
// env ilə üstələnə bilər (kodu yenidən yığmadan).
export const PLATFORM = {
  name: process.env.PLATFORM_LEGAL_NAME || '“FRİD Aİ TRADE” MMC',
  voen: process.env.PLATFORM_VOEN || '',
  address: process.env.PLATFORM_ADDRESS || 'AZ1040, Bakı şəhəri, Sabunçu rayonu, Bakıxanov kəndi, Sakita Qocayev küçəsi, 13A, 13B, 13B',
  bank: process.env.PLATFORM_BANK || 'KAPITAL BANK OPEN JOINT STOCK COMPANY',
  swift: process.env.PLATFORM_SWIFT || 'AIIBAZ2XXXX',
  account: process.env.PLATFORM_ACCOUNT || 'AZ22AIIB400600M9447264258121',
  director: process.env.PLATFORM_DIRECTOR || 'Ağayev Xanlar Əmralı oğlu',
  directorFin: process.env.PLATFORM_DIRECTOR_FIN || '',
  email: process.env.PLATFORM_EMAIL || '',
};

export interface ContractParty {
  companyName: string;
  voen: string;
  address: string;
  phone: string;
  email: string;
  iban: string;
  director: string;
  /** Şəxsiyyət vəsiqəsindən (Veriff) — imzalayanı eyniləşdirir. */
  signerName: string;
  signerFin: string;
}

/** Müqavilə üçün satıcı tərəfinin məlumatlarını topla. */
export async function collectSellerParty(businessId: number): Promise<{ ok: boolean; party?: ContractParty; missing?: string[]; message?: string }> {
  const biz = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      user: { select: { name: true, phone: true, email: true, idNumber: true, idVerifyStatus: true } },
      banks: { where: { isActive: true }, orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }], take: 1 },
    },
  });
  if (!biz) return { ok: false, message: 'Biznes tapılmadı' };

  // Kimlik təsdiqlənməyibsə ad/FİN etibarsızdır — müqavilə formalaşmır.
  if (biz.user.idVerifyStatus !== 'APPROVED') {
    return { ok: false, message: 'Müqavilə üçün kimlik Veriff ilə təsdiqlənməlidir' };
  }

  const party: ContractParty = {
    companyName: biz.name || '',
    voen: biz.voen || '',
    address: biz.legalAddress || '',
    phone: biz.phone || biz.user.phone || '',
    email: biz.user.email || '',
    iban: biz.banks[0]?.iban || '',
    director: biz.ownerName || '',
    signerName: biz.user.name || '',      // Veriff vəsiqədən yazıb
    signerFin: biz.user.idNumber || '',   // Veriff vəsiqədən yazıb
  };

  // Boş qalan MƏCBURİ xanalar — müqavilə yarımçıq imzalanmasın.
  const labels: Record<keyof ContractParty, string> = {
    companyName: 'Şirkət adı', voen: 'VÖEN', address: 'Hüquqi ünvan', phone: 'Telefon',
    email: 'E-poçt', iban: 'Bank hesabı (IBAN)', director: 'Direktor',
    signerName: 'İmzalayanın adı (Veriff)', signerFin: 'FİN (Veriff)',
  };
  const missing = (Object.keys(labels) as (keyof ContractParty)[])
    .filter((k) => !String(party[k] || '').trim())
    .map((k) => labels[k]);

  return { ok: missing.length === 0, party, missing };
}

/** Şablondakı boş xanaları doldur. Mətnin özü dəyişdirilmir. */
export function fillContract(template: string, party: ContractParty, contractNo: string, dateStr: string): string {
  let t = template;

  // Başlıq sətri: «"08   " iyul  2026-cı il  № ____  Bakı şəhəri»
  t = t.replace(/№\s*_{2,}/, `№ ${contractNo}`);

  // Preambula: «________________________ (VÖEN: ____________, Direktor_______________»
  t = t.replace(/_{10,}\s*\(VÖEN:\s*_{4,}\s*,\s*Direktor\s*_{4,}/,
    `${party.companyName} (VÖEN: ${party.voen}, Direktor: ${party.director} `);   // sondakı boşluq: mətndə "bundan sonra" bitişik gəlir

  // Rekvizitlər — «Satıcı» blokundakı sətirlər.
  const rows: [RegExp, string][] = [
    [/Adı \/ Hüquqi şəxs:\s*_{2,}/, `Adı / Hüquqi şəxs: ${party.companyName}`],
    [/(?<=Satıcı[\s\S]{0,400})VÖEN:\s*_{2,}/, `VÖEN: ${party.voen}`],
    [/Ünvan:\s*_{2,}/, `Ünvan: ${party.address}`],
    [/Telefon:\s*_{2,}/, `Telefon: ${party.phone}`],
    [/E-poçt:\s*_{2,}/, `E-poçt: ${party.email}`],
    [/Bank hesabı \(IBAN\):\s*_{2,}/, `Bank hesabı (IBAN): ${party.iban}`],
    [/Direktor_{2,}/, `Direktor: ${party.director}`],
  ];
  for (const [re, val] of rows) t = t.replace(re, val);

  // İmza sətirləri. Sənəddə hər iki tərəfdə eyni «İmza: _____» var:
  //   · Möhür-dən ƏVVƏLKİ  → Platforma
  //   · SONUNCU            → Satıcı
  // Faktiki imza DocuSign-da atılır; burada yalnız kimin imzalayacağı yazılır.
  t = t.replace(/İmza:\s*_{2,}(\s*\nMöhür:)/,
    `İmza: ${PLATFORM.director}${PLATFORM.directorFin ? ` (FİN: ${PLATFORM.directorFin})` : ''} — elektron imza$1`);
  // Sonuncu «İmza: ___» — satıcınınkı (mətnin sonunda başqa şey yoxdur).
  const lastSig = t.lastIndexOf('İmza:');
  if (lastSig >= 0) {
    const head = t.slice(0, lastSig);
    const tail = t.slice(lastSig).replace(/İmza:\s*_{2,}/,
      `İmza: ${party.signerName} (FİN: ${party.signerFin}) — elektron imza`);
    t = head + tail;
  }

  // Platforma rekvizitləri — sənəddə VÖEN xanası boş idi.
  if (PLATFORM.voen) t = t.replace(/(Şirkətin adı:.*?MMC)\s*VÖEN:/, `$1 VÖEN: ${PLATFORM.voen}`);

  // Tarix (başlıqdakı «"08   " iyul  2026-cı il» saxlanılır; imzalanma tarixi
  // ayrıca əlavə edilir — sənəd nə vaxt formalaşdığı bilinsin).
  t += `\n\n────────────────────────────────────────\nMüqavilə tarixi: ${dateStr}\nMüqavilə nömrəsi: ${contractNo}\n`;
  t += `İmzalayan (Satıcı): ${party.signerName}, FİN ${party.signerFin}\n`;
  return t;
}

/** Biznes üçün hazır müqavilə mətni. */
export async function buildContract(businessId: number): Promise<{ ok: boolean; text?: string; party?: ContractParty; missing?: string[]; message?: string; version?: number }> {
  const doc = await prisma.legalDocument.findFirst({
    where: { slug: 'seller-agreement', isActive: true },
    orderBy: { version: 'desc' },
  });
  if (!doc) return { ok: false, message: 'Müqavilə şablonu tapılmadı' };

  const r = await collectSellerParty(businessId);
  if (!r.party) return { ok: false, message: r.message };
  if (!r.ok) return { ok: false, party: r.party, missing: r.missing, message: 'Müqavilə üçün məlumat çatışmır' };

  const no = `TX-${String(businessId).padStart(5, '0')}`;
  const date = new Date().toLocaleDateString('az-AZ');
  return { ok: true, text: fillContract(doc.body, r.party, no, date), party: r.party, version: doc.version };
}
