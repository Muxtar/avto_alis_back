import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import authRoutes from './routes/auth';
import verifyRoutes from './routes/verify';
import listingsRoutes from './routes/listings';
import adminRoutes from './routes/admin';
import userRoutes from './routes/user';
import messageRoutes from './routes/messages';
import cartRoutes from './routes/cart';
import courierRoutes from './routes/courier';
import inquiryRoutes from './routes/inquiry';
import favoritesRoutes from './routes/favorites';
import addressesRoutes from './routes/addresses';
import promoRoutes from './routes/promo';
import ratingsRoutes from './routes/ratings';
import notificationsRoutes from './routes/notifications';
import sellerRoutes from './routes/seller';

const app = express();
const PORT = process.env.PORT || 5001;

// Fix #17: CORS - env-based config
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:3000', 'http://localhost:3001'];

const corsOptions = {
  origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    // Origin yoxdursa (server-to-server, curl) icazə ver
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

const uploadsDir = path.join(__dirname, '../uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

app.use('/api', authRoutes);
app.use('/api', verifyRoutes);
app.use('/api', listingsRoutes);
app.use('/api', adminRoutes);
app.use('/api', userRoutes);
app.use('/api', messageRoutes);
app.use('/api', cartRoutes);
app.use('/api', courierRoutes);
app.use('/api', inquiryRoutes);
app.use('/api', favoritesRoutes);
app.use('/api', addressesRoutes);
app.use('/api', promoRoutes);
app.use('/api', ratingsRoutes);
app.use('/api', notificationsRoutes);
app.use('/api', sellerRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Fix #16: 404 handler - tanimlanmamis route'lar icin
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, message: 'Endpoint tapılmadı' });
});

// Fix #15: Global error handler - yakalanmamis hatalari yakalar
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  console.error(`[${req.method} ${req.path}] Unhandled error:`, err.message, err.code || '');
  console.error(err.stack);

  // Multer file size error
  if (err.message?.includes('File too large') || err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ success: false, message: 'Fayl çox böyükdür (max 5MB)' });
    return;
  }

  // Multer unexpected file
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    res.status(400).json({ success: false, message: 'Gözlənilməyən fayl sahəsi' });
    return;
  }

  // Multer file type error
  if (err.message?.includes('resim dosyaları')) {
    res.status(400).json({ success: false, message: err.message });
    return;
  }

  // Filesystem errors (uploads/ yoxdursa)
  if (err.code === 'ENOENT' || err.code === 'EACCES') {
    res.status(500).json({ success: false, message: 'Server fayl sistemi xətası' });
    return;
  }

  // JSON parse error
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ success: false, message: 'Yanlış JSON formatı' });
    return;
  }

  res.status(500).json({ success: false, message: 'Server xətası baş verdi' });
});

// Unhandled promise rejections
process.on('unhandledRejection', (reason: any) => {
  console.error('Unhandled Promise Rejection:', reason);
});

// Backfill expiresAt for legacy listings created before this column existed.
// Idempotent: only updates rows where expiresAt IS NULL.
async function backfillListingExpiresAt() {
  try {
    const prisma = new PrismaClient();
    const updated = await prisma.$executeRaw`UPDATE "Listing" SET "expiresAt" = "createdAt" + INTERVAL '20 days' WHERE "expiresAt" IS NULL`;
    if (updated > 0) console.log(`[startup] Backfilled expiresAt on ${updated} legacy listings`);
    await prisma.$disconnect();
  } catch (err: any) {
    console.error('[startup] expiresAt backfill failed:', err.message);
  }
}

// One-time optimization of legacy uploads: re-encodes oversized / progressive
// images to baseline JPEG (1280px max) so browsers render them fully on first paint.
// Idempotent: skips files already small enough.
async function backfillOptimizeImages() {
  try {
    const dir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(dir)) return;
    const files = await fs.promises.readdir(dir);
    let processed = 0;
    for (const filename of files) {
      if (!/\.(jpe?g|png|webp)$/i.test(filename)) continue;
      const fullPath = path.join(dir, filename);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (stat.size < 200 * 1024) continue;
        const buffer = await fs.promises.readFile(fullPath);
        const meta = await sharp(buffer).metadata();
        const oversized = (meta.width || 0) > 1280 || (meta.height || 0) > 1280;
        const progressive = !!meta.isProgressive;
        if (!oversized && !progressive && stat.size < 400 * 1024) continue;
        const out = await sharp(buffer)
          .rotate()
          .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80, progressive: false, mozjpeg: true })
          .toBuffer();
        await fs.promises.writeFile(fullPath, out);
        processed++;
      } catch (err: any) {
        console.error(`[startup] Could not optimize ${filename}:`, err.message);
      }
    }
    if (processed > 0) console.log(`[startup] Re-encoded ${processed} legacy images to baseline JPEG`);
  } catch (err: any) {
    console.error('[startup] image backfill failed:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`CORS origins: ${allowedOrigins.join(', ')}`);
  backfillListingExpiresAt();
  backfillOptimizeImages();
});
