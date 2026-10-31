// Image storage with a local driver (development) and an S3-compatible driver (production).
// Every upload is decoded and re-encoded with sharp: this validates that it is really an image,
// strips metadata (EXIF/GPS), bounds dimensions and removes any embedded payloads.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config/env.js';
import { randomToken } from '../utils/crypto.js';
import { badRequest } from './errors.js';

const ALLOWED = new Set(['jpeg', 'png', 'webp']);
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function processImage(buffer, { maxWidth = 2000, maxHeight = 2000 } = {}) {
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: 50_000_000 }).metadata();
  } catch {
    throw badRequest('That file is not a valid image', undefined, 'INVALID_IMAGE');
  }
  if (!ALLOWED.has(meta.format)) throw badRequest('Only JPEG, PNG or WebP images are allowed', undefined, 'INVALID_IMAGE');
  const out = await sharp(buffer, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: maxWidth, height: maxHeight, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  return out;
}

let s3Client;
async function s3() {
  if (!s3Client) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: config.S3_REGION || 'auto',
      endpoint: config.S3_ENDPOINT || undefined,
      forcePathStyle: Boolean(config.S3_ENDPOINT),
      credentials: config.S3_ACCESS_KEY_ID ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY } : undefined,
    });
  }
  return s3Client;
}

/** @returns {Promise<string>} public URL of the stored image */
export async function saveImage(buffer, folder = 'events', opts) {
  const processed = await processImage(buffer, opts);
  const name = `${folder}/${randomToken(18)}.webp`;

  if (config.STORAGE_DRIVER === 's3') {
    if (!config.S3_BUCKET || !config.S3_PUBLIC_BASE_URL) throw new Error('S3_BUCKET and S3_PUBLIC_BASE_URL are required for STORAGE_DRIVER=s3');
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await s3()).send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: name, Body: processed, ContentType: 'image/webp', CacheControl: 'public, max-age=31536000, immutable' }));
    return `${config.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${name}`;
  }

  const dir = path.resolve(config.LOCAL_UPLOAD_DIR, folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.resolve(config.LOCAL_UPLOAD_DIR, name), processed);
  return `/uploads/${name}`;
}
