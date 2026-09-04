import { EventEmitter } from 'eventemitter3';
import { RewriteRule, RewriteAction, RewriteResult } from '../types';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export class RewriteManager extends EventEmitter {
  private rules: Map<string, RewriteRule> = new Map();
  private activeRules: RewriteRule[] = [];
  private storagePath: string;

  constructor(userDataPath?: string) {
    super();
    // 设置存储路径，优先使用传入的路径，否则使用app的userData路径
    const basePath = userDataPath || (app ? app.getPath('userData') : path.join(process.cwd(), 'data'));
    this.storagePath = path.join(basePath, 'rewrite-rules.json');
    this.loadRules();
  }

  addRule(rule: Omit<RewriteRule, 'id'>): RewriteRule {
    const newRule: RewriteRule = {
      ...rule,
      id: uuidv4()
    };
    
    this.rules.set(newRule.id, newRule);
    this.updateActiveRules();
    this.emit('rule:added', newRule);
    this.saveRules();
    
    return newRule;
  }

  updateRule(id: string, updates: Partial<RewriteRule>): RewriteRule | null {
    const rule = this.rules.get(id);
    if (!rule) return null;

    const updatedRule = { ...rule, ...updates };
    this.rules.set(id, updatedRule);
    this.updateActiveRules();
    this.emit('rule:updated', updatedRule);
    this.saveRules();
    
    return updatedRule;
  }

  deleteRule(id: string): boolean {
    const deleted = this.rules.delete(id);
    if (deleted) {
      this.updateActiveRules();
      this.emit('rule:deleted', id);
      this.saveRules();
    }
    return deleted;
  }

  getRule(id: string): RewriteRule | undefined {
    return this.rules.get(id);
  }

  getAllRules(): RewriteRule[] {
    return Array.from(this.rules.values()).sort((a, b) => a.priority - b.priority);
  }

  getActiveRules(): RewriteRule[] {
    return this.activeRules;
  }

  toggleRule(id: string, enabled: boolean): boolean {
    const rule = this.rules.get(id);
    if (!rule) return false;

    rule.enabled = enabled;
    this.updateActiveRules();
    this.emit('rule:toggled', { id, enabled });
    this.saveRules();
    
    return true;
  }

  applyRequestRewrite(url: string, method: string, headers: Record<string, string>, body?: any): {
    modifiedUrl: string;
    modifiedHeaders: Record<string, string>;
    modifiedBody: any;
    results: RewriteResult[];
    shouldRedirect: boolean;
    redirectUrl?: string;
  } {
    let modifiedUrl = url;
    let modifiedHeaders = { ...headers };
    let modifiedBody = body;
    const results: RewriteResult[] = [];
    let shouldRedirect = false;
    let redirectUrl: string | undefined;

    for (const rule of this.activeRules) {
      if (rule.applyTo !== 'request' && rule.applyTo !== 'both') continue;

      const result = this.applyRule(rule, {
        url: modifiedUrl,
        method,
        headers: modifiedHeaders,
        body: modifiedBody
      });

      if (!result.matched || result.modifications.length === 0) continue;
      results.push(result);

      for (const action of result.modifications) {
        switch (action.type) {
          case 'url':
            if (action.operation === 'replace') {
              modifiedUrl = action.value || modifiedUrl;
            }
            break;
          case 'header':
            this.applyHeaderAction(modifiedHeaders, action);
            break;
          case 'query':
            modifiedUrl = this.applyQueryAction(modifiedUrl, action);
            break;
          case 'body':
            if (action.operation === 'replace') {
              modifiedBody = action.value;
            }
            break;
          case 'redirect':
            shouldRedirect = true;
            redirectUrl = action.value;
            break;
        }
      }
    }

    return {
      modifiedUrl,
      modifiedHeaders,
      modifiedBody,
      results,
      shouldRedirect,
      redirectUrl
    };
  }

  applyResponseRewrite(
    statusCode: number,
    headers: Record<string, string>,
    body?: any,
    requestUrl?: string
  ): {
    modifiedStatusCode: number;
    modifiedHeaders: Record<string, string>;
    modifiedBody: any;
    results: RewriteResult[];
  } {
    let modifiedStatusCode = statusCode;
    let modifiedHeaders = { ...headers };
    let modifiedBody = body;
    const results: RewriteResult[] = [];

    for (const rule of this.activeRules) {
      if (rule.applyTo !== 'response' && rule.applyTo !== 'both') continue;

      const result = this.applyRule(rule, {
        url: requestUrl || '',
        method: '',
        headers: modifiedHeaders,
        body: modifiedBody,
        statusCode: modifiedStatusCode.toString()
      });

      if (!result.matched || result.modifications.length === 0) continue;
      results.push(result);

      for (const action of result.modifications) {
        switch (action.type) {
          case 'header':
            this.applyHeaderAction(modifiedHeaders, action);
            break;
          case 'body':
            if (action.operation === 'replace') {
              modifiedBody = action.value;
            }
            break;
          case 'status':
            modifiedStatusCode = parseInt(action.value, 10) || modifiedStatusCode;
            break;
        }
      }
    }

    return {
      modifiedStatusCode,
      modifiedHeaders,
      modifiedBody,
      results
    };
  }

  /**
   * 1) 用 URL（+ 可选 Method）判断是否命中
   * 2) 命中后再按 actionType 生成改写动作
   */
  private applyRule(rule: RewriteRule, context: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: any;
    statusCode?: string;
  }): RewriteResult {
    const modifications: RewriteAction[] = [];
    const url = context.url || '';
    const methodOk = this.matchMethod(context.method, rule.matchMethod);

    // 始终按 URL 匹配请求（旧数据若 matchType=method 仍兼容）
    let matched = false;
    if (rule.matchType === 'method') {
      matched = methodOk && this.matchPattern(context.method, rule.matchPattern, rule.matchOperator);
    } else {
      matched = methodOk && this.matchPattern(url, rule.matchPattern, rule.matchOperator);
    }

    if (!matched) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        matched: false,
        modifications: []
      };
    }

    const actionType = this.normalizeActionType(rule);
    let newValue: string | undefined;
    let originalValue: string | undefined = url;

    switch (actionType) {
      case 'replace-url': {
        newValue = this.applyReplace(url, rule.matchPattern, rule.actionValue, rule.matchOperator);
        modifications.push({
          type: 'url',
          target: url,
          value: newValue,
          operation: 'replace'
        });
        break;
      }
      case 'replace-host': {
        try {
          const u = new URL(url);
          originalValue = u.host;
          u.host = rule.actionValue;
          newValue = u.toString();
          modifications.push({ type: 'url', target: 'host', value: newValue, operation: 'replace' });
        } catch {
          /* ignore invalid url */
        }
        break;
      }
      case 'replace-path': {
        try {
          const u = new URL(url);
          originalValue = u.pathname;
          u.pathname = rule.actionValue.startsWith('/') ? rule.actionValue : `/${rule.actionValue}`;
          newValue = u.toString();
          modifications.push({ type: 'url', target: 'path', value: newValue, operation: 'replace' });
        } catch {
          /* ignore */
        }
        break;
      }
      case 'add-query':
        modifications.push({
          type: 'query',
          target: rule.actionTarget || '',
          value: rule.actionValue,
          operation: 'add'
        });
        break;
      case 'replace-query':
        modifications.push({
          type: 'query',
          target: rule.actionTarget || '',
          value: rule.actionValue,
          operation: 'replace'
        });
        break;
      case 'remove-query':
        modifications.push({
          type: 'query',
          target: rule.actionTarget || '',
          value: '',
          operation: 'remove'
        });
        break;
      case 'add-header':
        modifications.push({
          type: 'header',
          target: rule.actionTarget || '',
          value: rule.actionValue,
          operation: 'add'
        });
        break;
      case 'replace-header':
        modifications.push({
          type: 'header',
          target: rule.actionTarget || '',
          value: rule.actionValue,
          operation: 'replace'
        });
        break;
      case 'remove-header':
        modifications.push({
          type: 'header',
          target: rule.actionTarget || '',
          value: '',
          operation: 'remove'
        });
        break;
      case 'replace-body': {
        const bodyStr =
          typeof context.body === 'string'
            ? context.body
            : context.body != null
              ? JSON.stringify(context.body)
              : '';
        originalValue = bodyStr;
        newValue = rule.actionValue;
        modifications.push({
          type: 'body',
          target: '',
          value: rule.actionValue,
          operation: 'replace'
        });
        break;
      }
      case 'redirect':
        newValue = rule.actionValue;
        modifications.push({
          type: 'redirect',
          target: url,
          value: rule.actionValue,
          operation: 'replace'
        });
        break;
    }

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      matched: true,
      modifications,
      originalValue,
      newValue
    };
  }

  /** 旧版 actionType 映射到新语义 */
  private normalizeActionType(rule: RewriteRule): string {
    const t = rule.actionType;
    if (
      t === 'replace-url' ||
      t === 'replace-host' ||
      t === 'replace-path' ||
      t === 'add-query' ||
      t === 'replace-query' ||
      t === 'remove-query' ||
      t === 'add-header' ||
      t === 'replace-header' ||
      t === 'remove-header' ||
      t === 'replace-body' ||
      t === 'redirect'
    ) {
      return t;
    }
    // 兼容旧数据
    if (t === 'add') return 'add-header';
    if (t === 'remove') return 'remove-header';
    if (t === 'modify') return 'replace-header';
    if (t === 'replace') {
      if (rule.matchType === 'header' || rule.matchType === 'response-header') return 'replace-header';
      if (rule.matchType === 'body' || rule.matchType === 'response-body') return 'replace-body';
      return 'replace-url';
    }
    return 'replace-url';
  }

  private matchMethod(method: string, ruleMethod?: string): boolean {
    if (!ruleMethod || ruleMethod === '*' || ruleMethod.toUpperCase() === 'ANY') return true;
    return method.toUpperCase() === ruleMethod.toUpperCase();
  }

  private applyQueryAction(url: string, action: RewriteAction): string {
    try {
      const u = new URL(url);
      const key = action.target;
      if (!key) return url;
      if (action.operation === 'remove') {
        u.searchParams.delete(key);
      } else if (action.operation === 'add') {
        if (!u.searchParams.has(key)) u.searchParams.set(key, action.value);
      } else {
        u.searchParams.set(key, action.value);
      }
      return u.toString();
    } catch {
      return url;
    }
  }

  private matchPattern(target: string, pattern: string, operator: string): boolean {
    if (!pattern) return true;
    switch (operator) {
      case 'contains':
        return target.toLowerCase().includes(pattern.toLowerCase());
      case 'equals':
        return target.toLowerCase() === pattern.toLowerCase();
      case 'regex':
        try {
          return new RegExp(pattern, 'i').test(target);
        } catch (e) {
          console.error('Invalid regex pattern:', pattern);
          return false;
        }
      case 'starts-with':
        return target.toLowerCase().startsWith(pattern.toLowerCase());
      case 'ends-with':
        return target.toLowerCase().endsWith(pattern.toLowerCase());
      default:
        return false;
    }
  }

  private applyReplace(target: string, pattern: string, replacement: string, operator: string = 'regex'): string {
    try {
      switch (operator) {
        case 'contains':
        case 'equals': {
          const regex = new RegExp(this.escapeRegex(pattern), 'gi');
          return target.replace(regex, replacement);
        }
        case 'regex':
          return target.replace(new RegExp(pattern, 'gi'), replacement);
        case 'starts-with':
          if (target.toLowerCase().startsWith(pattern.toLowerCase())) {
            return replacement + target.substring(pattern.length);
          }
          return target;
        case 'ends-with':
          if (target.toLowerCase().endsWith(pattern.toLowerCase())) {
            return target.substring(0, target.length - pattern.length) + replacement;
          }
          return target;
        default:
          return target;
      }
    } catch (e) {
      console.error('Error applying replace:', e);
      return target;
    }
  }

  private applyModification(target: string, modification: string): string {
    try {
      if (modification.startsWith('value.')) {
        // eslint-disable-next-line no-new-func
        const func = new Function('value', `return ${modification}`);
        return func(target);
      }
      return modification;
    } catch (e) {
      console.error('Error applying modification:', e);
      return target;
    }
  }

  private applyHeaderAction(headers: Record<string, string>, action: RewriteAction): void {
    const headerName = (action.target || '').toLowerCase();
    if (!headerName) return;

    switch (action.operation) {
      case 'replace':
      case 'modify':
        headers[headerName] = action.value;
        break;
      case 'add':
        if (headers[headerName] === undefined) {
          headers[headerName] = action.value;
        }
        break;
      case 'remove':
        delete headers[headerName];
        break;
    }
  }

  private getModificationType(_matchType: string): RewriteAction['type'] {
    return 'url';
  }

  private escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private updateActiveRules(): void {
    this.activeRules = this.getAllRules()
      .filter((rule) => rule.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  private saveRules(): void {
    try {
      const rules = Array.from(this.rules.values());
      const dir = path.dirname(this.storagePath);
      
      // 确保目录存在
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(this.storagePath, JSON.stringify(rules, null, 2), 'utf8');
    } catch (e) {
      console.error('Error saving rewrite rules:', e);
    }
  }

  private loadRules(): void {
    try {
      if (fs.existsSync(this.storagePath)) {
        const saved = fs.readFileSync(this.storagePath, 'utf8');
        const rules = JSON.parse(saved) as RewriteRule[];
        rules.forEach(rule => {
          this.rules.set(rule.id, rule);
        });
        this.updateActiveRules();
      }
      
      // Add some default rules for demo
      if (this.rules.size === 0) {
        this.addDefaultRules();
      }
    } catch (e) {
      console.error('Error loading rewrite rules:', e);
      this.addDefaultRules();
    }
  }

  private addDefaultRules(): void {
    this.addRule({
      name: '示例：替换 API 域名',
      enabled: false,
      matchType: 'url',
      matchPattern: 'api.example.com',
      matchOperator: 'contains',
      matchMethod: '*',
      actionType: 'replace-url',
      actionValue: 'api.local.dev',
      applyTo: 'request',
      priority: 50,
      description: 'URL 包含 api.example.com 时替换为本地域名'
    });

    this.addRule({
      name: '示例：增加 CORS 头',
      enabled: false,
      matchType: 'url',
      matchPattern: '.*',
      matchOperator: 'regex',
      matchMethod: '*',
      actionType: 'add-header',
      actionTarget: 'Access-Control-Allow-Origin',
      actionValue: '*',
      applyTo: 'response',
      priority: 100,
      description: '匹配任意 URL 的响应，增加 CORS 头'
    });
  }

  exportRules(): string {
    return JSON.stringify(Array.from(this.rules.values()), null, 2);
  }

  importRules(rulesJson: string): number {
    try {
      const rules = JSON.parse(rulesJson) as RewriteRule[];
      let imported = 0;
      
      rules.forEach(rule => {
        if (rule.id && rule.name) {
          // Update existing or add new
          if (this.rules.has(rule.id)) {
            this.rules.set(rule.id, rule);
          } else {
            this.rules.set(rule.id, rule);
          }
          imported++;
        }
      });
      
      this.updateActiveRules();
      this.saveRules();
      this.emit('rules:imported', imported);
      
      return imported;
    } catch (e) {
      console.error('Error importing rules:', e);
      return 0;
    }
  }

  clearAllRules(): void {
    this.rules.clear();
    this.updateActiveRules();
    this.saveRules();
    this.emit('rules:cleared');
  }
}