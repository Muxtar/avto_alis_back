/**
 * Sorğunu ANLAMAQ — axtarış mətnindən süzgəcləri çıxarır:
 *   "3 otaqlı mənzil yasamal 200 minə qədər"  → otaq=3, maxPrice=200000
 *   "bmw x5 2018 40000-dən ucuz"              → il=2018, maxPrice=40000
 *   "kirayə 2 otaqlı nərimanov 800 manata qədər" → kirayə, otaq=2, maxPrice=800
 * Qiymət ifadəsi saytlara göndərilən sorğudan çıxarılır (saytların öz axtarışı
 * "200 minə qədər" sözlərini elan başlığında axtarıb heç nə tapmırdı), nəticələr
 * isə burada süzülür. Qiyməti/ili/otağı BİLİNMƏYƏN elan atılmır — yalnız açıq
 * uyğunsuzlar çıxarılır.
 */
import type { WebResult } from './webSearchAI';

export interface SearchIntent {
  clean: string;            // saytlara göndəriləcək sorğu (qiymət ifadəsi çıxarılıb)
  minPrice?: number;
  maxPrice?: number;
  rooms?: number;
  year?: number;
  rent?: boolean;           // true → kirayə/icarə, false → satış; undefined → fərq etmir
}

const NUM = String.raw`(\d{1,3}(?:[ .,]\d{3})+|\d+(?:[.,]\d+)?)\s*(min|k|mln|milyon)?`;
const CUR = String.raw`\s*(?:azn|manat\w*|₼|usd|dollar\w*|\$)?`;
// "…-ə qədər", "…a kimi", "…-dək", "…-dən ucuz/aşağı/az", "… altı"
const UPTO = String.raw`\s*-?\s*(?:[əeaı]|y[əa])?\s*(?:q[əe]d[əe]r|kimi|-?d[əe]k|-?c[əa]n)|\s*-?\s*d[əa]n\s+(?:ucuz|a[sş]a[gğ][iı]|az)|\s+alt[iı]`;
// "…-dən yuxarı/baha/çox/başlayaraq"
const FROM = String.raw`\s*-?\s*d[əa]n\s+(?:yuxar[iı]|baha|[cç]ox|ba[sş]layaraq)`;

function toNumber(raw: string, unit?: string): number | null {
  let s = raw.trim();
  // "200 000", "200.000", "200,000" → 200000;  "1.5" (min/mln ilə) → 1.5
  if (/^\d{1,3}([ .,]\d{3})+$/.test(s)) s = s.replace(/[ .,]/g, '');
  else s = s.replace(',', '.');
  let n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = (unit || '').toLowerCase();
  if (u === 'min' || u === 'k') n *= 1000;
  else if (u === 'mln' || u === 'milyon') n *= 1_000_000;
  return n;
}

export function parseIntent(query: string, scope?: 'car' | 'realestate' | 'other'): SearchIntent {
  let text = ' ' + query.replace(/\s+/g, ' ').trim() + ' ';
  const intent: SearchIntent = { clean: query.trim() };

  const take = (re: RegExp, set: (n: number) => void) => {
    const m = text.match(re);
    if (!m) return;
    const n = toNumber(m[1], m[2]);
    if (n == null) return;
    set(n);
    text = text.replace(m[0], ' ');
  };
  take(new RegExp(`${NUM}${CUR}(?:${UPTO})`, 'i'), (n) => { intent.maxPrice = n; });
  take(new RegExp(`(?:max|maksimum)\\s*${NUM}${CUR}`, 'i'), (n) => { intent.maxPrice = intent.maxPrice ?? n; });
  take(new RegExp(`${NUM}${CUR}(?:${FROM})`, 'i'), (n) => { intent.minPrice = n; });
  if (intent.minPrice != null && intent.maxPrice != null && intent.minPrice > intent.maxPrice) delete intent.minPrice;

  const rooms = text.match(/(\d{1,2})\s*-?\s*otaq/i);
  if (rooms) intent.rooms = Number(rooms[1]);

  if (scope === 'car' || scope === undefined) {
    const y = text.match(/(?:^|\s)(19[89]\d|20[0-3]\d)(?:\s*-?\s*(?:ci|cu|cü|cı)?\s*il)?(?=\s|$)/i);
    if (y && scope === 'car') intent.year = Number(y[1]);
  }

  if (/kiray[əe]|icar[əe]|g[üu]nl[üu]k/i.test(text)) intent.rent = true;
  else if (/sat[ıi]l[ıi]r|sat[ıi][sş]|alq[ıi]/i.test(text)) intent.rent = false;

  // Əmlakda kirayə/satış yazılmayıbsa qiymət həddindən anla: "250 minə qədər" →
  // satış (kirayə elanları çıxmasın), "800 manata qədər" → kirayə.
  if (scope === 'realestate' && intent.rent === undefined && intent.maxPrice != null) intent.rent = intent.maxPrice < 10000;

  const clean = text.replace(/\s+/g, ' ').trim();
  // Təmizlənmiş sorğu boş qalmasın ("200 minə qədər" tək yazılıbsa orijinal qalır).
  intent.clean = clean.replace(/[^\p{L}\p{N}]/gu, '').length >= 2 ? clean : query.trim();
  return intent;
}

export function hasFilters(i: SearchIntent): boolean {
  return i.minPrice != null || i.maxPrice != null || i.rooms != null || i.year != null || i.rent != null;
}

// Yalnız müqayisə üçün təxmini məzənnə (göstərilən qiymət dəyişmir).
const RATE: Record<string, number> = { AZN: 1, USD: 1.7, EUR: 1.85, RUB: 0.02 };
const RENT_RE = /kiray[əe]|icar[əe]|g[üu]nl[üu]k|аренд|сда[её]тся|посуточно/i;

export function applyIntent(items: WebResult[], i: SearchIntent): WebResult[] {
  if (!hasFilters(i)) return items;
  return items.filter((r) => {
    const title = r.title || '';
    if (r.price != null && (i.minPrice != null || i.maxPrice != null)) {
      const azn = r.price * (RATE[r.currency || 'AZN'] ?? 1);
      if (i.maxPrice != null && azn > i.maxPrice) return false;
      if (i.minPrice != null && azn < i.minPrice) return false;
    }
    if (i.rooms != null) {
      const m = title.match(/(\d{1,2})\s*-?\s*(?:otaq|комн)/i);
      if (m && Number(m[1]) !== i.rooms) return false;
    }
    if (i.year != null) {
      const m = title.match(/(?:^|[\s,])(19[89]\d|20[0-3]\d)(?=[\s,]|$)/);
      if (m && Number(m[1]) !== i.year) return false;
    }
    if (i.rent === true && !RENT_RE.test(title)) return false;
    if (i.rent === false && RENT_RE.test(title)) return false;
    return true;
  });
}
