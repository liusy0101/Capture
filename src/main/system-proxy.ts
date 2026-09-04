import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

const execFileAsync = promisify(execFile);

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

interface SavedWinProxySettings {
  proxyEnable?: string;
  proxyServer?: string;
  proxyOverride?: string;
  autoConfigURL?: string;
}

interface MacProxyState {
  enabled: boolean;
  server: string;
  port: string;
}

interface SavedMacServiceProxy {
  service: string;
  web: MacProxyState;
  secure: MacProxyState;
  socks: MacProxyState;
  bypass: string[];
  autoProxyUrl: string;
  autoProxyEnabled: boolean;
}

interface SavedProxySettings {
  win?: SavedWinProxySettings;
  macServices?: SavedMacServiceProxy[];
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

/** macOS networksetup bypass 域名列表 */
function buildMacBypassDomains(options: SystemProxyOptions): string[] {
  const parts: string[] = [];
  // 保留常见局域网旁路；若要抓 localhost 则不要写入 localhost/127.0.0.1/<local>
  if (options.captureLocalhost === false) {
    parts.push('localhost', '127.0.0.1', '*.local', '<local>');
  } else {
    parts.push('*.local');
  }
  for (const item of parseBypassList(options.bypassList)) {
    if (item === '<-loopback>') continue; // Chromium 专用，networksetup 不识别
    if (!parts.includes(item)) parts.push(item);
  }
  return parts.length ? parts : ['Empty'];
}

/**
 * 跨平台系统代理管理（Windows 注册表 / macOS networksetup）
 */
export class SystemProxyManager {
  private saved: SavedProxySettings | null = null;
  private enabled = false;
  private lastOptions: SystemProxyOptions = {};

  isEnabled(): boolean {
    return this.enabled;
  }

  async enable(port: number, options: SystemProxyOptions | boolean = {}): Promise<void> {
    const opts: SystemProxyOptions =
      typeof options === 'boolean' ? { captureLocalhost: options } : options || {};
    this.lastOptions = opts;

    if (process.platform === 'win32') {
      await this.enableWindows(port, opts);
      return;
    }
    if (process.platform === 'darwin') {
      await this.enableMac(port, opts);
      return;
    }

    console.log('[system-proxy] 当前平台不支持自动系统代理，请手动设置 127.0.0.1:' + port);
  }

  async disable(): Promise<void> {
    if (process.platform === 'win32') {
      await this.disableWindows();
      return;
    }
    if (process.platform === 'darwin') {
      await this.disableMac();
      return;
    }

    this.enabled = false;
    this.saved = null;
  }

  getChromeLaunchHint(port: number, options?: SystemProxyOptions): string {
    const opts = options || this.lastOptions || {};
    const bypass = buildProxyOverride({
      captureLocalhost: opts.captureLocalhost !== false,
      bypassList: opts.bypassList
    });
    const bypassArg = bypass || '<-loopback>';
    if (process.platform === 'darwin') {
      return `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --proxy-server="127.0.0.1:${port}" --proxy-bypass-list="${bypassArg}"`;
    }
    return `"chrome.exe" --proxy-server="127.0.0.1:${port}" --proxy-bypass-list="${bypassArg}"`;
  }

  // ─── Windows ───────────────────────────────────────────────

  private async enableWindows(port: number, opts: SystemProxyOptions): Promise<void> {
    if (!this.saved) {
      this.saved = { win: await this.readWinCurrent() };
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
    console.log(`[system-proxy] 已启用(Windows): ${proxyServer}, override=${proxyOverride}`);
  }

  private async disableWindows(): Promise<void> {
    try {
      const win = this.saved?.win;
      if (win) {
        if (win.proxyEnable !== undefined) {
          await this.setReg('ProxyEnable', 'REG_DWORD', win.proxyEnable || '0');
        } else {
          await this.setReg('ProxyEnable', 'REG_DWORD', '0');
        }

        if (win.proxyServer) {
          await this.setReg('ProxyServer', 'REG_SZ', win.proxyServer);
        } else {
          await this.deleteReg('ProxyServer');
        }

        if (win.proxyOverride !== undefined) {
          await this.setReg('ProxyOverride', 'REG_SZ', win.proxyOverride);
        } else {
          await this.deleteReg('ProxyOverride');
        }

        if (win.autoConfigURL) {
          await this.setReg('AutoConfigURL', 'REG_SZ', win.autoConfigURL);
        } else {
          await this.deleteReg('AutoConfigURL');
        }
      } else {
        await this.setReg('ProxyEnable', 'REG_DWORD', '0');
      }

      await this.notifyProxyChanged();
      await this.syncWinHttp();
      console.log('[system-proxy] 已恢复原系统代理设置(Windows)');
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

  private async readWinCurrent(): Promise<SavedWinProxySettings> {
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

  // ─── macOS ─────────────────────────────────────────────────

  private async enableMac(port: number, opts: SystemProxyOptions): Promise<void> {
    const services = await this.listMacServices();
    if (!services.length) {
      throw new Error('未找到可用的网络服务（Wi-Fi/Ethernet）');
    }

    if (!this.saved) {
      const macServices: SavedMacServiceProxy[] = [];
      for (const service of services) {
        macServices.push(await this.readMacService(service));
      }
      this.saved = { macServices };
    }

    const bypass = buildMacBypassDomains(opts);
    const portStr = String(port);

    for (const service of services) {
      await this.runNetworksetup(['-setwebproxy', service, '127.0.0.1', portStr]);
      await this.runNetworksetup(['-setsecurewebproxy', service, '127.0.0.1', portStr]);
      await this.runNetworksetup(['-setsocksfirewallproxy', service, '127.0.0.1', portStr]);
      await this.runNetworksetup(['-setwebproxystate', service, 'on']);
      await this.runNetworksetup(['-setsecurewebproxystate', service, 'on']);
      await this.runNetworksetup(['-setsocksfirewallproxystate', service, 'on']);
      await this.runNetworksetup(['-setproxybypassdomains', service, ...bypass]);
      // 关掉自动代理/PAC，避免覆盖手动代理
      await this.runNetworksetup(['-setautoproxystate', service, 'off']);
    }

    this.enabled = true;
    console.log(
      `[system-proxy] 已启用(macOS): HTTP/HTTPS/SOCKS 127.0.0.1:${port}；services=${services.join(', ')}`
    );
  }

  private async disableMac(): Promise<void> {
    try {
      const savedServices = this.saved?.macServices;
      if (savedServices?.length) {
        for (const s of savedServices) {
          await this.restoreMacService(s);
        }
        console.log('[system-proxy] 已恢复原系统代理设置(macOS)');
      } else {
        // 无备份时强制关闭当前服务上的代理，避免残留指向本机
        const services = await this.listMacServices();
        for (const service of services) {
          await this.runNetworksetup(['-setwebproxystate', service, 'off']);
          await this.runNetworksetup(['-setsecurewebproxystate', service, 'off']);
          await this.runNetworksetup(['-setsocksfirewallproxystate', service, 'off']);
        }
        console.log('[system-proxy] 无备份，已关闭 macOS 系统代理');
      }
    } catch (err) {
      console.error('[system-proxy] macOS 恢复失败:', err);
      try {
        const services = await this.listMacServices();
        for (const service of services) {
          await this.runNetworksetup(['-setwebproxystate', service, 'off']);
          await this.runNetworksetup(['-setsecurewebproxystate', service, 'off']);
          await this.runNetworksetup(['-setsocksfirewallproxystate', service, 'off']);
        }
      } catch {
        /* ignore */
      }
    } finally {
      this.saved = null;
      this.enabled = false;
    }
  }

  private async listMacServices(): Promise<string[]> {
    const { stdout } = await execFileAsync('networksetup', ['-listallnetworkservices']);
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('An asterisk') && !l.startsWith('*'));
  }

  private async readMacService(service: string): Promise<SavedMacServiceProxy> {
    const web = await this.parseMacProxyOutput(
      await this.runNetworksetup(['-getwebproxy', service])
    );
    const secure = await this.parseMacProxyOutput(
      await this.runNetworksetup(['-getsecurewebproxy', service])
    );
    const socks = await this.parseMacProxyOutput(
      await this.runNetworksetup(['-getsocksfirewallproxy', service])
    );
    const bypassOut = await this.runNetworksetup(['-getproxybypassdomains', service]);
    const bypass = bypassOut
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l !== 'There aren\'t any bypass domains set on' && !l.includes('bypass domains'));

    let autoProxyUrl = '';
    let autoProxyEnabled = false;
    try {
      const autoOut = await this.runNetworksetup(['-getautoproxyurl', service]);
      const urlMatch = autoOut.match(/URL:\s*(.*)/i);
      const enabledMatch = autoOut.match(/Enabled:\s*(Yes|No)/i);
      autoProxyUrl = (urlMatch?.[1] || '').trim();
      autoProxyEnabled = /^Yes$/i.test(enabledMatch?.[1] || '');
    } catch {
      /* ignore */
    }

    return { service, web, secure, socks, bypass, autoProxyUrl, autoProxyEnabled };
  }

  private parseMacProxyOutput(out: string): MacProxyState {
    const enabled = /Enabled:\s*Yes/i.test(out);
    const server = (out.match(/Server:\s*(.*)/i)?.[1] || '').trim();
    const port = (out.match(/Port:\s*(\d+)/i)?.[1] || '0').trim();
    return { enabled, server, port };
  }

  private async restoreMacService(s: SavedMacServiceProxy): Promise<void> {
    const { service, web, secure, socks, bypass, autoProxyUrl, autoProxyEnabled } = s;

    if (web.server) {
      await this.runNetworksetup(['-setwebproxy', service, web.server, web.port || '0']);
    }
    await this.runNetworksetup(['-setwebproxystate', service, web.enabled ? 'on' : 'off']);

    if (secure.server) {
      await this.runNetworksetup(['-setsecurewebproxy', service, secure.server, secure.port || '0']);
    }
    await this.runNetworksetup(['-setsecurewebproxystate', service, secure.enabled ? 'on' : 'off']);

    // 恢复启动前的 SOCKS（例如 Clash 7888）
    if (socks?.server) {
      await this.runNetworksetup([
        '-setsocksfirewallproxy',
        service,
        socks.server,
        socks.port || '0'
      ]);
    }
    await this.runNetworksetup([
      '-setsocksfirewallproxystate',
      service,
      socks?.enabled ? 'on' : 'off'
    ]);

    if (bypass.length) {
      await this.runNetworksetup(['-setproxybypassdomains', service, ...bypass]);
    } else {
      await this.runNetworksetup(['-setproxybypassdomains', service, 'Empty']);
    }

    if (autoProxyUrl && autoProxyUrl !== '(null)') {
      await this.runNetworksetup(['-setautoproxyurl', service, autoProxyUrl]);
    }
    await this.runNetworksetup(['-setautoproxystate', service, autoProxyEnabled ? 'on' : 'off']);
  }

  /**
   * 执行 networksetup；权限不足时通过 osascript 提权（会弹系统密码框）
   */
  private async runNetworksetup(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('networksetup', args);
      return stdout || '';
    } catch (err) {
      const msg = (err as Error).message || String(err);
      const needAdmin =
        /not\s+authorized|permission|privileges|Authorization/i.test(msg) ||
        (err as { code?: string | number }).code === 1;

      if (!needAdmin) throw err;

      const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
      const script = `do shell script "networksetup ${quoted}" with administrator privileges`;
      const { stdout } = await execFileAsync('osascript', ['-e', script]);
      return stdout || '';
    }
  }
}

export const systemProxyManager = new SystemProxyManager();
