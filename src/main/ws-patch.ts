/**
 * http-mitm-proxy 创建上游 WebSocket 时调用：
 *   new WebSocket(url, options)
 * 把 options 当成第二参后，protocols 恒为空数组。
 * 即便 headers 里带了 Sec-WebSocket-Protocol，ws 也不会记入 protocolSet，
 * 上游一旦回了子协议就会报：
 *   Server sent a subprotocol but none was requested
 *
 * 在加载 http-mitm-proxy 之前调用本函数，把 header 中的子协议提升为构造参数。
 */
export function patchWsSubprotocolFromHeaders(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const wsPath = require.resolve('ws');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const OriginalWS = require(wsPath) as any;
  if (OriginalWS.__capturePatched) return;

  function CaptureWebSocket(address: any, protocols?: any, options?: any) {
    // WebSocketServer 内部会 `new WebSocket(null)` 再挂 socket
    if (address === null || address === undefined) {
      return new OriginalWS(address, protocols, options);
    }

    let prots = protocols;
    let opts = options;
    if (prots !== undefined && !Array.isArray(prots) && typeof prots === 'object') {
      opts = prots;
      prots = [];
    }
    opts = opts ? { ...opts } : {};
    const headers = { ...(opts.headers || {}) };

    const protoHeader =
      headers['Sec-WebSocket-Protocol'] || headers['sec-websocket-protocol'];
    const needLift =
      (!prots || (Array.isArray(prots) && prots.length === 0)) && !!protoHeader;

    if (needLift) {
      prots = String(protoHeader)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      delete headers['Sec-WebSocket-Protocol'];
      delete headers['sec-websocket-protocol'];
      opts.headers = headers;
    }

    return new OriginalWS(address, prots || [], opts);
  }

  Object.setPrototypeOf(CaptureWebSocket, OriginalWS);
  CaptureWebSocket.prototype = OriginalWS.prototype;
  for (const key of Reflect.ownKeys(OriginalWS)) {
    if (key === 'prototype' || key === 'name' || key === 'length' || key === 'caller' || key === 'arguments') {
      continue;
    }
    try {
      const desc = Object.getOwnPropertyDescriptor(OriginalWS, key);
      if (desc) Object.defineProperty(CaptureWebSocket, key, desc);
    } catch {
      try {
        (CaptureWebSocket as any)[key] = OriginalWS[key];
      } catch {
        /* ignore */
      }
    }
  }

  CaptureWebSocket.__capturePatched = true;
  CaptureWebSocket.WebSocket = CaptureWebSocket;
  CaptureWebSocket.default = CaptureWebSocket;

  const cached = require.cache[wsPath];
  if (cached) {
    cached.exports = CaptureWebSocket;
  }

  // 若 http-mitm-proxy 已加载，清掉缓存以便下次拿到 patched ws
  for (const key of Object.keys(require.cache)) {
    if (key.replace(/\\/g, '/').includes('/http-mitm-proxy/')) {
      delete require.cache[key];
    }
  }

  console.log('[ws] patched: Sec-WebSocket-Protocol header → constructor protocols');
}
