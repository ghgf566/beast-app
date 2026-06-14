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

let storeMarkers = [];
let envRadarChartInstance = null;

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    
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
    
    // 🌟 登入後顯示全局搜尋框
    document.getElementById('nav-search-container').style.display = 'block';
    
    updateNavAvatar();

    if (!mainMap) {
        mainMap = L.map('map-container', { zoomControl: false }).setView([currentGPS.lat, currentGPS.lng], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { className: 'dark-map-tiles' }).addTo(mainMap);
        
        mainMap.on('click', (e) => { 
            // 關閉可能開啟的搜尋選單
            document.getElementById('search-dropdown-menu').classList.remove('show'); 
            
            // 🌟 解封：讓青藍色定位點 (虛擬GPS) 瞬間移動到你點擊的位置！
            currentGPS.lat = e.latlng.lat; 
            currentGPS.lng = e.latlng.lng; 
            updateMapMarker(); 
            fetchNearbyStores();
        });
        
        mainMap.on('dragstart', () => {
            document.getElementById('search-dropdown-menu').classList.remove('show');
        });
    }

    setInterval(pullIoTData, 1000);
    setInterval(syncHardwareDrafts, 5000);

    // 啟動定位
    backToMyLocation();
    renderDraftsInIoTPanel();
}

// 🌟 新增：回到我的定位按鈕邏輯
function backToMyLocation() {
    if("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(pos => { 
            currentGPS.lat = pos.coords.latitude; 
            currentGPS.lng = pos.coords.longitude; 
            updateMapMarker(); 
            mainMap.flyTo([currentGPS.lat, currentGPS.lng], 16);
            fetchNearbyStores(); 
            showToast("已取得最新定位", "success");
        }, err => {
            fetchNearbyStores();
            showToast("無法取得定位，將使用預設位置", "error");
        }, {enableHighAccuracy:true});
    } else {
        fetchNearbyStores();
        showToast("您的裝置不支援定位", "error");
    }
}

// 🌟 新增：全局搜尋邏輯與下拉選單
async function searchRestaurants() {
    const q = document.getElementById('nav-search-input').value.trim(); 
    const dropdown = document.getElementById('search-dropdown-menu');
    
    if(!q) { 
        dropdown.classList.remove('show'); 
        return fetchNearbyStores(); 
    }
    
    dropdown.innerHTML = '<div style="padding: 15px; text-align: center; color: #a0a0c0;"><i class="fa-solid fa-spinner fa-spin"></i> 搜尋中...</div>';
    dropdown.classList.add('show');
    
    try {
        const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(q)}&lat=${currentGPS.lat}&lng=${currentGPS.lng}`, { headers: { 'Authorization': `Bearer ${getCookie('beast_token')}` }});
        const data = await res.json();
        
        dropdown.innerHTML = '';
        if (data.error) throw new Error(data.error);
        if (data.success === false) throw new Error(data.message);
        
        if (data.length === 0) {
            dropdown.innerHTML = '<div style="padding: 15px; text-align: center; color: #a0a0c0;">找不到相關餐廳</div>';
            return;
        }

        // 確保新搜尋的資料有進到快取，方便等一下切換
        const newIds = data.map(d => d.id);
        cachedStoresGlobal = cachedStoresGlobal.filter(s => !newIds.includes(s.id)).concat(data);
        
        data.forEach(s => {
            // 🌟 直接拿後端算好的精準距離
            const dist = s.dist_m; 
            const stars = s.avg_rating > 0 ? `${s.avg_rating.toFixed(1)} ⭐` : `無評分`;
            
            dropdown.innerHTML += `
                <div class="search-result-item" onclick="selectSearchResult(${s.id})">
                    <span class="search-result-title">${escapeHtml(s.name)}</span>
                    <span class="search-result-dist">📍 距離約 ${dist}m | 評分: ${stars} | 👑 王道分數: ${s.recom_score}</span>
                </div>
            `;
        });
        
    } catch(e) { 
        dropdown.innerHTML = `<div style="padding: 15px; text-align: center; color: #ff3366;">搜尋發生異常</div>`; 
    }
}

// 🌟 新增：點擊搜尋結果的反應邏輯
function selectSearchResult(id) {
    document.getElementById('search-dropdown-menu').classList.remove('show');
    document.getElementById('nav-search-input').value = ''; 
    
    renderStores(cachedStoresGlobal, true); // 確保圖釘都畫上去了
    expandDrawerFull(true); // 拉起底部抽屜
    showStoreDetails(id); // 開啟該餐廳的細節面板
}

// 全局點擊防呆：點擊其他地方關閉搜尋框
document.addEventListener('click', (event) => {
    const searchDropdown = document.getElementById('search-dropdown-menu');
    if (searchDropdown && searchDropdown.classList.contains('show')) {
        const clickedInsideSearch = event.target.closest('#nav-search-container');
        if (!clickedInsideSearch) {
            searchDropdown.classList.remove('show');
        }
    }
    
    // 原本的頭像下拉關閉邏輯
    const userDropdown = document.getElementById('user-dropdown-menu');
    if (userDropdown && userDropdown.classList.contains('show')) {
        const clickedOnAvatar = event.target.closest('#nav-avatar-btn');
        const clickedInsideDropdown = userDropdown.contains(event.target);
        if (!clickedOnAvatar && !clickedInsideDropdown) {
            userDropdown.classList.remove('show');
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
    const dr = document.getElementById('bottom-drawer'); 
    if(exp) dr.classList.add('expanded'); else dr.classList.remove('expanded');
    document.getElementById('btn-toggle-more').textContent = exp ? "收合選單" : "展開選單";
    renderStores(cachedStoresGlobal, exp);
}

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

function renderStores(stores, showAll = false) {
    const list = document.getElementById('restaurant-list'); list.innerHTML = '';
    
    if (typeof storeMarkers !== 'undefined' && Array.isArray(storeMarkers)) {
        storeMarkers.forEach(m => mainMap.removeLayer(m));
    }
    storeMarkers = [];
    
    // 🌟 強制補上 Inline CSS 保證粉紫色地標絕對會出現
    const customIcon = L.divIcon({ 
        className: 'custom-div-icon', 
        html: '<i class="fa-solid fa-location-dot" style="color: #f093fb; font-size: 34px; filter: drop-shadow(0 0 12px rgba(240, 147, 251, 0.9));"></i>', 
        iconSize: [34,34],
        iconAnchor: [17,34] // 確保圖釘的尖端精準指在地圖座標上
    });

    if(!Array.isArray(stores) || stores.length === 0) { list.innerHTML = '<p class="empty-text">半徑範圍內無觀測地標。</p>'; return; }
    
    // 🌟 修正 1：不管底下選單有沒有展開，地圖上「永遠顯示半徑內所有的店家圖釘」！
    stores.forEach(s => {
        // 🌟 新增：準備懸浮提示框 (Tooltip) 的內容，顯示星等與評價數
        const starsForTooltip = s.avg_rating > 0 ? "⭐".repeat(Math.round(s.avg_rating)) + ` ${s.avg_rating.toFixed(1)}` : "尚無評分";
        const tooltipContent = `
            <div class="map-tooltip-content">
                <strong>${escapeHtml(s.name)}</strong>
                <span>${starsForTooltip} (${s.review_count}則)</span>
            </div>
        `;

        const marker = L.marker([s.lat, s.lng], {icon: customIcon}).addTo(mainMap);
        
        // 🌟 新增：綁定 Leaflet 內建的 Tooltip (滑鼠移入自動顯示，移出消失)
        marker.bindTooltip(tooltipContent, {
            direction: 'top', // 顯示在圖釘上方
            offset: [0, -30], // 稍微往上偏移，避免擋住圖釘
            className: 'cyber-map-tooltip' // 套用我們自訂的科幻 CSS
        });

        marker.on('click', () => {
            expandDrawerFull(true);
            showStoreDetails(s.id);
        });
        storeMarkers.push(marker);
    });

    // 🌟 修正 2：底下的文字清單，才依照 showAll 決定要不要折疊 (預設只顯示 2 筆)
    // 🌟 修正 2：底下的文字清單，才依照 showAll 決定要不要折疊
    const targetStores = showAll ? stores : stores.slice(0, 2);
    targetStores.forEach(s => {
        const stars = s.avg_rating > 0 ? "⭐".repeat(Math.round(s.avg_rating)) + ` ${s.avg_rating.toFixed(1)}` : "尚無評分";
        const reviewHtml = s.latest_review ? `<p class="rest-review">"${escapeHtml(s.latest_review)}"</p>` : '';
        
        // 🌟 新增 AI 推薦度與右側精準距離標籤
        const aiScoreHtml = `<span style="color: #f093fb; font-weight: bold; margin-left: 10px;"><i class="fa-solid fa-fire-flame-curved"></i> 王道推薦: ${s.recom_score}</span>`;
        
        const card = document.createElement('div'); 
        card.className = 'rest-card'; 
        card.onclick = () => showStoreDetails(s.id); 
        
        // 將標籤塞進 HTML 裡
        card.innerHTML = `
            <h4>${escapeHtml(s.name)} <span style="font-size: 0.8rem; color:#a0a0c0; float:right;">📍 ${s.dist_m}m</span></h4>
            <div class="rest-stats"><span>${stars} (${s.review_count}則)</span>${aiScoreHtml}</div>
            ${reviewHtml}
        `;
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
    if(!s.reviews || s.reviews.length === 0) {
        rBox.innerHTML = '<span class="empty-review">目前無文字點評</span>';
    } else {
        s.reviews.forEach(review => {
            let aiHtml = '';
            let reviewText = typeof review === 'string' ? review : review.text;
            let aiSummary = review.ai_summary;
            let weight = review.weight;

            if (aiSummary) {
                const glowColor = weight >= 80 ? '#f093fb' : (weight >= 60 ? '#00f2fe' : '#a0a0c0');
                aiHtml = `
                    <div style="margin-top: 8px; padding: 6px 10px; background: rgba(0,0,0,0.4); border-radius: 6px; border-left: 3px solid ${glowColor}; font-size: 0.8rem; box-shadow: 0 2px 10px ${glowColor}20;">
                        <span style="color: ${glowColor}; font-weight: bold;"><i class="fa-solid fa-robot"></i> BEAST AI 分析：</span>
                        <span style="color: #fff;">${escapeHtml(aiSummary)}</span>
                        <span style="float: right; color: ${glowColor}; font-family: monospace; font-weight: bold;">權重 ${Number(weight).toFixed(1)}</span>
                    </div>
                `;
            }
            
            rBox.innerHTML += `
                <div class="review-item" style="margin-bottom: 10px;">
                    <div style="color: #ccc;">"${escapeHtml(reviewText)}"</div>
                    ${aiHtml}
                </div>
            `;
        });
    }
    
    renderEnvChart(s);
    mainMap.flyTo([s.lat, s.lng], 18);
}

function renderEnvChart(s) {
    const ctx = document.getElementById('envRadarChart').getContext('2d');
    const tempScore = Math.max(0, 100 - Math.abs((s.env_temp || 24) - 24) * 6);
    const humidScore = Math.max(0, 100 - Math.abs((s.env_humid || 50) - 50) * 1.5);
    const noiseScore = Math.max(0, 100 - ((s.env_noise || 45) > 45 ? ((s.env_noise || 45) - 45) * 1.8 : 0));
    const ratingScore = (s.avg_rating || 0) * 20;
    const popScore = Math.min(100, (s.review_count || 0) * 15);

    const dataVals = [tempScore, humidScore, noiseScore, ratingScore, popScore];
    
    if (envRadarChartInstance) {
        envRadarChartInstance.data.datasets[0].data = dataVals;
        envRadarChartInstance.update();
    } else {
        envRadarChartInstance = new Chart(ctx, {
            type: 'radar',
            data: {
                labels: ['溫度適宜度', '濕度舒適度', '寧靜度', '王道星等', '熱門度'],
                datasets: [{
                    label: '環境戰力分析',
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
                plugins: { legend: { display: false } },
                animation: { duration: 800, easing: 'easeOutQuart' } 
            }
        });
    }
}

function backToListPane() { document.getElementById('pane-detail').classList.remove('active'); document.getElementById('pane-list').classList.remove('hidden'); }

function pullIoTData() {
    const simToggle = document.getElementById('sim-toggle');
    const isSimMode = simToggle ? simToggle.checked : false;
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('connection-status');
    const devId = currentUser?.device_id;

    // 先判斷是不是模擬模式
    if (isSimMode) {
        currentTemp = 21 + Math.random() * 8; currentHumid = 55 + Math.random() * 25; currentNoise = 40 + Math.random() * 45;
        if(dot) dot.className = "status-dot pulsing warning";
        if(txt) txt.textContent = `模擬模式 (${devId || '未綁定設備'})`;
        updateIoTUI();
        if (isRecording) { tempArr.push(currentTemp); humidArr.push(currentHumid); noiseArr.push(currentNoise); }
        return;
    }

    // 如果沒開模擬模式，且也沒有綁定設備
    if (!devId) {
        currentTemp = 0; currentHumid = 0; currentNoise = 0;
        if(dot) dot.className = "status-dot pulsing error";
        if(txt) txt.textContent = "未綁定設備";
        updateIoTUI(); 
        return;
    }

    fetch(`${API_BASE}/api/latest?device_id=${devId}`)
        .then(res => {
            if (!res.ok) throw new Error("伺服器無回應");
            return res.json();
        })
        .then(data => {
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
        })
        .catch(() => {
            // 🌟 關鍵修復：這裡補回了「無法連到後端」的警告
            currentTemp = 0; currentHumid = 0; currentNoise = 0;
            if(dot) dot.className = "status-dot pulsing error";
            if(txt) txt.textContent = "無法連線到後端伺服器";
            updateIoTUI();
        });
}

// 🌟 全域防呆：只要模擬開關一被點擊，馬上觸發 pullIoTData 刷新文字，不用等 1 秒
document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'sim-toggle') {
        pullIoTData();
    }
});

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
        
        const avgT = tempArr.length > 0 ? tempArr.reduce((a,b)=>a+b,0)/tempArr.length : currentTemp;
        const avgH = humidArr.length > 0 ? humidArr.reduce((a,b)=>a+b,0)/humidArr.length : currentHumid;
        const avgN = noiseArr.length > 0 ? noiseArr.reduce((a,b)=>a+b,0)/noiseArr.length : currentNoise;

        const draft = { id:Date.now(), date:new Date().toLocaleString(), duration:d, temp:avgT, humid:avgH, noise:avgN };
        drafts.push(draft); localStorage.setItem('beast_drafts', JSON.stringify(drafts)); 
        renderDraftsInIoTPanel();
        
        showToast("✅ 紀錄儲存成功！請點擊左側雷達圖示進入草稿匣歸檔", 'success');
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

function updateNavAvatar() {
    const navActions = document.getElementById('nav-actions');
    if (!navActions || !currentUser) return;

    let avatarContent = `<i class="fa-solid fa-user"></i>`;
    if (currentUser.avatar_url) {
        avatarContent = `<img src="${currentUser.avatar_url}" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"><i class="fa-solid fa-user" style="display:none;"></i>`;
    }

    navActions.innerHTML = `
        <div class="user-avatar-btn" id="nav-avatar-btn" style="pointer-events: auto; cursor: pointer;">
            ${avatarContent}
        </div>
    `;

    setTimeout(() => {
        const btn = document.getElementById('nav-avatar-btn');
        if (btn) {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation(); 
                toggleUserDropdown();
            });
        }
    }, 50);
}

function toggleUserDropdown() {
    const dropdown = document.getElementById('user-dropdown-menu');
    if (!dropdown) return;
    
    dropdown.classList.toggle('show');
    
    if (dropdown.classList.contains('show')) {
        document.getElementById('menu-username').textContent = currentUser.username || '探索者';
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
