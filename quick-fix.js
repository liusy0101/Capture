const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔧 快速修复构建问题...\n');

// 停止当前的构建进程
console.log('1. 清理构建文件...');
try {
  if (fs.existsSync('dist')) {
    const files = fs.readdirSync('dist');
    files.forEach(file => {
      const filePath = path.join('dist', file);
      if (fs.statSync(filePath).isDirectory()) {
        // 保留 dist/main 和 dist/renderer
        if (file !== 'main' && file !== 'renderer') {
          fs.rmSync(filePath, { recursive: true, force: true });
        }
      }
    });
    console.log('✅ 清理完成');
  }
} catch (error) {
  console.log('⚠️  清理过程中出现错误，但继续执行');
}

// 重新构建
console.log('\n2. 重新编译TypeScript...');
try {
  execSync('npx tsc', { stdio: 'inherit' });
  console.log('✅ TypeScript编译完成');
} catch (error) {
  console.error('❌ TypeScript编译失败');
  process.exit(1);
}

// 创建必要的目录
console.log('\n3. 创建目录结构...');
const dirs = ['dist/renderer', 'release', 'assets'];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✅ 创建目录: ${dir}`);
  }
});

// 复制渲染进程文件
console.log('\n4. 复制渲染进程文件...');
try {
  const rendererDir = 'src/renderer';
  const outputDir = 'dist/renderer';
  
  if (fs.existsSync(rendererDir)) {
    const files = fs.readdirSync(rendererDir);
    files.forEach(file => {
      const srcPath = path.join(rendererDir, file);
      const destPath = path.join(outputDir, file);
      
      if (fs.statSync(srcPath).isFile()) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`✅ 复制: ${file}`);
      }
    });
  }
} catch (error) {
  console.error('❌ 复制渲染进程文件失败:', error.message);
  process.exit(1);
}

// 创建图标
console.log('\n5. 创建图标...');
try {
  execSync('node create-icon.js', { stdio: 'inherit' });
} catch (error) {
  console.log('⚠️  图标创建失败，但不影响构建');
}

console.log('\n🎉 构建修复完成！');
console.log('\n现在可以运行以下命令:');
console.log('  npm start       # 启动开发版本');
console.log('  npm run dev     # 开发模式');
console.log('  npm run dist    # 打包应用');

console.log('\n📋 如需打包应用，请确保:');
console.log('  1. 构建成功 (dist/main/index.js 存在)');
console.log('  2. 渲染进程文件存在 (dist/renderer/index.html 存在)');
console.log('  3. 图标文件存在 (assets/icon.svg 存在)');