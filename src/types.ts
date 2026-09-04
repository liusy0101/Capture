export interface ProxyConfig {
  port: number;
  enableHttps: boolean;
  enableLocalhost: boolean;
  /** 启动时自动设置 Windows 系统代理（默认 true） */
  autoSystemProxy?: boolean;
  /**
   * 代理绕过列表（ProxyOverride），分号/换行分隔。
   * 例：*.corp.com;10.*;*.local
   * 捕获本地时会自动附加 <-loopback>
   */
  bypassList?: string;
  filterDomains?: string[];
  sslCertPath?: string;
  sslKeyPath?: string;
  recordRequests: boolean;
  recordWebSocket: boolean;
  autoScroll: boolean;
}

export interface Packet {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  protocol: 'http' | 'https' | 'ws' | 'wss';
  status?: number;
  statusText?: string;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: any;
  responseBody?: any;
  duration?: number;
  size?: number;
  ip?: string;
  localPort?: number;
  remotePort?: number;
  isError?: boolean;
  errorMessage?: string;
}

export interface WebSocketPacket extends Packet {
  protocol: 'ws' | 'wss';
  messages: WebSocketMessage[];
  connectionId: string;
  state: 'connecting' | 'connected' | 'disconnected' | 'error';
  closeReason?: string;
  closeCode?: number;
}

export interface WebSocketMessage {
  id: string;
  timestamp: number;
  direction: 'incoming' | 'outgoing';
  type: 'text' | 'binary' | 'ping' | 'pong' | 'close' | 'error';
  content?: any;
  size: number;
  isMasked?: boolean;
  opcode?: number;
}

export interface ProxyFilter {
  search?: string;
  protocols?: ('http' | 'https' | 'ws' | 'wss')[];
  methods?: string[];
  statusCodes?: number[];
  domains?: string[];
  hasError?: boolean;
  startTime?: number;
  endTime?: number;
}

export interface ProxyStats {
  totalRequests: number;
  totalWebSocketConnections: number;
  totalMessages: number;
  failedRequests: number;
  averageDuration: number;
  totalDataTransferred: number;
}

/**
 * 重写规则（Charles Rewrite 风格）
 * - 匹配条件：决定命中哪些请求（主要按 URL）
 * - 操作：对命中请求执行的改写（Header / Query / URL / Body / 重定向）
 */
export interface RewriteRule {
  id: string;
  name: string;
  enabled: boolean;
  /** @deprecated 兼容旧数据；新规则固定按 URL 匹配 */
  matchType: 'url' | 'method' | 'header' | 'body' | 'response-header' | 'response-body';
  /** URL 匹配模式（包含/正则等） */
  matchPattern: string;
  matchOperator: 'contains' | 'equals' | 'regex' | 'starts-with' | 'ends-with';
  /** 可选：限定 HTTP 方法，空或 * 表示全部 */
  matchMethod?: string;
  /**
   * 操作类型
   * - replace-url / replace-host / replace-path
   * - add-query / replace-query / remove-query
   * - add-header / replace-header / remove-header
   * - replace-body / redirect
   * 旧值 replace|add|remove|modify|redirect 仍兼容
   */
  actionType:
    | 'replace-url'
    | 'replace-host'
    | 'replace-path'
    | 'add-query'
    | 'replace-query'
    | 'remove-query'
    | 'add-header'
    | 'replace-header'
    | 'remove-header'
    | 'replace-body'
    | 'redirect'
    | 'replace'
    | 'add'
    | 'remove'
    | 'modify';
  /** Header 名 / Query 参数名；URL 替换时可空 */
  actionTarget?: string;
  /** 新值；remove-* 可空；replace-url 可为带 $1 的替换串 */
  actionValue: string;
  applyTo: 'request' | 'response' | 'both';
  priority: number;
  description?: string;
}

export interface RewriteAction {
  type: 'url' | 'header' | 'query' | 'body' | 'status' | 'redirect';
  target: string;
  value: string;
  operation: 'replace' | 'add' | 'remove' | 'modify';
}

export interface RewriteResult {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  modifications: RewriteAction[];
  originalValue?: string;
  newValue?: string;
}