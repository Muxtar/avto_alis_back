// HİSSƏLİ ALIŞ (taksit) qaydaları.
//
// Kimə açıqdır: yalnız BİZNES məhsullarına (VÖEN-li satıcı, kartla ödəniş).
//
// Necə işləyir: alıcı planı (məs. 6 ay) seçir, sifariş kartla ödənilir.
// Kapital Bank sifarişinin təsvirinə «TAKSIT=N» yazılır — bank ödənişi
// BirKart/taksit kartı sahibi üçün N aya bölür, merchant (biz) isə tam
// məbləği alır. YIĞIM (MAGNET) API-də taksit göstəricisi YOXDUR — ona görə
// şlüz YIĞIM olanda taksit ümumiyyətlə təklif edilmir (vəd edib yerinə
// yetirməmək olmasın).
//
// Admin paneldən idarə olunur (services/settings): planlar (installment_mN),
// minimal məbləğ, hər planın bank komissiyası (installment_fee_mN) və
// komissiyanı kimin ödədiyi (installment_buyer_pays_fee).
import { resolveFlag, getNumber } from './settings';
import { activeProvider } from './paymentGateway';

// Mümkün bütün planlar — hansının aktiv olduğunu admin seçir.
export const ALL_INSTALLMENT_MONTHS = [2, 3, 6, 9, 12, 18, 24] as const;
/** @deprecated — admin konfiqurasiyası üçün getInstallmentConfig() */
export const INSTALLMENT_MONTHS = ALL_INSTALLMENT_MONTHS;

export function isValidMonths(v: unknown): boolean {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return (ALL_INSTALLMENT_MONTHS as readonly number[]).includes(n);
}

export interface InstallmentConfig {
  available: boolean;
  reason: string | null;
  months: number[];                 // aktiv planlar
  fees: Record<number, number>;     // plan → bank komissiyası (%)
  minAmount: number;
  buyerPaysFee: boolean;
  provider: string;
}

export async function getInstallmentConfig(): Promise<InstallmentConfig> {
  const provider = activeProvider();
  const [enabled, toKapital, buyerPaysFee, minAmount] = await Promise.all([
    resolveFlag('installment_enabled'), resolveFlag('installment_kapital_taksit'),
    resolveFlag('installment_buyer_pays_fee'), getNumber('installment_min_azn'),
  ]);
  const months: number[] = [];
  const fees: Record<number, number> = {};
  for (const m of ALL_INSTALLMENT_MONTHS) {
    if (await resolveFlag(`installment_m${m}`)) months.push(m);
    fees[m] = await getNumber(`installment_fee_m${m}`);
  }
  let reason: string | null = null;
  if (!enabled) reason = 'Hissəli ödəniş hazırda deaktivdir';
  else if (provider !== 'kapital') reason = 'Cari ödəniş şlüzü taksiti dəstəkləmir';
  else if (!toKapital) reason = 'Taksitin banka ötürülməsi deaktivdir';
  else if (!months.length) reason = 'Aktiv taksit planı yoxdur';
  return { available: !reason, reason, months, fees, minAmount, buyerPaysFee, provider };
}

// Elanın taksit parametrləri — satıcının seçimi.
type ListingInstallmentFields = {
  businessId?: number | null;
  businessObjectId?: number | null;
  installmentEnabled?: boolean | null;
  installmentMaxMonths?: number | null;
};

/** Elan biznesə bağlıdırmı — taksit yalnız belə elanlarda mümkündür. */
export function isBusinessListing(l: ListingInstallmentFields): boolean {
  return !!(l.businessId || l.businessObjectId);
}

/** Bu elan üçün seçilə bilən planlar (aktiv planlar ∩ satıcının limiti). */
export function monthsForListing(l: ListingInstallmentFields, active: readonly number[] = ALL_INSTALLMENT_MONTHS): number[] {
  if (!isBusinessListing(l) || l.installmentEnabled === false) return [];
  const max = l.installmentMaxMonths;
  return active.filter((m) => !max || m <= max);
}

/** Sifarişdəki BÜTÜN məhsullar üçün ortaq planlar (ən dar məhdudiyyət). */
export function monthsForListings(list: ListingInstallmentFields[], active: readonly number[] = ALL_INSTALLMENT_MONTHS): number[] {
  if (!list.length) return [];
  return list.reduce<number[]>((acc, l) => acc.filter((m) => monthsForListing(l, active).includes(m)), [...active]);
}

export function monthsAllowedFor(list: ListingInstallmentFields[], months: unknown, active: readonly number[] = ALL_INSTALLMENT_MONTHS): boolean {
  const n = typeof months === 'number' ? months : parseInt(String(months ?? ''), 10);
  return monthsForListings(list, active).includes(n);
}

export function installmentAllowed(amount: number, isBusiness: boolean, minAmount = 30): boolean {
  return isBusiness && amount >= minAmount;
}

/** Plan komissiyası (AZN) — malların ödənilən məbləğindən. */
export function installmentFee(goodsAmount: number, feePercent: number): number {
  return Math.round(Math.max(0, goodsAmount) * Math.max(0, feePercent)) / 100;
}

// Aylıq ödəniş — bərabər bölgü. Yuvarlaqlaşdırmadan yaranan qəpik fərqi SON
// aya yazılır ki, cəm həmişə tam məbləğə bərabər olsun.
export function monthlyPayment(amount: number, months: number): { monthly: number; last: number; total: number } {
  const cents = Math.round(amount * 100);
  const per = Math.floor(cents / months);
  const last = cents - per * (months - 1);
  return { monthly: per / 100, last: last / 100, total: cents / 100 };
}
