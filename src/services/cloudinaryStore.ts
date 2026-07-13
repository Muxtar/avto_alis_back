// Cloudinary (bulud şəkil anbarı) — şəkillər serverin diskinə deyil, buluda
// yüklənir, deploy-lar arasında İTMİR + CDN ilə sürətli servis olunur.
// Açarlar KODA YAZILMIR — env-dən oxunur (Railway):
//   CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
//   (və ya ayrıca: CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET)
import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

// CLOUDINARY_URL env qoyulubsa SDK onu avtomatik oxuyur; ayrıca açarlar
// verilibsə əl ilə konfiqurasiya edirik.
if (cloudName && apiKey && apiSecret) {
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
} else if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ secure: true });
}

export function isCloudinaryConfigured(): boolean {
  return !!(process.env.CLOUDINARY_URL || (cloudName && apiKey && apiSecret));
}

// Yerli faylı Cloudinary-yə yüklə → daimi secure URL qaytar.
export async function uploadToCloudinary(filePath: string, folder = 'listings'): Promise<string> {
  const res = await cloudinary.uploader.upload(filePath, {
    folder: `tradixai/${folder}`,
    resource_type: 'image',
  });
  return res.secure_url;
}

// URL Cloudinary-dirsə public_id-ni çıxarıb şəkli sil (elan silinəndə təmizlik).
export async function deleteFromCloudinary(url: string): Promise<void> {
  if (!isCloudinaryConfigured() || !/res\.cloudinary\.com/.test(url)) return;
  try {
    const m = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+$/);
    if (m && m[1]) await cloudinary.uploader.destroy(m[1]);
  } catch { /* təmizlik xətaları səssiz keçilir */ }
}

// Faylı (fs) təhlükəsiz sil.
export function unlinkLocal(filePath: string): void {
  fs.promises.unlink(filePath).catch(() => {});
}
