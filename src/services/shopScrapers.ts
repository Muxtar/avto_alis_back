// Azərbaycan alış-veriş saytlarında BİRBAŞA axtarış (internet axtarışının əsas mənbəyi).
//
// Niyə: Tavily kimi axtarış motorları çox vaxt kateqoriya / ana səhifə linki
// qaytarır, qiyməti isə köhnə indeks snippet-indən götürür — nəticədə link ana
// səhifəyə atır və göstərilən qiymət saytdakından fərqlənirdi. Burada isə həmin
// saytların ÖZ axtarış səhifəsini oxuyuruq: hər nəticə konkret elanın linkidir,
// qiymət və şəkil saytın öz məlumatından (canlı) gəlir — elana daxil olanda
// görünən qiymətlə eynidir (empirik yoxlanılıb: tap.az, lalafo.az).
//
// Hər mənbə müstəqildir: biri xəta versə / dəyişsə, digərləri işləməyə davam edir.
// Alınmayan mənbə sadəcə boş massiv qaytarır — axtarış pozulmur.

import type { WebResult } from './webSearchAI';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 9000;
const MAX_HTML = 2_500_000;

async function getHtml(url: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'az,en;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, MAX_HTML);
    return { html, finalUrl: res.url || url };
  } catch (e: any) {
    console.error('[shopScrapers]', url.slice(0, 70), e?.name || e?.message);
    return null;
  }
}

function nextData(html: string): any | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// ── Uyğunluq filtri ─────────────────────────────────────────────────────────
// Saytların axtarışı (xüsusən VIP/reklam elanları) sorğuya aid olmayan elan da
// qaytarır. Sorğunun BÜTÜN sözləri başlıqda olmalıdır ("iphone 15" → "iPhone 15
// Pro" keçir, "iPhone 16" və "Telefon təmiri" keçmir). Rəqəmlər tam söz kimi
// yoxlanılır ki, "15" → "150" ilə uyğun gəlməsin.
function fold(s: string): string {
  return s.toLowerCase()
    .replace(/ə/g, 'e').replace(/ı/g, 'i').replace(/i̇/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g')
    .replace(/[^a-z0-9а-яё]+/g, ' ').trim();
}
export function queryTokens(q: string): string[] {
  return fold(q).split(' ').filter((t) => t.length >= 1);
}
export function matchesQuery(title: string, tokens: string[]): boolean {
  if (!tokens.length) return false;
  const words = fold(title).split(' ');
  const joined = ' ' + words.join(' ') + ' ';
  const glued = words.join('');               // "iphone15" yazılışı üçün
  return tokens.every((t) => {
    if (/^\d+$/.test(t)) return words.includes(t) || new RegExp(`[a-z]${t}(?!\\d)`).test(glued);
    // Söz başlanğıcı ilə uyğunluq ("samsung" → "samsung", "galax" → "galaxy").
    return joined.includes(' ' + t) || (t.length >= 4 && glued.includes(t));
  });
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  const n = parseFloat(v.replace(/[\s ]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normCurrency(c: unknown): string {
  const s = String(c || '').trim().toUpperCase();
  if (!s || s === '₼' || s === 'AZN' || s === 'MANAT' || s === 'MAN') return 'AZN';
  if (s === '$' || s === 'USD') return 'USD';
  if (s === '€' || s === 'EUR') return 'EUR';
  if (s === '₽' || s === 'RUB') return 'RUB';
  return s.slice(0, 5);
}

// ── tap.az ──────────────────────────────────────────────────────────────────
// Axtarış səhifəsi SSR-dir; elanlar __NEXT_DATA__ → apolloState-dədir.
// Açar parametr `q[keywords]` (sadə `keywords` server tərəfdə nəzərə alınmır).
async function searchTapAz(q: string, tokens: string[]): Promise<WebResult[]> {
  const page = await getHtml(`https://tap.az/elanlar?q%5Bkeywords%5D=${encodeURIComponent(q)}`);
  if (!page) return [];
  const ap = nextData(page.html)?.props?.pageProps?.apolloState;
  if (!ap || typeof ap !== 'object') return [];
  const out: WebResult[] = [];
  for (const [k, a] of Object.entries<any>(ap)) {
    if (!k.startsWith('Ad:') || !a || a.status !== 'APPROVED') continue;
    if (typeof a.path !== 'string' || !/\/\d+$/.test(a.path)) continue;  // yalnız konkret elan
    const title = String(a.title || '').trim();
    if (!title || !matchesQuery(title, tokens)) continue;
    const img = a['photo({"source":"DESKTOP"})']?.url || a.photo?.url || null;
    out.push({
      title: title.slice(0, 160),
      url: `https://tap.az${a.path}`,
      snippet: [a.region].filter(Boolean).join(' · '),
      price: toNum(a.price),
      currency: 'AZN',            // tap.az qiymətləri həmişə AZN-dədir
      site: 'tap.az',
      kind: 'product',
      image: img,
      seller: null,
    });
  }
  return out;
}

// ── lalafo.az ───────────────────────────────────────────────────────────────
// Axtarış: /azerbaijan/q-<sorğu>. Elanlar react-query dehydratedState-dədir.
// DİQQƏT: lalafo-da slug köhnə başlıqdan qala bilir — uyğunluğu yalnız
// başlıqla yoxlayırıq (slug-la yox).
async function searchLalafo(q: string, tokens: string[]): Promise<WebResult[]> {
  const slug = q.trim().toLowerCase().replace(/\s+/g, '-');
  const page = await getHtml(`https://lalafo.az/azerbaijan/q-${encodeURIComponent(slug)}`);
  if (!page) return [];
  const queries: any[] = nextData(page.html)?.props?.pageProps?.dehydratedState?.queries || [];
  const feed = queries.find((x) => Array.isArray(x?.queryKey) && x.queryKey[0] === 'listingFeed');
  const items: any[] = (feed?.state?.data?.pages || []).flatMap((p: any) => (Array.isArray(p?.items) ? p.items : []));
  const out: WebResult[] = [];
  for (const it of items) {
    const title = String(it?.title || '').trim();
    if (!title || typeof it.url !== 'string' || !/-id-\d+$/.test(it.url)) continue;
    if (!matchesQuery(title, tokens)) continue;
    const img = Array.isArray(it.images) && it.images.length
      ? (it.images.find((i: any) => i?.is_main) || it.images[0])
      : null;
    out.push({
      title: title.slice(0, 160),
      url: `https://lalafo.az${it.url}`,
      snippet: [it.city].filter(Boolean).join(' · '),
      price: toNum(it.price),
      currency: normCurrency(it.currency || it.symbol),
      site: 'lalafo.az',
      kind: 'product',
      image: img?.thumbnail_url || img?.original_url || null,
      seller: it.user?.company_name || null,
    });
  }
  return out;
}

// ── turbo.az (avtomobil) ────────────────────────────────────────────────────
// Server HTML-i — kartlar `products-i` bloklarıdır. Açar söz filtri saytda
// həmişə tətbiq olunmur, ona görə uyğunluq filtrimiz burada xüsusilə vacibdir.
async function searchTurboAz(q: string, tokens: string[]): Promise<WebResult[]> {
  const page = await getHtml(`https://turbo.az/autos?q%5Bkeywords%5D=${encodeURIComponent(q)}`);
  if (!page) return [];
  const out: WebResult[] = [];
  const parts = page.html.split(/<div class="products-i[ "]/).slice(1);
  for (const raw of parts) {
    const chunk = raw.slice(0, 4000);
    const href = chunk.match(/class="products-i__link"[^>]*href="(\/autos\/\d+[^"]*)"/)?.[1];
    if (!href) continue;
    const name = decodeEntities(chunk.match(/products-i__name[^>]*>([^<]+)</)?.[1] || '').trim();
    const attrs = decodeEntities(chunk.match(/products-i__attributes[^>]*>([^<]+)</)?.[1] || '').trim();
    if (!name || !matchesQuery(`${name} ${attrs}`, tokens)) continue;
    const priceTxt = decodeEntities(chunk.match(/products-i__price[^>]*>([^<]+)</)?.[1] || '');
    const num = priceTxt.match(/[\d\s ]+/)?.[0];
    const cur = priceTxt.match(/₼|\$|€|AZN|USD|EUR/i)?.[0];
    out.push({
      title: `${name}${attrs ? ', ' + attrs : ''}`.slice(0, 160),
      url: `https://turbo.az${href}`,
      snippet: decodeEntities(chunk.match(/products-i__datetime[^>]*>([^<]+)</)?.[1] || '').trim(),
      price: num ? toNum(num) : null,
      currency: normCurrency(cur),
      site: 'turbo.az',
      kind: 'product',
      image: chunk.match(/<img[^>]+src="(https:\/\/[^"]+)"/)?.[1] || null,
      seller: null,
    });
  }
  // Eyni elan VIP və adi blokda iki dəfə görünə bilər.
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}

const CAR_WORDS = /\b(bmw|mercedes|benz|audi|toyota|lexus|honda|nissan|hyundai|kia|ford|chevrolet|opel|volkswagen|vw|skoda|renault|peugeot|mazda|mitsubishi|subaru|volvo|jeep|porsche|tesla|lada|vaz|chery|geely|byd|infiniti|land rover|range rover|zeekr|genesis|haval|changan|prius|camry|corolla|cobalt|maşın|masin|avtomobil)\b/i;

/**
 * Bütün mənbələrdə paralel axtarır. Hər mənbədən uyğun elanlar qaytarılır.
 * Avtomobil sorğusunda turbo.az da əlavə olunur.
 */
export async function searchShops(q: string): Promise<WebResult[]> {
  const tokens = queryTokens(q);
  if (!tokens.length) return [];
  const jobs: Promise<WebResult[]>[] = [searchTapAz(q, tokens), searchLalafo(q, tokens)];
  if (CAR_WORDS.test(q)) jobs.push(searchTurboAz(q, tokens));
  const settled = await Promise.allSettled(jobs);
  const lists = settled.map((s) => (s.status === 'fulfilled' ? s.value : []));
  console.log('[shopScrapers] sorğu:', q, '| tap.az:', lists[0].length, '| lalafo:', lists[1].length,
    lists[2] ? `| turbo: ${lists[2].length}` : '');
  return lists.flat();
}

// ── Ümumi məhsul səhifəsi yoxlaması (Tavily nəticələri üçün) ──────────────────
// Axtarış motorunun verdiyi linki AÇIB yoxlayırıq: (1) həqiqətən məhsul səhifəsidir
// (JSON-LD Product / og:type=product / qiymət meta etiketi), (2) ana səhifəyə
// yönləndirmir, (3) qiymət və şəkil səhifənin ÖZÜNDƏN götürülür — snippet-dən yox.
export interface ProductPage {
  url: string;
  title: string | null;
  price: number | null;
  currency: string;
  image: string | null;
  isProduct: boolean;
}

function meta(html: string, prop: string): string | null {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re1 = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${esc}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${esc}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decodeEntities(m[1]).trim() : null;
}

function findLdProduct(html: string): any | null {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const body = b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    let j: any;
    try { j = JSON.parse(body); } catch { continue; }
    const stack = [j];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== 'object') continue;
      if (Array.isArray(o)) { stack.push(...o); continue; }
      const t = o['@type'];
      if (t === 'Product' || (Array.isArray(t) && t.includes('Product')) || t === 'Car' || t === 'Vehicle') return o;
      if (o['@graph']) stack.push(o['@graph']);
    }
  }
  return null;
}

export async function fetchProductPage(url: string): Promise<ProductPage | null> {
  const page = await getHtml(url);
  if (!page) return null;
  const { html, finalUrl } = page;
  // Ana səhifəyə / kökə yönləndirildisə — elan silinib və ya link səhvdir.
  try { if (new URL(finalUrl).pathname.replace(/\/+$/, '') === '') return null; } catch { return null; }

  const ld = findLdProduct(html);
  let offer = ld?.offers;
  if (Array.isArray(offer)) offer = offer[0];
  if (offer?.['@type'] === 'AggregateOffer') offer = { price: offer.lowPrice ?? offer.price, priceCurrency: offer.priceCurrency };

  const price = toNum(offer?.price)
    ?? toNum(meta(html, 'product:price:amount'))
    ?? toNum(meta(html, 'og:price:amount'))
    ?? toNum(meta(html, 'price'));
  const currency = normCurrency(offer?.priceCurrency || meta(html, 'product:price:currency') || meta(html, 'og:price:currency') || meta(html, 'priceCurrency'));

  let image: string | null = null;
  const ldImg = ld?.image;
  image = (Array.isArray(ldImg) ? ldImg[0] : typeof ldImg === 'object' ? ldImg?.url : ldImg) || meta(html, 'og:image') || meta(html, 'twitter:image');
  if (image) { try { image = new URL(String(image), finalUrl).toString(); } catch { image = null; } }

  const ogType = (meta(html, 'og:type') || '').toLowerCase();
  const isProduct = !!ld || ogType.includes('product') || price != null;
  const title = (ld?.name && String(ld.name)) || meta(html, 'og:title') || null;
  return { url: finalUrl, title: title ? title.slice(0, 160) : null, price, currency, image, isProduct };
}

// URL konkret məhsul/elan səhifəsinə bənzəyirmi? (kök, kateqoriya, axtarış yox)
export function looksLikeProductUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, '');
    if (!path) return false;
    if (/\/(search|axtaris|catalogsearch|kateqoriya|category|categories|brand|brands|tag|blog|news|xeberler)(\/|$)/i.test(path)) return false;
    if (u.searchParams.has('q') || u.searchParams.has('query') || u.searchParams.has('keywords')) return false;
    const segs = path.split('/').filter(Boolean);
    // Rəqəmsal ID və ya uzun slug (məhsul adı) — tipik məhsul səhifəsi.
    return /\d{3,}/.test(path) || segs.some((s) => s.split('-').length >= 3);
  } catch { return false; }
}
