// Şəkillə axtarış — Claude (Anthropic) vision ilə.
//
// İstifadəçi başlıqdakı axtarış sahəsinə şəkil yükləyəndə, bu servis şəkildəki
// əsas məhsulu tanıyır və qısa axtarış sorğusu (marka + model + məhsul növü)
// qaytarır. Frontend həmin sorğu ilə /elanlar?search=... səhifəsinə keçir.
//
// ANTHROPIC_API_KEY mühit dəyişəni tələb olunur (Railway → Variables).

import Anthropic from '@anthropic-ai/sdk';

export interface VisionSearchResult {
  ok: boolean;
  query: string;          // hazır axtarış sorğusu
  productType: string | null;
  brand: string | null;
  category: string | null;
  keywords: string[];
  error?: string;
}

const EMPTY: VisionSearchResult = {
  ok: false, query: '', productType: null, brand: null, category: null, keywords: [],
};

// Model env ilə dəyişilə bilər (xərc/keyfiyyət balansı).
const AI_MODEL = process.env.VISION_SEARCH_MODEL || 'claude-opus-4-8';

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

// Model cavabındakı JSON-u çıxarır (bəzən ```json ... ``` ilə bükülür).
function parseJson(text: string): any | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : (text.match(/\{[\s\S]*\}/)?.[0] || text);
  try { return JSON.parse(candidate); } catch { return null; }
}

const PROMPT = `Bu şəkildəki ƏSAS məhsulu tanı. Bu, ümumi bir elan saytıdır — istənilən məhsul ola bilər
(telefon, geyim, mebel, avtomobil, ehtiyat hissəsi, məişət texnikası, uşaq malları və s.).

YALNIZ bu JSON formatında cavab ver, başqa heç nə yazma:
{
  "query": "2-4 sözlük Azərbaycan dilində axtarış sorğusu (marka + model + məhsul növü)",
  "productType": "məhsulun növü və ya null",
  "brand": "marka və ya null",
  "category": "kateqoriya (Elektronika, Geyim, Nəqliyyat, Ev və bağ, Uşaq aləmi və s.) və ya null",
  "keywords": ["əlavə", "açar", "sözlər"]
}

Qeydlər:
- "query" ən vacib sahədir: qısa, konkret və axtarışa yararlı olsun (məsələn "iPhone 13 telefon", "uşaq velosipedi", "dəri divan").
- Marka və ya model dəqiq bilinmirsə, sadəcə məhsulun növünü yaz.
- Tapılmayan sahəni null qoy.`;

/**
 * Şəkildən axtarış sorğusu çıxarır.
 * @param imageBase64 base64 kodlanmış şəkil (JPEG)
 * @param mimeType    şəklin MIME tipi (default: image/jpeg)
 */
export async function imageToSearchQuery(
  imageBase64: string,
  mimeType = 'image/jpeg',
): Promise<VisionSearchResult> {
  const ai = getClient();
  if (!ai) return { ...EMPTY, error: 'Şəkilli axtarış konfiqurasiya edilməyib.' };

  let text: string;
  try {
    const res = await ai.messages.create({
      model: AI_MODEL,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType as any, data: imageBase64 } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });
    if (res.stop_reason === 'refusal') return { ...EMPTY, error: 'Bu şəkil analiz edilə bilmədi.' };
    text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  } catch (e: any) {
    // Provayder xəta mətnini kənara sızdırmırıq — yalnız daxili log.
    console.error('[imageToSearchQuery] vision API failed:', e?.message);
    return { ...EMPTY, error: 'Şəkilli axtarış uğursuz oldu. Yenidən cəhd edin.' };
  }

  const parsed = parseJson(text);
  if (!parsed) return { ...EMPTY, error: 'Şəkil oxundu, amma nəticə anlaşılmadı.' };

  const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const query = str(parsed.query)
    || [str(parsed.brand), str(parsed.productType)].filter(Boolean).join(' ')
    || '';
  if (!query) return { ...EMPTY, error: 'Şəkildə tanınan məhsul tapılmadı.' };

  return {
    ok: true,
    query,
    productType: str(parsed.productType),
    brand: str(parsed.brand),
    category: str(parsed.category),
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((k: any) => typeof k === 'string') : [],
  };
}

// ANTHROPIC_API_KEY varsa Claude ilə şəkilli axtarış mümkündür.
export function visionSearchEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
