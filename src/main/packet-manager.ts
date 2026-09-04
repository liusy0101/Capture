import { EventEmitter } from 'eventemitter3';
import { Packet, WebSocketPacket, ProxyFilter, ProxyStats } from '../types';

export class PacketManager extends EventEmitter {
  private packets: Map<string, Packet> = new Map();
  private maxPackets: number = 1000;
  private stats: ProxyStats = {
    totalRequests: 0,
    totalWebSocketConnections: 0,
    totalMessages: 0,
    failedRequests: 0,
    averageDuration: 0,
    totalDataTransferred: 0
  };

  constructor() {
    super();
  }

  addPacket(packet: Packet): void {
    // Limit total packets to prevent memory issues
    if (this.packets.size >= this.maxPackets) {
      const oldestKey = this.packets.keys().next().value;
      if (oldestKey) {
        this.packets.delete(oldestKey);
      }
    }

    this.packets.set(packet.id, packet);
    this.updateStats(packet);
    this.emit('packet:added', packet);
  }

  getPacket(id: string): Packet | undefined {
    return this.packets.get(id);
  }

  getPackets(): Packet[] {
    return Array.from(this.packets.values());
  }

  filterPackets(filter: ProxyFilter): Packet[] {
    let filtered = Array.from(this.packets.values());

    if (filter.search) {
      const searchTerm = filter.search.toLowerCase();
      filtered = filtered.filter(packet =>
        packet.url.toLowerCase().includes(searchTerm) ||
        packet.method.toLowerCase().includes(searchTerm) ||
        JSON.stringify(packet.requestHeaders).toLowerCase().includes(searchTerm) ||
        JSON.stringify(packet.responseHeaders || {}).toLowerCase().includes(searchTerm)
      );
    }

    if (filter.protocols && filter.protocols.length > 0) {
      filtered = filtered.filter(packet => filter.protocols!.includes(packet.protocol as any));
    }

    if (filter.methods && filter.methods.length > 0) {
      filtered = filtered.filter(packet => filter.methods!.includes(packet.method));
    }

    if (filter.statusCodes && filter.statusCodes.length > 0) {
      filtered = filtered.filter(packet =>
        packet.status !== undefined && filter.statusCodes!.includes(packet.status)
      );
    }

    if (filter.domains && filter.domains.length > 0) {
      filtered = filtered.filter(packet => {
        try {
          const hostname = new URL(packet.url).hostname;
          return filter.domains!.some(domain =>
            hostname === domain || hostname.endsWith('.' + domain)
          );
        } catch {
          return false;
        }
      });
    }

    if (filter.hasError !== undefined) {
      filtered = filtered.filter(packet => packet.isError === filter.hasError);
    }

    if (filter.startTime) {
      filtered = filtered.filter(packet => packet.timestamp >= filter.startTime!);
    }

    if (filter.endTime) {
      filtered = filtered.filter(packet => packet.timestamp <= filter.endTime!);
    }

    return filtered.sort((a, b) => b.timestamp - a.timestamp);
  }

  getWebSocketPackets(): WebSocketPacket[] {
    return this.getPackets().filter(packet => 
      packet.protocol === 'ws' || packet.protocol === 'wss'
    ) as WebSocketPacket[];
  }

  getWebSocketConnection(connectionId: string): WebSocketPacket | undefined {
    return this.getWebSocketPackets().find(packet => packet.connectionId === connectionId);
  }

  getWebSocketMessages(connectionId: string): any[] {
    const packet = this.getWebSocketConnection(connectionId);
    return packet?.messages || [];
  }

  updatePacket(id: string, updates: Partial<Packet>): boolean {
    const packet = this.packets.get(id);
    if (packet) {
      Object.assign(packet, updates);
      this.emit('packet:updated', packet);
      return true;
    }
    return false;
  }

  deletePacket(id: string): boolean {
    const deleted = this.packets.delete(id);
    if (deleted) {
      this.emit('packet:deleted', id);
    }
    return deleted;
  }

  clear(): void {
    this.packets.clear();
    this.resetStats();
    this.emit('packets:cleared');
  }

  getStats(): ProxyStats {
    return { ...this.stats };
  }

  private updateStats(packet: Packet): void {
    this.stats.totalRequests++;

    if (packet.isError) {
      this.stats.failedRequests++;
    }

    if (packet.protocol === 'ws' || packet.protocol === 'wss') {
      this.stats.totalWebSocketConnections++;
      const wsPacket = packet as WebSocketPacket;
      this.stats.totalMessages += wsPacket.messages.length;
    }

    if (packet.size) {
      this.stats.totalDataTransferred += packet.size;
    }

    if (packet.duration) {
      // Update average duration
      const totalDuration = this.stats.averageDuration * (this.stats.totalRequests - 1) + packet.duration;
      this.stats.averageDuration = totalDuration / this.stats.totalRequests;
    }

    this.emit('stats:updated', this.stats);
  }

  private resetStats(): void {
    this.stats = {
      totalRequests: 0,
      totalWebSocketConnections: 0,
      totalMessages: 0,
      failedRequests: 0,
      averageDuration: 0,
      totalDataTransferred: 0
    };
  }

  setMaxPackets(max: number): void {
    this.maxPackets = max;
    // Trim existing packets if needed
    while (this.packets.size > this.maxPackets) {
      const oldestKey = this.packets.keys().next().value;
      if (oldestKey) {
        this.packets.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  exportPackets(format: 'json' | 'csv' = 'json'): string {
    const packets = this.getPackets();

    if (format === 'json') {
      return JSON.stringify(packets, null, 2);
    } else {
      // CSV format
      if (packets.length === 0) return '';
      
      const headers = Object.keys(packets[0]).join(',');
      const rows = packets.map(packet => 
        Object.values(packet).map(value => 
          typeof value === 'object' ? JSON.stringify(value).replace(/"/g, '""') : value
        ).join(',')
      );
      
      return [headers, ...rows].join('\n');
    }
  }

  importPackets(data: string, format: 'json' | 'csv' = 'json'): number {
    let imported = 0;

    try {
      if (format === 'json') {
        const packets = JSON.parse(data) as Packet[];
        packets.forEach(packet => {
          if (packet.id) {
            this.packets.set(packet.id, packet);
            imported++;
          }
        });
      } else {
        // CSV import (simplified)
        const lines = data.split('\n');
        if (lines.length > 1) {
          const headers = lines[0].split(',');
          for (let i = 1; i < lines.length; i++) {
            try {
              const values = lines[i].split(',');
              const packet: any = {};
              headers.forEach((header, index) => {
                packet[header] = values[index];
              });
              
              if (packet.id) {
                this.packets.set(packet.id, packet);
                imported++;
              }
            } catch (error) {
              console.error('Error importing CSV row:', error);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error importing packets:', error);
    }

    return imported;
  }
}