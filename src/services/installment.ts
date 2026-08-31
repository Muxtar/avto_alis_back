// HİSSƏLİ ALIŞ (taksit) qaydaları.
//
// Kimə açıqdır: yalnız BİZNES üzərindən paylaşılan məhsullara. Şəxsi elana
// taksit verilmir — arxasında VÖEN-li satıcı və hesablaşma yoxdur.
//
// Necə işləyir: ödəniş şlüzü (YIĞIM/MAGNET v1.16) məbləği bölmür — API-də
// taksit parametri ümumiyyətlə yoxdur (spesifikasiya yoxlanılıb). Taksit
// alıcının ÖZ taksit kartı ilə tətbiq olunur; biz tam məbləği alırıq, bank
// onu kart sahibi üçün aylara bölür. Ona görə burada yalnız plan seçimi,
// hesablama və qeyd var — pul axını dəyişmir.

export const INSTALLMENT_MONTHS = [3, 6, 9, 12, 18] as const;
export type InstallmentMonths = (typeof INSTALLMENT_MONTHS)[number];

// Taksitin açıq olduğu minimal məbləğ — çox kiçik alışa taksit mənasızdır.
export const INSTALLMENT_MIN_AMOUNT = Number(process.env.INSTALLMENT_MIN_AMOUNT || 30);

export function isValidMonths(v: unknown): v is InstallmentMonths {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return (INSTALLMENT_MONTHS as readonly number[]).includes(n);
}

// Verilmiş məbləğ üçün taksit mümkündürmü.
export function installmentAllowed(amount: number, isBusiness: boolean): boolean {
  return isBusiness && amount >= INSTALLMENT_MIN_AMOUNT;
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

/**
 * Bu elan üçün seçilə bilən ay variantları.
 * Satıcı taksiti bağlayıbsa və ya elan biznes elanı deyilsə — boş.
 */
export function monthsForListing(l: ListingInstallmentFields): number[] {
  if (!isBusinessListing(l) || l.installmentEnabled === false) return [];
  const max = l.installmentMaxMonths;
  return INSTALLMENT_MONTHS.filter((m) => !max || m <= max);
}

/** Sifarişdəki BÜTÜN məhsullar üçün ortaq ay variantları (ən dar məhdudiyyət). */
export function monthsForListings(list: ListingInstallmentFields[]): number[] {
  if (!list.length) return [];
  return list.reduce<number[]>(
    (acc, l) => acc.filter((m) => monthsForListing(l).includes(m)),
    [...INSTALLMENT_MONTHS],
  );
}

/** Ay sayının dəyəri elanların icazə verdiyi aralıqdadırmı. */
export function monthsAllowedFor(list: ListingInstallmentFields[], months: unknown): boolean {
  const n = typeof months === 'number' ? months : parseInt(String(months ?? ''), 10);
  return monthsForListings(list).includes(n);
}

// Aylıq ödəniş — 0% faizlə bərabər bölgü. Yuvarlaqlaşdırmadan yaranan
// qəpik fərqi SON aya yazılır ki, cəm həmişə tam məbləğə bərabər olsun.
export function monthlyPayment(amount: number, months: number): { monthly: number; last: number; total: number } {
  const cents = Math.round(amount * 100);
  const per = Math.floor(cents / months);
  const last = cents - per * (months - 1);
  return { monthly: per / 100, last: last / 100, total: cents / 100 };
}

// Bütün planların cədvəli — məhsul səhifəsindəki kalkulyator üçün.
export function installmentPlans(amount: number): { months: number; monthly: number; last: number }[] {
  return INSTALLMENT_MONTHS.map((months) => {
    const { monthly, last } = monthlyPayment(amount, months);
    return { months, monthly, last };
  });
}
