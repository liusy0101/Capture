import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ProxyServer } from './proxy-server';
import { PacketManager } from './packet-manager';
import { RewriteManager } from './rewrite-manager';
import { systemProxyManager } from './system-proxy';
import { ensureCaCertificate } from './cert-utils';
import { initFileLogger, getLogDir, getLogFilePath, logError, logInfo } from './logger';
import { ProxyConfig, RewriteRule } from '../types';

const execFileAsync = promisify(execFile);

let mainWindow: BrowserWindow | null = null;
let proxyServer: ProxyServer | null = null;
let packetManager: PacketManager | null = null;
let rewriteManager: RewriteManager | null = null;
let lastConfig: ProxyConfig | null = null;

// 防止证书等异常弹出 Electron 崩溃对话框
process.on('uncaughtException', (err) => {
  logError('[uncaughtException]', err);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('proxy:error', err.message);
  }
});

process.on('unhandledRejection', (reason) => {
  logError('[unhandledRejection]', reason);
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0f1419',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
    title: 'Capture'
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    void stopProxy();
  });
}

async function startProxy(config: ProxyConfig): Promise<void> {
  if (proxyServer) {
    await stopProxy();
  }

  lastConfig = config;
  packetManager = new PacketManager();
  const userDataPath = app.getPath('userData');
  rewriteManager = new RewriteManager(userDataPath);
  proxyServer = new ProxyServer(config, packetManager, rewriteManager);

  proxyServer.on('request', (packet) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('packet:new', packet);
    }
  });

  proxyServer.on('websocket', (packet) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('packet:websocket', packet);
    }
  });

  proxyServer.on('error', (error) => {
    console.error('Proxy error:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('proxy:error', error.message);
    }
  });

  await proxyServer.start();

  // 代理就绪后再改系统代理，避免浏览器先连上却连不通
  if (config.autoSystemProxy !== false) {
    try {
      await systemProxyManager.enable(config.port, {
        captureLocalhost: config.enableLocalhost !== false,
        bypassList: config.bypassList || ''
      });
    } catch (err) {
      console.error('设置系统代理失败:', err);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(
          'proxy:error',
          `系统代理设置失败（代理端口已监听）: ${(err as Error).message}`
        );
      }
    }
  }
}

async function stopProxy(): Promise<void> {
  // 先关代理端口，立刻停止接收；再恢复系统代理（可能较慢）
  if (proxyServer) {
    try {
      proxyServer.stop();
    } catch (err) {
      console.error('停止代理服务失败:', err);
    }
    proxyServer = null;
  }

  try {
    await Promise.race([
      systemProxyManager.disable(),
      new Promise<void>((resolve) => setTimeout(resolve, 8000))
    ]);
  } catch (err) {
    console.error('恢复系统代理失败:', err);
  }

  // 停止时保留已抓数据；仅「清除」才清空列表
}

app.whenReady().then(() => {
  const { logDir, logFile } = initFileLogger();
  logInfo(`UI ready, logDir=${logDir}, logFile=${logFile}`);

  createWindow();

  if (!rewriteManager) {
    const userDataPath = app.getPath('userData');
    rewriteManager = new RewriteManager(userDataPath);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  void systemProxyManager.disable();
});

// IPC handlers
ipcMain.handle('proxy:start', async (_event, config: ProxyConfig) => {
  try {
    logInfo('proxy:start', JSON.stringify({
      port: config.port,
      enableHttps: config.enableHttps,
      enableLocalhost: config.enableLocalhost,
      autoSystemProxy: config.autoSystemProxy,
      bypassList: config.bypassList || ''
    }));
    await startProxy(config);
    return {
      success: true,
      systemProxy: systemProxyManager.isEnabled(),
      chromeHint: systemProxyManager.getChromeLaunchHint(config.port, {
        captureLocalhost: config.enableLocalhost !== false,
        bypassList: config.bypassList || ''
      }),
      caCertPath: proxyServer?.getCaCertPath()
    };
  } catch (error) {
    logError('proxy:start failed', error);
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('proxy:stop', async () => {
  try {
    logInfo('proxy:stop');
    await stopProxy();
    return { success: true };
  } catch (error) {
    logError('proxy:stop failed', error);
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('proxy:status', async () => {
  return {
    running: proxyServer !== null,
    port: proxyServer?.getPort() || 0,
    systemProxy: systemProxyManager.isEnabled()
  };
});

ipcMain.handle('packets:get', async () => {
  if (!packetManager) return [];
  return packetManager.getPackets();
});

ipcMain.handle('packets:clear', async () => {
  if (packetManager) {
    packetManager.clear();
  }
  return { success: true };
});

ipcMain.handle('packets:filter', async (_event, filter: any) => {
  if (!packetManager) return [];
  return packetManager.filterPackets(filter);
});

ipcMain.handle('proxy:set-config', async (_event, config: Partial<ProxyConfig>) => {
  if (proxyServer) {
    proxyServer.updateConfig(config);
  }
  if (lastConfig) {
    lastConfig = { ...lastConfig, ...config };
  }
  // 运行中保存 bypass / 本地捕获开关时，即时刷新系统 ProxyOverride
  if (systemProxyManager.isEnabled() && lastConfig && lastConfig.autoSystemProxy !== false) {
    try {
      await systemProxyManager.enable(lastConfig.port, {
        captureLocalhost: lastConfig.enableLocalhost !== false,
        bypassList: lastConfig.bypassList || ''
      });
    } catch (err) {
      console.error('更新系统代理 bypass 失败:', err);
      return { success: false, error: (err as Error).message };
    }
  }
  return { success: true };
});

ipcMain.handle('proxy:get-ca-dir', async () => {
  const caDir = path.join(app.getPath('userData'), 'mitm-certs');
  return {
    success: true,
    caDir,
    caCertPath: path.join(caDir, 'certs', 'ca.pem'),
    hint: '请将此 CA 证书导入到浏览器/系统的受信任根证书颁发机构，以解密 HTTPS/WSS 流量'
  };
});

ipcMain.handle('proxy:open-ca-dir', async () => {
  try {
    const caDir = path.join(app.getPath('userData'), 'mitm-certs');
    fs.mkdirSync(path.join(caDir, 'certs'), { recursive: true });
    await shell.openPath(caDir);
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('app:open-logs', async () => {
  try {
    // 确保 logger 已初始化（极端情况下）
    if (!getLogFilePath()) {
      initFileLogger();
    }
    const dir = getLogDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return { success: true, logDir: dir, logFile: getLogFilePath() || '' };
  } catch (error) {
    logError('open-logs failed', error);
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('app:get-log-info', async () => {
  return {
    success: true,
    logDir: getLogDir(),
    logFile: getLogFilePath() || ''
  };
});

/** 将 MITM CA 安装到当前用户「受信任的根证书颁发机构」 */
ipcMain.handle('proxy:install-ca', async () => {
  const caDir = path.join(app.getPath('userData'), 'mitm-certs');
  let caCertPath = path.join(caDir, 'certs', 'ca.pem');
  try {
    caCertPath = await ensureCaCertificate(caDir);

    if (process.platform === 'win32') {
      try {
        await execFileAsync('certutil', ['-addstore', '-user', 'Root', caCertPath], {
          windowsHide: true
        });
      } catch (certErr) {
        // 打开目录方便手动双击导入；同时返回明确错误
        await shell.openPath(path.dirname(caCertPath));
        return {
          success: false,
          error: `自动安装失败: ${(certErr as Error).message}。已打开证书目录，请双击 ca.pem 手动导入「受信任的根证书颁发机构」。`,
          caCertPath
        };
      }
      return {
        success: true,
        message: 'CA 证书已安装到当前用户受信任根证书存储。请完全退出并重启浏览器后再抓 HTTPS/WSS。',
        caCertPath
      };
    }

    // 非 Windows：打开目录让用户手动导入
    await shell.openPath(path.dirname(caCertPath));
    return {
      success: true,
      message: '已打开证书目录，请手动将 ca.pem 导入系统/浏览器受信任根证书',
      caCertPath
    };
  } catch (error) {
    try {
      await shell.openPath(path.join(caDir, 'certs'));
    } catch {
      /* ignore */
    }
    return {
      success: false,
      error: (error as Error).message,
      caCertPath
    };
  }
});

ipcMain.handle('proxy:get-chrome-hint', async () => {
  const port = lastConfig?.port || proxyServer?.getPort() || 8080;
  return {
    success: true,
    hint: systemProxyManager.getChromeLaunchHint(port, {
      captureLocalhost: lastConfig?.enableLocalhost !== false,
      bypassList: lastConfig?.bypassList || ''
    }),
    tip: '若系统代理已开仍抓不到 127.0.0.1，请用此命令启动 Chrome/Edge'
  };
});

// Rewrite rules management
ipcMain.handle('rewrite:add-rule', async (_event, rule: Omit<RewriteRule, 'id'>) => {
  if (!rewriteManager) return { success: false, error: 'Rewrite manager not initialized' };
  try {
    const newRule = rewriteManager.addRule(rule);
    return { success: true, rule: newRule };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('rewrite:update-rule', async (_event, id: string, updates: Partial<RewriteRule>) => {
  if (!rewriteManager) return { success: false, error: 'Rewrite manager not initialized' };
  try {
    const updatedRule = rewriteManager.updateRule(id, updates);
    return { success: true, rule: updatedRule };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('rewrite:delete-rule', async (_event, id: string) => {
  if (!rewriteManager) return { success: false, error: 'Rewrite manager not initialized' };
  try {
    const deleted = rewriteManager.deleteRule(id);
    return { success: true, deleted };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('rewrite:get-rules', async () => {
  if (!rewriteManager) return { success: false, error: 'Rewrite manager not initialized', rules: [] };
  try {
    const rules = rewriteManager.getAllRules();
    return { success: true, rules };
  } catch (error) {
    return { success: false, error: (error as Error).message, rules: [] };
  }
});

ipcMain.handle('rewrite:toggle-rule', async (_event, id: string, enabled: boolean) => {
  if (!rewriteManager) return { success: false, error: 'Rewrite manager not initialized' };
  try {
    const toggled = rewriteManager.toggleRule(id, enabled);
    return { success: true, toggled };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('rewrite:export-rules', async () => {
  if (!rewriteManager) return { success: false, error: 'Rewrite manager not initialized', data: '' };
  try {
    const data = rewriteManager.exportRules();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: (error as Error).message, data: '' };
  }
});

ipcMain.handle('rewrite:import-rules', async (_event, rulesJson: string) => {
  if (!rewriteManager) return { success: false, error: 'Rewrite manager not initialized', imported: 0 };
  try {
    const imported = rewriteManager.importRules(rulesJson);
    return { success: true, imported };
  } catch (error) {
    return { success: false, error: (error as Error).message, imported: 0 };
  }
});
