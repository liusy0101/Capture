class ProxyApp {
    constructor() {
        this.isRunning = false;
        this.currentFilter = 'all';
        this.packets = [];
        this.selectedPacket = null;
        this.autoScroll = true;
        this.rewriteRules = [];
        this.config = {
            port: 8080,
            enableHttps: true,
            enableLocalhost: true,
            autoSystemProxy: true,
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
        document.getElementById('certBtn').addEventListener('click', () => this.installCertificate());
        document.getElementById('configBtn').addEventListener('click', () => this.showConfigModal());
        const copyChromeHintBtn = document.getElementById('copyChromeHintBtn');
        if (copyChromeHintBtn) {
            copyChromeHintBtn.addEventListener('click', () => this.copyChromeHint());
        }

        // Filter chips
        document.querySelectorAll('.filter-chip').forEach(chip => {
            chip.addEventListener('click', () => this.setFilter(chip.dataset.filter));
        });

        // Tabs
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        // Search
        document.getElementById('searchBox').addEventListener('input', (e) => this.filterPackets(e.target.value));

        // Config modal
        document.getElementById('closeConfig').addEventListener('click', () => this.hideConfigModal());
        document.getElementById('cancelConfig').addEventListener('click', () => this.hideConfigModal());
        document.getElementById('saveConfig').addEventListener('click', () => this.saveConfig());

        // Rewrite rules
        document.getElementById('addRewriteRuleBtn').addEventListener('click', () => this.showAddRewriteRuleModal());
        document.getElementById('exportRewriteRulesBtn').addEventListener('click', () => this.exportRewriteRules());
        document.getElementById('importRewriteRulesBtn').addEventListener('click', () => this.importRewriteRules());
    }

    setupEventListeners() {
        // Listen for new packets
        window.electronAPI.onNewPacket((packet) => {
            this.addPacket(packet);
        });

        // Listen for WebSocket packets
        window.electronAPI.onWebSocketPacket((packet) => {
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
        tipEl.innerHTML = `
            <strong>抓包提示</strong>
            <ul>
              <li>HTTPS/WSS：点击「安装证书」，然后<strong>完全重启浏览器</strong></li>
              <li>本地 127.0.0.1/localhost：已写入 <code>&lt;-loopback&gt;</code>；若仍抓不到，用下方命令启动 Chrome/Edge</li>
              <li>抓完后请点「停止代理」，会自动恢复系统代理</li>
            </ul>
            <code class="chrome-hint">${chromeHint || ''}</code>
        `;
    }

    async installCertificate() {
        try {
            const result = await window.electronAPI.installCa();
            if (result.success) {
                this.showStatus(result.message || '证书已安装', 'success');
            } else {
                this.showError(result.error || '安装证书失败');
                // 失败时仍打开目录，方便手动导入
                await window.electronAPI.openCaDir();
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

    async stopProxy() {
        try {
            const result = await window.electronAPI.stopProxy();
            if (result.success) {
                this.isRunning = false;
                this.updateUI();
                this.showStatus('代理已停止，系统代理已恢复', 'info');
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
            if (result.success) {
                this.packets = [];
                this.selectedPacket = null;
                this.renderPacketList();
                this.renderPacketDetails();
                this.updatePacketCount();
            } else {
                this.showError('清除失败: ' + result.error);
            }
        } catch (error) {
            this.showError('清除失败: ' + error.message);
        }
    }

    addPacket(packet) {
        // Check if packet already exists (update)
        const existingIndex = this.packets.findIndex(p => p.id === packet.id);
        if (existingIndex >= 0) {
            this.packets[existingIndex] = packet;
        } else {
            this.packets.unshift(packet);
        }

        this.updatePacketCount();

        if (this.shouldDisplayPacket(packet)) {
            this.renderPacketList();
            
            // Auto scroll to top if enabled
            if (this.autoScroll && this.currentFilter === 'all') {
                const packetList = document.getElementById('packetList');
                packetList.scrollTop = 0;
            }
        }

        // Update selected packet if it's the same one
        if (this.selectedPacket && this.selectedPacket.id === packet.id) {
            this.selectedPacket = packet;
            this.renderPacketDetails();
        }
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
                this.renderPacketDetails();
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
        this.renderPacketList(searchTerm);
    }

    selectPacket(packetId) {
        this.selectedPacket = this.packets.find(p => p.id === packetId);
        
        // Update selection UI
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

    renderPacketList(searchTerm = '') {
        const packetList = document.getElementById('packetList');
        let filteredPackets = this.packets.filter(packet => this.shouldDisplayPacket(packet));

        // Apply search filter
        if (searchTerm) {
            const searchLower = searchTerm.toLowerCase();
            filteredPackets = filteredPackets.filter(packet => 
                packet.url.toLowerCase().includes(searchLower) ||
                packet.method.toLowerCase().includes(searchLower) ||
                JSON.stringify(packet.requestHeaders).toLowerCase().includes(searchLower)
            );
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

        packetList.innerHTML = filteredPackets.map(packet => {
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

            return `
                <li class="packet-item ${packet.protocol === 'ws' || packet.protocol === 'wss' ? 'ws-connection' : ''} ${packet.isError ? 'error' : ''}" 
                    data-packet-id="${packet.id}">
                    <div class="packet-method ${methodClass}">${method}</div>
                    <div class="packet-url">${this.truncateUrl(packet.url)}</div>
                    <div class="packet-meta">
                        <span class="packet-status ${statusClass}">${statusText}</span>
                        <span>${this.formatTime(packet.timestamp)}</span>
                    </div>
                </li>
            `;
        }).join('');

        // Add click listeners
        document.querySelectorAll('.packet-item').forEach(item => {
            item.addEventListener('click', () => this.selectPacket(item.dataset.packetId));
        });
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

        // Hide all content, show empty states
        Object.values(contents).forEach(content => content.style.display = 'none');
        Object.values(emptyStates).forEach(state => state.style.display = 'flex');

        // Update WebSocket tab visibility
        const wsTab = document.querySelector('.tab[data-tab="websocket"]');
        if (this.selectedPacket && (this.selectedPacket.protocol === 'ws' || this.selectedPacket.protocol === 'wss')) {
            wsTab.style.display = 'block';
        } else {
            wsTab.style.display = 'none';
        }

        if (!this.selectedPacket) {
            this.switchTab('overview');
            return;
        }

        // Show content, hide empty states
        Object.values(emptyStates).forEach(state => state.style.display = 'none');
        contents.overview.style.display = 'block';

        // Render overview
        this.renderOverview(contents.overview);
        
        // Render headers
        this.renderHeaders(contents.headers);
        
        // Render request
        this.renderRequestBody(contents.request);
        
        // Render response
        this.renderResponseBody(contents.response);
        
        // Render WebSocket messages
        if (this.selectedPacket.protocol === 'ws' || this.selectedPacket.protocol === 'wss') {
            this.renderWebSocketMessages(contents.websocket);
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
        
        if (!packet.requestBody) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-text">没有请求体数据</div></div>';
            return;
        }

        const content = typeof packet.requestBody === 'object' 
            ? JSON.stringify(packet.requestBody, null, 2)
            : packet.requestBody;

        container.innerHTML = `
            <div class="panel-section">
                <h3>请求体</h3>
                <div class="json-viewer">${this.syntaxHighlight(content)}</div>
            </div>
        `;
    }

    renderResponseBody(container) {
        const packet = this.selectedPacket;
        
        if (!packet.responseBody) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-text">没有响应体数据</div></div>';
            return;
        }

        const content = typeof packet.responseBody === 'object' 
            ? JSON.stringify(packet.responseBody, null, 2)
            : packet.responseBody;

        container.innerHTML = `
            <div class="panel-section">
                <h3>响应体</h3>
                <div class="json-viewer">${this.syntaxHighlight(content)}</div>
            </div>
        `;
    }

    renderWebSocketMessages(container) {
        const packet = this.selectedPacket;
        
        if (!packet.messages || packet.messages.length === 0) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-text">暂无WebSocket消息</div></div>';
            return;
        }

        const messagesHtml = `
            <div class="panel-section">
                <h3>WebSocket消息 (${packet.messages.length}条)</h3>
                <div class="ws-messages">
                    ${packet.messages.map(message => `
                        <div class="ws-message ${message.direction}">
                            <div class="ws-message-header">
                                <div class="ws-message-direction direction-${message.direction}">
                                    ${message.direction === 'incoming' ? '📥 接收' : '📤 发送'}
                                </div>
                                <div class="ws-message-time">${new Date(message.timestamp).toLocaleTimeString('zh-CN')}</div>
                            </div>
                            <div class="ws-message-content">
                                ${message.type === 'binary' ? '[二进制数据]' : this.formatMessageContent(message.content)}
                            </div>
                            <div class="ws-message-type">
                                类型: ${message.type} | 大小: ${this.formatSize(message.size)}
                                ${message.isMasked !== undefined ? ` | 屏蔽: ${message.isMasked}` : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;

        container.innerHTML = messagesHtml;
    }

    formatMessageContent(content) {
        if (typeof content === 'object') {
            try {
                return `<div class="json-viewer">${this.syntaxHighlight(JSON.stringify(content, null, 2))}</div>`;
            } catch (e) {
                return content.toString();
            }
        }
        return content.toString();
    }

    syntaxHighlight(json) {
        if (typeof json !== 'string') {
            json = JSON.stringify(json, null, 2);
        }
        
        json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        
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

    showConfigModal() {
        document.getElementById('configModal').style.display = 'flex';
    }

    hideConfigModal() {
        document.getElementById('configModal').style.display = 'none';
    }

    saveConfig() {
        this.config = {
            port: parseInt(document.getElementById('configPort').value),
            enableHttps: document.getElementById('configEnableHttps').checked,
            enableLocalhost: document.getElementById('configEnableLocalhost').checked,
            autoSystemProxy: document.getElementById('configAutoSystemProxy')
                ? document.getElementById('configAutoSystemProxy').checked
                : true,
            recordWebSocket: document.getElementById('configRecordWebSocket').checked,
            recordRequests: document.getElementById('configRecordRequests').checked,
            autoScroll: true
        };

        // Save to localStorage
        localStorage.setItem('proxyConfig', JSON.stringify(this.config));

        // Update proxy if running
        if (this.isRunning) {
            window.electronAPI.setProxyConfig(this.config);
        }

        this.updateUI();
        this.hideConfigModal();
        this.showStatus('配置已保存', 'success');
    }

    showStatus(message, type = 'info') {
        const statusText = document.getElementById('statusText');
        const originalText = statusText.textContent;
        statusText.textContent = message;
        statusText.style.color = type === 'success' ? '#4caf50' : type === 'error' ? '#f44336' : '';
        
        setTimeout(() => {
            statusText.textContent = originalText;
            statusText.style.color = '';
        }, 3000);
    }

    showError(message) {
        console.error(message);
        this.showStatus(message, 'error');
        // You could also show a toast notification here
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
        
        if (this.rewriteRules.length === 0) {
            container.innerHTML = `
                <div class="rewrite-empty-rules">
                    <div class="rewrite-empty-rules-icon">📝</div>
                    <div class="rewrite-empty-rules-text">暂无重写规则</div>
                    <div class="rewrite-empty-rules-hint">点击"添加规则"创建第一个重写规则</div>
                </div>
            `;
            return;
        }

        container.innerHTML = this.rewriteRules.sort((a, b) => a.priority - b.priority).map(rule => `
            <div class="rewrite-rule-item ${rule.enabled ? '' : 'disabled'}" data-rule-id="${rule.id}">
                <div class="rewrite-rule-header">
                    <div class="rewrite-rule-title">
                        <div class="rewrite-rule-status ${rule.enabled ? 'enabled' : ''}"></div>
                        <span class="rewrite-rule-name">${this.escapeHtml(rule.name)}</span>
                        <span class="rewrite-rule-priority ${this.getPriorityClass(rule.priority)}">P${rule.priority}</span>
                        <span class="rewrite-badge ${rule.applyTo}">${rule.applyTo === 'request' ? '请求' : rule.applyTo === 'response' ? '响应' : '双向'}</span>
                    </div>
                    <div class="rewrite-rule-actions">
                        <button class="btn-toggle ${rule.enabled ? 'enabled' : ''}" onclick="window.proxyApp.toggleRewriteRule('${rule.id}', ${!rule.enabled})">
                            ${rule.enabled ? '禁用' : '启用'}
                        </button>
                        <button class="btn-edit" onclick="window.proxyApp.editRewriteRule('${rule.id}')">编辑</button>
                        <button class="btn-delete" onclick="window.proxyApp.deleteRewriteRule('${rule.id}')">删除</button>
                    </div>
                </div>
                <div class="rewrite-rule-details">
                    <div class="rewrite-rule-detail">
                        <span class="rewrite-rule-detail-label">匹配类型</span>
                        <span class="rewrite-rule-detail-value">${this.getMatchTypeLabel(rule.matchType)}</span>
                    </div>
                    <div class="rewrite-rule-detail">
                        <span class="rewrite-rule-detail-label">操作类型</span>
                        <span class="rewrite-rule-detail-value">${this.getActionTypeLabel(rule.actionType)}</span>
                    </div>
                    <div class="rewrite-rule-detail">
                        <span class="rewrite-rule-detail-label">匹配模式</span>
                        <span class="rewrite-rule-detail-value highlight">${this.escapeHtml(rule.matchPattern)}</span>
                    </div>
                    <div class="rewrite-rule-detail">
                        <span class="rewrite-rule-detail-label">操作值</span>
                        <span class="rewrite-rule-detail-value">${this.escapeHtml(rule.actionValue)}</span>
                    </div>
                </div>
                ${rule.description ? `<div class="rewrite-rule-description">${this.escapeHtml(rule.description)}</div>` : ''}
            </div>
        `).join('');
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
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'rewriteRuleModal';
        
        const isEdit = rule !== null;
        const title = isEdit ? '编辑重写规则' : '添加重写规则';
        
        modal.innerHTML = `
            <div class="modal">
                <div class="modal-header">
                    <h2>${title}</h2>
                    <button class="modal-close" id="closeRewriteModal">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="rewrite-form-section">
                        <h4>基本信息</h4>
                        <div class="rewrite-form-row">
                            <div>
                                <label class="rewrite-form-label">规则名称 *</label>
                                <input type="text" class="rewrite-form-input" id="ruleName" value="${rule ? rule.name : ''}" placeholder="例如：替换API域名">
                            </div>
                            <div>
                                <label class="rewrite-form-label">优先级</label>
                                <input type="number" class="rewrite-form-input" id="rulePriority" value="${rule ? rule.priority : 100}" min="1" max="1000">
                            </div>
                        </div>
                        <div class="rewrite-form-row full-width">
                            <div>
                                <label class="rewrite-form-label">描述</label>
                                <textarea class="rewrite-form-textarea" id="ruleDescription" placeholder="规则描述...">${rule ? rule.description || '' : ''}</textarea>
                            </div>
                        </div>
                        <div class="rewrite-form-row">
                            <div class="rewrite-form-checkbox">
                                <input type="checkbox" id="ruleEnabled" ${rule ? (rule.enabled ? 'checked' : '') : 'checked'}>
                                <label for="ruleEnabled">启用规则</label>
                            </div>
                        </div>
                    </div>
                    
                    <div class="rewrite-form-section">
                        <h4>匹配条件</h4>
                        <div class="rewrite-form-row">
                            <div>
                                <label class="rewrite-form-label">应用范围</label>
                                <select class="rewrite-form-select" id="ruleApplyTo">
                                    <option value="request" ${rule && rule.applyTo === 'request' ? 'selected' : ''}>请求</option>
                                    <option value="response" ${rule && rule.applyTo === 'response' ? 'selected' : ''}>响应</option>
                                    <option value="both" ${rule && rule.applyTo === 'both' ? 'selected' : ''}>双向</option>
                                </select>
                            </div>
                            <div>
                                <label class="rewrite-form-label">匹配类型</label>
                                <select class="rewrite-form-select" id="ruleMatchType">
                                    <option value="url" ${rule && rule.matchType === 'url' ? 'selected' : ''}>URL</option>
                                    <option value="method" ${rule && rule.matchType === 'method' ? 'selected' : ''}>请求方法</option>
                                    <option value="header" ${rule && rule.matchType === 'header' ? 'selected' : ''}>请求头</option>
                                    <option value="body" ${rule && rule.matchType === 'body' ? 'selected' : ''}>请求体</option>
                                    <option value="response-header" ${rule && rule.matchType === 'response-header' ? 'selected' : ''}>响应头</option>
                                    <option value="response-body" ${rule && rule.matchType === 'response-body' ? 'selected' : ''}>响应体</option>
                                </select>
                            </div>
                        </div>
                        <div class="rewrite-form-row">
                            <div>
                                <label class="rewrite-form-label">匹配方式</label>
                                <select class="rewrite-form-select" id="ruleMatchOperator">
                                    <option value="contains" ${rule && rule.matchOperator === 'contains' ? 'selected' : ''}>包含</option>
                                    <option value="equals" ${rule && rule.matchOperator === 'equals' ? 'selected' : ''}>等于</option>
                                    <option value="regex" ${rule && rule.matchOperator === 'regex' ? 'selected' : ''}>正则表达式</option>
                                    <option value="starts-with" ${rule && rule.matchOperator === 'starts-with' ? 'selected' : ''}>开始于</option>
                                    <option value="ends-with" ${rule && rule.matchOperator === 'ends-with' ? 'selected' : ''}>结束于</option>
                                </select>
                            </div>
                            <div>
                                <label class="rewrite-form-label">匹配模式 *</label>
                                <input type="text" class="rewrite-form-input" id="ruleMatchPattern" value="${rule ? rule.matchPattern : ''}" placeholder="例如：api.example.com">
                            </div>
                        </div>
                        ${this.getMatchTypeTargetField(rule)}
                    </div>
                    
                    <div class="rewrite-form-section">
                        <h4>操作设置</h4>
                        <div class="rewrite-form-row">
                            <div>
                                <label class="rewrite-form-label">操作类型</label>
                                <select class="rewrite-form-select" id="ruleActionType">
                                    <option value="replace" ${rule && rule.actionType === 'replace' ? 'selected' : ''}>替换</option>
                                    <option value="add" ${rule && rule.actionType === 'add' ? 'selected' : ''}>添加</option>
                                    <option value="remove" ${rule && rule.actionType === 'remove' ? 'selected' : ''}>删除</option>
                                    <option value="modify" ${rule && rule.actionType === 'modify' ? 'selected' : ''}>修改</option>
                                    <option value="redirect" ${rule && rule.actionType === 'redirect' ? 'selected' : ''}>重定向</option>
                                </select>
                            </div>
                            <div>
                                <label class="rewrite-form-label">操作值 *</label>
                                <input type="text" class="rewrite-form-input" id="ruleActionValue" value="${rule ? rule.actionValue : ''}" placeholder="例如：api.local.dev">
                            </div>
                        </div>
                        <div class="rewrite-hint">提示：对于修改操作，可以使用 JavaScript 表达式，如 value.toUpperCase()</div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" id="cancelRewriteModal">取消</button>
                    <button class="btn-start" id="saveRewriteModal">${isEdit ? '更新规则' : '添加规则'}</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Bind events
        document.getElementById('closeRewriteModal').addEventListener('click', () => {
            document.body.removeChild(modal);
        });

        document.getElementById('cancelRewriteModal').addEventListener('click', () => {
            document.body.removeChild(modal);
        });

        document.getElementById('ruleMatchType').addEventListener('change', (e) => {
            this.updateMatchTypeTargetField(e.target.value, rule);
        });

        document.getElementById('saveRewriteModal').addEventListener('click', async () => {
            await this.saveRewriteRule(isEdit, rule);
            document.body.removeChild(modal);
        });
    }

    getMatchTypeTargetField(rule) {
        const matchType = rule ? rule.matchType : 'url';
        const needsTarget = ['header', 'response-header'].includes(matchType);
        
        if (!needsTarget) return '';
        
        return `
            <div class="rewrite-form-row">
                <div>
                    <label class="rewrite-form-label">目标头名称</label>
                    <input type="text" class="rewrite-form-input" id="ruleActionTarget" value="${rule ? rule.actionTarget || '' : ''}" placeholder="例如：Content-Type">
                </div>
            </div>
        `;
    }

    updateMatchTypeTargetField(matchType, existingRule) {
        const container = document.querySelector('.rewrite-form-section:nth-child(2) .rewrite-form-row:last-of-type');
        const needsTarget = ['header', 'response-header'].includes(matchType);
        
        if (needsTarget) {
            if (!container || !container.id.includes('target')) {
                const targetField = document.createElement('div');
                targetField.className = 'rewrite-form-row';
                targetField.innerHTML = `
                    <div>
                        <label class="rewrite-form-label">目标头名称</label>
                        <input type="text" class="rewrite-form-input" id="ruleActionTarget" value="${existingRule ? existingRule.actionTarget || '' : ''}" placeholder="例如：Content-Type">
                    </div>
                `;
                
                const matchSection = document.querySelectorAll('.rewrite-form-section')[1];
                matchSection.appendChild(targetField);
            }
        } else {
            const existingTargetField = document.querySelector('#ruleActionTarget');
            if (existingTargetField) {
                existingTargetField.closest('.rewrite-form-row').remove();
            }
        }
    }

    async saveRewriteRule(isEdit, existingRule) {
        const name = document.getElementById('ruleName').value.trim();
        const priority = parseInt(document.getElementById('rulePriority').value);
        const description = document.getElementById('ruleDescription').value.trim();
        const enabled = document.getElementById('ruleEnabled').checked;
        const applyTo = document.getElementById('ruleApplyTo').value;
        const matchType = document.getElementById('ruleMatchType').value;
        const matchOperator = document.getElementById('ruleMatchOperator').value;
        const matchPattern = document.getElementById('ruleMatchPattern').value.trim();
        const actionType = document.getElementById('ruleActionType').value;
        const actionValue = document.getElementById('ruleActionValue').value.trim();
        const actionTarget = document.getElementById('ruleActionTarget')?.value.trim() || '';

        if (!name) {
            this.showError('请输入规则名称');
            return;
        }

        if (!matchPattern) {
            this.showError('请输入匹配模式');
            return;
        }

        if (!actionValue) {
            this.showError('请输入操作值');
            return;
        }

        const ruleData = {
            name,
            priority,
            description,
            enabled,
            applyTo,
            matchType,
            matchOperator,
            matchPattern,
            actionType,
            actionValue,
            actionTarget: ['header', 'response-header'].includes(matchType) ? actionTarget : undefined
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
            } else {
                this.showError('保存失败: ' + result.error);
            }
        } catch (error) {
            this.showError('保存失败: ' + error.message);
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
            'replace': '替换',
            'add': '添加',
            'remove': '删除',
            'modify': '修改',
            'redirect': '重定向'
        };
        return labels[type] || type;
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
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