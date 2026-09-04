const fs = require('fs');
const path = require('path');

// 确保必要的目录存在
const ensureDirectories = () => {
    const dirs = [
        'dist',
        'dist/main',
        'dist/renderer',
        'release',
        'assets'
    ];

    dirs.forEach(dir => {
        const fullPath = path.join(__dirname, dir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
            console.log(`创建目录: ${dir}`);
        }
    });
};

// 复制渲染进程文件（HTML/JS 不会经过 tsc 编译，需要手动复制到 dist）
const copyRendererFiles = () => {
    const rendererDir = path.join(__dirname, 'src/renderer');
    const outputDir = path.join(__dirname, 'dist/renderer');

    try {
        if (fs.existsSync(rendererDir)) {
            const files = fs.readdirSync(rendererDir);
            files.forEach(file => {
                const srcPath = path.join(rendererDir, file);
                const destPath = path.join(outputDir, file);

                try {
                    if (fs.statSync(srcPath).isFile()) {
                        fs.copyFileSync(srcPath, destPath);
                        console.log(`复制文件: ${file}`);
                    }
                } catch (err) {
                    console.warn(`跳过文件 ${file}:`, err.message);
                }
            });
        } else {
            console.log('渲染进程目录不存在，跳过复制');
        }
    } catch (error) {
        console.error('复制渲染进程文件失败:', error.message);
    }
};

// 复制 package.json 到 dist（electron-builder 需要）
const copyPackageJson = () => {
    const src = path.join(__dirname, 'package.json');
    const dest = path.join(__dirname, 'dist', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(src, 'utf8'));

    // 修正入口路径：dist/package.json 作为 app 根，main 应为 main/index.js
    pkg.main = 'main/index.js';
    fs.writeFileSync(dest, JSON.stringify(pkg, null, 2));
    console.log('复制并修正 package.json -> dist/package.json');
};

// 验证关键文件存在
const verifyBuild = () => {
    const required = [
        'dist/main/index.js',
        'dist/main/preload.js',
        'dist/renderer/index.html',
        'dist/renderer/renderer.js',
        'dist/package.json'
    ];
    let ok = true;
    required.forEach(f => {
        const full = path.join(__dirname, f);
        if (fs.existsSync(full)) {
            console.log(`✅ ${f}`);
        } else {
            console.error(`❌ 缺失: ${f}`);
            ok = false;
        }
    });
    if (!ok) {
        console.error('\n构建产物不完整，请检查 tsc 编译是否成功。');
        process.exit(1);
    }
};

// 构建应用（仅做文件复制和校验，tsc 由 package.json build 脚本单独执行）
const buildApp = () => {
    console.log('开始后处理构建（复制文件 + 校验）...');
    try {
        ensureDirectories();
        copyRendererFiles();
        copyPackageJson();
        ensureIcon();
        verifyBuild();
        console.log('✅ 构建后处理完成！');
    } catch (error) {
        console.error('构建失败:', error.message);
        process.exit(1);
    }
};

// 确保存在有效的 PNG 图标，若不存在则生成
const ensureIcon = () => {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    if (fs.existsSync(iconPath)) {
        // 简单校验 PNG 签名
        const head = fs.readFileSync(iconPath).slice(0, 8);
        const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        if (head.equals(sig)) {
            console.log('✅ 图标已存在且有效: assets/icon.png');
            return;
        }
        console.log('⚠️  现有图标无效，重新生成...');
    }
    try {
        require('child_process').execSync('node make-icon.js', { stdio: 'inherit' });
    } catch (e) {
        console.warn('⚠️  图标生成失败，打包时可能报图标错误');
    }
};

buildApp();