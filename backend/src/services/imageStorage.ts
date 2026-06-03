import crypto from 'crypto';

interface UploadResult {
  url: string;
}

/**
 * Uploads a base64 image string to Cloudinary
 */
async function uploadToCloudinary(
  base64Data: string,
  filename: string,
  cloudName: string,
  apiKey?: string,
  apiSecret?: string,
  preset?: string
): Promise<UploadResult> {
  console.log('[ImageStorage] Attempting Cloudinary upload for:', filename);

  const cleanBase64 = base64Data.startsWith('data:') 
    ? base64Data 
    : `data:image/jpeg;base64,${base64Data}`;

  // If a preset is configured, we can do an unsigned upload
  if (preset) {
    console.log('[ImageStorage] Cloudinary unsigned upload with preset:', preset);
    const formData = new URLSearchParams();
    formData.append('file', cleanBase64);
    formData.append('upload_preset', preset);

    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Cloudinary preset upload failed: ${errText}`);
    }

    const data = await res.json() as any;
    return { url: data.secure_url || data.url };
  }

  // Otherwise, use signed upload with API key / secret
  if (!apiKey || !apiSecret) {
    throw new Error('Cloudinary signed upload requires API key and API secret.');
  }

  const timestamp = Math.round(Date.now() / 1000).toString();
  const signatureString = `timestamp=${timestamp}${apiSecret}`;
  const signature = crypto
    .createHash('sha1')
    .update(signatureString)
    .digest('hex');

  const formData = new URLSearchParams();
  formData.append('file', cleanBase64);
  formData.append('api_key', apiKey);
  formData.append('timestamp', timestamp);
  formData.append('signature', signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Cloudinary signed upload failed: ${errText}`);
  }

  const data = await res.json() as any;
  return { url: data.secure_url || data.url };
}

/**
 * Uploads a base64 image string to ImageKit
 */
async function uploadToImageKit(
  base64Data: string,
  filename: string,
  privateKey: string,
  publicKey: string
): Promise<UploadResult> {
  console.log('[ImageStorage] Attempting ImageKit upload for:', filename);

  // Strip prefixes if ImageKit prefers raw base64 or format with data prefix
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
    throw new Error(`ImageKit upload failed: ${errText}`);
  }

  const data = await res.json() as any;
  return { url: data.url };
}

/**
 * Uploads a base64 image string to Supabase storage container
 */
async function uploadToSupabase(
  base64Data: string,
  filename: string,
  supabaseUrl: string,
  supabaseKey: string,
  bucketName: string = 'products'
): Promise<UploadResult> {
  console.log('[ImageStorage] Attempting Supabase upload for:', filename);

  // Convert base64 data to binary buffer
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
    throw new Error(`Supabase storage upload failed: ${errText}`);
  }

  // Get public URL
  const publicUrl = `${cleanUrl}/storage/v1/object/public/${bucketName}/${filePath}`;
  return { url: publicUrl };
}

/**
 * Public Cloud Image Uploader dispatcher
 */
export async function uploadImageToCloud(
  base64Data: string,
  filename: string = 'image.jpg'
): Promise<UploadResult> {
  try {
    // 1. Check Cloudinary settings
    const cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const cloudinaryApiKey = process.env.CLOUDINARY_API_KEY;
    const cloudinaryApiSecret = process.env.CLOUDINARY_API_SECRET;
    const cloudinaryPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

    if (cloudinaryCloudName) {
      return await uploadToCloudinary(
        base64Data,
        filename,
        cloudinaryCloudName,
        cloudinaryApiKey,
        cloudinaryApiSecret,
        cloudinaryPreset
      );
    }

    // 2. Check ImageKit settings
    const imagekitPrivateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    const imagekitPublicKey = process.env.IMAGEKIT_PUBLIC_KEY;

    if (imagekitPrivateKey && imagekitPublicKey) {
      return await uploadToImageKit(
        base64Data,
        filename,
        imagekitPrivateKey,
        imagekitPublicKey
      );
    }

    // 3. Check Supabase Storage settings
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    const supabaseBucket = process.env.SUPABASE_BUCKET || 'products';

    if (supabaseUrl && supabaseKey) {
      return await uploadToSupabase(
        base64Data,
        filename,
        supabaseUrl,
        supabaseKey,
        supabaseBucket
      );
    }

    // 4. Default Fallback
    console.log('[ImageStorage] No cloud storage environment variables detected. Falling back to high-fidelity Base64 string directly stored in PostgreSQL to guarantee 100% rendering without ephemeral disk dependencies.');
    
    // Validate image format prefix is present
    const cleanBase64 = base64Data.startsWith('data:')
      ? base64Data
      : `data:image/jpeg;base64,${base64Data}`;

    // Return the base64 string directly. Perfect for single-user offline, local or demo PostgreSQL storage.
    return { url: cleanBase64 };

  } catch (err: any) {
    console.error('[ImageStorage] Cloud upload driver failure:', err);
    throw err;
  }
}
