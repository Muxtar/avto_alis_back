import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { Request, Response, NextFunction } from 'express';

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 80;

async function processOne(file: Express.Multer.File): Promise<void> {
  const buffer = await fs.promises.readFile(file.path);
  const out = await sharp(buffer)
    .rotate()
    .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, progressive: true, mozjpeg: true })
    .toBuffer();

  const dir = path.dirname(file.path);
  const base = path.basename(file.path, path.extname(file.path));
  const newPath = path.join(dir, base + '.jpg');
  await fs.promises.writeFile(newPath, out);
  if (newPath !== file.path) {
    await fs.promises.unlink(file.path).catch(() => {});
  }
  file.path = newPath;
  file.filename = base + '.jpg';
  file.size = out.length;
}

export async function processImages(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const files: Express.Multer.File[] = [];
    if (req.file) files.push(req.file);
    if (Array.isArray(req.files)) {
      files.push(...(req.files as Express.Multer.File[]));
    } else if (req.files && typeof req.files === 'object') {
      for (const key of Object.keys(req.files)) {
        const v = (req.files as Record<string, Express.Multer.File[]>)[key];
        if (Array.isArray(v)) files.push(...v);
      }
    }
    await Promise.all(files.map(processOne));
    next();
  } catch (err) {
    next(err);
  }
}
