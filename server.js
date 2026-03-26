const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const HTTP_PORT = 30000;
const WS_PORT = 18789;

// ============ SQLite数据库 ============
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'jolly.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// 简单的SQLite模拟（使用JSON文件）
const usersFile = path.join(dataDir, 'users.json');
const rolesFile = path.join(dataDir, 'roles.json');
const tokensFile = path.join(dataDir, 'tokens.json');

// 初始化数据文件
function loadData(file, defaultData) {
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (e) {}
    return defaultData;
}

function saveData(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// 用户数据
let users = loadData(usersFile, {});
if (Object.keys(users).length === 0) {
    users = { admin: { username: 'admin', password: 'admin123', createdAt: new Date().toISOString() } };
    saveData(usersFile, users);
}

// Token存储
let tokens = loadData(tokensFile, {});

// 角色数据
let roles = loadData(rolesFile, [
    { id: 'pm', name: '项目经理', status: 'offline', log: '', config: { color: '#667eea', icon: '📋' } },
    { id: 'dev', name: '开发工程师', status: 'offline', log: '', config: { color: '#28a745', icon: '💻' } },
    { id: 'tester', name: '测试工程师', status: 'offline', log: '', config: { color: '#ffc107', icon: '🧪' } }
]);

// 锁定记录
const lockouts = {};

// ============ 中间件 ============
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ WebSocket服务器 ============
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('connection', (ws) => {
    console.log('客户端连接成功');
    ws.send(JSON.stringify({ type: 'connected', message: '已连接' }));
});

wss.on('error', (err) => {
    console.error('WebSocket错误:', err);
});

function broadcastToAll(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// ============ 辅助函数 ============
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function isLocked(username) {
    const record = lockouts[username];
    if (!record) return false;
    if (record.count >= 5 && Date.now() < record.unlockTime) return true;
    return false;
}

function recordFailedLogin(username) {
    let record = lockouts[username] || { count: 0, unlockTime: 0 };
    record.count++;
    record.unlockTime = Date.now() + 15 * 60 * 1000;
    lockouts[username] = record;
    return record;
}

function clearLockout(username) {
    delete lockouts[username];
}

function saveTokens() {
    // 清理过期token
    const now = Date.now();
    for (const [token, data] of Object.entries(tokens)) {
        if (data.expiresAt < now) {
            delete tokens[token];
        }
    }
    saveData(tokensFile, tokens);
}

// ============ API: 用户认证 ============
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: '请输入用户名和密码' });
    if (isLocked(username)) return res.status(403).json({ success: false, message: '账号已被锁定，请15分钟后重试' });
    
    const user = users[username];
    if (!user || user.password !== password) {
        recordFailedLogin(username);
        return res.status(401).json({ success: false, message: '用户名或密码错误' });
    }
    
    clearLockout(username);
    const token = generateToken();
    const tokenData = { username, createdAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
    tokens[token] = tokenData;
    saveTokens();
    
    res.json({ success: true, message: '登录成功', token, username: user.username });
});

app.get('/api/verify', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ valid: false });
    
    const tokenData = tokens[token];
    if (!tokenData) return res.status(401).json({ valid: false });
    if (Date.now() > tokenData.expiresAt) { delete tokens[token]; saveTokens(); return res.status(401).json({ valid: false, message: 'Token已过期' }); }
    
    res.json({ valid: true, username: tokenData.username });
});

app.post('/api/logout', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token && tokens[token]) { delete tokens[token]; saveTokens(); }
    res.json({ success: true, message: '已退出登录' });
});

// ============ API: 用户管理 ============
app.get('/api/users', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!tokens[token]) return res.status(401).json({ message: '未登录' });
    const userList = Object.values(users).map(u => ({ username: u.username, createdAt: u.createdAt }));
    res.json({ users: userList });
});

app.post('/api/users', (req, res) => {
    const { username, password } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!tokens[token]) return res.status(401).json({ message: '未登录' });
    if (!username || !password) return res.status(400).json({ message: '请填写用户名和密码' });
    if (users[username]) return res.status(400).json({ message: '用户已存在' });
    
    users[username] = { username, password, createdAt: new Date().toISOString() };
    saveData(usersFile, users);
    res.json({ success: true, message: '用户添加成功' });
});

// ============ API: 需求发布（Issue #2核心功能） ============
app.post('/api/requirements', (req, res) => {
    const { title, description, priority } = req.body;
    
    if (!title || !description) {
        return res.status(400).json({ 
            success: false, 
            message: '请填写完整的需求信息' 
        });
    }
    
    const requirement = {
        type: 'new_requirement',
        data: {
            title,
            description,
            priority: priority || 'medium',
            createdAt: new Date().toISOString()
        }
    };
    
    broadcastToAll(requirement);
    
    res.json({ 
        success: true, 
        message: '需求已发送给PM' 
    });
});

app.get('/api/pm-status', (req, res) => {
    res.json({ 
        connected: wss.clients.size > 0, 
        count: wss.clients.size 
    });
});

// ============ API: 角色管理 ============
app.get('/api/roles', (req, res) => {
    res.json({ roles: roles });
});

app.post('/api/roles', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!tokens[token]) return res.status(401).json({ message: '未登录' });
    
    const { id, name, config } = req.body;
    if (!id || !name) return res.status(400).json({ message: '请填写角色ID和名称' });
    if (roles.find(r => r.id === id)) return res.status(400).json({ message: '角色已存在' });
    
    const newRole = { id, name, status: 'offline', log: '', config: config || {} };
    roles.push(newRole);
    saveData(rolesFile, roles);
    broadcastToAll({ type: 'role_added', role: newRole });
    res.json({ success: true, message: '角色添加成功', role: newRole });
});

app.put('/api/roles/:id', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!tokens[token]) return res.status(401).json({ message: '未登录' });
    
    const { id } = req.params;
    const { name, config, status } = req.body;
    const role = roles.find(r => r.id === id);
    
    if (!role) return res.status(404).json({ message: '角色不存在' });
    if (name) role.name = name;
    if (config) role.config = { ...role.config, ...config };
    if (status) role.status = status;
    
    saveData(rolesFile, roles);
    res.json({ success: true, message: '角色更新成功', role });
});

app.delete('/api/roles/:id', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!tokens[token]) return res.status(401).json({ message: '未登录' });
    
    const { id } = req.params;
    const idx = roles.findIndex(r => r.id === id);
    if (idx === -1) return res.status(404).json({ message: '角色不存在' });
    
    roles.splice(idx, 1);
    saveData(rolesFile, roles);
    broadcastToAll({ type: 'role_removed', id });
    
    res.json({ success: true, message: '角色删除成功' });
});

app.get('/api/roles/:id/log', (req, res) => {
    const { id } = req.params;
    const role = roles.find(r => r.id === id);
    if (!role) return res.status(404).json({ message: '角色不存在' });
    res.json({ log: role.log });
});

// ============ 前端页面 ============
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Jolly AI - 管理面板</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; }
        .container { background: white; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 40px; width: 100%; max-width: 600px; animation: slideIn 0.5s ease-out; }
        @keyframes slideIn { from { transform: translateY(-30px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        h1 { color: #667eea; margin-bottom: 10px; font-size: 28px; text-align: center; }
        .subtitle { color: #888; margin-bottom: 30px; text-align: center; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; color: #333; font-weight: 500; }
        input, select, textarea { width: 100%; padding: 14px 18px; border: 2px solid #e0e0e0; border-radius: 12px; font-size: 15px; transition: all 0.3s; }
        input:focus, select:focus, textarea:focus { border-color: #667eea; outline: none; box-shadow: 0 0 0 3px rgba(102,126,234,0.15); }
        textarea { min-height: 100px; resize: vertical; }
        .btn { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; padding: 16px 30px; border-radius: 12px; font-size: 16px; cursor: pointer; width: 100%; transition: transform 0.2s, box-shadow 0.2s; font-weight: 600; }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(102,126,234,0.4); }
        .btn:disabled { background: #ccc; cursor: not-allowed; transform: none; }
        .btn-secondary { background: #6c757d; }
        .btn-small { padding: 8px 16px; width: auto; font-size: 14px; }
        .status { margin-top: 20px; padding: 15px; border-radius: 12px; display: none; text-align: center; }
        .status.show { display: block; animation: fadeIn 0.3s; }
        .status.success { background: #d4edda; color: #155724; }
        .status.error { background: #f8d7da; color: #721c24; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .pm-status { margin-top: 20px; padding: 15px; background: #f8f9fa; border-radius: 12px; font-size: 14px; }
        .pm-status .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; background: #dc3545; }
        .pm-status .dot.connected { background: #28a745; }
        .footer { margin-top: 25px; text-align: center; color: #999; font-size: 13px; }
        .dashboard { display: none; }
        .dashboard.active { display: block; }
        .login-form.hidden { display: none; }
        .nav { display: flex; gap: 10px; margin-bottom: 20px; }
        .nav-btn { flex: 1; padding: 10px; background: #f8f9fa; border: 2px solid #e0e0e0; border-radius: 8px; cursor: pointer; text-align: center; transition: all 0.2s; font-size: 14px; }
        .nav-btn:hover, .nav-btn.active { border-color: #667eea; background: #e8eaf6; }
        .user-info { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; padding: 20px; background: #f8f9fa; border-radius: 12px; }
        .user-info h2 { color: #333; font-size: 20px; }
        .logout-btn { background: #dc3545; padding: 10px 20px; width: auto; }
        .role-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 20px; }
        .role-card { padding: 20px; background: white; border: 2px solid #e0e0e0; border-radius: 12px; text-align: center; cursor: pointer; transition: all 0.2s; }
        .role-card:hover { border-color: #667eea; transform: translateY(-2px); }
        .role-card .icon { font-size: 32px; margin-bottom: 10px; }
        .role-card .name { font-weight: 600; color: #333; margin-bottom: 5px; }
        .role-card .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; }
        .status-badge.online { background: #d4edda; color: #155724; }
        .status-badge.offline { background: #f8d7da; color: #721c24; }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; }
        .modal.show { display: flex; justify-content: center; align-items: center; }
        .modal-content { background: white; padding: 30px; border-radius: 20px; max-width: 600px; width: 90%; max-height: 80vh; overflow-y: auto; }
        .modal h3 { color: #667eea; margin-bottom: 20px; }
        .log-content { background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 8px; font-family: monospace; font-size: 13px; max-height: 400px; overflow-y: auto; white-space: pre-wrap; }
        .close-btn { float: right; font-size: 24px; cursor: pointer; color: #999; }
        .close-btn:hover { color: #333; }
        .section-title { color: #333; font-size: 18px; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 2px solid #667eea; }
        .add-role-form { background: #f8f9fa; padding: 20px; border-radius: 12px; margin-bottom: 20px; }
        .form-row { display: flex; gap: 10px; margin-bottom: 10px; }
        .form-row input { flex: 1; }
    </style>
</head>
<body>
    <div class="container">
        <!-- 登录表单 -->
        <div class="login-form" id="loginForm">
            <h1>🔐 管理系统</h1>
            <p class="subtitle">Jolly AI Admin Panel</p>
            <form id="loginFormEl">
                <div class="form-group"><label for="username">用户名</label><input type="text" id="username" placeholder="输入用户名" required></div>
                <div class="form-group"><label for="password">密码</label><input type="password" id="password" placeholder="输入密码" required></div>
                <button type="submit" class="btn" id="loginBtn">🚀 登录</button>
            </form>
            <div class="status" id="loginStatus"></div>
            <div class="footer"><p>默认账号: admin / admin123</p></div>
        </div>
        
        <!-- 主界面 -->
        <div class="dashboard" id="dashboard">
            <div class="user-info">
                <h2>👋 欢迎, <span id="displayUsername">admin</span></h2>
                <button class="btn logout-btn" id="logoutBtn">退出</button>
            </div>
            
            <div class="nav">
                <button class="nav-btn active" data-page="requirements">📋 需求发布</button>
                <button class="nav-btn" data-page="role-manager">👥 角色管理</button>
                <button class="nav-btn" data-page="status-monitor">📊 角色状态</button>
            </div>
            
            <!-- 需求发布 -->
            <div class="page active" id="requirementsPage">
                <h3 class="section-title">📋 需求发布</h3>
                <form id="requirementForm">
                    <div class="form-group"><label>需求标题</label><input type="text" id="reqTitle" placeholder="输入需求标题" required></div>
                    <div class="form-group"><label>需求描述</label><textarea id="reqDesc" placeholder="详细描述需求内容..." required></textarea></div>
                    <div class="form-group"><label>优先级</label><select id="reqPriority"><option value="low">低</option><option value="medium" selected>中</option><option value="high">高</option><option value="urgent">紧急</option></select></div>
                    <button type="submit" class="btn">🚀 发送需求</button>
                </form>
                <div class="status" id="reqStatus"></div>
                <div class="pm-status" id="pmStatus">
                    <span class="dot" id="pmDot"></span>
                    <span id="pmText">检查PM连接...</span>
                </div>
            </div>
            
            <!-- 角色管理 -->
            <div class="page" id="roleManagerPage">
                <h3 class="section-title">👥 角色管理（可扩充）</h3>
                <div class="add-role-form">
                    <div class="form-row">
                        <input type="text" id="newRoleId" placeholder="角色ID (如: designer)">
                        <input type="text" id="newRoleName" placeholder="角色名称">
                    </div>
                    <button class="btn btn-small" onclick="addRole()">➕ 添加角色</button>
                </div>
                <div class="role-grid" id="roleGrid"></div>
            </div>
            
            <!-- 状态监控 -->
            <div class="page" id="statusPage">
                <h3 class="section-title">📊 角色状态监控</h3>
                <div class="role-grid" id="statusGrid"></div>
            </div>
        </div>
    </div>
    
    <!-- 日志弹窗 -->
    <div class="modal" id="logModal">
        <div class="modal-content">
            <span class="close-btn" onclick="closeLogModal()">&times;</span>
            <h3 id="logTitle">角色日志</h3>
            <div class="log-content" id="logContent"></div>
        </div>
    </div>
    
    <script>
        let token = localStorage.getItem('token');
        
        async function checkAuth() {
            if (!token) return;
            try {
                const res = await fetch('/api/verify', { headers: { 'Authorization': 'Bearer ' + token } });
                const data = await res.json();
                if (data.valid) { showDashboard(data.username); loadRoles(); } 
                else localStorage.removeItem('token');
            } catch (e) { localStorage.removeItem('token'); }
        }
        checkAuth();
        
        function showDashboard(username) {
            document.getElementById('loginForm').classList.add('hidden');
            document.getElementById('dashboard').classList.add('active');
            document.getElementById('displayUsername').textContent = username;
            loadRoles(); loadPMStatus();
        }
        
        document.getElementById('loginFormEl').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('loginBtn');
            btn.disabled = true; btn.textContent = '登录中...';
            try {
                const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.getElementById('username').value, password: document.getElementById('password').value }) });
                const data = await res.json();
                if (data.success) { localStorage.setItem('token', data.token); token = data.token; showDashboard(data.username); loadRoles(); }
                else { document.getElementById('loginStatus').className = 'status show error'; document.getElementById('loginStatus').textContent = '❌ ' + data.message; }
            } catch (err) { document.getElementById('loginStatus').className = 'status show error'; document.getElementById('loginStatus').textContent = '❌ 网络错误'; }
            btn.disabled = false; btn.textContent = '🚀 登录';
        });
        
        document.getElementById('logoutBtn').addEventListener('click', async () => {
            if (token) await fetch('/api/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
            localStorage.removeItem('token');
            document.getElementById('dashboard').classList.remove('active');
            document.getElementById('loginForm').classList.remove('hidden');
            document.getElementById('loginFormEl').reset();
        });
        
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
                document.getElementById(btn.dataset.page + 'Page').classList.add('active');
                if (btn.dataset.page === 'status-monitor') loadStatusMonitor();
            });
        });
        
        async function loadRoles() {
            try {
                const res = await fetch('/api/roles');
                const data = await res.json();
                let html = '';
                data.roles.forEach(r => {
                    html += \`<div class="role-card" onclick="showLog('\${r.id}', '\${r.name}')">
                        <div class="icon">\${r.config?.icon || '👤'}</div>
                        <div class="name">\${r.name}</div>
                        <span class="status-badge \${r.status}">\${r.status === 'online' ? '🟢 在线' : '🔴 离线'}</span>
                    </div>\`;
                });
                document.getElementById('roleGrid').innerHTML = html;
                document.getElementById('statusGrid').innerHTML = html;
            } catch (e) { console.error(e); }
        }
        
        async function addRole() {
            const id = document.getElementById('newRoleId').value.trim();
            const name = document.getElementById('newRoleName').value.trim();
            if (!id || !name) return alert('请填写角色ID和名称');
            try {
                const res = await fetch('/api/roles', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ id, name, config: { color: '#667eea', icon: '👤' } }) });
                const data = await res.json();
                if (data.success) { alert('✅ 角色添加成功'); document.getElementById('newRoleId').value = ''; document.getElementById('newRoleName').value = ''; loadRoles(); }
                else alert('❌ ' + data.message);
            } catch (e) { alert('❌ 添加失败'); }
        }
        
        async function showLog(id, name) {
            document.getElementById('logTitle').textContent = name + ' - 日志';
            try {
                const res = await fetch('/api/roles/' + id + '/log');
                const data = await res.json();
                document.getElementById('logContent').textContent = data.log || '暂无日志';
            } catch (e) { document.getElementById('logContent').textContent = '加载失败'; }
            document.getElementById('logModal').classList.add('show');
        }
        
        function closeLogModal() { document.getElementById('logModal').classList.remove('show'); }
        
        async function loadStatusMonitor() { loadRoles(); }
        
        document.getElementById('requirementForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                const res = await fetch('/api/requirements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: document.getElementById('reqTitle').value, description: document.getElementById('reqDesc').value, priority: document.getElementById('reqPriority').value }) });
                const data = await res.json();
                if (data.success) { document.getElementById('reqStatus').className = 'status show success'; document.getElementById('reqStatus').textContent = '✅ ' + data.message; document.getElementById('requirementForm').reset(); }
                else { document.getElementById('reqStatus').className = 'status show error'; document.getElementById('reqStatus').textContent = '❌ ' + data.message; }
            } catch (err) { document.getElementById('reqStatus').className = 'status show error'; document.getElementById('reqStatus').textContent = '❌ 发送失败'; }
        });
        
        async function loadPMStatus() {
            try {
                const res = await fetch('/api/pm-status');
                const data = await res.json();
                const dot = document.getElementById('pmDot');
                const text = document.getElementById('pmText');
                if (data.connected) { dot.classList.add('connected'); text.textContent = '✅ PM已连接 (' + data.count + ')'; }
                else { text.textContent = '⚠️ PM未连接'; }
            } catch (e) {}
        }
        setInterval(loadPMStatus, 5000);
    </script>
</body>
</html>`);
});

// 启动服务器
app.listen(HTTP_PORT, () => {
    console.log(`🚀 Jolly AI 管理面板: http://localhost:${HTTP_PORT}`);
    console.log(`📡 WebSocket: ws://localhost:${WS_PORT}`);
    console.log(`📝 默认账号: admin / admin123`);
    console.log(`💾 数据目录: ${dataDir}`);
});