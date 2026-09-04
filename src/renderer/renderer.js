class ProxyApp {
    constructor() {
        this.isRunning = false;
        this.currentFilter = 'all';
        this.searchTerm = '';
        this.packets = [];
        this.selectedPacket = null;
        this.autoScroll = true;
        this.rewriteRules = [];
        this.bodyPlainText = '';
        this.bodySearchMatches = [];
        this.bodySearchIndex = -1;
        this.bodySearchKind = 'response';
        this.ctxPacketId = null;
        this._searchTimer = null;
        this._listRenderQueued = false;
        this._listBound = false;
        this.config = {
            port: 8080,
            enableHttps: true,
            enableLocalhost: true,
            autoSystemProxy: true,
            bypassList: '',
            recordRequests: true,
            recordWebSocket: true,
            autoScroll: true
        };

        this.init();
    }

    init() {
        this.bindEvents();
        this.setupEventListeners();
        this.updateUI();
        this.loadSavedConfig();
        this.loadRewriteRules();
    }

    bindEvents() {
        // Proxy controls
        document.getElementById('startBtn').addEventListener('click', () => this.startProxy());
        document.getElementById('stopBtn').addEventListener('click', () => this.stopProxy());
        document.getElementById('clearBtn').addEventListener('click', () => this.clearPackets());
        document.getElementById('certBtn').addEventListener('click', () => {
            this.closeToolbarMore();
            this.installCertificate();
        });
        document.getElementById('configBtn').addEventListener('click', () => {
            this.closeToolbarMore();
            this.showConfigModal();
        });
        const copyChromeHintBtn = document.getElementById('copyChromeHintBtn');
        if (copyChromeHintBtn) {
            copyChromeHintBtn.addEventListener('click', () => {
                this.closeToolbarMore();
                this.copyChromeHint();
            });
        }
        const openLogsBtn = document.getElementById('openLogsBtn');
        if (openLogsBtn) {
            openLogsBtn.addEventListener('click', () => {
                this.closeToolbarMore();
                this.openLogs();
            });
        }
        const rewriteBtn = document.getElementById('rewriteBtn');
        if (rewriteBtn) {
            rewriteBtn.addEventListener('click', () => {
                this.closeToolbarMore();
                this.showRewriteManager();
            });
        }
        // 点击页面其它区域时收起「更多」菜单
        document.addEventListener('click', (e) => {
            const more = document.getElementById('toolbarMore');
            if (more && more.open && !more.contains(e.target)) {
                more.open = false;
            }
        });

        // Filter chips
        document.querySelectorAll('.filter-chip').forEach(chip => {
            chip.addEventListener('click', () => this.setFilter(chip.dataset.filter));
        });

        // Tabs
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        // Search（防抖，避免每个按键都全量重绘）
        document.getElementById('searchBox').addEventListener('input', (e) => {
            this.filterPackets(e.target.value);
        });

        // 请求列表事件委托（只绑一次，避免每次重绘重复 addEventListener）
        const packetList = document.getElementById('packetList');
        if (packetList && !this._listBound) {
            this._listBound = true;
            packetList.addEventListener('click', (e) => {
                const curlBtn = e.target.closest('.packet-curl-btn');
                if (curlBtn) {
                    e.stopPropagation();
                    const packet = this.packets.find((p) => p.id === curlBtn.dataset.curlId);
                    if (packet) this.copyPacketAsCurl(packet);
                    return;
                }
                const item = e.target.closest('.packet-item');
                if (item?.dataset.packetId) this.selectPacket(item.dataset.packetId);
            });
            packetList.addEventListener('contextmenu', (e) => {
                const item = e.target.closest('.packet-item');
                if (!item?.dataset.packetId) return;
                e.preventDefault();
                this.selectPacket(item.dataset.packetId);
                this.showPacketCtxMenu(e.clientX, e.clientY, item.dataset.packetId);
            });
        }

        // Config modal
        document.getElementById('closeConfig').addEventListener('click', () => this.hideConfigModal());
        document.getElementById('cancelConfig').addEventListener('click', () => this.hideConfigModal());
        document.getElementById('saveConfig').addEventListener('click', () => this.saveConfig());

        // Rewrite modal
        const closeRewriteModal = document.getElementById('closeRewriteModal');
        const closeRewriteModalBtn = document.getElementById('closeRewriteModalBtn');
        if (closeRewriteModal) closeRewriteModal.addEventListener('click', () => this.hideRewriteManager());
        if (closeRewriteModalBtn) closeRewriteModalBtn.addEventListener('click', () => this.hideRewriteManager());

        // Rewrite rules
        document.getElementById('addRewriteRuleBtn').addEventListener('click', () => this.showAddRewriteRuleModal());
        document.getElementById('exportRewriteRulesBtn').addEventListener('click', () => this.exportRewriteRules());
        document.getElementById('importRewriteRulesBtn').addEventListener('click', () => this.importRewriteRules());

        // Ctrl/Cmd+F：在请求体/响应体中搜索
        document.addEventListener('keydown', (e) => {
            const isFind = (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'f' || e.key === 'F');
            if (!isFind) return;
            const activeTab = document.querySelector('.tab.active')?.dataset?.tab;
            if (activeTab !== 'response' && activeTab !== 'request') return;
            const input = document.getElementById('bodySearchInput');
            if (!input) return;
            e.preventDefault();
            input.focus();
            input.select();
        });

        // 请求列表右键菜单
        const ctxMenu = document.getElementById('packetCtxMenu');
        if (ctxMenu) {
            ctxMenu.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-action]');
                if (!btn || !this.ctxPacketId) return;
                const packet = this.packets.find((p) => p.id === this.ctxPacketId);
                this.hidePacketCtxMenu();
                if (!packet) return;
                if (btn.dataset.action === 'curl') this.copyPacketAsCurl(packet);
                if (btn.dataset.action === 'copy-url') this.copyText(packet.url, 'URL 已复制');
            });
        }
        document.addEventListener('click', () => this.hidePacketCtxMenu());
        document.addEventListener('contextmenu', (e) => {
            if (!e.target.closest('#packetCtxMenu')) this.hidePacketCtxMenu();
        });
    }

    setupEventListeners() {
        // Listen for new packets（已停止则丢弃迟到事件）
        window.electronAPI.onNewPacket((packet) => {
            if (!this.isRunning) return;
            this.addPacket(packet);
        });

        // Listen for WebSocket packets
        window.electronAPI.onWebSocketPacket((packet) => {
            if (!this.isRunning) return;
            this.updateWebSocketPacket(packet);
        });

        // Listen for proxy errors
        window.electronAPI.onProxyError((error) => {
            this.showError(error);
        });
    }

    async loadSavedConfig() {
        try {
            // Load config from localStorage if available
            const savedConfig = localStorage.getItem('proxyConfig');
            if (savedConfig) {
                this.config = { ...this.config, ...JSON.parse(savedConfig) };
            }
            
            // Update config modal values
            document.getElementById('configPort').value = this.config.port;
            document.getElementById('configEnableHttps').checked = this.config.enableHttps;
            document.getElementById('configEnableLocalhost').checked = this.config.enableLocalhost;
            const autoProxyEl = document.getElementById('configAutoSystemProxy');
            if (autoProxyEl) autoProxyEl.checked = this.config.autoSystemProxy !== false;
            const bypassEl = document.getElementById('configBypassList');
            if (bypassEl) bypassEl.value = this.config.bypassList || '';
            document.getElementById('configRecordWebSocket').checked = this.config.recordWebSocket;
            document.getElementById('configRecordRequests').checked = this.config.recordRequests;
            
            this.updateUI();
        } catch (error) {
            console.error('Error loading config:', error);
        }
    }

    async startProxy() {
        try {
            const result = await window.electronAPI.startProxy(this.config);
            if (result.success) {
                this.isRunning = true;
                this.updateUI();
                const proxyHint = result.systemProxy
                    ? '系统代理已自动开启'
                    : '请手动将浏览器代理设为 127.0.0.1:' + this.config.port;
                this.showStatus('代理已启动（' + proxyHint + '）', 'success');
                this.showCaptureTips(result.chromeHint);
            } else {
                this.showError('启动失败: ' + result.error);
            }
        } catch (error) {
            this.showError('启动失败: ' + error.message);
        }
    }

    showCaptureTips(chromeHint) {
        const tipEl = document.getElementById('captureTips');
        if (!tipEl) return;
        tipEl.style.display = 'block';
        tipEl.classList.add('collapsed');
        tipEl.innerHTML = `
            <div class="capture-tips-header">
              <strong>抓包提示</strong>
              <button type="button" class="tip-toggle" id="tipToggleBtn">展开</button>
            </div>
            <div class="capture-tips-body">
              <ul>
                <li>HTTPS/WSS：点击「安装证书」，然后<strong>完全重启浏览器</strong></li>
                <li>本地 127.0.0.1：已写入 <code>&lt;-loopback&gt;</code>；仍抓不到请用下方命令启动浏览器</li>
                <li>抓完后点「停止」，会自动恢复系统代理</li>
              </ul>
              <code class="chrome-hint">${chromeHint || ''}</code>
            </div>
        `;
        const toggle = document.getElementById('tipToggleBtn');
        if (toggle) {
            toggle.addEventListener('click', () => {
                tipEl.classList.toggle('collapsed');
                toggle.textContent = tipEl.classList.contains('collapsed') ? '展开' : '收起';
            });
        }
    }

    async installCertificate() {
        try {
            const result = await window.electronAPI.installCa();
            if (result.success) {
                this.showStatus(result.message || '证书已安装', 'success');
            } else {
                // 主进程失败时可能已打开证书目录；这里只展示明确错误，避免重复开文件夹
                this.showError(result.error || '安装证书失败');
            }
        } catch (error) {
            this.showError('安装证书失败: ' + error.message);
        }
    }

    async copyChromeHint() {
        try {
            const result = await window.electronAPI.getChromeHint();
            if (result.success && result.hint) {
                await navigator.clipboard.writeText(result.hint);
                this.showStatus('已复制 Chrome/Edge 启动命令', 'success');
            }
        } catch (error) {
            this.showError('复制失败: ' + error.message);
        }
    }

    async openLogs() {
        try {
            const result = await window.electronAPI.openLogs();
            if (result.success) {
                this.showStatus('已打开日志目录: ' + (result.logDir || ''), 'success');
            } else {
                this.showError(result.error || '打开日志失败');
            }
        } catch (error) {
            this.showError('打开日志失败: ' + error.message);
        }
    }

    async stopProxy() {
        // 先更新 UI，避免等系统代理恢复时按钮看起来「没反应」
        this.isRunning = false;
        this.updateUI();
        this.showStatus('正在停止…', 'info');

        try {
            const result = await window.electronAPI.stopProxy();
            if (result.success) {
                this.updateUI();
                this.showStatus('代理已停止，系统代理已恢复', 'success');
                const tipEl = document.getElementById('captureTips');
                if (tipEl) tipEl.style.display = 'none';
            } else {
                this.showError('停止失败: ' + result.error);
            }
        } catch (error) {
            this.showError('停止失败: ' + error.message);
        }
    }

    async clearPackets() {
        try {
            const result = await window.electronAPI.clearPackets();
            // 主进程失败时仍清空界面，避免「必须先清才能停」的错觉
            this.packets = [];
            this.selectedPacket = null;
            this.renderPacketList();
            this.renderPacketDetails();
            this.updatePacketCount();
            if (!result.success) {
                this.showError('清除失败: ' + (result.error || ''));
            }
        } catch (error) {
            this.packets = [];
            this.selectedPacket = null;
            this.renderPacketList();
            this.renderPacketDetails();
            this.updatePacketCount();
            this.showError('清除失败: ' + error.message);
        }
    }

    addPacket(packet) {
        this.indexPacketForSearch(packet);

        // Check if packet already exists (update)
        const existingIndex = this.packets.findIndex(p => p.id === packet.id);
        if (existingIndex >= 0) {
            this.packets[existingIndex] = packet;
        } else {
            this.packets.unshift(packet);
            // 防止列表无限增长导致搜索更卡
            if (this.packets.length > 2000) {
                this.packets.length = 2000;
            }
        }

        this.updatePacketCount();

        // 合并到下一帧渲染，抓包高峰时不会每条请求都重绘
        if (this.shouldDisplayPacket(packet) && this.packetMatchesSearch(packet)) {
            this.scheduleRenderPacketList();
        }

        // Update selected packet if it's the same one
        if (this.selectedPacket && this.selectedPacket.id === packet.id) {
            this.selectedPacket = packet;
            this.renderPacketDetails();
        }
    }

    /** 预计算搜索字段，避免每次搜索 JSON.stringify 请求头 */
    indexPacketForSearch(packet) {
        const parts = [
            packet.method || '',
            packet.url || '',
            packet.protocol || '',
            packet.status != null ? String(packet.status) : '',
            packet.statusText || ''
        ];
        const headers = packet.requestHeaders;
        if (headers && typeof headers === 'object') {
            for (const key of Object.keys(headers)) {
                parts.push(key, String(headers[key] ?? ''));
            }
        }
        packet._searchText = parts.join('\n').toLowerCase();
    }

    packetMatchesSearch(packet) {
        const term = (this.searchTerm || '').trim().toLowerCase();
        if (!term) return true;
        if (!packet._searchText) this.indexPacketForSearch(packet);
        return packet._searchText.includes(term);
    }

    scheduleRenderPacketList() {
        if (this._listRenderQueued) return;
        this._listRenderQueued = true;
        requestAnimationFrame(() => {
            this._listRenderQueued = false;
            this.renderPacketList();
            if (this.autoScroll && this.currentFilter === 'all' && !this.searchTerm) {
                const packetList = document.getElementById('packetList');
                if (packetList) packetList.scrollTop = 0;
            }
        });
    }

    updateWebSocketPacket(packet) {
        const existingIndex = this.packets.findIndex(p => p.id === packet.id);
        if (existingIndex >= 0) {
            this.packets[existingIndex] = packet;
            
            // Update the list item to show new message count
            const listItem = document.querySelector(`[data-packet-id="${packet.id}"]`);
            if (listItem) {
                const metaDiv = listItem.querySelector('.packet-meta');
                if (metaDiv) {
                    const messageCount = packet.messages ? packet.messages.length : 0;
                    metaDiv.innerHTML = `
                        <span class="packet-status status-websocket">${messageCount} 条消息</span>
                        <span>${this.formatTime(packet.timestamp)}</span>
                    `;
                }
            }

            // Update details if this packet is selected
            if (this.selectedPacket && this.selectedPacket.id === packet.id) {
                this.selectedPacket = packet;
                // 仅刷新 WS 消息区，避免整页重绘；并确保 HTML 转义后全部消息可见
                const wsContent = document.getElementById('websocketContent');
                if (wsContent && (packet.protocol === 'ws' || packet.protocol === 'wss')) {
                    this.renderWebSocketMessages(wsContent);
                } else {
                    this.renderPacketDetails();
                }
            }
        } else {
            this.addPacket(packet);
        }
    }

    shouldDisplayPacket(packet) {
        // Apply current filter
        if (this.currentFilter === 'all') return true;
        if (this.currentFilter === 'error') return packet.isError;
        return packet.protocol === this.currentFilter;
    }

    setFilter(filter) {
        this.currentFilter = filter;

        // Update UI
        document.querySelectorAll('.filter-chip').forEach(chip => {
            chip.classList.toggle('active', chip.dataset.filter === filter);
        });

        this.renderPacketList();
    }

    filterPackets(searchTerm) {
        this.searchTerm = searchTerm || '';
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => {
            this.renderPacketList();
        }, 120);
    }

    selectPacket(packetId) {
        this.selectedPacket = this.packets.find(p => p.id === packetId);
        
        // Update selection UI（不重绘列表，避免清掉当前搜索结果）
        document.querySelectorAll('.packet-item').forEach(item => {
            item.classList.toggle('selected', item.dataset.packetId === packetId);
        });

        this.renderPacketDetails();
    }

    switchTab(tabName) {
        // Update tabs
        document.querySelectorAll('.tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        // Update tab panes
        document.querySelectorAll('.tab-pane').forEach(pane => {
            pane.classList.toggle('active', pane.id === tabName);
        });

        // Show/hide WebSocket tab based on selection
        const wsTab = document.querySelector('.tab[data-tab="websocket"]');
        if (this.selectedPacket && (this.selectedPacket.protocol === 'ws' || this.selectedPacket.protocol === 'wss')) {
            wsTab.style.display = 'block';
        } else {
            wsTab.style.display = 'none';
            if (tabName === 'websocket') {
                this.switchTab('overview');
            }
        }
    }

    renderPacketList() {
        const packetList = document.getElementById('packetList');
        if (!packetList) return;

        const searchTerm = (this.searchTerm || '').trim();
        let filteredPackets = [];
        for (let i = 0; i < this.packets.length; i++) {
            const packet = this.packets[i];
            if (!this.shouldDisplayPacket(packet)) continue;
            if (searchTerm && !this.packetMatchesSearch(packet)) continue;
            filteredPackets.push(packet);
            // 列表只渲染前 400 条，避免 DOM 过大卡顿
            if (filteredPackets.length >= 400) break;
        }

        if (filteredPackets.length === 0) {
            packetList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📡</div>
                    <div class="empty-state-text">${this.packets.length === 0 ? '等待捕获数据包' : '没有找到匹配的请求'}</div>
                    ${this.packets.length === 0 ? '<div class="empty-state-hint">启动代理后，这里将显示所有网络请求</div>' : ''}
                </div>
            `;
            return;
        }

        const selectedId = this.selectedPacket ? this.selectedPacket.id : null;
        const moreHint =
            this.packets.length > filteredPackets.length
                ? `<div class="empty-state-hint" style="padding:8px;text-align:center;color:var(--text-muted);font-size:0.72rem;">仅显示前 ${filteredPackets.length} 条，可用搜索缩小范围</div>`
                : '';

        const html = filteredPackets.map((packet) => this.buildPacketItemHtml(packet, selectedId)).join('');
        packetList.innerHTML = html + moreHint;
    }

    buildPacketItemHtml(packet, selectedId) {
        const method = packet.protocol === 'ws' || packet.protocol === 'wss' ? packet.protocol.toUpperCase() : packet.method;
        const methodClass = `method-${method}`;
        const statusClass = packet.isError ? 'status-error' :
                           (packet.protocol === 'ws' || packet.protocol === 'wss') ? 'status-websocket' :
                           packet.status >= 200 && packet.status < 300 ? 'status-success' : 'status-error';

        let statusText = packet.status ? `${packet.status}` : '等待中';
        if (packet.protocol === 'ws' || packet.protocol === 'wss') {
            const messageCount = packet.messages ? packet.messages.length : 0;
            statusText = `${messageCount} 条消息`;
        }

        const selectedClass = packet.id === selectedId ? 'selected' : '';
        return `
            <li class="packet-item ${packet.protocol === 'ws' || packet.protocol === 'wss' ? 'ws-connection' : ''} ${packet.isError ? 'error' : ''} ${selectedClass}"
                data-packet-id="${packet.id}">
                ${packet.protocol !== 'ws' && packet.protocol !== 'wss'
                    ? `<button type="button" class="packet-curl-btn" data-curl-id="${packet.id}" title="复制为 cURL">cURL</button>`
                    : ''}
                <div class="packet-method ${methodClass}">${method}</div>
                <div class="packet-url">${this.truncateUrl(packet.url)}</div>
                <div class="packet-meta">
                    <span class="packet-status ${statusClass}">${statusText}</span>
                    <span>${this.formatTime(packet.timestamp)}</span>
                </div>
            </li>
        `;
    }

    renderPacketDetails() {
        const emptyStates = {
            overview: document.getElementById('emptyOverview'),
            headers: document.getElementById('emptyHeaders'),
            request: document.getElementById('emptyRequest'),
            response: document.getElementById('emptyResponse'),
            websocket: document.getElementById('emptyWebSocket')
        };

        const contents = {
            overview: document.getElementById('overviewContent'),
            headers: document.getElementById('headersContent'),
            request: document.getElementById('requestContent'),
            response: document.getElementById('responseContent'),
            websocket: document.getElementById('websocketContent')
        };

        // Update WebSocket tab visibility
        const wsTab = document.querySelector('.tab[data-tab="websocket"]');
        const isWs = this.selectedPacket && (this.selectedPacket.protocol === 'ws' || this.selectedPacket.protocol === 'wss');
        if (wsTab) {
            wsTab.style.display = isWs ? 'block' : 'none';
        }

        if (!this.selectedPacket) {
            Object.values(contents).forEach(content => { if (content) content.style.display = 'none'; });
            Object.values(emptyStates).forEach(state => { if (state) state.style.display = 'flex'; });
            this.switchTab('overview');
            return;
        }

        // 有选中请求时：隐藏空状态，并显示所有内容区
        // （可见性由 .tab-pane.active 控制；之前只打开 overview，导致其它 tab 空白）
        Object.values(emptyStates).forEach(state => { if (state) state.style.display = 'none'; });
        Object.values(contents).forEach(content => { if (content) content.style.display = 'block'; });

        this.renderOverview(contents.overview);
        this.renderHeaders(contents.headers);
        this.renderRequestBody(contents.request);
        this.renderResponseBody(contents.response);

        if (isWs) {
            this.renderWebSocketMessages(contents.websocket);
        } else {
            contents.websocket.innerHTML = '';
        }
    }

    renderOverview(container) {
        const packet = this.selectedPacket;
        
        const overviewHtml = `
            <div class="panel-section">
                <h3>基本信息</h3>
                <table class="key-value-table">
                    <tr>
                        <td class="key-name">请求方法</td>
                        <td class="value-text">${packet.method}</td>
                    </tr>
                    <tr>
                        <td class="key-name">协议</td>
                        <td class="value-text">${packet.protocol.toUpperCase()}</td>
                    </tr>
                    <tr>
                        <td class="key-name">URL</td>
                        <td class="value-text">${packet.url}</td>
                    </tr>
                    <tr>
                        <td class="key-name">状态码</td>
                        <td class="value-text">${packet.status || '等待中'} ${packet.statusText || ''}</td>
                    </tr>
                    <tr>
                        <td class="key-name">时间</td>
                        <td class="value-text">${new Date(packet.timestamp).toLocaleString('zh-CN')}</td>
                    </tr>
                    <tr>
                        <td class="key-name">耗时</td>
                        <td class="value-text">${packet.duration ? packet.duration + 'ms' : '计算中...'}</td>
                    </tr>
                    <tr>
                        <td class="key-name">大小</td>
                        <td class="value-text">${packet.size ? this.formatSize(packet.size) : '未知'}</td>
                    </tr>
                    ${packet.ip ? `
                    <tr>
                        <td class="key-name">客户端IP</td>
                        <td class="value-text">${packet.ip}:${packet.remotePort || '未知'}</td>
                    </tr>
                    ` : ''}
                    ${packet.isError ? `
                    <tr>
                        <td class="key-name">错误信息</td>
                        <td class="value-text" style="color: #f44336;">${packet.errorMessage || '未知错误'}</td>
                    </tr>
                    ` : ''}
                </table>
            </div>
        `;

        container.innerHTML = overviewHtml;
    }

    renderHeaders(container) {
        const packet = this.selectedPacket;
        
        if (!packet.requestHeaders && !packet.responseHeaders) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-text">没有请求头信息</div></div>';
            return;
        }

        let headersHtml = '';

        if (packet.requestHeaders) {
            headersHtml += `
                <div class="panel-section">
                    <h3>请求头</h3>
                    <table class="key-value-table">
                        <thead>
                            <tr>
                                <th>名称</th>
                                <th>值</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${Object.entries(packet.requestHeaders).map(([key, value]) => `
                                <tr>
                                    <td class="key-name">${key}</td>
                                    <td class="value-text">${value}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        if (packet.responseHeaders) {
            headersHtml += `
                <div class="panel-section">
                    <h3>响应头</h3>
                    <table class="key-value-table">
                        <thead>
                            <tr>
                                <th>名称</th>
                                <th>值</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${Object.entries(packet.responseHeaders).map(([key, value]) => `
                                <tr>
                                    <td class="key-name">${key}</td>
                                    <td class="value-text">${value}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        container.innerHTML = headersHtml;
    }

    renderRequestBody(container) {
        const packet = this.selectedPacket;

        if (packet.protocol === 'ws' || packet.protocol === 'wss') {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-text">WebSocket 握手无传统请求体，消息请看「WebSocket消息」页</div></div>';
            return;
        }

        if (!packet.requestBody) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-text">没有请求体数据</div></div>';
            return;
        }

        this.renderBodyPanel(container, '请求体', this.formatBodyForDisplay(packet.requestBody), 'request');
    }

    renderResponseBody(container) {
        const packet = this.selectedPacket;

        if (packet.protocol === 'ws' || packet.protocol === 'wss') {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-text">WebSocket 握手无传统响应体，消息请看「WebSocket消息」页</div></div>';
            return;
        }

        if (packet.responseBody === undefined || packet.responseBody === null || packet.responseBody === '') {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-text">没有响应体数据</div></div>';
            return;
        }

        this.renderBodyPanel(container, '响应体', this.formatBodyForDisplay(packet.responseBody), 'response');
    }

    renderBodyPanel(container, title, plainText, kind) {
        this.bodyPlainText = plainText;
        this.bodySearchKind = kind;
        this.bodySearchMatches = [];
        this.bodySearchIndex = -1;

        container.innerHTML = `
            <div class="panel-section">
                <div class="body-toolbar">
                    <h3>${title}</h3>
                    <div class="body-search-wrap">
                        <input type="search" id="bodySearchInput" placeholder="搜索 (Ctrl+F)" autocomplete="off">
                        <span class="body-search-meta" id="bodySearchMeta"></span>
                        <button type="button" class="body-tool-btn" id="bodySearchPrev" title="上一个">↑</button>
                        <button type="button" class="body-tool-btn" id="bodySearchNext" title="下一个">↓</button>
                    </div>
                    <button type="button" class="body-tool-btn" id="bodyCopyBtn">复制</button>
                </div>
                <div class="json-viewer" id="bodyViewer">${this.syntaxHighlight(plainText)}</div>
            </div>
        `;

        const input = document.getElementById('bodySearchInput');
        const copyBtn = document.getElementById('bodyCopyBtn');
        const prevBtn = document.getElementById('bodySearchPrev');
        const nextBtn = document.getElementById('bodySearchNext');

        if (copyBtn) {
            copyBtn.addEventListener('click', () => this.copyText(this.bodyPlainText, title + '已复制'));
        }
        if (input) {
            input.addEventListener('input', () => this.applyBodySearch(input.value));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (e.shiftKey) this.gotoBodyMatch(-1);
                    else this.gotoBodyMatch(1);
                }
                if (e.key === 'Escape') {
                    input.value = '';
                    this.applyBodySearch('');
                    input.blur();
                }
            });
        }
        if (prevBtn) prevBtn.addEventListener('click', () => this.gotoBodyMatch(-1));
        if (nextBtn) nextBtn.addEventListener('click', () => this.gotoBodyMatch(1));
    }

    applyBodySearch(query) {
        const viewer = document.getElementById('bodyViewer');
        const meta = document.getElementById('bodySearchMeta');
        if (!viewer) return;

        const q = (query || '').trim();
        if (!q) {
            viewer.innerHTML = this.syntaxHighlight(this.bodyPlainText);
            this.bodySearchMatches = [];
            this.bodySearchIndex = -1;
            if (meta) meta.textContent = '';
            return;
        }

        const text = this.bodyPlainText;
        const lower = text.toLowerCase();
        const needle = q.toLowerCase();
        const ranges = [];
        let from = 0;
        while (from < lower.length) {
            const idx = lower.indexOf(needle, from);
            if (idx < 0) break;
            ranges.push([idx, idx + needle.length]);
            from = idx + Math.max(needle.length, 1);
        }
        this.bodySearchMatches = ranges;
        this.bodySearchIndex = ranges.length ? 0 : -1;

        viewer.innerHTML = this.highlightSearchInText(text, ranges, this.bodySearchIndex);
        if (meta) {
            meta.textContent = ranges.length ? `${this.bodySearchIndex + 1}/${ranges.length}` : '0/0';
        }
        this.scrollToActiveBodyMatch();
    }

    highlightSearchInText(text, ranges, activeIndex) {
        if (!ranges.length) return this.escapeHtml(text);
        let html = '';
        let last = 0;
        ranges.forEach(([start, end], i) => {
            html += this.escapeHtml(text.slice(last, start));
            const cls = i === activeIndex ? 'body-search-hit active' : 'body-search-hit';
            html += `<mark class="${cls}" data-hit="${i}">${this.escapeHtml(text.slice(start, end))}</mark>`;
            last = end;
        });
        html += this.escapeHtml(text.slice(last));
        return html;
    }

    gotoBodyMatch(delta) {
        if (!this.bodySearchMatches.length) return;
        const n = this.bodySearchMatches.length;
        this.bodySearchIndex = (this.bodySearchIndex + delta + n) % n;
        const viewer = document.getElementById('bodyViewer');
        const meta = document.getElementById('bodySearchMeta');
        const input = document.getElementById('bodySearchInput');
        if (viewer && input) {
            viewer.innerHTML = this.highlightSearchInText(
                this.bodyPlainText,
                this.bodySearchMatches,
                this.bodySearchIndex
            );
        }
        if (meta) meta.textContent = `${this.bodySearchIndex + 1}/${n}`;
        this.scrollToActiveBodyMatch();
    }

    scrollToActiveBodyMatch() {
        const el = document.querySelector('#bodyViewer .body-search-hit.active');
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    async copyText(text, successMsg) {
        try {
            await navigator.clipboard.writeText(text == null ? '' : String(text));
            this.showStatus(successMsg || '已复制', 'success');
        } catch (err) {
            this.showError('复制失败: ' + err.message);
        }
    }

    showPacketCtxMenu(x, y, packetId) {
        const menu = document.getElementById('packetCtxMenu');
        if (!menu) return;
        this.ctxPacketId = packetId;
        menu.classList.add('open');
        const pad = 8;
        const rect = menu.getBoundingClientRect();
        let left = x;
        let top = y;
        if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
        if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad;
        menu.style.left = `${Math.max(pad, left)}px`;
        menu.style.top = `${Math.max(pad, top)}px`;
    }

    hidePacketCtxMenu() {
        const menu = document.getElementById('packetCtxMenu');
        if (menu) menu.classList.remove('open');
        this.ctxPacketId = null;
    }

    packetToCurl(packet) {
        if (!packet) return '';
        if (packet.protocol === 'ws' || packet.protocol === 'wss') {
            return `# WebSocket 无法直接转为 curl\n# ${packet.url}`;
        }

        const method = (packet.method || 'GET').toUpperCase();
        const url = packet.url || '';
        const headers = packet.requestHeaders || {};
        const skip = new Set([
            'host',
            'content-length',
            'transfer-encoding',
            'connection',
            'keep-alive',
            'proxy-connection',
            'proxy-authorization',
            'te',
            'trailer',
            'upgrade',
            'accept-encoding'
        ]);

        const lines = [`curl '${url.replace(/'/g, `'\\''`)}'`];
        if (method !== 'GET') {
            lines.push(`  -X ${method}`);
        }

        Object.keys(headers)
            .sort((a, b) => a.localeCompare(b))
            .forEach((key) => {
                if (skip.has(key.toLowerCase())) return;
                const val = String(headers[key]).replace(/'/g, `'\\''`);
                lines.push(`  -H '${key}: ${val}'`);
            });

        if (packet.requestBody !== undefined && packet.requestBody !== null && packet.requestBody !== '') {
            let body =
                typeof packet.requestBody === 'string'
                    ? packet.requestBody
                    : JSON.stringify(packet.requestBody);
            body = body.replace(/'/g, `'\\''`);
            lines.push(`  --data-raw '${body}'`);
        }

        return lines.join(' \\\n');
    }

    async copyPacketAsCurl(packet) {
        const curl = this.packetToCurl(packet);
        await this.copyText(curl, '已复制为 cURL');
    }

    formatBodyForDisplay(body) {
        if (typeof body === 'object') {
            try {
                return JSON.stringify(body, null, 2);
            } catch {
                return String(body);
            }
        }
        const text = String(body);
        const trimmed = text.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                return JSON.stringify(JSON.parse(trimmed), null, 2);
            } catch {
                return text;
            }
        }
        return text;
    }

    showRewriteManager() {
        this.loadRewriteRules();
        const modal = document.getElementById('rewriteModal');
        if (modal) modal.style.display = 'flex';
    }

    hideRewriteManager() {
        document.querySelectorAll('#rewriteRuleModal').forEach((el) => el.remove());
        const modal = document.getElementById('rewriteModal');
        if (modal) modal.style.display = 'none';
    }

    renderWebSocketMessages(container) {
        const packet = this.selectedPacket;
        
        if (!packet.messages || packet.messages.length === 0) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-text">暂无WebSocket消息</div></div>';
            return;
        }

        // 逐条安全渲染：单条内容含 < / </div> 等字符时，不再破坏后续消息的 DOM
        const list = document.createElement('div');
        list.className = 'panel-section';

        const title = document.createElement('h3');
        title.textContent = `WebSocket消息 (${packet.messages.length}条)`;
        list.appendChild(title);

        const messagesEl = document.createElement('div');
        messagesEl.className = 'ws-messages';

        packet.messages.forEach((message, index) => {
            try {
                messagesEl.appendChild(this.createWsMessageElement(message, index));
            } catch (err) {
                const fallback = document.createElement('div');
                fallback.className = 'ws-message error';
                fallback.textContent = `第 ${index + 1} 条消息渲染失败: ${err.message}`;
                messagesEl.appendChild(fallback);
            }
        });

        list.appendChild(messagesEl);
        container.replaceChildren(list);

        // 新消息到达时滚到底部，便于看后续收发
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    createWsMessageElement(message, index) {
        const wrap = document.createElement('div');
        wrap.className = `ws-message ${message.direction || ''}`;
        wrap.dataset.messageIndex = String(index);

        const header = document.createElement('div');
        header.className = 'ws-message-header';

        const direction = document.createElement('div');
        direction.className = `ws-message-direction direction-${message.direction || 'incoming'}`;
        direction.textContent = message.direction === 'incoming' ? '📥 接收' : '📤 发送';

        const time = document.createElement('div');
        time.className = 'ws-message-time';
        time.textContent = new Date(message.timestamp).toLocaleTimeString('zh-CN');

        header.appendChild(direction);
        header.appendChild(time);

        const content = document.createElement('div');
        content.className = 'ws-message-content';
        if (message.type === 'binary') {
            content.textContent = `[二进制数据] ${this.formatSize(message.size || 0)}`;
        } else if (message.type === 'error') {
            content.style.whiteSpace = 'pre-wrap';
            content.style.color = 'var(--danger)';
            content.textContent = String(message.content || '');
        } else {
            content.innerHTML = this.formatMessageContent(message.content);
        }

        const meta = document.createElement('div');
        meta.className = 'ws-message-type';
        meta.textContent = `类型: ${message.type || 'text'} | 大小: ${this.formatSize(message.size || 0)}${
            message.isMasked !== undefined ? ` | 屏蔽: ${message.isMasked}` : ''
        }`;

        wrap.appendChild(header);
        wrap.appendChild(content);
        wrap.appendChild(meta);
        return wrap;
    }

    formatMessageContent(content) {
        if (content == null) {
            return '<em>(空)</em>';
        }

        // Buffer 经 IPC 可能变成 { type: 'Buffer', data: [...] }
        if (content && typeof content === 'object' && content.type === 'Buffer' && Array.isArray(content.data)) {
            try {
                content = new TextDecoder().decode(Uint8Array.from(content.data));
            } catch {
                return this.escapeHtml('[无法解码的二进制数据]');
            }
        }

        if (typeof content === 'object') {
            try {
                return `<div class="json-viewer">${this.syntaxHighlight(JSON.stringify(content, null, 2))}</div>`;
            } catch (e) {
                return this.escapeHtml(String(content));
            }
        }

        const text = String(content);
        const trimmed = text.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
                const parsed = JSON.parse(trimmed);
                return `<div class="json-viewer">${this.syntaxHighlight(JSON.stringify(parsed, null, 2))}</div>`;
            } catch {
                // 非完整 JSON，按纯文本转义
            }
        }

        // 关键：必须转义，否则流式 HTML/Markdown 中的 </div> 会截断后续消息
        return `<div class="json-viewer">${this.escapeHtml(text)}</div>`;
    }

    escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    syntaxHighlight(json) {
        if (typeof json !== 'string') {
            json = JSON.stringify(json, null, 2);
        }
        
        json = this.escapeHtml(json);
        
        return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
            let cls = 'json-number';
            if (/^"/.test(match)) {
                if (/:$/.test(match)) {
                    cls = 'json-key';
                } else {
                    cls = 'json-string';
                }
            } else if (/true|false/.test(match)) {
                cls = 'json-boolean';
            } else if (/null/.test(match)) {
                cls = 'json-null';
            }
            return '<span class="' + cls + '">' + match + '</span>';
        });
    }

    updateUI() {
        // Update status indicator
        const statusIndicator = document.getElementById('statusIndicator');
        statusIndicator.className = 'status-indicator ' + (this.isRunning ? 'active' : 'inactive');

        // Update button states
        document.getElementById('startBtn').disabled = this.isRunning;
        document.getElementById('stopBtn').disabled = !this.isRunning;
        document.getElementById('portDisplay').textContent = `端口: ${this.config.port}`;

        // Update status text
        const statusText = document.getElementById('statusText');
        if (this.isRunning) {
            statusText.textContent = `代理运行中 - 端口 ${this.config.port}`;
        } else {
            statusText.textContent = '代理未启动';
        }
    }

    updatePacketCount() {
        const packetCount = document.getElementById('packetCount');
        const wsCount = this.packets.filter(p => p.protocol === 'ws' || p.protocol === 'wss').length;
        const httpCount = this.packets.length - wsCount;
        packetCount.textContent = `${this.packets.length} 个请求 (HTTP: ${httpCount}, WS: ${wsCount})`;
    }

    closeToolbarMore() {
        const more = document.getElementById('toolbarMore');
        if (more) more.open = false;
    }

    showConfigModal() {
        const bypassEl = document.getElementById('configBypassList');
        if (bypassEl) bypassEl.value = this.config.bypassList || '';
        document.getElementById('configModal').style.display = 'flex';
    }

    hideConfigModal() {
        document.getElementById('configModal').style.display = 'none';
    }

    saveConfig() {
        const bypassEl = document.getElementById('configBypassList');
        this.config = {
            port: parseInt(document.getElementById('configPort').value),
            enableHttps: document.getElementById('configEnableHttps').checked,
            enableLocalhost: document.getElementById('configEnableLocalhost').checked,
            autoSystemProxy: document.getElementById('configAutoSystemProxy')
                ? document.getElementById('configAutoSystemProxy').checked
                : true,
            bypassList: bypassEl ? bypassEl.value.trim() : (this.config.bypassList || ''),
            recordWebSocket: document.getElementById('configRecordWebSocket').checked,
            recordRequests: document.getElementById('configRecordRequests').checked,
            autoScroll: true
        };

        // Save to localStorage
        localStorage.setItem('proxyConfig', JSON.stringify(this.config));

        // Update proxy if running（含即时刷新系统 ProxyOverride）
        if (this.isRunning) {
            window.electronAPI.setProxyConfig(this.config);
        }

        this.updateUI();
        this.hideConfigModal();
        this.showStatus('配置已保存', 'success');
    }

    showStatus(message, type = 'info') {
        const statusText = document.getElementById('statusText');
        const bar = document.querySelector('.status-bar');
        if (!statusText) return;
        statusText.textContent = message;
        if (bar) {
            bar.classList.remove('error-flash', 'success-flash');
            if (type === 'error') bar.classList.add('error-flash');
            if (type === 'success') bar.classList.add('success-flash');
        }

        clearTimeout(this._statusTimer);
        this._statusTimer = setTimeout(() => {
            if (bar) bar.classList.remove('error-flash', 'success-flash');
            this.updateUI();
        }, 3500);
    }

    showError(message) {
        const msg = String(message || '');
        // 瞬时网络断开不打扰
        if (/socket hang up|ECONNRESET|ECONNABORTED|EPIPE/i.test(msg)) {
            console.warn('[proxy]', msg);
            return;
        }
        console.error(message);
        this.showStatus(message, 'error');
    }

    formatTime(timestamp) {
        return new Date(timestamp).toLocaleTimeString('zh-CN');
    }

    formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    truncateUrl(url, maxLength = 60) {
        if (url.length <= maxLength) return url;
        return url.substring(0, maxLength) + '...';
    }

    // Rewrite Rules Management
    async loadRewriteRules() {
        try {
            const result = await window.electronAPI.getRewriteRules();
            if (result.success) {
                this.rewriteRules = result.rules;
                this.renderRewriteRules();
            }
        } catch (error) {
            console.error('Error loading rewrite rules:', error);
        }
    }

    renderRewriteRules() {
        const container = document.getElementById('rewriteRulesList');
        const countEl = document.getElementById('rewriteRuleCount');
        const rules = [...this.rewriteRules].sort((a, b) => a.priority - b.priority);
        if (countEl) {
            countEl.textContent = rules.length ? `(${rules.length})` : '';
        }

        if (rules.length === 0) {
            container.innerHTML = `
                <div class="rewrite-empty">
                    <strong>暂无规则</strong>
                    点击「添加」创建第一条重写规则
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <table class="rewrite-table">
                <thead>
                    <tr>
                        <th class="col-on">启用</th>
                        <th class="col-name">名称</th>
                        <th>匹配 → 改写</th>
                        <th class="col-scope">范围</th>
                        <th class="col-ops"></th>
                    </tr>
                </thead>
                <tbody>
                    ${rules.map((rule) => this.renderRewriteRuleRow(rule)).join('')}
                </tbody>
            </table>
        `;
    }

    renderRewriteRuleRow(rule) {
        const scopeClass = rule.applyTo === 'request' ? 'req' : rule.applyTo === 'response' ? 'res' : 'both';
        const scopeLabel = rule.applyTo === 'request' ? '请求' : rule.applyTo === 'response' ? '响应' : '双向';
        const actionLabel = this.getActionTypeLabel(rule.actionType);
        const actionDetail = this.formatActionDetail(rule);
        const matchHint = [
          rule.matchOperator === 'regex' ? '正则' : rule.matchOperator === 'contains' ? '包含' : rule.matchOperator,
          rule.matchMethod && rule.matchMethod !== '*' ? rule.matchMethod : null
        ].filter(Boolean).join(' · ');

        return `
            <tr class="${rule.enabled ? '' : 'is-off'}" data-rule-id="${rule.id}">
                <td class="col-on">
                    <input type="checkbox" class="rw-switch" ${rule.enabled ? 'checked' : ''}
                        title="${rule.enabled ? '点击禁用' : '点击启用'}"
                        onchange="window.proxyApp.toggleRewriteRule('${rule.id}', this.checked)">
                </td>
                <td class="col-name">
                    <div class="rw-name" title="${this.escapeHtml(rule.name)}">${this.escapeHtml(rule.name)}</div>
                    <div class="rw-meta">P${rule.priority} · ${actionLabel}</div>
                </td>
                <td>
                    <div class="rw-flow">
                        <div class="rw-flow-line">
                            <span class="rw-flow-label">匹配</span>
                            <span class="rw-flow-code" title="${this.escapeHtml(rule.matchPattern)}">${this.escapeHtml(rule.matchPattern)}</span>
                            <span class="rw-meta">${this.escapeHtml(matchHint)}</span>
                        </div>
                        <div class="rw-flow-line">
                            <span class="rw-flow-label">操作</span>
                            <span class="rw-flow-code to" title="${this.escapeHtml(actionDetail)}">${this.escapeHtml(actionDetail)}</span>
                        </div>
                    </div>
                </td>
                <td class="col-scope"><span class="rw-pill ${scopeClass}">${scopeLabel}</span></td>
                <td class="col-ops">
                    <button type="button" class="rw-icon-btn" title="编辑" onclick="event.stopPropagation(); window.proxyApp.editRewriteRule('${rule.id}')">编辑</button>
                    <button type="button" class="rw-icon-btn danger" title="删除" onclick="event.stopPropagation(); window.proxyApp.deleteRewriteRule('${rule.id}')">删除</button>
                </td>
            </tr>
        `;
    }

    formatActionDetail(rule) {
        const t = rule.actionType;
        const key = rule.actionTarget || '';
        const val = rule.actionValue || '';
        if (t === 'add-header' || t === 'add') return `+ Header ${key}: ${val}`;
        if (t === 'replace-header' || t === 'modify') return `Header ${key} = ${val}`;
        if (t === 'remove-header' || t === 'remove') return `- Header ${key}`;
        if (t === 'add-query') return `+ Query ${key}=${val}`;
        if (t === 'replace-query') return `Query ${key}=${val}`;
        if (t === 'remove-query') return `- Query ${key}`;
        if (t === 'replace-host') return `Host → ${val}`;
        if (t === 'replace-path') return `Path → ${val}`;
        if (t === 'replace-body') return `Body → ${val.slice(0, 40)}${val.length > 40 ? '…' : ''}`;
        if (t === 'redirect') return `Redirect → ${val}`;
        if (t === 'replace-url' || t === 'replace') return `URL → ${val}`;
        return val || '—';
    }

    async showAddRewriteRuleModal() {
        this.showRewriteRuleModal();
    }

    async editRewriteRule(ruleId) {
        const rule = this.rewriteRules.find(r => r.id === ruleId);
        if (rule) {
            this.showRewriteRuleModal(rule);
        }
    }

    showRewriteRuleModal(rule = null) {
        // 避免连点「编辑」叠多个弹窗：顶层按钮无监听，表现为「卡住」
        document.querySelectorAll('#rewriteRuleModal').forEach((el) => el.remove());

        const modal = document.createElement('div');
        modal.className = 'modal-overlay modal-nested';
        modal.id = 'rewriteRuleModal';

        const isEdit = rule !== null;
        const title = isEdit ? '编辑重写规则' : '添加重写规则';
        const actionType = this.normalizeActionTypeForUi(rule);
        const needsTarget = this.actionNeedsTarget(actionType);
        const needsValue = this.actionNeedsValue(actionType);
        const $ = (sel) => modal.querySelector(sel);

        modal.innerHTML = `
            <div class="modal modal-wide" style="width:560px">
                <div class="modal-header">
                    <h2>${title}</h2>
                    <button type="button" class="modal-close" data-rw-close>&times;</button>
                </div>
                <div class="modal-body">
                    <div class="rewrite-form-section">
                        <h4>基本信息</h4>
                        <div class="rewrite-form-row">
                            <div>
                                <label class="rewrite-form-label">规则名称 *</label>
                                <input type="text" class="rewrite-form-input" data-rw="name" value="${rule ? this.escapeHtml(rule.name) : ''}" placeholder="例如：本地 API 转发">
                            </div>
                            <div>
                                <label class="rewrite-form-label">优先级（越小越先）</label>
                                <input type="number" class="rewrite-form-input" data-rw="priority" value="${rule ? rule.priority : 100}" min="1" max="1000">
                            </div>
                        </div>
                        <div class="rewrite-form-row">
                            <div>
                                <label class="rewrite-form-label">应用阶段</label>
                                <select class="rewrite-form-select" data-rw="applyTo">
                                    <option value="request" ${!rule || rule.applyTo === 'request' ? 'selected' : ''}>请求（发出前改写）</option>
                                    <option value="response" ${rule && rule.applyTo === 'response' ? 'selected' : ''}>响应</option>
                                    <option value="both" ${rule && rule.applyTo === 'both' ? 'selected' : ''}>请求 + 响应</option>
                                </select>
                            </div>
                            <div class="rewrite-form-checkbox">
                                <input type="checkbox" data-rw="enabled" id="ruleEnabled" ${rule ? (rule.enabled ? 'checked' : '') : 'checked'}>
                                <label for="ruleEnabled">启用</label>
                            </div>
                        </div>
                    </div>

                    <div class="rewrite-form-section">
                        <h4>① 匹配哪些请求</h4>
                        <div class="rewrite-form-row">
                            <div>
                                <label class="rewrite-form-label">URL 匹配方式</label>
                                <select class="rewrite-form-select" data-rw="matchOperator">
                                    <option value="contains" ${!rule || rule.matchOperator === 'contains' ? 'selected' : ''}>包含</option>
                                    <option value="regex" ${rule && rule.matchOperator === 'regex' ? 'selected' : ''}>正则</option>
                                    <option value="equals" ${rule && rule.matchOperator === 'equals' ? 'selected' : ''}>等于</option>
                                    <option value="starts-with" ${rule && rule.matchOperator === 'starts-with' ? 'selected' : ''}>开头是</option>
                                    <option value="ends-with" ${rule && rule.matchOperator === 'ends-with' ? 'selected' : ''}>结尾是</option>
                                </select>
                            </div>
                            <div>
                                <label class="rewrite-form-label">HTTP 方法</label>
                                <select class="rewrite-form-select" data-rw="matchMethod">
                                    <option value="*" ${!rule || !rule.matchMethod || rule.matchMethod === '*' ? 'selected' : ''}>全部</option>
                                    ${['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'].map(m =>
                                      `<option value="${m}" ${rule && rule.matchMethod === m ? 'selected' : ''}>${m}</option>`
                                    ).join('')}
                                </select>
                            </div>
                        </div>
                        <div class="rewrite-form-row full-width">
                            <div>
                                <label class="rewrite-form-label">URL 匹配内容 *</label>
                                <input type="text" class="rewrite-form-input" data-rw="matchPattern" value="${rule ? this.escapeHtml(rule.matchPattern) : ''}" placeholder="例：cowork.kdocs.cn/api；匹配全部可用 .*（正则）">
                            </div>
                        </div>
                        <div class="rewrite-hint">只有命中上述条件的请求/响应，才会执行下面的操作。「包含」模式下 * 是字面量，匹配全部请用正则 <code>.*</code>。</div>
                    </div>

                    <div class="rewrite-form-section">
                        <h4>② 对这些请求做什么</h4>
                        <div class="rewrite-form-row full-width">
                            <div>
                                <label class="rewrite-form-label">操作类型 *</label>
                                <select class="rewrite-form-select" data-rw="actionType">
                                    <optgroup label="URL">
                                        <option value="replace-url" ${actionType === 'replace-url' ? 'selected' : ''}>替换 URL（支持 $1 捕获组）</option>
                                        <option value="replace-host" ${actionType === 'replace-host' ? 'selected' : ''}>替换 Host</option>
                                        <option value="replace-path" ${actionType === 'replace-path' ? 'selected' : ''}>替换 Path</option>
                                        <option value="redirect" ${actionType === 'redirect' ? 'selected' : ''}>重定向到新 URL</option>
                                    </optgroup>
                                    <optgroup label="Query">
                                        <option value="add-query" ${actionType === 'add-query' ? 'selected' : ''}>增加 Query 参数</option>
                                        <option value="replace-query" ${actionType === 'replace-query' ? 'selected' : ''}>替换 Query 参数</option>
                                        <option value="remove-query" ${actionType === 'remove-query' ? 'selected' : ''}>删除 Query 参数</option>
                                    </optgroup>
                                    <optgroup label="Header">
                                        <option value="add-header" ${actionType === 'add-header' ? 'selected' : ''}>增加 Header</option>
                                        <option value="replace-header" ${actionType === 'replace-header' ? 'selected' : ''}>替换 Header</option>
                                        <option value="remove-header" ${actionType === 'remove-header' ? 'selected' : ''}>删除 Header</option>
                                    </optgroup>
                                    <optgroup label="Body">
                                        <option value="replace-body" ${actionType === 'replace-body' ? 'selected' : ''}>替换 Body</option>
                                    </optgroup>
                                </select>
                            </div>
                        </div>
                        <div class="rewrite-form-row" data-rw="actionFields">
                            <div data-rw="targetWrap" style="${needsTarget ? '' : 'display:none'}">
                                <label class="rewrite-form-label" data-rw="targetLabel">名称 *</label>
                                <input type="text" class="rewrite-form-input" data-rw="actionTarget" value="${rule ? this.escapeHtml(rule.actionTarget || '') : ''}" placeholder="Header 名或 Query 名">
                            </div>
                            <div data-rw="valueWrap" style="${needsValue ? '' : 'display:none'}">
                                <label class="rewrite-form-label" data-rw="valueLabel">值 *</label>
                                <input type="text" class="rewrite-form-input" data-rw="actionValue" value="${rule ? this.escapeHtml(rule.actionValue || '') : ''}" placeholder="新的值">
                            </div>
                        </div>
                        <div class="rewrite-hint" data-rw="actionHint"></div>
                    </div>
                </div>
                <div class="modal-form-error" data-rw="formError"></div>
                <div class="modal-footer">
                    <button type="button" class="btn-secondary" data-rw-close>取消</button>
                    <button type="button" class="btn-start" data-rw-save>${isEdit ? '保存' : '添加'}</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const showFormError = (msg) => {
            const el = $('[data-rw="formError"]');
            if (!el) return;
            el.textContent = msg || '';
            el.classList.toggle('visible', !!msg);
        };

        const closeModal = () => {
            document.removeEventListener('keydown', onKeydown);
            if (modal.parentNode) modal.parentNode.removeChild(modal);
        };

        const onKeydown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeModal();
            }
        };
        document.addEventListener('keydown', onKeydown);

        const syncActionUi = () => {
            const type = $('[data-rw="actionType"]').value;
            const needT = this.actionNeedsTarget(type);
            const needV = this.actionNeedsValue(type);
            $('[data-rw="targetWrap"]').style.display = needT ? '' : 'none';
            $('[data-rw="valueWrap"]').style.display = needV ? '' : 'none';
            const tLabel = $('[data-rw="targetLabel"]');
            const vLabel = $('[data-rw="valueLabel"]');
            const hint = $('[data-rw="actionHint"]');
            const targetInput = $('[data-rw="actionTarget"]');
            const valueInput = $('[data-rw="actionValue"]');
            if (type.includes('header')) {
                tLabel.textContent = 'Header 名称 *';
                targetInput.placeholder = '例如：Authorization';
                vLabel.textContent = 'Header 值 *';
                valueInput.placeholder = '例如：Bearer xxx';
                hint.textContent = 'CORS 相关头请选「响应」阶段；对命中请求/响应的 Header 增删改。';
            } else if (type.includes('query')) {
                tLabel.textContent = 'Query 参数名 *';
                targetInput.placeholder = '例如：debug';
                vLabel.textContent = '参数值 *';
                valueInput.placeholder = '例如：1';
                hint.textContent = '对命中请求 URL 的 query 进行增删改。';
            } else if (type === 'replace-url') {
                vLabel.textContent = '新 URL / 替换串 *';
                valueInput.placeholder = '例：https://127.0.0.1:3000/$1';
                hint.textContent = '用匹配模式替换整段 URL；正则可用 $1、$2 捕获组。';
            } else if (type === 'replace-host') {
                vLabel.textContent = '新 Host *';
                valueInput.placeholder = '例：127.0.0.1:3000';
                hint.textContent = '只改 host:port，path/query 保持不变。';
            } else if (type === 'replace-path') {
                vLabel.textContent = '新 Path *';
                valueInput.placeholder = '例：/api/v2/plans';
                hint.textContent = '只改 pathname。';
            } else if (type === 'redirect') {
                vLabel.textContent = '重定向目标 URL *';
                valueInput.placeholder = '例：https://example.com/fallback';
                hint.textContent = '直接对客户端返回 302，不再转发原请求。';
            } else if (type === 'replace-body') {
                vLabel.textContent = '新 Body *';
                valueInput.placeholder = '{"ok":true}';
                hint.textContent = '替换请求/响应体内容。';
            } else {
                hint.textContent = '';
            }
        };

        syncActionUi();
        $('[data-rw="actionType"]').addEventListener('change', syncActionUi);

        modal.querySelectorAll('[data-rw-close]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeModal();
            });
        });

        // 点遮罩关闭；点内容区不关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
        modal.querySelector('.modal')?.addEventListener('click', (e) => e.stopPropagation());

        const saveBtn = $('[data-rw-save]');
        saveBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (saveBtn.disabled) return;
            saveBtn.disabled = true;
            showFormError('');
            try {
                const ok = await this.saveRewriteRule(isEdit, rule, modal, showFormError);
                if (ok) closeModal();
            } finally {
                saveBtn.disabled = false;
            }
        });
    }

    normalizeActionTypeForUi(rule) {
        if (!rule) return 'replace-url';
        const t = rule.actionType;
        if (t === 'add') return 'add-header';
        if (t === 'remove') return 'remove-header';
        if (t === 'modify') return 'replace-header';
        if (t === 'replace') {
            if (rule.matchType === 'header' || rule.matchType === 'response-header') return 'replace-header';
            if (rule.matchType === 'body' || rule.matchType === 'response-body') return 'replace-body';
            return 'replace-url';
        }
        return t;
    }

    actionNeedsTarget(type) {
        return ['add-header','replace-header','remove-header','add-query','replace-query','remove-query'].includes(type);
    }

    actionNeedsValue(type) {
        return !['remove-header','remove-query'].includes(type);
    }

    async saveRewriteRule(isEdit, existingRule, root = document, showFormError = null) {
        const q = (sel) => (root.querySelector ? root.querySelector(sel) : document.querySelector(sel));
        const fail = (msg) => {
            if (showFormError) showFormError(msg);
            else this.showError(msg);
            return false;
        };

        const name = (q('[data-rw="name"]') || q('#ruleName'))?.value.trim() || '';
        const priority = parseInt((q('[data-rw="priority"]') || q('#rulePriority'))?.value, 10) || 100;
        const enabled = !!(q('[data-rw="enabled"]') || q('#ruleEnabled'))?.checked;
        const applyTo = (q('[data-rw="applyTo"]') || q('#ruleApplyTo'))?.value || 'request';
        let matchOperator = (q('[data-rw="matchOperator"]') || q('#ruleMatchOperator'))?.value || 'contains';
        const matchMethod = (q('[data-rw="matchMethod"]') || q('#ruleMatchMethod'))?.value || '*';
        let matchPattern = (q('[data-rw="matchPattern"]') || q('#ruleMatchPattern'))?.value.trim() || '';
        const actionType = (q('[data-rw="actionType"]') || q('#ruleActionType'))?.value || '';
        const actionValue = (q('[data-rw="actionValue"]') || q('#ruleActionValue'))?.value.trim() || '';
        const actionTarget = (q('[data-rw="actionTarget"]') || q('#ruleActionTarget'))?.value.trim() || '';

        if (!name) return fail('请输入规则名称');
        if (!matchPattern) return fail('请输入 URL 匹配内容');
        // 「包含 *」常被当成通配；自动改为正则 .*，避免规则永远匹配不到
        if ((matchPattern === '*' || matchPattern === '.*') && matchOperator !== 'regex') {
            matchOperator = 'regex';
            matchPattern = '.*';
        }
        if (matchOperator === 'regex') {
            try {
                // eslint-disable-next-line no-new
                new RegExp(matchPattern);
            } catch {
                return fail('URL 正则无效，请检查匹配内容');
            }
        }
        if (this.actionNeedsTarget(actionType) && !actionTarget) {
            return fail(actionType.includes('query') ? '请输入 Query 参数名' : '请输入 Header 名称');
        }
        if (this.actionNeedsValue(actionType) && !actionValue) {
            return fail('请输入操作值');
        }
        if (
            actionType.includes('header') &&
            /access-control-/i.test(actionTarget) &&
            applyTo === 'request'
        ) {
            return fail('CORS 响应头应把「应用阶段」改为「响应」，否则浏览器看不到该头');
        }

        const ruleData = {
            name,
            enabled,
            matchType: 'url',
            matchPattern,
            matchOperator,
            matchMethod,
            actionType,
            actionTarget,
            actionValue,
            applyTo,
            priority,
            description: existingRule?.description || ''
        };

        try {
            let result;
            if (isEdit && existingRule) {
                result = await window.electronAPI.updateRewriteRule(existingRule.id, ruleData);
            } else {
                result = await window.electronAPI.addRewriteRule(ruleData);
            }
            if (result.success) {
                await this.loadRewriteRules();
                this.showStatus(isEdit ? '规则已更新' : '规则已添加', 'success');
                return true;
            }
            return fail(result.error || '保存失败');
        } catch (error) {
            return fail('保存失败: ' + error.message);
        }
    }

    async toggleRewriteRule(ruleId, enabled) {
        try {
            const result = await window.electronAPI.toggleRewriteRule(ruleId, enabled);
            if (result.success) {
                await this.loadRewriteRules();
                this.showStatus(enabled ? '规则已启用' : '规则已禁用', 'success');
            } else {
                this.showError('操作失败: ' + result.error);
            }
        } catch (error) {
            this.showError('操作失败: ' + error.message);
        }
    }

    async deleteRewriteRule(ruleId) {
        if (!confirm('确定要删除此规则吗？')) return;

        try {
            const result = await window.electronAPI.deleteRewriteRule(ruleId);
            if (result.success) {
                await this.loadRewriteRules();
                this.showStatus('规则已删除', 'success');
            } else {
                this.showError('删除失败: ' + result.error);
            }
        } catch (error) {
            this.showError('删除失败: ' + error.message);
        }
    }

    async exportRewriteRules() {
        try {
            const result = await window.electronAPI.exportRewriteRules();
            if (result.success) {
                const blob = new Blob([result.data], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `rewrite-rules-${Date.now()}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                this.showStatus('规则已导出', 'success');
            } else {
                this.showError('导出失败: ' + result.error);
            }
        } catch (error) {
            this.showError('导出失败: ' + error.message);
        }
    }

    async importRewriteRules() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const text = await file.text();
                const result = await window.electronAPI.importRewriteRules(text);
                
                if (result.success) {
                    await this.loadRewriteRules();
                    this.showStatus(`已导入 ${result.imported} 条规则`, 'success');
                } else {
                    this.showError('导入失败: ' + result.error);
                }
            } catch (error) {
                this.showError('导入失败: ' + error.message);
            }
        };

        input.click();
    }

    // Helper methods for rewrite rules
    getPriorityClass(priority) {
        if (priority <= 50) return 'high';
        if (priority <= 200) return 'medium';
        return 'low';
    }

    getMatchTypeLabel(type) {
        const labels = {
            'url': 'URL',
            'method': '请求方法',
            'header': '请求头',
            'body': '请求体',
            'response-header': '响应头',
            'response-body': '响应体'
        };
        return labels[type] || type;
    }

    getActionTypeLabel(type) {
        const labels = {
            'replace-url': '替换 URL',
            'replace-host': '替换 Host',
            'replace-path': '替换 Path',
            'add-query': '增加 Query',
            'replace-query': '替换 Query',
            'remove-query': '删除 Query',
            'add-header': '增加 Header',
            'replace-header': '替换 Header',
            'remove-header': '删除 Header',
            'replace-body': '替换 Body',
            'redirect': '重定向',
            'replace': '替换',
            'add': '添加',
            'remove': '删除',
            'modify': '修改'
        };
        return labels[type] || type;
    }

    escapeHtml(text) {
        // 覆盖前面同名方法：属性值必须转义引号，否则 value="..." 会被截断导致表单坏掉
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.proxyApp = new ProxyApp();
});

// Handle window before unload
window.addEventListener('beforeunload', () => {
    // Stop proxy if running
    if (window.proxyApp && window.proxyApp.isRunning) {
        window.proxyApp.stopProxy();
    }
});