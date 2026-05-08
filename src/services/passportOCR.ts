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
// dəqiq oxuyur. Şəkilin istiqaməti kullanıcının frontend-də ox düymələri ilə
// düzəltdiyi vaxt artıq düz olur — burada heç bir fırlatma etmirik.
async function preprocess(imagePath: string): Promise<Buffer> {
  return sharp(imagePath, { limitInputPixels: 50_000_000 })
    .rotate() // EXIF orientation-i tətbiq et (telefonun çəkdiyi şəkil üçün)
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .normalise()
    .sharpen()
    .toFormat('png')
    .toBuffer();
}

async function ocrSingle(imagePath: string): Promise<string> {
  const buffer = await preprocess(imagePath);
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

  // VIN (E.2) — 17 simvol, I/O/Q istifadə olunmur. OCR bəzən bir rəqəmi əskik
  // edir/əlavə edir — 16-18 simvolluq adblok-da axtarıb 17-yə yaxınını seçirik.
  const vinCandidates = [...backText.matchAll(/\b([A-HJ-NPR-Z0-9]{16,18})\b/g)].map((m) => m[1]);
  const vin17 = vinCandidates.find((s) => s.length === 17);
  if (vin17) fields.bodyNumber = vin17;
  else if (vinCandidates.length > 0) {
    // 17-li tapılmasa, ən yaxın uzunluq olanı təklif et (kullanıcı redaktə edəcək)
    const best = vinCandidates.sort((a, b) => Math.abs(17 - a.length) - Math.abs(17 - b.length))[0];
    if (best) fields.bodyNumber = best;
  }

  // G — mühərrik həcmi (cm³): 800-7000 arası 3-4 rəqəm. Sətirə əsaslı —
  // "G" etiketi və ya "Mühərrikin həcmi" / "Engine capacity" keçən sətir tap.
  // Beləliklə F.1/F.2 (kütlə) dəyərləri yanlış tutulmur.
  for (const line of backText.split(/\n/)) {
    if (!/(\bG\b|M[üu]h[əe]rr?ik[iı]?n?\s+h[əe]cm|Engine\s+capacity)/i.test(line)) continue;
    const m = line.match(/\b((?:[89]\d{2}|[1-6]\d{3}))\b/);
    if (m) { fields.engineCapacity = m[1]; break; }
  }

  // F.3 — oturacaqların sayı. Etiketin "3"-ünü tutmamaq üçün sətirlərə böl,
  // "F.3" və ya "Oturaca..." keçən sətirin SON rəqəmini götür (etiket
  // əvvəldə, dəyər sonda olur).
  for (const line of backText.split(/\n/)) {
    if (!/(F\.?\s*3|Oturaca)/i.test(line)) continue;
    const nums = [...line.matchAll(/(?<![\d.])(\d{1,2})(?![\d.])/g)].map((m) => parseInt(m[1], 10));
    // "F.3" etiketinin "3"-ünü kənarlaşdır — yalnız etiketdən sonra gələn rəqəmi al.
    const labelEnd = line.search(/F\.?\s*3|Oturaca\w*/i);
    const tail = labelEnd >= 0 ? line.slice(labelEnd) : line;
    const tailNums = [...tail.matchAll(/(?<![\d.])(\d{1,2})(?![\d.])/g)]
      .map((m) => parseInt(m[1], 10))
      .filter((n) => n >= 1 && n <= 29);
    // Etiket "F.3"-ün özü `3`-i daxil edirsə, ondan keç — tail-da ilk rəqəmin
    // pozisiyası etiketin sonundan ən az 2 simvol uzaqda olmalıdır.
    const labelMatch = tail.match(/F\.?\s*3|Oturaca\w*/i);
    const labelLen = labelMatch ? labelMatch[0].length : 0;
    const firstAfterLabel = [...tail.matchAll(/(?<![\d.])(\d{1,2})(?![\d.])/g)]
      .find((m) => (m.index ?? 0) >= labelLen + 1);
    if (firstAfterLabel) {
      const n = parseInt(firstAfterLabel[1], 10);
      if (n >= 1 && n <= 29) { fields.seatCount = n; break; }
    } else if (tailNums.length > 0) {
      fields.seatCount = tailNums[0];
      break;
    }
    void nums; // (debug üçün)
  }

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

  // E.4 — rəng. Pasportda qısa kod (Ag/Aq, Qa, Bz) və ya tam söz (Qara, Ağ) olur.
  // Xətti sətir-by-sətir axtaraq, "E.4" və ya "Rəng" / "Rang" / "Color" keçəni tap.
  for (const line of backText.split(/\n/)) {
    if (!/(E\.?\s*4|R[əea]ng\w*|Color)/i.test(line)) continue;
    // Etiketdən sonra ilk hərfi söz — 1-15 simvol
    const m = line.match(/(?:E\.?\s*4|R[əea]ng\w*|Color)[\s:.,-]+([A-ZƏŞÇÖÜĞ][a-zəşçöüğı]{0,14}|[A-ZƏŞÇÖÜĞ]{1,3})/i);
    if (m) { fields.color = m[1]; break; }
  }

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

  // F.1 — maksimum kütlə (kg): adətən 1000-5000 arası 4-rəqəmli dəyər.
  // F.2 — yüksüz kütlə: adətən F.1-dən kiçik. Sətirə əsaslanan axtarış.
  for (const line of backText.split(/\n/)) {
    if (/(F\.?\s*1|Maks\w*\s+k[üu]tl|Maximum\s+mass)/i.test(line) && !fields.maxMass) {
      const m = line.match(/\b([12]?\d{3,4})\b/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 600 && n <= 30000) fields.maxMass = m[1];
      }
    }
    if (/(F\.?\s*2|Y[üu]ks[üu]z|Unloaded\s+mass)/i.test(line) && !fields.unloadedMass) {
      const m = line.match(/\b([12]?\d{3,4})\b/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 500 && n <= 25000) fields.unloadedMass = m[1];
      }
    }
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

export async function extractWithOCR(frontPath: string, backPath: string): Promise<OCRResult> {
  let frontText = '';
  let backText = '';
  try {
    [frontText, backText] = await Promise.all([ocrSingle(frontPath), ocrSingle(backPath)]);
  } catch (err: any) {
    console.error('[passportOCR] tesseract failed:', err?.message);
    return { ok: false, fields: {}, filledCount: 0, rawText: '' };
  }
  const fields = parsePassportText(frontText, backText);
  const filledCount = Object.values(fields).filter((v) => v !== undefined && v !== null && v !== '').length;
  const hasCritical = !!(fields.bodyNumber && fields.brand && fields.manufactureYear);
  const ok = filledCount >= 6 && hasCritical;
  return {
    ok,
    fields,
    filledCount,
    rawText: `--- FRONT ---\n${frontText}\n--- BACK ---\n${backText}`,
  };
}

export const PASSPORT_TOTAL_FIELDS = TOTAL_FIELDS;

// Server kapanan zaman worker-i təmizlə (uzun işləyən proseslərdə bellek leak-i önləmək üçün)
process.once('exit', () => {
  if (workerPromise) workerPromise.then((w) => w.terminate()).catch(() => {});
});
