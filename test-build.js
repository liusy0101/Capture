const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔧 开始修复构建...\n');

// 安装依赖
console.log('📦 安装依赖...');
try {
  execSync('npm install --silent', { stdio: 'inherit' });
  console.log('✅ 依赖安装完成\n');
} catch (error) {
  console.error('❌ 依赖安装失败:', error.message);
  process.exit(1);
}

// 构建项目
console.log('🏗️  构建项目...');
try {
  execSync('npm run build', { stdio: 'inherit' });
  console.log('✅ 项目构建完成\n');
} catch (error) {
  console.error('❌ 项目构建失败:', error.message);
  process.exit(1);
}

// 检查构建输出
console.log('🔍 检查构建输出...');
const distDir = path.join(__dirname, 'dist');
const mainFile = path.join(distDir, 'main', 'index.js');
const rendererFile = path.join(distDir, 'renderer', 'index.html');

if (fs.existsSync(mainFile)) {
  console.log('✅ 主进程编译文件存在:', mainFile);
} else {
  console.error('❌ 主进程编译文件不存在:', mainFile);
  process.exit(1);
}

if (fs.existsSync(rendererFile)) {
  console.log('✅ 渲染进程文件存在:', rendererFile);
} else {
  console.error('❌ 渲染进程文件不存在:', rendererFile);
  process.exit(1);
}

console.log('\n🎉 构建修复成功！现在可以运行以下命令：');
console.log('  npm start       # 启动开发版本');
console.log('  npm run dist    # 打包应用');
console.log('  npm run dev     # 开发模式');

console.log('\n📋 如果要打包应用，请确保已安装必要的工具:');
console.log('  - Windows: 已包含在 electron-builder 中');
console.log('  - Linux: 可能需要安装 fakeroot 和 dpkg');