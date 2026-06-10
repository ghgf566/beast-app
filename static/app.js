// 🌟 修復 API_BASE
const isLocal = window.location.protocol === 'file:' || window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
const API_BASE = isLocal ? 'http://127.0.0.1:5000' : window.location.origin;

function setCookie(name, value, days) {
    let expires = "";
    if (days) {
        let date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + (value || "")  + expires + "; path=/";
}

function getCookie(name) {
    let nameEQ = name + "=";
    let ca = document.cookie.split(';');
    for(let i=0;i < ca.length;i++) {
        let c = ca[i].trim();
        if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
    }
    return null;
}

function eraseCookie(name) {   
    document.cookie = name +'=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
}

let currentUser = null;
let latestPollInterval = null;
let chartInstance = null;
let activeContainerBeforeTeam = 'auth-container';

// 錄製狀態控制
let isRecording = false;
let recordingStartTime = 0;
let recordingTimerId = null;
let recordedData = { temp: [], humid: [], noise: [] };
let finalAverages = {}; 

// LBS 全域變數
let beastMap = null;
let userMarker = null;
let currentGPS = { lat: null, lng: null };

document.addEventListener('DOMContentLoaded', () => {
    initAuth();
    initEventListeners();
});

// ==========================================
// 1. 會員驗證
// ==========================================
function initAuth() {
    const token = getCookie('beast_token');
    const savedUser = getCookie('beast_user');
    
    if (token && savedUser && token !== "undefined") {
        currentUser = JSON.parse(decodeURIComponent(savedUser));
        showDashboard();
    } else {
        localStorage.removeItem('beast_user'); 
        showAuth();
    }
}

function showAuth() {
    document.getElementById('auth-container').classList.remove('hidden');
    document.getElementById('dashboard-container').classList.add('hidden');
    stopPolling();
}

function showDashboard() {
    document.getElementById('auth-container').classList.add('hidden');
    document.getElementById('dashboard-container').classList.remove('hidden');
    document.getElementById('user-display-name').textContent = currentUser.username;
    
    fetch(`${API_BASE}/api/latest`)
        .then(res => res.json())
        .then(data => {
            if (data.status && data.status.includes('COM')) {
                const match = data.status.match(/COM\d+/);
                if (match) document.getElementById('com-port-input').value = match[0];
            }
        }).catch(err => {});
        
    startPolling();
    loadHistory();
    setTimeout(initBeastMap, 300);
}

function startPolling() {
    stopPolling();
    updateLatestData();
    latestPollInterval = setInterval(updateLatestData, 1000); 
}

function stopPolling() {
    if (latestPollInterval) { clearInterval(latestPollInterval); latestPollInterval = null; }
}

// ==========================================
// 2. 即時監控與錄製收集
// ==========================================
async function updateLatestData() {
    if (!currentUser) return;
    try {
        const res = await fetch(`${API_BASE}/api/latest`);
        const data = await res.json();
        renderTelemetry(data);
        
        if (isRecording) {
            recordedData.temp.push(data.avg_temp_c);
            recordedData.humid.push(data.avg_humidity);
            recordedData.noise.push(data.avg_noise_db);
        }
    } catch (err) {
        document.getElementById('status-dot').className = "status-dot disconnected";
        document.getElementById('connection-status').textContent = "與 Flask 後端中斷連線...";
    }
}

function renderTelemetry(data) {
    const dot = document.getElementById('status-dot');
    document.getElementById('connection-status').textContent = data.status || "數據更新中...";
    
    if (data.is_simulated) {
        dot.className = "status-dot pulsing"; dot.style.background = "#ff9f43"; dot.style.boxShadow = "0 0 10px #ff9f43";
    } else {
        dot.className = "status-dot pulsing"; dot.style.background = "#00ff87"; dot.style.boxShadow = "0 0 10px #00ff87";
    }
    
    document.getElementById('val-temp').textContent = data.avg_temp_c.toFixed(1);
    document.getElementById('progress-temp').style.width = `${Math.min(Math.max((data.avg_temp_c / 50) * 100, 0), 100)}%`;
    
    document.getElementById('val-humid').textContent = data.avg_humidity.toFixed(1);
    document.getElementById('progress-humid').style.width = `${data.avg_humidity}%`;
    
    document.getElementById('val-noise').textContent = data.avg_noise_db.toFixed(1);
    document.getElementById('progress-noise').style.width = `${Math.min(Math.max(((data.avg_noise_db - 30) / 70) * 100, 0), 100)}%`;
    
    const noiseDesc = document.getElementById('noise-desc'); const noiseCard = document.getElementById('card-noise');
    if (data.avg_noise_db > 75) { noiseDesc.textContent = "⚠️ 警報: 環境過度嘈雜！"; noiseDesc.style.color = "#ff3366"; noiseCard.style.borderColor = "rgba(255, 8, 68, 0.4)"; } 
    else if (data.avg_noise_db > 60) { noiseDesc.textContent = "🟡 稍嫌嘈雜 (談話背景音)"; noiseDesc.style.color = "#ffbc00"; noiseCard.style.borderColor = "var(--card-border)"; } 
    else { noiseDesc.textContent = "🟢 舒適安全 (輕背景音)"; noiseDesc.style.color = "var(--text-muted)"; noiseCard.style.borderColor = "var(--card-border)"; }
}

// ==========================================
// 3. 核心事件監聽
// ==========================================
function initEventListeners() {
    document.getElementById('go-to-register').addEventListener('click', (e) => { e.preventDefault(); document.getElementById('login-form').classList.add('hidden'); document.getElementById('register-form').classList.remove('hidden'); hideAlert(); });
    document.getElementById('go-to-login').addEventListener('click', (e) => { e.preventDefault(); document.getElementById('register-form').classList.add('hidden'); document.getElementById('login-form').classList.remove('hidden'); hideAlert(); });

    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const res = await fetch(`${API_BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.getElementById('login-username').value.trim(), password: document.getElementById('login-password').value }) });
            const data = await res.json();
            if (data.success) {
                setCookie('beast_token', data.token, 7); setCookie('beast_user', encodeURIComponent(JSON.stringify(data.user)), 7); currentUser = data.user;
                showAlert('登入成功！', 'success'); setTimeout(() => { hideAlert(); showDashboard(); }, 1000);
            } else showAlert(data.message || '登入失敗', 'error');
        } catch (err) { showAlert('伺服器連線錯誤', 'error'); }
    });

    document.getElementById('register-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pwd = document.getElementById('register-password').value;
        if (pwd !== document.getElementById('register-confirm-password').value) { showAlert('密碼不一致', 'error'); return; }
        try {
            const res = await fetch(`${API_BASE}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.getElementById('register-username').value.trim(), password: pwd }) });
            const data = await res.json();
            if (data.success) {
                showAlert('註冊成功！', 'success');
                if(data.token) { setCookie('beast_token', data.token, 7); setCookie('beast_user', encodeURIComponent(JSON.stringify(data.user)), 7); }
                setTimeout(() => { document.getElementById('register-form').classList.add('hidden'); document.getElementById('login-form').classList.remove('hidden'); document.getElementById('login-username').value = document.getElementById('register-username').value.trim(); hideAlert(); }, 2000);
            } else showAlert(data.message || '註冊失敗', 'error');
        } catch (err) { showAlert('伺服器連線錯誤', 'error'); }
    });

    document.getElementById('logout-btn').addEventListener('click', () => { eraseCookie('beast_token'); eraseCookie('beast_user'); localStorage.removeItem('beast_user'); currentUser = null; showAuth(); });

    // 🌟 全新工作流：🔴 開始錄製 / ⏹️ 結束並獲取定位
    document.getElementById('toggle-record-btn').addEventListener('click', () => {
        const btn = document.getElementById('toggle-record-btn');
        const btnText = document.getElementById('record-text');
        const btnIcon = document.getElementById('record-icon');
        const timerDisplay = document.getElementById('recording-timer');

        if (!isRecording) {
            // --- 階段一：啟動錄製 ---
            isRecording = true;
            recordedData = { temp: [], humid: [], noise: [] };
            recordingStartTime = Date.now();

            btn.style.background = 'transparent';
            btn.style.border = '1px solid #ff3366';
            btn.style.color = '#ff3366';
            btn.style.boxShadow = '0 0 15px rgba(255, 51, 102, 0.4)';
            btnIcon.className = 'fa-solid fa-square'; 
            btnText.textContent = '結束並定位歸檔';
            
            timerDisplay.classList.remove('hidden');
            timerDisplay.textContent = '00:00';

            recordingTimerId = setInterval(() => {
                const diff = Math.floor((Date.now() - recordingStartTime) / 1000);
                const m = String(Math.floor(diff / 60)).padStart(2, '0');
                const s = String(diff % 60).padStart(2, '0');
                timerDisplay.textContent = `${m}:${s}`;
            }, 1000);

        } else {
            // --- 階段二：停止錄製並處理資料 ---
            isRecording = false;
            clearInterval(recordingTimerId);
            const durationSec = Math.floor((Date.now() - recordingStartTime) / 1000);

            // 恢復按鈕 UI
            btn.style = ''; 
            btnIcon.className = 'fa-solid fa-circle-dot';
            btnText.textContent = '開始錄製數據';
            timerDisplay.classList.add('hidden');

            if (durationSec < 3) {
                alert("錄製時間過短 (少於 3 秒)，已取消。");
                return;
            }

            finalAverages = {
                temp: recordedData.temp.length > 0 ? (recordedData.temp.reduce((a,b)=>a+b,0) / recordedData.temp.length) : 0,
                humid: recordedData.humid.length > 0 ? (recordedData.humid.reduce((a,b)=>a+b,0) / recordedData.humid.length) : 0,
                noise: recordedData.noise.length > 0 ? (recordedData.noise.reduce((a,b)=>a+b,0) / recordedData.noise.length) : 0,
                duration: durationSec
            };

            // 🌟 呼叫「強制定制定位與歸檔」流程
            triggerPostRecordWorkflow();
        }
    });

    document.getElementById('show-team-auth-btn').addEventListener('click', (e) => { e.preventDefault(); activeContainerBeforeTeam = 'auth-container'; document.getElementById('auth-container').classList.add('hidden'); document.getElementById('team-container').classList.remove('hidden'); });
    document.getElementById('show-team-dash-btn').addEventListener('click', () => { activeContainerBeforeTeam = 'dashboard-container'; document.getElementById('dashboard-container').classList.add('hidden'); document.getElementById('team-container').classList.remove('hidden'); stopPolling(); });
    document.getElementById('team-back-btn').addEventListener('click', () => { document.getElementById('team-container').classList.add('hidden'); document.getElementById(activeContainerBeforeTeam).classList.remove('hidden'); if (activeContainerBeforeTeam === 'dashboard-container') startPolling(); });
    document.getElementById('toggle-footer-btn').addEventListener('click', (e) => { e.preventDefault(); const footerSection = document.getElementById('team-footer-section'); const btn = document.getElementById('toggle-footer-btn'); footerSection.classList.toggle('hidden'); if (footerSection.classList.contains('hidden')) { btn.innerHTML = '<i class="fa-solid fa-circle-info"></i> 關於我們'; } else { btn.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> 收合內容'; setTimeout(() => footerSection.scrollIntoView({ behavior: 'smooth' }), 100); } });
    document.getElementById('update-port-btn').addEventListener('click', async () => { const comPort = document.getElementById('com-port-input').value.trim(); if (!comPort) return; try { await fetch(`${API_BASE}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ com_port: comPort }) }); alert(`通訊埠已設定為 ${comPort}`); } catch (err) {} });
}

function showAlert(message, type) {
    const box = document.getElementById('auth-message');
    box.textContent = message; box.className = `alert-message ${type}`; box.classList.remove('hidden');
}
function hideAlert() { document.getElementById('auth-message').classList.add('hidden'); }


// ==========================================
// 🌟 4. LBS 地圖與雙階段歸檔 (Post-Record Modal)
// ==========================================
function initBeastMap() {
    if (beastMap) { beastMap.invalidateSize(); return; }
    beastMap = L.map('beast-map').setView([24.1505, 120.6845], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { className: 'dark-map-tiles', attribution: '© OpenStreetMap' }).addTo(beastMap);
    passivelyTrackLocation();
}

function passivelyTrackLocation() {
    if ("geolocation" in navigator) {
        navigator.geolocation.watchPosition(
            (pos) => {
                currentGPS.lat = pos.coords.latitude; currentGPS.lng = pos.coords.longitude;
                beastMap.flyTo([currentGPS.lat, currentGPS.lng], 17);
                if (userMarker) beastMap.removeLayer(userMarker);
                const userIcon = L.divIcon({ className: 'user-gps-marker', html: '<i class="fa-solid fa-crosshairs fa-spin-pulse" style="color: #00f2fe; font-size: 24px; filter: drop-shadow(0 0 10px #00f2fe);"></i>', iconSize: [24, 24] });
                userMarker = L.marker([currentGPS.lat, currentGPS.lng], {icon: userIcon}).addTo(beastMap);
                document.getElementById('val-gps-status').textContent = `已鎖定: ${currentGPS.lat.toFixed(4)}, ${currentGPS.lng.toFixed(4)}`;
            },
            (err) => { document.getElementById('val-gps-status').textContent = "無法取得 GPS，請確認權限"; },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    }
}

// 🛑 觸發歸檔流程：強制要求最新 GPS -> 打 API 找附近店家 -> 打開 Modal
function triggerPostRecordWorkflow() {
    if (!navigator.geolocation) {
        alert("您的設備不支援定位功能！");
        return;
    }

    const btnText = document.getElementById('record-text');
    const oldText = btnText.textContent;
    btnText.textContent = "定位掃描中..."; // 給予使用者等待反饋

    // 🌟 核心防呆：強制主動獲取一次最新定位，避免 background watch 沒跟上
    navigator.geolocation.getCurrentPosition(async (pos) => {
        currentGPS.lat = pos.coords.latitude;
        currentGPS.lng = pos.coords.longitude;
        btnText.textContent = oldText;

        const token = getCookie('beast_token');
        try {
            const res = await fetch(`${API_BASE}/api/nearby?lat=${currentGPS.lat}&lng=${currentGPS.lng}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (res.status === 401) {
                alert("登入狀態已失效，請重新登入！");
                document.getElementById('logout-btn').click();
                return;
            }

            const data = await res.json();
            
            // 捕捉後端拋出的明確錯誤
            if (data.error) {
                alert("後端資料庫錯誤：" + data.error + "\n(請確認 app.py 的資料表結構已正確建立)");
                return;
            }

            openPostRecordModal(data);
        } catch (err) {
            console.error("Fetch nearby error:", err);
            alert("無法連線後端獲取周邊地標，可能是伺服器沒有啟動或網路錯誤。");
        }
    }, (err) => {
        btnText.textContent = oldText;
        alert("無法取得 GPS 定位，請確認您已開啟瀏覽器或手機的位置存取權限！");
    }, { enableHighAccuracy: true, timeout: 10000 });
}

function openPostRecordModal(stores) {
    document.getElementById('post-record-modal').classList.add('active');
    
    document.getElementById('modal-val-duration').textContent = finalAverages.duration;
    document.getElementById('modal-val-temp').textContent = finalAverages.temp.toFixed(1);
    document.getElementById('modal-val-humid').textContent = finalAverages.humid.toFixed(1);
    document.getElementById('modal-val-noise').textContent = finalAverages.noise.toFixed(1);
    document.getElementById('modal-gps-info').textContent = `(${currentGPS.lat.toFixed(5)}, ${currentGPS.lng.toFixed(5)})`;
    
    const listContainer = document.getElementById('modal-nearby-list');
    listContainer.innerHTML = '';
    
    stores.forEach((store, index) => {
        const label = document.createElement('label');
        label.innerHTML = `<input type="radio" name="loc_select" value="${store.id}" ${index === 0 ? 'checked' : ''}> 📍 ${escapeHtml(store.name)}`;
        label.addEventListener('change', updateModalRadioUI);
        listContainer.appendChild(label);
    });
    
    // 永遠加上「創建新地標」選項 (防呆：隔壁店問題)
    const newLabel = document.createElement('label');
    newLabel.style.color = '#00f2fe';
    newLabel.innerHTML = `<input type="radio" name="loc_select" value="NEW" ${stores.length === 0 ? 'checked' : ''}> ➕ 創建新王道地標...`;
    newLabel.addEventListener('change', updateModalRadioUI);
    listContainer.appendChild(newLabel);
    
    updateModalRadioUI();
}

function updateModalRadioUI() {
    document.querySelectorAll('#modal-nearby-list label').forEach(l => l.classList.remove('selected'));
    const checked = document.querySelector('input[name="loc_select"]:checked');
    if (checked) {
        checked.parentElement.classList.add('selected');
        const form = document.getElementById('modal-new-rest-form');
        if (checked.value === 'NEW') {
            form.classList.remove('hidden');
        } else {
            form.classList.add('hidden');
        }
    }
}

function closePostRecordModal() {
    if(confirm("確定要放棄剛才錄製的所有數據嗎？")) {
        document.getElementById('post-record-modal').classList.remove('active');
        document.getElementById('modal-record-name').value = '';
    }
}

// 🛑 終極上傳邏輯
async function submitPostRecord() {
    const recordName = document.getElementById('modal-record-name').value.trim();
    if (!recordName) { alert("請為這筆感官紀錄命名！"); return; }
    
    const selectedLoc = document.querySelector('input[name="loc_select"]:checked').value;
    const token = getCookie('beast_token');
    
    try {
        let finalRestId = selectedLoc;
        
        // 1. 若選擇創建新店家
        if (selectedLoc === 'NEW') {
            const newName = document.getElementById('modal-new-name').value.trim();
            const newAddr = document.getElementById('modal-new-addr').value.trim();
            const newHours = document.getElementById('modal-new-hours').value.trim();
            if (!newName) { alert("創建新地標需要填寫店家名稱！"); return; }
            
            const restRes = await fetch(`${API_BASE}/api/add-restaurant`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ 
                    name: newName, 
                    address: newAddr, 
                    business_hours: newHours, 
                    photo_url: "mock_image.jpg", // 模擬相機照片上傳
                    lat: currentGPS.lat, 
                    lng: currentGPS.lng 
                })
            });
            const restData = await restRes.json();
            if (!restData.success) { alert("創建地標失敗: " + (restData.message || '')); return; }
            finalRestId = restData.restaurant_id;
        }
        
        // 2. 寫入感官紀錄
        const saveRes = await fetch(`${API_BASE}/api/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
                record_name: recordName,
                restaurant_id: finalRestId,
                avg_temp_c: finalAverages.temp,
                avg_humidity: finalAverages.humid,
                avg_noise_db: finalAverages.noise,
                duration_sec: finalAverages.duration
            })
        });
        const saveData = await saveRes.json();
        
        if (saveData.success) {
            document.getElementById('post-record-modal').classList.remove('active');
            document.getElementById('modal-record-name').value = '';
            document.getElementById('modal-new-name').value = '';
            document.getElementById('modal-new-addr').value = '';
            document.getElementById('modal-new-hours').value = '';
            alert("✅ 歸檔成功！您的美食紀錄已寫入資料庫。");
            loadHistory(); 
        } else {
            alert(`歸檔失敗: ${saveData.message}`);
        }
    } catch (err) {
        alert("伺服器連線異常，無法歸檔");
    }
}


// ==========================================
// 5. 歷史紀錄與圖表
// ==========================================
async function loadHistory() {
    if (!currentUser) return;
    const token = getCookie('beast_token');
    try {
        const res = await fetch(`${API_BASE}/api/history`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (res.status === 401) { alert("登入狀態已失效，請重新登入！"); document.getElementById('logout-btn').click(); return; }
        const data = await res.json();
        if (data.success) {
            renderHistoryTable(data.records);
            renderHistoryChart(data.records);
        }
    } catch (err) { console.error("載入歷史失敗:", err); }
}

function renderHistoryTable(records) {
    const tbody = document.getElementById('history-tbody');
    tbody.innerHTML = '';
    if (!records || records.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center">目前沒有任何儲存的環境紀錄。點擊開始錄製！</td></tr>`;
        return;
    }
    records.forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${escapeHtml(r.record_name)}</strong></td>
            <td>${r.created_at}</td>
            <td><span class="highlight">${escapeHtml(r.rest_name || "未知 ("+r.restaurant_id+")")}</span></td>
            <td>${r.avg_temp_c.toFixed(1)} °C</td>
            <td>${r.avg_humidity.toFixed(1)} %</td>
            <td><span style="color: ${r.avg_noise_db > 75 ? '#ff3366' : (r.avg_noise_db > 60 ? '#ffbc00' : '#00ff87')}">${r.avg_noise_db.toFixed(1)} dB</span></td>
            <td>${r.duration_sec} 秒</td>
            <td><button class="btn-delete" onclick="deleteRecord(${r.id})"><i class="fa-solid fa-trash-can"></i> 刪除</button></td>
        `;
        tbody.appendChild(tr);
    });
}

async function deleteRecord(recordId) {
    if (!confirm("確定要刪除這筆歷史紀錄嗎？")) return;
    const token = getCookie('beast_token');
    try {
        const res = await fetch(`${API_BASE}/api/history/${recordId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json();
        if (data.success) loadHistory(); else alert(`刪除失敗`);
    } catch (err) { alert("刪除請求失敗。"); }
}

function renderHistoryChart(records) {
    const ctx = document.getElementById('historyChart').getContext('2d');
    if (chartInstance) chartInstance.destroy();
    
    const safeRecords = records || [];
    const chartRecords = [...safeRecords].slice(0, 12).reverse();
    const labels = chartRecords.map(r => r.record_name);
    const tempData = chartRecords.map(r => r.avg_temp_c);
    const humidData = chartRecords.map(r => r.avg_humidity);
    const noiseData = chartRecords.map(r => r.avg_noise_db);

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                { label: '平均溫度 (°C)', data: tempData, borderColor: '#ff7e5f', backgroundColor: 'rgba(255, 126, 95, 0.1)', borderWidth: 2, tension: 0.3, yAxisID: 'y' },
                { label: '平均濕度 (%)', data: humidData, borderColor: '#00c6ff', backgroundColor: 'rgba(0, 198, 255, 0.1)', borderWidth: 2, tension: 0.3, yAxisID: 'y' },
                { label: '噪音大小 (dB)', data: noiseData, borderColor: '#ff0844', backgroundColor: 'rgba(255, 8, 68, 0.05)', borderWidth: 2, borderDash: [5, 5], tension: 0.3, yAxisID: 'y1' }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: '#a0a0c0', font: { family: 'Outfit, Noto Sans TC' } } } },
            scales: {
                x: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#a0a0c0', font: { family: 'Outfit, Noto Sans TC' } } },
                y: { type: 'linear', display: true, position: 'left', grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#a0a0c0' }, title: { display: true, text: '溫濕度比例', color: '#a0a0c0' } },
                y1: { type: 'linear', display: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#ff0844' }, title: { display: true, text: '分貝大小 (dB)', color: '#ff0844' } }
            }
        }
    });
}

function escapeHtml(unsafe) {
    return String(unsafe).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}