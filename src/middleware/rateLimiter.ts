import { Request, Response, NextFunction } from 'express';

// In-memory rate limiter - IP bazli istek sinirlamasi
const requests = new Map<string, { count: number; resetAt: number }>();

// Belirli araliklarda eski kayitlari temizle
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of requests.entries()) {
    if (val.resetAt < now) requests.delete(key);
  }
}, 60 * 1000); // her dakika temizle

export function rateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const key = `${ip}:${req.path}`;
    const now = Date.now();

    const record = requests.get(key);

    if (!record || record.resetAt < now) {
      // Yeni pencere baslat
      requests.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (record.count >= maxRequests) {
      const retryAfter = Math.ceil((record.resetAt - now) / 1000);
      res.status(429).json({
        success: false,
        message: `Çox sayda sorğu göndərdiniz. ${retryAfter} saniyə sonra yenidən cəhd edin.`,
      });
      return;
    }

    record.count++;
    next();
  };
}

// Onceden tanimlanmis limitler
// Auth endpointler: 5 istek / 1 dakika
export const authLimiter = rateLimit(5, 60 * 1000);

// Verify endpointler: 5 istek / 5 dakika (brute-force korunmasi)
export const verifyLimiter = rateLimit(5, 5 * 60 * 1000);

// Register endpointler: 3 istek / 10 dakika
export const registerLimiter = rateLimit(3, 10 * 60 * 1000);

// Listing yaratma — depolama spam koruması: 30 istek / saat
export const listingWriteLimiter = rateLimit(30, 60 * 60 * 1000);

// Bulk publish (Desktop) — 10 istek / saat (her biri 100 elemana qədər)
export const bulkLimiter = rateLimit(10, 60 * 60 * 1000);

// AI/Inquiry — DeepSeek spam korumas: 20 istek / saat
export const inquiryLimiter = rateLimit(20, 60 * 60 * 1000);

// Image search — OpenAI vision API qoruması: 15 istek / saat
export const imageSearchLimiter = rateLimit(15, 60 * 60 * 1000);
