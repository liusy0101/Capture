// 生成有效的PNG图标文件（512x512）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    table[n] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
}

function createPng(width, height, getPixel) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // IDAT - raw image data with filter byte per row
  const rowSize = width * 4;
  const raw = Buffer.alloc((rowSize + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowSize + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y);
      const offset = y * (rowSize + 1) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const compressed = zlib.deflateSync(raw);

  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrChunk = createChunk('IHDR', ihdr);
  const idatChunk = createChunk('IDAT', compressed);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function generateIcon(size) {
  return createPng(size, size, (x, y) => {
    const cx = size / 2;
    const cy = size / 2;
    const r = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    const maxR = size / 2;
    
    // 深色背景
    if (r > maxR) {
      return [30, 30, 30, 255]; // #1e1e1e
    }
    
    // 圆形蓝色背景
    if (r > maxR - size * 0.05) {
      return [79, 195, 247, 255]; // #4fc3f7 边框
    }
    
    // 内部深色方块
    const innerSize = size * 0.35;
    const innerStart = (size - innerSize) / 2;
    if (x > innerStart && x < innerStart + innerSize && y > innerStart && y < innerStart + innerSize) {
      return [45, 45, 45, 255]; // #2d2d2d
    }
    
    // 默认深色背景
    return [30, 30, 30, 255];
  });
}

const iconDir = path.join(__dirname, 'assets');
if (!fs.existsSync(iconDir)) {
  fs.mkdirSync(iconDir, { recursive: true });
}

console.log('🎨 生成应用图标...');

// 生成512x512的PNG图标（Linux推荐尺寸）
const icon512 = generateIcon(512);
fs.writeFileSync(path.join(iconDir, 'icon.png'), icon512);
console.log('✅ 生成PNG图标: assets/icon.png (512x512)');

// 也生成256x256版本
const icon256 = generateIcon(256);
fs.writeFileSync(path.join(iconDir, 'icon-256.png'), icon256);
console.log('✅ 生成PNG图标: assets/icon-256.png (256x256)');

console.log('\n🎉 图标生成完成！');
console.log('\n现在可以运行打包命令:');
console.log('  npm run dist:linux');
console.log('  npm run dist:win');