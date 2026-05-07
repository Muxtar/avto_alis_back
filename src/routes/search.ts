import { Router, Response } from 'express';
import { upload } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';
import { analyzeImage } from '../services/deepseek';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { imageSearchLimiter } from '../middleware/rateLimiter';
import fs from 'fs';

const router = Router();

// POST /api/search/image — accepts an uploaded image, runs AI vision
// to extract searchable keywords (brand, model, productType, etc.) and
// returns a structured response that the frontend uses to populate the
// global search bar / redirect to the marketplace with the right filters.
//
// Auth + rate limit required: AI vision calls cost real money (OpenAI
// per-image pricing), so we gate the endpoint to authenticated users
// and cap at 15 requests / hour per IP.
router.post('/search/image', imageSearchLimiter, adminAuth, upload.single('image'), processImages, async (req: AuthRequest, res: Response) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ success: false, message: 'Şəkil tələb olunur' });
      return;
    }
    // After processImages middleware, the file has been re-encoded to JPEG
    // at max 1280px. Read it back and base64-encode for the vision model.
    const buffer = await fs.promises.readFile(file.path);
    const base64 = buffer.toString('base64');
    const analysis = await analyzeImage(base64, 'image/jpeg');

    // Clean up the temporary upload — we don't need to keep search images.
    fs.promises.unlink(file.path).catch(() => undefined);

    res.json({
      success: true,
      analysis,
      // Convenience: a single search query string built from the analysis
      // that the frontend can drop into ?search= directly.
      searchQuery: [analysis.brand, analysis.vehicleBrand, analysis.vehicleModel, analysis.productType]
        .filter(Boolean)
        .join(' ')
        .trim() || analysis.summary,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
