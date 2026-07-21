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

function prompt(query: string): string {
  return `İstifadəçi bizim elan saytında "${query}" axtardı, amma saytda uyğun nəticə tapılmadı.
İnternetdə axtar və bu sorğuya ən uyğun 4-6 nəticə tap (məhsul səhifəsi, otel/məkan səhifəsi, rəsmi sayt və s.).
Mümkünsə Azərbaycan üçün aktual mənbələrə üstünlük ver.

Axtarışı bitirdikdən sonra YALNIZ bu JSON formatında cavab ver, başqa heç nə yazma:
{
  "summary": "1-2 cümlə Azərbaycan dilində qısa xülasə",
  "results": [
    { "title": "başlıq", "url": "tam https ünvan", "snippet": "1 cümlə izah (Azərbaycan dilində)" }
  ]
}

Qeydlər:
- "url" mütləq axtarış nəticəsindən gələn real ünvan olsun, uydurma yazma.
- Nəticə tapılmazsa "results" boş massiv olsun və "summary"-də bunu bildir.`;
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
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 } as any],
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
        .filter((r: any) => r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url))
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
