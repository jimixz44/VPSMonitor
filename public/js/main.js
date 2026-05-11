const API_URL = '/api';
let token = localStorage.getItem('vps_token');
let autoRefreshInterval = null;
let currentViewingLog = null;
let currentBotsList = [];
let prevBotStates = {}; // { fullName: isActive } for crash detection
let pinnedBots = JSON.parse(localStorage.getItem('pinnedBots') || '[]');
let tokenRefreshInterval = null;
let termTabs = []; // MUST be at top scope — used by openLog()

// --- Utility Functions ---
function showToast(msg, type='info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 3000);
}

async function apiCall(endpoint, method='GET', body=null, isFormData=false) {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (!isFormData && body) headers['Content-Type'] = 'application/json';

    const config = { method, headers };
    if (body) config.body = isFormData ? body : JSON.stringify(body);

    const res = await fetch(`${API_URL}${endpoint}`, config);
    if (res.status === 401 || res.status === 403) {
        logout();
        throw new Error("Unauthorized");
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API Error');
    return data;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
}

function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function hasConfiguredDirectory(bot) {
    return !!(bot && bot.savedDirectory && bot.savedDirectory !== 'Unknown');
}

// --- Navigation ---
function showScreen(id) {
    document.querySelectorAll('.screen-container').forEach(el => el.classList.remove('active', 'hidden'));
    document.querySelectorAll('.screen-container').forEach(el => {
        if(el.id !== id) el.classList.add('hidden');
    });
    document.getElementById(id).classList.add('active');
}

function showSection(id, eventOrElement=null) {
    document.querySelectorAll('.main-section').forEach(el => el.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
    
    if(eventOrElement) {
        document.querySelectorAll('.nav-links li').forEach(li => li.classList.remove('active'));
        const target = eventOrElement.currentTarget || eventOrElement;
        if(target && target.parentElement) {
            target.parentElement.classList.add('active');
        }
    }

    if (id === 'bots-section') {
        fetchBots();
        if(!autoRefreshInterval) autoRefreshInterval = setInterval(fetchBots, 5000);
    } else if (id === 'migrate-section') {
        fetchBotsForMigration();
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    } else {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    }
}

// --- Auth ---
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = document.getElementById('username').value;
    const p = document.getElementById('password').value;
    
    try {
        const res = await apiCall('/login', 'POST', { username: u, password: p });
        token = res.token;
        localStorage.setItem('vps_token', token);
        initDashboard();
        showToast('Login successful', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
});

function confirmLogout() {
    document.getElementById('confirm-title').innerText = `Logout`;
    document.getElementById('confirm-desc').innerHTML = `Are you sure you want to <strong>log out</strong> of your session?`;
    document.getElementById('confirm-modal').classList.add('active');
    
    document.getElementById('confirm-btn').onclick = () => {
        closeConfirmModal();
        logout();
    };
}

function logout() {
    token = null;
    localStorage.removeItem('vps_token');
    clearInterval(autoRefreshInterval);
    clearInterval(statsInterval);
    clearInterval(tokenRefreshInterval);
    statsInterval = null;
    autoRefreshInterval = null;
    tokenRefreshInterval = null;
    closeLog();
    showScreen('login-screen');
}

let statsInterval = null;

async function initDashboard() {
    showScreen('dashboard-screen');
    fetchSystemStats();
    showSection('bots-section');
    if (!statsInterval) statsInterval = setInterval(fetchSystemStats, 5000);
    // JWT auto-refresh every 30 mins
    if (!tokenRefreshInterval) {
        tokenRefreshInterval = setInterval(async () => {
            try {
                const res = await apiCall('/refresh-token', 'POST');
                token = res.token;
                localStorage.setItem('vps_token', token);
            } catch(e) { console.warn('Token refresh failed:', e); }
        }, 30 * 60 * 1000);
    }
    // Request browser notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
    // Init theme — sync button label with current theme state
    applyTheme(localStorage.getItem('theme') || 'dark');
}

async function fetchSystemStats() {
    try {
        const data = await apiCall('/system');
        document.getElementById('cpu-stat').innerText = `${data.cpu.usage}%`;
        document.getElementById('cpu-fill').style.width = `${data.cpu.usage}%`;
        
        document.getElementById('ram-stat').innerText = `${data.memory.usedPercent}%`;
        document.getElementById('ram-fill').style.width = `${data.memory.usedPercent}%`;
        
        const hrs = Math.floor(data.uptime / 3600);
        const mins = Math.floor((data.uptime % 3600) / 60);
        document.getElementById('uptime-stat').innerText = `${hrs}h ${mins}m`;
        
        if (data.ip) {
            document.getElementById('vps-ip-title').innerText = data.ip;
        }
    } catch(err) { console.error('Stat err:', err); }
}

async function fetchBots() {
    try {
        const data = await apiCall('/bots');
        const container = document.getElementById('bots-container');
        const runningBadge = document.getElementById('bot-count-running');
        const idleBadge = document.getElementById('bot-count-idle');

        if (data.screens) {
            let runningCount = 0;
            let idleCount = 0;
            data.screens.forEach(s => {
                if (s.isActive) runningCount++;
                else idleCount++;
            });
            if (runningBadge) runningBadge.innerHTML = `<span style="width: 6px; height: 6px; border-radius: 50%; background: var(--success);"></span>${runningCount} Running`;
            if (idleBadge) idleBadge.innerHTML = `<span style="width: 6px; height: 6px; border-radius: 50%; background: var(--danger);"></span>${idleCount} Idle`;
        }

        if (!data.screens || data.screens.length === 0) {
            currentBotsList = [];
            container.innerHTML = '<div class="empty-state">No running bot sessions found.</div>';
            return;
        }

        // Crash detection
        data.screens.forEach(s => {
            const prev = prevBotStates[s.fullName];
            if (prev === true && s.isActive === false) {
                notifyCrash(s.name);
            }
            prevBotStates[s.fullName] = s.isActive;
        });

        currentBotsList = data.screens;
        renderBots();
    } catch(err) { console.error('Bots err:', err); }
}

function notifyCrash(name) {
    showToast(`⚠️ Bot "${name}" stopped running!`, 'error');
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Bot Crashed', {
            body: `"${name}" has stopped. Check the terminal for errors.`,
            icon: '/favicon.ico'
        });
    }
}

function formatUptime(startTime) {
    if (!startTime) return '';
    const ms = Date.now() - startTime;
    const totalSecs = Math.floor(ms / 1000);
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function togglePin(name) {
    const idx = pinnedBots.indexOf(name);
    if (idx === -1) pinnedBots.push(name);
    else pinnedBots.splice(idx, 1);
    localStorage.setItem('pinnedBots', JSON.stringify(pinnedBots));
    renderBots();
}

function renderBots() {
    const container = document.getElementById('bots-container');
    const searchTerm = (document.getElementById('bot-search').value || '').toLowerCase();
    let filtered = currentBotsList.filter(s =>
        String(s.name || '').toLowerCase().includes(searchTerm) ||
        String(s.pid || '').includes(searchTerm)
    );

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state">No bots match your search.</div>';
        return;
    }

    filtered.sort((a, b) => {
        // 1. Pinned bots always on top
        const ap = pinnedBots.includes(a.name) ? 0 : 1;
        const bp = pinnedBots.includes(b.name) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        
        // 2. Running bots above stopped/idle bots
        const aRunning = a.isActive ? 0 : 1;
        const bRunning = b.isActive ? 0 : 1;
        if (aRunning !== bRunning) return aRunning - bRunning;
        
        // 3. Alphabetical fallback
        return String(a.name).localeCompare(String(b.name));
    });

    container.innerHTML = filtered.map(s => {
        const isPinned = pinnedBots.includes(s.name);
        const uptime = formatUptime(s.startTime);
        const canOpenFiles = hasConfiguredDirectory(s);
        const statusClass = s.status ? String(s.status).toLowerCase() : 'unknown';
        const stateClass = s.isActive ? 'running' : 'idle';
        const commandHtml = s.savedCommand
            ? escapeHtml(s.savedCommand)
            : '<span class="empty-command">No cmd configured</span>';
        const directoryHtml = canOpenFiles ? escapeHtml(s.savedDirectory) : 'No folder set';

        return `
        <div class="bot-card ${isPinned ? 'pinned-card' : ''}">
            <div class="bot-header">
                <div class="bot-titleline">
                    <div class="bot-name">
                        <span class="bot-pid">#${escapeHtml(s.pid)}</span>
                        <span>${escapeHtml(s.name)}</span>
                    </div>
                    <div class="bot-card-tools">
                        <button class="btn-pin ${isPinned ? 'pinned' : ''}" data-name="${escapeAttr(s.name)}" onclick="togglePin(this.dataset.name)" title="${isPinned ? 'Unpin' : 'Pin to top'}">
                            <i data-lucide="star" fill="${isPinned ? 'currentColor' : 'none'}"></i>
                        </button>
                        <span class="status-badge ${escapeAttr(statusClass)}">${escapeHtml(s.status || 'Unknown')}</span>
                    </div>
                </div>
                <div class="bot-meta">
                    <span class="bot-command"><i data-lucide="terminal-square"></i> ${commandHtml}</span>
                    <span class="run-state ${stateClass}"><span class="state-dot"></span>${s.isActive ? 'Running' : 'Idle'}</span>
                    ${s.cpu !== undefined ? `<span><i data-lucide="cpu"></i> ${escapeHtml(s.cpu)}%</span>` : ''}
                    ${s.mem !== undefined ? `<span><i data-lucide="memory-stick"></i> ${escapeHtml(s.mem)}%</span>` : ''}
                    ${uptime ? `<span><i data-lucide="clock"></i> ${escapeHtml(uptime)}</span>` : ''}
                    <span class="bot-directory ${canOpenFiles ? '' : 'missing'}"><i data-lucide="folder"></i> ${directoryHtml}</span>
                </div>
            </div>
            <div class="bot-actions">
                <button class="btn-action btn-log" data-name="${escapeAttr(s.fullName)}" onclick="openLog(this.dataset.name)"><i data-lucide="terminal"></i> Terminal</button>
                <button class="btn-action btn-files" data-name="${escapeAttr(s.name)}" onclick="openBotFilesByName(this.dataset.name)" ${canOpenFiles ? '' : 'disabled'} title="${canOpenFiles ? 'Open configured bot directory' : 'Set bot directory first'}"><i data-lucide="folder-open"></i> File</button>
                <button class="btn-action btn-restart" data-name="${escapeAttr(s.fullName)}" onclick="doRestartByName(this.dataset.name)"><i data-lucide="refresh-cw"></i> Restart</button>
                <button class="btn-action btn-stop" data-name="${escapeAttr(s.fullName)}" onclick="confirmBotAction('stop', this.dataset.name)"><i data-lucide="square"></i> Stop</button>
                <button class="btn-action btn-kill" data-name="${escapeAttr(s.fullName)}" onclick="confirmBotAction('kill', this.dataset.name)"><i data-lucide="trash-2"></i> Kill</button>
                <button class="btn-action btn-config" data-name="${escapeAttr(s.name)}" onclick="setCommandByName(this.dataset.name)" title="Bot Configuration"><i data-lucide="settings"></i> Set</button>
            </div>
        </div>`;
    }).join('');
    lucide.createIcons();
}

function confirmBotAction(action, name) {
    document.getElementById('confirm-title').innerText = `${action.toUpperCase()} Bot`;
    document.getElementById('confirm-desc').innerHTML = `Are you sure you want to <strong>${action}</strong> the bot <strong>${name}</strong>?`;
    document.getElementById('confirm-modal').classList.add('active');
    
    document.getElementById('confirm-btn').onclick = () => {
        closeConfirmModal();
        botAction(action, name);
    };
}

function closeConfirmModal() {
    document.getElementById('confirm-modal').classList.remove('active');
}

async function botAction(action, name, command=null) {
    try {
        const body = { name };
        if (command) body.command = command;
        await apiCall(`/${action}`, 'POST', body);
        showToast(`${action} command sent successfully`, 'success');
        fetchBots();
    } catch (err) {
        showToast(`Failed: ${err.message}`, 'error');
    }
}

function closeSetCmdModal() {
    document.getElementById('set-cmd-modal').classList.remove('active');
}

document.getElementById('set-cmd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('set-cmd-name').value;
    const cmd = document.getElementById('set-cmd-input').value.trim();
    const dir = document.getElementById('set-dir-input').value.trim();
    
    if (cmd !== '' && dir !== '') {
        try {
            await apiCall('/set-command', 'POST', { name, command: cmd, directory: dir });
            showToast('Configuration updated', 'success');
            closeSetCmdModal();
            fetchBots();
        } catch (err) {
            showToast(err.message, 'error');
        }
    } else {
        showToast('Command and Directory cannot be empty', 'error');
    }
});

/** Called from bot card Restart button — looks up data from currentBotsList to avoid inline quoting issues */
function doRestartByName(fullName) {
    const bot = currentBotsList.find(b => b.fullName === fullName);
    if (!bot) return showToast('Bot not found', 'error');
    doRestart(bot.fullName, bot.savedCommand);
}

/** Called from bot card Set button — safely reads all fields from currentBotsList */
function setCommandByName(name) {
    const bot = currentBotsList.find(b => b.name === name);
    if (!bot) return showToast('Bot not found', 'error');
    setCommand(bot.name, bot.savedCommand, bot.savedDirectory || bot.cwd);
}

function doRestart(fullName, savedCmd) {
    if (savedCmd && savedCmd.trim() !== '') {
        // Restart uses savedCommand — inject safely via data-attribute in renderBots()
        // doRestart is called from an inline onclick, so the command must be pre-encoded.
        // We use a data map to avoid quoting issues in HTML attributes.
        botAction('restart', fullName, savedCmd);
    } else {
        // Extract base name
        const name = fullName.split('.').slice(1).join('.');
        setCommand(name, '', '');
        showToast('Please configure the bot command and directory first', 'warning');
    }
}

function setCommand(name, currentCmd, currentDir) {
    document.getElementById('set-cmd-name').value = name;
    document.getElementById('set-cmd-bot-name').innerText = name;
    document.getElementById('set-cmd-input').value = currentCmd || '';
    document.getElementById('set-dir-input').value = currentDir || '';
    updateCrontabPreview();
    document.getElementById('set-cmd-modal').classList.add('active');
    // Live update crontab preview as user types
    document.getElementById('set-cmd-input').oninput = updateCrontabPreview;
    document.getElementById('set-dir-input').oninput = updateCrontabPreview;
}

function updateCrontabPreview() {
    const name = document.getElementById('set-cmd-name').value;
    const cmd = document.getElementById('set-cmd-input').value.trim();
    const dir = document.getElementById('set-dir-input').value.trim();
    const box = document.getElementById('crontab-preview');
    const copyBtn = document.getElementById('crontab-copy-btn');
    if (!box) return;
    if (cmd && dir && name) {
        const cronCmd = `@reboot cd ${dir} && screen -dmS ${name} bash -c '${cmd}'`;
        box.innerHTML = `<span id="crontab-text">${cronCmd}</span><button type="button" class="crontab-copy-btn" onclick="copyCrontab()"><i data-lucide="copy" style="width:12px;height:12px;"></i> Copy</button>`;
        lucide.createIcons();
    } else {
        box.innerHTML = '<span style="color: var(--text-muted);">Fill command & directory above to generate...</span>';
    }
}
async function copyCrontab() {
    const el = document.getElementById('crontab-text');
    if (!el) return;
    await navigator.clipboard.writeText(el.innerText);
    showToast('Crontab command copied! Add to: crontab -e', 'success');
}

// --- xterm.js WebSocket Terminal ---
let xtermInstance = null;
let xtermFitAddon = null;
let terminalSocket = null;
let termResizeObserver = null;

/**
 * Directly focus the xterm.js input textarea.
 * xterm creates a hidden <textarea class="xterm-helper-textarea"> for keyboard input.
 * We must focus THIS element — not the canvas, not the container.
 * This is exactly what ttyd/wetty/gotty do internally.
 */
function focusXterm() {
    if (!xtermInstance) return;
    // Method 1: direct DOM — most reliable
    const ta = document.querySelector('#xterm-container .xterm-helper-textarea');
    if (ta) {
        ta.focus({ preventScroll: true });
        return;
    }
    // Method 2: xterm API fallback
    try { xtermInstance.focus(); } catch(e) {}
}

function openLog(screenFullName) {
    currentViewingLog = screenFullName;

    if (!termTabs.includes(screenFullName)) termTabs.push(screenFullName);
    renderTermTabs();

    document.getElementById('term-status').innerText = 'Connecting...';
    document.getElementById('term-status').style.color = 'var(--text-muted)';
    document.getElementById('log-modal').classList.add('active');

    // Tear down previous session
    if (terminalSocket) { try { terminalSocket.close(); } catch {} terminalSocket = null; }
    if (xtermInstance) { try { xtermInstance.dispose(); } catch {} xtermInstance = null; }
    if (termResizeObserver) { termResizeObserver.disconnect(); termResizeObserver = null; }

    const container = document.getElementById('xterm-container');
    container.innerHTML = '';

    const term = new Terminal({
        theme: {
            background: '#0d0d0d',
            foreground: '#e2e8f0',
            cursor: '#6366f1',
            selectionBackground: 'rgba(99,102,241,0.3)',
        },
        fontFamily: "'Consolas', 'Menlo', 'Courier New', monospace",
        fontSize: 14,
        lineHeight: 1.4,
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    xtermInstance = term;
    xtermFitAddon = fitAddon;

    // Send keyboard input from xterm → WebSocket (xterm.onData fires when textarea is focused)
    term.onData(data => {
        if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
            terminalSocket.send(JSON.stringify({ type: 'input', data }));
        }
    });

    term.onResize(({ cols, rows }) => {
        if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
            terminalSocket.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
    });

    // Focus xterm on any mousedown inside the terminal window
    const termWin = document.getElementById('terminal-main-window');
    termWin.addEventListener('mousedown', (e) => {
        if (e.target.closest('.terminal-header')) return;
        // DO NOT e.preventDefault() here, it breaks xterm's internal click handling and selection!
        setTimeout(() => focusXterm(), 10);
    });

    // Also focus on touch (mobile)
    container.addEventListener('touchstart', () => focusXterm(), { passive: true });

    // Fit + connect after modal is rendered
    const isMobile = window.innerWidth <= 768;
    setTimeout(() => {
        if (isMobile) {
            const win = document.getElementById('terminal-main-window');
            const header = win?.querySelector('.terminal-header');
            container.style.height = ((win?.offsetHeight || window.innerHeight) - (header?.offsetHeight || 50)) + 'px';
        }
        try { fitAddon.fit(); } catch(e) {}
        connectTerminalWS(term, fitAddon, screenFullName);
        setTimeout(() => { try { fitAddon.fit(); } catch(e) {} }, 300);
    }, isMobile ? 500 : 150);

    // Auto-resize on window resize
    termResizeObserver = new ResizeObserver(() => { try { fitAddon.fit(); } catch(e) {} });
    termResizeObserver.observe(container);
}

let wsReconnectTimeout = null;

function connectTerminalWS(term, fitAddon, screenFullName, isReconnect = false) {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const dims = fitAddon.proposeDimensions() || { cols: 220, rows: 50 };
    const wsUrl = `${protocol}://${location.host}/terminal?token=${encodeURIComponent(token)}&screen=${encodeURIComponent(screenFullName)}&cols=${dims.cols}&rows=${dims.rows}`;

    const ws = new WebSocket(wsUrl);
    terminalSocket = ws;

    ws.onopen = () => {
        document.getElementById('term-status').innerText = '\u25cf Connected';
        document.getElementById('term-status').style.color = 'var(--success)';
        if (isReconnect) term.writeln('\r\n\x1b[32m[Reconnected]\x1b[0m');
        // Focus the xterm textarea now that WS is ready
        focusXterm();
    };

    ws.onmessage = (e) => {
        try { term.write(e.data); } catch(err) {}
    };

    ws.onclose = () => {
        if (currentViewingLog !== screenFullName) return;
        document.getElementById('term-status').innerText = '\u25cb Reconnecting...';
        document.getElementById('term-status').style.color = 'var(--warning)';
        clearTimeout(wsReconnectTimeout);
        wsReconnectTimeout = setTimeout(() => {
            if (currentViewingLog === screenFullName) connectTerminalWS(term, fitAddon, screenFullName, true);
        }, 3000);
    };

    ws.onerror = () => {
        if (!isReconnect) term.writeln('\r\n\x1b[31m[Connection error — check server]\x1b[0m');
    };
}

function closeLog() {
    document.getElementById('log-modal').classList.remove('active');
    if (terminalSocket) { try { terminalSocket.close(); } catch {} terminalSocket = null; }
    if (xtermInstance) { try { xtermInstance.dispose(); } catch {} xtermInstance = null; }
    if (termResizeObserver) { termResizeObserver.disconnect(); termResizeObserver = null; }
    clearTimeout(wsReconnectTimeout);
    currentViewingLog = null;
    termTabs = [];
    const tabContainer = document.getElementById('term-tabs');
    if (tabContainer) tabContainer.innerHTML = '';
}

// Multi-tab rendering
function renderTermTabs() {
    const container = document.getElementById('term-tabs');
    if (!container) return;
    container.innerHTML = termTabs.map(tab => `
        <div class="term-tab ${tab === currentViewingLog ? 'active' : ''}" onclick="openLog('${tab}')">
            <i data-lucide="terminal-square" style="width:12px;height:12px;"></i> ${tab}
            <button class="term-tab-close" onclick="closeTermTab(event, '${tab}')">&times;</button>
        </div>
    `).join('');
    lucide.createIcons();
}

function closeTermTab(e, tabName) {
    e.stopPropagation();
    termTabs = termTabs.filter(t => t !== tabName);
    if (termTabs.length === 0) {
        closeLog();
    } else if (currentViewingLog === tabName) {
        openLog(termTabs[termTabs.length - 1]);
    } else {
        renderTermTabs();
    }
}


// --- File Upload & Launch ---
let currentLaunchMode = 'upload';

function switchLaunchMode(mode, el) {
    currentLaunchMode = mode;
    document.getElementById('mode-upload').classList.toggle('hidden', mode !== 'upload');
    document.getElementById('mode-existing').classList.toggle('hidden', mode !== 'existing');
    
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    if (el) el.classList.add('active');

    // Update button state
    const btn = document.getElementById('btn-launch');
    if (mode === 'upload') {
        btn.disabled = !selectedFiles;
        btn.innerText = 'Upload & Launch Bot';
    } else {
        btn.disabled = false;
        btn.innerText = 'Launch Bot in Path';
    }
}

const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('folder-input');
let selectedFiles = null;

uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

function handleFiles(files) {
    if(files.length > 0) {
        selectedFiles = files;
        document.getElementById('upload-status').innerText = `${files.length} files selected ready to upload.`;
        document.getElementById('btn-launch').disabled = false;
    }
}

document.getElementById('launch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const name = document.getElementById('new-bot-name').value;
    const cmd = document.getElementById('new-bot-cmd').value;
    const btn = document.getElementById('btn-launch');
    
    try {
        btn.disabled = true;

        // Duplicate name check
        const checkRes = await apiCall(`/check-name/${encodeURIComponent(name)}`);
        if (checkRes.exists) {
            btn.disabled = false;
            return showToast(`A bot named "${name}" is already running!`, "error");
        }

        let finalPath = '';

        if (currentLaunchMode === 'upload') {
            if(!selectedFiles) return showToast("Please select a folder first", "error");
            btn.innerText = "Uploading...";
            
            const formData = new FormData();
            formData.append('folderName', name);
            for(let i=0; i<selectedFiles.length; i++) {
                formData.append('files', selectedFiles[i]);
                const path = selectedFiles[i].webkitRelativePath || selectedFiles[i].name;
                formData.append('paths', path);
            }
            const uploadRes = await apiCall('/upload-folder', 'POST', formData, true);
            finalPath = uploadRes.destPath;
        } else {
            finalPath = document.getElementById('existing-path').value.trim();
            if(!finalPath) return showToast("Please provide an absolute path", "error");
        }

        btn.innerText = "Starting screen...";
        await apiCall('/launch', 'POST', {
            name: name,
            command: cmd,
            directoryPath: finalPath
        });

        showToast("Bot launched successfully!", "success");
        document.getElementById('launch-form').reset();
        selectedFiles = null;
        document.getElementById('upload-status').innerText = "";
        showSection('bots-section', document.querySelector('.nav-links li:first-child a'));
    } catch (err) {
        showToast(err.message, "error");
    } finally {
        btn.disabled = currentLaunchMode === 'upload' && !selectedFiles;
        btn.innerText = currentLaunchMode === 'upload' ? "Upload & Launch Bot" : "Launch Bot in Path";
    }
});

// --- Settings ---
document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('set-username').value;
    const newPassword = document.getElementById('set-new-password').value;
    const oldPassword = document.getElementById('set-old-password').value;

    try {
        await apiCall('/settings', 'POST', { username, newPassword, oldPassword });
        showToast('Settings updated successfully', 'success');
        document.getElementById('settings-form').reset();
    } catch(err) {
        showToast(err.message, 'error');
    }
});

// --- File Explorer & Picker ---
let fileBrowserMode = 'explorer'; // 'explorer', 'picker_launch', 'picker_set', 'session_files'
let currentBrowsePath = '/';
let lastDirectoryHtml = '';

function goBackToBrowser() {
    document.getElementById('files-content').innerHTML = lastDirectoryHtml;
    const backBtn = document.getElementById('files-btn-back');
    if (backBtn) backBtn.style.display = 'none';
    document.getElementById('files-btn-select').style.display = fileBrowserMode.startsWith('picker') ? 'flex' : 'none';
}



let activeFileBotName = '';
let activeFileRoot = '';
let activeFileParentPath = '';
let editingFilePath = '';
let activeFileOriginal = '';
let activeFileDirty = false;
let monacoEditor = null;
let monacoLoadPromise = null;
let suppressFileDirty = false;

function openBotFilesByName(name) {
    const bot = currentBotsList.find(b => b.name === name);
    if (!bot) return showToast('Bot not found', 'error');
    if (!hasConfiguredDirectory(bot)) {
        showToast('Set bot directory first', 'warning');
        setCommand(bot.name, bot.savedCommand, bot.savedDirectory || bot.cwd || '');
        return;
    }
    openFileBrowser('session_files', '', bot.name);
}

function openFileBrowser(mode, startPath = '', botName = '') {
    if (startPath === 'Unknown') startPath = '/';
    fileBrowserMode = mode;
    activeFileBotName = mode === 'session_files' ? botName : '';
    activeFileRoot = '';
    activeFileParentPath = '';
    editingFilePath = '';
    activeFileOriginal = '';
    setFileDirty(false);

    const modal = document.getElementById('files-modal');
    const workspace = document.getElementById('file-workspace');
    modal.classList.add('active');
    workspace?.classList.toggle('picker-mode', mode.startsWith('picker'));
    workspace?.classList.toggle('editor-mode', mode === 'session_files');

    document.getElementById('files-btn-select').style.display = mode.startsWith('picker') ? 'inline-flex' : 'none';
    document.getElementById('file-save-btn').style.display = mode === 'session_files' ? 'inline-flex' : 'none';
    document.getElementById('file-save-btn').disabled = true;
    document.getElementById('files-title').innerText = mode === 'session_files' ? `Files: ${botName}` : 'Browse VPS Folder';
    document.getElementById('file-root-label').innerText = mode === 'session_files' ? botName : 'VPS';
    showEditorEmptyState('Select a text file to edit.');

    fetchDirectory(startPath || '');
}

function closeFileBrowser() {
    if (!confirmDiscardFileChanges()) return;
    document.getElementById('files-modal').classList.remove('active');
    activeFileBotName = '';
    activeFileRoot = '';
    activeFileParentPath = '';
    editingFilePath = '';
    activeFileOriginal = '';
    setFileDirty(false);
}

function selectFolder() {
    if (fileBrowserMode === 'picker_launch') {
        document.getElementById('existing-path').value = currentBrowsePath;
    } else if (fileBrowserMode === 'picker_set') {
        document.getElementById('set-dir-input').value = currentBrowsePath;
        updateCrontabPreview();
    }
    closeFileBrowser();
}

function goUpDirectory() {
    if (fileBrowserMode === 'session_files') {
        fetchDirectory(activeFileParentPath || '');
        return;
    }

    fetchDirectory(getPickerParentPath(currentBrowsePath));
}

function getPickerParentPath(value) {
    const normalized = String(value || '').replace(/\\/g, '/');
    if (!normalized || normalized === '/') return '/';
    if (/^[A-Za-z]:\/?$/.test(normalized)) {
        return normalized.endsWith('/') ? normalized : `${normalized}/`;
    }
    const parent = normalized.split('/').slice(0, -1).join('/') || '/';
    if (/^[A-Za-z]:$/.test(parent)) return `${parent}/`;
    return parent;
}

function refreshFilePanel() {
    fetchDirectory(currentBrowsePath || '');
}

async function fetchDirectory(targetPath = '') {
    if (fileBrowserMode === 'session_files') {
        await fetchBotDirectory(targetPath);
    } else {
        await fetchPickerDirectory(targetPath);
    }
}

async function fetchPickerDirectory(targetPath = '') {
    const container = document.getElementById('files-content');
    container.innerHTML = '<div class="file-loading">Loading directory...</div>';
    try {
        const data = await apiCall(`/dirs?path=${encodeURIComponent(targetPath || '/')}`);
        currentBrowsePath = data.currentPath;
        document.getElementById('files-current-path').value = currentBrowsePath;
        document.getElementById('files-title').innerText = currentBrowsePath;

        const rows = [];
        if (currentBrowsePath !== '/' && currentBrowsePath !== 'C:\\') {
            rows.push(`
                <button class="file-row folder-row" onclick="goUpDirectory()">
                    <i data-lucide="corner-left-up"></i>
                    <span class="file-name">..</span>
                    <span class="file-meta">Parent folder</span>
                </button>`);
        }

        (data.items || []).forEach(item => {
            if (!item.isDir) return;
            rows.push(`
                <button class="file-row folder-row" data-path="${escapeAttr(item.path)}" onclick="fetchDirectory(this.dataset.path)">
                    <i data-lucide="folder"></i>
                    <span class="file-name">${escapeHtml(item.name)}</span>
                    <span class="file-meta">Folder</span>
                </button>`);
        });

        container.innerHTML = rows.join('') || '<div class="empty-state">No folders found.</div>';
        lucide.createIcons();
    } catch (err) {
        container.innerHTML = `<div class="file-error">${escapeHtml(err.message)}</div>`;
    }
}

async function fetchBotDirectory(relativePath = '') {
    const container = document.getElementById('files-content');
    container.innerHTML = '<div class="file-loading">Loading files...</div>';

    try {
        const data = await apiCall(`/files/list?name=${encodeURIComponent(activeFileBotName)}&path=${encodeURIComponent(relativePath || '')}`);
        currentBrowsePath = data.currentPath || '';
        activeFileRoot = data.root || '';
        activeFileParentPath = data.parentPath || '';

        document.getElementById('files-current-path').value = formatDisplayFilePath(activeFileRoot, currentBrowsePath);
        document.getElementById('files-title').innerText = `${activeFileBotName} files`;
        document.getElementById('file-root-label').innerText = activeFileRoot;

        const rows = [];
        if (currentBrowsePath) {
            rows.push(`
                <button class="file-row folder-row" onclick="goUpDirectory()">
                    <i data-lucide="corner-left-up"></i>
                    <span class="file-name">..</span>
                    <span class="file-meta">Parent folder</span>
                </button>`);
        }

        (data.items || []).forEach(item => {
            const icon = item.isDir ? 'folder' : getFileIcon(item.name);
            const typeClass = item.isDir ? 'folder-row' : 'text-row';
            const action = item.isDir
                ? 'fetchDirectory(this.dataset.path)'
                : 'openEditor(this.dataset.path, this.dataset.name)';
            const hiddenBadge = item.isHidden ? '<span class="file-hidden-badge">hidden</span>' : '';
            const meta = item.isDir ? 'Folder' : formatBytes(item.size);

            rows.push(`
                <button class="file-row ${typeClass} ${item.isHidden ? 'is-hidden-file' : ''}" data-path="${escapeAttr(item.path)}" data-name="${escapeAttr(item.name)}" onclick="${action}">
                    <i data-lucide="${icon}"></i>
                    <span class="file-name">${escapeHtml(item.name)}${hiddenBadge}</span>
                    <span class="file-meta">${escapeHtml(meta)}</span>
                </button>`);
        });

        container.innerHTML = rows.join('') || '<div class="empty-state">This folder is empty.</div>';
        lucide.createIcons();
    } catch (err) {
        container.innerHTML = `<div class="file-error">${escapeHtml(err.message)}</div>`;
    }
}

function formatDisplayFilePath(root, relPath) {
    if (!root) return relPath || '/';
    if (!relPath) return root;
    const separator = root.endsWith('/') || root.endsWith('\\') ? '' : '/';
    return `${root}${separator}${relPath}`;
}

function getFileIcon(name) {
    const lower = String(name || '').toLowerCase();
    if (lower.endsWith('.json')) return 'braces';
    if (lower.endsWith('.js') || lower.endsWith('.ts')) return 'file-code-2';
    if (lower.endsWith('.env') || lower === '.env') return 'key-round';
    if (lower.endsWith('.md')) return 'file-text';
    if (lower.endsWith('.html') || lower.endsWith('.css') || lower.endsWith('.php')) return 'file-code-2';
    return 'file-text';
}

function getEditorLanguage(fileName) {
    const lower = String(fileName || '').toLowerCase();
    if (lower === '.env' || lower.endsWith('.env') || lower.endsWith('.ini')) return 'ini';
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
    if (lower.endsWith('.ts')) return 'typescript';
    if (lower.endsWith('.html')) return 'html';
    if (lower.endsWith('.css')) return 'css';
    if (lower.endsWith('.md')) return 'markdown';
    if (lower.endsWith('.php')) return 'php';
    if (lower.endsWith('.py')) return 'python';
    if (lower.endsWith('.sh')) return 'shell';
    if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
    return 'plaintext';
}

async function openEditor(filePath, fileName) {
    if (fileBrowserMode.startsWith('picker')) return;
    if (!confirmDiscardFileChanges()) return;

    try {
        const data = await apiCall(`/files/read?name=${encodeURIComponent(activeFileBotName)}&path=${encodeURIComponent(filePath)}`);
        editingFilePath = data.path;
        activeFileOriginal = data.content || '';
        document.getElementById('editor-filename').innerText = data.name || fileName || editingFilePath;
        document.getElementById('file-active-tab').innerHTML = `<i data-lucide="${getFileIcon(data.name || fileName)}"></i><span>${escapeHtml(data.name || fileName || editingFilePath)}</span>`;
        document.getElementById('file-status-path').innerText = formatDisplayFilePath(activeFileRoot, editingFilePath);
        document.getElementById('file-status-size').innerText = formatBytes(data.size);
        document.getElementById('file-empty-state').classList.add('hidden');
        document.getElementById('editor-content').classList.remove('hidden');
        document.getElementById('monaco-editor').classList.remove('hidden');

        await setEditorValue(activeFileOriginal, getEditorLanguage(data.name || fileName));
        setFileDirty(false);
        lucide.createIcons();
    } catch (err) {
        showToast(`Failed to open file: ${err.message}`, 'error');
    }
}

async function setEditorValue(content, language) {
    const usingMonaco = await ensureMonacoEditor(language);
    suppressFileDirty = true;
    if (usingMonaco && monacoEditor) {
        monacoEditor.setValue(content);
        const model = monacoEditor.getModel();
        if (model && window.monaco?.editor) {
            window.monaco.editor.setModelLanguage(model, language || 'plaintext');
        }
        setTimeout(() => monacoEditor.layout(), 0);
    } else {
        const textarea = document.getElementById('editor-content');
        textarea.value = content;
        textarea.focus();
    }
    suppressFileDirty = false;
}

async function ensureMonacoEditor(language = 'plaintext') {
    const host = document.getElementById('monaco-editor');
    const textarea = document.getElementById('editor-content');
    if (!host || !textarea) return false;

    if (window.monaco?.editor) {
        textarea.classList.add('hidden');
        host.classList.remove('hidden');
        if (!monacoEditor) {
            monacoEditor = window.monaco.editor.create(host, {
                value: '',
                language,
                theme: 'vs-dark',
                automaticLayout: true,
                minimap: { enabled: false },
                fontFamily: "'Cascadia Code', 'Consolas', 'Menlo', monospace",
                fontSize: 13,
                lineHeight: 20,
                tabSize: 4,
                insertSpaces: true,
                scrollBeyondLastLine: false,
                renderLineHighlight: 'all',
                roundedSelection: false,
                wordWrap: 'on'
            });
            monacoEditor.onDidChangeModelContent(() => {
                if (!suppressFileDirty) setFileDirty(true);
            });
        }
        return true;
    }

    if (window.require) {
        try {
            if (!monacoLoadPromise) {
                window.require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
                monacoLoadPromise = new Promise((resolve, reject) => {
                    window.require(['vs/editor/editor.main'], resolve, reject);
                });
            }
            await monacoLoadPromise;
            return ensureMonacoEditor(language);
        } catch (_) {
            monacoLoadPromise = null;
        }
    }

    host.classList.add('hidden');
    textarea.classList.remove('hidden');
    return false;
}

function setFileDirty(isDirty) {
    activeFileDirty = !!isDirty;
    const saveBtn = document.getElementById('file-save-btn');
    const status = document.getElementById('file-status-state');
    const tab = document.getElementById('file-active-tab');
    if (saveBtn) saveBtn.disabled = !activeFileDirty || !editingFilePath;
    if (status) status.innerText = activeFileDirty ? 'Unsaved' : (editingFilePath ? 'Saved' : 'Ready');
    if (tab) tab.classList.toggle('dirty', activeFileDirty);
}

function confirmDiscardFileChanges() {
    if (!activeFileDirty) return true;
    return window.confirm('Ada perubahan belum disimpan. Buang perubahan?');
}

function getCurrentEditorContent() {
    if (monacoEditor && !document.getElementById('monaco-editor').classList.contains('hidden')) {
        return monacoEditor.getValue();
    }
    return document.getElementById('editor-content').value;
}

async function saveCurrentFile() {
    if (!activeFileBotName || !editingFilePath) return;

    try {
        const content = getCurrentEditorContent();
        const result = await apiCall('/files/write', 'POST', {
            name: activeFileBotName,
            filePath: editingFilePath,
            content
        });
        activeFileOriginal = content;
        document.getElementById('file-status-size').innerText = formatBytes(result.size);
        setFileDirty(false);
        showToast('File saved', 'success');
        fetchDirectory(currentBrowsePath || '');
    } catch (err) {
        showToast(`Save failed: ${err.message}`, 'error');
    }
}

function saveFile() {
    return saveCurrentFile();
}

function showEditorEmptyState(message) {
    const empty = document.getElementById('file-empty-state');
    const textarea = document.getElementById('editor-content');
    const monacoHost = document.getElementById('monaco-editor');
    const tab = document.getElementById('file-active-tab');
    if (empty) {
        empty.innerText = message;
        empty.classList.remove('hidden');
    }
    textarea?.classList.add('hidden');
    monacoHost?.classList.add('hidden');
    if (tab) tab.innerHTML = '<i data-lucide="file-text"></i><span>No file open</span>';
    document.getElementById('file-status-path').innerText = '';
    document.getElementById('file-status-size').innerText = '';
    lucide.createIcons();
}

document.getElementById('editor-content')?.addEventListener('input', () => {
    if (!suppressFileDirty) setFileDirty(true);
});

document.addEventListener('keydown', (e) => {
    const filesOpen = document.getElementById('files-modal')?.classList.contains('active');
    if (filesOpen && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveCurrentFile();
    }
});

// --- Multi-tab Terminal Helpers --- (termTabs already declared at top)

let newTabValue = '';

function toggleNewTabDropdown() {
    const dd = document.getElementById('new-tab-dropdown');
    if (dd) dd.classList.toggle('open');
}

function selectNewTabOption(fullName, label) {
    newTabValue = fullName;
    document.getElementById('new-tab-select').value = fullName;
    const lbl = document.getElementById('new-tab-label');
    if (lbl) lbl.textContent = label;
    document.querySelectorAll('#new-tab-menu .custom-dropdown-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.value === fullName);
    });
    document.getElementById('new-tab-dropdown')?.classList.remove('open');
}

// Close new-tab dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dd = document.getElementById('new-tab-dropdown');
    if (dd && !dd.contains(e.target)) dd.classList.remove('open');
});

function promptNewTerminalTab() {
    const menu = document.getElementById('new-tab-menu');
    const label = document.getElementById('new-tab-label');
    newTabValue = '';
    document.getElementById('new-tab-select').value = '';
    if (label) label.textContent = 'Select a bot...';

    // Find active bots not currently open in tabs
    const availableBots = currentBotsList.filter(b => !termTabs.includes(b.fullName));

    if (availableBots.length === 0) {
        showToast('All active bots are already open in tabs.', 'warning');
        return;
    }

    if (menu) {
        menu.innerHTML = availableBots.map(b => {
            const lbl = `${b.name} (#${b.pid})`;
            // Use data-value attr + event delegation to avoid quote issues in bot names
            return `<div class="custom-dropdown-item" data-value="${b.fullName.replace(/"/g,'&quot;')}" data-label="${lbl.replace(/"/g,'&quot;')}" onclick="selectNewTabOption(this.dataset.value, this.dataset.label)">${lbl}</div>`;
        }).join('');
    }

    document.getElementById('new-tab-modal').classList.add('active');
}

function closeNewTabModal() {
    document.getElementById('new-tab-modal').classList.remove('active');
}

function confirmNewTab() {
    const val = newTabValue || document.getElementById('new-tab-select').value;
    if (val) {
        openLog(val);
        closeNewTabModal();
    } else {
        showToast('Please select a bot', 'warning');
    }
}

// --- Theme ---
// Apply theme immediately on page load (before auth check) to avoid flash
(function initThemeEarly() {
    const saved = localStorage.getItem('theme');
    if (saved === 'light') {
        document.body.classList.add('light-mode');
    }
})();

function toggleTheme() {
    const isLight = document.body.classList.toggle('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) {
        btn.innerHTML = isLight 
            ? '<i data-lucide="moon" style="width:16px;height:16px;"></i> <span class="hide-mobile">Dark Mode</span>' 
            : '<i data-lucide="sun" style="width:16px;height:16px;"></i> <span class="hide-mobile">Light Mode</span>';
        lucide.createIcons();
    }
}

function applyTheme(theme) {
    const isLight = theme === 'light';
    document.body.classList.toggle('light-mode', isLight);
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) {
        btn.innerHTML = isLight
            ? '<i data-lucide="moon" style="width:16px;height:16px;"></i> <span class="hide-mobile">Dark Mode</span>'
            : '<i data-lucide="sun" style="width:16px;height:16px;"></i> <span class="hide-mobile">Light Mode</span>';
        lucide.createIcons();
    }
}

// Check auth on load
if (token) {
    initDashboard();
} else {
    showScreen('login-screen');
}

// --- Migration Custom Dropdown ---
let migrateBotValue = '';       // 'all' or bot name
let migrateBotList = [];        // cache of bots from /bots API

function toggleBotDropdown() {
    const dd = document.getElementById('migrate-bot-dropdown');
    dd.classList.toggle('open');
}

function selectBotOption(name, label, hasDir) {
    migrateBotValue = name;
    document.getElementById('migrate-bot-select').value = name;
    document.getElementById('migrate-bot-label').textContent = label;
    document.querySelectorAll('#migrate-bot-menu .custom-dropdown-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.value === name);
    });
    document.getElementById('migrate-bot-dropdown').classList.remove('open');

    // Show/hide directory warning
    const warning = document.getElementById('migrate-dir-warning');
    const btnLabel = document.getElementById('btn-migrate-label');
    if (name === 'all') {
        warning.style.display = 'none';
        btnLabel.textContent = 'Transfer All Bots';
    } else if (!hasDir) {
        warning.style.display = 'flex';
        btnLabel.textContent = 'Start Migration';
        lucide.createIcons();
    } else {
        warning.style.display = 'none';
        btnLabel.textContent = 'Start Migration';
    }
}

/** Opens Bot Configuration modal for the currently selected bot */
function openSetDirForBot() {
    if (!migrateBotValue || migrateBotValue === 'all') return;
    const bot = migrateBotList.find(b => b.name === migrateBotValue);
    if (bot) setCommand(bot.name, bot.savedCommand, bot.savedDirectory || bot.cwd);
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dd = document.getElementById('migrate-bot-dropdown');
    if (dd && !dd.contains(e.target)) dd.classList.remove('open');
});

async function fetchBotsForMigration() {
    const menu = document.getElementById('migrate-bot-menu');
    const label = document.getElementById('migrate-bot-label');
    if (!menu) return;

    menu.innerHTML = '<div class="custom-dropdown-item" style="color:var(--text-muted);">Loading bots...</div>';
    label.textContent = 'Select a bot...';
    migrateBotValue = '';
    migrateBotList = [];
    document.getElementById('migrate-bot-select').value = '';
    document.getElementById('migrate-dir-warning').style.display = 'none';
    document.getElementById('btn-migrate-label').textContent = 'Start Migration';

    try {
        const data = await apiCall('/bots');
        const screens = data.screens || [];

        if (screens.length === 0) {
            menu.innerHTML = '<div class="custom-dropdown-item" style="color:var(--text-muted);">No active bots found</div>';
            return;
        }

        screens.sort((a, b) => {
            const aRunning = a.isActive ? 0 : 1;
            const bRunning = b.isActive ? 0 : 1;
            if (aRunning !== bRunning) return aRunning - bRunning;
            return String(a.name).localeCompare(String(b.name));
        });
        
        migrateBotList = screens;

        // Count how many have dir set
        const withDir = screens.filter(s => s.savedDirectory && s.savedDirectory !== 'Unknown');

        // Build menu: Transfer All first, then individual bots
        let html = '';

        // "Transfer All" option
        html += `<div class="custom-dropdown-item" data-value="all"
            onclick="selectBotOption('all', '⚡ Transfer All (${withDir.length}/${screens.length} bots ready)', true)"
            style="border-bottom: 1px solid var(--border); font-weight: 600;">
            <span style="display:flex;align-items:center;gap:8px;">
                <span style="color:var(--primary);">⚡</span>
                Transfer All Bots
                <span style="font-size:11px;font-weight:400;color:var(--text-muted);">${withDir.length}/${screens.length} have folder set</span>
            </span>
        </div>`;

        // Individual bots
        html += screens.map(s => {
            const dotColor = s.isActive ? 'var(--success)' : 'var(--danger)';
            const stateText = s.isActive ? 'Running' : 'Idle';
            const dotHtml = `<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${dotColor}; box-shadow: 0 0 5px ${dotColor};"></span>`;
            const hasDir = !!(s.savedDirectory && s.savedDirectory !== 'Unknown');
            const dirBadge = hasDir
                ? `<span style="font-size:11px;color:var(--success);margin-left:auto;"><i data-lucide="check" style="width:12px;height:12px;vertical-align:-2px;"></i> ${s.savedDirectory}</span>`
                : `<span style="font-size:11px;color:var(--warning);margin-left:auto;"><i data-lucide="alert-triangle" style="width:12px;height:12px;vertical-align:-2px;"></i> No folder set</span>`;
            
            const triggerLabel = `${s.name} (${stateText})`;
            
            return `<div class="custom-dropdown-item" data-value="${s.name}"
                onclick="selectBotOption('${s.name}', '${triggerLabel.replace(/'/g,"\\\\'")}', ${hasDir})"
                style="display:flex;align-items:center;gap:12px;padding:12px 14px;">
                ${dotHtml}
                <div style="display:flex;flex-direction:column;gap:3px;">
                    <span style="font-weight:600;font-size:14px;">${s.name}</span>
                    <span style="font-size:11px;color:var(--text-muted);font-family:Consolas, Menlo, monospace;">${s.status}</span>
                </div>
                ${dirBadge}
            </div>`;
        }).join('');

        menu.innerHTML = html;
        lucide.createIcons();

    } catch (err) {
        menu.innerHTML = '<div class="custom-dropdown-item" style="color:var(--danger);">Error loading bots</div>';
        showToast('Failed to load bots: ' + err.message, 'error');
    }
}

async function testSshConnection() {
    const targetIp = document.getElementById('migrate-ip').value.trim();
    const targetUser = document.getElementById('migrate-user').value.trim();
    const targetPass = document.getElementById('migrate-pass').value;

    if (!targetIp || !targetUser || !targetPass) {
        showToast('Please fill in IP, Username, and Password to test connection', 'error');
        return;
    }

    const btn = document.getElementById('btn-test-connection');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader"></i> Testing...';
    lucide.createIcons();

    try {
        await apiCall('/test-connection', 'POST', { targetIp, targetUser, targetPass });
        showToast('✅ Connection to VPS successful!', 'success');
    } catch (err) {
        showToast('❌ Connection failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
        lucide.createIcons();
    }
}

document.getElementById('migrate-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const targetIp   = document.getElementById('migrate-ip').value.trim();
    const targetUser = document.getElementById('migrate-user').value.trim();
    const targetPass = document.getElementById('migrate-pass').value;

    if (!migrateBotValue) {
        showToast('Please select a bot to migrate', 'error');
        document.getElementById('migrate-bot-dropdown')?.classList.add('open');
        return;
    }
    if (!targetIp || !targetUser || !targetPass) {
        showToast('Please fill in all VPS credential fields', 'error');
        return;
    }

    // Build list of bots to migrate
    let botsToMigrate = [];
    if (migrateBotValue === 'all') {
        botsToMigrate = migrateBotList.filter(s => s.savedDirectory && s.savedDirectory !== 'Unknown');
        if (botsToMigrate.length === 0) {
            showToast('No bots have a folder set. Please configure bot directories first.', 'error');
            return;
        }
        const skipped = migrateBotList.length - botsToMigrate.length;
        if (skipped > 0) showToast(`${skipped} bot(s) skipped — no folder set`, 'warning');
    } else {
        const bot = migrateBotList.find(b => b.name === migrateBotValue);
        if (!bot) return showToast('Selected bot not found', 'error');
        if (!bot.savedDirectory || bot.savedDirectory === 'Unknown') {
            document.getElementById('migrate-dir-warning').style.display = 'flex';
            showToast('Please set the bot directory first', 'error');
            lucide.createIcons();
            return;
        }
        botsToMigrate = [bot];
    }

    const btn        = document.getElementById('btn-migrate');
    const statusBox  = document.getElementById('migrate-status-box');
    const statusText = document.getElementById('migrate-status-text');
    const progressBar = document.getElementById('migrate-progress-bar');
    const counter    = document.getElementById('migrate-bot-counter');
    const logLines   = document.getElementById('migrate-log-lines');

    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader"></i> Migrating...';
    lucide.createIcons();
    statusBox.style.display = 'block';
    progressBar.style.width = '0%';
    statusText.style.color = 'var(--text-muted)';
    logLines.style.display = botsToMigrate.length > 1 ? 'block' : 'none';
    logLines.innerHTML = '';

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < botsToMigrate.length; i++) {
        const bot = botsToMigrate[i];
        const pctStart = Math.round((i / botsToMigrate.length) * 100);
        const pctEnd   = Math.round(((i + 1) / botsToMigrate.length) * 100);

        counter.textContent = `${i + 1} / ${botsToMigrate.length}`;
        statusText.textContent = `Transferring: ${bot.name}...`;
        progressBar.style.width = pctStart + '%';

        // Animate to mid-point while waiting
        setTimeout(() => { progressBar.style.width = Math.round((pctStart + pctEnd) / 2) + '%'; }, 800);

        try {
            await apiCall('/migrate', 'POST', { botName: bot.name, targetIp, targetUser, targetPass });
            successCount++;
            progressBar.style.width = pctEnd + '%';
            if (botsToMigrate.length > 1) {
                logLines.innerHTML += `<div style="color:var(--success);padding:2px 0;">✓ ${bot.name} → transferred</div>`;
                logLines.scrollTop = logLines.scrollHeight;
            }
        } catch (err) {
            failCount++;
            if (botsToMigrate.length > 1) {
                logLines.innerHTML += `<div style="color:var(--danger);padding:2px 0;">✗ ${bot.name} — ${err.message}</div>`;
                logLines.scrollTop = logLines.scrollHeight;
            } else {
                statusText.textContent = 'Migration failed: ' + err.message;
                statusText.style.color = 'var(--danger)';
                showToast('Migration failed: ' + err.message, 'error');
                btn.disabled = false;
                btn.innerHTML = '<i data-lucide="rocket"></i> <span id="btn-migrate-label">Start Migration</span>';
                lucide.createIcons();
                return;
            }
        }
    }

    progressBar.style.width = '100%';
    if (failCount === 0) {
        statusText.textContent = botsToMigrate.length > 1
            ? `All ${successCount} bots transferred successfully!`
            : 'Transfer complete!';
        statusText.style.color = 'var(--success)';
        showToast(`✅ ${successCount} bot(s) migrated successfully!`, 'success');
    } else {
        statusText.textContent = `Done: ${successCount} succeeded, ${failCount} failed.`;
        statusText.style.color = 'var(--warning)';
        showToast(`⚠ ${successCount} ok, ${failCount} failed. Check log above.`, 'warning');
    }

    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="rocket"></i> <span id="btn-migrate-label">Start Migration</span>';
    lucide.createIcons();
});

// --- Command Palette ---
let commandOptions = [];
let commandSelectedIndex = 0;

function openCommandPalette() {
    document.getElementById('command-palette-modal').classList.add('active');
    const input = document.getElementById('command-search-input');
    input.value = '';
    input.focus();
    updateCommandOptions('');
}

function closeCommandPalette() {
    document.getElementById('command-palette-modal').classList.remove('active');
}

function updateCommandOptions(query) {
    query = query.toLowerCase();
    let options = [
        { label: 'Navigate: Launch New Bot', icon: 'plus-circle', action: () => showSection('launch-section', document.querySelector('a[onclick*="launch-section"]')) },
        { label: 'Navigate: VPS Migration', icon: 'send', action: () => showSection('migrate-section', document.querySelector('a[onclick*="migrate-section"]')) },
        { label: 'Navigate: System Settings', icon: 'settings', action: () => showSection('settings-section', document.querySelector('a[onclick*="settings-section"]')) },
        { label: 'System: Logout', icon: 'log-out', action: confirmLogout }
    ];

    // Add bot specific actions
    currentBotsList.forEach(b => {
        options.push({ label: `Terminal: ${b.name}`, icon: 'terminal', action: () => openLog(b.fullName) });
        if (hasConfiguredDirectory(b)) {
            options.push({ label: `File: ${b.name}`, icon: 'folder-open', action: () => openBotFilesByName(b.name) });
        }
        options.push({ label: `Restart: ${b.name}`, icon: 'refresh-cw', action: () => doRestart(b.fullName, b.savedCommand) });
        options.push({ label: `Stop: ${b.name}`, icon: 'square', action: () => confirmBotAction('stop', b.fullName) });
        options.push({ label: `Config: ${b.name}`, icon: 'settings', action: () => setCommand(b.name, b.savedCommand, b.savedDirectory || b.cwd) });
    });

    if (query) {
        options = options.filter(o => o.label.toLowerCase().includes(query));
    }

    commandOptions = options;
    commandSelectedIndex = 0;
    renderCommandPalette();
}

function renderCommandPalette() {
    const list = document.getElementById('command-list');
    list.innerHTML = commandOptions.length === 0 
        ? '<div style="padding: 20px; color: var(--text-muted); text-align: center;">No commands found.</div>'
        : commandOptions.map((opt, i) => `
        <div class="command-item ${i === commandSelectedIndex ? 'selected' : ''}" onclick="executeCommandPalette(${i})">
            <i data-lucide="${opt.icon}"></i>
            <span>${opt.label}</span>
        </div>
    `).join('');
    lucide.createIcons();
    
    // Auto scroll to selected
    const selectedEl = list.querySelector('.selected');
    if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
}

function executeCommandPalette(index) {
    if (commandOptions[index]) {
        closeCommandPalette();
        commandOptions[index].action();
    }
}

document.getElementById('command-search-input')?.addEventListener('input', (e) => {
    updateCommandOptions(e.target.value);
});

document.getElementById('command-search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        commandSelectedIndex = Math.min(commandSelectedIndex + 1, commandOptions.length - 1);
        renderCommandPalette();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        commandSelectedIndex = Math.max(commandSelectedIndex - 1, 0);
        renderCommandPalette();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        executeCommandPalette(commandSelectedIndex);
    }
});

// Global Shortcuts
document.addEventListener('keydown', (e) => {
    // Ctrl+K for command palette
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        openCommandPalette();
    }
    // Escape to close modals — but NOT the terminal modal when xterm is focused
    // (ESC is a valid key in terminal apps like vim)
    if (e.key === 'Escape') {
        const termModal = document.getElementById('log-modal');
        const isTermActive = termModal && termModal.classList.contains('active');
        // Check if xterm textarea has focus (xterm creates a hidden textarea for input)
        const activeEl = document.activeElement;
        const xtermFocused = isTermActive && activeEl && (
            activeEl.classList.contains('xterm-helper-textarea') ||
            activeEl.classList.contains('xterm-input') ||
            (activeEl.tagName === 'TEXTAREA' && activeEl.closest('#xterm-container'))
        );
        document.querySelectorAll('.modal-overlay.active').forEach(m => {
            // Never close terminal modal with ESC when xterm is focused
            if (m.id === 'log-modal' && xtermFocused) return;
            // Also never close terminal modal with ESC if it's active (user must use X button)
            if (m.id === 'log-modal' && isTermActive) return;
            if (m.id === 'files-modal') {
                closeFileBrowser();
                return;
            }
            m.classList.remove('active');
        });
    }
});
