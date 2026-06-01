import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import fs from 'fs';
import path from 'path';

const STORAGE_DIR = path.join(process.cwd(), 'data', 'documents');

// Ensure storage directories exist
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

export function getInvoicePath(orderId: string): string {
  return path.join(STORAGE_DIR, `invoice-${orderId}.pdf`);
}

export function getLabelPath(orderId: string): string {
  return path.join(STORAGE_DIR, `label-${orderId}.pdf`);
}

// Generate Barcode using bwip-js
async function generateBarcodeBuffer(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    bwipjs.toBuffer(
      {
        bcid: 'code128',       // Barcode type
        text: text,            // Text to encode
        scale: 2,              // Scale factor
        height: 12,            // Height in mm
        includetext: false,    // No text embedded inside barcode
        textxalign: 'center',
      },
      (err, png) => {
        if (err) reject(err);
        else resolve(png);
      }
    );
  });
}

// Helper to retrieve the official company brand logo image path
function getCompanyLogoPath(): string | null {
  const logoPath = path.join(process.cwd(), 'public', 'logo.png');

  if (fs.existsSync(logoPath)) {
    console.log(`[PDF Generator] Loaded company logo image from: ${logoPath}`);
    return logoPath;
  }

  console.warn('[PDF Generator] Warning: No company logo found at public/logo.png.');
  return null;
}
const ASSETS_DIR = path.join(process.cwd(), 'assets');

if (!fs.existsSync(ASSETS_DIR)) {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

const defaultLogoPath = path.join(ASSETS_DIR, 'logo.png');

if (!fs.existsSync(defaultLogoPath)) {
  const defaultPngBase64 = '...';
  try {
    fs.writeFileSync(defaultLogoPath, Buffer.from(defaultPngBase64, 'base64'));
    console.log('[PDF Generator] Successfully initialized default company logo PNG under "assets/logo.png"');
  } catch (err) {
    console.error('[PDF Generator] Failed to initialize default company logo file assets/logo.png:', err);
  }
}
// Generate a Tax Invoice PDF
export async function generateInvoicePDF(order: any): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const destPath = getInvoicePath(order.id);
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const stream = fs.createWriteStream(destPath);
      doc.pipe(stream);

      // Colors
      const primaryColor = '#6B2D0E'; // deep brown
      const secondaryColor = '#2C1810'; // dark brown text
      const accentColor = '#E8820C'; // saffron orange
      const tableHeaderBg = '#F5EFE6'; // cream background

      // Header Brand Group
      const logoPath = getCompanyLogoPath();
      if (logoPath) {
        doc.image(logoPath, 40, 40, { width: 50 });
      } else {
        doc.font('Helvetica-Bold').fontSize(14).fillColor(primaryColor).text('[G]', 48, 48);
      }
      doc.font('Helvetica-Bold').fontSize(22).fillColor(primaryColor).text('Godhara', 100, 42);
      doc.font('Helvetica').fontSize(9).fillColor(secondaryColor).text('Gau Traditional Ayurvedic Products', 100, 64);
      doc.font('Helvetica').fontSize(8).fillColor('#777777').text('Pocharam Apartment, Banswada, Telangana 503187', 100, 76);

      // Invoice Title
      doc.font('Helvetica-Bold').fontSize(16).fillColor(primaryColor).text('TAX INVOICE', 430, 42, { align: 'right' });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(secondaryColor).text(`INVOICE NO: ${order.invoiceNumber || 'INV-' + order.id.replace('GDH-', '')}`, 430, 62, { align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor('#555555').text(`Date: ${new Date(order.createdAt).toLocaleDateString()}`, 430, 76, { align: 'right' });

      doc.moveTo(40, 105).lineTo(555, 105).strokeColor('#D4B896').lineWidth(1).stroke();

      // Customer Info & Store Info
      doc.font('Helvetica-Bold').fontSize(10).fillColor(primaryColor).text('BILLED TO:', 40, 115);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(secondaryColor).text(order.shippingAddress.name, 40, 127);
      doc.font('Helvetica').fontSize(9).fillColor(secondaryColor).text(order.shippingAddress.street, 40, 140);
      doc.font('Helvetica').fontSize(9).fillColor(secondaryColor).text(`${order.shippingAddress.city}, ${order.shippingAddress.state} - ${order.shippingAddress.pincode}`, 40, 152);
      doc.font('Helvetica').fontSize(9).fillColor(secondaryColor).text(`Phone: ${order.shippingAddress.phone || 'N/A'}`, 40, 164);
      doc.font('Helvetica').fontSize(9).fillColor(secondaryColor).text(`Email: ${order.shippingAddress.email || 'N/A'}`, 40, 176);

      // Payment Method Info
      doc.font('Helvetica-Bold').fontSize(10).fillColor(primaryColor).text('PAYMENT DETAILS:', 350, 115);
      doc.font('Helvetica').fontSize(9).fillColor(secondaryColor).text(`Payment Status: ${order.paymentStatus || 'PAID'}`, 350, 127);
      doc.font('Helvetica').fontSize(9).fillColor(secondaryColor).text(`Razorpay ID: ${order.razorpayPaymentId || 'N/A'}`, 350, 140);
      doc.font('Helvetica').fontSize(9).fillColor(secondaryColor).text(`Payment Date: ${order.paymentDate ? new Date(order.paymentDate).toLocaleDateString() : 'N/A'}`, 350, 152);
      doc.font('Helvetica').fontSize(9).fillColor(secondaryColor).text(`Tracking No: ${order.trackingNumber || 'N/A'}`, 350, 164);
      doc.font('Helvetica').fontSize(9).fillColor(secondaryColor).text(`Delivery Mode: Gaushala Cargo Logistics`, 350, 176);

      // Table Header
      const tableTop = 205;
      doc.rect(40, tableTop, 515, 20).fill(tableHeaderBg);

      doc.font('Helvetica-Bold').fontSize(9).fillColor(primaryColor);
      doc.text('S.No', 45, tableTop + 6, { width: 30 });
      doc.text('Description of Ayurvedic Product', 85, tableTop + 6, { width: 240 });
      doc.text('Qty', 335, tableTop + 6, { width: 30, align: 'center' });
      doc.text('Unit Price', 380, tableTop + 6, { width: 70, align: 'right' });
      doc.text('Total (INR)', 465, tableTop + 6, { width: 85, align: 'right' });

      // Clean divider line
      doc.moveTo(40, tableTop + 20).lineTo(555, tableTop + 20).strokeColor('#D4B896').lineWidth(0.5).stroke();

      // Table Items
      let currentTop = tableTop + 25;
      order.items.forEach((item: any, i: number) => {
        // Safe check for item weight/grams if present
        const labelText = item.weight ? `${item.name} (${item.weight}g)` : item.name;

        doc.font('Helvetica').fontSize(9).fillColor(secondaryColor);
        doc.text((i + 1).toString(), 45, currentTop, { width: 30 });
        doc.text(labelText, 85, currentTop, { width: 240, height: 16 });
        doc.text(item.qty.toString(), 335, currentTop, { width: 30, align: 'center' });
        doc.text(`Rs. ${item.unitPrice.toFixed(2)}`, 380, currentTop, { width: 70, align: 'right' });
        doc.text(`Rs. ${(item.qty * item.unitPrice).toFixed(2)}`, 465, currentTop, { width: 85, align: 'right' });

        currentTop += 20;
      });

      // Bottom Section Divider
      doc.moveTo(40, currentTop).lineTo(555, currentTop).strokeColor('#D4B896').lineWidth(0.5).stroke();
      currentTop += 10;

      // Totals Panel
      const totalLabelX = 350;
      const totalValX = 465;

      doc.font('Helvetica').fontSize(9).fillColor(secondaryColor);
      doc.text('Subtotal:', totalLabelX, currentTop, { width: 110, align: 'right' });
      doc.text(`Rs. ${order.subtotal.toFixed(2)}`, totalValX, currentTop, { width: 85, align: 'right' });
      currentTop += 16;

      doc.text('Shipping Charge:', totalLabelX, currentTop, { width: 110, align: 'right' });
      doc.text(order.shippingCharge === 0 ? 'FREE' : `Rs. ${order.shippingCharge.toFixed(2)}`, totalValX, currentTop, { width: 85, align: 'right' });
      currentTop += 16;

      // GST Line
      const gstAmount = order.subtotal * 0.05; // 5% GST included
      doc.text('GST (5% Included):', totalLabelX, currentTop, { width: 110, align: 'right' });
      doc.text(`Rs. ${gstAmount.toFixed(2)}`, totalValX, currentTop, { width: 85, align: 'right' });
      currentTop += 20;

      // Grand Total Ring
      doc.rect(340, currentTop - 2, 215, 20).fill(tableHeaderBg);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(primaryColor);
      doc.text('GRAND TOTAL:', totalLabelX, currentTop + 3, { width: 110, align: 'right' });
      doc.text(`Rs. ${order.total.toFixed(2)}`, totalValX, currentTop + 3, { width: 85, align: 'right' });

      // Traditional Seal Note and Thank You Footer
      currentTop += 65;
      doc.font('Helvetica-Oblique').fontSize(10).fillColor(primaryColor).text('Thank you for shopping with Godhara!', 40, currentTop, { align: 'center' });
      doc.font('Helvetica').fontSize(8).fillColor('#777777').text('Every purchase supports Gaushalas & sustainable organic Indian farming loops.', 40, currentTop + 14, { align: 'center' });

      // Elegant tiny footer credit
      doc.font('Helvetica').fontSize(7).fillColor('#AAAAAA').text('Powering Indian Vedic Traditions. Built by Nexkite.', 40, doc.page.height - 30, { align: 'center' });

      doc.end();

      stream.on('finish', () => resolve(destPath));
      stream.on('error', (err) => reject(err));
    } catch (e) {
      reject(e);
    }
  });
}

// Generate A6 Shipping Label PDF
export async function generateShippingLabelPDF(order: any): Promise<string> {
  return new Promise(async (resolve, reject) => {
    try {
      const destPath = getLabelPath(order.id);
      
      // A6 standard page size dimensions: 105mm x 148mm = 297.64 points x 419.53 points
      const doc = new PDFDocument({
        size: [297.64, 419.53],
        margin: 15
      });

      const stream = fs.createWriteStream(destPath);
      doc.pipe(stream);

      // Colors
      const primaryColor = '#6B2D0E'; // deep brown
      const textDark = '#2C1810'; // dark brown

      // FROM Header
      const logoPath = getCompanyLogoPath();
      if (logoPath) {
        doc.image(logoPath, 15, 11, { width: 45 });
      } else {
        doc.font('Helvetica-Bold').fontSize(10).fillColor(primaryColor).text('[G]', 22, 21);
      }
      doc.font('Helvetica-Bold').fontSize(11).fillColor(primaryColor).text('GODHARA PRODUCTS', 72, 14);
      doc.font('Helvetica').fontSize(6).fillColor(textDark).text('FROM: Pocharam Apartment, Banswada, Telangana 503187', 72, 26, { width: 210 });
      doc.text('Ph: +91 8978038932 | support@godhara.com', 72, 33, { width: 210 });

      // Divide line
      doc.moveTo(15, 46).lineTo(282, 46).strokeColor('#6B2D0E').lineWidth(1.5).stroke();

      // SHIP TO Section
      doc.font('Helvetica-Bold').fontSize(8).fillColor(primaryColor).text('SHIP TO:', 15, 53);
      
      doc.font('Helvetica-Bold').fontSize(13).fillColor(textDark).text(order.shippingAddress.name, 15, 64, { width: 260, height: 16 });
      doc.font('Helvetica').fontSize(9).text(order.shippingAddress.street, 15, 82, { width: 260, height: 36 });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(primaryColor).text(`${order.shippingAddress.city}, ${order.shippingAddress.state}`, 15, 120);

      // Large PINCODE block
      doc.rect(15, 136, 267, 28).fill('#F5EFE6');
      doc.font('Helvetica-Bold').fontSize(15).fillColor(primaryColor).text(`PIN: ${order.shippingAddress.pincode}`, 22, 143);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(textDark).text(`PHONE: ${order.shippingAddress.phone}`, 152, 146);

      // Details bar
      const totalWeight = order.items.reduce((acc: number, item: any) => acc + (item.weight || 250) * item.qty, 0);
      const totalQty = order.items.reduce((acc: number, item: any) => acc + item.qty, 0);

      doc.font('Helvetica').fontSize(8).fillColor(textDark);
      doc.text(`Dispatch Date: ${new Date(order.createdAt).toLocaleDateString()}`, 15, 171);
      doc.text(`Total Weight: ${(totalWeight / 1000).toFixed(2)} kg`, 15, 183);
      doc.text(`Total Items: ${totalQty} pcs`, 15, 195);

      const trackingNo = order.trackingNumber || `TRK-GDH-${order.id.slice(0, 8).toUpperCase()}`;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(primaryColor).text(`TRACKING NO: ${trackingNo}`, 130, 171, { width: 152, align: 'right' });
      doc.font('Helvetica').fontSize(7.5).fillColor(textDark).text(`Order Ref: ${order.id}`, 130, 183, { width: 152, align: 'right' });
      doc.text(`Payment: ${order.paymentStatus || 'PAID'}`, 130, 195, { width: 152, align: 'right' });

      // Divider line before barcode
      doc.moveTo(15, 210).lineTo(282, 210).strokeColor('#D4B896').lineWidth(0.5).stroke();

      // Dynamic Barcode of Order ID via bwip-js
      try {
        const barcodeBuffer = await generateBarcodeBuffer(order.id);
        doc.image(barcodeBuffer, 15, 217, { width: 267, height: 42 });
        
        doc.font('Helvetica-Bold').fontSize(10).fillColor(textDark).text(order.id, 15, 264, { align: 'center', width: 267 });
      } catch (err) {
        console.error('Failed to generate label barcode:', err);
        // Fallback display
        doc.rect(15, 217, 267, 42).strokeColor('#6B2D0E').stroke();
        doc.font('Helvetica-Bold').fontSize(10).text(`ORDER REF: ${order.id}`, 15, 233, { align: 'center', width: 267 });
      }

      // ITEMIZATION PRECIS (ALL ORDER DETAILS FITTED TO 1/4 A4 PRINT SIZE)
      doc.font('Helvetica-Bold').fontSize(7).fillColor(primaryColor).text('ITEMIZED PACKING CONTENT:', 15, 280);
      
      let itemY = 290;
      // Small grey table header
      doc.rect(15, itemY, 267, 10).fill('#F5EFE6');
      doc.font('Helvetica-Bold').fontSize(6).fillColor(primaryColor);
      doc.text('Product / Variant & Specs', 18, itemY + 2, { width: 200 });
      doc.text('Qty', 245, itemY + 2, { width: 30, align: 'right' });
      itemY += 10;

      // Draw rows
      doc.font('Helvetica').fontSize(6).fillColor(textDark);
      order.items.slice(0, 5).forEach((item: any) => {
        const itemText = item.weight ? `${item.name} (${item.weight}g)` : item.name;
        doc.text(itemText, 18, itemY + 2, { width: 200, height: 8 });
        doc.text(String(item.qty), 245, itemY + 2, { width: 30, align: 'right' });
        
        // keyline
        doc.moveTo(15, itemY + 9).lineTo(282, itemY + 9).strokeColor('#E2D1BE').lineWidth(0.3).stroke();
        itemY += 10;
      });

      if (order.items.length > 5) {
        doc.font('Helvetica-Oblique').fontSize(5.5).fillColor('#777777').text(`+ ${order.items.length - 5} more items... inspect delivery bill`, 18, itemY + 1);
      }

      // Small security / delivery note
      doc.font('Helvetica').fontSize(6).fillColor('#777777').text('Traditional Gaushala Logistics. Handle with Devotion. Built by Nexkite.', 15, 400, { align: 'center', width: 267 });

      doc.end();

      stream.on('finish', () => resolve(destPath));
      stream.on('error', (err) => reject(err));
    } catch (e) {
      reject(e);
    }
  });
}
