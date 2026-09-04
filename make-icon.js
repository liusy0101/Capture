// 使用纯 zlib 生成一个真正有效的 256x256 PNG 图标（蓝色背景 + WS 文字感）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 实现（PNG 要求每个 chunk 都带 CRC）
const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = crc32Table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
};

// 生成 PNG chunk
const makeChunk = (type, data) => {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
};

const WIDTH = 256;
const HEIGHT = 256;

// 构建原始像素数据：每行前加一个 filter 字节(0)，然后是 RGB 三字节/像素
// 颜色：深色背景 #1e1e1e，中间圆 #4fc3f7
const buildImageData = () => {
  const rows = [];
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const r = 90;
  for (let y = 0; y < HEIGHT; y++) {
    const row = Buffer.alloc(1 + WIDTH * 3); // 1 字节 filter + 像素
    row[0] = 0; // None filter
    for (let x = 0; x < WIDTH; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let rC, gC, bC;
      if (dist < r) {
        // 内圆青蓝色 #4fc3f7
        rC = 0x4f; gC = 0xc3; bC = 0xf7;
      } else {
        // 背景深色 #1e1e1e
        rC = 0x1e; gC = 0x1e; bC = 0x1e;
      }
      const offset = 1 + x * 3;
      row[offset] = rC;
      row[offset + 1] = gC;
      row[offset + 2] = bC;
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
};

const generatePng = () => {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // IDAT (压缩像素数据)
  const raw = buildImageData();
  const compressed = zlib.deflateSync(raw);

  // IEND
  const png = Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);

  const iconDir = path.join(__dirname, 'assets');
  if (!fs.existsSync(iconDir)) fs.mkdirSync(iconDir, { recursive: true });
  const pngPath = path.join(iconDir, 'icon.png');
  fs.writeFileSync(pngPath, png);
  console.log('✅ 生成有效 PNG 图标:', pngPath, `(${png.length} bytes)`);

  // 生成 SVG（用于参考/编辑）
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
  <rect width="256" height="256" fill="#1e1e1e"/>
  <circle cx="128" cy="128" r="90" fill="#4fc3f7"/>
</svg>`;
  fs.writeFileSync(path.join(iconDir, 'icon.svg'), svg);
  console.log('✅ 生成 SVG 图标: assets/icon.svg');
};

generatePng();