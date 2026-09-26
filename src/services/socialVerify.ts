// SOSİAL HESABIN SAHİBLİYİNİ TƏSDİQ — açarsız (OAuth olmadan) işləyən üsul.
//
// Məntiq: istifadəçiyə unikal kod verilir (TRX-XXXXXX). O, kodu hesabının
// BİO-suna (təsvir / about) yazır. Sistem həmin ictimai səhifəni oxuyur və
// kodu tapırsa — hesabı idarə edən şəxs odur, link «təsdiqlənmiş» olur.
// Təsdiqdən sonra kod biodan silinə bilər.
//
// Platformalar serverə bionu fərqli dərəcədə göstərir (yoxlanılıb):
//   Telegram, YouTube, LinkedIn, X, sayt — bio səhifədə oxunur → avtomatik.
//   Instagram, TikTok, Facebook — bio serverdən gizlidir → ya ictimai
//   paylaşımın linki (kod + hesab adı səhifədə görünməlidir), ya da admin
//   kodu profildə əl ilə yoxlayır.
import dns from 'dns/promises';
import net from 'net';
import { PrismaClient } from '@prisma/client';
import { pushLive } from './live';

const prisma = new PrismaClient();

export const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'linkedin', 'twitter', 'telegram', 'website'] as const;

const HOSTS: Record<string, string[]> = {
  instagram: ['instagram.com'],
  facebook: ['facebook.com', 'fb.com'],
  tiktok: ['tiktok.com'],
  youtube: ['youtube.com', 'youtu.be'],
  linkedin: ['linkedin.com'],
  twitter: ['twitter.com', 'x.com'],
  telegram: ['t.me', 'telegram.me'],
};
/** Bio serverdən oxunan platformalar — kod avtomatik yoxlanır. */
export const BIO_READABLE = new Set(['telegram', 'youtube', 'linkedin', 'twitter', 'website']);

const hostMatches = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** Linki yoxla: platformanın öz domeni olmalıdır (instagram linki instagram.com-da). */
export function validateSocialUrl(platform: string, raw: string): { ok: true; url: string } | { ok: false; message: string } {
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { ok: false, message: 'Düzgün link daxil edin (https://...)' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, message: 'Link http(s) olmalıdır' };
  const host = u.hostname.toLowerCase();
  const list = HOSTS[platform];
  if (list && !hostMatches(host, list)) return { ok: false, message: `Bu ${platform} linki deyil — ${list[0]} ünvanı olmalıdır` };
  if (list && u.pathname.replace(/\/+$/, '') === '') return { ok: false, message: 'Profilinizin tam linkini yazın (məs. https://' + list[0] + '/istifadeci_adi)' };
  u.hash = '';
  return { ok: true, url: u.toString().replace(/\/$/, '') };
}

/** Linkdən hesab adı (handle) — /@ad, /in/ad, /ad formatları. */
export function handleOf(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return u.hostname;
    let h = decodeURIComponent(parts[0]);
    if ((h === 'in' || h === 'company' || h === 'c' || h === 'channel' || h === 'user') && parts[1]) h = decodeURIComponent(parts[1]);
    if (h === 'profile.php') h = u.searchParams.get('id') || h;
    return h.replace(/^@/, '').toLowerCase() || null;
  } catch { return null; }
}

const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newVerifyCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPH[Math.floor(Math.random() * ALPH.length)];
  return `TRX-${s}`;
}

// ── SSRF qoruması: daxili şəbəkə ünvanlarına sorğu göndərilmir ──
function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:127.') || x.startsWith('::ffff:10.') || x.startsWith('::ffff:192.168.');
}
async function safeUrl(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) return false;
    const addrs = await dns.lookup(u.hostname, { all: true });
    return addrs.length > 0 && !addrs.some((a) => privateIp(a.address));
  } catch { return false; }
}

const UAS = [
  'facebookexternalhit/1.1 (+https://www.facebook.com/externalhit_uatext.php)',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
];
const MAX_BYTES = 3 * 1024 * 1024;

function decode(s: string): string {
  return s
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

/** Səhifəni oxu (yönləndirmələr də yoxlanır). Alınmasa null. */
async function fetchPage(url: string, ua: string): Promise<string | null> {
  let cur = url;
  for (let hop = 0; hop < 5; hop++) {
    if (!(await safeUrl(cur))) return null;
    const res = await fetch(cur, {
      headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml', 'accept-language': 'az,en;q=0.8' },
      redirect: 'manual', signal: AbortSignal.timeout(12000),
    }).catch(() => null);
    if (!res) return null;
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { cur = new URL(res.headers.get('location')!, cur).toString(); continue; }
    if (!res.ok) return null;
    const reader = res.body?.getReader();
    if (!reader) return decode((await res.text()).slice(0, MAX_BYTES));
    const dec = new TextDecoder(); let html = ''; let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength; html += dec.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return decode(html);
  }
  return null;
}

export type CheckResult =
  | { status: 'FOUND'; method: 'BIO_CODE' | 'POST_CODE' }
  | { status: 'NOT_FOUND' | 'UNREADABLE' | 'HANDLE_MISMATCH'; message: string };

/**
 * Kodu yoxla. proofUrl verilibsə — həmin ictimai paylaşımda kod VƏ hesab adı
 * olmalıdır (paylaşım həmin hesaba məxsus olsun). Yoxdursa — profil səhifəsi.
 */
export async function checkSocialCode(p: { platform: string; url: string; code: string; proofUrl?: string | null }): Promise<CheckResult> {
  const target = p.proofUrl || p.url;
  const code = p.code.toUpperCase();
  const handle = handleOf(p.url);
  let readAny = false;
  for (const ua of UAS) {
    const html = await fetchPage(target, ua);
    if (!html) continue;
    readAny = true;
    const up = html.toUpperCase();
    // Kod bəzən boşluqla/tire olmadan yazılır — TRX AB12CD, TRXAB12CD da qəbul.
    const bare = code.replace('TRX-', '');
    const hit = up.includes(code) || new RegExp(`TRX[\\s_\\-–—]?${bare}`).test(up);
    if (!hit) continue;
    if (p.proofUrl) {
      if (!handle || !html.toLowerCase().includes(handle)) return { status: 'HANDLE_MISMATCH', message: 'Paylaşımda kod var, amma o sizin profil linkinizdəki hesaba məxsus görünmür' };
      return { status: 'FOUND', method: 'POST_CODE' };
    }
    return { status: 'FOUND', method: 'BIO_CODE' };
  }
  if (!readAny) return { status: 'UNREADABLE', message: 'Səhifə açılmadı — link düzgündür və hesab açıqdır (private deyil)?' };
  if (!p.proofUrl && !BIO_READABLE.has(p.platform)) {
    return { status: 'UNREADABLE', message: 'Bu platforma bionu serverə göstərmir. Kodu olan ictimai paylaşımın linkini əlavə edin və ya admin yoxlamasına göndərin.' };
  }
  return { status: 'NOT_FOUND', message: `Kod «${p.code}» ${p.proofUrl ? 'paylaşımda' : 'profilinizin biosunda'} tapılmadı. Yadda saxladığınıza əmin olun (dəyişiklik bir neçə dəqiqəyə görünə bilər).` };
}

/**
 * Eyni hesabı (platforma + ad) başqa istifadəçi əvvəl təsdiqləyibsə — təzə sübut
 * qalib gəlir: bir hesab yalnız BİR profilə təsdiqli bağlı ola bilər.
 */
export async function releaseSameHandle(link: { id: number; platform: string; url: string }) {
  const h = handleOf(link.url);
  if (!h) return;
  const others = await prisma.socialLink.findMany({ where: { platform: link.platform, verified: true, id: { not: link.id } } });
  for (const o of others) {
    if (handleOf(o.url) !== h) continue;
    await prisma.socialLink.update({ where: { id: o.id }, data: { verified: false, verifyMethod: null, verifiedAt: null, lastCheckNote: 'Bu hesabın sahibliyini başqa istifadəçi sübut etdi' } });
    await prisma.notification.create({ data: { userId: o.userId, type: 'SYSTEM', title: 'Sosial hesab təsdiqi götürüldü', body: `${o.platform} hesabınızın (${o.url}) sahibliyini başqa istifadəçi sübut etdi. Hesab sizindirsə yenidən təsdiqləyin.`, link: '/profile#social' } }).catch(() => {});
    pushLive(o.userId, { kind: 'social', id: o.id, status: 'REVOKED' });
  }
}
