import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

const execFileAsync = promisify(execFile);

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

interface SavedProxySettings {
  proxyEnable?: string;
  proxyServer?: string;
  proxyOverride?: string;
  autoConfigURL?: string;
}

export interface SystemProxyOptions {
  captureLocalhost?: boolean;
  /** 分号/换行/逗号分隔的 bypass 规则，如 *.corp.com;10.*;localhost */
  bypassList?: string;
}

/** 将用户输入拆成 bypass 条目 */
export function parseBypassList(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[;\n,\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 组装 Windows ProxyOverride / Chrome --proxy-bypass-list */
export function buildProxyOverride(options: SystemProxyOptions): string {
  const parts: string[] = [];
  if (options.captureLocalhost !== false) {
    // 取消 Chromium 默认 loopback 绕过，从而能抓 127.0.0.1
    parts.push('<-loopback>');
  }
  for (const item of parseBypassList(options.bypassList)) {
    if (item === '<-loopback>' || item === '<local>') {
      if (!parts.includes(item)) parts.push(item);
      continue;
    }
    if (!parts.includes(item)) parts.push(item);
  }
  return parts.join(';');
}

/**
 * Windows 系统代理管理
 */
export class SystemProxyManager {
  private saved: SavedProxySettings | null = null;
  private enabled = false;
  private lastOptions: SystemProxyOptions = {};

  isEnabled(): boolean {
    return this.enabled;
  }

  async enable(port: number, options: SystemProxyOptions | boolean = {}): Promise<void> {
    if (process.platform !== 'win32') {
      console.log('[system-proxy] 非 Windows，跳过系统代理设置');
      return;
    }

    const opts: SystemProxyOptions =
      typeof options === 'boolean' ? { captureLocalhost: options } : options || {};
    this.lastOptions = opts;

    if (!this.saved) {
      this.saved = await this.readCurrent();
    }

    const proxyServer = `127.0.0.1:${port}`;
    const proxyOverride = buildProxyOverride(opts);

    await this.setReg('ProxyEnable', 'REG_DWORD', '1');
    await this.setReg('ProxyServer', 'REG_SZ', proxyServer);
    await this.setReg('ProxyOverride', 'REG_SZ', proxyOverride || ' ');
    await this.deleteReg('AutoConfigURL');

    await this.writePacFile(port, opts);
    await this.notifyProxyChanged();
    await this.syncWinHttp();

    this.enabled = true;
    console.log(`[system-proxy] 已启用: ${proxyServer}, override=${proxyOverride}`);
  }

  async disable(): Promise<void> {
    if (process.platform !== 'win32') {
      this.enabled = false;
      this.saved = null;
      return;
    }

    try {
      if (this.saved) {
        if (this.saved.proxyEnable !== undefined) {
          await this.setReg('ProxyEnable', 'REG_DWORD', this.saved.proxyEnable || '0');
        } else {
          await this.setReg('ProxyEnable', 'REG_DWORD', '0');
        }

        if (this.saved.proxyServer) {
          await this.setReg('ProxyServer', 'REG_SZ', this.saved.proxyServer);
        } else {
          await this.deleteReg('ProxyServer');
        }

        if (this.saved.proxyOverride !== undefined) {
          await this.setReg('ProxyOverride', 'REG_SZ', this.saved.proxyOverride);
        } else {
          await this.deleteReg('ProxyOverride');
        }

        if (this.saved.autoConfigURL) {
          await this.setReg('AutoConfigURL', 'REG_SZ', this.saved.autoConfigURL);
        } else {
          await this.deleteReg('AutoConfigURL');
        }
      } else {
        // 没有备份时也强制关闭，避免「停止了但系统代理仍指向本机」
        await this.setReg('ProxyEnable', 'REG_DWORD', '0');
      }

      await this.notifyProxyChanged();
      await this.syncWinHttp();
      console.log('[system-proxy] 已恢复原系统代理设置');
    } catch (err) {
      console.error('[system-proxy] 恢复失败:', err);
      try {
        await this.setReg('ProxyEnable', 'REG_DWORD', '0');
        await this.notifyProxyChanged();
      } catch {
        /* ignore */
      }
    } finally {
      this.saved = null;
      this.enabled = false;
    }
  }

  getChromeLaunchHint(port: number, options?: SystemProxyOptions): string {
    const opts = options || this.lastOptions || {};
    const bypass = buildProxyOverride({
      captureLocalhost: opts.captureLocalhost !== false,
      bypassList: opts.bypassList
    });
    const bypassArg = bypass || '<-loopback>';
    return `"chrome.exe" --proxy-server="127.0.0.1:${port}" --proxy-bypass-list="${bypassArg}"`;
  }

  private async readCurrent(): Promise<SavedProxySettings> {
    const read = async (name: string): Promise<string | undefined> => {
      try {
        const { stdout } = await execFileAsync('reg', ['query', REG_PATH, '/v', name]);
        const match = stdout.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`));
        return match ? match[1].trim() : undefined;
      } catch {
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

  private async setReg(name: string, type: 'REG_SZ' | 'REG_DWORD', value: string): Promise<void> {
    await execFileAsync('reg', ['add', REG_PATH, '/v', name, '/t', type, '/d', value, '/f']);
  }

  private async deleteReg(name: string): Promise<void> {
    try {
      await execFileAsync('reg', ['delete', REG_PATH, '/v', name, '/f']);
    } catch {
      /* 键不存在时忽略 */
    }
  }

  private async writePacFile(port: number, options: SystemProxyOptions): Promise<string> {
    const pacDir = path.join(app.getPath('userData'), 'proxy');
    fs.mkdirSync(pacDir, { recursive: true });
    const pacPath = path.join(pacDir, 'proxy.pac');
    const bypass = parseBypassList(options.bypassList)
      .map((b) => JSON.stringify(b))
      .join(', ');
    const pac = `function FindProxyForURL(url, host) {
  var bypass = [${bypass}];
  for (var i = 0; i < bypass.length; i++) {
    var rule = bypass[i];
    if (rule === "<local>" && isPlainHostName(host)) return "DIRECT";
    if (rule.charAt(0) === "*" && dnsDomainIs(host, rule.substring(1))) return "DIRECT";
    if (shExpMatch(host, rule) || shExpMatch(url, rule)) return "DIRECT";
  }
  return "PROXY 127.0.0.1:${port}";
}
`;
    fs.writeFileSync(pacPath, pac, 'utf8');
    return pacPath;
  }

  private async notifyProxyChanged(): Promise<void> {
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
    } catch (err) {
      console.warn('[system-proxy] InternetSetOption 通知失败:', err);
    }
  }

  private async syncWinHttp(): Promise<void> {
    try {
      await execFileAsync('netsh', ['winhttp', 'import', 'proxy', 'source=ie'], {
        windowsHide: true
      });
    } catch (err) {
      console.warn('[system-proxy] netsh winhttp 同步失败:', err);
    }
  }
}

export const systemProxyManager = new SystemProxyManager();
