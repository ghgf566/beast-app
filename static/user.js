const isLocalFile = window.location.protocol === 'file:';
const API_BASE = isLocalFile ? 'http://127.0.0.1:5000' : window.location.origin;

function setCookie(n,v,d){let t=new Date();t.setTime(t.getTime()+(d*864e5));document.cookie=n+"="+(v||"")+";expires="+t.toUTCString()+";path=/";}
function getCookie(n){let m=n+"=",a=document.cookie.split(';');for(let i=0;i<a.length;i++){let c=a[i].trim();if(c.indexOf(m)===0)return c.substring(m.length,c.length);}return null;}
function eraseCookie(n){document.cookie=n+'=;Path=/;Expires=Thu, 01 Jan 1970 00:00:01 GMT;';}

let currentUser = null;
let mainMap = null; let userMarker = null; let currentGPS = { lat: 24.1495, lng: 120.6835 }; 
let cachedStoresGlobal = []; 

let isRecording = false; let recordStartTime = 0; let recordTimerInterval = null;
let currentTemp = 0, currentHumid = 0, currentNoise = 0;
let tempArr = [], humidArr = [], noiseArr = [];
let drafts = JSON.parse(localStorage.getItem('beast_drafts') || '[]');
let activeDraftId = null;
let usbPort = null;

// 🌟 修復 1：補回遺失的全域變數 (否則地圖與圖表會報錯罷工)
let storeMarkers = [];
let envRadarChartInstance = null;

// 🌟 修復 2：補回遺失的科技感提示框函式
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) { console.error("Toast: " + message); return; } // 防呆
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? 'fa-check-circle' : (type === 'error' ? 'fa-circle-exclamation' : 'fa-info-circle');
    toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400); 
    }, 3000);
}

document.addEventListener('DOMContentLoaded', () => {
    const token = getCookie('beast_token');
    const savedUser = getCookie('beast_user');
    if (token && savedUser && token !== "undefined") {
        currentUser = JSON.parse(decodeURIComponent(savedUser));
        initAppMode();
    }

    // 🌟 新增：關於我們頁面的滾動視差與霧化特效
    const teamPage = document.getElementById('page-team');
    const introContainer = document.getElementById('team-intro-container');
    
    if (teamPage && introContainer) {
        teamPage.addEventListener('scroll', () => {
            const y = teamPage.scrollTop;
            
            // 透明度：向下滾動 300px 內逐漸變為 0 (隱藏)
            let opacity = Math.max(1 - (y / 300), 0);
            
            // 霧化：向下滾動逐漸增加到 15px 的模糊度
            let blur = Math.min(y / 20, 15);
            
            // 上移：產生高質感的視差效果 (Parallax)
            let translateY = -(y / 2.5);
            
            // 套用特效
            introContainer.style.opacity = opacity;
            introContainer.style.filter = `blur(${blur}px)`;
            introContainer.style.transform = `translateY(${translateY}px)`;
        });
    }
});

async function submitAuth(type) {
    const u = document.getElementById('auth-username').value.trim(), p = document.getElementById('auth-password').value;
    const err = document.getElementById('auth-error');
    if(!u || !p) { err.textContent="請填寫完整"; err.style.display='block'; return; }
    try {
        const res = await fetch(`${API_BASE}/api/${type}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:u, password:p}) });
        const d = await res.json();
        if(d.success) {
            setCookie('beast_token', d.token, 7); setCookie('beast_user', encodeURIComponent(JSON.stringify(d.user)), 7);
            currentUser = d.user; document.getElementById('auth-modal').classList.remove('active'); initAppMode();
        } else { err.textContent=d.message; err.style.display='block'; }
    } catch { err.textContent="連線失敗"; err.style.display='block'; }
}

function logout() { eraseCookie('beast_token'); eraseCookie('beast_user'); location.reload(); }

function initAppMode() {
    document.getElementById('view-landing').style.display = 'none';
    document.getElementById('view-app').style.display = 'block';
    
    const avatarHtml = currentUser.avatar_url ? `<img src="${currentUser.avatar_url}" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"><i class="fa-solid fa-user" style="display:none;"></i>` : `<i class="fa-solid fa-user"></i>`;
    document.getElementById('nav-actions').innerHTML = `<div class="user-avatar-btn" onclick="toggleUserDropdown(event)">${avatarHtml}</div>`;

    mainMap = L.map('map-container', { zoomControl: false }).setView([currentGPS.lat, currentGPS.lng], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { className: 'dark-map-tiles' }).addTo(mainMap);
    mainMap.on('click', (e) => { currentGPS.lat=e.latlng.lat; currentGPS.lng=e.latlng.lng; updateMapMarker(); fetchNearbyStores(); });

    mainMap.on('dragend', () => {
        const btn = document.getElementById('btn-search-area');
        if(btn) btn.classList.remove('hidden');
    });

    setInterval(pullIoTData, 1000);
    setInterval(syncHardwareDrafts, 5000);

    if("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(pos => { currentGPS.lat=pos.coords.latitude; currentGPS.lng=pos.coords.longitude; updateMapMarker(); fetchNearbyStores(); }, err => fetchNearbyStores(), {enableHighAccuracy:true});
    } else fetchNearbyStores();

    renderDraftsInIoTPanel();
}

function toggleUserDropdown(event) {
    if(event) event.stopPropagation(); // 阻止點擊事件冒泡，避免觸發空白處關閉
    const dropdown = document.getElementById('user-dropdown-menu');
    dropdown.classList.toggle('show');
    
    // 如果是打開狀態，就更新裡面的資料
    if (dropdown.classList.contains('show')) {
        document.getElementById('menu-username').textContent = currentUser.username;
        document.getElementById('menu-device-id').textContent = currentUser.device_id || '尚未綁定';
        
        const img = document.getElementById('menu-avatar-img');
        const icon = document.getElementById('menu-avatar-icon');
        if(currentUser.avatar_url) { 
            img.src = currentUser.avatar_url; 
            img.style.display = 'block'; 
            icon.style.display = 'none'; 
        } else { 
            img.style.display = 'none'; 
            icon.style.display = 'block'; 
        }
    }
}

document.addEventListener('click', (event) => {
    const dropdown = document.getElementById('user-dropdown-menu');
    // 如果選單是開著的，而且點擊的目標不是頭像按鈕，也不是選單本身，就關掉它
    if (dropdown && dropdown.classList.contains('show')) {
        const clickedOnAvatar = event.target.closest('.user-avatar-btn');
        const clickedInsideDropdown = dropdown.contains(event.target);
        if (!clickedOnAvatar && !clickedInsideDropdown) {
            dropdown.classList.remove('show');
        }
    }
});

function openProfilePage() {
    document.getElementById('page-profile').classList.add('active');
    document.getElementById('prof-name').value = currentUser.username;
    document.getElementById('prof-avatar').value = currentUser.avatar_url || '';
    document.getElementById('prof-pwd').value = '';
    
    const img = document.getElementById('profile-page-avatar');
    const icon = document.getElementById('profile-page-icon');
    if(currentUser.avatar_url) { img.src = currentUser.avatar_url; img.style.display = 'block'; icon.style.display = 'none'; } 
    else { img.style.display = 'none'; icon.style.display = 'block'; }
    
    document.getElementById('profile-page-name').textContent = currentUser.username;
    document.getElementById('profile-page-role').textContent = currentUser.role.toUpperCase();
}

async function saveProfile() {
    const data = { username: document.getElementById('prof-name').value.trim(), avatar_url: document.getElementById('prof-avatar').value.trim() };
    const pwd = document.getElementById('prof-pwd').value; if(pwd) data.password = pwd;
    try {
        const res = await fetch(`${API_BASE}/api/user/profile`, { method:'PUT', headers:{'Content-Type':'application/json','Authorization':`Bearer ${getCookie('beast_token')}`}, body:JSON.stringify(data)});
        const d = await res.json();
        if(d.success) { showToast('個人資料已更新！請重新登入', 'success'); setTimeout(logout, 1500); } 
        else showToast(d.message, 'error');
    } catch { showToast('更新失敗', 'error'); }
}

function openDevicePage() {
    document.getElementById('page-device').classList.add('active');
    document.getElementById('bind-device-id').value = currentUser.device_id || '';
}

function openTeamPage() {
    document.getElementById('page-team').classList.add('active');
}

async function saveDeviceBinding() {
    const devId = document.getElementById('bind-device-id').value.trim();
    if(!devId) { showToast("請輸入設備識別碼！", 'error'); return; }
    try {
        const res = await fetch(`${API_BASE}/api/user/device`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getCookie('beast_token')}` }, body: JSON.stringify({ device_id: devId }) });
        const d = await res.json();
        if(d.success) {
            showToast('設備綁定成功！', 'success');
            currentUser.device_id = d.device_id;
            setCookie('beast_user', encodeURIComponent(JSON.stringify(currentUser)), 7);
            document.getElementById('menu-device-id').textContent = d.device_id;
        } else showToast(d.message, 'error');
    } catch { showToast('綁定連線失敗', 'error'); }
}

async function connectUSB() {
    if (!("serial" in navigator)) {
        showToast("瀏覽器不支援 USB 連線！請用電腦版 Chrome", 'error');
        return;
    }
    try {
        usbPort = await navigator.serial.requestPort();
        await usbPort.open({ baudRate: 115200 });
        showToast("USB 連接成功！請輸入 Wi-Fi 密碼", 'success');
        
        const writeBtn = document.getElementById('btn-write-usb');
        writeBtn.disabled = false;
        writeBtn.classList.add('enabled');
        document.getElementById('btn-connect-usb').textContent = "已連接 USB";
    } catch (e) { showToast("USB 連接失敗: " + e.message, 'error'); }
}

async function writeWifiToDevice() {
    if (!usbPort) return showToast("請先連接 USB！", 'error');
    const ssid = document.getElementById("usb-ssid").value.trim();
    const pass = document.getElementById("usb-pass").value;
    
    if (!ssid) return showToast("請輸入手機熱點名稱！", 'error');
    
    try {
        const encoder = new TextEncoder();
        const writer = usbPort.writable.getWriter();
        await writer.write(encoder.encode(`SET_WIFI:${ssid},${pass}\n`));
        writer.releaseLock();
        showToast("Wi-Fi 設定已燒錄！設備將重啟。", 'success');
    } catch (e) { showToast("寫入失敗: " + e.message, 'error'); }
}

function updateMapMarker() {
    if(userMarker) mainMap.removeLayer(userMarker);
    const icon = L.divIcon({ className: 'user-gps-marker', html: '<i class="fa-solid fa-crosshairs fa-spin-pulse gps-icon"></i>', iconSize: [30,30] });
    userMarker = L.marker([currentGPS.lat, currentGPS.lng], {icon: icon}).addTo(mainMap);
    mainMap.flyTo([currentGPS.lat, currentGPS.lng], 17);
}

function toggleDrawerExpand(id) {
    const dr = document.getElementById(id); dr.classList.toggle('expanded');
    if(id === 'bottom-drawer') {
        const isExp = dr.classList.contains('expanded');
        document.getElementById('btn-toggle-more').textContent = isExp ? "收合選單" : "展開選單";
        renderStores(cachedStoresGlobal, isExp);
    }
}
function expandDrawerFull(exp) {
    const dr = document.getElementById('bottom-drawer'); if(exp) dr.classList.add('expanded'); else dr.classList.remove('expanded');
    document.getElementById('btn-toggle-more').textContent = exp ? "收合選單" : "展開選單";
    renderStores(cachedStoresGlobal, exp);
}

async function searchCurrentArea() {
    const center = mainMap.getCenter();
    currentGPS.lat = center.lat; currentGPS.lng = center.lng;
    document.getElementById('btn-search-area').classList.add('hidden'); 
    updateMapMarker();
    await fetchNearbyStores();
    expandDrawerFull(true);
}

// 🌟 強化防呆與報錯，不再沉默死當
async function fetchNearbyStores() {
    const list = document.getElementById('restaurant-list');
    try {
        const res = await fetch(`${API_BASE}/api/nearby?lat=${currentGPS.lat}&lng=${currentGPS.lng}`, { headers: { 'Authorization': `Bearer ${getCookie('beast_token')}` }});
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (data.success === false) throw new Error(data.message); 
        
        cachedStoresGlobal = Array.isArray(data) ? data : [];
        expandDrawerFull(false); 
    } catch(e) {
        console.error(e);
        list.innerHTML = `<p class="error-text">地標載入異常: ${e.message}</p>`;
    }
}

async function searchRestaurants() {
    const q = document.getElementById('search-input').value.trim(); if(!q) return fetchNearbyStores();
    const list = document.getElementById('restaurant-list');
    list.innerHTML = '<p class="loading-text"><i class="fa-solid fa-spinner fa-spin"></i> 搜尋中...</p>';
    try {
        const res = await fetch(`${API_BASE}/api/search?q=${q}&lat=${currentGPS.lat}&lng=${currentGPS.lng}`, { headers: { 'Authorization': `Bearer ${getCookie('beast_token')}` }});
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (data.success === false) throw new Error(data.message);
        
        cachedStoresGlobal = Array.isArray(data) ? data : [];
        expandDrawerFull(true); 
        if(cachedStoresGlobal.length > 0) mainMap.flyTo([cachedStoresGlobal[0].lat, cachedStoresGlobal[0].lng], 16);
    } catch(e) { 
        console.error(e);
        list.innerHTML = `<p class="error-text">搜尋異常: ${e.message}</p>`; 
    }
}

function renderStores(stores, showAll = false) {
    const list = document.getElementById('restaurant-list'); list.innerHTML = '';
    
    if (typeof storeMarkers !== 'undefined' && Array.isArray(storeMarkers)) {
        storeMarkers.forEach(m => mainMap.removeLayer(m));
    }
    storeMarkers = [];
    const customIcon = L.divIcon({ className: 'custom-div-icon', html: '<i class="fa-solid fa-location-dot store-marker-icon"></i>', iconSize: [30,30] });

    if(!Array.isArray(stores) || stores.length === 0) { list.innerHTML = '<p class="empty-text">半徑範圍內無觀測地標。</p>'; return; }
    
    const targetStores = showAll ? stores : stores.slice(0, 2);
    targetStores.forEach(s => {
        const marker = L.marker([s.lat, s.lng], {icon: customIcon}).addTo(mainMap);
        marker.on('click', () => showStoreDetails(s.id));
        storeMarkers.push(marker);

        const stars = s.avg_rating > 0 ? "⭐".repeat(Math.round(s.avg_rating)) + ` ${s.avg_rating.toFixed(1)}` : "尚無評分";
        const reviewHtml = s.latest_review ? `<p class="rest-review">"${escapeHtml(s.latest_review)}"</p>` : '';
        const card = document.createElement('div'); card.className = 'rest-card'; card.onclick = () => showStoreDetails(s.id); 
        card.innerHTML = `<h4>${escapeHtml(s.name)}</h4><div class="rest-stats"><span>${stars} (${s.review_count} 次觀測)</span></div>${reviewHtml}`;
        list.appendChild(card);
    });
}

function showStoreDetails(id) {
    const s = cachedStoresGlobal.find(item => item.id === id); if(!s) return;
    document.getElementById('pane-list').classList.add('hidden'); document.getElementById('pane-detail').classList.add('active');
    document.getElementById('det-name').textContent = s.name; document.getElementById('det-big-star').textContent = s.avg_rating.toFixed(1); document.getElementById('det-review-count').textContent = `${s.review_count} 則紀錄`;
    document.getElementById('det-temp').textContent = s.env_temp != null ? s.env_temp.toFixed(1) : '--'; document.getElementById('det-humid').textContent = s.env_humid != null ? s.env_humid.toFixed(1) : '--'; document.getElementById('det-noise').textContent = s.env_noise != null ? s.env_noise.toFixed(1) : '--';
    document.getElementById('det-hours').textContent = s.business_hours; document.getElementById('det-addr').textContent = s.address;

    const total = s.review_count || 1;
    for(let i=1; i<=5; i++) {
        const count = s.stars_distribution[i] || 0;
        document.getElementById(`star-bar-${i}`).style.width = `${(count / total) * 100}%`;
        document.getElementById(`star-num-${i}`).textContent = count;
    }

    const rBox = document.getElementById('det-reviews-box'); rBox.innerHTML = '';
    if(s.reviews.length === 0) rBox.innerHTML = '<span class="empty-review">目前無文字點評</span>';
    s.reviews.forEach(txt => rBox.innerHTML += `<div class="review-item">"${escapeHtml(txt)}"</div>`);
    
    renderEnvChart(s);
    mainMap.flyTo([s.lat, s.lng], 18);
}

function renderEnvChart(s) {
    const ctx = document.getElementById('envRadarChart').getContext('2d');
    const dataVals = [s.env_temp, s.env_humid, s.env_noise];
    
    if (envRadarChartInstance) {
        envRadarChartInstance.data.datasets[0].data = dataVals;
        envRadarChartInstance.update();
    } else {
        envRadarChartInstance = new Chart(ctx, {
            type: 'radar',
            data: {
                labels: ['溫度 (°C)', '濕度 (%)', '噪音 (dB)'],
                datasets: [{
                    label: '平均環境指標',
                    data: dataVals,
                    backgroundColor: 'rgba(0, 242, 254, 0.2)',
                    borderColor: '#00f2fe',
                    pointBackgroundColor: '#f093fb',
                    pointBorderColor: '#fff',
                    borderWidth: 2,
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    r: {
                        angleLines: { color: 'rgba(255,255,255,0.1)' },
                        grid: { color: 'rgba(255,255,255,0.1)' },
                        pointLabels: { color: '#a0a0c0', font: { family: 'Outfit', size: 12 } },
                        ticks: { display: false, min: 0, max: 100 }
                    }
                },
                plugins: { legend: { display: false } }
            }
        });
    }
}

function backToListPane() { document.getElementById('pane-detail').classList.remove('active'); document.getElementById('pane-list').classList.remove('hidden'); }

// 🌟 修復 3：邏輯順序錯位，確保「模擬模式」享有絕對優先權！
function pullIoTData() {
    const simToggle = document.getElementById('sim-toggle');
    const isSimMode = simToggle ? simToggle.checked : false;
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('connection-status');
    const devId = currentUser?.device_id;

    // 先判斷是不是模擬模式，是的話就不管有沒有綁定設備了，直接亂數跳！
    if (isSimMode) {
        currentTemp = 21 + Math.random() * 8; currentHumid = 55 + Math.random() * 25; currentNoise = 40 + Math.random() * 45;
        if(dot) dot.className = "status-dot pulsing warning";
        if(txt) txt.textContent = `模擬設備 (${devId || '未綁定'})`;
        updateIoTUI();
        if (isRecording) { tempArr.push(currentTemp); humidArr.push(currentHumid); noiseArr.push(currentNoise); }
        return;
    }

    // 如果沒開模擬模式，且也沒有綁定設備，才報錯
    if (!devId) {
        currentTemp = 0; currentHumid = 0; currentNoise = 0;
        if(dot) dot.className = "status-dot pulsing error";
        if(txt) txt.textContent = "未綁定設備";
        updateIoTUI(); 
        return;
    }

    fetch(`${API_BASE}/api/latest?device_id=${devId}`).then(res => res.json()).then(data => {
        if(!data.is_simulated) {
            currentTemp = data.avg_temp_c || 0; currentHumid = data.avg_humidity || 0; currentNoise = data.avg_noise_db || 0;
            if(dot) dot.className = "status-dot connected pulsing";
            if(txt) txt.textContent = `已連線至 ${devId}`;
        } else {
            currentTemp = 0; currentHumid = 0; currentNoise = 0;
            if(dot) dot.className = "status-dot pulsing error";
            if(txt) txt.textContent = `等待設備 ${devId} 雲端訊號...`;
        }
        updateIoTUI();
        if (isRecording && !data.is_simulated) { tempArr.push(currentTemp); humidArr.push(currentHumid); noiseArr.push(currentNoise); }
    }).catch(()=>{});
}

function updateIoTUI() {
    document.getElementById('iot-val-temp').textContent = currentTemp.toFixed(1);
    document.getElementById('iot-val-humid').textContent = currentHumid.toFixed(1);
    document.getElementById('iot-val-noise').textContent = currentNoise.toFixed(1);
}

function toggleRecording() {
    const fab = document.getElementById('fab-record'), icon = document.getElementById('record-icon'), tmr = document.getElementById('record-timer');
    if(!isRecording) {
        isRecording=true; tempArr=[]; humidArr=[]; noiseArr=[]; recordStartTime=Date.now();
        fab.classList.add('recording'); icon.className="fa-solid fa-stop"; tmr.classList.add('active');
        recordTimerInterval = setInterval(()=>{ const d=Math.floor((Date.now()-recordStartTime)/1000); tmr.textContent=`${String(Math.floor(d/60)).padStart(2,'0')}:${String(d%60).padStart(2,'0')}`; }, 1000);
    } else {
        isRecording=false; clearInterval(recordTimerInterval); const d=Math.floor((Date.now()-recordStartTime)/1000);
        fab.classList.remove('recording'); icon.className="fa-solid fa-podcast"; tmr.classList.remove('active'); tmr.textContent="00:00";
        
        if(d<3) { showToast("記錄過短，已捨棄。", 'error'); return; }
        const draft = { id:Date.now(), date:new Date().toLocaleString(), duration:d, temp:tempArr.reduce((a,b)=>a+b,0)/tempArr.length, humid:humidArr.reduce((a,b)=>a+b,0)/humidArr.length, noise:noiseArr.reduce((a,b)=>a+b,0)/noiseArr.length };
        drafts.push(draft); localStorage.setItem('beast_drafts', JSON.stringify(drafts)); 
        renderDraftsInIoTPanel();
        
        showToast("✅ 手動紀錄已成功儲存至草稿匣！", 'success');
    }
}

function syncHardwareDrafts() {
    if(!currentUser || !currentUser.device_id) return;
    fetch(`${API_BASE}/api/user/hw-drafts`, { headers: { 'Authorization': `Bearer ${getCookie('beast_token')}` }})
        .then(res => res.json())
        .then(data => {
            if(data.success && data.drafts && data.drafts.length > 0) {
                drafts = drafts.concat(data.drafts);
                localStorage.setItem('beast_drafts', JSON.stringify(drafts));
                renderDraftsInIoTPanel();
                
                const badge = document.getElementById('iot-draft-badge');
                badge.classList.remove('hidden');
                badge.classList.add('syncing');
                setTimeout(() => badge.classList.remove('syncing'), 3000);
            }
        }).catch(()=>{});
}

function renderDraftsInIoTPanel() {
    const list = document.getElementById('iot-drafts-list');
    const badge = document.getElementById('iot-draft-badge');
    
    document.getElementById('iot-draft-count').textContent = drafts.length;
    if(drafts.length > 0) { badge.classList.remove('hidden'); badge.textContent = drafts.length; } 
    else { badge.classList.add('hidden'); }
    
    list.innerHTML='';
    if(drafts.length === 0) { 
        list.innerHTML='<p class="empty-draft">目前無待歸檔之紀錄</p>'; 
    } else {
        drafts.slice().reverse().forEach(d => {
            list.innerHTML += `
                <div class="draft-card">
                    <div class="draft-header">
                        <span><i class="fa-solid fa-clock"></i> ${d.date}</span>
                        <span class="draft-duration">時長: ${d.duration}s</span>
                    </div>
                    <div class="draft-stats">
                        <span class="c-temp">${d.temp.toFixed(1)}°C</span>
                        <span class="c-humid">${d.humid.toFixed(1)}%</span>
                        <span class="c-noise">${d.noise.toFixed(1)}dB</span>
                    </div>
                    <div class="draft-actions">
                        <button class="btn-discard" onclick="deleteDraft(${d.id})">捨棄</button>
                        <button class="btn-publish" onclick="preparePublish(${d.id})">填寫歸檔</button>
                    </div>
                </div>
            `;
        });
    }
}

function deleteDraft(id) { drafts=drafts.filter(d=>d.id!==id); localStorage.setItem('beast_drafts',JSON.stringify(drafts)); renderDraftsInIoTPanel(); }

async function preparePublish(id) {
    document.getElementById('iot-sheet').classList.remove('active');
    activeDraftId = id; const d = drafts.find(i=>i.id===id);
    document.getElementById('pub-duration').textContent=d.duration; document.getElementById('pub-temp').textContent=d.temp.toFixed(1); document.getElementById('pub-noise').textContent=d.noise.toFixed(1);
    
    const sel = document.getElementById('pub-restaurant-select'); sel.innerHTML='';
    cachedStoresGlobal.forEach(s=>sel.innerHTML+=`<option value="${s.id}">📍 ${s.name}</option>`);
    document.getElementById('publish-modal').classList.add('active');
}

async function submitPublish() {
    const name = document.getElementById('pub-record-name').value.trim(); if(!name){ showToast("請填寫紀錄名稱！", 'error'); return;}
    let finalRestId = document.getElementById('pub-restaurant-select').value;
    const token = getCookie('beast_token');
    try {
        if (!document.getElementById('pub-new-rest-form').classList.contains('hidden') && document.getElementById('pub-new-name').value.trim() !== '') {
            const n = document.getElementById('pub-new-name').value.trim(), h = document.getElementById('pub-new-hours').value.trim();
            const rRes = await fetch(`${API_BASE}/api/add-restaurant`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ name: n, business_hours: h, lat: currentGPS.lat, lng: currentGPS.lng }) });
            finalRestId = (await rRes.json()).restaurant_id;
        }
        const d = drafts.find(i=>i.id===activeDraftId);
        const res = await fetch(`${API_BASE}/api/save`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify({record_name:name,restaurant_id:finalRestId,avg_temp_c:d.temp,avg_humidity:d.humid,avg_noise_db:d.noise,duration_sec:d.duration,review_text:document.getElementById('pub-review').value,rating:parseInt(document.getElementById('pub-rating').value)})});
        if((await res.json()).success) {
            showToast("✅ 歸檔成功！王道大數據已更新。", 'success');
            drafts=drafts.filter(i=>i.id!==activeDraftId); localStorage.setItem('beast_drafts',JSON.stringify(drafts)); renderDraftsInIoTPanel();
            document.getElementById('publish-modal').classList.remove('active'); fetchNearbyStores();
        }
    } catch { showToast("發布失敗", 'error'); }
}
function escapeHtml(u){return String(u).replace(/&/g,"&amp;").replace(/</g,"&lt;");}