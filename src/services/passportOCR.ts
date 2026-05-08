// Local OCR: tesseract.js ilə Azərbaycan texniki pasportunu oxuyur.
// Heç bir xarici servisə bağlı deyil, kompüterdə tam işləyir. İlk istifadədə
// `aze.traineddata` (~4 MB) və `eng.traineddata` (~4 MB) avtomatik yüklənir
// və `node_modules/tesseract.js`-də cache olunur.
//
// OCR şəkildən düz mətn çıxarır; bu modulun `parsePassportText` funksiyası
// həmin mətndən pasport sahələrini regex/pattern ilə ayırır. Pasport sabit
// layout-da olduğuna görə bu effektivdir, amma şəkil keyfiyyəti zəif olduqda
// bəzi sahələr boş qala bilər. Boş qalanlar AI fallback-ə ötürülür.

import { createWorker, Worker } from 'tesseract.js';
import sharp from 'sharp';
import path from 'path';

let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    // Az + İngilis dilləri. İlk dəfə işə salındıqda CDN-dən endirir,
    // sonra cache-dən yüklənir. Server cold-start zamanı bir az yavaş olur.
    workerPromise = createWorker(['aze', 'eng']);
  }
  return workerPromise;
}

// Şəkli OCR-a uyğunlaşdırmaq: çox böyük şəkilləri kiçilt, kontrastı artır,
// boz tonlara çevir. Tesseract kontrast yüksək olan boz şəkillərdə daha
// dəqiq oxuyur. Opsional `rotateDeg` ilə şəkli 0/90/180/270 dərəcə fırlatmaq
// olar — pasport şəkilləri yan-tərs çəkilirsə kömək edir.
async function preprocess(imagePath: string, rotateDeg = 0): Promise<Buffer> {
  return sharp(imagePath, { limitInputPixels: 50_000_000 })
    .rotate(rotateDeg) // İlk parametr verilərsə EXIF deyil, açıq fırlatma
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .normalise()
    .sharpen()
    .toFormat('png')
    .toBuffer();
}

async function ocrSingle(imagePath: string, rotateDeg = 0): Promise<string> {
  const buffer = await preprocess(imagePath, rotateDeg);
  const worker = await getWorker();
  const { data } = await worker.recognize(buffer);
  return data.text || '';
}

// Pasport mətnindən bir tərəfin (ön və ya arxa) sahələrini çıxarır.
// Hər iki tərəf birləşdirilərək parse olunur — etiketlər tərəflər arasında
// qarışmasın deyə diqqətli olmaq lazımdır.
export interface OCRFields {
  registrationNumber?: string;
  registrationDate?: string;
  manufactureYear?: number;
  ownerName?: string;
  ownerAddress?: string;
  ownershipType?: string;
  validUntil?: string;
  cardSerial?: string;
  brand?: string;
  model?: string;
  vehicleType?: string;
  engineNumber?: string;
  bodyNumber?: string;
  chassisNumber?: string;
  color?: string;
  maxMass?: string;
  unloadedMass?: string;
  seatCount?: number;
  engineCapacity?: string;
  issuedBy?: string;
  specialMarks?: string;
}

// Common Azerbaijani-market vehicle brands. Tesseract often catches these
// as recognizable English/Latin tokens even when the rest is noisy.
const KNOWN_BRANDS = [
  'BMW', 'TOYOTA', 'MERCEDES', 'MERCEDES-BENZ', 'AUDI', 'LEXUS', 'HYUNDAI',
  'KIA', 'HONDA', 'FORD', 'CHEVROLET', 'LADA', 'PORSCHE', 'VOLKSWAGEN', 'VW',
  'NISSAN', 'MAZDA', 'VOLVO', 'MITSUBISHI', 'SUBARU', 'TESLA', 'RENAULT',
  'PEUGEOT', 'SKODA', 'SEAT', 'OPEL', 'INFINITI', 'ACURA', 'JEEP', 'DODGE',
  'CHRYSLER', 'CADILLAC', 'BUICK', 'GMC', 'LAND ROVER', 'JAGUAR', 'MINI',
  'GAZ', 'UAZ', 'ZAZ', 'GEELY', 'CHERY', 'HAVAL',
];

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function parsePassportText(frontText: string, backText: string): OCRFields {
  const all = `${frontText}\n${backText}`;
  const fields: OCRFields = {};

  // A — qeydiyyat nişanı: AZ formatı 2-3 rəqəm + 2 hərf + 3 rəqəm (məs: 77NP518, 90AA001)
  const reg = all.match(/\b(\d{2,3}\s?[A-ZƏİ]{2}\s?\d{3,4})\b/);
  if (reg) fields.registrationNumber = reg[1].replace(/\s/g, '');

  // B.1 — qeydiyyat tarixi (DD.MM.YYYY)
  const date = all.match(/\b([0-3]?\d\.[0-1]?\d\.(?:19|20)\d{2})\b/);
  if (date) fields.registrationDate = date[1];

  // B.2 — istehsal ili. Tarixin içindəki ili ayırd etmək üçün ayrıca standalone
  // 4-rəqəmli illər (1980-2030 arasında) axtarırıq.
  const yearTokens = [...all.matchAll(/\b((?:19[8-9]\d|20[0-3]\d))\b/g)].map((m) => parseInt(m[1], 10));
  const dateYear = date ? parseInt(date[1].split('.')[2], 10) : null;
  const distinctYears = yearTokens.filter((y) => y !== dateYear);
  if (distinctYears.length > 0) {
    fields.manufactureYear = distinctYears[0];
  }

  // VIN (E.2) — 17 simvol, I/O/Q istifadə olunmur
  const vin = backText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
  if (vin) fields.bodyNumber = vin[1];

  // G — mühərrik həcmi (cm³): 800-7000 arası 3-4 rəqəm (qeydiyyat nömrələrindən
  // ayırmaq üçün məhdud diapazon)
  const cap = backText.match(/\b((?:[89]\d{2}|[1-6]\d{3}))\b/);
  if (cap) fields.engineCapacity = cap[1];

  // F.3 — oturacaqların sayı: 1-9 və ya 14, 16, 22 kimi rəqəmlər. "F.3" etiketinə
  // yaxın yerdə kiçik rəqəm tap.
  const seat = backText.match(/(?:F\.?\s*3|Oturaca\w*).{0,40}?\b([1-9]|1\d|2\d)\b/i);
  if (seat) fields.seatCount = parseInt(seat[1], 10);

  // D — marka: tanınmış brendlərdən birini tap. Tesseract bəzən "BMW"-i "BMil",
  // "Mercedes"-i "Mercodes" kimi oxuyur — fuzzy match (Levenshtein-vari) ilə
  // ilk hərfləri eyni olan və uzunluğu yaxın token-ləri qəbul edirik.
  const upper = backText.toUpperCase();
  for (const b of KNOWN_BRANDS) {
    const re = new RegExp(`\\b${b.replace(' ', '\\s+')}\\b`);
    if (re.test(upper)) { fields.brand = b; break; }
  }
  if (!fields.brand) {
    // "D" etiketinin yanındakı 3-12 simvolluq Latın/rəqəm token-i —
    // OCR səhvinə tab gətirmək üçün ən yaxın brendlə tutuşdur.
    const dToken = backText.match(/\bD\s+([A-Z][A-Z0-9]{2,12})\b/);
    if (dToken) {
      const tok = dToken[1].toUpperCase();
      for (const b of KNOWN_BRANDS) {
        // İlk 2 hərfi və son hərfi eynidirsə qəbul et (BMW vs BMil — B,M ortaq).
        if (b.length >= 3 && tok.length >= 3 && tok.startsWith(b.slice(0, 2)) && Math.abs(b.length - tok.length) <= 2) {
          fields.brand = b; break;
        }
      }
    }
  }

  // D.2 — model: marka tapıldıqdan sonra eyni sətirdə marka adından sonra gələn token-lər
  if (fields.brand) {
    const re = new RegExp(`${fields.brand.replace(' ', '\\s+')}\\s+([A-Z0-9][A-Z0-9 -]{0,30})`, 'i');
    const m = upper.match(re);
    if (m) {
      const candidate = squash(m[1]).replace(/\s+(MİNİK|UNIVERSAL|SEDAN|HATCHBACK).*$/i, '');
      if (candidate.length >= 2 && candidate.length <= 30) fields.model = candidate;
    }
  }

  // D.3 — tip: MİNİK/MINIK, UNIVERSAL, SEDAN, HATCHBACK və s. (Az+ASCII variantları)
  const typeMatch = backText.match(/\b(M[İI]N[İI]K|UNIVERSAL|SEDAN|HATCHBACK|M[İI]N[İI]VAN|P[İI]KAP|Y[ÜU]K|AVTOBUS)\b/i);
  if (typeMatch) fields.vehicleType = typeMatch[1].toUpperCase();

  // E.4 — rəng: kiçik kod (Ag, Qa) və ya tam söz
  const colorMatch = backText.match(/(?:E\.?\s*4|Rəng\w*|Color)[\s:]+([A-ZƏŞÇÖÜĞIı][a-zəşçöüğıi]{1,15})/);
  if (colorMatch) fields.color = colorMatch[1];

  // Kart seriyası: 2 hərf + 6-8 rəqəm (məs: BB667834)
  const serial = frontText.match(/\b([A-Z]{2}\d{6,8})\b/);
  if (serial) fields.cardSerial = serial[1];

  // C.1 — mülkiyyətçi: BÖYÜK HƏRFLƏRLƏ ad-soyad. "OĞLU/OGLU/OQLU" və "QIZI/QIZI/QIZ"
  // suffikslərini qəbul edirik (Tesseract Az hərflərini bəzən ASCII-yə çevirir).
  const ownerWithSuffix = frontText.match(
    /\b([ƏA-ZÇŞÜÖĞİ]{2,}(?:\s+[ƏA-ZÇŞÜÖĞİ]{2,}){1,3}\s+(?:OĞLU|OGLU|OQLU|QIZI|QIZ[İI]))\b/i,
  );
  if (ownerWithSuffix) {
    fields.ownerName = squash(ownerWithSuffix[1]).toUpperCase();
  }

  // C.2 — ünvan: şəhər/şəh./seh. başlayan sətir (Az + ASCII variantları)
  const addr = frontText.match(
    /((?:Bakı|Baki|Sumqayıt|Sumqayit|Gəncə|Gence|Mingəçevir|Mingacevir|Şirvan|Sirvan|Naxçıvan|Naxcivan|Şəki|Seki|Lənkəran|Lenkeran)\s*ş?əh?\.?[^\n]{5,120})/i,
  );
  if (addr) fields.ownerAddress = squash(addr[1]);

  // C.3 — mülkiyyət növü (Az/ASCII)
  if (/Fiziki\s+(?:şəxs|sexs|sehs)/i.test(frontText)) fields.ownershipType = 'Fiziki şəxs';
  else if (/H[üu]quqi\s+(?:şəxs|sexs|sehs)/i.test(frontText)) fields.ownershipType = 'Hüquqi şəxs';

  // Verilib — "AR DİN", "BDYPİ" və s.
  const issued = backText.match(/\b(AR\s+D[İI]N[^\n]{0,30}|BDYP[İI][^\n]{0,20})\b/);
  if (issued) fields.issuedBy = squash(issued[0]);

  // E.1 — mühərrik nömrəsi: 6-15 simvol uzunluğunda alphanumeric, "E.1" etiketinə yaxın
  const eng = backText.match(/(?:E\.?\s*1|Mühərrik\s+nömrə\w*).{0,40}?\b([A-Z0-9]{6,15})\b/i);
  if (eng && eng[1] !== fields.bodyNumber) fields.engineNumber = eng[1];

  // E.3 — şassi nömrəsi
  const chassis = backText.match(/(?:E\.?\s*3|Şassi).{0,40}?\b([A-Z0-9]{6,17})\b/i);
  if (chassis && chassis[1] !== fields.bodyNumber && chassis[1] !== fields.engineNumber) {
    fields.chassisNumber = chassis[1];
  }

  return fields;
}

export interface OCRResult {
  ok: boolean;
  fields: OCRFields;
  filledCount: number;
  rawText: string;
}

const TOTAL_FIELDS = 21;

function scoreFields(fields: OCRFields): number {
  // Sahə doluluğu + kritik sahələrin (VIN, marka, il) bonusu.
  // Doğru istiqamətli şəkil səhv istiqamətdən daha yüksək bal alır.
  let score = 0;
  for (const v of Object.values(fields)) {
    if (v !== undefined && v !== null && v !== '') score += 1;
  }
  if (fields.bodyNumber) score += 3;        // VIN 17-simvol — düz oxunması çətindir
  if (fields.brand) score += 2;
  if (fields.manufactureYear) score += 1;
  if (fields.registrationNumber) score += 1;
  return score;
}

async function ocrAllRotations(imagePath: string, tryAll: boolean): Promise<{ text: string; rot: number }> {
  if (!tryAll) {
    return { text: await ocrSingle(imagePath, 0), rot: 0 };
  }
  // Bütün 4 istiqaməti ardıcıl sına (paralel istəsək worker tək olduğu üçün
  // serializasiya olur; ardıcıl daha proqnozlaşdırılandır).
  const results: Array<{ text: string; rot: number }> = [];
  for (const rot of [0, 90, 180, 270]) {
    try {
      const text = await ocrSingle(imagePath, rot);
      results.push({ text, rot });
    } catch (err: any) {
      console.error(`[passportOCR] rotation ${rot}° failed:`, err?.message);
    }
  }
  if (results.length === 0) return { text: '', rot: 0 };
  // Mətndə pasport etiketi tezliyi ilə ən doğru istiqaməti seç.
  // Az dilində bu sözlər yan/tərs istiqamətdə paralanır, ona görə düz mətndə
  // çox sayda görünür.
  const keywords = /\b(qeydiyyat|nişan|tarix|istehsal|m[üu]lkiyy?ət|sahib|fiziki|h[üu]quqi|m[üu]hərr?ik|şassi|rəng|kütlə|mod[ae]l|min[iı]k|universal|bakı|baki)\b/gi;
  let best = results[0];
  let bestScore = (results[0].text.match(keywords) || []).length;
  for (const r of results.slice(1)) {
    const sc = (r.text.match(keywords) || []).length;
    if (sc > bestScore) { best = r; bestScore = sc; }
  }
  return best;
}

export async function extractWithOCR(
  frontPath: string,
  backPath: string,
  options: { tryAllRotations?: boolean } = {},
): Promise<OCRResult> {
  const tryAll = options.tryAllRotations ?? false;
  let frontText = '';
  let backText = '';
  let frontRot = 0;
  let backRot = 0;
  try {
    const [front, back] = await Promise.all([
      ocrAllRotations(frontPath, tryAll),
      ocrAllRotations(backPath, tryAll),
    ]);
    frontText = front.text; frontRot = front.rot;
    backText = back.text; backRot = back.rot;
  } catch (err: any) {
    console.error('[passportOCR] tesseract failed:', err?.message);
    return { ok: false, fields: {}, filledCount: 0, rawText: '' };
  }
  let fields = parsePassportText(frontText, backText);

  // 1-ci pass çox az sahə tutdusa və hələ rotation cəhdi etməmişiksə,
  // 4 istiqaməti də yoxla.
  if (!tryAll && scoreFields(fields) < 4) {
    return extractWithOCR(frontPath, backPath, { tryAllRotations: true });
  }

  const filledCount = Object.values(fields).filter((v) => v !== undefined && v !== null && v !== '').length;
  const hasCritical = !!(fields.bodyNumber && fields.brand && fields.manufactureYear);
  const ok = filledCount >= 6 && hasCritical;
  return {
    ok,
    fields,
    filledCount,
    rawText: `--- FRONT (rotated ${frontRot}°) ---\n${frontText}\n--- BACK (rotated ${backRot}°) ---\n${backText}`,
  };
}

export const PASSPORT_TOTAL_FIELDS = TOTAL_FIELDS;

// Server kapanan zaman worker-i təmizlə (uzun işləyən proseslərdə bellek leak-i önləmək üçün)
process.once('exit', () => {
  if (workerPromise) workerPromise.then((w) => w.terminate()).catch(() => {});
});
