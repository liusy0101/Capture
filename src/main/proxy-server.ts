import { EventEmitter } from 'events';
import { app } from 'electron';
import * as path from 'path';
import * as zlib from 'zlib';
import { v4 as uuidv4 } from 'uuid';
import { ProxyConfig, Packet, WebSocketPacket, WebSocketMessage } from '../types';
import { RewriteManager } from './rewrite-manager';
import { ensureCertDir, isTransientProxyError, patchMitmCa, patchMitmCaPrototype, sanitizeCertHostname } from './cert-utils';
import { patchWsSubprotocolFromHeaders } from './ws-patch';

// http-mitm-proxy 没有完整的 TS 类型导出，这里按其 README API 定义所需的最小接口
interface IProxyMitm {
  listen(opts: { port: number; host?: string; sslCaDir?: string; keepAlive?: boolean; forceSNI?: boolean }, cb?: (err?: Error) => void): void;
  close(cb?: () => void): void;
  onError(fn: (ctx: any, err: Error, errorKind?: string) => void): void;
  // 可覆盖的实例方法（不是 onError 那种注册器）
  onCertificateRequired(
    hostname: string,
    callback: (err: Error | null, files: {
      keyFile: string;
      certFile: string;
      hosts?: string[];
    }) => void
  ): void;
  onCertificateMissing?(
    ctx: any,
    files: any,
    callback: (err: Error | null, files: any) => void
  ): void;
  onRequest(fn: (ctx: any, callback: (err?: Error) => void) => void): void;
  onWebSocketConnection(fn: (ctx: any, callback: (err?: Error) => void) => void): void;
  onWebSocketSend(fn: (ctx: any, message: any, flags: any, callback: (err: Error | null, message: any, flags: any) => void) => void): void;
  onWebSocketMessage(fn: (ctx: any, message: any, flags: any, callback: (err: Error | null, message: any, flags: any) => void) => void): void;
  onWebSocketFrame(fn: (ctx: any, type: string, fromServer: boolean, data: any, flags: any, callback: (err: Error | null, data: any, flags: any) => void) => void): void;
  onWebSocketError(fn: (ctx: any, err: Error) => void): void;
  onWebSocketClose(fn: (ctx: any, code: number, message: any, callback: (err: Error | null, code: number, message: any) => void) => void): void;
  use(mod: any): void;
  gunzip: any;
  ca?: any;
}

/**
 * 基于 http-mitm-proxy 的代理服务器
 *
 * 相比之前的手动实现，本版本：
 *  1. 通过 MITM 自动解密 HTTPS / WSS
 *  2. 自动生成并缓存 CA 证书
 *  3. 使用库自带的 WebSocket 事件正确解析帧
 *  4. 监听 0.0.0.0；配合系统代理 <-loopback> 抓取 localhost
 */
export class ProxyServer extends EventEmitter {
  private config: ProxyConfig;
  private packetManager: any;
  private rewriteManager: RewriteManager;
  private proxy: IProxyMitm | null = null;
  private isRunning: boolean = false;
  private pendingWebSockets: Map<any, WebSocketPacket> = new Map();
  private sslCaDir: string;

  constructor(config: ProxyConfig, packetManager: any, rewriteManager?: RewriteManager) {
    super();
    this.config = config;
    this.packetManager = packetManager;
    this.rewriteManager = rewriteManager || new RewriteManager();
    this.sslCaDir = path.join(app.getPath('userData'), 'mitm-certs');
  }

  start(): Promise<void> {
    if (this.isRunning) {
      console.log('Proxy server is already running');
      return Promise.resolve();
    }

    // 必须在 require http-mitm-proxy 之前打补丁，否则上游 WS 子协议会校验失败
    patchWsSubprotocolFromHeaders();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mitm = require('http-mitm-proxy');
    const Proxy = mitm.Proxy || mitm;
    patchMitmCaPrototype();
    const proxy = new Proxy() as IProxyMitm;
    this.proxy = proxy;

    console.log('MITM CA certificates dir:', this.sslCaDir);
    ensureCertDir(this.sslCaDir);

    // 全局启用 gzip 解压中间件（注意：要用类上的 Proxy.gunzip，不是实例属性）
    try {
      const gunzipMw = (Proxy as any).gunzip || mitm.gunzip;
      if (gunzipMw) {
        proxy.use(gunzipMw);
      }
    } catch (err) {
      console.warn('[proxy] enable gunzip middleware failed:', err);
    }

    proxy.onError((ctx: any, err: Error, errorKind?: string) => {
      const url = ctx?.clientToProxyRequest?.url
        || ctx?.clientToProxyWebSocket?.upgradeReq?.url
        || '';
      console.error(`[proxy error] ${errorKind || ''} on ${url}:`, err.message);
      // 瞬时断开不刷状态栏，避免 "socket hang up" 刷屏
      if (!isTransientProxyError(err.message)) {
        this.emit('error', err);
      }
    });

    // 覆盖默认 onCertificateRequired（必须赋值，不能当 onXxx 注册器调用）
    // 错误写法 proxy.onCertificateRequired(fn) 会触发 "callback is not a function"
    proxy.onCertificateRequired = (
      hostname: string,
      callback: (err: Error | null, files: any) => void
    ) => {
      const safe = sanitizeCertHostname(hostname);
      const keyFile = path.join(this.sslCaDir, 'keys', `${safe}.key`);
      const certFile = path.join(this.sslCaDir, 'certs', `${safe}.pem`);
      return callback(null, { keyFile, certFile, hosts: [safe] });
    };

    // ---------- HTTP / HTTPS（使用 ctx 级 handler，避免每次请求注册全局监听） ----------
    proxy.onRequest((ctx: any, callback: (err?: Error) => void) => {
      if (!this.isRunning) {
        return callback();
      }
      // 避免 br 压缩导致展示乱码；仍可能收到 gzip/deflate，后面会手动解压
      try {
        if (ctx.proxyToServerRequestOptions?.headers) {
          ctx.proxyToServerRequestOptions.headers['accept-encoding'] = 'gzip, deflate, identity';
        }
        if (ctx.clientToProxyRequest?.headers) {
          ctx.clientToProxyRequest.headers['accept-encoding'] = 'gzip, deflate, identity';
        }
      } catch {
        /* ignore */
      }

      const req = ctx.clientToProxyRequest;
      const host = req.headers.host || '';
      const isSSL = !!ctx.isSSL;
      const protocol = isSSL ? 'https' : 'http';
      let fullUrl = `${protocol}://${host}${req.url}`;
      const method = req.method || 'GET';
      let headers = this.normalizeHeaders(req.headers);

      // Charles 风格：匹配后改写 URL / Header，再真正发往上游
      let rewriteApplied = false;
      try {
        const rewrite = this.rewriteManager.applyRequestRewrite(fullUrl, method, headers);
        if (rewrite.results.some((r) => r.matched)) {
          rewriteApplied = true;
          console.log('[rewrite] matched', rewrite.results.filter((r) => r.matched).map((r) => r.ruleName));
        }

        if (rewrite.shouldRedirect && rewrite.redirectUrl) {
          const redirectUrl = rewrite.redirectUrl;
          const clientRes = ctx.proxyToClientResponse;
          if (clientRes && !clientRes.headersSent) {
            clientRes.writeHead(302, { Location: redirectUrl, Connection: 'close' });
            clientRes.end();
          }
          if (this.config.recordRequests && this.shouldCaptureHost(host)) {
            const packet: Packet = {
              id: uuidv4(),
              timestamp: Date.now(),
              method,
              url: fullUrl,
              protocol,
              status: 302,
              statusText: 'Found (rewrite redirect)',
              requestHeaders: headers,
              responseHeaders: { location: redirectUrl },
              requestBody: undefined,
              responseBody: `Redirected to ${redirectUrl}`,
              duration: 0,
              size: 0,
              isError: false
            };
            if (this.isRunning) {
              this.emit('request', packet);
              this.packetManager?.addPacket(packet);
            }
          }
          return; // 不继续转发
        }

        if (rewrite.modifiedUrl && rewrite.modifiedUrl !== fullUrl) {
          this.applyUpstreamUrl(ctx, rewrite.modifiedUrl, isSSL);
          fullUrl = rewrite.modifiedUrl;
          headers = { ...headers, ...this.normalizeHeaders(ctx.proxyToServerRequestOptions?.headers || {}) };
          rewriteApplied = true;
        }

        if (rewrite.modifiedHeaders) {
          headers = { ...rewrite.modifiedHeaders };
          const optsHeaders = ctx.proxyToServerRequestOptions?.headers;
          if (optsHeaders) {
            // 清空后写入改写结果
            for (const key of Object.keys(optsHeaders)) {
              delete optsHeaders[key];
            }
            for (const [k, v] of Object.entries(rewrite.modifiedHeaders)) {
              optsHeaders[k] = v;
            }
          }
        }
      } catch (err) {
        console.error('[rewrite] request rewrite failed:', err);
      }

      if (!this.config.recordRequests) {
        return callback();
      }

      if (!this.shouldCaptureHost(host) && !rewriteApplied) {
        return callback();
      }

      const startTime = Date.now();
      const packet: Packet = {
        id: uuidv4(),
        timestamp: startTime,
        method,
        url: fullUrl,
        protocol,
        status: undefined,
        statusText: undefined,
        requestHeaders: headers,
        responseHeaders: undefined,
        requestBody: undefined,
        responseBody: undefined,
        duration: undefined,
        size: undefined,
        ip: req.socket?.remoteAddress,
        localPort: req.socket?.localPort,
        remotePort: req.socket?.remotePort,
        isError: false,
        errorMessage: undefined
      };

      const reqChunks: Buffer[] = [];
      ctx.onRequestData((_c: any, chunk: Buffer, cb: (e: Error | null, chunk?: Buffer) => void) => {
        reqChunks.push(chunk);
        return cb(null, chunk);
      });

      ctx.onRequestEnd((_c: any, cb: (err?: Error) => void) => {
        if (reqChunks.length > 0) {
          const fullReq = Buffer.concat(reqChunks);
          try {
            const rewritten = this.rewriteManager.applyRequestRewrite(
              packet.url,
              packet.method,
              packet.requestHeaders,
              fullReq.toString('utf8')
            );
            if (rewritten.modifiedBody !== undefined && rewritten.modifiedBody !== fullReq.toString('utf8')) {
              const bodyStr =
                typeof rewritten.modifiedBody === 'string'
                  ? rewritten.modifiedBody
                  : JSON.stringify(rewritten.modifiedBody);
              packet.requestBody = this.parseBody(bodyStr, req.headers['content-type']);
              // 改写后的 body 需要替换发出：http-mitm-proxy 已在 onRequestData 透传，
              // 这里仅记录；完整 body 替换需在 onRequestData 阶段完成，见下方简化策略
            } else {
              packet.requestBody = this.parseBody(fullReq.toString('utf8'), req.headers['content-type']);
            }
          } catch {
            packet.requestBody = this.parseBody(fullReq.toString('utf8'), req.headers['content-type']);
          }
        }
        return cb();
      });

      ctx.onResponse((_c: any, cb: (err?: Error) => void) => {
        const res = ctx.serverToProxyResponse;
        packet.status = res?.statusCode;
        packet.statusText = res?.statusMessage;
        packet.responseHeaders = this.normalizeHeaders(res?.headers || {});

        // 尽量走库自带 gunzip；br/deflate 在收集完后手动解压
        try {
          ctx.use(proxy.gunzip);
        } catch {
          /* ignore */
        }

        const resChunks: Buffer[] = [];
        ctx.onResponseData((_cc: any, chunk: Buffer, ccb: (e: Error | null, chunk?: Buffer) => void) => {
          resChunks.push(chunk);
          return ccb(null, chunk);
        });

        ctx.onResponseEnd((_cc: any, ccb: (err?: Error) => void) => {
          const fullRes = Buffer.concat(resChunks);
          const encoding =
            packet.responseHeaders?.['content-encoding'] ||
            res?.headers?.['content-encoding'] ||
            '';
          const decoded = this.decodeResponseBody(fullRes, encoding);
          const contentType =
            packet.responseHeaders?.['content-type'] ||
            res?.headers?.['content-type'];

          let body: any = this.parseBody(decoded.text, contentType);

          // 响应侧重写
          try {
            const rr = this.rewriteManager.applyResponseRewrite(
              packet.status || 200,
              packet.responseHeaders || {},
              body,
              packet.url
            );
            if (rr.results.some((r) => r.matched)) {
              packet.status = rr.modifiedStatusCode;
              packet.responseHeaders = rr.modifiedHeaders;
              body = rr.modifiedBody;
              // 同步改写给客户端的响应（仅文本场景）
              if (typeof body === 'string' || typeof body === 'object') {
                /* 展示用；客户端流已写出，响应改写主要影响记录与后续规则设计 */
              }
            }
          } catch (err) {
            console.error('[rewrite] response rewrite failed:', err);
          }

          packet.responseBody = body;
          packet.size = decoded.buffer.length;
          packet.duration = Date.now() - startTime;
          if (decoded.decompressed && packet.responseHeaders) {
            delete packet.responseHeaders['content-encoding'];
            packet.responseHeaders['content-length'] = String(decoded.buffer.length);
          }
          if (this.isRunning) {
            this.emit('request', packet);
            this.packetManager?.addPacket(packet);
          }
          return ccb();
        });

        return cb();
      });

      return callback();
    });

    // ---------- WebSocket ----------
    proxy.onWebSocketConnection((ctx: any, callback: (err?: Error) => void) => {
      // 库在调用本 handler 前已写好 proxyToServerWebSocketOptions；此处必须修好再 callback，
      // 否则上游常返回 400（Unexpected server response: 400），业务 WSS 直接不可用。
      this.fixUpstreamWebSocketOptions(ctx);

      if (!this.isRunning || !this.config.recordWebSocket) {
        return callback();
      }

      const upgradeReq = ctx.clientToProxyWebSocket?.upgradeReq || {};
      const host = this.resolveWsHost(ctx, upgradeReq);
      const isSSL = !!ctx.isSSL;
      const protocol = isSSL ? 'wss' : 'ws';
      const reqUrl = upgradeReq.url || '';
      // 绝对 URL（经 HTTP 代理的 ws）或相对路径
      const fullUrl =
        ctx.proxyToServerWebSocketOptions?.url ||
        (/^wss?:\/\//i.test(reqUrl) ? reqUrl : `${protocol}://${host}${reqUrl}`);

      if (!this.shouldCaptureHost(host)) {
        console.log(`[ws] skip host: ${host}`);
        return callback();
      }

      console.log(`[ws] connect ${fullUrl}`);

      const startTime = Date.now();
      const wsPacket: WebSocketPacket = {
        id: uuidv4(),
        timestamp: startTime,
        method: 'WS',
        url: fullUrl,
        protocol,
        status: 101,
        statusText: 'Switching Protocols',
        requestHeaders: this.normalizeHeaders(upgradeReq.headers || {}),
        responseHeaders: undefined,
        requestBody: undefined,
        responseBody: undefined,
        duration: Date.now() - startTime,
        size: 0,
        ip: upgradeReq.socket?.remoteAddress,
        localPort: upgradeReq.socket?.localPort,
        remotePort: upgradeReq.socket?.remotePort,
        isError: false,
        errorMessage: undefined,
        messages: [],
        connectionId: uuidv4(),
        state: 'connected'
      };

      this.pendingWebSockets.set(ctx, wsPacket);
      this.emit('websocket', { ...wsPacket, messages: [...wsPacket.messages] });
      this.packetManager?.addPacket(wsPacket);

      return callback();
    });

    proxy.onWebSocketSend((ctx: any, message: any, flags: any, callback: (e: Error | null, m: any, f: any) => void) => {
      this.recordWsMessage(ctx, 'outgoing', message, flags);
      return callback(null, message, flags);
    });

    proxy.onWebSocketMessage((ctx: any, message: any, flags: any, callback: (e: Error | null, m: any, f: any) => void) => {
      this.recordWsMessage(ctx, 'incoming', message, flags);
      return callback(null, message, flags);
    });

    proxy.onWebSocketFrame((ctx: any, type: string, fromServer: boolean, data: any, flags: any, callback: (e: Error | null, d: any, f: any) => void) => {
      if (type === 'close') {
        const wsPacket = this.pendingWebSockets.get(ctx);
        if (wsPacket) {
          wsPacket.state = 'disconnected';
          this.emit('websocket', { ...wsPacket, messages: [...wsPacket.messages] });
          this.pendingWebSockets.delete(ctx);
        }
      } else if (type === 'ping' || type === 'pong') {
        this.recordWsMessage(ctx, fromServer ? 'incoming' : 'outgoing', data, { opcode: type === 'ping' ? 0x9 : 0xA }, true);
      }
      return callback(null, data, flags);
    });

    proxy.onWebSocketError((ctx: any, err: Error) => {
      console.error('[ws error]', err.message);
      const wsPacket = this.pendingWebSockets.get(ctx);
      if (wsPacket) {
        wsPacket.state = 'error';
        wsPacket.isError = true;
        wsPacket.errorMessage = err.message;
        const statusMatch = /Unexpected server response:\s*(\d+)/i.exec(err.message);
        if (statusMatch) {
          wsPacket.status = parseInt(statusMatch[1], 10);
          wsPacket.statusText = 'WebSocket handshake failed';
        }
        wsPacket.messages.push({
          id: uuidv4(),
          timestamp: Date.now(),
          direction: 'incoming',
          type: 'error',
          content: this.formatWsHandshakeError(err.message),
          size: err.message.length
        });
        this.emit('websocket', { ...wsPacket, messages: [...wsPacket.messages] });
        this.pendingWebSockets.delete(ctx);
      }
    });

    proxy.onWebSocketClose((ctx: any, code: number, message: any, callback: (e: Error | null, c: number, m: any) => void) => {
      const wsPacket = this.pendingWebSockets.get(ctx);
      if (wsPacket) {
        wsPacket.state = 'disconnected';
        const safeCode = typeof code === 'number' && code >= 1000 && code <= 4999 ? code : 1006;
        wsPacket.closeCode = safeCode;
        wsPacket.closeReason = typeof message === 'string' ? message : (message ? message.toString() : '');
        this.emit('websocket', { ...wsPacket, messages: [...wsPacket.messages] });
        this.pendingWebSockets.delete(ctx);
      }
      const safeCode = typeof code === 'number' && code >= 1000 && code <= 4999 ? code : 1006;
      try {
        return callback(null, safeCode, message);
      } catch (err) {
        console.warn('[ws] close callback:', err);
        return callback(null, 1006, message);
      }
    });

    return new Promise((resolve, reject) => {
      proxy.listen(
        {
          port: this.config.port,
          host: '0.0.0.0',
          sslCaDir: this.sslCaDir,
          keepAlive: true,
          forceSNI: true
        },
        (err?: Error) => {
          if (err) {
            this.proxy = null;
            this.isRunning = false;
            console.error('Failed to start MITM proxy:', err);
            reject(err);
            return;
          }
          // listen 完成后 CA 已创建，立刻打补丁
          try {
            patchMitmCa((proxy as any).ca);
          } catch (patchErr) {
            console.error('[cert] patchMitmCa failed:', patchErr);
          }
          this.isRunning = true;
          console.log(`MITM proxy server running on 0.0.0.0:${this.config.port}`);
          resolve();
        }
      );
    });
  }

  stop(): void {
    if (!this.proxy) {
      this.isRunning = false;
      this.pendingWebSockets.clear();
      return;
    }

    try {
      const p: any = this.proxy;
      // 先断掉现有连接，否则 close() 会等 keep-alive，表现为「停止不生效」
      try {
        p.httpServer?.closeAllConnections?.();
        p.httpsServer?.closeAllConnections?.();
        if (p.sslServers) {
          for (const name of Object.keys(p.sslServers)) {
            p.sslServers[name]?.server?.closeAllConnections?.();
            p.sslServers[name]?.server?.close?.();
          }
        }
      } catch (err) {
        console.warn('[proxy] closeAllConnections:', err);
      }

      p.close();
      console.log('Proxy server stopped');
    } catch (e) {
      console.error('Error stopping proxy:', e);
    }

    this.proxy = null;
    this.pendingWebSockets.clear();
    this.isRunning = false;
  }

  updateConfig(newConfig: Partial<ProxyConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  getPort(): number {
    return this.config.port;
  }

  getCaDir(): string {
    return this.sslCaDir;
  }

  getCaCertPath(): string {
    return path.join(this.sslCaDir, 'certs', 'ca.pem');
  }

  /**
   * 修复 http-mitm-proxy 默认的上游 WS 握手：
   * - 库会丢掉所有 sec-websocket-* 头（含 Protocol），很多业务（如 kdocs）会直接 400
   * - 默认 perMessageDeflate=true，与部分服务器协商失败也会 400
   * - 透传 hop-by-hop 头可能干扰 ws 客户端重建 Upgrade
   */
  private fixUpstreamWebSocketOptions(ctx: any): void {
    const opts = ctx?.proxyToServerWebSocketOptions;
    if (!opts) return;

    const upgradeReq = ctx.clientToProxyWebSocket?.upgradeReq || {};
    const rawHeaders: Record<string, string | string[] | undefined> = upgradeReq.headers || {};

    // 优先用 CONNECT 目标校正上游 URL（比 Host 更准）
    const connectTarget = ctx.connectRequest?.url; // e.g. "365.kdocs.cn:443"
    const pathAndQuery = (() => {
      const u = upgradeReq.url || '/';
      if (/^wss?:\/\//i.test(u)) {
        try {
          const parsed = new URL(u);
          return parsed.pathname + parsed.search;
        } catch {
          return u;
        }
      }
      return u.startsWith('/') ? u : `/${u}`;
    })();

    if (connectTarget) {
      const prefix = ctx.isSSL ? 'wss' : 'ws';
      opts.url = `${prefix}://${connectTarget}${pathAndQuery}`;
    } else if (opts.url && /^https?:\/\//i.test(opts.url)) {
      opts.url = opts.url.replace(/^http/i, 'ws');
    }

    const hopByHop = new Set([
      'connection',
      'upgrade',
      'keep-alive',
      'proxy-connection',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailers',
      'transfer-encoding',
      'content-length',
      'content-encoding',
      'accept-encoding'
    ]);

    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(opts.headers || {})) {
      const lk = key.toLowerCase();
      if (hopByHop.has(lk)) continue;
      if (lk.startsWith('sec-websocket')) continue;
      if (value == null) continue;
      cleaned[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    // 补回子协议到 Header；ws-patch 会在 new WebSocket(url, options) 时提升为 protocols 参数
    const proto = rawHeaders['sec-websocket-protocol'];
    if (proto) {
      cleaned['Sec-WebSocket-Protocol'] = Array.isArray(proto) ? proto.join(', ') : String(proto);
    }

    // Host 与上游 URL 对齐
    try {
      const upstream = new URL(opts.url);
      cleaned.Host = upstream.host;
      opts.servername = upstream.hostname;
    } catch {
      /* ignore */
    }

    opts.headers = cleaned;
    // 关闭默认压缩扩展，避免部分网关对 Sec-WebSocket-Extensions 直接 400
    opts.perMessageDeflate = false;
    opts.handshakeTimeout = opts.handshakeTimeout || 15000;
    // 不用 keep-alive Agent，避免复用半开连接导致握手异常
    opts.agent = undefined;

    console.log(
      `[ws] upstream ${opts.url}` +
        (cleaned['Sec-WebSocket-Protocol'] ? ` proto=${cleaned['Sec-WebSocket-Protocol']}` : '')
    );
  }

  private formatWsHandshakeError(message: string): string {
    if (/subprotocol but none was requested/i.test(message)) {
      return (
        `${message}\n\n` +
        '上游返回了 Sec-WebSocket-Protocol，但客户端握手未登记子协议。请更新到已修复版本（会把协议头提升为 ws 构造参数）。'
      );
    }
    if (/Unexpected server response:\s*400/i.test(message)) {
      return (
        `${message}\n\n` +
        '上游拒绝了 WebSocket 握手（HTTP 400）。常见原因：缺少 Sec-WebSocket-Protocol、扩展协商失败、Cookie/鉴权头未正确转发。' +
        '若仍失败，请确认已安装并信任 Capture CA，并关掉可能改写该域名的重写规则。'
      );
    }
    if (/Unexpected server response:\s*(\d+)/i.test(message)) {
      return `${message}\n\n上游 WebSocket 握手失败，连接未能升级为 101。`;
    }
    return message;
  }

  private resolveWsHost(ctx: any, upgradeReq: any): string {
    // CONNECT 隧道目标优先（host:port）
    const connectTarget = ctx?.connectRequest?.url;
    if (connectTarget) return connectTarget;

    const headerHost = upgradeReq.headers?.host || '';
    if (headerHost) return headerHost;

    const url = upgradeReq.url || '';
    if (/^wss?:\/\//i.test(url)) {
      try {
        return new URL(url).host;
      } catch {
        /* ignore */
      }
    }

    const auth = (upgradeReq as any).headers?.[':authority'];
    if (auth) return auth;

    return ctx.clientToProxyRequest?.headers?.host || 'unknown';
  }

  private recordWsMessage(ctx: any, direction: 'incoming' | 'outgoing', message: any, flags: any, isFrame = false): void {
    if (!this.isRunning) return;
    const wsPacket = this.pendingWebSockets.get(ctx);
    if (!wsPacket) return;

    const isBinary = flags && (flags.binary || flags.opcode === 0x2);
    const opcode = flags?.opcode;
    let type: WebSocketMessage['type'] = isBinary ? 'binary' : 'text';
    if (opcode === 0x8) type = 'close';
    else if (opcode === 0x9) type = 'ping';
    else if (opcode === 0xA) type = 'pong';

    let content: any = message;
    let size = 0;
    if (Buffer.isBuffer(message)) {
      content = isBinary ? message : message.toString('utf8');
      size = message.length;
    } else if (typeof message === 'string') {
      size = Buffer.byteLength(message);
    } else if (message && typeof message === 'object') {
      content = JSON.stringify(message);
      size = Buffer.byteLength(content);
    }

    const msg: WebSocketMessage = {
      id: uuidv4(),
      timestamp: Date.now(),
      direction,
      type,
      content,
      size,
      isMasked: direction === 'outgoing' && !isFrame
    };

    wsPacket.messages.push(msg);
    wsPacket.size = (wsPacket.size || 0) + size;
    this.emit('websocket', { ...wsPacket, messages: [...wsPacket.messages] });
  }

  /**
   * 判断是否抓取指定 host
   * - bypassList 命中：不记录（系统层也应已绕过）
   * - enableLocalhost=true（默认）：抓取本地请求
   * - 配置了 filterDomains：只抓取匹配域名
   */
  private shouldCaptureHost(host: string): boolean {
    const hostname = (host || '').split(':')[0].toLowerCase();
    if (!hostname || hostname === 'unknown') return true;

    if (this.matchesBypass(hostname)) {
      return false;
    }

    const localPatterns = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'];
    const isLocal = localPatterns.some(p => hostname === p || hostname.endsWith('.' + p));

    if (this.config.filterDomains && this.config.filterDomains.length > 0) {
      return this.config.filterDomains.some(d =>
        hostname === d.toLowerCase() || hostname.endsWith('.' + d.toLowerCase())
      );
    }

    if (isLocal) {
      return this.config.enableLocalhost !== false;
    }

    return true;
  }

  private matchesBypass(hostname: string): boolean {
    const raw = this.config.bypassList || '';
    const rules = raw.split(/[;\n,\r]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    for (const rule of rules) {
      if (rule === '<-loopback>' || rule === '<local>') continue;
      if (rule === hostname) return true;
      if (rule.startsWith('*.') && (hostname === rule.slice(2) || hostname.endsWith(rule.slice(1)))) {
        return true;
      }
      // 简单通配：把 * 转成正则
      if (rule.includes('*')) {
        const re = new RegExp('^' + rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
        if (re.test(hostname)) return true;
      }
    }
    return false;
  }

  private applyUpstreamUrl(ctx: any, absoluteUrl: string, isSSL: boolean): void {
    try {
      const u = new URL(absoluteUrl);
      const opts = ctx.proxyToServerRequestOptions;
      if (!opts) return;

      opts.host = u.hostname;
      opts.port = u.port
        ? parseInt(u.port, 10)
        : u.protocol === 'https:'
          ? 443
          : 80;
      opts.path = `${u.pathname}${u.search}`;
      opts.headers = opts.headers || {};
      opts.headers.host = u.host;

      // CONNECT / SSL 场景下同步标记
      if (typeof ctx.isSSL === 'boolean') {
        ctx.isSSL = u.protocol === 'https:' || isSSL;
      }
      console.log(`[rewrite] upstream -> ${u.protocol}//${u.host}${opts.path}`);
    } catch (err) {
      console.error('[rewrite] invalid rewritten url:', absoluteUrl, err);
    }
  }

  /**
   * 解压响应体（gzip / deflate / br），再交给 JSON 解析。
   * gunzip 中间件只处理 gzip，现代站点常返回 br，不解压就会乱码。
   */
  private decodeResponseBody(
    buf: Buffer,
    encoding: string | string[] | undefined
  ): { buffer: Buffer; text: string; decompressed: boolean } {
    const enc = (Array.isArray(encoding) ? encoding[0] : encoding || '')
      .toLowerCase()
      .trim();
    let out = buf;
    let decompressed = false;

    try {
      if (enc.includes('br')) {
        out = zlib.brotliDecompressSync(buf);
        decompressed = true;
      } else if (enc.includes('gzip')) {
        out = zlib.gunzipSync(buf);
        decompressed = true;
      } else if (enc.includes('deflate')) {
        try {
          out = zlib.inflateSync(buf);
        } catch {
          out = zlib.inflateRawSync(buf);
        }
        decompressed = true;
      } else if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        // 头里没写 encoding，但内容是 gzip 魔数
        out = zlib.gunzipSync(buf);
        decompressed = true;
      }
    } catch (err) {
      console.warn('[body] decompress failed, use raw:', (err as Error).message);
      out = buf;
      decompressed = false;
    }

    // 去掉 UTF-8 BOM
    if (out.length >= 3 && out[0] === 0xef && out[1] === 0xbb && out[2] === 0xbf) {
      out = out.subarray(3);
    }

    return { buffer: out, text: out.toString('utf8'), decompressed };
  }

  private normalizeHeaders(headers: any): Record<string, string> {
    const result: Record<string, string> = {};
    if (!headers) return result;
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null) continue;
      result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return result;
  }

  private parseBody(body: string, contentType?: string | string[]): any {
    if (!body) return undefined;
    const ct = Array.isArray(contentType) ? contentType[0] : contentType || '';
    const trimmed = body.trim();
    if (
      ct.includes('application/json') ||
      ct.includes('+json') ||
      trimmed.startsWith('{') ||
      trimmed.startsWith('[')
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // 尝试截掉前后噪声后再 parse
        const start = Math.min(
          ...['{', '['].map((c) => {
            const i = trimmed.indexOf(c);
            return i >= 0 ? i : Number.POSITIVE_INFINITY;
          })
        );
        if (Number.isFinite(start) && start > 0) {
          try {
            return JSON.parse(trimmed.slice(start));
          } catch {
            return body;
          }
        }
        return body;
      }
    }
    return body;
  }
}
