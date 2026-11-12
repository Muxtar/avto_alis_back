// Saytdaxili axtarış nəticə vermədikdə internetdən axtarış.
// İstifadəçi başlıqdakı axtarışda məhsul/otel adı yazır; saytda tapılmazsa
// nəticələr internetdən gətirilir.
//
// İki yol var (dispatcher `webSearch` seçir):
//   1) TAVILY_API_KEY varsa → Tavily axtarış motoru (ucuz, sürətli) +
//      istəyə görə Haiku 4.5 ilə qiymət/xülasə təmizlənməsi. ƏSAS yol.
//   2) Yalnız ANTHROPIC_API_KEY varsa → köhnə Claude web_search yolu (ehtiyat,
//      keçid dövrü üçün — Tavily açarı əlavə edilənə qədər sayt işləsin).
//
// Railway → Variables:
//   TAVILY_API_KEY      — tavily.com pulsuz açarı (əsas axtarış)
//   ANTHROPIC_API_KEY   — Haiku təmizləmə + Claude ehtiyat yolu (istəyə görə)
//   WEB_SEARCH_REFINE_MODEL — default 'claude-haiku-4-5'

import Anthropic from '@anthropic-ai/sdk';
import { resolveFlag } from './settings';
import { searchShops, fetchProductPage, looksLikeProductUrl, refineRelevance, matchesQuery, queryTokens, filterByCategory } from './shopScrapers';
import { aiRankResults, aiRankEnabled } from './searchRank';
import { tavilyCarListings, tavilyProductListings } from './tavilyListings';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  price: number | null;   // saytdakı qiymət (canlı) — səhifədə görünürsə
  currency?: string;      // qiymətin valyutası saytda necədirsə (AZN, USD ...)
  site: string;           // mənbə sayt (tap.az, turbo.az ...)
  category?: string | null; // saytdakı kateqoriya (uyğunluq süzgəci üçün)
  priceFromIndex?: boolean; // qiymət axtarış indeksindəndir (sayt canlı açılmadı) — dəyişə bilər
  kind?: 'product' | 'social';  // məhsul elanı, yoxsa şəxsin sosial profili
  platform?: string;      // social üçün: instagram/facebook/linkedin/tiktok/x/youtube/telegram
  handle?: string;        // social üçün: istifadəçi adı (profil şəkli üçün də lazımdır)
  seller?: string | null; // məhsul üçün: satıcının adı (səhifədə görünürsə)
  // Bu profil bizim saytda qeydiyyatlı istifadəçiyə aiddirsə (doğrulanmış sosial link).
  siteUser?: { id: number; name: string; avatar: string | null } | null;
  // Apify ilə zənginləşdirmə — profilin gerçək adı və şəkli (varsa).
  displayName?: string | null;
  avatarUrl?: string | null;
  // MƏHSUL nəticələri üçün: elan səhifəsinin og:image şəkli (kart görünüşü).
  image?: string | null;
  // og:description — kartda qısa izah (snippet-dən daha səliqəli).
  description?: string | null;
  followers?: number | null;
  verifiedBadge?: boolean;
}

export interface WebSearchResponse {
  ok: boolean;
  mode: 'product' | 'person';  // sorğu məhsul, yoxsa şəxs axtarışıdır
  summary: string;      // qısa Azərbaycanca xülasə
  results: WebResult[];
  error?: string;
}

const EMPTY: WebSearchResponse = { ok: false, mode: 'product', summary: '', results: [] };

// İstifadəçi axtarış sahəsində rejimi ÖZÜ seçir: məhsul, yoxsa şəxs.
// 'auto' — köhnə davranış (sorğuya baxıb özü təxmin edir).
export type SearchMode = 'auto' | 'product' | 'person';

// Azərbaycanın məhsul/elan alış-veriş saytları — MƏHSUL rejimində axtarış
// birinci növbədə məhz bunlarda aparılır ki, nəticə xəbər/bloq deyil, ELAN olsun
// (ad + qiymət + satıcı çıxsın).
const AZ_SHOP_DOMAINS = [
  'tap.az', 'turbo.az', 'bina.az', 'lalafo.az', 'umico.az', 'birmarket.az',
  'emalls.az', 'kontakt.az', 'irshad.az', 'bakuelectronics.az', 'trendyol.az',
  'soliton.az', 'texnomart.az', 'optimal.az', 'amerikan.az', 'maxi.az',
];

const AI_MODEL = process.env.WEB_SEARCH_MODEL || 'claude-opus-4-8';

// ── Yaddaş keşi ──────────────────────────────────────────────────────────────
// Eyni sorğunun nəticəsini saxlayır ki, təkrar axtarışlar Tavily kreditini /
// AI tokenini yandırmasın. Prosess yaddaşındadır (DB lazım deyil); serveri
// yenidən başladanda təmizlənir — bu, məqbuldur.
interface CacheEntry { at: number; ttl: number; data: WebSearchResponse; }
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 500;                       // maks. sorğu sayı (yaddaş limiti)
// Qiymət saytdakı ilə EYNİ olmalıdır — ona görə nəticə qısa saxlanılır.
const TTL_HIT = 20 * 60 * 1000;              // nəticə tapıldı → 20 dəqiqə
const TTL_EMPTY = 60 * 60 * 1000;            // boş nəticə → 1 saat (sonra sayt yeni elan əlavə edə bilər)
const TTL_ERROR = 2 * 60 * 1000;             // xəta → 2 dəqiqə (keçici ola bilər, uzun saxlama)

function cacheKey(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim();
}

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

function parseJson(text: string): any | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : (text.match(/\{[\s\S]*\}/)?.[0] || text);
  try { return JSON.parse(candidate); } catch { return null; }
}

// ── Azərbaycan filtri ────────────────────────────────────────────────────────
// Üç qat: (1) alət səviyyəsi (user_location + blocked_domains),
// (2) prompt səviyyəsi (aşağıdakı SYSTEM/prompt), (3) kod səviyyəsi (isAzResult).
// Model qaydanı pozsa belə, kod filtri son söz sahibidir.

// Azərbaycan şirkətlərinin .az olmayan domenləri (nadir hal).
const AZ_BRAND_DOMAINS = new Set([
  // Elan / pazar platformaları
  'tap.az', 'turbo.az', 'bina.az', 'lalafo.az', 'lalafo.com', 'umico.az',
  'birmarket.az', 'emalls.az', 'boss.az', 'jobsearch.az',
  // Mağaza şəbəkələri
  'kontakt.az', 'irshad.az', 'bakuelectronics.az', 'trendyol.az',
  'soliton.az', 'texnomart.az', 'optimal.az',
]);

// Beynəlxalq saytlarda Azərbaycana aid səhifəni tanıyan izlər.
const AZ_PATH_HINTS = /(\/az\/|azerbaijan|azerbaycan|az[eə]rbaycan|\bbaku\b|-baku|\bbaki\b|\bganja\b|\bnakhchivan\b|\bqabala\b|\bshaki\b)/i;

// Nəticə Azərbaycana aiddirsə true. Şübhə varsa false (nəticə atılır).
export function isAzResult(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'az' || host.endsWith('.az')) return true;   // .az domenləri
    if (AZ_BRAND_DOMAINS.has(host)) return true;              // tanınmış AZ brendləri
    return AZ_PATH_HINTS.test(host + u.pathname);             // beynəlxalq saytın AZ səhifəsi
  } catch {
    return false;
  }
}

// PUBLIC sosial media / peşəkar profil domenləri — şəxs/ixtisas axtarışında yalnız
// AÇIQ profil LİNKİ göstərmək üçün (Google kimi). Telefon/email SCRAPE OLUNMUR.
// Yalnız 4 platforma — istifadəçi tələbi (Instagram, Facebook, X/Twitter, LinkedIn).
const SOCIAL_DOMAINS = ['instagram.com', 'facebook.com', 'fb.com', 'linkedin.com', 'x.com', 'twitter.com'];
export function isSocialResult(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return SOCIAL_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

// URL-dən sosial platformanın adını çıxarır (instagram, facebook, linkedin ...).
export function socialPlatform(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (host.includes('instagram')) return 'instagram';
    if (host.includes('facebook') || host === 'fb.com') return 'facebook';
    if (host.includes('linkedin')) return 'linkedin';
    if (host === 'x.com' || host.includes('twitter')) return 'x';
    return host;
  } catch { return ''; }
}

// Sosial profil URL-indən istifadəçi adını çıxarır (profil şəkli və göstərim üçün).
// Post/reel/video kimi profil olmayan linklərdə null qaytarır.
const NON_PROFILE = new Set([
  'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'watch', 'groups', 'events',
  'pages', 'photo', 'video', 'videos', 'posts', 'status', 'share', 'permalink.php',
  'shorts', 'channel', 'c', 'playlist', 'results', 'hashtag', 'search', 'company',
  'jobs', 'feed', 'pulse', 'story',
]);
export function socialHandle(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    let first = decodeURIComponent(parts[0]).replace(/^@/, '');
    // LinkedIn profilləri /in/<handle> formatındadır.
    if (first === 'in' && parts[1]) first = decodeURIComponent(parts[1]);
    else if (NON_PROFILE.has(first.toLowerCase())) return null;
    // Yalnız profil adına oxşayanlar (post id-ləri deyil).
    if (!/^[A-Za-z0-9._-]{2,40}$/.test(first)) return null;
    return first;
  } catch { return null; }
}

// ── Şəxs (ad-soyad) axtarışı tanıma ──────────────────────────────────────────
// İstifadəçi "muxtar bayramov" kimi ad-soyad yazanda → şəxs axtarışı (public
// sosial media profilləri). Məhsul/brend/kateqoriya sözü varsa → məhsul axtarışı.
// Brend+model (məs. "toyota corolla") şəxs kimi qəbul olunmasın deyə brend/kateqoriya
// stop-siyahısı saxlanır — hər hansı söz bu siyahıdadırsa, sorğu MƏHSULdur.
const PRODUCT_STOPWORDS = new Set([
  // Kateqoriya / ümumi sözlər
  'telefon', 'noutbuk', 'notebook', 'kompüter', 'komputer', 'planşet', 'planset', 'televizor',
  'maşın', 'masin', 'avtomobil', 'moto', 'motosiklet', 'velosiped', 'ev', 'mənzil', 'menzil',
  'torpaq', 'bağ', 'bag', 'obyekt', 'ofis', 'kirayə', 'kiraye', 'satılır', 'satilir', 'alınır',
  'çanta', 'canta', 'ayaqqabı', 'ayaqqabi', 'geyim', 'saat', 'qol', 'üzük', 'uzuk', 'sırğa',
  'köynək', 'koynek', 'kostyum', 'palto', 'kurtka', 'şalvar', 'salvar', 'don', 'yubka',
  'divan', 'çarpayı', 'carpayi', 'stol', 'stul', 'şkaf', 'skaf', 'soyuducu', 'paltaryuyan',
  'kondisioner', 'qaz', 'plita', 'mikrodalğa', 'tozsoran', 'ütü', 'utu', 'qulaqlıq', 'qulaqlıq',
  'kamera', 'obyektiv', 'dron', 'konsol', 'oyun', 'kitab', 'velosped', 'skuter', 'təkər', 'teker',
  'ehtiyat', 'hissə', 'hisse', 'disk', 'akkumulyator', 'şin', 'sin', 'yağ', 'yag',
  // Elektronika brendləri
  'iphone', 'ipad', 'macbook', 'samsung', 'galaxy', 'xiaomi', 'redmi', 'huawei', 'honor', 'oppo',
  'vivo', 'realme', 'nokia', 'sony', 'lg', 'apple', 'lenovo', 'asus', 'acer', 'hp', 'dell', 'msi',
  'playstation', 'xbox', 'nintendo', 'canon', 'nikon', 'gopro', 'dji', 'bose', 'jbl', 'beats',
  // Avtomobil brendləri
  'bmw', 'mercedes', 'benz', 'audi', 'toyota', 'lexus', 'honda', 'nissan', 'hyundai', 'kia',
  'ford', 'chevrolet', 'opel', 'volkswagen', 'vw', 'skoda', 'renault', 'peugeot', 'fiat', 'mazda',
  'mitsubishi', 'subaru', 'volvo', 'jeep', 'land', 'range', 'rover', 'porsche', 'jaguar', 'tesla',
  'lada', 'vaz', 'gaz', 'uaz', 'chery', 'geely', 'byd', 'infiniti', 'acura', 'cadillac', 'dodge',
]);

// Sorğu şəxs adına bənzəyirsə true. 2-3 sözlük, yalnız hərflərdən ibarət,
// rəqəmsiz, məhsul/brend sözü olmayan sorğular şəxs sayılır.
export function looksLikePerson(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (/\d/.test(q)) return false;                       // rəqəm varsa məhsuldur (model, il)
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 3) return false;
  // Yalnız Azərbaycan/Latın hərfləri (defis, apostrof olar).
  const onlyLetters = words.every((w) => /^[a-zâçəğıöşüi̇'’-]{2,}$/i.test(w));
  if (!onlyLetters) return false;
  if (words.some((w) => PRODUCT_STOPWORDS.has(w))) return false;  // brend/kateqoriya → məhsul
  return true;
}

// Azərbaycanla əlaqəsi olmayan qlobal pazarlar — alət səviyyəsində bağlanır.
const BLOCKED_DOMAINS = [
  'amazon.com', 'aliexpress.com', 'ebay.com', 'hepsiburada.com',
  'trendyol.com', 'wildberries.ru', 'ozon.ru', 'temu.com',
];

const SYSTEM = `Sən tradixai (Azərbaycan onlayn elan platforması) üçün internet axtarışı köməkçisisən.
İstifadəçi saytda nəsə axtarıb, amma nəticə tapılmayıb. Sənin işin həmin sorğunu
internetdə axtarıb YALNIZ AZƏRBAYCANA AİD nəticələr qaytarmaqdır.

Coğrafi qayda (ən vacib qayda — heç vaxt pozma):
- Nəticə Azərbaycanda satılan, yerləşən və ya Azərbaycandan sifariş edilə bilən olmalıdır.
  Azərbaycanla əlaqəsi olmayan nəticəni SİYAHIYA SALMA.
- Üstünlük sırası: (1) .az domenləri və Azərbaycan şirkətlərinin rəsmi saytları,
  (2) beynəlxalq saytların Azərbaycan bölməsi (məs. booking.com-un Bakı oteli səhifəsi),
  (3) başqa heç nə.
- Beynəlxalq sayt yalnız o halda uyğundur ki, HƏMİN SƏHİFƏ Azərbaycandakı məhsul/məkan
  haqqında olsun. Ümumi qlobal səhifə uyğun deyil.
- Şübhə varsa nəticəni at. Az sayda düzgün nəticə, çox sayda uyğunsuzdan yaxşıdır.

Dürüstlük qaydası:
- Yalnız axtarış nəticələrindən gələn REAL ünvanları yaz. URL uydurma.
- Qiymət, ünvan, telefon kimi məlumatı yalnız səhifədə görmüsənsə yaz.
- Heç nə tapmasan, boş siyahı qaytar və bunu açıq bildir. Uydurma ilə doldurma.
- Axtarış sayı məhduddur. Limitə çatmamış tapdıqlarını qaytar; limit bəhanəsi ilə
  boş cavab vermə.

Cavab dili: Azərbaycan dili.`;

function prompt(query: string): string {
  return `İstifadəçi bizim saytda "${query}" axtardı, saytda uyğun elan tapılmadı.

Bunu internetdə axtar və Azərbaycanda mövcud olan ən uyğun 4-6 nəticəni tap.
Axtararkən sorğuya "Azərbaycan" və ya "Bakı" kimi yer göstəricisi əlavə et.

Sorğu qısa və ya qısaldılmış ola bilər (məs. "x5" → BMW X5 avtomobili,
"s24" → Samsung Galaxy S24, "air 2" → iPad Air 2). Belə halda əvvəlcə onun
nə demək olduğunu müəyyən et, sonra tam adla axtar. Bir neçə məna varsa,
Azərbaycanda ən çox axtarılanı seç.

AXTARIŞ BÜDCƏSİ: təxminən 10 axtarışın var. Onu səmərəli xərclə —
hər saytı ayrıca yoxlamağa çalışma, büdcə bitər və əliboş qalarsan.

Strategiya (bu sıra ilə):
1. 1-2 ümumi axtarış: "<məhsul adı> Azərbaycan" və "<məhsul adı> Bakı qiymət".
   Çox vaxt bu, tap.az / lalafo.az / umico.az nəticələrini onsuz da gətirir.
2. Hələ də azdırsa, YALNIZ ən uyğun 1-2 platformada "site:" ilə axtar:
   - Avtomobil → site:turbo.az
   - Ev/mənzil/torpaq → site:bina.az
   - Digər məhsullar → site:tap.az və ya site:lalafo.az
3. Qalan büdcəni ehtiyatda saxla.

Bu platformalardan nəticə tapsan, onları siyahının BAŞINA qoy:
tap.az, lalafo.az, turbo.az (avtomobil), bina.az (əmlak),
umico.az / kontakt.az / irshad.az / bakuelectronics.az / birmarket.az (mağaza).

VACİB: axtarış büdcən bitməyə yaxınlaşırsa, DAYAN və o ana qədər tapdığın
etibarlı nəticələri qaytar. Əliboş cavab vermə — 1-2 düzgün nəticə də
heç nədən yaxşıdır. (Yenə də uydurma URL yazma.)

Nəticə tipləri (sorğuya uyğun olanı seç):
- Məhsuldursa: yuxarıdakı elan/mağaza platformalarının məhsul səhifələri
- Avtomobildirsə: turbo.az elan səhifəsi
- Ev/mənzil/torpaqdırsa: bina.az və ya tap.az elan səhifəsi
- Otel/məkandırsa: rəsmi sayt və ya rezervasiya səhifəsi (Azərbaycandakı obyekt)
- Xidmətdirsə: xidməti Azərbaycanda göstərən şirkətin səhifəsi

Axtarışı bitirdikdən sonra YALNIZ bu JSON-u qaytar, başqa heç nə yazma:
{
  "summary": "1-2 cümlə Azərbaycan dilində qısa xülasə",
  "results": [
    {
      "title": "elanın / məhsulun adı",
      "url": "tam https ünvan",
      "site": "mənbə sayt, məs. tap.az",
      "price": 1250,
      "snippet": "1 cümlə izah — nə olduğu və Azərbaycanla əlaqəsi",
      "az_reason": "niyə bu nəticə Azərbaycana aiddir (qısa)"
    }
  ]
}

"price" haqqında:
- YALNIZ axtarış nəticəsində/səhifədə həqiqətən gördüyün qiyməti yaz.
- Yalnız RƏQƏM yaz, AZN ilə: 1250 (── "1250 AZN", "1.250" və ya mətn YOX).
- Qiymət dollar/avro ilədirsə, təxmini çevirmə etmə — price: null qoy.
- Qiyməti görmürsənsə price: null. Təxmin etmə, uydurma.

Qeyd: "az_reason"-u özün üçün yaz — hər nəticəni siyahıya salmadan əvvəl onun
Azərbaycanla əlaqəsini yoxla. Əlaqəni izah edə bilmirsənsə, nəticəni at.`;
}

// ── Dispatcher ───────────────────────────────────────────────────────────────
/**
 * Sorğunu internetdə axtarır və struktur nəticələr qaytarır.
 * TAVILY_API_KEY varsa Tavily (+ Haiku) istifadə olunur; yoxdursa köhnə
 * Claude web_search yoluna düşülür. İstifadəçiyə qaytarılan forma eynidir.
 * @param query istifadəçinin axtarış mətni
 */
export async function webSearch(query: string, mode: SearchMode = 'auto'): Promise<WebSearchResponse> {
  const q = query.trim().slice(0, 200);
  if (!q) return { ...EMPTY, error: 'Axtarış mətni boşdur.' };

  // Keş açarına rejim də daxildir — eyni söz "məhsul" və "şəxs" rejimlərində
  // fərqli nəticə verir (məs. "Rəna Səlimova" ad ola bilər, marka da).
  const key = `${mode}|${cacheKey(q)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) {
    console.log('[webSearch] keş HIT — sorğu:', q);
    return hit.data;
  }

  const data = await webSearchUncached(q, mode);

  // TTL: nəticə var → uzun, boş → orta, xəta → qısa.
  const ttl = data.ok ? (data.results.length > 0 ? TTL_HIT : TTL_EMPTY) : TTL_ERROR;
  cache.delete(key);                          // varsa sona köçsün (LRU təmizləmə üçün)
  cache.set(key, { at: Date.now(), ttl, data });
  if (cache.size > CACHE_MAX) {               // ölçü limiti — ən köhnəni sil
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return data;
}

// Keşsiz əsl axtarış — əvvəlcə sorğu tipini müəyyən edirik (şəxs, yoxsa məhsul).
// Hər motor ayrıca admin flag-ı ilə idarə olunur (admin/ai panelindən aç/söndür):
//   ai_websearch_tavily  — məhsul üçün əsas Tavily motoru
//   ai_websearch_claude  — məhsul üçün Claude ehtiyat motoru
//   ai_person_search     — şəxs (sosial media) axtarışı (Tavily)
async function webSearchUncached(q: string, mode: SearchMode = 'auto'): Promise<WebSearchResponse> {
  const [tavilyOn, claudeOn, personOn] = await Promise.all([
    resolveFlag('ai_websearch_tavily'),
    resolveFlag('ai_websearch_claude'),
    resolveFlag('ai_person_search'),
  ]);
  const hasTavily = !!process.env.TAVILY_API_KEY;
  const hasClaude = !!process.env.ANTHROPIC_API_KEY;

  // Rejim istifadəçi tərəfindən seçilibsə ona hörmət edilir; 'auto' olanda
  // köhnə davranış — sorğuya baxıb təxmin edirik.
  const wantsPerson = mode === 'person' || (mode === 'auto' && looksLikePerson(q));

  // ── Şəxs axtarışı — yalnız flag aktiv + Tavily açarı + Tavily motoru aktiv ──
  if (wantsPerson) {
    if (personOn && tavilyOn && hasTavily) return webSearchPerson(q);
    return { ok: true, mode: 'person', summary: '', results: [] };  // deaktiv → boş
  }

  // ── Məhsul — AZ saytlarında birbaşa axtarış (açarsız, canlı qiymət) +
  //    Tavily (aktivsə) əlavə mağazalar üçün. Claude yalnız heç nə tapılmasa.
  const products = await webSearchProducts(q, tavilyOn && hasTavily);
  if (products.ok && products.results.length) return products;
  if (claudeOn && hasClaude) {
    const c = await webSearchClaude(q);
    // Claude-un linkləri də açılıb yoxlanılır — qiymət səhifədən gəlsin.
    const verified = c.ok && c.results.length ? await verifyLinks(c.results) : [];
    if (verified.length) return { ...c, results: verified.slice(0, MAX_RESULTS) };
  }
  return products.ok ? products : { ...EMPTY, error: products.error || 'İnternet axtarışı alınmadı.' };
}

// ── Şəxs axtarışı (public sosial media profilləri) ───────────────────────────
// "muxtar bayramov" kimi ad yazılanda Google-vari — həmin şəxsə aid AÇIQ sosial
// media hesablarını (instagram/facebook/linkedin/tiktok/x/youtube/telegram) tapır.
// YALNIZ public profil LİNKİ göstərilir — telefon/email/ünvan SCRAPE OLUNMUR.
async function webSearchPerson(q: string): Promise<WebSearchResponse> {
  console.log('[webSearch] şəxs axtarışı — sorğu:', q);
  let data: any;
  try {
    const resp = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({
        // Sosial platformalarda adı axtar — profil linkləri gəlsin.
        query: `${q} Azərbaycan instagram OR facebook OR linkedin OR twitter`,
        search_depth: 'basic',
        topic: 'general',
        max_results: 12,
        include_answer: false,
        include_domains: SOCIAL_DOMAINS,   // yalnız sosial media nəticələri
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[webSearch] şəxs Tavily HTTP', resp.status, body.slice(0, 200));
      const msg = resp.status === 401 || resp.status === 403 ? 'Axtarış açarı etibarsızdır.'
        : resp.status === 429 ? 'Axtarış limiti doldu, bir azdan yenidən cəhd edin.'
        : 'İnternet axtarışı alınmadı. Yenidən cəhd edin.';
      return { ...EMPTY, mode: 'person', error: msg };
    }
    data = await resp.json();
  } catch (e: any) {
    console.error('[webSearch] şəxs Tavily xəta:', e?.name, e?.message);
    return { ...EMPTY, mode: 'person', error: 'İnternet axtarışı alınmadı. Yenidən cəhd edin.' };
  }

  const raw: any[] = Array.isArray(data?.results) ? data.results : [];
  // BÜTÜN tapılan profillər (eyni adlı fərqli şəxslər ola bilər) — platforma üzrə
  // təkləmə YOXDUR, yalnız eyni URL/istifadəçi adı təkrar göstərilmir.
  const seenKey = new Set<string>();
  const results: WebResult[] = [];
  for (const r of raw) {
    if (!r || typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url) || !isSocialResult(r.url)) continue;
    const platform = socialPlatform(r.url);
    if (!platform) continue;
    const handle = socialHandle(r.url);
    // Profil səhifəsi olmayan linkləri (post/reel/video) at — istifadəçi şəxs axtarır.
    if (!handle) continue;
    const key = `${platform}:${handle.toLowerCase()}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    let site = '';
    try { site = new URL(r.url).hostname.replace(/^www\./, ''); } catch {}
    results.push({
      title: String(r.title || q).slice(0, 120),
      url: String(r.url),
      snippet: String(r.content || '').slice(0, 160),
      price: null,
      site: site.slice(0, 60),
      kind: 'social',
      platform,
      handle,
    });
  }

  console.log('[webSearch] şəxs sorğu:', q, '| xam:', raw.length, '| profil:', results.length);
  return {
    ok: true,
    mode: 'person',
    summary: results.length ? '' : `"${q}" üçün açıq sosial media hesabı tapılmadı.`,
    results,
  };
}

// ── Tavily yolu (əsas) ───────────────────────────────────────────────────────
const TAVILY_URL = 'https://api.tavily.com/search';


// Snippet/məzmundan satıcı adını çıxaran ehtiyat regex (səhifədə açıq yazılıbsa).
// Tapılmasa null — uydurmuruq. Yalnız "Satıcı: X" / "Seller: X" formatları.
function extractSeller(text: string): string | null {
  if (!text) return null;
  const m = text.match(/(?:satıcı|satici|seller|elan[çc]ı|elanci|müəllif|muellif)\s*[:\-–]\s*([A-Za-zÂÇƏĞIİÖŞÜâçəğıöşü.\s]{2,40})/i);
  if (!m) return null;
  const name = m[1].trim().replace(/\s{2,}/g, ' ').replace(/[.,;]+$/, '');
  return name.length >= 2 ? name.slice(0, 40) : null;
}

// Bir Tavily sorğusu. `shopsOnly` — nəticələr YALNIZ AZ alış-veriş saytlarından
// gəlsin (elan səhifələri: ad + qiymət + satıcı). Xəta olarsa mesaj qaytarır.
async function tavilyQuery(q: string, shopsOnly: boolean): Promise<{ results: any[] } | { error: string }> {
  const body: any = {
    query: shopsOnly ? q : `${q} Azərbaycan`,
    search_depth: 'basic',      // 'basic' = 1 kredit; 'advanced' = 2 kredit
    topic: 'general',
    country: 'azerbaijan',      // nəticələri AZ-ə meyilləndirir
    max_results: shopsOnly ? 12 : 10,
    include_answer: false,      // xülasə lazım deyil — yalnız linklər (az kredit)
  };
  if (shopsOnly) body.include_domains = AZ_SHOP_DOMAINS;
  else body.exclude_domains = BLOCKED_DOMAINS;
  try {
    const resp = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.error('[webSearch] Tavily HTTP', resp.status, t.slice(0, 300));
      return { error: resp.status === 401 || resp.status === 403 ? 'Axtarış açarı etibarsızdır.'
        : resp.status === 429 ? 'Axtarış limiti doldu, bir azdan yenidən cəhd edin.'
        : 'İnternet axtarışı alınmadı. Yenidən cəhd edin.' };
    }
    const j: any = await resp.json();
    return { results: Array.isArray(j?.results) ? j.results : [] };
  } catch (e: any) {
    console.error('[webSearch] Tavily xəta:', e?.name, e?.message);
    return { error: 'İnternet axtarışı alınmadı. Yenidən cəhd edin.' };
  }
}

// ── Məhsul axtarışı (əsas yol) ───────────────────────────────────────────────
// 1) tap.az / lalafo.az / turbo.az-da BİRBAŞA axtarış — konkret elan linki,
//    saytın öz qiyməti və şəkli (canlı, elana daxil olanda görünənlə eyni).
// 2) Tavily (aktivsə) — digər AZ mağazaları; HƏR link açılıb yoxlanılır:
//    məhsul səhifəsi deyilsə / ana səhifəyə atırsa atılır, qiymət və şəkil
//    snippet-dən YOX, səhifənin özündən götürülür.
// Nəticə: ən azı 5 (mövcuddursa), maksimum 10 birbaşa məhsul linki.
// İstifadəçi tələbi: Google-dakı kimi ilk 5 uyğun elan (qiymətə görə sıralanmır).
const MIN_RESULTS = 5;
const MAX_RESULTS = 5;
// Yalnız SIRALAMA üçün təxmini məzənnə — göstərilən qiymət saytdakı kimi qalır.
const SORT_RATE: Record<string, number> = { AZN: 1, USD: 1.7, EUR: 1.85, RUB: 0.02 };

function normUrl(u: string): string {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/+$/, '').toLowerCase(); }
  catch { return u; }
}

// Axtarış motorunun linklərini açıb yoxlayır (paralel). Yalnız real məhsul
// səhifələri qalır; qiymət/şəkil/başlıq səhifənin özündən gəlir.
async function verifyLinks(raw: { url: string; title?: string; content?: string }[], limit = 8): Promise<WebResult[]> {
  const seen = new Set<string>();
  const cand = raw.filter((r) => {
    if (!r || typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url)) return false;
    if (!isAzResult(r.url) || !looksLikeProductUrl(r.url)) return false;
    const k = normUrl(r.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, limit);
  const pages = await Promise.allSettled(cand.map((r) => fetchProductPage(r.url)));
  const out: WebResult[] = [];
  pages.forEach((p, i) => {
    if (p.status !== 'fulfilled' || !p.value || !p.value.isProduct) return;
    const pg = p.value;
    let site = '';
    try { site = new URL(pg.url).hostname.replace(/^www\./, ''); } catch {}
    out.push({
      title: String(pg.title || cand[i].title || pg.url).slice(0, 160),
      url: pg.url,                       // yönləndirmədən sonrakı son ünvan
      snippet: String(cand[i].content || '').slice(0, 120),
      price: pg.price,                   // YALNIZ səhifədən — snippet qiyməti işlədilmir
      currency: pg.currency,
      site: site.slice(0, 60),
      kind: 'product',
      image: pg.image,
      seller: extractSeller(String(cand[i].content || '')),
    });
  });
  return out;
}

function sortValue(r: WebResult): number {
  if (r.price == null) return Number.POSITIVE_INFINITY;
  return r.price * (SORT_RATE[r.currency || 'AZN'] ?? 1);
}

// Aksesuar/ehtiyat hissəsi kimi kəskin ucuz uyğunsuzları atır ("iPhone 15" axtarışında
// 25 AZN-lik qab). Yalnız kifayət qədər qiymətli nəticə olanda tətbiq olunur.
function dropOutliers(items: WebResult[]): WebResult[] {
  const vals = items.map(sortValue).filter(Number.isFinite).sort((a, b) => a - b);
  if (vals.length < 4) return items;
  const median = vals[Math.floor(vals.length / 2)];
  const kept = items.filter((r) => { const v = sortValue(r); return !Number.isFinite(v) || v >= median * 0.25; });
  return kept.length >= MIN_RESULTS ? kept : items;
}

// Google-vari sıralama (qiymətə görə YOX). İstifadəçi tələbi: "ən ucuz" məntiqi
// oyuncaq maşın / aksesuar kimi uyğunsuz ucuz elanları önə çıxarırdı.
//  1) Uyğunluq: sorğu başlıqda BİTİŞİK ifadə kimi keçirsə ("bmw x5") daha yuxarı.
//  2) Mənbə sırası: maşın → turbo.az birinci (Google-da olduğu kimi);
//     digər məhsullar → saytlar növbə ilə (tap.az, lalafo.az, sonra digərləri).
//  3) Hər saytın daxilində həmin saytın öz axtarış sırası saxlanılır.
function rankLikeGoogle(items: WebResult[], q: string, n: number, siteOrder: string[]): WebResult[] {
  const phrase = queryTokens(q).join(' ');
  const fold = (t: string) => ' ' + queryTokens(t).join(' ') + ' ';
  const score = (r: WebResult) => (fold(r.title).includes(' ' + phrase + ' ') ? 1 : 0);
  const bySite = new Map<string, WebResult[]>();
  for (const r of items) {
    const arr = bySite.get(r.site) || [];
    arr.push(r);
    bySite.set(r.site, arr);
  }
  // Sayt daxilində: əvvəl tam ifadə uyğunluğu, sonra saytın öz sırası (stabil sort).
  for (const arr of bySite.values()) arr.sort((a, b) => score(b) - score(a));
  const sites = [...bySite.keys()].sort((a, b) => {
    const ia = siteOrder.indexOf(a), ib = siteOrder.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const out: WebResult[] = [];
  // Birinci saytdan ilk 2 nəticə (Google-da ən uyğun sayt bir neçə dəfə çıxır), sonra növbə ilə.
  const first = bySite.get(sites[0]) || [];
  out.push(...first.splice(0, 2));
  while (out.length < n && sites.some((s) => (bySite.get(s) || []).length)) {
    for (const s of sites) {
      const r = (bySite.get(s) || []).shift();
      if (r) out.push(r);
      if (out.length >= n) break;
    }
  }
  return out.slice(0, n);
}

function dedupe(items: WebResult[]): WebResult[] {
  const seen = new Set<string>();
  return items.filter((r) => {
    const k = normUrl(r.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function webSearchProducts(q: string, useTavily: boolean): Promise<WebSearchResponse> {
  console.log('[webSearch] məhsul axtarışı — sorğu:', q, '| tavily:', useTavily);
  // 1) Əvvəlcə AZ saytlarında birbaşa (maşın → turbo.az, digər → tap.az/lalafo.az).
  const shop = await searchShops(q).catch((e) => {
    console.error('[webSearch] shops:', e?.message);
    return { results: [] as WebResult[], isCar: false, car: null };
  });

  // 2) Kateqoriya süzgəci: oyuncaq / ehtiyat hissə / aksesuar / xidmət kateqoriyalarındakı
  //    elanlar atılır (sorğu bunu açıq istəmirsə). Bütün məhsul növləri üçün işləyir.
  const candidates = shop.isCar ? shop.results : filterByCategory(shop.results, q);
  let pool = shop.isCar ? candidates : dropOutliers(refineRelevance(candidates, q, MIN_RESULTS));

  // 3) 5-dən az qalıbsa — Tavily İNDEKSİ. Prod-da tap.az/turbo.az/lalafo server
  //    IP-lərinə 403 qaytarır, ona görə orada əsas mənbə budur: konkret elan
  //    linkləri, başlıqdakı qiymət, mətndəki şəkil. Sonra hər linki canlı açmağa
  //    cəhd edirik — açılsa qiymət/şəkil canlı olur, açılmasa indeksdən qalır.
  let tavCount = 0;
  let tavError: string | undefined;
  let tavRelevant: WebResult[] = [];
  if (pool.length < MIN_RESULTS && useTavily) {
    const idx = shop.isCar && shop.car ? await tavilyCarListings(shop.car) : await tavilyProductListings(q);
    tavError = idx.error;
    tavRelevant = shop.isCar ? idx.results : filterByCategory(idx.results, q);
    // (Canlı yoxlama tavilyListings daxilində — Tavily Extract ilə.)
    tavCount = tavRelevant.length;
    pool = dedupe([...pool, ...(shop.isCar ? tavRelevant : dropOutliers(refineRelevance(tavRelevant, q, MIN_RESULTS)))]);
  }

  const siteOrder = shop.isCar ? ['turbo.az', 'tap.az'] : ['tap.az', 'lalafo.az'];

  // 4) AI uyğunluq hakimi (maşın deyilsə və açar varsa): kateqoriya süzgəcindən keçən
  //    BÜTÜN namizədlərə baxır, yalnız axtarılan məhsulun özünü saxlayıb sıralayır.
  //    Maşında turbo.az nəticələri artıq marka/model üzrə təmizdir — AI lazım deyil.
  if (!shop.isCar && aiRankEnabled()) {
    const aiPool = dedupe([...candidates, ...tavRelevant]);
    if (aiPool.length) {
      // Namizədləri evristik sıra ilə ver ki, ilk 30-a ən ehtimallılar düşsün.
      const ordered = rankLikeGoogle(dedupe([...pool, ...aiPool]), q, 30, siteOrder);
      const ranked = await aiRankResults(q, ordered);
      if (ranked) {
        const results = ranked.slice(0, MAX_RESULTS);
        console.log('[webSearch] məhsul sorğu (AI):', q, '| namizəd:', ordered.length, '| göstərilən:', results.length);
        return {
          ok: true, mode: 'product',
          summary: results.length ? '' : `"${q}" üçün uyğun elan tapılmadı.`,
          results,
        };
      }
    }
  }

  if (!pool.length) {
    if (tavError) return { ...EMPTY, error: tavError };
    return { ok: true, mode: 'product', summary: '', results: [] };
  }

  const results = rankLikeGoogle(dedupe(pool), q, MAX_RESULTS, siteOrder);
  console.log('[webSearch] məhsul sorğu:', q, '| maşın:', shop.isCar, '| saytlar:', shop.results.length,
    '| tavily:', tavCount, '| göstərilən:', results.length);
  return { ok: true, mode: 'product', summary: '', results };
}

// ── Claude yolu (ehtiyat — Tavily açarı yoxdursa) ─────────────────────────────
async function webSearchClaude(q: string): Promise<WebSearchResponse> {
  const ai = getClient();
  if (!ai) return { ...EMPTY, error: 'İnternet axtarışı konfiqurasiya edilməyib.' };

  console.log('[webSearch] Claude (ehtiyat) başladı — sorğu:', q, '| model:', AI_MODEL);

  // Alət konfiqurasiyaları — sıra ilə sınanır. Yeni versiya (dinamik filtr +
  // user_location + blocked_domains) hesabda dəstəklənmirsə, sadə versiyaya
  // düşürük ki, axtarış tamamilə sıradan çıxmasın.
  const TOOL_VARIANTS: any[] = [
    {
      type: 'web_search_20260209', name: 'web_search', max_uses: 10,
      user_location: { type: 'approximate', country: 'AZ', city: 'Baku', timezone: 'Asia/Baku' },
      blocked_domains: BLOCKED_DOMAINS,
    },
    { type: 'web_search_20260209', name: 'web_search', max_uses: 10 },
    {
      type: 'web_search_20250305', name: 'web_search', max_uses: 10,
      user_location: { type: 'approximate', country: 'AZ', city: 'Baku', timezone: 'Asia/Baku' },
    },
    { type: 'web_search_20250305', name: 'web_search', max_uses: 10 },
  ];

  let text = '';
  let lastError: any = null;

  for (let v = 0; v < TOOL_VARIANTS.length && !text; v++) {
    const messages: any[] = [{ role: 'user', content: prompt(q) }];
    try {
      // Server aləti işləyərkən model `pause_turn` ilə dayana bilər —
      // bu halda cavabı geri göndərib davam etdiririk.
      for (let i = 0; i < 6; i++) {
        const res: any = await ai.messages.create({
          model: AI_MODEL,
          max_tokens: 3000,
          system: SYSTEM,
          tools: [TOOL_VARIANTS[v]],
          messages,
        });
        if (res.stop_reason === 'refusal') return { ...EMPTY, error: 'Bu sorğu üçün axtarış edilə bilmədi.' };
        if (res.stop_reason === 'pause_turn') {
          messages.push({ role: 'assistant', content: res.content });
          continue;
        }
        text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
        break;
      }
      if (v > 0 && text) console.warn('[webSearch] alət variantı', v, 'ilə işlədi:', TOOL_VARIANTS[v].type);
    } catch (e: any) {
      lastError = e;
      // Provayder xəta mətni kənara sızdırılmır — yalnız daxili log.
      // Səbəbi ayırd etmək üçün: açar, model adı və ya alət versiyası problemi.
      console.error('[webSearch] variant', v, TOOL_VARIANTS[v].type, 'xəta:',
        e?.status, e?.name, e?.message, e?.error ? JSON.stringify(e.error).slice(0, 400) : '');
      // 400 = alət/parametr qəbul edilmədi → növbəti varianta keç.
      // Digər xətalarda (401/429/5xx) variant dəyişmək kömək etmir.
      if (e?.status !== 400) break;
    }
  }

  if (!text && lastError) {
    const st = lastError?.status;
    const msg = st === 401 ? 'AI açarı etibarsızdır.'
      : st === 429 ? 'Axtarış limiti doldu, bir azdan yenidən cəhd edin.'
      : st === 404 ? 'AI modeli əlçatan deyil.'
      : 'İnternet axtarışı alınmadı. Yenidən cəhd edin.';
    return { ...EMPTY, error: msg };
  }


  if (!text) {
    console.error('[webSearch] boş cavab (pause_turn limiti?) — sorğu:', q);
    return { ...EMPTY, error: 'Axtarış tamamlanmadı. Yenidən cəhd edin.' };
  }

  const parsed = parseJson(text);
  if (!parsed) {
    console.error('[webSearch] JSON oxunmadı — sorğu:', q, '| cavabın başı:', text.slice(0, 200));
    return { ...EMPTY, error: 'Nəticələr oxunmadı.' };
  }

  const raw: any[] = Array.isArray(parsed.results) ? parsed.results : [];
  const results: WebResult[] = Array.isArray(parsed.results)
    ? parsed.results
        // Son güvənlik qatı: model qaydanı pozsa belə, Azərbaycana aid
        // olmayan nəticə buraxılmır. "az_reason" daxili yoxlama üçündür,
        // istifadəçiyə göndərilmir.
        .filter((r: any) => r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url) && isAzResult(r.url))
        .map((r: any) => {
          // Qiyməti yalnız təmiz rəqəm kimi qəbul edirik; "1.250 AZN" kimi
          // mətn gəlsə də rəqəmə çeviririk, alınmasa null.
          let price: number | null = null;
          if (typeof r.price === 'number' && Number.isFinite(r.price) && r.price > 0) {
            price = r.price;
          } else if (typeof r.price === 'string') {
            // Xarici valyuta (USD/EUR/RUB) AZN kimi göstərilməməlidir — belə
            // qiyməti atırıq, əks halda "1500 $" ucuz AZN kimi sıralanardı.
            const foreign = /[$€₽]|usd|eur|dollar|avro|rub/i.test(r.price);
            if (!foreign) {
              const n = parseFloat(r.price.replace(/[^\d.,]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
              if (Number.isFinite(n) && n > 0) price = n;
            }
          }
          let site = String(r.site || '').trim().toLowerCase();
          if (!site) { try { site = new URL(r.url).hostname.replace(/^www\./, ''); } catch { site = ''; } }
          return {
            title: String(r.title || r.url).slice(0, 160),
            url: String(r.url),
            snippet: String(r.snippet || '').slice(0, 300),
            price,
            site: site.slice(0, 60),
          };
        })
        // Ucuzdan bahaya. Qiyməti bilinməyənlər sona düşür.
        .sort((a: WebResult, b: WebResult) => {
          if (a.price == null && b.price == null) return 0;
          if (a.price == null) return 1;
          if (b.price == null) return -1;
          return a.price - b.price;
        })
        .slice(0, 6)   // sıralamadan SONRA kəsirik ki, ən ucuzlar itməsin
    : [];

  // Model nəticə tapıb, amma hamısı Azərbaycan filtrindən keçməyibsə —
  // bunu "heç nə tapılmadı"dan fərqləndiririk (həm log, həm istifadəçi üçün).
  if (raw.length > 0 && results.length === 0) {
    console.warn('[webSearch] bütün nəticələr AZ filtrindən keçmədi — sorğu:', q,
      '| atılan:', raw.map((r: any) => r?.url).filter(Boolean).join(', ').slice(0, 300));
    return {
      ok: true,
      mode: 'product',
      summary: 'Nəticələr tapıldı, amma Azərbaycana aid olmadığı üçün göstərilmədi.',
      results: [],
    };
  }

  console.log('[webSearch] sorğu:', q, '| model:', raw.length, '| AZ filtrindən keçən:', results.length);

  // Nəticə yoxdursa modelin öz izahını (məs. "limit aşıldı") istifadəçiyə
  // göstərmirik — qarışıq və narahatedicidir. Sadə mesaj kifayətdir.
  if (results.length === 0) return { ok: true, mode: 'product', summary: '', results: [] };

  return {
    ok: true,
    mode: 'product',
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 400) : '',
    results,
  };
}

// Məhsul axtarışı AZ saytlarında birbaşa aparıldığı üçün açar tələb etmir.
export function webSearchEnabled(): boolean {
  return true;
}

// Admin test — konkret axtarış motorunu (flag-dan asılı olmadan) sınaqdan keçirir.
// Nəticəni birbaşa qaytarır ki, admin motorun işlədiyini gözlə görsün.
export async function runWebSearchTest(engine: 'tavily' | 'claude' | 'person', q: string): Promise<WebSearchResponse> {
  if (engine === 'person') return webSearchPerson(q);
  if (engine === 'claude') return webSearchClaude(q);
  return webSearchProducts(q, true);
}
