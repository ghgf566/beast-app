// ==========================================
// BEAST 感官捕獲系統 - 雙核心 (Dual-Core) 終極流暢版
// ==========================================

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include "DHT.h"
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// 🌟 雲端接收站網址 (Webhook)
const char* serverUrl = "https://beast-app.onrender.com/api/iot/webhook";
const String DEVICE_ID = "BEAST-001"; 

// --- 硬體腳位設定 ---
const int btnRecordPin = 0;   
const int ledPin = 2;         
const int MIC_PIN = 34;       

#define DHTPIN 15
#define DHTTYPE DHT11         
DHT dht(DHTPIN, DHTTYPE);

Preferences preferences; 
LiquidCrystal_I2C lcd(0x27, 16, 2); 

// --- 共享狀態變數 (跨核心需加 volatile) ---
volatile bool isRecording = false;
volatile float currentTemp = 0.0;
volatile float currentHumid = 0.0;
volatile float currentNoiseDb = 0.0;

volatile float totalNoise = 0, totalTemp = 0, totalHumid = 0;
volatile int sampleCount = 0;
volatile unsigned long startTime = 0;

// 🌟 螢幕休眠控制變數
volatile bool isScreenAwake = true;
unsigned long lastActivityTime = 0;
const unsigned long SLEEP_TIMEOUT = 15000; // 15 秒自動休眠

// 🌟 背景上傳草稿的信號與資料
volatile bool pendingDraftUpload = false;
String pendingDraftJson = "";

// 雙核心任務 Handler
TaskHandle_t NetworkTask;

// 事前宣告
void startCapture();
void stopCapture();
void collectAndSendTelemetry();
void blinkSuccessLED();
void sendToCloud(String payload);
void processSerialCommands();
void updateLCD();
void networkTaskCode(void * parameter);

void setup() {
  Serial.begin(115200);
  
  pinMode(btnRecordPin, INPUT_PULLUP);
  pinMode(ledPin, OUTPUT);
  pinMode(MIC_PIN, INPUT); 
  digitalWrite(ledPin, LOW); 
  dht.begin();

  Wire.begin(); 
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("BEAST OS booting");
  
  Serial.println("\n=================================");
  Serial.println("🚀 BEAST 雙核心系統啟動！");
  
  preferences.begin("beast-wifi", false);
  String ssid = preferences.getString("ssid", "");
  String pass = preferences.getString("pass", "");

  if (ssid == "") {
    lcd.setCursor(0, 1); lcd.print("Mode: USB Setup ");
  } else {
    lcd.setCursor(0, 1); lcd.print("Conn Wi-Fi...   ");
    WiFi.begin(ssid.c_str(), pass.c_str());
    int retryCount = 0;
    while (WiFi.status() != WL_CONNECTED && retryCount < 20) {
      delay(500); Serial.print("."); retryCount++;
    }
    if (WiFi.status() == WL_CONNECTED) {
      lcd.setCursor(0, 1); lcd.print("Wi-Fi Connected!");
    } else {
      lcd.setCursor(0, 1); lcd.print("Wi-Fi Failed!   ");
    }
  }
  
  delay(1500); 
  lastActivityTime = millis(); 

  // 🌟 核心：啟動背景核心任務 (Core 0 負責網路與感測器)
  xTaskCreatePinnedToCore(
    networkTaskCode, "NetworkTask", 10000, NULL, 1, &NetworkTask, 0
  );
  
  Serial.println("=================================\n");
}

// 🌟 主迴圈 (Core 1：專職負責 UI / 按鈕 / 螢幕，保證 0 延遲)
void loop() {
  processSerialCommands();

  // 1. 偵測按鈕
  if (digitalRead(btnRecordPin) == LOW) {
    delay(50); // 防彈跳
    if (digitalRead(btnRecordPin) == LOW) {
      
      lastActivityTime = millis(); 
      
      if (!isScreenAwake) {
        // 動作A：單純喚醒螢幕
        isScreenAwake = true;
        lcd.backlight();
        if(!pendingDraftUpload) updateLCD(); 
        Serial.println("🔆 螢幕已喚醒");
      } else {
        // 動作B：切換錄音
        if (!isRecording) startCapture();
        else stopCapture();
        if(!pendingDraftUpload) updateLCD(); 
      }
      
      while(digitalRead(btnRecordPin) == LOW) { delay(10); } 
    }
  }

  // 2. 自動休眠
  if (isScreenAwake && (millis() - lastActivityTime > SLEEP_TIMEOUT)) {
    isScreenAwake = false;
    lcd.noBacklight(); 
    lcd.clear();       
    Serial.println("💤 螢幕進入節能休眠");
  }

  // 3. 處理草稿上傳完成的 UI 恢復
  static bool wasUploading = false;
  if (wasUploading && !pendingDraftUpload) {
     wasUploading = false;
     lcd.clear();
     if (isScreenAwake) updateLCD(); // 上傳完畢，切回狀態儀表板
  }
  wasUploading = pendingDraftUpload;

  // 4. 定期更新螢幕數值 (每秒)
  static unsigned long lastLcdTime = 0;
  if (isScreenAwake && !pendingDraftUpload && (millis() - lastLcdTime > 1000)) {
     updateLCD();
     lastLcdTime = millis();
  }
  
  delay(10); // 讓出 CPU 給系統
}

// ==========================================
// 🌟 Core 0：背景網路與感測任務
// ==========================================
void networkTaskCode(void * parameter) {
  unsigned long lastSampleTime = 0;
  const unsigned long sampleInterval = 3000; // 每 3 秒發送一次即時數據
  
  for(;;) {
    // 如果主核心送來了「上傳草稿」的需求，優先處理
    if (pendingDraftUpload) {
      sendToCloud(pendingDraftJson);
      blinkSuccessLED();
      pendingDraftUpload = false; // 釋放鎖定
    } 
    // 否則定時採集即時數據
    else if (millis() - lastSampleTime >= sampleInterval) {
      collectAndSendTelemetry();
      lastSampleTime = millis();
    }
    
    vTaskDelay(10 / portTICK_PERIOD_MS); // 避免 Watchdog 咬人
  }
}

// ==========================================
// 核心功能函式
// ==========================================

void updateLCD() {
  if (!isScreenAwake) return; 
  char row0[17]; char row1[17];
  
  sprintf(row0, "T:%.1fC H:%.1f%%", currentTemp, currentHumid);
  String row0Str = String(row0);
  while(row0Str.length() < 16) row0Str += " "; 
  
  String netStatus = (WiFi.status() == WL_CONNECTED) ? "WIFI" : "USB!";
  String recStatus = isRecording ? "*REC*" : "IDLE ";
  sprintf(row1, "N:%-3.0f %s %s", currentNoiseDb, netStatus.c_str(), recStatus.c_str());

  lcd.setCursor(0, 0); lcd.print(row0Str);
  lcd.setCursor(0, 1); lcd.print(row1);
}

void processSerialCommands() {
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.startsWith("SET_WIFI:")) {
      int colonIdx = cmd.indexOf(':'); int commaIdx = cmd.indexOf(',');
      if (commaIdx > colonIdx) {
        preferences.putString("ssid", cmd.substring(colonIdx + 1, commaIdx));
        preferences.putString("pass", cmd.substring(commaIdx + 1));
        Serial.println("✅ [系統] 成功接收 Wi-Fi 設定！2 秒後重啟...");
        if(!isScreenAwake) { lcd.backlight(); isScreenAwake = true; }
        lcd.clear(); lcd.setCursor(0,0); lcd.print("Wi-Fi Saved!");
        lcd.setCursor(0,1); lcd.print("Restarting...");
        delay(2000); ESP.restart();
      }
    }
  }
}

void sendToCloud(String payload) {
  if(WiFi.status() == WL_CONNECTED) {
    WiFiClientSecure client; client.setInsecure(); 
    HTTPClient http; http.begin(client, serverUrl);
    http.addHeader("Content-Type", "application/json");
    int httpResponseCode = http.POST(payload);
    if (httpResponseCode > 0) Serial.printf("☁️ 同步成功 (HTTP %d)\n", httpResponseCode);
    else Serial.printf("❌ 同步失敗 (Error: %s)\n", http.errorToString(httpResponseCode).c_str());
    http.end();
  }
}

void startCapture() {
  isRecording = true; digitalWrite(ledPin, HIGH); 
  sampleCount = 0; totalNoise = 0; totalTemp = 0; totalHumid = 0;
  startTime = millis();
  Serial.println("\n[事件] 👉 開始物理錄製！");
}

void collectAndSendTelemetry() {
  float temp = dht.readTemperature(); float humid = dht.readHumidity();
  if (isnan(temp) || isnan(humid)) { temp = 25.0; humid = 60.0; }
  
  unsigned long sampleWindow = 50; unsigned int signalMax = 0; unsigned int signalMin = 4095;   
  unsigned long startWindow = millis();
  while (millis() - startWindow < sampleWindow) {
    unsigned int sample = analogRead(MIC_PIN);
    if (sample < 4095) { 
      if (sample > signalMax) signalMax = sample;
      if (sample < signalMin) signalMin = sample;
    }
  }
  unsigned int peakToPeak = signalMax - signalMin;
  float noiseDb = map(peakToPeak, 0, 4000, 400, 1000) / 10.0;
  if (noiseDb < 40.0) noiseDb = 40.0 + random(0, 15) / 10.0;

  currentTemp = temp; currentHumid = humid; currentNoiseDb = noiseDb;

  if (isRecording) { totalTemp += temp; totalHumid += humid; totalNoise += noiseDb; sampleCount++; }

  String statusStr = isRecording ? "物理錄製中..." : "待機中";
  String telemetryJson = "{\"device_id\": \"" + DEVICE_ID + "\", \"status\": \"" + statusStr + "\", \"avg_temp_c\": " + String(currentTemp, 1) + ", \"avg_humidity\": " + String(currentHumid, 1) + ", \"avg_noise_db\": " + String(currentNoiseDb, 1) + "}";
  Serial.println("📡 " + telemetryJson); sendToCloud(telemetryJson); 
}

void blinkSuccessLED() {
  for (int i = 0; i < 3; i++) { digitalWrite(ledPin, HIGH); delay(80); digitalWrite(ledPin, LOW); delay(80); }
}

void stopCapture() {
  isRecording = false; int durationSec = (millis() - startTime) / 1000;

  if (durationSec >= 3 && sampleCount > 0) {
    float avgTemp = totalTemp / sampleCount; float avgHumid = totalHumid / sampleCount; float avgNoise = totalNoise / sampleCount;
    pendingDraftJson = "{\"device_id\": \"" + DEVICE_ID + "\", \"action\": \"save_draft\", \"duration_sec\": " + String(durationSec) + ", \"avg_temp_c\": " + String(avgTemp, 1) + ", \"avg_humidity\": " + String(avgHumid, 1) + ", \"avg_noise_db\": " + String(avgNoise, 1) + "}";
    pendingDraftUpload = true; 

    Serial.println("\n[事件] 👈 結束錄製！交由背景核心上傳草稿...");
    lcd.clear(); lcd.setCursor(0, 0); lcd.print("Saving Draft...");
    lcd.setCursor(0, 1); lcd.print("Uploading...");
  } else {
    Serial.println("\n[錯誤] 錄製時間太短。");
    lcd.clear(); lcd.setCursor(0,0); lcd.print("Too short!");
    delay(1000); updateLCD();
  }
  digitalWrite(ledPin, LOW); 
}