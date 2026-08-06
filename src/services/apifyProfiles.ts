// Apify ilə sosial profil zənginləşdirmə — websearch-də tapılan profillərin
// GERÇƏK adını və profil şəklini gətirir.
//
// Railway → Variables:
//   APIFY_TOKEN                — Apify API tokeni (apify.com → Settings → Integrations)
//   APIFY_INSTAGRAM_ACTOR      — default "apify~instagram-profile-scraper"
//   APIFY_ACTOR_TIMEOUT_SEC    — default 25 (axtarış çox gözlətməsin)
//
// Token yoxdursa funksiya sadəcə boş qaytarır — axtarış əvvəlki kimi işləyir
// (unavatar / platforma ikonu ilə). Yəni bu, İSTƏYƏ BAĞLI zənginləşdirmədir.

const TOKEN = () => process.env.APIFY_TOKEN || '';
const TIMEOUT_SEC = () => Math.max(5, Math.min(60, Number(process.env.APIFY_ACTOR_TIMEOUT_SEC) || 25));

export function isApifyConfigured(): boolean {
  return !!TOKEN();
}

export interface ApifyProfile {
  handle: string;
  fullName: string | null;
  avatarUrl: string | null;
  followers?: number | null;
  verified?: boolean;
}

// Platforma → Apify actor. Yalnız token VƏ actor varsa çağırılır.
function actorFor(platform: string): string | null {
  const p = (platform || '').toLowerCase();
  if (p === 'instagram') return process.env.APIFY_INSTAGRAM_ACTOR || 'apify~instagram-profile-scraper';
  if (p === 'tiktok') return process.env.APIFY_TIKTOK_ACTOR || null;
  if (p === 'facebook') return process.env.APIFY_FACEBOOK_ACTOR || null;
  return null;
}

// Nəticə keşi — eyni profili təkrar sorğulamırıq (Apify hər run üçün pul alır).
interface CacheEntry { at: number; data: ApifyProfile | null }
const cache = new Map<string, CacheEntry>();
const TTL_MS = 24 * 60 * 60 * 1000;  // 24 saat
const CACHE_MAX = 1000;

function cacheGet(key: string): ApifyProfile | null | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) { cache.delete(key); return undefined; }
  return hit.data;
}
function cacheSet(key: string, data: ApifyProfile | null) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), data });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// Apify actor-u sinxron işlədib dataset elementlərini alır.
async function runActor(actor: string, input: any): Promise<any[]> {
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(TOKEN())}&timeout=${TIMEOUT_SEC()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout((TIMEOUT_SEC() + 5) * 1000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Apify HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// Apify-ın müxtəlif actor-ları fərqli sahə adları qaytarır — hamısını yoxlayırıq.
function pickProfile(item: any, handle: string): ApifyProfile | null {
  if (!item || typeof item !== 'object') return null;
  const fullName = item.fullName || item.full_name || item.name || item.displayName || item.nickname || null;
  const avatarUrl = item.profilePicUrl || item.profilePicUrlHD || item.profile_pic_url
    || item.avatar || item.avatarUrl || item.profileImage || item.picture || null;
  if (!fullName && !avatarUrl) return null;
  return {
    handle,
    fullName: fullName ? String(fullName).slice(0, 80) : null,
    avatarUrl: avatarUrl ? String(avatarUrl) : null,
    followers: typeof item.followersCount === 'number' ? item.followersCount
      : (typeof item.followers === 'number' ? item.followers : null),
    verified: !!(item.verified || item.isVerified),
  };
}

/**
 * Bir sosial profilin adını və şəklini gətirir.
 * Token/actor yoxdursa və ya xəta olarsa `null` qaytarır (axtarış pozulmur).
 */
export async function fetchProfile(platform: string, handle: string): Promise<ApifyProfile | null> {
  if (!isApifyConfigured() || !handle) return null;
  const actor = actorFor(platform);
  if (!actor) return null;

  const key = `${platform.toLowerCase()}:${handle.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  try {
    const p = platform.toLowerCase();
    // Actor-a görə giriş formatı dəyişir.
    const input = p === 'instagram'
      ? { usernames: [handle] }
      : { profiles: [handle], startUrls: [{ url: `https://www.${p}.com/${handle}` }] };
    const items = await runActor(actor, input);
    const profile = items.length ? pickProfile(items[0], handle) : null;
    cacheSet(key, profile);
    if (profile) console.log(`[apify] ${key} → ${profile.fullName || '(ad yoxdur)'}${profile.avatarUrl ? ' + şəkil' : ''}`);
    return profile;
  } catch (e: any) {
    console.error('[apify] fetchProfile xəta:', platform, handle, e?.message);
    cacheSet(key, null);   // qısa müddət təkrar cəhd etməsin
    return null;
  }
}

/**
 * Bir neçə profili paralel zənginləşdirir (maksimum `limit` ədəd — xərc nəzarəti).
 * Uğursuzlar sadəcə atlanır.
 */
export async function enrichProfiles(
  targets: { platform: string; handle: string }[],
  limit = 5,
): Promise<Map<string, ApifyProfile>> {
  const out = new Map<string, ApifyProfile>();
  if (!isApifyConfigured()) return out;
  const slice = targets.filter((t) => t.handle && actorFor(t.platform)).slice(0, limit);
  if (!slice.length) return out;
  const settled = await Promise.allSettled(slice.map((t) => fetchProfile(t.platform, t.handle)));
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      out.set(`${slice[i].platform.toLowerCase()}:${slice[i].handle.toLowerCase()}`, r.value);
    }
  });
  return out;
}
