// ÇOX ALANDA UCUZ — say-qiymət düsturu.
//
// Satıcı elana könüllü pillə qoyur: «100 ədəd → 800 AZN» (adi qiymət 1000).
// Alıcı 50 ədəd alanda nə olmalıdır? Sistem ARALIQ sayı özü hesablayır:
// pillələr arasında XƏTTİ keçid tətbiq olunur.
//
//   1 ədəd  → 1000 AZN   (elanın adi qiyməti)
//   100 ədəd→  800 AZN   (satıcının pilləsi)
//   50 ədəd → 1000 − (1000−800) × (50−1)/(100−1) ≈ 901.01 AZN
//
// Bir neçə pillə olanda hər qonşu iki nöqtə arasında eyni düstur işləyir;
// sonuncu pillədən çox alanda qiymət sonuncu pillənin qiymətidir.
//
// Qaydalar (create/update-də yoxlanılır):
//   • minQty ≥ 2, artan sırada, təkrarsız
//   • hər pillənin qiyməti adi qiymətdən və əvvəlki pillədən KİÇİK olmalıdır
//   • maksimum 5 pillə

export interface Tier { minQty: number; price: number }

export const MAX_TIERS = 5;

/** Pillələri təmizlə + yoxla. Xəta varsa `error` qaytarır. */
export function validateTiers(basePrice: number, raw: any): { ok: true; tiers: Tier[] } | { ok: false; error: string } {
  if (raw == null) return { ok: true, tiers: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'Qiymət pillələri siyahı olmalıdır' };
  const tiers: Tier[] = [];
  for (const t of raw) {
    const minQty = Math.trunc(Number(t?.minQty));
    const price = Number(t?.price);
    if (!Number.isFinite(minQty) || minQty < 2) return { ok: false, error: 'Pillədə say ən azı 2 olmalıdır' };
    if (!Number.isFinite(price) || price <= 0) return { ok: false, error: 'Pillə qiyməti 0-dan böyük olmalıdır' };
    if (price >= basePrice) return { ok: false, error: `Pillə qiyməti adi qiymətdən (${basePrice} AZN) kiçik olmalıdır` };
    tiers.push({ minQty, price: Math.round(price * 100) / 100 });
  }
  if (tiers.length > MAX_TIERS) return { ok: false, error: `Ən çox ${MAX_TIERS} pillə ola bilər` };
  tiers.sort((a, b) => a.minQty - b.minQty);
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].minQty === tiers[i - 1].minQty) return { ok: false, error: 'Eyni say iki dəfə yazılıb' };
    if (tiers[i].price >= tiers[i - 1].price) {
      return { ok: false, error: 'Say artdıqca qiymət azalmalıdır' };
    }
  }
  return { ok: true, tiers };
}

/** Verilmiş say üçün BİR ədədin qiyməti (pillələr arasında xətti keçid). */
export function unitPriceFor(basePrice: number, tiers: Tier[], qty: number): number {
  const q = Math.max(1, Math.trunc(qty || 1));
  const sorted = [...(tiers || [])].sort((a, b) => a.minQty - b.minQty);
  if (!sorted.length) return basePrice;
  // Sonuncu pillədən çox: ən ucuz qiymət.
  const last = sorted[sorted.length - 1];
  if (q >= last.minQty) return round2(last.price);
  // Nöqtələr: (1, adi qiymət) + pillələr.
  const points: Tier[] = [{ minQty: 1, price: basePrice }, ...sorted];
  for (let i = 1; i < points.length; i++) {
    const lo = points[i - 1];
    const hi = points[i];
    if (q <= hi.minQty) {
      if (q <= lo.minQty) return round2(lo.price);
      const ratio = (q - lo.minQty) / (hi.minQty - lo.minQty);
      return round2(lo.price - (lo.price - hi.price) * ratio);
    }
  }
  return round2(basePrice);
}

/** Say üçün qiymət + endirim məlumatı (UI üçün). */
export function priceInfo(basePrice: number, tiers: Tier[], qty: number) {
  const unit = unitPriceFor(basePrice, tiers, qty);
  const saved = round2((basePrice - unit) * Math.max(1, qty));
  const percent = basePrice > 0 ? Math.round(((basePrice - unit) / basePrice) * 100) : 0;
  const sorted = [...(tiers || [])].sort((a, b) => a.minQty - b.minQty);
  // Növbəti pillə — «daha 20 ədəd alsanız qiymət X olacaq».
  const next = sorted.find((t) => t.minQty > qty) || null;
  return {
    unitPrice: unit,
    basePrice: round2(basePrice),
    totalPrice: round2(unit * Math.max(1, qty)),
    saved,
    discountPercent: percent,
    nextTier: next ? { minQty: next.minQty, price: round2(next.price), need: next.minQty - qty } : null,
    bestPrice: sorted.length ? round2(sorted[sorted.length - 1].price) : round2(basePrice),
    bestQty: sorted.length ? sorted[sorted.length - 1].minQty : null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
