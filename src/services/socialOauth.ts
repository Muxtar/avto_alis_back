// Sosial media OAuth təsdiqi — "hesabla daxil ol". Platforma istifadəçini təsdiqləyir,
// biz yalnız onun profil linkini alıb verified=true ilə saxlayırıq. Ən güclü üsul.
//
// İŞLƏMƏSİ ÜÇÜN env dəyişənləri (Railway-də qoyulmalıdır):
//   FACEBOOK_CLIENT_ID / FACEBOOK_CLIENT_SECRET
//   INSTAGRAM_CLIENT_ID / INSTAGRAM_CLIENT_SECRET   (Meta app-da Instagram məhsulu)
//   TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET
//   PUBLIC_BACKEND_URL  (callback URL-i qurmaq üçün, məs. https://api.tradixai.az)
// Hər platformanın developer panelində Redirect URI:
//   <PUBLIC_BACKEND_URL>/api/social/oauth/<platform>/callback
import jwt from 'jsonwebtoken';

const SIGNING_KEY = process.env.JWT_SECRET || 'dev-only-not-for-production-XXXXXXXXXXXX';
const BACKEND = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 5001}`;

export const redirectUri = (platform: string) => `${BACKEND}/api/social/oauth/${platform}/callback`;

// state: callback zamanı kimliyi (userId) və platformanı daşıyır (qısa ömürlü, imzalı).
export function signState(userId: number, platform: string): string {
  return jwt.sign({ userId, platform }, SIGNING_KEY, { expiresIn: '10m' });
}
export function verifyState(state: string): { userId: number; platform: string } | null {
  try { return jwt.verify(state, SIGNING_KEY) as any; } catch { return null; }
}

interface Provider {
  clientId?: string;
  clientSecret?: string;
  buildAuthUrl(state: string): string;
  exchange(code: string): Promise<{ url: string }>;
}

const jsonFetch = async (url: string, init?: any) => {
  const r = await fetch(url, init);
  return r.json() as Promise<any>;
};

const PROVIDERS: Record<string, Provider> = {
  facebook: {
    clientId: process.env.FACEBOOK_CLIENT_ID,
    clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
    buildAuthUrl(state) {
      const p = new URLSearchParams({
        client_id: this.clientId!, redirect_uri: redirectUri('facebook'),
        scope: 'public_profile', response_type: 'code', state,
      });
      return `https://www.facebook.com/v19.0/dialog/oauth?${p}`;
    },
    async exchange(code) {
      const p = new URLSearchParams({
        client_id: this.clientId!, client_secret: this.clientSecret!,
        redirect_uri: redirectUri('facebook'), code,
      });
      const tok = await jsonFetch(`https://graph.facebook.com/v19.0/oauth/access_token?${p}`);
      if (!tok.access_token) throw new Error(tok.error?.message || 'Token alınmadı');
      const me = await jsonFetch(`https://graph.facebook.com/me?fields=id,name,link&access_token=${tok.access_token}`);
      return { url: me.link || `https://facebook.com/${me.id}` };
    },
  },

  instagram: {
    clientId: process.env.INSTAGRAM_CLIENT_ID,
    clientSecret: process.env.INSTAGRAM_CLIENT_SECRET,
    // Yeni "Instagram API with Instagram Login" axını (Basic Display 2024-də ləğv olunub).
    buildAuthUrl(state) {
      const p = new URLSearchParams({
        client_id: this.clientId!, redirect_uri: redirectUri('instagram'),
        scope: 'instagram_business_basic', response_type: 'code', state,
      });
      return `https://www.instagram.com/oauth/authorize?${p}`;
    },
    async exchange(code) {
      const body = new URLSearchParams({
        client_id: this.clientId!, client_secret: this.clientSecret!,
        grant_type: 'authorization_code', redirect_uri: redirectUri('instagram'), code,
      });
      const tok = await jsonFetch('https://api.instagram.com/oauth/access_token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      });
      // Yeni axın token-i həm birbaşa, həm də data[] içində qaytara bilər.
      const accessToken = tok.access_token || tok?.data?.[0]?.access_token;
      if (!accessToken) throw new Error(tok.error_message || tok.error?.message || 'Token alınmadı');
      const me = await jsonFetch(`https://graph.instagram.com/me?fields=username&access_token=${accessToken}`);
      return { url: me.username ? `https://instagram.com/${me.username}` : 'https://instagram.com' };
    },
  },

  tiktok: {
    clientId: process.env.TIKTOK_CLIENT_KEY,
    clientSecret: process.env.TIKTOK_CLIENT_SECRET,
    buildAuthUrl(state) {
      const p = new URLSearchParams({
        client_key: this.clientId!, redirect_uri: redirectUri('tiktok'),
        scope: 'user.info.basic', response_type: 'code', state,
      });
      return `https://www.tiktok.com/v2/auth/authorize/?${p}`;
    },
    async exchange(code) {
      const body = new URLSearchParams({
        client_key: this.clientId!, client_secret: this.clientSecret!,
        code, grant_type: 'authorization_code', redirect_uri: redirectUri('tiktok'),
      });
      const tok = await jsonFetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      });
      if (!tok.access_token) throw new Error(tok.error_description || 'Token alınmadı');
      const info = await jsonFetch('https://open.tiktokapis.com/v2/user/info/?fields=username,profile_deep_link', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      const u = info?.data?.user;
      return { url: u?.profile_deep_link || (u?.username ? `https://tiktok.com/@${u.username}` : 'https://tiktok.com') };
    },
  },
};

export function getProvider(platform: string): Provider | null {
  return PROVIDERS[platform] || null;
}
// Bu platforma üçün açarlar qoyulubmu (yəni OAuth aktivdir)?
export function isConfigured(platform: string): boolean {
  const p = PROVIDERS[platform];
  return !!(p && p.clientId && p.clientSecret);
}
export const OAUTH_PLATFORMS = Object.keys(PROVIDERS);
