// Admin idarə edilən feature-flags (tənzimləmələr) — DB-də açar/dəyər.
// Qısa TTL keşi ilə oxunur ki, hər OTP/istəkdə DB-yə getməsin.
import { PrismaClient } from '@prisma/client';
import { isInfobipConfigured } from './infobipWhatsApp';

const prisma = new PrismaClient();

// ── Flag kataloqu ──
// Admin paneldə göstərilən açarlar. Hər biri gerçək olaraq kodda tətbiq olunur.
export type FlagSection = 'production' | 'developer';
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
    key: 'registration_open',
    section: 'production',
    label: 'Yeni qeydiyyat açıqdır',
    description: 'Deaktiv edilsə yeni istifadəçilər qeydiyyatdan keçə bilməz (mövcud istifadəçilər giriş edə bilər).',
    default: true,
  },
  {
    key: 'internet_search',
    section: 'production',
    label: 'İnternet axtarışı (Claude)',
    description: 'Saytda nəticə tapılmayanda internetdən (Claude web search) axtarış. Deaktiv edilsə internet nəticələri göstərilmir.',
    default: true,
  },
];

const FLAG_MAP = new Map(FLAGS.map((f) => [f.key, f]));

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
