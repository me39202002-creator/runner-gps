# 跑友即時追蹤系統 (Runner GPS Live Tracker)

一個專為跑步愛好者與路跑社團設計的高效、即時、安全的 Web 應用程式。無須安裝肥大 App，打開瀏覽器即可開啟或加入房間，即時在地圖上查看隊友的位置、動態軌跡、配速與移動狀態。

---

## 🌟 核心特色

1. **極速低延遲同步**：
   - 採用 **Firebase Realtime Database** 的 WebSocket 持久雙工連線，延遲僅數十毫秒。
   - **本機樂觀更新 (Optimistic UI)**：自身座標獲取後零延遲即時呈現於地圖，再非同步推送至資料庫。
2. **現代地圖視覺化**：
   - 整合 **Google Maps JavaScript API**。
   - 自訂跑友向量標記 (Marker)，搭配專屬顏色、頭像 Emoji 與在線呼吸光暈。
   - 動態行進路徑折線 (**Polyline**) 與 GPS 精度誤差圈。
   - 支援「聚焦自己」、「全體隊友視野」與「衛星/街道切換」。
3. **高精度定位與省電節流**：
   - 使用 **HTML5 Geolocation API (`watchPosition`)**。
   - 內建智慧節流機制（位移小於 3 公尺且間隔小於 2 秒不上報），大幅降低戶外手機耗電與行動流量。
   - 精度過濾門檻（自動略過大於 50m 飄移座標）。
4. **離線自動監控 (Presence System)**：
   - 結合 Firebase `.info/connected` 與 `onDisconnect()` 機制。
   - 當隊友手機斷訊或關閉分頁時，地圖標記自動標註「離線」，杜絕幽靈隊友停留。
5. **嚴格 DOM XSS 防禦機制**：
   - 嚴格正則驗證所有 URL 參數與房間 ID (`/^[a-zA-Z0-9_-]{4,32}$/`)，阻絕偽協議注入。
   - 介面與 Google Maps 彈出視窗 (`InfoWindow`) 杜絕字串拼接 `innerHTML`，全數採用原生 `createElement` 與 `textContent` 安全渲染。
6. **桌機開發測試模式 (Mock Runner)**：
   - 提供「🎮 模擬跑步」按鈕，方便在沒有硬體 GPS 的桌上型電腦或筆電進行跑步軌跡模擬除錯。

---

## 🏗️ 專案架構 (職責分離)

```
RUNNER-GPS/
├── index.html                   # 主畫面結構 (Tailwind CSS 佈局、毛玻璃導航列、底部面板)
├── css/
│   └── style.css                # 客製化動畫 (光暈、捲軸、全版地圖)
├── js/
│   ├── config.example.js        # 金鑰範本檔案
│   ├── config.js                # 實際環境配置 (支援 localStorage 覆蓋)
│   ├── security.js              # [安全層] DOM XSS 防禦、白名單驗證、字串跳脫
│   ├── services/
│   │   ├── firebase-service.js  # [資料層] Firebase 連線、即時讀寫、Presence 監控
│   │   └── geolocation-service.js # [定位層] watchPosition、節流過濾、配速計算、軌跡模擬
│   ├── components/
│   │   ├── map-renderer.js      # [地圖層] Google Maps 標記、Polyline、視角邊界
│   │   └── ui-controller.js     # [UI 控制層] 安全 DOM 渲染、跑友清單、Toast 提示
│   └── app.js                   # [核心層] 串接資料與畫面、生命週期控制
└── README.md
```

---

## 🚀 快速開始

### 1. 取得 API 金鑰
本專案依賴以下兩項免費服務（均有慷慨的免費額度）：

#### A. Google Maps JavaScript API
1. 前往 [Google Cloud Console](https://console.cloud.google.com/)。
2. 建立新專案或選取現有專案。
3. 搜尋並啟用 **Maps JavaScript API**。
4. 前往「憑證 (Credentials)」，建立一組 API 金鑰。

#### B. Firebase Realtime Database
1. 前往 [Firebase Console](https://console.firebase.google.com/)。
2. 建立新專案。
3. 在左側導航選單中進入 **Build > Realtime Database**，點擊「建立資料庫」。
4. 選擇地區（建議選擇離台灣較近的地區，如新加坡 `asia-southeast1` 或美國）。
5. 設定安全性規則（測試期間可設為公開讀寫，或參照下方的建議規則）：
   ```json
   {
     "rules": {
       "rooms": {
         "$roomId": {
           ".read": true,
           ".write": true
         }
       }
     }
   }
   ```
6. 前往「專案設定 (Project settings)」>「一般」，在下方「您的應用程式」中點擊「Web (</>)」註冊應用程式，即可獲得 Firebase 配置物件：
   - `apiKey`
   - `databaseURL`
   - `projectId`
   - `appId`

### 2. 設定金鑰 (二選一)

#### 方法一：直接在網頁介面填寫（推薦最方便）
直接開啟本專案網頁，點擊右上角的 **⚙️ 設定按鈕**，將金鑰直接填入彈窗中並儲存，系統會自動儲存於瀏覽器本機快取中。

#### 方法二：編輯 `js/config.js` 檔案
打開 `js/config.js`，將金鑰直接填入：
```javascript
const DEFAULT_CONFIG = {
  googleMapsApiKey: 'AIzaSyYourGoogleMapsApiKey...',
  firebase: {
    apiKey: 'AIzaSyYourFirebaseApiKey...',
    databaseURL: 'https://your-project-default-rtdb.firebaseio.com',
    projectId: 'your-project-id',
    appId: '1:123456789:web:abcdef...'
  },
  // ...
};
```

---

### 3. 本地啟動伺服器

因為程式使用原生 ES6 模組 (`import/export`)，必須透過本機 Web Server 運行（不能直接雙擊 `file://` 打開）。

您可以使用任何現有的靜態檔案伺服器，例如：

**使用 Python (內建)：**
```bash
python -m http.server 8080
```
或
```bash
python3 -m http.server 8080
```

**使用 Node.js (npx serve / live-server)：**
```bash
npx serve -l 8080
```

開啟瀏覽器前往：`http://localhost:8080` 即可開始使用！

---

## 🏃 使用流程

1. **進入隊伍**：
   - 開啟頁面後，輸入您的跑友暱稱、自訂頭像與顏色。
   - 輸入或保留系統產生的房間 ID（例如 `run-fast-88`），點擊「確認進入」。
2. **分享給跑友**：
   - 點擊頂部的 **分享按鈕**，系統會產生 `?room=run-fast-88` 的專屬連結。
   - 跑友點擊該連結進入時，會自動帶入相同房間 ID，立即連線。
3. **開始追蹤**：
   - 點擊底部「**開始追蹤**」，允許瀏覽器取得 GPS 權限。
   - 若在室內或電腦端測試，可點擊「**🎮 模擬跑步**」體驗即時軌跡與地圖更新。
4. **查看隊友動態**：
   - 點擊右上角「**隊友**」抽屜，可展開側欄查看所有在線跑友的即時配速與速度。
   - 點擊隊友旁的定位圖示，地圖視野將自動平滑移至該隊友目前所在位置。
