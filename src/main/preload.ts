import { contextBridge, ipcRenderer } from 'electron';
import { ProxyConfig, Packet, ProxyFilter, ProxyStats, RewriteRule } from '../types';

contextBridge.exposeInMainWorld('electronAPI', {
  // Proxy control
  startProxy: (config: ProxyConfig) => ipcRenderer.invoke('proxy:start', config),
  stopProxy: () => ipcRenderer.invoke('proxy:stop'),
  getProxyStatus: () => ipcRenderer.invoke('proxy:status'),
  setProxyConfig: (config: Partial<ProxyConfig>) => ipcRenderer.invoke('proxy:set-config', config),
  getCaDir: () => ipcRenderer.invoke('proxy:get-ca-dir'),
  openCaDir: () => ipcRenderer.invoke('proxy:open-ca-dir'),
  installCa: () => ipcRenderer.invoke('proxy:install-ca'),
  getChromeHint: () => ipcRenderer.invoke('proxy:get-chrome-hint'),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  getLogInfo: () => ipcRenderer.invoke('app:get-log-info'),
  
  // Packet management
  getPackets: () => ipcRenderer.invoke('packets:get'),
  filterPackets: (filter: ProxyFilter) => ipcRenderer.invoke('packets:filter', filter),
  clearPackets: () => ipcRenderer.invoke('packets:clear'),
  
  // Rewrite rules management
  addRewriteRule: (rule: Omit<RewriteRule, 'id'>) => ipcRenderer.invoke('rewrite:add-rule', rule),
  updateRewriteRule: (id: string, updates: Partial<RewriteRule>) => ipcRenderer.invoke('rewrite:update-rule', id, updates),
  deleteRewriteRule: (id: string) => ipcRenderer.invoke('rewrite:delete-rule', id),
  getRewriteRules: () => ipcRenderer.invoke('rewrite:get-rules'),
  toggleRewriteRule: (id: string, enabled: boolean) => ipcRenderer.invoke('rewrite:toggle-rule', id, enabled),
  exportRewriteRules: () => ipcRenderer.invoke('rewrite:export-rules'),
  importRewriteRules: (rulesJson: string) => ipcRenderer.invoke('rewrite:import-rules', rulesJson),
  
  // Event listeners
  onNewPacket: (callback: (packet: Packet) => void) => {
    ipcRenderer.on('packet:new', (event, packet) => callback(packet));
  },
  onWebSocketPacket: (callback: (packet: any) => void) => {
    ipcRenderer.on('packet:websocket', (event, packet) => callback(packet));
  },
  onProxyError: (callback: (error: string) => void) => {
    ipcRenderer.on('proxy:error', (event, error) => callback(error));
  },
  
  // Remove listeners
  removeListener: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, callback);
  }
});

// Type definitions for the exposed API
declare global {
  interface Window {
    electronAPI: {
      startProxy: (config: ProxyConfig) => Promise<{ success: boolean; error?: string }>;
      stopProxy: () => Promise<{ success: boolean; error?: string }>;
      getProxyStatus: () => Promise<{ running: boolean; port: number }>;
      setProxyConfig: (config: Partial<ProxyConfig>) => Promise<{ success: boolean }>;
      getCaDir: () => Promise<{ success: boolean; caDir: string; caCertPath: string; hint: string }>;
      openCaDir: () => Promise<{ success: boolean; error?: string }>;
      installCa: () => Promise<{ success: boolean; error?: string; message?: string; caCertPath?: string }>;
      getChromeHint: () => Promise<{ success: boolean; hint: string; tip: string }>;
      openLogs: () => Promise<{ success: boolean; error?: string; logDir?: string; logFile?: string }>;
      getLogInfo: () => Promise<{ success: boolean; logDir: string; logFile: string }>;
      getPackets: () => Promise<Packet[]>;
      filterPackets: (filter: ProxyFilter) => Promise<Packet[]>;
      clearPackets: () => Promise<{ success: boolean; error?: string }>;
      addRewriteRule: (rule: Omit<RewriteRule, 'id'>) => Promise<{ success: boolean; error?: string; rule?: RewriteRule }>;
      updateRewriteRule: (id: string, updates: Partial<RewriteRule>) => Promise<{ success: boolean; error?: string; rule?: RewriteRule }>;
      deleteRewriteRule: (id: string) => Promise<{ success: boolean; error?: string; deleted?: boolean }>;
      getRewriteRules: () => Promise<{ success: boolean; error?: string; rules: RewriteRule[] }>;
      toggleRewriteRule: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string; toggled?: boolean }>;
      exportRewriteRules: () => Promise<{ success: boolean; error?: string; data: string }>;
      importRewriteRules: (rulesJson: string) => Promise<{ success: boolean; error?: string; imported: number }>;
      onNewPacket: (callback: (packet: Packet) => void) => void;
      onWebSocketPacket: (callback: (packet: any) => void) => void;
      onProxyError: (callback: (error: string) => void) => void;
      removeListener: (channel: string, callback: (...args: any[]) => void) => void;
    };
  }
}