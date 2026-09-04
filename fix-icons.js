const fs = require('fs');
const path = require('path');

const createPngIcon = () => {
  const iconDir = path.join(__dirname, 'assets');
  if (!fs.existsSync(iconDir)) {
    fs.mkdirSync(iconDir, { recursive: true });
  }

  // 创建一个最小的有效PNG文件（32x32像素，简单的蓝色方块）
  const pngData = Buffer.from([
    // PNG Signature
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    
    // IHDR Chunk
    0x00, 0x00, 0x00, 0x0D, // Length: 13 bytes
    0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x20, // Width: 32
    0x00, 0x00, 0x00, 0x20, // Height: 32
    0x08, // Bit depth: 8
    0x02, // Color type: 2 (RGB)
    0x00, 0x00, 0x00, // Compression, filter, interlace: none
    0x3C, 0x9C, 0x65, 0x5C, // CRC
    
    // IDAT Chunk (simple blue color data)
    0x00, 0x00, 0x00, 0x0F, // Length: 15 bytes
    0x49, 0x44, 0x41, 0x54, // IDAT
    0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, // Compressed data
    0x63, 0x1D, 0xD4, 0x4F, // CRC
    
    // IEND Chunk
    0x00, 0x00, 0x00, 0x00, // Length: 0 bytes
    0x49, 0x45, 0x4E, 0x44, // IEND
    0xAE, 0x42, 0x60, 0x82  // CRC
  ]);

  const pngPath = path.join(iconDir, 'icon.png');
  fs.writeFileSync(pngPath, pngData);
  console.log('✅ 创建PNG图标: assets/icon.png');
  
  return pngPath;
};

const createSvgIcon = () => {
  const iconDir = path.join(__dirname, 'assets');
  const svgIcon = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
  <rect width="256" height="256" fill="#1e1e1e"/>
  <circle cx="128" cy="128" r="80" fill="#4fc3f7" opacity="0.8"/>
  <rect x="88" y="88" width="80" height="80" rx="10" fill="#2d2d2d"/>
  <text x="128" y="140" font-family="Arial" font-size="40" font-weight="bold" fill="#4fc3f7" text-anchor="middle">WS</text>
  <path d="M 60 60 L 90 90" stroke="#4caf50" stroke-width="8" stroke-linecap="round"/>
  <path d="M 196 60 L 166 90" stroke="#4caf50" stroke-width="8" stroke-linecap="round"/>
  <circle cx="60" cy="60" r="12" fill="#4caf50"/>
  <circle cx="196" cy="60" r="12" fill="#4caf50"/>
</svg>`;

  fs.writeFileSync(path.join(iconDir, 'icon.svg'), svgIcon);
  console.log('✅ 创建SVG图标: assets/icon.svg');
};

const fixPackageJson = () => {
  const packageJsonPath = path.join(__dirname, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  
  // 添加Linux配置
  if (!packageJson.build.linux) {
    packageJson.build.linux = {
      "target": [
        "AppImage",
        "deb"
      ],
      "category": "Development",
      "icon": "assets/icon.png"
    };
  }
  
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
  console.log('✅ 更新package.json配置');
};

const main = () => {
  console.log('🔧 修复打包配置...\n');
  
  try {
    createPngIcon();
    createSvgIcon();
    fixPackageJson();
    
    console.log('\n🎉 配置修复完成！');
    console.log('\n现在可以运行:');
    console.log('  npm run dist:linux  # 打包Linux版本');
    console.log('  npm run dist:win    # 打包Windows版本');
    console.log('  npm run dist         # 打包所有平台');
    
  } catch (error) {
    console.error('❌ 修复失败:', error.message);
    process.exit(1);
  }
};

main();