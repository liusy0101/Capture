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
exports.ProxyServer = void 0;
const events_1 = require("events");
const electron_1 = require("electron");
const path = __importStar(require("path"));
const uuid_1 = require("uuid");
const rewrite_manager_1 = require("./rewrite-manager");
const cert_utils_1 = require("./cert-utils");
/**
 * 基于 http-mitm-proxy 的代理服务器
 *
 * 相比之前的手动实现，本版本：
 *  1. 通过 MITM 自动解密 HTTPS / WSS
 *  2. 自动生成并缓存 CA 证书
 *  3. 使用库自带的 WebSocket 事件正确解析帧
 *  4. 监听 0.0.0.0；配合系统代理 <-loopback> 抓取 localhost
 */
class ProxyServer extends events_1.EventEmitter {
    constructor(config, packetManager, rewriteManager) {
        super();
        this.proxy = null;
        this.isRunning = false;
        this.pendingWebSockets = new Map();
        this.config = config;
        this.packetManager = packetManager;
        this.rewriteManager = rewriteManager || new rewrite_manager_1.RewriteManager();
        this.sslCaDir = path.join(electron_1.app.getPath('userData'), 'mitm-certs');
    }
    start() {
        if (this.isRunning) {
            console.log('Proxy server is already running');
            return Promise.resolve();
        }
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Proxy } = require('http-mitm-proxy');
        (0, cert_utils_1.patchMitmCaPrototype)();
        const proxy = new Proxy();
        this.proxy = proxy;
        console.log('MITM CA certificates dir:', this.sslCaDir);
        (0, cert_utils_1.ensureCertDir)(this.sslCaDir);
        proxy.onError((ctx, err, errorKind) => {
            const url = ctx?.clientToProxyRequest?.url
                || ctx?.clientToProxyWebSocket?.upgradeReq?.url
                || '';
            console.error(`[proxy error] ${errorKind || ''} on ${url}:`, err.message);
            // 瞬时断开不刷状态栏，避免 "socket hang up" 刷屏
            if (!(0, cert_utils_1.isTransientProxyError)(err.message)) {
                this.emit('error', err);
            }
        });
        // 覆盖默认 onCertificateRequired（必须赋值，不能当 onXxx 注册器调用）
        // 错误写法 proxy.onCertificateRequired(fn) 会触发 "callback is not a function"
        proxy.onCertificateRequired = (hostname, callback) => {
            const safe = (0, cert_utils_1.sanitizeCertHostname)(hostname);
            const keyFile = path.join(this.sslCaDir, 'keys', `${safe}.key`);
            const certFile = path.join(this.sslCaDir, 'certs', `${safe}.pem`);
            return callback(null, { keyFile, certFile, hosts: [safe] });
        };
        // ---------- HTTP / HTTPS（使用 ctx 级 handler，避免每次请求注册全局监听） ----------
        proxy.onRequest((ctx, callback) => {
            if (!this.config.recordRequests) {
                return callback();
            }
            const req = ctx.clientToProxyRequest;
            const host = req.headers.host || '';
            if (!this.shouldCaptureHost(host)) {
                return callback();
            }
            const isSSL = !!ctx.isSSL;
            const protocol = isSSL ? 'https' : 'http';
            const fullUrl = `${protocol}://${host}${req.url}`;
            const startTime = Date.now();
            const packet = {
                id: (0, uuid_1.v4)(),
                timestamp: startTime,
                method: req.method || 'GET',
                url: fullUrl,
                protocol,
                status: undefined,
                statusText: undefined,
                requestHeaders: this.normalizeHeaders(req.headers),
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
            const reqChunks = [];
            ctx.onRequestData((_c, chunk, cb) => {
                reqChunks.push(chunk);
                return cb(null, chunk);
            });
            ctx.onResponse((_c, cb) => {
                if (reqChunks.length > 0) {
                    const fullReq = Buffer.concat(reqChunks);
                    packet.requestBody = this.parseBody(fullReq.toString(), req.headers['content-type']);
                }
                const res = ctx.serverToProxyResponse;
                packet.status = res?.statusCode;
                packet.statusText = res?.statusMessage;
                packet.responseHeaders = this.normalizeHeaders(res?.headers || {});
                try {
                    ctx.use(proxy.gunzip);
                }
                catch {
                    /* ignore */
                }
                const resChunks = [];
                ctx.onResponseData((_cc, chunk, ccb) => {
                    resChunks.push(chunk);
                    return ccb(null, chunk);
                });
                ctx.onResponseEnd((_cc, ccb) => {
                    const fullRes = Buffer.concat(resChunks);
                    packet.responseBody = this.parseBody(fullRes.toString(), res?.headers?.['content-type']);
                    packet.size = fullRes.length;
                    packet.duration = Date.now() - startTime;
                    this.emit('request', packet);
                    this.packetManager?.addPacket(packet);
                    return ccb();
                });
                return cb();
            });
            return callback();
        });
        // ---------- WebSocket ----------
        proxy.onWebSocketConnection((ctx, callback) => {
            if (!this.config.recordWebSocket) {
                return callback();
            }
            const upgradeReq = ctx.clientToProxyWebSocket?.upgradeReq || {};
            const host = this.resolveWsHost(ctx, upgradeReq);
            const isSSL = !!ctx.isSSL;
            const protocol = isSSL ? 'wss' : 'ws';
            const reqUrl = upgradeReq.url || '';
            // 绝对 URL（经 HTTP 代理的 ws）或相对路径
            const fullUrl = /^wss?:\/\//i.test(reqUrl)
                ? reqUrl
                : `${protocol}://${host}${reqUrl}`;
            if (!this.shouldCaptureHost(host)) {
                console.log(`[ws] skip host: ${host}`);
                return callback();
            }
            console.log(`[ws] connect ${fullUrl}`);
            const startTime = Date.now();
            const wsPacket = {
                id: (0, uuid_1.v4)(),
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
                connectionId: (0, uuid_1.v4)(),
                state: 'connected'
            };
            this.pendingWebSockets.set(ctx, wsPacket);
            this.emit('websocket', { ...wsPacket, messages: [...wsPacket.messages] });
            this.packetManager?.addPacket(wsPacket);
            return callback();
        });
        proxy.onWebSocketSend((ctx, message, flags, callback) => {
            this.recordWsMessage(ctx, 'outgoing', message, flags);
            return callback(null, message, flags);
        });
        proxy.onWebSocketMessage((ctx, message, flags, callback) => {
            this.recordWsMessage(ctx, 'incoming', message, flags);
            return callback(null, message, flags);
        });
        proxy.onWebSocketFrame((ctx, type, fromServer, data, flags, callback) => {
            if (type === 'close') {
                const wsPacket = this.pendingWebSockets.get(ctx);
                if (wsPacket) {
                    wsPacket.state = 'disconnected';
                    this.emit('websocket', { ...wsPacket, messages: [...wsPacket.messages] });
                    this.pendingWebSockets.delete(ctx);
                }
            }
            else if (type === 'ping' || type === 'pong') {
                this.recordWsMessage(ctx, fromServer ? 'incoming' : 'outgoing', data, { opcode: type === 'ping' ? 0x9 : 0xA }, true);
            }
            return callback(null, data, flags);
        });
        proxy.onWebSocketError((ctx, err) => {
            console.error('[ws error]', err.message);
            const wsPacket = this.pendingWebSockets.get(ctx);
            if (wsPacket) {
                wsPacket.state = 'error';
                wsPacket.isError = true;
                wsPacket.errorMessage = err.message;
                wsPacket.messages.push({
                    id: (0, uuid_1.v4)(),
                    timestamp: Date.now(),
                    direction: 'incoming',
                    type: 'error',
                    content: err.message,
                    size: err.message.length
                });
                this.emit('websocket', { ...wsPacket, messages: [...wsPacket.messages] });
                this.pendingWebSockets.delete(ctx);
            }
        });
        proxy.onWebSocketClose((ctx, code, message, callback) => {
            const wsPacket = this.pendingWebSockets.get(ctx);
            if (wsPacket) {
                wsPacket.state = 'disconnected';
                wsPacket.closeCode = code;
                wsPacket.closeReason = typeof message === 'string' ? message : (message ? message.toString() : '');
                this.emit('websocket', { ...wsPacket, messages: [...wsPacket.messages] });
                this.pendingWebSockets.delete(ctx);
            }
            return callback(null, code, message);
        });
        return new Promise((resolve, reject) => {
            proxy.listen({
                port: this.config.port,
                host: '0.0.0.0',
                sslCaDir: this.sslCaDir,
                keepAlive: true,
                forceSNI: true
            }, (err) => {
                if (err) {
                    this.proxy = null;
                    this.isRunning = false;
                    console.error('Failed to start MITM proxy:', err);
                    reject(err);
                    return;
                }
                // listen 完成后 CA 已创建，立刻打补丁
                try {
                    (0, cert_utils_1.patchMitmCa)(proxy.ca);
                }
                catch (patchErr) {
                    console.error('[cert] patchMitmCa failed:', patchErr);
                }
                this.isRunning = true;
                console.log(`MITM proxy server running on 0.0.0.0:${this.config.port}`);
                resolve();
            });
        });
    }
    stop() {
        if (this.proxy) {
            try {
                this.proxy.close(() => {
                    console.log('Proxy server stopped');
                });
            }
            catch (e) {
                console.error('Error stopping proxy:', e);
            }
            this.proxy = null;
        }
        this.pendingWebSockets.clear();
        this.isRunning = false;
    }
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }
    getPort() {
        return this.config.port;
    }
    getCaDir() {
        return this.sslCaDir;
    }
    getCaCertPath() {
        return path.join(this.sslCaDir, 'certs', 'ca.pem');
    }
    resolveWsHost(ctx, upgradeReq) {
        const headerHost = upgradeReq.headers?.host || '';
        if (headerHost)
            return headerHost;
        // CONNECT 隧道场景：从 connectRequests / URL 推断
        const url = upgradeReq.url || '';
        if (/^wss?:\/\//i.test(url)) {
            try {
                return new URL(url).host;
            }
            catch {
                /* ignore */
            }
        }
        // http-mitm-proxy 在 CONNECT 后可能把目标放在 socket 上
        const auth = upgradeReq.headers?.[':authority'];
        if (auth)
            return auth;
        return ctx.clientToProxyRequest?.headers?.host || 'unknown';
    }
    recordWsMessage(ctx, direction, message, flags, isFrame = false) {
        const wsPacket = this.pendingWebSockets.get(ctx);
        if (!wsPacket)
            return;
        const isBinary = flags && (flags.binary || flags.opcode === 0x2);
        const opcode = flags?.opcode;
        let type = isBinary ? 'binary' : 'text';
        if (opcode === 0x8)
            type = 'close';
        else if (opcode === 0x9)
            type = 'ping';
        else if (opcode === 0xA)
            type = 'pong';
        let content = message;
        let size = 0;
        if (Buffer.isBuffer(message)) {
            content = isBinary ? message : message.toString('utf8');
            size = message.length;
        }
        else if (typeof message === 'string') {
            size = Buffer.byteLength(message);
        }
        else if (message && typeof message === 'object') {
            content = JSON.stringify(message);
            size = Buffer.byteLength(content);
        }
        const msg = {
            id: (0, uuid_1.v4)(),
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
    shouldCaptureHost(host) {
        const hostname = (host || '').split(':')[0].toLowerCase();
        if (!hostname || hostname === 'unknown')
            return true;
        if (this.matchesBypass(hostname)) {
            return false;
        }
        const localPatterns = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'];
        const isLocal = localPatterns.some(p => hostname === p || hostname.endsWith('.' + p));
        if (this.config.filterDomains && this.config.filterDomains.length > 0) {
            return this.config.filterDomains.some(d => hostname === d.toLowerCase() || hostname.endsWith('.' + d.toLowerCase()));
        }
        if (isLocal) {
            return this.config.enableLocalhost !== false;
        }
        return true;
    }
    matchesBypass(hostname) {
        const raw = this.config.bypassList || '';
        const rules = raw.split(/[;\n,\r]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
        for (const rule of rules) {
            if (rule === '<-loopback>' || rule === '<local>')
                continue;
            if (rule === hostname)
                return true;
            if (rule.startsWith('*.') && (hostname === rule.slice(2) || hostname.endsWith(rule.slice(1)))) {
                return true;
            }
            // 简单通配：把 * 转成正则
            if (rule.includes('*')) {
                const re = new RegExp('^' + rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
                if (re.test(hostname))
                    return true;
            }
        }
        return false;
    }
    normalizeHeaders(headers) {
        const result = {};
        if (!headers)
            return result;
        for (const [key, value] of Object.entries(headers)) {
            if (value === undefined || value === null)
                continue;
            result[key] = Array.isArray(value) ? value.join(', ') : String(value);
        }
        return result;
    }
    parseBody(body, contentType) {
        if (!body)
            return undefined;
        const ct = Array.isArray(contentType) ? contentType[0] : contentType || '';
        if (ct.includes('application/json') || body.trim().startsWith('{') || body.trim().startsWith('[')) {
            try {
                return JSON.parse(body);
            }
            catch {
                return body;
            }
        }
        return body;
    }
}
exports.ProxyServer = ProxyServer;
