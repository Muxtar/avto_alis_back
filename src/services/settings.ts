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
  {
    key: 'ai_disputes',
    section: 'ai',
    label: 'Mübahisə qərarı (Claude)',
    description: 'Alıcı-satıcı mübahisələrində (iadə rəddi, qüsurlu məhsul) sübutları və foto-ları qiymətləndirib qərar verir. Əmin olmadıqda adminə ötürür. Deaktiv edilsə cavablanmış bütün mübahisələrə admin baxır.',
    default: true,
  },
  {
    key: 'installment_enabled',
    section: 'production',
    label: 'Hissəli ödəniş (taksit)',
    description: 'Biznes məhsullarında kartla taksitlə alış. Deaktiv edilsə kalkulyator və taksit seçimi saytın heç bir yerində görünmür. Taksit yalnız ödəniş şlüzü Kapital Bank olduqda işləyir (bank «TAKSIT=N» göstəricisi ilə ödənişi aylara bölür).',
    default: true,
  },
  {
    key: 'installment_kapital_taksit',
    section: 'production',
    label: 'Taksiti Kapital Bank-a ötür (TAKSIT=N)',
    description: 'Seçilən ay sayı Kapital Bank sifarişinin təsvirinə «TAKSIT=N» kimi yazılır və bank ödənişi BirKart/taksit kartı ilə aylara bölür. Merchant müqaviləsində taksit aktiv olmalıdır. Deaktiv edilsə taksit seçimi göstərilmir (vəd edib yerinə yetirməmək olmasın).',
    default: true,
  },
  {
    key: 'installment_yigim_page',
    section: 'production',
    label: 'YIĞIM ödəniş səhifəsində taksit aktivdir',
    description: 'YIĞIM taksiti öz kart səhifəsində təklif edir (API parametri yoxdur, alıcı ayı orada seçir). YIĞIM taksiti merchant hesabınızda aktivləşdirdiyini təsdiqləyəndən SONRA açın. Ayrıca taksit şablonu verilibsə (YIGIM_TEMPLATE_INSTALLMENT) o işlədilir, yoxsa adi şablon.',
    default: false,
  },
  {
    key: 'installment_buyer_pays_fee',
    section: 'production',
    label: 'Taksit komissiyasını alıcı ödəsin',
    description: 'Aktivdirsə planın bank komissiyası (aşağıdakı faizlər) alıcının ödədiyi məbləğə əlavə olunur. Deaktivdirsə məbləğ dəyişmir, komissiya satıcının qazancından çıxılır.',
    default: false,
  },
  {
    key: 'installment_m2',
    section: 'production',
    label: 'Taksit planı: 2 ay',
    description: '2 aylıq hissəli ödəniş seçimi alıcıya göstərilsin.',
    default: true,
  },
  {
    key: 'installment_m3',
    section: 'production',
    label: 'Taksit planı: 3 ay',
    description: '3 aylıq hissəli ödəniş seçimi alıcıya göstərilsin.',
    default: false,
  },
  {
    key: 'installment_m6',
    section: 'production',
    label: 'Taksit planı: 6 ay',
    description: '6 aylıq hissəli ödəniş seçimi alıcıya göstərilsin.',
    default: true,
  },
  {
    key: 'installment_m9',
    section: 'production',
    label: 'Taksit planı: 9 ay',
    description: '9 aylıq hissəli ödəniş seçimi alıcıya göstərilsin.',
    default: true,
  },
  {
    key: 'installment_m12',
    section: 'production',
    label: 'Taksit planı: 12 ay',
    description: '12 aylıq hissəli ödəniş seçimi alıcıya göstərilsin.',
    default: true,
  },
  {
    key: 'installment_m18',
    section: 'production',
    label: 'Taksit planı: 18 ay',
    description: '18 aylıq hissəli ödəniş seçimi alıcıya göstərilsin.',
    default: true,
  },
  {
    key: 'installment_m24',
    section: 'production',
    label: 'Taksit planı: 24 ay',
    description: '24 aylıq hissəli ödəniş seçimi alıcıya göstərilsin.',
    default: false,
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
    key: 'abandoned_checkout_minutes',
    label: 'Tərk edilmiş ödənişin ləğv müddəti',
    description:
      'Kartla ödəniş seçib bank səhifəsində ödənişi tamamlamayan sifarişlər bu müddətdən sonra avtomatik ləğv edilir. Belə sifarişlər üçün pul alınmır və stok tutulmur — ləğv yalnız admin panelini «olmayan sifarişlər»dən təmizləyir. Çox qısa qoymayın: alıcı hələ bank səhifəsində ola bilər.',
    default: 30,
    min: 5,
    max: 1440,
    unit: 'dəqiqə',
    decimals: 0,
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
  {
    key: 'vip_price_1d',
    label: 'VIP elan — 1 gün',
    description: 'Elanı 1 gün VIP etmək qiyməti. VIP elanlar siyahılarda həmişə ən öndə göstərilir və kartda VIP nişanı olur. 0 yazılsa bu paket pulsuzdur (dərhal aktivləşir).',
    default: 1,
    min: 0,
    max: 1000,
    unit: 'AZN',
    decimals: 2,
  },
  {
    key: 'vip_price_7d',
    label: 'VIP elan — 7 gün',
    description: 'Elanı 7 gün VIP etmək qiyməti. VIP elanlar siyahılarda həmişə ən öndə göstərilir və kartda VIP nişanı olur. 0 yazılsa bu paket pulsuzdur (dərhal aktivləşir).',
    default: 5,
    min: 0,
    max: 1000,
    unit: 'AZN',
    decimals: 2,
  },
  {
    key: 'vip_price_30d',
    label: 'VIP elan — 30 gün',
    description: 'Elanı 30 gün VIP etmək qiyməti. VIP elanlar siyahılarda həmişə ən öndə göstərilir və kartda VIP nişanı olur. 0 yazılsa bu paket pulsuzdur (dərhal aktivləşir).',
    default: 15,
    min: 0,
    max: 1000,
    unit: 'AZN',
    decimals: 2,
  },
  {
    key: 'installment_min_azn',
    label: 'Taksit üçün minimal məbləğ',
    description: 'Bu məbləğdən ucuz alışda taksit təklif olunmur (səbətin cəmi).',
    default: 30,
    min: 0,
    max: 100000,
    unit: 'AZN',
    decimals: 2,
  },
  {
    key: 'installment_fee_m2',
    label: 'Taksit komissiyası — 2 ay',
    description: 'Bankın 2 aylıq taksit üçün tutduğu faiz (merchant müqaviləsinə görə). 0 = komissiyasız. Kimin ödədiyi «Taksit komissiyasını alıcı ödəsin» açarı ilə seçilir.',
    default: 0,
    min: 0,
    max: 50,
    unit: '%',
    decimals: 2,
  },
  {
    key: 'installment_fee_m3',
    label: 'Taksit komissiyası — 3 ay',
    description: 'Bankın 3 aylıq taksit üçün tutduğu faiz (merchant müqaviləsinə görə). 0 = komissiyasız. Kimin ödədiyi «Taksit komissiyasını alıcı ödəsin» açarı ilə seçilir.',
    default: 0,
    min: 0,
    max: 50,
    unit: '%',
    decimals: 2,
  },
  {
    key: 'installment_fee_m6',
    label: 'Taksit komissiyası — 6 ay',
    description: 'Bankın 6 aylıq taksit üçün tutduğu faiz (merchant müqaviləsinə görə). 0 = komissiyasız. Kimin ödədiyi «Taksit komissiyasını alıcı ödəsin» açarı ilə seçilir.',
    default: 0,
    min: 0,
    max: 50,
    unit: '%',
    decimals: 2,
  },
  {
    key: 'installment_fee_m9',
    label: 'Taksit komissiyası — 9 ay',
    description: 'Bankın 9 aylıq taksit üçün tutduğu faiz (merchant müqaviləsinə görə). 0 = komissiyasız. Kimin ödədiyi «Taksit komissiyasını alıcı ödəsin» açarı ilə seçilir.',
    default: 0,
    min: 0,
    max: 50,
    unit: '%',
    decimals: 2,
  },
  {
    key: 'installment_fee_m12',
    label: 'Taksit komissiyası — 12 ay',
    description: 'Bankın 12 aylıq taksit üçün tutduğu faiz (merchant müqaviləsinə görə). 0 = komissiyasız. Kimin ödədiyi «Taksit komissiyasını alıcı ödəsin» açarı ilə seçilir.',
    default: 0,
    min: 0,
    max: 50,
    unit: '%',
    decimals: 2,
  },
  {
    key: 'installment_fee_m18',
    label: 'Taksit komissiyası — 18 ay',
    description: 'Bankın 18 aylıq taksit üçün tutduğu faiz (merchant müqaviləsinə görə). 0 = komissiyasız. Kimin ödədiyi «Taksit komissiyasını alıcı ödəsin» açarı ilə seçilir.',
    default: 0,
    min: 0,
    max: 50,
    unit: '%',
    decimals: 2,
  },
  {
    key: 'installment_fee_m24',
    label: 'Taksit komissiyası — 24 ay',
    description: 'Bankın 24 aylıq taksit üçün tutduğu faiz (merchant müqaviləsinə görə). 0 = komissiyasız. Kimin ödədiyi «Taksit komissiyasını alıcı ödəsin» açarı ilə seçilir.',
    default: 0,
    min: 0,
    max: 50,
    unit: '%',
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
