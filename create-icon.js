const fs = require('fs');
const path = require('path');

// 创建一个简单的PNG图标占位符
const createSimpleIcon = () => {
  const iconDir = path.join(__dirname, 'assets');
  if (!fs.existsSync(iconDir)) {
    fs.mkdirSync(iconDir, { recursive: true });
  }

  // 创建一个简单的SVG图标
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

  // 注意：实际打包时可能需要使用工具将SVG转换为PNG/ICO格式
  // 这里只是为了防止打包时缺少文件而报错
  console.log('📝 提示: 正式打包时请使用专业工具将SVG转换为PNG/ICO格式');
  console.log('   可以使用在线工具: https://www.aconvert.com/cn/image/svg-to-png/');
};

createSimpleIcon();