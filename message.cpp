// ==========================================
// BEAST 感官捕獲系統 - 藍牙專機直傳草稿版
// ==========================================

#include "BluetoothSerial.h"
#include "DHT.h"

// --- 藍牙設定 ---
#if !defined(CONFIG_BT_ENABLED) || !defined(CONFIG_BLUEDROID_ENABLED)
#error 你的 ESP32 板子沒有開啟藍牙功能！
#endif

BluetoothSerial SerialBT; // 建立藍牙物件

// 🌟 設備專屬設定 (手機端綁定用的 ID)
const String DEVICE_ID = "BEAST-001"; 

// --- 硬體腳位設定 ---
const int btnRecordPin = 0;   // 按鈕 A：內建 BOOT 鍵 (負責 開始/結束物理錄製)
const int ledPin = 2;         // 內建藍色 LED

#define DHTPIN 15             // DHT11 接在 GPIO 15
#define DHTTYPE DHT11         
DHT dht(DHTPIN, DHTTYPE);

// --- 狀態與數據變數 ---
bool isRecording = false;
unsigned long lastSampleTime = 0;
const unsigned long sampleInterval = 2000; // 每 2 秒採集並回傳一次即時數據

float totalNoise = 0, totalTemp = 0, totalHumid = 0;
int sampleCount = 0;
unsigned long startTime = 0;

void setup() {
  Serial.begin(115200);
  
  pinMode(btnRecordPin, INPUT_PULLUP);
  pinMode(ledPin, OUTPUT);
  digitalWrite(ledPin, LOW); 
  dht.begin();

  // 啟動藍牙，設定藍牙名稱！
  SerialBT.begin("BEAST_ESP32_IoT"); 
  
  Serial.println("\n=================================");
  Serial.println("✅ 藍牙已啟動！");
  Serial.println("👉 請在電腦端開啟藍牙，並配對「BEAST_ESP32_IoT」");
  Serial.println("=================================\n");
}

void loop() {
  // ---------------------------------------------------------
  // 1. 偵測按鈕：開始 / 結束物理錄製
  // ---------------------------------------------------------
  if (digitalRead(btnRecordPin) == LOW) {
    delay(50); // 防彈跳
    if (digitalRead(btnRecordPin) == LOW) {
      if (!isRecording) {
        startCapture();
      } else {
        stopCapture();
      }
      // 等待按鈕放開
      while(digitalRead(btnRecordPin) == LOW) { delay(10); }
    }
  }

  // ---------------------------------------------------------
  // 2. 採集即時數據並發送 (給手機/電腦即時面板顯示用)
  // ---------------------------------------------------------
  if (millis() - lastSampleTime >= sampleInterval) {
    collectAndSendTelemetry();
    lastSampleTime = millis();
  }
}

// ==========================================
// 核心功能函式
// ==========================================

void startCapture() {
  isRecording = true;
  digitalWrite(ledPin, HIGH); 
  sampleCount = 0; totalNoise = 0; totalTemp = 0; totalHumid = 0;
  startTime = millis();
  Serial.println("\n[事件] 👉 開始物理錄製！");
}

void collectAndSendTelemetry() {
  // 讀取溫濕度
  float currentTemp = dht.readTemperature();
  float currentHumid = dht.readHumidity();
  
  // 防呆：如果感測器讀不到數值
  if (isnan(currentTemp) || isnan(currentHumid)) {
    currentTemp = 25.0; currentHumid = 60.0;
  }
  
  // 模擬噪音 (有真實麥克風請改為 analogRead)
  float currentNoiseDb = random(500, 800) / 10.0;

  if (isRecording) {
    totalTemp += currentTemp;
    totalHumid += currentHumid;
    totalNoise += currentNoiseDb;
    sampleCount++;
  }

  // 🌟 組合即時動態 JSON (包含 device_id)
  String statusStr = isRecording ? "物理錄製中..." : "待機中";
  String telemetryJson = "{\"device_id\": \"" + DEVICE_ID + "\", \"status\": \"" + statusStr + "\", \"avg_temp_c\": " + String(currentTemp, 1) + ", \"avg_humidity\": " + String(currentHumid, 1) + ", \"avg_noise_db\": " + String(currentNoiseDb, 1) + "}";
  
  // 透過 USB 與 藍牙 同時發送
  Serial.println(telemetryJson);
  SerialBT.println(telemetryJson);
}

void blinkSuccessLED() {
  for (int i = 0; i < 3; i++) {
    digitalWrite(ledPin, HIGH); delay(80);
    digitalWrite(ledPin, LOW); delay(80);
  }
}

void stopCapture() {
  isRecording = false;
  int durationSec = (millis() - startTime) / 1000;

  // 必須大於 3 秒才算有效紀錄
  if (durationSec >= 3 && sampleCount > 0) {
    float avgTemp = totalTemp / sampleCount;
    float avgHumid = totalHumid / sampleCount;
    float avgNoise = totalNoise / sampleCount;

    // 🌟 組合完結篇草稿 JSON (帶有 action = save_draft)
    String draftJson = "{\"device_id\": \"" + DEVICE_ID + "\", \"action\": \"save_draft\", \"duration_sec\": " + String(durationSec) + ", \"avg_temp_c\": " + String(avgTemp, 1) + ", \"avg_humidity\": " + String(avgHumid, 1) + ", \"avg_noise_db\": " + String(avgNoise, 1) + "}";

    Serial.println("\n[事件] 👈 結束錄製！發送草稿至雲端。");
    Serial.println("📤 發送 Payload: " + draftJson);
    
    // 透過藍牙發送給 Python 後端攔截
    SerialBT.println(draftJson); 
    
    // 閃爍 3 下代表發送完成
    blinkSuccessLED(); 
  } else {
    Serial.println("\n[錯誤] 錄製時間太短，草稿已捨棄。");
  }
  
  digitalWrite(ledPin, LOW); 
  Serial.println("--------------------------------------------------");
}