const isLocalFile = window.location.protocol === 'file:';
const API_BASE = isLocalFile ? 'http://127.0.0.1:5000' : window.location.origin;

function setCookie(name, value, days) { let d = new Date(); d.setTime(d.getTime() + (days*24*60*60*1000)); document.cookie = name + "=" + (value||"") + "; expires=" + d.toUTCString() + "; path=/"; }
function getCookie(name) { let n = name + "="; let ca = document.cookie.split(';'); for(let i=0;i<ca.length;i++) { let c = ca[i].trim(); if(c.indexOf(n)===0) return c.substring(n.length,c.length); } return null; }
function eraseCookie(name) { document.cookie = name+'=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;'; }

let currentUser = null; 
let latestPollInterval = null; 
let activeContainerBeforeTeam = 'auth-container';

document.addEventListener('DOMContentLoaded', () => {
    const token = getCookie('beast_token');
    const savedUser = getCookie('beast_user');
    
    if (token && savedUser && token !== "undefined") {
        const u = JSON.parse(decodeURIComponent(savedUser));
        if (u.role === 'admin' || u.role === 'owner') {
            currentUser = u; 
            showDashboard();
        } else {
            alert('權限不足！此頁面僅限管理員使用。');
            eraseCookie('beast_token'); eraseCookie('beast_user');
            document.getElementById('auth-container').classList.remove('hidden');
        }
    } else { document.getElementById('auth-container').classList.remove('hidden'); }
    
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const res = await fetch(`${API_BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.getElementById('login-username').value.trim(), password: document.getElementById('login-password').value }) });
            const data = await res.json();
            if (data.success) {
                if (data.user.role === 'admin' || data.user.role === 'owner') {
                    setCookie('beast_token', data.token, 7); setCookie('beast_user', encodeURIComponent(JSON.stringify(data.user)), 7); 
                    currentUser = data.user;
                    document.getElementById('auth-container').classList.add('hidden'); showDashboard();
                } else { alert("這是一般會員帳號，無法登入控制台！"); }
            } else alert(data.message);
        } catch { alert('後端連線失敗'); }
    });
    
    document.getElementById('logout-btn').addEventListener('click', () => { eraseCookie('beast_token'); eraseCookie('beast_user'); location.reload(); });
    document.getElementById('show-team-dash-btn').addEventListener('click', () => { activeContainerBeforeTeam = 'dashboard-container'; document.getElementById('dashboard-container').classList.add('hidden'); document.getElementById('team-container').classList.remove('hidden'); clearInterval(latestPollInterval); });
    document.getElementById('team-back-btn').addEventListener('click', () => { document.getElementById('team-container').classList.add('hidden'); document.getElementById(activeContainerBeforeTeam).classList.remove('hidden'); startPolling(); });

    document.getElementById('update-port-btn').addEventListener('click', async () => {
        const port = document.getElementById('com-port-input').value.trim();
        if(port) { try { await fetch(`${API_BASE}/api/config`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({com_port:port})}); alert('已變更通訊埠'); } catch(e){} }
    });
});

function showDashboard() {
    document.getElementById('dashboard-container').classList.remove('hidden');
    const badge = document.getElementById('admin-role-badge');
    badge.textContent = currentUser.role.toUpperCase();
    badge.className = `badge badge-${currentUser.role}`;
    startPolling(); 
}

function switchAdminTab(tabId) {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector(`.admin-tab[onclick="switchAdminTab('${tabId}')"]`).classList.add('active');
    document.getElementById(`tab-${tabId}`).classList.add('active');

    if (tabId === 'restaurants') fetchAdminRestaurants();
    if (tabId === 'users') fetchAdminUsers();
    
    // 🌟 如果切換到日誌面板，啟動自動抓取
    if (tabId === 'logs') {
        fetchAdminSystem();
        if(!window.sysLogInterval) window.sysLogInterval = setInterval(fetchAdminSystem, 3000);
    } else {
        if(window.sysLogInterval) { clearInterval(window.sysLogInterval); window.sysLogInterval = null; }
    }
}

function startPolling() { latestPollInterval = setInterval(updateLatestData, 1000); }

// 🌟 獲取系統狀態與日誌
async function fetchAdminSystem() {
    try {
        const res = await fetch(`${API_BASE}/api/admin/system`, { headers: { 'Authorization': `Bearer ${getCookie('beast_token')}` } });
        const d = await res.json();
        if(d.success) {
            document.getElementById('sys-hit-rate').textContent = d.cache.hit_rate.toFixed(1);
            document.getElementById('sys-hits').textContent = d.cache.hits;
            document.getElementById('sys-misses').textContent = d.cache.misses;
            
            const term = document.getElementById('sys-terminal');
            term.innerHTML = '';
            
            if(d.logs.length === 0) {
                term.innerHTML = '<p style="color:#a0a0c0;">目前尚無系統日誌...</p>';
            } else {
                d.logs.forEach(log => {
                    let cls = '';
                    if(log.includes('❌') || log.includes('⚠️')) cls = 'log-error';
                    else if(log.includes('🤖')) cls = 'log-warn';
                    else if(log.includes('✅') || log.includes('📦') || log.includes('🔑') || log.includes('📝')) cls = 'log-success';
                    
                    // 防 XSS 過濾
                    const safeLog = String(log).replace(/&/g, "&amp;").replace(/</g, "&lt;");
                    term.innerHTML += `<p class="${cls}">${safeLog}</p>`;
                });
            }
        }
    } catch(e) {}
}

async function updateLatestData() {
    const isSimMode = document.getElementById('admin-sim-toggle').checked;
    if (isSimMode) {
        renderTelemetry({ status: "啟用前端亂數模擬中", is_simulated: true, avg_temp_c: 22+Math.random()*6, avg_humidity: 55+Math.random()*20, avg_noise_db: 45+Math.random()*35 });
    } else {
        try {
            const res = await fetch(`${API_BASE}/api/latest`); const d = await res.json(); 
            if (d.is_simulated) renderTelemetry({ status: "等待硬體連線...", is_simulated: false, avg_temp_c: 0, avg_humidity: 0, avg_noise_db: 0 });
            else renderTelemetry(d);
        } catch { document.getElementById('connection-status').textContent = "與 Flask 斷線"; }
    }
}

function renderTelemetry(data) {
    document.getElementById('connection-status').textContent = data.status || "更新中";
    document.getElementById('val-temp').textContent = data.avg_temp_c.toFixed(1);
    document.getElementById('val-humid').textContent = data.avg_humidity.toFixed(1);
    document.getElementById('val-noise').textContent = data.avg_noise_db.toFixed(1);
}

// ==========================================
// Tab 2: 地標管理 (餐廳)
// ==========================================
async function fetchAdminRestaurants() {
    const tbody = document.getElementById('admin-rest-tbody');
    tbody.innerHTML = '<tr><td colspan="5">載入中...</td></tr>';
    try {
        const res = await fetch(`${API_BASE}/api/admin/restaurants`, { headers: { 'Authorization': `Bearer ${getCookie('beast_token')}` } });
        const stores = await res.json();
        tbody.innerHTML = '';
        stores.forEach(s => {
            const stars = s.avg_rating > 0 ? `⭐ ${s.avg_rating.toFixed(1)}` : '無';
            tbody.innerHTML += `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:10px; color:#a0a0c0;">#${s.id}</td>
                    <td style="color:#00f2fe; font-weight:bold;">${escapeHtml(s.name)}</td>
                    <td>${stars}</td>
                    <td>${s.record_count} 筆</td>
                    <td style="display:flex; gap:5px; padding:10px 0;">
                        <button class="btn btn-primary btn-sm" onclick="openEditRestModal(${s.id}, '${escapeHtml(s.name)}', '${escapeHtml(s.address)}', '${escapeHtml(s.business_hours)}')">編輯</button>
                        <button class="btn btn-sm" style="background:rgba(255,255,255,0.1); border:1px solid #ccc; color:#fff;" onclick="viewRestRecords(${s.id}, '${escapeHtml(s.name)}')">檢視</button>
                        <button class="btn btn-danger btn-sm" onclick="deleteRestaurant(${s.id}, '${escapeHtml(s.name)}')">刪除</button>
                    </td>
                </tr>
            `;
        });
    } catch(e) { tbody.innerHTML = '<tr><td colspan="5" style="color:red;">載入失敗</td></tr>'; }
}

function openEditRestModal(id, name, addr, hours) {
    document.getElementById('edit-rest-id').value = id;
    document.getElementById('edit-rest-name').value = name;
    document.getElementById('edit-rest-addr').value = addr === 'null' ? '' : addr;
    document.getElementById('edit-rest-hours').value = hours === 'null' ? '' : hours;
    document.getElementById('modal-edit-rest').classList.add('active');
}

async function saveRestEdit() {
    const id = document.getElementById('edit-rest-id').value;
    const data = {
        name: document.getElementById('edit-rest-name').value.trim(),
        address: document.getElementById('edit-rest-addr').value.trim(),
        business_hours: document.getElementById('edit-rest-hours').value.trim()
    };
    if(!data.name) return alert('名稱不可為空');
    try {
        await fetch(`${API_BASE}/api/admin/restaurants/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getCookie('beast_token')}` }, body: JSON.stringify(data) });
        document.getElementById('modal-edit-rest').classList.remove('active');
        fetchAdminRestaurants();
    } catch(e) { alert("更新失敗"); }
}

async function deleteRestaurant(id, name) {
    if(!confirm(`⚠️ 警告：確定要永久刪除地標「${name}」以及該地標底下的所有評價紀錄嗎？\n此操作無法復原！`)) return;
    try {
        const res = await fetch(`${API_BASE}/api/admin/restaurants/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${getCookie('beast_token')}` } });
        const d = await res.json();
        if(d.success) { alert('地標刪除成功！'); fetchAdminRestaurants(); } 
        else { alert("刪除失敗"); }
    } catch(e) { alert("連線異常，無法刪除"); }
}

async function viewRestRecords(rest_id, rest_name) {
    document.getElementById('view-records-title').textContent = `📍 ${rest_name} 的歷史評價`;
    const tbody = document.getElementById('view-records-tbody');
    tbody.innerHTML = '<tr><td colspan="5">載入中...</td></tr>';
    document.getElementById('modal-view-records').classList.add('active');
    
    try {
        const res = await fetch(`${API_BASE}/api/admin/restaurants/${rest_id}/records`, { headers: { 'Authorization': `Bearer ${getCookie('beast_token')}` } });
        const d = await res.json();
        tbody.innerHTML = '';
        if(d.records.length === 0) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#a0a0c0;">尚無評價紀錄</td></tr>';
        else {
            d.records.forEach(r => {
                const stars = "⭐".repeat(r.rating || 5);
                tbody.innerHTML += `
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                        <td style="padding:10px; font-size:0.8rem; color:#a0a0c0;">${r.created_at.split(' ')[0]}</td>
                        <td style="color:#00ff87;">${stars}</td>
                        <td style="color:#f093fb;">@${escapeHtml(r.username)}</td>
                        <td style="max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(r.review_text || '-')}</td>
                        <td><button class="btn btn-danger btn-sm" onclick="deleteAnyRecord(${r.id}, ${rest_id}, '${escapeHtml(rest_name)}')">刪除</button></td>
                    </tr>
                `;
            });
        }
    } catch(e) {}
}

async function deleteAnyRecord(record_id, rest_id, rest_name) {
    if(!confirm("確定要刪除這筆評價紀錄嗎？")) return;
    try {
        await fetch(`${API_BASE}/api/history/${record_id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${getCookie('beast_token')}` } });
        viewRestRecords(rest_id, rest_name); 
    } catch(e) {}
}

// ==========================================
// Tab 3: 會員管理 (Users)
// ==========================================
async function fetchAdminUsers() {
    const tbody = document.getElementById('admin-user-tbody');
    tbody.innerHTML = '<tr><td colspan="5">載入中...</td></tr>';
    try {
        const res = await fetch(`${API_BASE}/api/admin/users`, { headers: { 'Authorization': `Bearer ${getCookie('beast_token')}` } });
        const d = await res.json();
        tbody.innerHTML = '';
        d.users.forEach(u => {
            const roleBadge = `<span class="badge badge-${u.role}">${u.role.toUpperCase()}</span>`;
            const statusBadge = u.status === 'frozen' ? `<span class="badge badge-frozen">已凍結</span>` : `<span class="badge badge-user">正常</span>`;
            
            // 🌟 刪除按鈕加入！
            const toggleFreezeBtn = u.role === 'owner' ? '' : `<button class="btn btn-sm ${u.status === 'frozen' ? 'btn-primary' : 'btn-warning'}" onclick="toggleUserStatus(${u.id}, '${u.status}')">${u.status === 'frozen' ? '解凍' : '凍結'}</button>`;
            const deleteBtn = u.role === 'owner' ? '' : `<button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id}, '${escapeHtml(u.username)}')">刪除</button>`;
            
            tbody.innerHTML += `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:10px; color:#a0a0c0;">#${u.id}</td>
                    <td style="color:#fff; font-weight:bold;">${escapeHtml(u.username)}</td>
                    <td>${roleBadge}</td>
                    <td>${statusBadge}</td>
                    <td style="display:flex; gap:5px; padding:10px 0;">
                        <button class="btn btn-sm" style="background:rgba(255,255,255,0.1); border:1px solid #ccc; color:#fff;" onclick="openEditUserModal(${u.id}, '${escapeHtml(u.username)}', '${u.role}')">編輯</button>
                        ${toggleFreezeBtn}
                        ${deleteBtn}
                    </td>
                </tr>
            `;
        });
    } catch(e) { tbody.innerHTML = '<tr><td colspan="5" style="color:red;">載入失敗</td></tr>'; }
}

function openEditUserModal(id, name, role) {
    document.getElementById('edit-user-id').value = id;
    document.getElementById('edit-user-name').value = name;
    document.getElementById('edit-user-pwd').value = '';
    
    const roleSelect = document.getElementById('edit-user-role');
    roleSelect.value = role;
    
    if(currentUser.role === 'owner') {
        document.getElementById('role-select-box').style.display = 'block';
    } else {
        document.getElementById('role-select-box').style.display = 'none';
    }
    
    document.getElementById('modal-edit-user').classList.add('active');
}

async function saveUserEdit() {
    const id = document.getElementById('edit-user-id').value;
    const data = { username: document.getElementById('edit-user-name').value.trim() };
    const pwd = document.getElementById('edit-user-pwd').value;
    if(pwd) data.password = pwd;
    if(currentUser.role === 'owner') data.role = document.getElementById('edit-user-role').value;
    
    try {
        const res = await fetch(`${API_BASE}/api/admin/users/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getCookie('beast_token')}` }, body: JSON.stringify(data) });
        const d = await res.json();
        if(d.success) {
            document.getElementById('modal-edit-user').classList.remove('active');
            fetchAdminUsers();
        } else alert(d.message);
    } catch(e) { alert("更新失敗"); }
}

async function toggleUserStatus(id, currentStatus) {
    const newStatus = currentStatus === 'frozen' ? 'active' : 'frozen';
    if(!confirm(`確定要 ${newStatus === 'frozen' ? '凍結' : '解凍'} 該帳號嗎？`)) return;
    try {
        await fetch(`${API_BASE}/api/admin/users/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getCookie('beast_token')}` }, body: JSON.stringify({status: newStatus}) });
        fetchAdminUsers();
    } catch(e) { alert("更新狀態失敗"); }
}

// 🌟 會員永久刪除邏輯
async function deleteUser(id, username) {
    if(!confirm(`⚠️ 警告：確定要永久刪除會員「${username}」及其所有的感官評價紀錄嗎？\n此操作無法復原！`)) return;
    try {
        const res = await fetch(`${API_BASE}/api/admin/users/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${getCookie('beast_token')}` } });
        const d = await res.json();
        if(d.success) {
            alert('會員刪除成功！');
            fetchAdminUsers();
        } else { alert(d.message || "刪除失敗"); }
    } catch(e) { alert("連線異常，無法刪除"); }
}

function escapeHtml(u) { return String(u).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }