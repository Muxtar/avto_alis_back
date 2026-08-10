// IBAN doğrulaması — səhv yazılmış hesaba köçürmə bankda qayıdır və
// hesablaşma pozulur, ona görə yazılan anda yoxlanılır.
//
// Azərbaycan IBAN formatı: AZ + 2 yoxlama rəqəmi + 4 hərfli bank kodu +
// 20 simvol = CƏMİ 28 simvol. Məs: AZ21NABZ00000000137010001944
//
// Bütün IBAN-lar üçün ISO 13616 mod-97 yoxlaması da aparılır (bir rəqəm
// səhv yazılsa tutulur).

const LENGTHS: Record<string, number> = { AZ: 28, TR: 26, GE: 22, RU: 33, GB: 22, DE: 22 };

export function normalizeIban(raw: string): string {
  return String(raw || '').toUpperCase().replace(/[\s-]/g, '');
}

function mod97(iban: string): number {
  // İlk 4 simvolu sona köçür, hərfləri rəqəmə çevir (A=10 … Z=35), mod 97.
  const re = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of re) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem;
}

export interface IbanCheck { ok: boolean; iban: string; error?: string }

export function validateIban(raw: string): IbanCheck {
  const iban = normalizeIban(raw);
  if (!iban) return { ok: false, iban, error: 'IBAN boşdur' };
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) {
    return { ok: false, iban, error: 'IBAN formatı yanlışdır (ölkə kodu + 2 rəqəm ilə başlamalıdır)' };
  }
  const country = iban.slice(0, 2);
  const expected = LENGTHS[country];
  if (expected && iban.length !== expected) {
    return { ok: false, iban, error: `${country} IBAN-ı ${expected} simvol olmalıdır (yazılan: ${iban.length})` };
  }
  if (!expected && (iban.length < 15 || iban.length > 34)) {
    return { ok: false, iban, error: 'IBAN uzunluğu düzgün deyil' };
  }
  if (country === 'AZ' && !/^AZ[0-9]{2}[A-Z]{4}[A-Z0-9]{20}$/.test(iban)) {
    return { ok: false, iban, error: 'AZ IBAN formatı: AZ + 2 rəqəm + 4 hərfli bank kodu + 20 simvol' };
  }
  if (mod97(iban) !== 1) {
    return { ok: false, iban, error: 'IBAN yoxlama rəqəmi uyğun gəlmir — nömrəni yenidən yoxlayın' };
  }
  return { ok: true, iban };
}
