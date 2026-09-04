import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 规范化用于签发 MITM 证书的主机名。
 * http-mitm-proxy 用 /^[\d.]+$/ 判断 IP，会把 "1.2.3" 等非法串当成 IP，
 * 触发 node-forge: Extension "ip" value is not a valid IPv4 or IPv6 address.
 */
export function sanitizeCertHostname(hostname: string): string {
  let host = (hostname || '').trim();
  if (!host) return 'unknown.host';

  // [IPv6]:port 或 [IPv6]
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end > 1) {
      host = host.slice(1, end);
    }
  } else if (net.isIP(host) === 0 && /^[^:]+:\d+$/.test(host)) {
    // hostname:port（非 IPv6）
    host = host.slice(0, host.lastIndexOf(':'));
  }

  host = host.trim().toLowerCase();
  if (!host) return 'unknown.host';

  // 形似 IP 但非法 → 改为 DNS 名，避免 forge 按 IP 扩展写入
  if (/^[\d.]+$/.test(host) && net.isIP(host) !== 4) {
    return `invalid-ip.${host.replace(/\./g, '-')}.local`;
  }

  return host;
}

export function isTransientProxyError(message: string): boolean {
  const msg = (message || '').toLowerCase();
  return (
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('econnaborted') ||
    msg.includes('epipe') ||
    msg.includes('ecanceled') ||
    msg.includes('write after end') ||
    msg.includes('client network socket disconnected')
  );
}

/**
 * 修补 http-mitm-proxy 的 CA：仅对 net.isIP 为真的主机使用 IP SAN。
 */
export function patchMitmCa(ca: any): void {
  if (!ca || ca.__captureIpPatched) return;

  const original = ca.generateServerCertificateKeys.bind(ca);
  ca.generateServerCertificateKeys = (hosts: string | string[], cb: (cert: string, key: string) => void) => {
    let list = typeof hosts === 'string' ? [hosts] : [...(hosts || [])];
    list = list.map(sanitizeCertHostname);
    if (list.length === 0) list = ['unknown.host'];

    const safeHosts = list.map((h: string) => {
      if (net.isIP(h) === 4 || net.isIP(h) === 6) return h;
      if (/^[\d.]+$/.test(h)) {
        return `host-${h.replace(/\./g, '-')}.local`;
      }
      return h;
    });

    try {
      return original(safeHosts, cb);
    } catch (err) {
      console.error('[cert] generateServerCertificateKeys failed:', err);
      const fallback = safeHosts.map((h: string) =>
        net.isIP(h) ? `ip-${String(h).replace(/[:.]/g, '-')}.local` : h
      );
      try {
        return original(fallback, cb);
      } catch (err2) {
        console.error('[cert] fallback also failed:', err2);
        throw err2;
      }
    }
  };

  ca.__captureIpPatched = true;
}

/** 在创建 Proxy 实例前修补 CA 原型，避免 listen 竞态 */
export function patchMitmCaPrototype(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const caMod = require('http-mitm-proxy/dist/lib/ca.js');
    const CA = caMod.CA;
    if (!CA?.prototype || CA.prototype.__captureIpPatched) return;

    const original = CA.prototype.generateServerCertificateKeys;
    CA.prototype.generateServerCertificateKeys = function (
      hosts: string | string[],
      cb: (cert: string, key: string) => void
    ) {
      let list = typeof hosts === 'string' ? [hosts] : [...(hosts || [])];
      list = list.map(sanitizeCertHostname);
      if (list.length === 0) list = ['unknown.host'];

      const safeHosts = list.map((h: string) => {
        if (net.isIP(h) === 4 || net.isIP(h) === 6) return h;
        if (/^[\d.]+$/.test(h)) {
          return `host-${h.replace(/\./g, '-')}.local`;
        }
        return h;
      });

      try {
        return original.call(this, safeHosts, cb);
      } catch (err) {
        console.error('[cert] generateServerCertificateKeys failed:', err);
        const fallback = safeHosts.map((h: string) =>
          net.isIP(h) ? `ip-${String(h).replace(/[:.]/g, '-')}.local` : h
        );
        return original.call(this, fallback, cb);
      }
    };

    CA.prototype.__captureIpPatched = true;
    console.log('[cert] CA.prototype patched for IP SAN validation');
  } catch (err) {
    console.warn('[cert] patchMitmCaPrototype failed:', err);
  }
}

export function ensureCertDir(sslCaDir: string): void {
  fs.mkdirSync(path.join(sslCaDir, 'certs'), { recursive: true });
  fs.mkdirSync(path.join(sslCaDir, 'keys'), { recursive: true });
}

/** 确保 MITM 根 CA（ca.pem）已生成；未启动代理时也可安装证书 */
export function ensureCaCertificate(sslCaDir: string): Promise<string> {
  ensureCertDir(sslCaDir);
  const caCertPath = path.join(sslCaDir, 'certs', 'ca.pem');
  if (fs.existsSync(caCertPath)) {
    return Promise.resolve(caCertPath);
  }

  return new Promise((resolve, reject) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CA } = require('http-mitm-proxy/dist/lib/ca.js');
      CA.create(sslCaDir, (err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        if (!fs.existsSync(caCertPath)) {
          reject(new Error('CA 生成成功但未找到 ca.pem'));
          return;
        }
        resolve(caCertPath);
      });
    } catch (err) {
      reject(err);
    }
  });
}
