import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`CORS origins: ${allowedOrigins.join(', ')}`);
});
