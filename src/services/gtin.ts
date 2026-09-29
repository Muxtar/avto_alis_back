// ŞTRİX-KOD (GTIN) — EAN-8, UPC-A (12), EAN-13, ITF-14. Yoxlama rəqəmi (mod 10) ilə.
// Çekdə OCR bir rəqəmi səhv oxusa və ya satıcı səhv yazsa — yoxlama rəqəmi tutur.

/** Rəqəmlərdən başqa hər şeyi at; uzunluq 8/12/13/14 və yoxlama rəqəmi düzdürsə kodu qaytar. */
export function normalizeGtin(raw: string | null | undefined): string | null {
  const d = String(raw || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(d.length)) return null;
  const body = d.slice(0, -1).split('').map(Number);
  let sum = 0;
  // Sağdan: 3, 1, 3, 1 … çəkilər (yoxlama rəqəmi xaric).
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += body[i] * w;
  const check = (10 - (sum % 10)) % 10;
  return check === Number(d[d.length - 1]) ? d : null;
}

/**
 * Daxili (mağazanın özünün) kodu — çəki ilə satılan məhsullar və s.
 * GS1: 02, 04, 20–29 ilə başlayanlar «məhdud dövriyyə» kodlarıdır — mağazadan-mağazaya
 * fərqli məhsul ola bilər, ona görə başqa mağaza/saytla müqayisə edilmir.
 */
export function isRestrictedGtin(code: string): boolean {
  const c = code.length === 12 ? '0' + code : code; // UPC-A → EAN-13 forması
  return /^(02|04|2[0-9])/.test(c.length === 14 ? c.slice(1) : c);
}
