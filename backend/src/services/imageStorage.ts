import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';

export interface UploadResult {
  url: string;
  publicId?: string;
}

// Lazy initialization of Cloudinary SDK to prevent crash if keys are missing on startup
let isConfigured = false;
function configureCloudinary() {
  if (isConfigured) return;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (cloudName && apiKey && apiSecret) {
    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true
    });
    isConfigured = true;
    console.log('[Cloudinary] SDK initialized successfully with credentials.');
  }
}

/**
 * Extract publicId from a Cloudinary asset URL
 * Example: https://res.cloudinary.com/cloudname/image/upload/v12345/folder/sku123.jpg -> folder/sku123
 */
export function extractPublicIdFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  if (!url.includes('cloudinary.com')) return null;

  try {
    const parts = url.split('/image/upload/');
    if (parts.length < 2) return null;

    let remaining = parts[1];

    // Strip version prefix if present, e.g., v1234567/
    if (/^v\d+\//.test(remaining)) {
      remaining = remaining.replace(/^v\d+\//, '');
    }

    // Strip the file extension at the end
    const lastDotIdx = remaining.lastIndexOf('.');
    if (lastDotIdx !== -1) {
      remaining = remaining.slice(0, lastDotIdx);
    }

    return remaining;
  } catch (error) {
    console.error('[Cloudinary] Failed to extract public_id from URL:', error);
    return null;
  }
}

/**
 * Uploads a base64 image string or buffer to Cloudinary using SDK
 */
async function uploadToCloudinary(
  fileData: string | Buffer,
  filename: string,
  cloudName: string,
  apiKey?: string,
  apiSecret?: string
): Promise<UploadResult> {
  console.log('[Cloudinary] Attempting upload for file:', filename);
  configureCloudinary();

  try {
    let sourceData: string;
    if (Buffer.isBuffer(fileData)) {
      sourceData = `data:image/jpeg;base64,${fileData.toString('base64')}`;
    } else {
      sourceData = fileData.startsWith('data:') 
        ? fileData 
        : `data:image/jpeg;base64,${fileData}`;
    }

    const uploadResponse = await cloudinary.uploader.upload(sourceData, {
      resource_type: 'auto',
      folder: 'godhara_products',
    });

    console.log('[Cloudinary Sdk] Upload Success Response:', {
      public_id: uploadResponse.public_id,
      secure_url: uploadResponse.secure_url,
      format: uploadResponse.format,
      bytes: uploadResponse.bytes,
    });

    return {
      url: uploadResponse.secure_url || uploadResponse.url,
      publicId: uploadResponse.public_id
    };
  } catch (err: any) {
    console.error('[Cloudinary Sdk] Upload Failure:', err?.message || err);
    throw err;
  }
}

/**
 * Deletes an image from Cloudinary using SDK
 * @param publicId The unique public ID of the resource to delete from Cloudinary
 */
export async function deleteImageFromCloud(publicId: string): Promise<boolean> {
  console.log(`[Cloudinary Sdk] deleteImageFromCloud initiated for public ID: "${publicId}"`);
  try {
    configureCloudinary();

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      console.warn('[Cloudinary Sdk] Delete bypassed: missing full configuration in environment.');
      return false;
    }

    const destroyResult = await cloudinary.uploader.destroy(publicId);
    console.log('[Cloudinary Sdk] Deletion response result:', destroyResult);

    if (destroyResult && (destroyResult.result === 'ok' || destroyResult.result === 'not_found')) {
      console.log(`[Cloudinary Sdk] Resource deletion status successful (${destroyResult.result}) for:`, publicId);
      return true;
    } else {
      console.warn(`[Cloudinary Sdk] Resource deletion completed with unexpected outcome:`, destroyResult);
      return false;
    }
  } catch (err: any) {
    console.error('[Cloudinary Sdk] Image deletion exception for publicId:', publicId, err?.message || err);
    return false;
  }
}

/**
 * Uploads a base64 image string to ImageKit as fallback
 */
async function uploadToImageKit(
  base64Data: string,
  filename: string,
  privateKey: string,
  publicKey: string
): Promise<UploadResult> {
  console.log('[ImageStorage] Fallback: Attempting ImageKit upload for:', filename);

  const cleanBase64 = base64Data.startsWith('data:') 
    ? base64Data 
    : `data:image/jpeg;base64,${base64Data}`;

  const authHeader = 'Basic ' + Buffer.from(privateKey + ':').toString('base64');

  const bodyData = {
    file: cleanBase64,
    fileName: filename,
  };

  const res = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(bodyData),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Fallback ImageKit upload failed: ${errText}`);
  }

  const data = await res.json() as any;
  return { url: data.url };
}

/**
 * Uploads a base64 image string to Supabase storage container as fallback
 */
async function uploadToSupabase(
  base64Data: string,
  filename: string,
  supabaseUrl: string,
  supabaseKey: string,
  bucketName: string = 'products'
): Promise<UploadResult> {
  console.log('[ImageStorage] Fallback: Attempting Supabase upload for:', filename);

  const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  let base64Content = base64Data;
  let mimeType = 'image/jpeg';

  if (matches && matches.length === 3) {
    mimeType = matches[1];
    base64Content = matches[2];
  }

  const buffer = Buffer.from(base64Content, 'base64');
  const cleanUrl = supabaseUrl.replace(/\/$/, '');
  const timestamp = Date.now();
  const filePath = `img_${timestamp}_${filename.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;

  const uploadUrl = `${cleanUrl}/storage/v1/object/${bucketName}/${filePath}`;

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': mimeType,
    },
    body: buffer,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Fallback Supabase storage upload failed: ${errText}`);
  }

  const publicUrl = `${cleanUrl}/storage/v1/object/public/${bucketName}/${filePath}`;
  return { url: publicUrl };
}

/**
 * Public Cloud Image Uploader dispatcher (Main Export Service)
 */
export async function uploadImageToCloud(
  fileField: string | Buffer,
  filename: string = 'image.jpg'
): Promise<UploadResult> {
  try {
    const cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const cloudinaryApiKey = process.env.CLOUDINARY_API_KEY;
    const cloudinaryApiSecret = process.env.CLOUDINARY_API_SECRET;

    // 1. Prioritize Cloudinary Setup
    if (cloudinaryCloudName) {
      return await uploadToCloudinary(
        fileField,
        filename,
        cloudinaryCloudName,
        cloudinaryApiKey,
        cloudinaryApiSecret
      );
    }

    // 2. imagekit / supabase as legacy fallbacks
    const strFile = Buffer.isBuffer(fileField) ? fileField.toString('base64') : fileField;

    const imagekitPrivateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    const imagekitPublicKey = process.env.IMAGEKIT_PUBLIC_KEY;

    if (imagekitPrivateKey && imagekitPublicKey) {
      return await uploadToImageKit(
        strFile,
        filename,
        imagekitPrivateKey,
        imagekitPublicKey
      );
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    const supabaseBucket = process.env.SUPABASE_BUCKET || 'products';

    if (supabaseUrl && supabaseKey) {
      return await uploadToSupabase(
        strFile,
        filename,
        supabaseUrl,
        supabaseKey,
        supabaseBucket
      );
    }

    // 3. Fallback to base64 encoding directly inside DB
    console.log('[ImageStorage] Fallback: No cloud storage keys provided. Storing Base64 URL data string directly.');
    const cleanBase64 = strFile.startsWith('data:')
      ? strFile
      : `data:image/jpeg;base64,${strFile}`;

    return { url: cleanBase64 };

  } catch (err: any) {
    console.error('[ImageStorage] Dispatch cloud upload failure:', err?.message || err);
    throw err;
  }
}
