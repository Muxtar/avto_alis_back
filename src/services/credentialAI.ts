// Peşə sənədlərinin (diplom, sertifikat, lisenziya) AI analizi — Claude (Anthropic).
//
// Əsas məqsəd: sənəddəki ad-soyadın istifadəçinin qeydiyyat ad-soyadı ilə
// uyğun olduğunu yoxlamaq. Əlavə olaraq sənədin tipini, kim verdiyini,
// məsləklə uyğunluğunu və saxtakarlıq əlamətlərini çıxarır.
//
// ANTHROPIC_API_KEY mühit dəyişəni tələb olunur (Railway → Variables).

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

export interface CredentialAnalysis {
  ok: boolean;                 // analiz uğurla tamamlandı?
  documentType: string | null; // diplom / sertifikat / lisenziya / digər
  issuer: string | null;       // kim verib (universitet, qurum)
  holderName: string | null;   // sənəddə yazılmış ad-soyad
  nameMatch: boolean;          // istifadəçinin ad-soyadı ilə uyğundur?
  nameMatchScore: number;      // 0..1 uyğunluq balı
  professionMatch: boolean | null; // məsləklə uyğundur? (məslək verilibsə)
  confidence: number;          // 0..1 ümumi etibarlılıq
  fraudSignals: string[];      // saxtakarlıq əlamətləri
  reason: string;              // qısa izah (Azərbaycanca)
  error?: string;
}

const EMPTY: CredentialAnalysis = {
  ok: false, documentType: null, issuer: null, holderName: null,
  nameMatch: false, nameMatchScore: 0, professionMatch: null,
  confidence: 0, fraudSignals: [], reason: '',
};

// ə→e, ı→i kimi normallaşdırma + boşluq/registr təmizliyi — ad müqayisəsində kömək edir.
function normalizeName(s: string): string {
  return s
    .toLocaleLowerCase('az')
    .replace(/ə/g, 'e').replace(/ı/g, 'i').replace(/ö/g, 'o')
    .replace(/ü/g, 'u').replace(/ç/g, 'c').replace(/ş/g, 's').replace(/ğ/g, 'g')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Model env ilə dəyişilə bilər (xərc/keyfiyyət balansı). Default: ən güclü vision modeli.
// Daha ucuz üçün Railway-də CREDENTIAL_AI_MODEL=claude-sonnet-4-6 qoyula bilər.
const AI_MODEL = process.env.CREDENTIAL_AI_MODEL || 'claude-opus-4-8';

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Sənədi Claude ilə analiz edir və ad-soyad uyğunluğunu yoxlayır.
 * @param filePath   uploads/ içindəki JPEG faylının tam yolu
 * @param expectedName  istifadəçinin qeydiyyat ad-soyadı
 * @param profession  istifadəçinin məsləyi (varsa)
 */
export async function analyzeCredential(
  filePath: string,
  expectedName: string,
  profession?: string | null,
): Promise<CredentialAnalysis> {
  const ai = getClient();
  if (!ai) {
    return { ...EMPTY, error: 'AI açarı (ANTHROPIC_API_KEY) qoyulmayıb — admin əl ilə yoxlayacaq.' };
  }

  let base64: string;
  try {
    base64 = (await fs.promises.readFile(filePath)).toString('base64');
  } catch {
    return { ...EMPTY, error: 'Sənəd faylı oxunmadı.' };
  }

  const prompt = `Sən rəsmi sənədləri yoxlayan analitiksən. Sənə bir peşə sənədinin (diplom, sertifikat, lisenziya və s.) şəkli verilir.

İstifadəçinin qeydiyyatda göstərdiyi ad-soyad: "${expectedName}"${profession ? `\nİstifadəçinin bildirdiyi məslək: "${profession}"` : ''}

Şəkli diqqətlə analiz et və YALNIZ aşağıdakı JSON formatında cavab ver (başqa heç nə yazma):
{
  "documentType": "diplom | sertifikat | lisenziya | digər | naməlum",
  "issuer": "sənədi verən qurumun adı və ya null",
  "holderName": "sənəddə yazılmış şəxsin tam ad-soyadı və ya null",
  "nameMatch": true/false,        // holderName istifadəçinin ad-soyadı ilə eyni şəxsə aiddirmi
  "nameMatchScore": 0.0-1.0,      // ad uyğunluğu (transliterasiya/ad sırası fərqlərini nəzərə al)
  "professionMatch": true/false/null,  // sənəd bildirilən məsləklə uyğundurmu (məslək verilməyibsə null)
  "confidence": 0.0-1.0,          // sənədin əsl və oxunaqlı olmasına ümumi əminlik
  "fraudSignals": ["..."],        // saxtakarlıq/dəyişdirilmə əlamətləri (yoxdursa boş massiv)
  "reason": "Azərbaycan dilində 1-2 cümlə qısa izah"
}

Qeyd: ad-soyad müqayisəsində Azərbaycan hərflərinin transliterasiyasını (ə↔e), ad/soyad sırasını və orta adları nəzərə al. Şəkildə üz/şəkil yoxdursa bu normaldır — yalnız mətndəki adı müqayisə et.`;

  let text: string;
  try {
    const res = await ai.messages.create({
      model: AI_MODEL,
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    });
    text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  } catch (e: any) {
    return { ...EMPTY, error: `AI analizi alınmadı: ${e?.message || 'naməlum xəta'}` };
  }

  // JSON-u çıxar (model bəzən ```json ... ``` ilə bükür).
  const jsonStr = (() => {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) return fence[1].trim();
    const brace = text.match(/\{[\s\S]*\}/);
    return brace ? brace[0] : text;
  })();

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { ...EMPTY, error: 'AI cavabı oxunmadı.', reason: text.slice(0, 200) };
  }

  const clamp01 = (n: any) => { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; };

  // Modelin ad qiymətini öz lokal müqayisəmizlə də gücləndiririk (etibarlılıq üçün).
  const holderName: string | null = typeof parsed.holderName === 'string' ? parsed.holderName : null;
  let localScore = clamp01(parsed.nameMatchScore);
  if (holderName && expectedName) {
    const a = new Set(normalizeName(expectedName).split(' ').filter(Boolean));
    const b = new Set(normalizeName(holderName).split(' ').filter(Boolean));
    if (a.size && b.size) {
      let common = 0;
      a.forEach((w) => { if (b.has(w)) common++; });
      const overlap = common / Math.max(a.size, b.size);
      // Model balı ilə lokal balın daha yüksəyini götürürük.
      localScore = Math.max(localScore, overlap);
    }
  }

  return {
    ok: true,
    documentType: typeof parsed.documentType === 'string' ? parsed.documentType : null,
    issuer: typeof parsed.issuer === 'string' ? parsed.issuer : null,
    holderName,
    nameMatch: Boolean(parsed.nameMatch) || localScore >= 0.6,
    nameMatchScore: localScore,
    professionMatch: typeof parsed.professionMatch === 'boolean' ? parsed.professionMatch : null,
    confidence: clamp01(parsed.confidence),
    fraudSignals: Array.isArray(parsed.fraudSignals) ? parsed.fraudSignals.map(String).slice(0, 10) : [],
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}

// ---- Kimlik doğrulaması: şəxsiyyət vəsiqəsi + selfie ----

export interface IdentityAnalysis {
  ok: boolean;
  idName: string | null;       // vəsiqədəki ad-soyad
  nameMatch: boolean;          // qeydiyyat ad-soyadı ilə uyğun?
  nameMatchScore: number;      // 0..1
  faceMatch: boolean;          // vəsiqə şəkli ilə selfie eyni şəxs?
  faceMatchScore: number;      // 0..1 (AI əminliyi)
  documentValid: boolean;      // vəsiqə əsl və oxunaqlı görünür?
  fraudSignals: string[];
  reason: string;
  error?: string;
}

const EMPTY_ID: IdentityAnalysis = {
  ok: false, idName: null, nameMatch: false, nameMatchScore: 0,
  faceMatch: false, faceMatchScore: 0, documentValid: false, fraudSignals: [], reason: '',
};

/**
 * Şəxsiyyət vəsiqəsi + selfie şəkillərini Claude ilə yoxlayır:
 *  1) vəsiqədəki ad-soyad qeydiyyat ad-soyadı ilə uyğundurmu,
 *  2) vəsiqədəki üz selfie ilə eyni şəxsə aiddirmi.
 */
export async function verifyIdentityAI(
  idCardPath: string,
  selfiePath: string,
  expectedName: string,
): Promise<IdentityAnalysis> {
  const ai = getClient();
  if (!ai) return { ...EMPTY_ID, error: 'AI açarı (ANTHROPIC_API_KEY) qoyulmayıb — admin əl ilə yoxlayacaq.' };

  let idB64: string, selfieB64: string;
  try {
    [idB64, selfieB64] = await Promise.all([
      fs.promises.readFile(idCardPath).then((b) => b.toString('base64')),
      fs.promises.readFile(selfiePath).then((b) => b.toString('base64')),
    ]);
  } catch {
    return { ...EMPTY_ID, error: 'Şəkillər oxunmadı.' };
  }

  const prompt = `Sən kimlik doğrulaması aparan analitiksən. Sənə İKİ şəkil verilir:
1-ci şəkil — şəxsiyyət vəsiqəsi (üzərində ad-soyad və şəxsin fotosu var).
2-ci şəkil — həmin şəxsin canlı selfisi.

İstifadəçinin qeydiyyatda göstərdiyi ad-soyad: "${expectedName}"

Hər iki şəkli diqqətlə analiz et və YALNIZ bu JSON formatında cavab ver (başqa heç nə yazma):
{
  "idName": "vəsiqədəki tam ad-soyad və ya null",
  "nameMatch": true/false,        // vəsiqədəki ad istifadəçinin ad-soyadı ilə eyni şəxsdirmi
  "nameMatchScore": 0.0-1.0,      // ad uyğunluğu (transliterasiya/ad sırasını nəzərə al)
  "faceMatch": true/false,        // vəsiqədəki foto ilə selfidəki üz eyni şəxsdirmi
  "faceMatchScore": 0.0-1.0,      // üz uyğunluğuna əminlik
  "documentValid": true/false,    // vəsiqə əsl, oxunaqlı və dəyişdirilməmiş görünürmü
  "fraudSignals": ["..."],        // saxtakarlıq/montaj əlamətləri (yoxdursa boş massiv)
  "reason": "Azərbaycan dilində 1-2 cümlə qısa izah"
}

Qeyd: Azərbaycan hərflərinin transliterasiyasını (ə↔e) və ad/soyad sırasını nəzərə al. Üz müqayisəsində işıq, bucaq və yaş fərqlərini nəzərə al — kiçik fərqlər normaldır.`;

  let text: string;
  try {
    const res = await ai.messages.create({
      model: AI_MODEL,
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: idB64 } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: selfieB64 } },
          { type: 'text', text: prompt },
        ],
      }],
    });
    text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  } catch (e: any) {
    return { ...EMPTY_ID, error: `AI analizi alınmadı: ${e?.message || 'naməlum xəta'}` };
  }

  const jsonStr = (() => {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) return fence[1].trim();
    const brace = text.match(/\{[\s\S]*\}/);
    return brace ? brace[0] : text;
  })();

  let parsed: any;
  try { parsed = JSON.parse(jsonStr); }
  catch { return { ...EMPTY_ID, error: 'AI cavabı oxunmadı.', reason: text.slice(0, 200) }; }

  const clamp01 = (n: any) => { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; };

  const idName: string | null = typeof parsed.idName === 'string' ? parsed.idName : null;
  let nameScore = clamp01(parsed.nameMatchScore);
  if (idName && expectedName) {
    const a = new Set(normalizeName(expectedName).split(' ').filter(Boolean));
    const b = new Set(normalizeName(idName).split(' ').filter(Boolean));
    if (a.size && b.size) {
      let common = 0; a.forEach((w) => { if (b.has(w)) common++; });
      nameScore = Math.max(nameScore, common / Math.max(a.size, b.size));
    }
  }

  return {
    ok: true,
    idName,
    nameMatch: Boolean(parsed.nameMatch) || nameScore >= 0.6,
    nameMatchScore: nameScore,
    faceMatch: Boolean(parsed.faceMatch),
    faceMatchScore: clamp01(parsed.faceMatchScore),
    documentValid: Boolean(parsed.documentValid),
    fraudSignals: Array.isArray(parsed.fraudSignals) ? parsed.fraudSignals.map(String).slice(0, 10) : [],
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}
