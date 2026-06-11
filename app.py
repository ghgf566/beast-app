import os
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

import time
import json
import hashlib
import threading
import random
import jwt
from functools import wraps
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import redis 
import psycopg2
import psycopg2.extras

try:
    import serial
except ImportError:
    serial = None

app = Flask(__name__, static_folder='static')
app.config['SECRET_KEY'] = 'beast_super_secret_key_114514' 
CORS(app)

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://請換成你的_neon_連線字串_包含密碼@ep-xxx.aws.neon.tech/neondb?sslmode=require")
UPSTASH_REDIS_URL = os.environ.get("REDIS_URL", "rediss://default:AaaWAAIgcDE3MzU1ZGUyYjE2NTE0NGZhODgwYmRkMDc2MjM3NDIwMw@internal-titmouse-42646.upstash.io:6379")

try:
    r = redis.from_url(UPSTASH_REDIS_URL, decode_responses=True)
    r.ping()
except: r = None

latest_data = {
    "avg_noise_db": 0.0, "avg_temp_c": 0.0, "avg_humidity": 0.0,
    "is_simulated": True, "status": "等待感測器數據..."
}
latest_data_lock = threading.RLock() 
current_com_port = "COM5"
com_port_lock = threading.Lock()
serial_running = True

# 🌟 新增：萬一 Redis 不在，本機記憶體負責保存硬體傳來的草稿
hw_drafts_memory = {}
hw_drafts_lock = threading.Lock()

def init_db():
    if "ep-xxx.aws.neon.tech" in DATABASE_URL: return
    try:
        conn = psycopg2.connect(DATABASE_URL)
        conn.autocommit = True
        cursor = conn.cursor()
        
        cursor.execute('''CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS records (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, record_name TEXT NOT NULL, restaurant_id INTEGER, avg_noise_db REAL, avg_temp_c REAL, avg_humidity REAL, duration_sec INTEGER, created_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users (id))''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS restaurants (id SERIAL PRIMARY KEY, name TEXT NOT NULL, address TEXT, business_hours TEXT, photo_url TEXT, lat REAL NOT NULL, lng REAL NOT NULL)''')
        
        try: cursor.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user'")
        except: pass
        try: cursor.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'")
        except: pass
        try: cursor.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT ''")
        except: pass
        try: cursor.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS device_id TEXT DEFAULT ''")
        except: pass
        
        try: cursor.execute("ALTER TABLE records ADD COLUMN IF NOT EXISTS review_text TEXT")
        except: pass
        try: cursor.execute("ALTER TABLE records ADD COLUMN IF NOT EXISTS rating INTEGER")
        except: pass
        
        cursor.execute("SELECT id FROM users WHERE username = 'owner'")
        if not cursor.fetchone():
            cursor.execute("INSERT INTO users (username, password_hash, role, status) VALUES (%s, %s, 'owner', 'active')", ('owner', hash_password('beast_owner')))
        else:
            cursor.execute("UPDATE users SET password_hash = %s, role = 'owner', status = 'active' WHERE username = 'owner'", (hash_password('beast_owner'),))
        
        default_stores = [(101, '麥當勞 (學餐)', 24.1495, 120.6835), (102, '星巴克 (校門口)', 24.1505, 120.6845), (103, '圖書館咖啡', 24.1485, 120.6825)]
        for store in default_stores:
            cursor.execute("INSERT INTO restaurants (id, name, lat, lng) VALUES (%s, %s, %s, %s) ON CONFLICT (id) DO NOTHING", store)
            
        conn.close()
    except Exception as e: print(f"❌ 建表失敗: {e}")

def get_db_connection(): return psycopg2.connect(DATABASE_URL)
def hash_password(password): return hashlib.sha256(password.encode('utf-8')).hexdigest()

def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        if 'Authorization' in request.headers:
            parts = request.headers['Authorization'].split()
            if len(parts) == 2 and parts[0] == 'Bearer': token = parts[1]
        if not token: return jsonify({'success': False, 'message': '未授權'}), 401
        
        try:
            data = jwt.decode(token, app.config['SECRET_KEY'], algorithms=["HS256"])
            conn = get_db_connection()
            cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
            cursor.execute("SELECT id, username, role, status, avatar_url, device_id FROM users WHERE id = %s", (data['user_id'],))
            user = cursor.fetchone()
            conn.close()
            
            if not user: return jsonify({'success': False, 'message': '帳號不存在'}), 401
            status = user.get('status') or 'active'
            if status == 'frozen': return jsonify({'success': False, 'message': '此帳號已被凍結'}), 403
            
            safe_user = dict(user)
            safe_user['role'] = user.get('role') or 'user'
            safe_user['status'] = status
            safe_user['device_id'] = user.get('device_id') or ''
            
        except Exception: return jsonify({'success': False, 'message': '憑證過期'}), 401
        return f(safe_user, *args, **kwargs)
    return decorated

def update_sensor_data(new_data):
    global latest_data
    with latest_data_lock:
        latest_data.update(new_data)
        device_id = new_data.get("device_id", "BEAST-001")
        if r: 
            try: 
                r.set("beast:sensor:latest", json.dumps(latest_data), ex=10)
                r.set(f"beast:sensor:{device_id}", json.dumps(latest_data), ex=10)
            except: pass

def serial_listener_thread():
    global current_com_port, serial_running
    last_port = ""
    ser = None
    while serial_running:
        with com_port_lock: port = current_com_port
        if port != last_port:
            if ser and ser.is_open:
                try: ser.close()
                except: pass
            ser = None
            last_port = port
        if ser is None:
            if serial is not None:
                try:
                    ser = serial.Serial(port, 115200, timeout=1)
                    update_sensor_data({"is_simulated": False, "status": f"已連線 ({port})"})
                except:
                    update_sensor_data({"is_simulated": True, "status": f"等待設備連接...", "avg_noise_db": 0.0, "avg_temp_c": 0.0, "avg_humidity": 0.0})
                    ser = None
            else:
                update_sensor_data({"is_simulated": True, "status": "未安裝 pyserial", "avg_noise_db": 0.0, "avg_temp_c": 0.0, "avg_humidity": 0.0})
                ser = None
        if ser and ser.is_open:
            try:
                if ser.in_waiting > 0:
                    raw_line = ser.readline().decode('utf-8', errors='ignore').strip()
                    if raw_line.startswith("{") and raw_line.endswith("}"):
                        try:
                            data = json.loads(raw_line)
                            device_id = data.get("device_id", "BEAST-001")
                            
                            # 🌟 攔截 IoT 設備傳來的「物理紀錄草稿」
                            if data.get("action") == "save_draft":
                                draft_payload = {
                                    "id": int(time.time() * 1000),
                                    "date": datetime.now().strftime('%Y/%m/%d %H:%M:%S'),
                                    "duration": data.get("duration_sec", 0),
                                    "temp": data.get("avg_temp_c", 0.0),
                                    "humid": data.get("avg_humidity", 0.0),
                                    "noise": data.get("avg_noise_db", 0.0)
                                }
                                # 存入 Redis 佇列，或備用記憶體
                                if r: 
                                    r.lpush(f"beast:hw_drafts:{device_id}", json.dumps(draft_payload))
                                else:
                                    with hw_drafts_lock:
                                        if device_id not in hw_drafts_memory: hw_drafts_memory[device_id] = []
                                        hw_drafts_memory[device_id].append(draft_payload)
                                continue # 這是草稿，不更新即時數值

                            # 更新即時數據面板
                            update_sensor_data({
                                "avg_noise_db": data.get("avg_noise_db", 0.0), 
                                "avg_temp_c": data.get("avg_temp_c", 0.0), 
                                "avg_humidity": data.get("avg_humidity", 0.0), 
                                "is_simulated": False, 
                                "status": data.get("status", f"正在接收數據 ({port})"), 
                                "device_id": device_id
                            })
                        except: pass
            except:
                ser = None
                update_sensor_data({"is_simulated": True, "status": "連接中斷", "avg_noise_db": 0.0, "avg_temp_c": 0.0, "avg_humidity": 0.0})
        else: time.sleep(2)
        time.sleep(0.1)

@app.route('/api/register', methods=['POST'])
def api_register():
    data = request.json
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    try:
        cursor.execute("INSERT INTO users (username, password_hash, role, status, avatar_url, device_id) VALUES (%s, %s, 'user', 'active', '', '') RETURNING id",
                       (data['username'], hash_password(data['password'])))
        user_id = cursor.fetchone()['id']
        conn.commit()
        token = jwt.encode({'user_id': user_id}, app.config['SECRET_KEY'], algorithm="HS256")
        return jsonify({"success": True, "token": token, "user": {"id": user_id, "username": data['username'], "role": 'user', "avatar_url": '', "device_id": ''}})
    except psycopg2.IntegrityError:
        conn.rollback()
        return jsonify({"success": False, "message": "此帳號已被註冊"}), 400
    finally: conn.close()

@app.route('/api/login', methods=['POST'])
def api_login():
    data = request.json
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cursor.execute("SELECT * FROM users WHERE username = %s AND password_hash = %s", (data['username'], hash_password(data['password'])))
    user = cursor.fetchone()
    conn.close()
    if user:
        status = user.get('status') or 'active'
        if status == 'frozen': return jsonify({"success": False, "message": "帳號已遭凍結"}), 403
        token = jwt.encode({'user_id': user['id']}, app.config['SECRET_KEY'], algorithm="HS256")
        return jsonify({"success": True, "token": token, "user": {"id": user['id'], "username": user['username'], "role": user.get('role') or 'user', "avatar_url": user.get('avatar_url') or '', "device_id": user.get('device_id') or ''}})
    return jsonify({"success": False, "message": "帳號或密碼錯誤"}), 401

@app.route('/api/user/profile', methods=['PUT'])
@token_required
def update_profile(current_user):
    data = request.json
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        if 'password' in data and data['password']:
            cursor.execute("UPDATE users SET username = %s, avatar_url = %s, password_hash = %s WHERE id = %s", (data['username'], data.get('avatar_url', ''), hash_password(data['password']), current_user['id']))
        else:
            cursor.execute("UPDATE users SET username = %s, avatar_url = %s WHERE id = %s", (data['username'], data.get('avatar_url', ''), current_user['id']))
        conn.commit()
        return jsonify({"success": True, "message": "個人資料更新成功"})
    except: return jsonify({"success": False, "message": "名稱重複或更新失敗"}), 400
    finally: conn.close()

@app.route('/api/user/device', methods=['PUT'])
@token_required
def update_user_device(current_user):
    device_id = request.json.get('device_id', '').strip()
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("UPDATE users SET device_id = %s WHERE id = %s", (device_id, current_user['id']))
        conn.commit()
        return jsonify({"success": True, "device_id": device_id, "message": "設備綁定成功！"})
    except Exception as e:
        conn.rollback()
        return jsonify({"success": False, "message": str(e)}), 500
    finally: conn.close()

# 🌟 全新 API：讓手機來把硬體幫忙錄好的草稿給領走
@app.route('/api/user/hw-drafts', methods=['GET'])
@token_required
def sync_hw_drafts(current_user):
    device_id = current_user.get('device_id')
    if not device_id: return jsonify({"success": True, "drafts": []})
    
    drafts = []
    if r:
        # 把這個帳號的專屬草稿匣整個倒出來
        while True:
            item = r.rpop(f"beast:hw_drafts:{device_id}")
            if not item: break
            drafts.append(json.loads(item))
    else:
        with hw_drafts_lock:
            if device_id in hw_drafts_memory:
                drafts = hw_drafts_memory[device_id]
                hw_drafts_memory[device_id] = []
                
    return jsonify({"success": True, "drafts": drafts})

@app.route('/api/admin/users', methods=['GET'])
@token_required
def admin_get_users(current_user):
    if current_user['role'] not in ['admin', 'owner']: return jsonify({"success": False, "message": "權限不足"}), 403
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cursor.execute("SELECT id, username, role, status, avatar_url, device_id FROM users ORDER BY id ASC")
    users = [{"id": r['id'], "username": r['username'], "role": r['role'] or 'user', "status": r['status'] or 'active', "device_id": r['device_id'] or ''} for r in cursor.fetchall()]
    conn.close()
    return jsonify({"success": True, "users": users})

@app.route('/api/admin/users/<int:user_id>', methods=['PUT', 'DELETE'])
@token_required
def admin_manage_user(current_user, user_id):
    if current_user['role'] not in ['admin', 'owner']: return jsonify({"success": False, "message": "權限不足"}), 403
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cursor.execute("SELECT role FROM users WHERE id = %s", (user_id,))
    target_user = cursor.fetchone()
    if current_user['role'] == 'admin' and (target_user['role'] in ['admin', 'owner']):
        return jsonify({"success": False, "message": "無法修改同級或高層"}), 403

    if request.method == 'DELETE':
        cursor.execute("DELETE FROM records WHERE user_id = %s", (user_id,))
        cursor.execute("DELETE FROM users WHERE id = %s", (user_id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True})
        
    elif request.method == 'PUT':
        data = request.json
        updates, params = [], []
        if 'status' in data: updates.append("status = %s"); params.append(data['status'])
        if 'role' in data and current_user['role'] == 'owner': updates.append("role = %s"); params.append(data['role'])
        if 'username' in data: updates.append("username = %s"); params.append(data['username'])
        if 'password' in data and data['password']: updates.append("password_hash = %s"); params.append(hash_password(data['password']))
        if updates:
            params.append(user_id)
            try:
                cursor.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = %s", tuple(params))
                conn.commit()
            except:
                conn.rollback()
                return jsonify({"success": False, "message": "更新失敗"}), 400
        conn.close()
        return jsonify({"success": True})

@app.route('/api/admin/restaurants', methods=['GET'])
@token_required
def admin_get_restaurants(current_user):
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    query = """
        SELECT r.id, r.name, r.address, r.business_hours, 
               COUNT(rec.id) as record_count, COALESCE(AVG(rec.rating), 0)::FLOAT as avg_rating
        FROM restaurants r
        LEFT JOIN records rec ON r.id = rec.restaurant_id
        GROUP BY r.id ORDER BY r.id DESC
    """
    cursor.execute(query)
    stores = []
    for row in cursor.fetchall():
        d = dict(row)
        d['avg_rating'] = float(d['avg_rating'])
        stores.append(d)
    conn.close()
    return jsonify(stores)

@app.route('/api/admin/restaurants/<int:rest_id>', methods=['PUT', 'DELETE'])
@token_required
def admin_manage_restaurant(current_user, rest_id):
    if current_user['role'] not in ['admin', 'owner']: return jsonify({"success": False}), 403
    conn = get_db_connection()
    cursor = conn.cursor()
    if request.method == 'DELETE':
        cursor.execute("DELETE FROM records WHERE restaurant_id = %s", (rest_id,))
        cursor.execute("DELETE FROM restaurants WHERE id = %s", (rest_id,))
        conn.commit()
    else:
        data = request.json
        cursor.execute("UPDATE restaurants SET name=%s, address=%s, business_hours=%s WHERE id=%s", (data['name'], data.get('address',''), data.get('business_hours',''), rest_id))
        conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route('/api/admin/restaurants/<int:rest_id>/records', methods=['GET'])
@token_required
def admin_get_rest_records(current_user, rest_id):
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cursor.execute("""
        SELECT r.*, u.username 
        FROM records r 
        LEFT JOIN users u ON r.user_id = u.id 
        WHERE r.restaurant_id = %s ORDER BY r.created_at DESC
    """, (rest_id,))
    records = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return jsonify({"success": True, "records": records})

@app.route('/api/latest', methods=['GET'])
def api_latest():
    device_id = request.args.get('device_id')
    if device_id and r:
        try:
            cached = r.get(f"beast:sensor:{device_id}")
            if cached: return jsonify(json.loads(cached))
        except: pass
        return jsonify({"status": f"等待設備 {device_id} 訊號...", "is_simulated": True, "avg_temp_c": 0, "avg_humidity": 0, "avg_noise_db": 0})

    if r:
        try:
            cached = r.get("beast:sensor:latest")
            if cached: return jsonify(json.loads(cached))
        except: pass
    with latest_data_lock: return jsonify(latest_data)

@app.route('/api/config', methods=['POST'])
def api_config():
    global current_com_port
    with com_port_lock: current_com_port = request.json.get('com_port', 'COM5')
    return jsonify({"success": True, "status": f"已成功切換通訊埠至 {current_com_port}"})

def get_restaurant_details(stores):
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    results = []
    for s in stores:
        cursor.execute("SELECT rating, review_text, avg_temp_c, avg_humidity, avg_noise_db FROM records WHERE restaurant_id = %s", (s['id'],))
        records = cursor.fetchall()
        avg_rating, review_count = 0.0, len(records)
        sum_temp = sum_humid = sum_noise = 0
        stars_count = {5:0, 4:0, 3:0, 2:0, 1:0}
        all_reviews = []
        if review_count > 0:
            total_rating = 0
            for rec in records:
                rate = rec['rating'] if rec['rating'] is not None else 5
                total_rating += rate; stars_count[rate] += 1
                sum_temp += rec['avg_temp_c'] if rec['avg_temp_c'] is not None else 0
                sum_humid += rec['avg_humidity'] if rec['avg_humidity'] is not None else 0
                sum_noise += rec['avg_noise_db'] if rec['avg_noise_db'] is not None else 0
                if rec['review_text']: all_reviews.append(rec['review_text'])
            avg_rating = total_rating / review_count; sum_temp /= review_count; sum_humid /= review_count; sum_noise /= review_count
        results.append({
            "id": s['id'], "name": s['name'], "lat": s['lat'], "lng": s['lng'],
            "address": s['address'] or '無詳細地址紀錄', "business_hours": s['business_hours'] or '未設定營業時間',
            "avg_rating": round(avg_rating, 1), "review_count": review_count,
            "env_temp": round(sum_temp, 1) if sum_temp > 0 else 25.0,
            "env_humid": round(sum_humid, 1) if sum_humid > 0 else 60.0,
            "env_noise": round(sum_noise, 1) if sum_noise > 0 else 55.0,
            "stars_distribution": stars_count, "reviews": all_reviews[-5:]
        })
    conn.close()
    return results

@app.route('/api/nearby', methods=['GET'])
@token_required
def api_nearby(current_user):
    try:
        lat, lng = float(request.args.get('lat', 0)), float(request.args.get('lng', 0))
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
        cursor.execute("SELECT *, ((lat-%s)*(lat-%s) + (lng-%s)*(lng-%s)) AS dist FROM restaurants ORDER BY dist ASC LIMIT 10", (lat, lat, lng, lng))
        stores = cursor.fetchall()
        conn.close()
        return jsonify(get_restaurant_details(stores))
    except Exception as e: return jsonify({"error": str(e)}), 500

@app.route('/api/search', methods=['GET'])
@token_required
def api_search(current_user):
    try:
        q = request.args.get('q', '')
        lat, lng = float(request.args.get('lat', 0)), float(request.args.get('lng', 0))
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
        cursor.execute("SELECT *, ((lat-%s)*(lat-%s) + (lng-%s)*(lng-%s)) AS dist FROM restaurants WHERE name ILIKE %s ORDER BY dist ASC LIMIT 10", (lat, lat, lng, lng, f'%{q}%'))
        stores = cursor.fetchall()
        conn.close()
        return jsonify(get_restaurant_details(stores))
    except Exception as e: return jsonify({"error": str(e)}), 500

@app.route('/api/add-restaurant', methods=['POST'])
@token_required
def add_restaurant(current_user):
    data = request.json
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cursor.execute("INSERT INTO restaurants (name, address, business_hours, lat, lng) VALUES (%s, %s, %s, %s, %s) RETURNING id", (data['name'], data.get('address', ''), data.get('business_hours', ''), data['lat'], data['lng']))
    new_id = cursor.fetchone()['id']
    conn.commit()
    conn.close()
    return jsonify({"success": True, "restaurant_id": new_id})

@app.route('/api/save', methods=['POST'])
@token_required
def api_save(current_user):
    data = request.json
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """INSERT INTO records (user_id, record_name, restaurant_id, avg_noise_db, avg_temp_c, avg_humidity, duration_sec, review_text, rating, created_at) 
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (current_user['id'], data['record_name'], data['restaurant_id'], data.get('avg_noise_db', 0), data.get('avg_temp_c', 0), data.get('avg_humidity', 0), data.get('duration_sec', 0), data.get('review_text', ''), data.get('rating', 5), datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
        )
        conn.commit()
        return jsonify({"success": True})
    except Exception as e:
        conn.rollback()
        return jsonify({"success": False, "message": str(e)}), 500
    finally: conn.close()

@app.route('/api/history', methods=['GET'])
@token_required
def api_history(current_user):
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cursor.execute("SELECT r.*, rest.name as rest_name FROM records r LEFT JOIN restaurants rest ON r.restaurant_id = rest.id WHERE r.user_id = %s ORDER BY r.created_at DESC", (current_user['id'],))
    records = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return jsonify({"success": True, "records": records})

@app.route('/api/history/<int:record_id>', methods=['DELETE'])
@token_required
def api_delete_record(current_user, record_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    if current_user['role'] in ['admin', 'owner']:
        cursor.execute("DELETE FROM records WHERE id = %s", (record_id,))
    else:
        cursor.execute("DELETE FROM records WHERE id = %s AND user_id = %s", (record_id, current_user['id']))
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route('/')
def serve_user(): return send_from_directory(app.static_folder, 'user.html')

@app.route('/admin')
def serve_admin(): return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:path>')
def serve_static(path): return send_from_directory(app.static_folder, path)

if __name__ == '__main__':
    init_db()
    threading.Thread(target=serial_listener_thread, daemon=True).start()
    print("🚀 Flask 伺服器啟動於 http://0.0.0.0:5000")
    app.run(host='0.0.0.0', port=5000, debug=False)