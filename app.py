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
import psycopg2.extras # 讓 Postgres 回傳字典格式的資料

try:
    import serial
except ImportError:
    serial = None

app = Flask(__name__, static_folder='static')
app.config['SECRET_KEY'] = 'beast_super_secret_key_114514' 
CORS(app)

# ==========================================
# 🌟 雲端資料庫設定 (Neon PostgreSQL)
# ==========================================
# 請將下方換成你的 Neon 連線網址 (若部署在 Render，可從環境變數讀取)
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://neondb_owner:npg_KR2v4NGQonrk@ep-shy-dust-ao2dp1xn.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require")

# ==========================================
# 特調紅茶快取 (Upstash Redis)
# ==========================================
UPSTASH_REDIS_URL = os.environ.get("REDIS_URL", "rediss://default:AaaWAAIgcDE3MzU1ZGUyYjE2NTE0NGZhODgwYmRkMDc2MjM3NDIwMw@internal-titmouse-42646.upstash.io:6379")

try:
    r = redis.from_url(UPSTASH_REDIS_URL, decode_responses=True)
    r.ping()
    print("✅ [特調紅茶快取] 成功連線至 Upstash Redis！")
except Exception as e:
    print(f"❌ [特調紅茶快取] 連線失敗。錯誤: {e}")
    r = None

latest_data = {
    "avg_noise_db": 0.0, "avg_temp_c": 0.0, "avg_humidity": 0.0,
    "is_simulated": True, "status": "未連接 (模擬數據模式)"
}
latest_data_lock = threading.RLock() 
current_com_port = "COM5"
com_port_lock = threading.Lock()
serial_running = True

# ==========================================
# 初始化雲端資料庫表結構 (PostgreSQL 語法)
# ==========================================
def init_db():
    try:
        conn = psycopg2.connect(DATABASE_URL)
        cursor = conn.cursor()
        
        # Postgres 使用 SERIAL 來處理自動遞增
        cursor.execute('''CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS records (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, record_name TEXT NOT NULL, restaurant_id INTEGER, avg_noise_db REAL, avg_temp_c REAL, avg_humidity REAL, duration_sec INTEGER, created_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users (id))''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS restaurants (id SERIAL PRIMARY KEY, name TEXT NOT NULL, address TEXT, business_hours TEXT, photo_url TEXT, lat REAL NOT NULL, lng REAL NOT NULL)''')
        
        # 寫入預設的王道地標 (使用 ON CONFLICT 防止重複寫入)
        default_stores = [
            (101, '麥當勞 (學餐)', 24.1495, 120.6835),
            (102, '星巴克 (校門口)', 24.1505, 120.6845),
            (103, '圖書館咖啡', 24.1485, 120.6825)
        ]
        for store in default_stores:
            cursor.execute("INSERT INTO restaurants (id, name, lat, lng) VALUES (%s, %s, %s, %s) ON CONFLICT (id) DO NOTHING", store)
            
        conn.commit()
        conn.close()
        print("✅ [王道資料庫] 成功連線至 PostgreSQL！")
    except Exception as e:
        print(f"❌ [王道資料庫] PostgreSQL 連線或建表失敗: {e}")

def get_db_connection():
    return psycopg2.connect(DATABASE_URL)

def hash_password(password):
    return hashlib.sha256(password.encode('utf-8')).hexdigest()

def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        if 'Authorization' in request.headers:
            parts = request.headers['Authorization'].split()
            if len(parts) == 2 and parts[0] == 'Bearer': token = parts[1]
        if not token: return jsonify({'success': False, 'message': '未授權，缺少登入憑證'}), 401
        try:
            data = jwt.decode(token, app.config['SECRET_KEY'], algorithms=["HS256"])
            current_user_id = data['user_id']
        except Exception: return jsonify({'success': False, 'message': '登入已過期或無效'}), 401
        return f(current_user_id, *args, **kwargs)
    return decorated

def update_sensor_data(new_data):
    global latest_data
    with latest_data_lock:
        latest_data.update(new_data)
        if r: r.set("beast:sensor:latest", json.dumps(latest_data), ex=10)

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
                    update_sensor_data({"is_simulated": True, "status": f"無法連接 {port}，模擬模式"})
                    ser = None
            else:
                update_sensor_data({"is_simulated": True, "status": "未安裝 pyserial，模擬模式"})
                ser = None
        if ser and ser.is_open:
            try:
                if ser.in_waiting > 0:
                    raw_line = ser.readline().decode('utf-8', errors='ignore').strip()
                    if raw_line.startswith("{") and raw_line.endswith("}"):
                        try:
                            data = json.loads(raw_line)
                            update_sensor_data({
                                "avg_noise_db": data.get("avg_noise_db", 0.0),
                                "avg_temp_c": data.get("avg_temp_c", 0.0),
                                "avg_humidity": data.get("avg_humidity", 0.0),
                                "is_simulated": False,
                                "status": f"正在接收數據 ({port})"
                            })
                        except: pass
            except:
                ser = None
                update_sensor_data({"is_simulated": True, "status": "連接中斷，模擬模式"})
        else:
            time.sleep(2)
            with latest_data_lock:
                if latest_data["is_simulated"]:
                    update_sensor_data({
                        "avg_noise_db": round(random.uniform(50.0, 78.0), 1),
                        "avg_temp_c": round(random.uniform(22.0, 28.0), 1),
                        "avg_humidity": round(random.uniform(55.0, 75.0), 1)
                    })
        time.sleep(0.1)

# ==========================================
# API 路由
# ==========================================
@app.route('/')
def serve_index(): return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:path>')
def serve_static(path): return send_from_directory(app.static_folder, path)

@app.route('/api/register', methods=['POST'])
def api_register():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    try:
        # Postgres 使用 RETURNING id 來獲取剛新增的 ID
        cursor.execute("INSERT INTO users (username, password_hash) VALUES (%s, %s) RETURNING id",(username, hash_password(password)))
        user_id = cursor.fetchone()['id']
        conn.commit()
        token = jwt.encode({'user_id': user_id, 'exp': datetime.utcnow() + timedelta(days=7)}, app.config['SECRET_KEY'], algorithm="HS256")
        return jsonify({"success": True, "message": "註冊成功！", "token": token, "user": {"id": user_id, "username": username}})
    except psycopg2.IntegrityError:
        conn.rollback()
        return jsonify({"success": False, "message": "此帳號已被註冊"}), 400
    finally: conn.close()

@app.route('/api/login', methods=['POST'])
def api_login():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cursor.execute("SELECT * FROM users WHERE username = %s AND password_hash = %s", (username, hash_password(password)))
    user = cursor.fetchone()
    conn.close()
    if user:
        token = jwt.encode({'user_id': user['id'], 'exp': datetime.utcnow() + timedelta(days=7)}, app.config['SECRET_KEY'], algorithm="HS256")
        return jsonify({"success": True, "message": "登入成功！", "token": token, "user": {"id": user['id'], "username": user['username']}})
    return jsonify({"success": False, "message": "帳號或密碼錯誤"}), 401

@app.route('/api/latest', methods=['GET'])
def api_latest():
    if r:
        cached = r.get("beast:sensor:latest")
        if cached: return jsonify(json.loads(cached))
    with latest_data_lock: return jsonify(latest_data)

@app.route('/api/config', methods=['POST'])
def api_config():
    global current_com_port
    with com_port_lock: current_com_port = request.json.get('com_port', 'COM5')
    return jsonify({"success": True})

@app.route('/api/nearby', methods=['GET'])
@token_required
def api_nearby(current_user_id):
    try:
        lat, lng = float(request.args.get('lat', 0)), float(request.args.get('lng', 0))
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
        # PostgreSQL 距離計算語法
        query = "SELECT *, ((lat-%s)*(lat-%s) + (lng-%s)*(lng-%s)) AS dist FROM restaurants ORDER BY dist ASC LIMIT 10"
        cursor.execute(query, (lat, lat, lng, lng))
        stores = cursor.fetchall()
        results = [{"id": s['id'], "name": s['name']} for s in stores if s['dist'] < 0.0001]
        conn.close()
        return jsonify(results)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/add-restaurant', methods=['POST'])
@token_required
def add_restaurant(current_user_id):
    try:
        data = request.json
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
        cursor.execute(
            "INSERT INTO restaurants (name, address, business_hours, photo_url, lat, lng) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (data['name'], data.get('address', ''), data.get('business_hours', ''), data.get('photo_url', ''), data['lat'], data['lng'])
        )
        new_id = cursor.fetchone()['id']
        conn.commit()
        conn.close()
        return jsonify({"success": True, "restaurant_id": new_id})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/save', methods=['POST'])
@token_required
def api_save(current_user_id):
    data = request.json
    record_name = data.get('record_name')
    restaurant_id = data.get('restaurant_id')
    
    if not record_name or not restaurant_id:
        return jsonify({"success": False, "message": "缺少紀錄名稱或店家 ID"}), 400
        
    noise = data.get('avg_noise_db', 0)
    temp = data.get('avg_temp_c', 0)
    humid = data.get('avg_humidity', 0)
    duration = data.get('duration_sec', 0)
        
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        created_at = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        cursor.execute(
            """INSERT INTO records (user_id, record_name, restaurant_id, avg_noise_db, avg_temp_c, avg_humidity, duration_sec, created_at) 
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (current_user_id, record_name, restaurant_id, noise, temp, humid, duration, created_at)
        )
        conn.commit()
        return jsonify({"success": True})
    except Exception as e: 
        conn.rollback()
        return jsonify({"success": False, "message": str(e)}), 500
    finally: conn.close()

@app.route('/api/history', methods=['GET'])
@token_required
def api_history(current_user_id):
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cursor.execute("""
        SELECT r.*, rest.name as rest_name 
        FROM records r 
        LEFT JOIN restaurants rest ON r.restaurant_id = rest.id 
        WHERE r.user_id = %s ORDER BY r.created_at DESC
    """, (current_user_id,))
    records = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return jsonify({"success": True, "records": records})

@app.route('/api/history/<int:record_id>', methods=['DELETE'])
@token_required
def api_delete_record(current_user_id, record_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM records WHERE id = %s AND user_id = %s", (record_id, current_user_id))
    conn.commit()
    deleted = cursor.rowcount
    conn.close()
    if deleted > 0: return jsonify({"success": True})
    return jsonify({"success": False}), 404

if __name__ == '__main__':
    init_db()
    threading.Thread(target=serial_listener_thread, daemon=True).start()
    print("🚀 Flask 伺服器啟動於 http://0.0.0.0:5000")
    app.run(host='0.0.0.0', port=5000, debug=False)