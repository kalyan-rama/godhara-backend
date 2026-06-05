import { v2 as cloudinary } from 'cloudinary';

export interface UploadResult {
  url: string;
  publicId?: string;
}

// Track Cloudinary config state
let cloudinaryConfigured = false;

function ensureCloudinaryConfigured(): boolean {
  if (cloudinaryConfigured) return true;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    console.warn('[Cloudinary] Missing environment variables: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET');
    return false;
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

  cloudinaryConfigured = true;
  console.log(`[Cloudinary] Configured for cloud: ${cloudName}`);
  return true;
}

/**
 * Extract Cloudinary public_id from a Cloudinary URL.
 * e.g. https://res.cloudinary.com/mycloud/image/upload/v1234/godhara_products/abc123.jpg
 * → godhara_products/abc123
 */
export function extractPublicIdFromUrl(url: string | undefined | null): string | null {
  if (!url || !url.includes('cloudinary.com')) return null;
  try {
    const parts = url.split('/image/upload/');
    if (parts.length < 2) return null;
    let remaining = parts[1];
    // Strip version prefix e.g. v1234567/
    remaining = remaining.replace(/^v\d+\//, '');
    // Strip file extension
    const dotIdx = remaining.lastIndexOf('.');
    if (dotIdx !== -1) remaining = remaining.slice(0, dotIdx);
    return remaining || null;
  } catch {
    return null;
  }
}

/**
 * Upload a base64 or Buffer image to Cloudinary.
 */
export async function uploadImageToCloud(
  fileData: string | Buffer,
  filename: string = 'image.jpg'
): Promise<UploadResult> {
  if (!ensureCloudinaryConfigured()) {
    // Fallback: store as base64 data URL if no cloud storage configured
    console.warn('[ImageStorage] No cloud storage configured. Storing as base64 (NOT recommended for production).');
    const cleanBase64 = Buffer.isBuffer(fileData)
      ? `data:image/jpeg;base64,${fileData.toString('base64')}`
      : fileData.startsWith('data:') ? fileData : `data:image/jpeg;base64,${fileData}`;
    return { url: cleanBase64 };
  }

  console.log(`[Cloudinary] Uploading: ${filename}`);

  try {
    let sourceData: string;
    if (Buffer.isBuffer(fileData)) {
      sourceData = `data:image/jpeg;base64,${fileData.toString('base64')}`;
    } else {
      sourceData = fileData.startsWith('data:') ? fileData : `data:image/jpeg;base64,${fileData}`;
    }

    // Validate input size (Cloudinary limit is 100MB but we cap at 10MB for safety)
    const sizeEstimate = sourceData.length * 0.75; // approx bytes from base64
    if (sizeEstimate > 10 * 1024 * 1024) {
      throw new Error('Image too large (max 10MB)');
    }

    const result = await cloudinary.uploader.upload(sourceData, {
      resource_type: 'image',
      folder: 'godhara_products',
      use_filename: true,
      unique_filename: true,
      overwrite: false,
      transformation: [
        { width: 1200, height: 1200, crop: 'limit' },
        { quality: 'auto:good' },
        { fetch_format: 'auto' },
      ],
    });

    console.log(`[Cloudinary] Upload success: ${result.public_id} → ${result.secure_url}`);
    return {
      url: result.secure_url,
      publicId: result.public_id,
    };
  } catch (err: any) {
    console.error('[Cloudinary] Upload failed:', err?.message || err);
    throw new Error(`Cloudinary upload failed: ${err?.message || String(err)}`);
  }
}

/**
 * Delete an image from Cloudinary by public_id.
 */
export async function deleteImageFromCloud(publicId: string): Promise<boolean> {
  if (!publicId) return false;
  if (!ensureCloudinaryConfigured()) {
    console.warn('[Cloudinary] Cannot delete: not configured');
    return false;
  }

  try {
    console.log(`[Cloudinary] Deleting: ${publicId}`);
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    const success = result?.result === 'ok' || result?.result === 'not_found';
    console.log(`[Cloudinary] Delete result for "${publicId}":`, result?.result);
    return success;
  } catch (err: any) {
    console.error(`[Cloudinary] Delete failed for "${publicId}":`, err?.message || err);
    return false;
  }
}

/**
 * Delete multiple images from Cloudinary.
 */
export async function deleteImagesFromCloud(publicIds: string[]): Promise<void> {
  if (!publicIds.length) return;
  await Promise.allSettled(publicIds.map(id => deleteImageFromCloud(id)));
}
