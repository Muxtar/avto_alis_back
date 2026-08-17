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
