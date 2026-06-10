try:
    import serial
except ImportError:
    serial = None

import json
from datetime import datetime

# ==========================================
# ⚠️ 請把這裡的 'COM5' 換成你在裝置管理員找到的那個藍牙 COM Port
# (如果有兩個藍牙 COM Port，通常數字比較小的那個是接收端，可以兩個都試試看)
# ==========================================
BLUETOOTH_PORT = 'COM5'  
BAUD_RATE = 115200

def main():
    print(f"📡 正在連接藍牙裝置 {BLUETOOTH_PORT}...")
    try:
        # 連接藍牙 Serial
        bt_serial = serial.Serial(BLUETOOTH_PORT, BAUD_RATE, timeout=1)
        print("✅ 藍牙連線成功！正在監聽 ESP32 傳來的數據...\n")
        
        while True:
            # 讀取藍牙傳來的資料
            if bt_serial.in_waiting > 0:
                raw_data = bt_serial.readline().decode('utf-8').strip()
                
                # 確保收到的是我們發的 JSON 格式
                if raw_data.startswith("{") and raw_data.endswith("}"):
                    try:
                        data = json.loads(raw_data)
                        current_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                        
                        # 終端機即時顯示
                        print("=".center(45, "="))
                        print(f"📡 [藍牙接收] 成功獲取環境數據！")
                        print(f"⏰ 接收時間: {current_time}")
                        print(f"📍 餐廳 ID: {data['restaurant_id']}")
                        print(f"🔊 平均噪音: {data['avg_noise_db']} dB")
                        print(f"🌡️ 平均溫度: {data['avg_temp_c']} °C")
                        print(f"💧 平均濕度: {data['avg_humidity']} %")
                        print(f"⏱️ 錄製時長: {data['duration_sec']} 秒")
                        print("=".center(45, "=") + "\n")

                        # 寫入文字檔留存
                        with open("live_data.txt", "a", encoding="utf-8") as file:
                            log_line = f"[{current_time}] 餐廳:{data['restaurant_id']} | 噪音:{data['avg_noise_db']}dB | 溫度:{data['avg_temp_c']}°C | 濕度:{data['avg_humidity']}% | 停留:{data['duration_sec']}秒\n"
                            file.write(log_line)
                            
                    except json.JSONDecodeError:
                        print(f"⚠️ 解析錯誤，收到的原始字串: {raw_data}")

    except serial.SerialException as e:
        print(f"❌ 無法連接到 {BLUETOOTH_PORT}。請確認 ESP32 是否已開機且藍牙已配對！")
        print(f"錯誤詳情: {e}")
    except KeyboardInterrupt:
        print("\n程式手動結束。")
        if 'bt_serial' in locals() and bt_serial.is_open:
            bt_serial.close()

if __name__ == '__main__':
    main()