const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// PNG encoder in pure Node.js using built-in zlib
function createPNG(width, height, pixelDataRGBA) {
  // Signature
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // CRC32 table
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) c = 0xEDB88320 ^ (c >>> 1);
      else c = c >>> 1;
    }
    crcTable[n] = c;
  }

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);

    const toCrc = Buffer.concat([typeBuf, data]);
    const crcVal = crc32(toCrc);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal, 0);

    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(6, 9); // RGBA color type
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace

  const ihdrChunk = makeChunk('IHDR', ihdrData);

  // Scanlines with filter byte 0 (None)
  const rowStride = width * 4;
  const rawScanlines = Buffer.alloc(height * (rowStride + 1));
  for (let y = 0; y < height; y++) {
    rawScanlines[y * (rowStride + 1)] = 0; // Filter 0
    pixelDataRGBA.copy(
      rawScanlines,
      y * (rowStride + 1) + 1,
      y * rowStride,
      (y + 1) * rowStride
    );
  }

  // IDAT chunk
  const compressed = zlib.deflateSync(rawScanlines, { level: 9 });
  const idatChunk = makeChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Draw Runner GPS Logo onto RGBA buffer
function drawAppIcon(size, isMaskable = false) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.44;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (isMaskable) {
        // Maskable icon: fill entire background safely with deep navy
        buf[idx] = 0x0E;     // R
        buf[idx + 1] = 0x17; // G
        buf[idx + 2] = 0x2B; // B
        buf[idx + 3] = 0xFF; // A
      } else {
        // Standard icon: circular badge with subtle border
        if (dist <= r) {
          buf[idx] = 0x0E;
          buf[idx + 1] = 0x17;
          buf[idx + 2] = 0x2B;
          buf[idx + 3] = 0xFF;

          // Glowing border
          if (dist > r - (size * 0.03)) {
            buf[idx] = 0x05;
            buf[idx + 1] = 0xD5;
            buf[idx + 2] = 0xA4;
            buf[idx + 3] = 0xFF;
          }
        } else {
          // Transparent outside circle
          buf[idx] = 0;
          buf[idx + 1] = 0;
          buf[idx + 2] = 0;
          buf[idx + 3] = 0;
          continue;
        }
      }

      // Draw stylized Runner silhouette & GPS pulse
      // Center lightning / runner icon
      const nx = (x - cx) / (size * 0.35); // normalized -1 to 1
      const ny = (y - cy) / (size * 0.35);

      // Head: circle at (0.05, -0.55)
      const headDx = nx - 0.08;
      const headDy = ny - (-0.52);
      if (headDx * headDx + headDy * headDy <= 0.16 * 0.16) {
        buf[idx] = 0x05;
        buf[idx + 1] = 0xD5;
        buf[idx + 2] = 0xA4;
        buf[idx + 3] = 0xFF;
      }

      // Torso & Legs: running polygon silhouette
      // Torso angle
      if (ny >= -0.35 && ny <= 0.15) {
        const torsoX = -0.2 * ny + 0.02;
        if (Math.abs(nx - torsoX) <= 0.12) {
          buf[idx] = 0x05;
          buf[idx + 1] = 0xD5;
          buf[idx + 2] = 0xA4;
          buf[idx + 3] = 0xFF;
        }
      }

      // Front arm (reaching forward right)
      if (ny >= -0.35 && ny <= -0.1) {
        const armX = 0.5 * (ny + 0.35) + 0.1;
        if (Math.abs(nx - armX) <= 0.08) {
          buf[idx] = 0x38;
          buf[idx + 1] = 0xBD;
          buf[idx + 2] = 0xF8; // Sky blue accent
          buf[idx + 3] = 0xFF;
        }
      }

      // Back leg (kicking backwards left)
      if (ny >= -0.05 && ny <= 0.55) {
        const leg1X = -0.6 * (ny + 0.05) - 0.02;
        if (Math.abs(nx - leg1X) <= 0.09) {
          buf[idx] = 0x05;
          buf[idx + 1] = 0xD5;
          buf[idx + 2] = 0xA4;
          buf[idx + 3] = 0xFF;
        }
      }

      // Front leg (bent knee stepping forward)
      if (ny >= 0.05 && ny <= 0.65) {
        const leg2X = (ny < 0.35) ? (0.7 * (ny - 0.05) + 0.1) : (-0.4 * (ny - 0.35) + 0.31);
        if (Math.abs(nx - leg2X) <= 0.09) {
          buf[idx] = 0x05;
          buf[idx + 1] = 0xD5;
          buf[idx + 2] = 0xA4;
          buf[idx + 3] = 0xFF;
        }
      }

      // GPS pulse ring at bottom
      const ringDy = ny - 0.62;
      const ringDx = nx - 0.18;
      const ringDist = Math.sqrt(ringDx * ringDx * 2 + ringDy * ringDy * 5);
      if (ringDist >= 0.25 && ringDist <= 0.35) {
        buf[idx] = 0xF5;
        buf[idx + 1] = 0x9E;
        buf[idx + 2] = 0x0B; // Amber glow
        buf[idx + 3] = 0xCC;
      }
    }
  }

  return createPNG(size, size, buf);
}

const iconsDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Generate icons
fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), drawAppIcon(192, false));
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), drawAppIcon(512, false));
fs.writeFileSync(path.join(iconsDir, 'icon-maskable-192.png'), drawAppIcon(192, true));
fs.writeFileSync(path.join(iconsDir, 'icon-maskable-512.png'), drawAppIcon(512, true));
fs.writeFileSync(path.join(iconsDir, 'apple-touch-icon.png'), drawAppIcon(180, true));
fs.writeFileSync(path.join(iconsDir, 'favicon.png'), drawAppIcon(64, false));

console.log('✅ PWA Icons generated successfully!');
