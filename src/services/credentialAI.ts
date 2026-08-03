// Peşə sənədlərinin (diplom, sertifikat, lisenziya) AI analizi — Claude (Anthropic).
//
// Əsas məqsəd: sənəddəki ad-soyadın istifadəçinin qeydiyyat ad-soyadı ilə
// uyğun olduğunu yoxlamaq. Əlavə olaraq sənədin tipini, kim verdiyini,
// məsləklə uyğunluğunu və saxtakarlıq əlamətlərini çıxarır.
//
// ANTHROPIC_API_KEY mühit dəyişəni tələb olunur (Railway → Variables).

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import { resolveFlag } from './settings';

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
export function normalizeName(s: string): string {
  return s
    .toLocaleLowerCase('az')
    .replace(/ə/g, 'e').replace(/ı/g, 'i').replace(/ö/g, 'o')
    .replace(/ü/g, 'u').replace(/ç/g, 'c').replace(/ş/g, 's').replace(/ğ/g, 'g')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// İki adın söz-örtüşmə balı (0..1) — transliterasiya/ad sırası nəzərə alınır.
export function nameOverlapScore(a: string, b: string): number {
  const sa = new Set(normalizeName(a || '').split(' ').filter(Boolean));
  const sb = new Set(normalizeName(b || '').split(' ').filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  let common = 0; sa.forEach((w) => { if (sb.has(w)) common++; });
  return common / Math.max(sa.size, sb.size);
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

// Faylı Claude content blokuna çevirir — PDF üçün "document", şəkil üçün "image".
async function fileToContentBlock(path: string): Promise<any> {
  const data = (await fs.promises.readFile(path)).toString('base64');
  if (/\.pdf$/i.test(path)) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } };
}

// JSON cavabını mətndən çıxarır (model bəzən ```json ... ``` ilə bükür).
function parseJson(text: string): any | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : (text.match(/\{[\s\S]*\}/)?.[0] || text);
  try { return JSON.parse(candidate); } catch { return null; }
}

export interface BusinessInfoResult {
  ok: boolean;
  companyName: string | null;
  voen: string | null;
  ownerName: string | null;   // rəhbər / sahib
  founderName: string | null; // təsisçi
  error?: string;
}

/**
 * Vergi qeydiyyatı sənədindən (şəkil və ya PDF) şirkət məlumatlarını oxuyur:
 * şirkət adı, VÖEN, rəhbər/sahib, təsisçi — biznes formasını avtomatik doldurmaq üçün.
 */
export async function extractBusinessInfo(docPath: string): Promise<BusinessInfoResult> {
  const EMPTY: BusinessInfoResult = { ok: false, companyName: null, voen: null, ownerName: null, founderName: null };
  const ai = getClient();
  if (!ai) return { ...EMPTY, error: 'AI açarı qoyulmayıb.' };
  if (!(await resolveFlag('ai_business_docs'))) return { ...EMPTY, error: 'Biznes sənəd AI-ı deaktivdir — admin əl ilə yoxlayacaq.' };

  let block: any;
  try { block = await fileToContentBlock(docPath); }
  catch { return { ...EMPTY, error: 'Sənəd oxunmadı.' }; }

  const prompt = `Bu, bir şirkətin vergi qeydiyyatı / qeydiyyat sənədidir (şəkil və ya PDF). Sənəddən şirkət məlumatlarını oxu.
YALNIZ bu JSON formatında cavab ver (başqa heç nə yazma):
{
  "companyName": "şirkətin tam adı və ya null",
  "voen": "VÖEN (vergi ödəyicisinin eyniləşdirmə nömrəsi) və ya null",
  "ownerName": "rəhbər / direktor / sahibin ad-soyadı və ya null",
  "founderName": "təsisçinin ad-soyadı və ya null"
}
Qeyd: VÖEN adətən 10 rəqəmdir. Tapılmayan sahəni null qoy.`;

  let text: string;
  try {
    const res = await ai.messages.create({ model: AI_MODEL, max_tokens: 800, messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }] });
    text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  } catch (e: any) { return { ...EMPTY, error: `AI oxuya bilmədi: ${e?.message || 'xəta'}` }; }

  const parsed = parseJson(text);
  if (!parsed) return { ...EMPTY, error: 'AI cavabı oxunmadı.' };
  const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    ok: true,
    companyName: str(parsed.companyName),
    voen: str(parsed.voen),
    ownerName: str(parsed.ownerName),
    founderName: str(parsed.founderName),
  };
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
  if (!(await resolveFlag('ai_identity'))) return { ...EMPTY, error: 'Kimlik/ixtisas AI-ı deaktivdir — admin əl ilə yoxlayacaq.' };

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

// ---- Şəxsiyyət vəsiqəsindən ad-soyad oxuma (avtomatik doldurma üçün) ----

export interface IdNameResult {
  ok: boolean;
  fullName: string | null;   // tam ad-soyad
  firstName: string | null;  // ad
  lastName: string | null;   // soyad
  birthDate: string | null;  // doğum tarixi YYYY-MM-DD
  gender: string | null;     // Kişi / Qadın
  idNumber: string | null;   // FIN
  error?: string;
}

/**
 * Şəxsiyyət vəsiqəsindən ad, soyad, doğum tarixi, cins və FIN-i oxuyur
 * (kimlik formasını avtomatik doldurmaq üçün).
 */
export async function extractIdName(idCardPath: string): Promise<IdNameResult> {
  const EMPTY: IdNameResult = { ok: false, fullName: null, firstName: null, lastName: null, birthDate: null, gender: null, idNumber: null };
  const ai = getClient();
  if (!ai) return { ...EMPTY, error: 'AI açarı qoyulmayıb.' };
  if (!(await resolveFlag('ai_identity'))) return { ...EMPTY, error: 'Kimlik AI-ı deaktivdir — admin əl ilə yoxlayacaq.' };

  let b64: string;
  try { b64 = (await fs.promises.readFile(idCardPath)).toString('base64'); }
  catch { return { ...EMPTY, error: 'Şəkil oxunmadı.' }; }

  const prompt = `Bu, şəxsiyyət vəsiqəsinin şəklidir. Üzərindəki şəxsin məlumatlarını oxu.
YALNIZ bu JSON formatında cavab ver (başqa heç nə yazma):
{
  "firstName": "ad (vəsiqədəki kimi) və ya null",
  "lastName": "soyad (vəsiqədəki kimi) və ya null",
  "birthDate": "doğum tarixi YYYY-MM-DD formatında və ya null",
  "gender": "Kişi / Qadın və ya null",
  "idNumber": "FIN / şəxsiyyət vəsiqəsi nömrəsi və ya null"
}
Qeyd: Azərbaycan vəsiqələrində ad/soyad latın hərfləri ilə yazılır. Atanın adını (orta ad) ada daxil etmə — yalnız ad və soyad. Oxunmayan sahəni null qoy.`;

  let text: string;
  try {
    const res = await ai.messages.create({
      model: AI_MODEL,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: prompt },
        ],
      }],
    });
    text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  } catch (e: any) {
    return { ...EMPTY, error: `AI oxuya bilmədi: ${e?.message || 'xəta'}` };
  }

  const jsonStr = (() => {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) return fence[1].trim();
    const brace = text.match(/\{[\s\S]*\}/);
    return brace ? brace[0] : text;
  })();

  let parsed: any;
  try { parsed = JSON.parse(jsonStr); }
  catch { return { ...EMPTY, error: 'AI cavabı oxunmadı.' }; }

  const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const firstName = str(parsed.firstName);
  const lastName = str(parsed.lastName);
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || null;
  const bd = str(parsed.birthDate);
  const birthDate = bd && /^\d{4}-\d{2}-\d{2}$/.test(bd) ? bd : null;
  return { ok: !!fullName, fullName, firstName, lastName, birthDate, gender: str(parsed.gender), idNumber: str(parsed.idNumber) };
}

// ---- Kimlik doğrulaması: şəxsiyyət vəsiqəsi + selfie ----

export interface IdentityAnalysis {
  ok: boolean;
  idName: string | null;       // vəsiqədəki ad-soyad
  birthDate: string | null;    // doğum tarixi (YYYY-MM-DD) və ya null
  gender: string | null;       // "Kişi" / "Qadın" və ya null
  idNumber: string | null;     // FIN / şəxsiyyət nömrəsi
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
  ok: false, idName: null, birthDate: null, gender: null, idNumber: null,
  nameMatch: false, nameMatchScore: 0,
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
  if (!(await resolveFlag('ai_identity'))) return { ...EMPTY_ID, error: 'Kimlik AI-ı deaktivdir — admin əl ilə yoxlayacaq.' };

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
  "birthDate": "doğum tarixi YYYY-MM-DD formatında və ya null",
  "gender": "Kişi / Qadın və ya null",
  "idNumber": "FIN / şəxsiyyət vəsiqəsi nömrəsi və ya null",
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

  const isoDate = (v: any): string | null => {
    if (typeof v !== 'string') return null;
    const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? v.trim() : null;
  };

  return {
    ok: true,
    idName,
    birthDate: isoDate(parsed.birthDate),
    gender: typeof parsed.gender === 'string' && parsed.gender.trim() ? parsed.gender.trim() : null,
    idNumber: typeof parsed.idNumber === 'string' && parsed.idNumber.trim() ? parsed.idNumber.trim() : null,
    nameMatch: Boolean(parsed.nameMatch) || nameScore >= 0.6,
    nameMatchScore: nameScore,
    faceMatch: Boolean(parsed.faceMatch),
    faceMatchScore: clamp01(parsed.faceMatchScore),
    documentValid: Boolean(parsed.documentValid),
    fraudSignals: Array.isArray(parsed.fraudSignals) ? parsed.fraudSignals.map(String).slice(0, 10) : [],
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}

// ---- Biznes sənədlərinin yoxlanması (avtomatik təsdiq üçün) ----

export interface BusinessDoc { label: string; path: string; }

export interface BusinessAnalysis {
  ok: boolean;
  authorized: boolean;     // profil sahibi rəhbər/etibarnaməli olaraq təsdiqləndi?
  isDirector: boolean;     // vergi sənədinə görə rəhbər/sahibdir?
  hasPowerOfAttorney: boolean; // etibarnamə ilə səlahiyyət verilib?
  voenMatch: boolean;      // sənədlərdəki VÖEN forma ilə uyğundur?
  documentValid: boolean;  // sənədlər əsl və oxunaqlı görünür?
  confidence: number;      // 0..1
  fraudSignals: string[];
  reason: string;
  error?: string;
}

const EMPTY_BIZ: BusinessAnalysis = {
  ok: false, authorized: false, isDirector: false, hasPowerOfAttorney: false,
  voenMatch: false, documentValid: false, confidence: 0, fraudSignals: [], reason: '',
};

/**
 * Şirkət sənədlərini Claude ilə yoxlayır və profil sahibinin biznes açmağa
 * səlahiyyətli olub-olmadığını təyin edir:
 *  - TAX_DOC: profil sahibi vergi sənədində rəhbər/sahib kimi görünürmü,
 *  - POWER_OF_ATTORNEY: etibarnamədə profil sahibinə səlahiyyət verilibmi.
 * @param docs        yoxlanacaq sənəd şəkilləri (label + path)
 * @param proofType   'TAX_DOC' | 'POWER_OF_ATTORNEY'
 * @param form        formdan: ad, VÖEN, sahibi, təsisçi
 * @param registeredName  biznesi yaradan istifadəçinin qeydiyyat ad-soyadı
 */
export async function verifyBusinessAI(
  docs: BusinessDoc[],
  proofType: 'TAX_DOC' | 'POWER_OF_ATTORNEY',
  form: { name: string; voen: string; ownerName: string; founderName: string },
  registeredName: string,
): Promise<BusinessAnalysis> {
  const ai = getClient();
  if (!ai) return { ...EMPTY_BIZ, error: 'AI açarı (ANTHROPIC_API_KEY) qoyulmayıb — admin əl ilə yoxlayacaq.' };
  if (!(await resolveFlag('ai_business_docs'))) return { ...EMPTY_BIZ, error: 'Biznes sənəd AI-ı deaktivdir — admin əl ilə yoxlayacaq.' };
  if (!docs.length) return { ...EMPTY_BIZ, error: 'Yoxlanacaq sənəd yoxdur.' };

  let blocks: any[];
  try {
    blocks = await Promise.all(docs.map((d) => fileToContentBlock(d.path)));
  } catch {
    return { ...EMPTY_BIZ, error: 'Sənədlər oxunmadı.' };
  }

  const docList = docs.map((d, i) => `${i + 1}-ci sənəd — ${d.label}`).join('\n');
  const rule = proofType === 'TAX_DOC'
    ? 'Sənəd növü: VERGI QEYDİYYATI. Profil sahibi yalnız sənəddə şirkətin RƏHBƏRİ/DİREKTORU/SAHİBİ kimi göstərilibsə səlahiyyətlidir (authorized=true).'
    : 'Sənəd növü: ETİBARNAMƏ + ŞİRKƏT SƏNƏDİ. Profil sahibi yalnız etibarnamədə bu şirkət adından fəaliyyət üçün ona AÇIQ səlahiyyət verilibsə səlahiyyətlidir (authorized=true). Etibarnamədəki adın profil sahibi ilə uyğunluğunu yoxla.';

  const prompt = `Sən şirkət sənədlərini yoxlayan KYC analitiksən. Sənə bir neçə sənəd şəkli verilir:
${docList}

Biznesi yaratmaq istəyən şəxsin qeydiyyat ad-soyadı: "${registeredName}"
Formda göstərilən: şirkət adı = "${form.name}", VÖEN = "${form.voen}", sahibi = "${form.ownerName}", təsisçi = "${form.founderName}".

${rule}

Sənədləri diqqətlə analiz et və YALNIZ bu JSON formatında cavab ver (başqa heç nə yazma):
{
  "companyName": "sənəddəki şirkət adı və ya null",
  "voenInDoc": "sənəddəki VÖEN və ya null",
  "voenMatch": true/false,          // sənəddəki VÖEN formdakı VÖEN ilə uyğundurmu
  "isDirector": true/false,         // profil sahibi vergi sənədində rəhbər/sahib kimi görünürmü
  "hasPowerOfAttorney": true/false, // etibarnamə ilə profil sahibinə səlahiyyət verilibmi
  "authorized": true/false,         // yuxarıdakı qaydaya görə biznes açmağa səlahiyyətlidirmi
  "documentValid": true/false,      // sənədlər əsl, oxunaqlı və dəyişdirilməmiş görünürmü
  "confidence": 0.0-1.0,            // ümumi əminlik
  "fraudSignals": ["..."],          // saxtakarlıq/montaj əlamətləri (yoxdursa boş massiv)
  "reason": "Azərbaycan dilində 1-2 cümlə qısa izah"
}

Qeyd: Azərbaycan hərflərinin transliterasiyasını (ə↔e) və ad/soyad sırasını nəzərə al. Əmin deyilsənsə authorized=false qoy — şübhə varsa təsdiq vermə.`;

  let text: string;
  try {
    const content: any[] = [...blocks];
    content.push({ type: 'text', text: prompt });
    const res = await ai.messages.create({ model: AI_MODEL, max_tokens: 1500, messages: [{ role: 'user', content }] });
    text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  } catch (e: any) {
    return { ...EMPTY_BIZ, error: `AI analizi alınmadı: ${e?.message || 'naməlum xəta'}` };
  }

  const jsonStr = (() => {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) return fence[1].trim();
    const brace = text.match(/\{[\s\S]*\}/);
    return brace ? brace[0] : text;
  })();

  let parsed: any;
  try { parsed = JSON.parse(jsonStr); }
  catch { return { ...EMPTY_BIZ, error: 'AI cavabı oxunmadı.', reason: text.slice(0, 200) }; }

  const clamp01 = (n: any) => { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; };

  return {
    ok: true,
    authorized: Boolean(parsed.authorized),
    isDirector: Boolean(parsed.isDirector),
    hasPowerOfAttorney: Boolean(parsed.hasPowerOfAttorney),
    voenMatch: Boolean(parsed.voenMatch),
    documentValid: Boolean(parsed.documentValid),
    confidence: clamp01(parsed.confidence),
    fraudSignals: Array.isArray(parsed.fraudSignals) ? parsed.fraudSignals.map(String).slice(0, 10) : [],
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}

// ---- Bank sənədindən hesab nömrələrinin (IBAN) çıxarılması ----

export interface BankAccountExtract { iban: string; bankName: string | null; holder: string | null; }
export interface BankDocAnalysis {
  ok: boolean;
  accounts: BankAccountExtract[];
  documentValid: boolean;
  reason: string;
  error?: string;
}

// IBAN-ı normallaşdır (boşluqları sil, böyük hərf). Azərbaycan IBAN: AZ + 2 rəqəm + 4 hərf + 20 simvol = 28.
function normalizeIban(s: string): string | null {
  const v = String(s || '').replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v) ? v : null;
}

/**
 * Bank hesabı sənədindən (bank arayışı, hesab açılışı və s.) IBAN-ları oxuyur.
 */
export async function extractBankAccounts(bankDocPath: string): Promise<BankDocAnalysis> {
  const ai = getClient();
  if (!ai) return { ok: false, accounts: [], documentValid: false, reason: '', error: 'AI açarı qoyulmayıb — admin əl ilə yoxlayacaq.' };
  if (!(await resolveFlag('ai_business_docs'))) return { ok: false, accounts: [], documentValid: false, reason: '', error: 'Biznes sənəd AI-ı deaktivdir — admin əl ilə yoxlayacaq.' };

  let block: any;
  try { block = await fileToContentBlock(bankDocPath); }
  catch { return { ok: false, accounts: [], documentValid: false, reason: '', error: 'Sənəd oxunmadı.' }; }

  const prompt = `Bu, bir bank sənədidir (bank arayışı, hesab açılışı və ya hesab məlumatı). Sənəddəki BÜTÜN bank hesabı nömrələrini (IBAN) oxu.
YALNIZ bu JSON formatında cavab ver (başqa heç nə yazma):
{
  "accounts": [
    { "iban": "tam IBAN (məs. AZ21NABZ00000000137010001944)", "bankName": "bankın adı və ya null", "holder": "hesab sahibinin adı və ya null" }
  ],
  "documentValid": true/false,   // sənəd əsl bank sənədi və oxunaqlı görünürmü
  "reason": "Azərbaycan dilində 1 cümlə qısa izah"
}
Qeyd: IBAN-ı tam və boşluqsuz yaz. Hesab tapılmırsa accounts boş massiv olsun. Azərbaycan IBAN-ları "AZ" ilə başlayır və 28 simvoldur.`;

  let text: string;
  try {
    const res = await ai.messages.create({
      model: AI_MODEL,
      max_tokens: 1200,
      messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }],
    });
    text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  } catch (e: any) {
    return { ok: false, accounts: [], documentValid: false, reason: '', error: `AI oxuya bilmədi: ${e?.message || 'xəta'}` };
  }

  const jsonStr = (() => {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) return fence[1].trim();
    const brace = text.match(/\{[\s\S]*\}/);
    return brace ? brace[0] : text;
  })();

  let parsed: any;
  try { parsed = JSON.parse(jsonStr); }
  catch { return { ok: false, accounts: [], documentValid: false, reason: '', error: 'AI cavabı oxunmadı.' }; }

  const accounts: BankAccountExtract[] = Array.isArray(parsed.accounts)
    ? parsed.accounts.map((a: any) => {
        const iban = normalizeIban(a?.iban);
        if (!iban) return null;
        return { iban, bankName: typeof a?.bankName === 'string' && a.bankName.trim() ? a.bankName.trim() : null, holder: typeof a?.holder === 'string' && a.holder.trim() ? a.holder.trim() : null };
      }).filter(Boolean).slice(0, 10)
    : [];
  // Təkrarları sil.
  const seen = new Set<string>();
  const unique = accounts.filter((a) => (seen.has(a.iban) ? false : (seen.add(a.iban), true)));

  return {
    ok: true,
    accounts: unique,
    documentValid: Boolean(parsed.documentValid),
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}
