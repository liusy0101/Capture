"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemProxyManager = exports.SystemProxyManager = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const electron_1 = require("electron");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
/**
 * Windows 系统代理管理
 *
 * 根因说明：
 * 1. 仅监听端口而不改系统代理时，浏览器流量根本不会进 MITM
 * 2. Chrome/Edge 默认绕过 127.0.0.1/localhost；ProxyOverride 写入 <-loopback>
 *    可取消 Chromium 的隐式 loopback bypass，从而抓到本地 WS/HTTP
 */
class SystemProxyManager {
    constructor() {
        this.saved = null;
        this.enabled = false;
    }
    isEnabled() {
        return this.enabled;
    }
    async enable(port, captureLocalhost) {
        if (process.platform !== 'win32') {
            console.log('[system-proxy] 非 Windows，跳过系统代理设置');
            return;
        }
        if (!this.saved) {
            this.saved = await this.readCurrent();
        }
        const proxyServer = `127.0.0.1:${port}`;
        // <-loopback>：取消 Chromium 对 localhost/127.0.0.1 的默认绕过
        // 未开启本地捕获时保留 <local>，避免干扰本机直连
        const proxyOverride = captureLocalhost ? '<-loopback>' : '<local>';
        await this.setReg('ProxyEnable', 'REG_DWORD', '1');
        await this.setReg('ProxyServer', 'REG_SZ', proxyServer);
        await this.setReg('ProxyOverride', 'REG_SZ', proxyOverride);
        // 清掉 PAC，避免旧 AutoConfigURL 覆盖手动代理
        await this.deleteReg('AutoConfigURL');
        await this.writePacFile(port);
        await this.notifyProxyChanged();
        await this.syncWinHttp();
        this.enabled = true;
        console.log(`[system-proxy] 已启用: ${proxyServer}, override=${proxyOverride}`);
    }
    async disable() {
        if (process.platform !== 'win32' || !this.saved) {
            this.enabled = false;
            return;
        }
        try {
            if (this.saved.proxyEnable !== undefined) {
                await this.setReg('ProxyEnable', 'REG_DWORD', this.saved.proxyEnable || '0');
            }
            else {
                await this.setReg('ProxyEnable', 'REG_DWORD', '0');
            }
            if (this.saved.proxyServer) {
                await this.setReg('ProxyServer', 'REG_SZ', this.saved.proxyServer);
            }
            else {
                await this.deleteReg('ProxyServer');
            }
            if (this.saved.proxyOverride !== undefined) {
                await this.setReg('ProxyOverride', 'REG_SZ', this.saved.proxyOverride);
            }
            else {
                await this.deleteReg('ProxyOverride');
            }
            if (this.saved.autoConfigURL) {
                await this.setReg('AutoConfigURL', 'REG_SZ', this.saved.autoConfigURL);
            }
            else {
                await this.deleteReg('AutoConfigURL');
            }
            await this.notifyProxyChanged();
            await this.syncWinHttp();
            console.log('[system-proxy] 已恢复原系统代理设置');
        }
        catch (err) {
            console.error('[system-proxy] 恢复失败:', err);
            // 兜底：直接关闭代理，避免用户断网
            try {
                await this.setReg('ProxyEnable', 'REG_DWORD', '0');
                await this.notifyProxyChanged();
            }
            catch {
                /* ignore */
            }
        }
        finally {
            this.saved = null;
            this.enabled = false;
        }
    }
    getChromeLaunchHint(port) {
        return `"chrome.exe" --proxy-server="127.0.0.1:${port}" --proxy-bypass-list="<-loopback>"`;
    }
    async readCurrent() {
        const read = async (name) => {
            try {
                const { stdout } = await execFileAsync('reg', ['query', REG_PATH, '/v', name]);
                const match = stdout.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`));
                return match ? match[1].trim() : undefined;
            }
            catch {
                return undefined;
            }
        };
        return {
            proxyEnable: await read('ProxyEnable'),
            proxyServer: await read('ProxyServer'),
            proxyOverride: await read('ProxyOverride'),
            autoConfigURL: await read('AutoConfigURL')
        };
    }
    async setReg(name, type, value) {
        await execFileAsync('reg', ['add', REG_PATH, '/v', name, '/t', type, '/d', value, '/f']);
    }
    async deleteReg(name) {
        try {
            await execFileAsync('reg', ['delete', REG_PATH, '/v', name, '/f']);
        }
        catch {
            /* 键不存在时忽略 */
        }
    }
    async writePacFile(port) {
        const pacDir = path.join(electron_1.app.getPath('userData'), 'proxy');
        fs.mkdirSync(pacDir, { recursive: true });
        const pacPath = path.join(pacDir, 'proxy.pac');
        const pac = `function FindProxyForURL(url, host) {
  return "PROXY 127.0.0.1:${port}";
}
`;
        fs.writeFileSync(pacPath, pac, 'utf8');
        return pacPath;
    }
    /** 通知 WinINET 代理设置已变更，否则浏览器可能继续用旧配置 */
    async notifyProxyChanged() {
        const ps = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ProxyNotify {
  [DllImport("wininet.dll", SetLastError=true)]
  public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
}
'@
[void][ProxyNotify]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[void][ProxyNotify]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
`;
        try {
            await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], {
                windowsHide: true
            });
        }
        catch (err) {
            console.warn('[system-proxy] InternetSetOption 通知失败:', err);
        }
    }
    async syncWinHttp() {
        try {
            await execFileAsync('netsh', ['winhttp', 'import', 'proxy', 'source=ie'], {
                windowsHide: true
            });
        }
        catch (err) {
            console.warn('[system-proxy] netsh winhttp 同步失败:', err);
        }
    }
}
exports.SystemProxyManager = SystemProxyManager;
exports.systemProxyManager = new SystemProxyManager();
