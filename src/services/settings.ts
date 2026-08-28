// Admin idarə edilən feature-flags (tənzimləmələr) — DB-də açar/dəyər.
// Qısa TTL keşi ilə oxunur ki, hər OTP/istəkdə DB-yə getməsin.
import { PrismaClient } from '@prisma/client';
import { isInfobipConfigured } from './infobipWhatsApp';
import { isVeriffConfigured } from './veriff';

const prisma = new PrismaClient();

// ── Flag kataloqu ──
// Admin paneldə göstərilən açarlar. Hər biri gerçək olaraq kodda tətbiq olunur.
export type FlagSection = 'production' | 'developer' | 'ai';
export interface FlagDef {
  key: string;
  section: FlagSection;
  label: string;
  description: string;
  // Dəyər DB-də yoxdursa istifadə olunan default (dinamik ola bilər).
  default: boolean | (() => boolean);
}

export const FLAGS: FlagDef[] = [
  {
    key: 'otp_real',
    section: 'production',
    label: 'Nömrə doğrulama: real (Infobip)',
    description:
      'Aktiv: doğrulama kodu Infobip ilə (SMS və ya WhatsApp) göndərilir. Deaktiv: kod göndərilmir, test rejimində input üstündə "fake" olaraq göstərilir. Default: Infobip konfiqurasiya olunubsa aktiv.',
    default: () => isInfobipConfigured(),
  },
  {
    key: 'veriff_enabled',
    section: 'production',
    label: 'Kimlik doğrulaması: Veriff (test)',
    description:
      'Aktiv: istifadəçi «Təsdiqlə» deyəndə Veriff pəncərəsi açılır və nəticə birbaşa Veriff-dən gəlir — admin əl ilə yoxlamır. Deaktiv: Veriff çağırılmır (test mərhələsində boş yerə xərclənmir); istifadəçi vəsiqənin ön/arxa şəklini və selfie-ni göndərir, müraciət «Kimlik yoxlaması» səhifəsinə düşür və admin gözlə baxıb təsdiqləyir. Default: Veriff açarları qoyulubsa aktiv.',
    default: () => isVeriffConfigured(),
  },
  {
    key: 'registration_open',
    section: 'production',
    label: 'Yeni qeydiyyat açıqdır',
    description: 'Deaktiv edilsə yeni istifadəçilər qeydiyyatdan keçə bilməz (mövcud istifadəçilər giriş edə bilər).',
    default: true,
  },
  {
    key: 'internet_search',
    section: 'ai',
    label: 'İnternet axtarışı — ƏSAS açar',
    description: 'Bütün internet axtarışının master açarı. Deaktiv edilsə heç bir internet nəticəsi göstərilmir (aşağıdakı motorlardan asılı olmayaraq). İstifadə: başlıqdakı axtarış çubuğu.',
    default: true,
  },
  // ── Süni intellekt motorları — hər biri ayrıca söndürülə bilər ──
  {
    key: 'ai_websearch_tavily',
    section: 'ai',
    label: 'İnternet axtarışı — Tavily motoru',
    description: 'Məhsul axtarışının ƏSAS motoru (Tavily). Deaktiv edilsə məhsul üçün internet axtarışı Claude ehtiyat motoruna keçir (o da deaktivdirsə heç nə). İstifadə: başlıqdakı axtarış — məhsul.',
    default: true,
  },
  {
    key: 'ai_websearch_claude',
    section: 'ai',
    label: 'İnternet axtarışı — Claude ehtiyat motoru',
    description: 'Tavily olmadıqda/deaktiv olduqda işə düşən ehtiyat motor (Claude web_search). Deaktiv edilsə ehtiyat motor işləmir. İstifadə: başlıqdakı axtarış — məhsul.',
    default: true,
  },
  {
    key: 'ai_person_search',
    section: 'ai',
    label: 'Şəxs axtarışı (sosial media)',
    description: 'Ad-soyad yazılanda həmin şəxsin açıq sosial media hesablarını tapır (Tavily). Deaktiv edilsə şəxs axtarışı işləmir. İstifadə: başlıqdakı axtarış — ad-soyad.',
    default: true,
  },
  {
    key: 'ai_assistant',
    section: 'ai',
    label: 'AI köməkçi (söhbət botu)',
    description: 'Saytdakı süni intellekt köməkçisi (Claude — Sonnet/Opus). Deaktiv edilsə köməkçi cavab vermir. İstifadə: AI söhbət pəncərəsi.',
    default: true,
  },
  {
    key: 'ai_assistant_opus',
    section: 'ai',
    label: 'AI köməkçi — mürəkkəb suallarda Opus',
    description: 'Aktiv: mürəkkəb suallarda daha güclü (bahalı) Opus modeli. Deaktiv: həmişə daha ucuz Sonnet. İstifadə: AI köməkçi.',
    default: true,
  },
  {
    key: 'ai_vision_search',
    section: 'ai',
    label: 'Şəkillə axtarış (görüntü AI)',
    description: 'Şəkil yüklənəndə məhsulu tanıyıb axtarış sorğusuna çevirir (Claude vision). Deaktiv edilsə şəkillə axtarış işləmir. İstifadə: axtarış çubuğundakı kamera düyməsi.',
    default: true,
  },
  {
    key: 'ai_identity',
    section: 'ai',
    label: 'Kimlik doğrulaması (KYC — Claude)',
    description: 'Şəxsiyyət vəsiqəsi + selfi ilə avtomatik kimlik yoxlaması (Claude vision). Deaktiv edilsə admin əl ilə yoxlayır. İstifadə: profil təsdiqi / KYC.',
    default: true,
  },
  {
    key: 'ai_business_docs',
    section: 'ai',
    label: 'Biznes/VÖEN sənəd analizi (Claude)',
    description: 'VÖEN/etibarnamə/bank sənədlərini avtomatik yoxlayıb məlumat çıxarır (Claude). Deaktiv edilsə admin əl ilə yoxlayır. İstifadə: biznes təsdiqi.',
    default: true,
  },
];

const FLAG_MAP = new Map(FLAGS.map((f) => [f.key, f]));

// ── Rəqəmli tənzimləmələr (tariflər) ──
// Açıq/bağlı deyil, DƏYƏR olan parametrlər. Eyni `Setting` cədvəlində saxlanılır,
// eyni keşdən oxunur — ona görə dəyişiklik dərhal (ən çox 15 san) tətbiq olunur.
export interface NumberDef {
  key: string;
  label: string;
  description: string;
  default: number;
  min: number;
  max: number;
  unit: string;
  /** Onluq rəqəm sayı — 2 = qəpik dəqiqliyi. */
  decimals: number;
}

export const NUMBERS: NumberDef[] = [
  {
    key: 'business_fee_azn',
    label: 'Biznes yaratma haqqı',
    description:
      'İstifadəçi biznes yaratmaq üçün birdəfəlik bu məbləği ödəyir. Ödəniş edilməyincə biznes müraciəti göndərilə bilmir. 0 yazılsa haqq tələb olunmur (pulsuz). Admin biznesi RƏDD etsə ödəniş yenidən istifadəyə açılır — istifadəçi ikinci dəfə ödəmir.',
    default: 10,
    min: 0,
    max: 1000,
    unit: 'AZN',
    decimals: 2,
  },
  {
    key: 'veriff_fee_azn',
    label: 'Veriff ilə kimlik doğrulaması haqqı',
    description:
      'İstifadəçi kimliyini Veriff ilə DƏRHAL təsdiqləmək istəyirsə bu məbləği ödəyir (Veriff xidmətinin xərcini qarşılayır). Ödəniş yalnız Veriff seçiləndə tələb olunur — admin yoxlaması həmişə pulsuzdur. 0 yazılsa Veriff də pulsuz olur. Veriff təsdiqi alınmasa ödəniş yanmır: istifadəçi yenidən cəhd edə bilir.',
    default: 1,
    min: 0,
    max: 100,
    unit: 'AZN',
    decimals: 2,
  },
];

const NUMBER_MAP = new Map(NUMBERS.map((n) => [n.key, n]));

// ── TTL keş ──
let cache: Record<string, string> | null = null;
let cachedAt = 0;
const TTL_MS = 15000;

async function load(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cache && now - cachedAt < TTL_MS) return cache;
  try {
    const rows = await prisma.setting.findMany();
    cache = {};
    for (const r of rows) cache[r.key] = r.value;
    cachedAt = now;
  } catch {
    // DB əlçatan deyilsə köhnə keşi (varsa) və ya boş qaytar.
    if (!cache) cache = {};
  }
  return cache;
}

function defaultOf(def: FlagDef): boolean {
  return typeof def.default === 'function' ? def.default() : def.default;
}

// Bir flag-in effektiv dəyəri (DB → yoxdursa default).
export async function resolveFlag(key: string): Promise<boolean> {
  const def = FLAG_MAP.get(key);
  const store = await load();
  const raw = store[key];
  if (raw === undefined) return def ? defaultOf(def) : false;
  return raw === 'true';
}

// Admin paneli üçün — bütün flag-lar cari dəyər + meta ilə.
export async function listFlags() {
  const store = await load();
  return FLAGS.map((f) => ({
    key: f.key,
    section: f.section,
    label: f.label,
    description: f.description,
    value: store[f.key] === undefined ? defaultOf(f) : store[f.key] === 'true',
    isDefault: store[f.key] === undefined,
  }));
}

// Flag dəyərini dəyiş (yalnız kataloqdakı açarlar). Keş dərhal yenilənir.
export async function setFlag(key: string, value: boolean): Promise<boolean> {
  if (!FLAG_MAP.has(key)) throw new Error('Naməlum tənzimləmə açarı: ' + key);
  const v = value ? 'true' : 'false';
  await prisma.setting.upsert({
    where: { key },
    update: { value: v },
    create: { key, value: v },
  });
  if (cache) cache[key] = v;
  else { cache = { [key]: v }; cachedAt = Date.now(); }
  return value;
}

// ── Rəqəmli tənzimləmələr ──

function clampNumber(def: NumberDef, raw: number): number {
  const p = Math.pow(10, def.decimals);
  return Math.max(def.min, Math.min(def.max, Math.round(raw * p) / p));
}

/** Bir rəqəmli tənzimləmənin effektiv dəyəri (DB → yoxdursa default). */
export async function getNumber(key: string): Promise<number> {
  const def = NUMBER_MAP.get(key);
  if (!def) throw new Error('Naməlum tənzimləmə açarı: ' + key);
  const store = await load();
  const n = parseFloat(store[key] ?? '');
  // Yararsız dəyər (əl ilə DB-yə səhv yazılıb) default-a qayıdır — sistem
  // NaN tarifə görə ödənişi bloklamasın.
  if (!Number.isFinite(n)) return def.default;
  return clampNumber(def, n);
}

export async function listNumbers() {
  const store = await load();
  return NUMBERS.map((d) => {
    const raw = parseFloat(store[d.key] ?? '');
    const isDefault = !Number.isFinite(raw);
    return {
      key: d.key, label: d.label, description: d.description,
      unit: d.unit, min: d.min, max: d.max, decimals: d.decimals,
      value: isDefault ? d.default : clampNumber(d, raw),
      isDefault,
    };
  });
}

export async function setNumber(key: string, value: number): Promise<number> {
  const def = NUMBER_MAP.get(key);
  if (!def) throw new Error('Naməlum tənzimləmə açarı: ' + key);
  if (!Number.isFinite(value)) throw new Error('Dəyər rəqəm olmalıdır');
  if (value < def.min || value > def.max) {
    throw new Error(`${def.label}: ${def.min}–${def.max} ${def.unit} aralığında olmalıdır`);
  }
  const v = String(clampNumber(def, value));
  await prisma.setting.upsert({ where: { key }, update: { value: v }, create: { key, value: v } });
  if (cache) cache[key] = v;
  else { cache = { [key]: v }; cachedAt = Date.now(); }
  return parseFloat(v);
}
