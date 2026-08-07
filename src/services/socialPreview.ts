// Sosial profil önizləməsi — profilin ADINI və ŞƏKLİNİ pulsuz gətirir.
//
// Necə: sosial şəbəkələr paylaşım önizləməsi üçün səhifəyə `og:image` və `og:title`
// meta etiketləri qoyur və bunları KRAULER User-Agent-inə verir (brauzer UA-sına yox).
// Biz də serverdə həmin səhifəni krauler kimi çəkib meta etiketləri oxuyuruq.
// Test edilib və işləyir: Instagram, Facebook, TikTok, LinkedIn, Telegram.
//
// Apify TƏLƏB OLUNMUR. (Apify qoşulubsa daha zəngin məlumat — izləyici sayı və s. — verir.)

const CRAWLER_UA = 'facebookexternalhit/1.1 (+https://www.facebook.com/externalhit_uatext.php)';
const TIMEOUT_MS = 9000;
const MAX_HTML_BYTES = 400 * 1024;   // meta etiketlər səhifənin başındadır — hamısını oxumağa ehtiyac yoxdur

export interface SocialPreview {
  name: string | null;
  avatarUrl: string | null;
}

// ── Keş ──
interface Entry { at: number; data: SocialPreview | null }
const cache = new Map<string, Entry>();
const TTL_MS = 12 * 60 * 60 * 1000;  // 12 saat
const MAX_ENTRIES = 500;
function cacheGet(k: string) {
  const h = cache.get(k);
  if (!h) return undefined;
  if (Date.now() - h.at > TTL_MS) { cache.delete(k); return undefined; }
  return h.data;
}
function cacheSet(k: string, d: SocialPreview | null) {
  cache.delete(k);
  cache.set(k, { at: Date.now(), data: d });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// HTML entity-lərini aç (&amp; &#064; &#x2022; və s.).
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

// <meta property="og:xxx" content="..."> — atribut sırası dəyişə bilər, hər iki hal yoxlanır.
function metaContent(html: string, prop: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeEntities(m[1]).trim();
  }
  return null;
}

// og:title-dan şəxsin adını təmizlə (platformaya görə format fərqlidir).
function cleanName(title: string | null, platform: string): string | null {
  if (!title) return null;
  let s = decodeEntities(title).trim();
  // "Ad (@handle) • Instagram photos and videos" → "Ad"
  s = s.replace(/\s*\(@[^)]*\).*$/, '');
  // "Ad on TikTok" / "Ad | TikTok" / "Ad – Telegram" / "Ad / X"
  s = s.replace(/\s+on (TikTok|Instagram|Facebook|X|Twitter)\s*$/i, '');
  s = s.replace(/\s*[|·–—/]\s*(TikTok|Instagram|Facebook|LinkedIn|Telegram|X|Twitter)\s*$/i, '');
  // LinkedIn: "Ad - Vəzifə, Şirkət" → yalnız ad hissəsi
  if (platform === 'linkedin' && s.includes(' - ')) s = s.split(' - ')[0];
  // Telegram: "Telegram: Contact @handle" → ad yoxdur
  if (/^Telegram:\s*Contact/i.test(s)) return null;
  s = s.trim();
  return s.length >= 2 && s.length <= 80 ? s : null;
}

/**
 * Profil səhifəsindən ad + şəkil çəkir. Alınmasa null qaytarır (axtarış pozulmur).
 */
export async function fetchPreview(url: string, platform = ''): Promise<SocialPreview | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const key = url;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': CRAWLER_UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'az,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) { cacheSet(key, null); return null; }

    // Səhifənin yalnız başlanğıcını oxu — meta etiketlər <head>-dədir.
    const reader = res.body?.getReader();
    let html = '';
    if (reader) {
      const dec = new TextDecoder();
      let total = 0;
      while (total < MAX_HTML_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        html += dec.decode(value, { stream: true });
        if (/og:image/i.test(html) && /og:title/i.test(html)) break;  // lazım olan tapıldı
      }
      reader.cancel().catch(() => {});
    } else {
      html = (await res.text()).slice(0, MAX_HTML_BYTES);
    }

    const avatarUrl = metaContent(html, 'og:image');
    const name = cleanName(metaContent(html, 'og:title'), platform);
    const data: SocialPreview | null = (avatarUrl || name) ? { name, avatarUrl } : null;
    cacheSet(key, data);
    return data;
  } catch (e: any) {
    console.error('[socialPreview]', url.slice(0, 60), e?.name || e?.message);
    cacheSet(key, null);
    return null;
  }
}

/**
 * Bir neçə profili paralel çəkir (maks. `limit` ədəd).
 * URL → önizləmə xəritəsi qaytarır; uğursuzlar sadəcə olmur.
 */
export async function fetchPreviews(
  targets: { url: string; platform?: string }[],
  limit = 8,
): Promise<Map<string, SocialPreview>> {
  const out = new Map<string, SocialPreview>();
  const slice = targets.slice(0, limit);
  if (!slice.length) return out;
  const settled = await Promise.allSettled(slice.map((t) => fetchPreview(t.url, t.platform || '')));
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) out.set(slice[i].url, r.value);
  });
  return out;
}
