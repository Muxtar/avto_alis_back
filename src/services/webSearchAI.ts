// Saytdaxili axtarış nəticə vermədikdə internetdən axtarış — Claude (Anthropic)
// web_search server aləti ilə. İstifadəçi başlıqdakı axtarışda məhsul və ya
// otel adı yazır; saytda tapılmazsa nəticələr internetdən gətirilir.
//
// ANTHROPIC_API_KEY mühit dəyişəni tələb olunur (Railway → Variables).

import Anthropic from '@anthropic-ai/sdk';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  ok: boolean;
  summary: string;      // qısa Azərbaycanca xülasə
  results: WebResult[];
  error?: string;
}

const EMPTY: WebSearchResponse = { ok: false, summary: '', results: [] };

const AI_MODEL = process.env.WEB_SEARCH_MODEL || 'claude-opus-4-8';

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
  'tap.az', 'turbo.az', 'bina.az', 'umico.az', 'kontakt.az', 'irshad.az',
  'bakuelectronics.az', 'birmarket.az', 'trendyol.az',
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

Cavab dili: Azərbaycan dili.`;

function prompt(query: string): string {
  return `İstifadəçi bizim saytda "${query}" axtardı, saytda uyğun elan tapılmadı.

Bunu internetdə axtar və Azərbaycanda mövcud olan ən uyğun 4-6 nəticəni tap.
Axtararkən sorğuya "Azərbaycan" və ya "Bakı" kimi yer göstəricisi əlavə et.

Nəticə tipləri (sorğuya uyğun olanı seç):
- Məhsuldursa: Azərbaycan mağazalarının məhsul səhifələri
- Otel/məkandırsa: rəsmi sayt və ya rezervasiya səhifəsi (Azərbaycandakı obyekt)
- Xidmətdirsə: xidməti Azərbaycanda göstərən şirkətin səhifəsi

Axtarışı bitirdikdən sonra YALNIZ bu JSON-u qaytar, başqa heç nə yazma:
{
  "summary": "1-2 cümlə Azərbaycan dilində qısa xülasə",
  "results": [
    {
      "title": "səhifənin başlığı",
      "url": "tam https ünvan",
      "snippet": "1 cümlə izah — nə olduğu və Azərbaycanla əlaqəsi",
      "az_reason": "niyə bu nəticə Azərbaycana aiddir (qısa)"
    }
  ]
}

Qeyd: "az_reason"-u özün üçün yaz — hər nəticəni siyahıya salmadan əvvəl onun
Azərbaycanla əlaqəsini yoxla. Əlaqəni izah edə bilmirsənsə, nəticəni at.`;
}

/**
 * Sorğunu internetdə axtarır və struktur nəticələr qaytarır.
 * @param query istifadəçinin axtarış mətni
 */
export async function webSearch(query: string): Promise<WebSearchResponse> {
  const ai = getClient();
  if (!ai) return { ...EMPTY, error: 'İnternet axtarışı konfiqurasiya edilməyib.' };

  const q = query.trim().slice(0, 200);
  if (!q) return { ...EMPTY, error: 'Axtarış mətni boşdur.' };

  const messages: any[] = [{ role: 'user', content: prompt(q) }];
  let text = '';

  try {
    // Server aləti (web_search) işləyərkən model `pause_turn` ilə dayana bilər —
    // bu halda cavabı geri göndərib davam etdiririk (maks. 3 dəfə).
    for (let i = 0; i < 4; i++) {
      const res: any = await ai.messages.create({
        model: AI_MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        tools: [{
          type: 'web_search_20260209',
          name: 'web_search',
          max_uses: 5,
          // Axtarış motoru nəticələri Azərbaycana görə sıralasın.
          user_location: { type: 'approximate', country: 'AZ', city: 'Baku', timezone: 'Asia/Baku' },
          blocked_domains: BLOCKED_DOMAINS,
        } as any],
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
  } catch (e: any) {
    // Provayder xəta mətni kənara sızdırılmır — yalnız daxili log.
    console.error('[webSearch] failed:', e?.message);
    return { ...EMPTY, error: 'İnternet axtarışı alınmadı. Yenidən cəhd edin.' };
  }

  const parsed = parseJson(text);
  if (!parsed) return { ...EMPTY, error: 'Nəticələr oxunmadı.' };

  const results: WebResult[] = Array.isArray(parsed.results)
    ? parsed.results
        // Son güvənlik qatı: model qaydanı pozsa belə, Azərbaycana aid
        // olmayan nəticə buraxılmır. "az_reason" daxili yoxlama üçündür,
        // istifadəçiyə göndərilmir.
        .filter((r: any) => r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url) && isAzResult(r.url))
        .slice(0, 6)
        .map((r: any) => ({
          title: String(r.title || r.url).slice(0, 160),
          url: String(r.url),
          snippet: String(r.snippet || '').slice(0, 300),
        }))
    : [];

  return {
    ok: true,
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 400) : '',
    results,
  };
}

export function webSearchEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
