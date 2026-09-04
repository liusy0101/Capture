# Capture

HTTP/HTTPS/WebSocket 抓包与请求重写工具（原 ws-proxy-sniffer）。

## 功能特性

### 核心功能
- **HTTP/HTTPS 代理** - MITM 解密与转发
- **WebSocket 支持** - 实时消息监控
- **本地请求捕获** - 支持 `127.0.0.1` / localhost（系统代理写入 `<-loopback>`）
- **请求重写** - 规则匹配与改写

## 安装和运行

```bash
npm install
npm run build
npm run dist:win   # 产出 Capture-Setup-x.y.z.exe / portable
npm start
```

产物在 `release/`，无空格文件名，例如 `Capture-Setup-1.0.3.exe`。


### 📊 数据包管理
- 实时请求监控和展示
- 详细的请求/响应头和体查看
- WebSocket消息流查看
- 多种过滤和搜索选项
- 数据包导出功能

### ✨ 重写规则
- **匹配条件**: URL、方法、请求头、请求体、响应头、响应体
- **匹配方式**: 包含、等于、正则表达式、开始于、结束于
- **操作类型**: 替换、添加、删除、修改、重定向
- **应用范围**: 请求、响应或双向
- **规则优先级**: 支持复杂规则链

### 🖥️ 用户界面
- 现代化深色主题设计
- 响应式布局
- 实时数据更新
- 详细的配置选项
- 规则导入/导出

## 安装和运行

### 环境要求
- Node.js 18+ 
- npm 或 yarn
- Windows 10+ (主要开发环境)

### 安装依赖
```bash
npm install
```

### 开发模式
```bash
npm run dev
```

### 构建项目
```bash
npm run build
```

### 打包应用
```bash
npm run dist
```

生成的安装包位于 `release` 目录。

### 直接运行
```bash
npm start
```

## 使用指南

### 基本代理设置
1. 点击「启动代理」——默认会**自动设置 Windows 系统代理**（含 `<-loopback>`，用于抓 127.0.0.1）
2. 点击「安装证书」，将 MITM CA 写入当前用户受信任根证书，然后**完全退出并重启浏览器**
3. 开始浏览；停止代理时会自动恢复原系统代理

### 抓取 localhost / 127.0.0.1 / 本地 WebSocket
Chrome/Edge 默认绕过 loopback。本工具启动时会写入 `ProxyOverride=<-loopback>`。若仍抓不到：
1. 点击「本地抓包命令」复制启动参数
2. 用类似命令启动浏览器：`--proxy-server="127.0.0.1:8080" --proxy-bypass-list="<-loopback>"`
3. 或改用本机局域网 IP（如 `ws://192.168.x.x:端口`）代替 `127.0.0.1`

### WebSocket 监控
1. 确保启用「记录WebSocket消息」
2. HTTPS 站点的 WSS 必须先安装证书
3. 选择 WebSocket 连接查看消息流

### 请求重写
1. 切换到"重写规则"标签页
2. 点击"添加规则"创建新的重写规则
3. 配置匹配条件和操作
4. 启用规则后立即生效

#### 常用重写规则示例

**替换API域名**
```json
{
  "name": "替换生产API为本地",
  "matchType": "url",
  "matchPattern": "api.example.com",
  "matchOperator": "contains",
  "actionType": "replace",
  "actionValue": "localhost:3000",
  "applyTo": "request"
}
```

**添加CORS头**
```json
{
  "name": "添加CORS支持",
  "matchType": "header",
  "matchPattern": "*",
  "matchOperator": "contains", 
  "actionType": "add",
  "actionTarget": "Access-Control-Allow-Origin",
  "actionValue": "*",
  "applyTo": "response"
}
```

**重定向请求**
```json
{
  "name": "重定向到新域名",
  "matchType": "url", 
  "matchPattern": "old-domain.com",
  "matchOperator": "contains",
  "actionType": "redirect",
  "actionValue": "https://new-domain.com$1",
  "applyTo": "request"
}
```

### 配置选项
- **代理端口**: 默认8080，可自定义
- **HTTPS代理**: 启用/禁用HTTPS代理
- **本地请求捕获**: 捕获127.0.0.1和localhost请求
- **WebSocket记录**: 启用/禁用WebSocket消息记录
- **HTTP请求记录**: 启用/禁用HTTP请求记录
- **自动滚动**: 新数据包自动滚动到顶部

## 项目结构

```
ws-proxy-sniffer/
├── src/
│   ├── main/              # Electron主进程
│   │   ├── index.ts       # 主进程入口
│   │   ├── proxy-server.ts # 代理服务器
│   │   ├── packet-manager.ts # 数据包管理
│   │   ├── rewrite-manager.ts # 重写规则管理
│   │   └── preload.ts     # 预加载脚本
│   ├── renderer/          # 渲染进程
│   │   ├── index.html     # 主界面
│   │   └── renderer.js    # 前端逻辑
│   └── types.ts           # TypeScript类型定义
├── assets/                # 资源文件
├── dist/                  # 编译输出
├── release/               # 打包输出
├── package.json           # 项目配置
├── tsconfig.json          # TypeScript配置
├── build.js               # 构建脚本
└── README.md              # 项目说明
```

## 故障排除

### 打包错误
如果遇到 "Application entry file does not exist" 错误：
1. 确保 `npm run build` 成功执行
2. 检查 `dist/main/index.js` 是否存在
3. 尝试运行 `npm run build && npm run dist`

### 代理不工作
1. 检查防火墙设置
2. 确认端口没有被其他应用占用
3. 查看错误日志获取详细信息

### WebSocket连接问题
1. 确保启用"记录WebSocket消息"
2. 检查本地请求捕获设置
3. 验证WebSocket服务器地址格式

## 性能优化

- **数据包数量限制**: 默认最多保存1000个数据包
- **规则优先级**: 高优先级规则先执行
- **内存管理**: 自动清理旧数据包

## 安全说明

- 仅用于开发和测试环境
- 不要在生产环境中使用
- 妥善保管重写规则配置
- 注意敏感数据的处理

## 技术栈

- **Electron**: 桌面应用框架
- **TypeScript**: 类型安全的JavaScript
- **Node.js**: 后端运行时
- **WebSocket**: 实时通信
- **EventEmitter3**: 事件处理

## 开发指南

### 添加新功能
1. 在 `src/types.ts` 中定义相关类型
2. 在主进程或渲染进程中实现功能
3. 更新UI界面
4. 添加相应的IPC通信

### 调试
- 开发模式下会自动打开DevTools
- 使用 `console.log` 输出调试信息
- 检查Electron日志获取系统信息

## 许可证

MIT License

## 贡献

欢迎提交问题和拉取请求！

## 更新日志

### v1.0.0
- 初始版本发布
- HTTP/HTTPS代理支持
- WebSocket监控
- 请求重写功能
- 现代化UI设计