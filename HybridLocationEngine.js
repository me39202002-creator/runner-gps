/**
 * =========================================================================
 * HybridLocationEngine.js - 混合室內外定位引擎
 * =========================================================================
 * 
 * 優先順序狀態機 (Priority State Machine)：
 *  P1 【絕對校正錨點】Web Bluetooth Beacon (RSSI > -70 dBm 強制 Snap 錨定)
 *  P2 【戶外主力定位】A-GPS 高精準 (Accuracy <= 15m, 100% 採用)
 *  P3 【室內死角推算】PDR 行人航位推算 (GPS > 15m 或 > 5秒無訊號時接管)
 *  P4 【室內邊界防呆】Wi-Fi / 基地台三角 (偏離 > Accuracy * 1.2 時 0.85:0.15 平滑拉回)
 * 
 * 支援環境：PWA (Web APIs)、iOS 13+ Safari、Android Chrome、Capacitor WebView
 */

export class HybridLocationEngine {
  /**
   * @param {Object} options 配置參數
   * @param {Function} options.onLocationUpdate 定位更新回呼 ({ lat, lng, accuracy, source, heading, steps, timestamp })
   * @param {Function} options.onStateChange 狀態機切換回呼 ({ state, reason })
   * @param {Function} options.onLog 內部除錯日誌回呼 (msg, level)
   * @param {number} options.stepLength 預設步長 (公尺, 預設 0.7m)
   * @param {number} options.stepCooldown 步伐偵測冷卻時間 (毫秒, 預設 350ms)
   * @param {number} options.gpsGpsTimeoutThreshold GPS 判定斷訊超時時間 (毫秒, 預設 5000ms)
   * @param {number} options.highAccuracyThreshold 判定為高品質戶外訊號的半徑 (公尺, 預設 15m)
   * @param {number} options.bleRssiThreshold BLE 錨點判定門檻 (dBm, 預設 -70)
   */
  constructor(options = {}) {
    // 外部回呼
    this.onLocationUpdate = options.onLocationUpdate || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onLog = options.onLog || console.log;

    // 參數配置
    this.config = {
      stepLength: options.stepLength || 0.7,
      stepCooldown: options.stepCooldown || 350,
      gpsTimeoutThreshold: options.gpsTimeoutThreshold || 5000,
      highAccuracyThreshold: options.highAccuracyThreshold || 15,
      bleRssiThreshold: options.bleRssiThreshold || -70
    };

    // 核心狀態
    this.state = 'INITIALIZING'; // 'INITIALIZING' | 'OUTDOOR_GPS' | 'INDOOR_PDR' | 'STOPPED'
    
    // 座標與錨點
    this.currentLocation = null; // { lat, lng, accuracy, source, heading, timestamp }
    this.anchorLocation = null;  // 最後可信錨點 { lat, lng, source, timestamp }
    
    // P1: Web Bluetooth 狀態
    this.beaconMap = new Map();  // Map<string, { lat, lng, name }>
    this.bluetoothScan = null;
    this.isBluetoothSupported = typeof navigator !== 'undefined' && 'bluetooth' in navigator;

    // P2 & P4: Geolocation 狀態
    this.geoWatchId = null;
    this.isHighAccuracy = true;
    this.lastGpsTimestamp = 0;
    this.lastRawGpsCoords = null;
    this.gpsWatchdogTimer = null;

    // P3: PDR 狀態
    this.heading = 0;            // 絕對羅盤方位角 (0~360度, 0=正北, 順時針)
    this.stepCount = 0;          // 累計步數
    this.lastStepTime = 0;       // 上次步伐時間戳 (防連點冷卻)
    this.motionHistory = [];     // 加速度波峰偵測滑動窗口
    this.accelThreshold = 10.8;  // 波峰偵測重力合力門檻 (m/s^2)
    this.accelValleyThreshold = 9.2; // 波谷門檻
    this.waitingForValley = false;

    // 保活與系統機制
    this.wakeLock = null;
    this.isPageVisible = true;
    this.isRunning = false;

    // 綁定事件處理以利銷毀
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
    this.handleDeviceMotion = this.handleDeviceMotion.bind(this);
    this.handleDeviceOrientation = this.handleDeviceOrientation.bind(this);
  }

  // =========================================================================
  // 二、 系統權限與保活介面 (Permissions & Keep-Alive)
  // =========================================================================

  /**
   * 統一權限授權函式 (必須由使用者點擊按鈕等 User Gesture 觸發)
   * 涵蓋：iOS 13+ 體感權限、螢幕常亮 Wake Lock、Web Bluetooth 檢查
   * @returns {Promise<{ motion: boolean, orientation: boolean, wakeLock: boolean, bluetooth: boolean }>}
   */
  async initPermissions() {
    this.log('[權限] 開始請求感測器與保活權限...', 'info');
    const result = {
      motion: false,
      orientation: false,
      wakeLock: false,
      bluetooth: this.isBluetoothSupported
    };

    // 1. iOS 13+ DeviceMotion 權限申請
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const motionPermission = await DeviceMotionEvent.requestPermission();
        result.motion = (motionPermission === 'granted');
        this.log(`[權限] iOS DeviceMotion 授權結果: ${motionPermission}`, result.motion ? 'info' : 'warn');
      } catch (err) {
        this.log(`[權限] iOS DeviceMotion 授權失敗: ${err.message}`, 'error');
      }
    } else {
      result.motion = true; // Android / 一般瀏覽器自動允許或由安全上下文控制
    }

    // 2. iOS 13+ DeviceOrientation 權限申請
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const orientationPermission = await DeviceOrientationEvent.requestPermission();
        result.orientation = (orientationPermission === 'granted');
        this.log(`[權限] iOS DeviceOrientation 授權結果: ${orientationPermission}`, result.orientation ? 'info' : 'warn');
      } catch (err) {
        this.log(`[權限] iOS DeviceOrientation 授權失敗: ${err.message}`, 'error');
      }
    } else {
      result.orientation = true;
    }

    // 3. 申請 Wake Lock 保持螢幕長亮防休眠
    result.wakeLock = await this.requestWakeLock();

    // 4. 註冊可見性變化監聽 (切回前景自動復原)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    return result;
  }

  /**
   * 申請 Screen Wake Lock
   */
  async requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => {
          this.log('[WakeLock] 螢幕常亮鎖已釋放', 'info');
          this.wakeLock = null;
        });
        this.log('[WakeLock] 螢幕常亮已成功鎖定 (防止鎖屏斷訊)', 'info');
        return true;
      } catch (err) {
        this.log(`[WakeLock] 螢幕常亮申請失敗: ${err.message}`, 'warn');
      }
    }
    return false;
  }

  /**
   * 頁面前景/背景切換監聽
   */
  async handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      this.isPageVisible = true;
      this.log('[系統] 應用切回前景，正在重新喚起保活鎖與檢查定位...', 'info');
      await this.requestWakeLock();
      
      // 若 GPS 已超時，立即發動檢查
      this.evaluateGpsWatchdog();
    } else {
      this.isPageVisible = false;
      this.log('[系統] 應用切入背景', 'info');
    }
  }

  // =========================================================================
  // 啟動與停止 (Engine Lifecycle)
  // =========================================================================

  /**
   * 啟動混合定位引擎
   * @param {Object} [beaconMap] 可選的藍牙 Beacon 座標字典
   */
  start(beaconMap = null) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.log('[引擎] 啟動混合定位引擎...', 'info');

    if (beaconMap) {
      this.setBeaconMap(beaconMap);
    }

    // 1. 啟動 P2 A-GPS 監聽
    this.startGeolocationWatch();

    // 2. 啟動 P3 慣性感測器監聽 (Motion & Orientation)
    this.startMotionSensors();

    // 3. 啟動看門狗 (每秒檢查 GPS 是否逾時 > 5秒)
    this.startGpsWatchdog();

    this.updateState('INITIALIZING', '正在獲取首次定位...');
  }

  /**
   * 停止混合定位引擎並釋放所有感測器與鎖
   */
  stop() {
    this.isRunning = false;
    this.log('[引擎] 停止定位引擎', 'info');

    // 停止 Geolocation
    if (this.geoWatchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.geoWatchId);
      this.geoWatchId = null;
    }

    // 停止看門狗
    if (this.gpsWatchdogTimer) {
      clearInterval(this.gpsWatchdogTimer);
      this.gpsWatchdogTimer = null;
    }

    // 停止感測器
    window.removeEventListener('devicemotion', this.handleDeviceMotion);
    window.removeEventListener('deviceorientation', this.handleDeviceOrientation);
    if ('ondeviceorientationabsolute' in window) {
      window.removeEventListener('deviceorientationabsolute', this.handleDeviceOrientation);
    }

    // 釋放 Wake Lock
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }

    // 停止藍牙掃描 (若有)
    if (this.bluetoothScan && typeof this.bluetoothScan.stop === 'function') {
      try { this.bluetoothScan.stop(); } catch (e) {}
      this.bluetoothScan = null;
    }

    this.updateState('STOPPED', '定位已手動關閉');
  }

  // =========================================================================
  // 一、 優先級 P1 - 【絕對校正錨點】Web Bluetooth API
  // =========================================================================

  /**
   * 設定已知的 Bluetooth Beacon 字典
   * @param {Object} beaconDict 格式: { 'BEACON_UUID_OR_NAME': { lat: 25.0339, lng: 121.5644, name: '1F大門' } }
   */
  setBeaconMap(beaconDict) {
    this.beaconMap.clear();
    if (typeof beaconDict === 'object' && beaconDict !== null) {
      for (const [key, val] of Object.entries(beaconDict)) {
        this.beaconMap.set(key.toLowerCase(), val);
      }
    }
    this.log(`[P1-BLE] 已載入 ${this.beaconMap.size} 個精確 Beacon 錨點資料庫`, 'info');
  }

  /**
   * 啟動 Web Bluetooth 掃描 (限 Android Chrome / 支援環境)
   * 具備環境防呆：若不支援則靜默略過
   * @param {Object} [beaconMap] 字典
   */
  async scanBluetoothBeacons(beaconMap = null) {
    if (beaconMap) this.setBeaconMap(beaconMap);

    if (!this.isBluetoothSupported) {
      this.log('[P1-BLE] 當前環境/瀏覽器不支援 Web Bluetooth (如 iOS Safari)，安全略過 P1 層', 'info');
      return false;
    }

    try {
      // 優先使用 Web Bluetooth Scanning API (navigator.bluetooth.requestLEScan)
      if (typeof navigator.bluetooth.requestLEScan === 'function') {
        this.log('[P1-BLE] 正在啟動 requestLEScan 背景廣播掃描...', 'info');
        this.bluetoothScan = await navigator.bluetooth.requestLEScan({
          acceptAllAdvertisements: true,
          keepRepeatedDevices: true
        });

        navigator.bluetooth.addEventListener('advertisementreceived', (event) => {
          this.handleBluetoothAdvertisement(event);
        });

        this.log('[P1-BLE] BLE 廣告掃描監聽已順利啟動', 'info');
        return true;
      } else {
        this.log('[P1-BLE] 瀏覽器未啟用 requestLEScan，支援以手動配對方式掃描 (requestDevice)', 'warn');
        return false;
      }
    } catch (err) {
      this.log(`[P1-BLE] 藍牙掃描啟動未成功: ${err.message} (不影響 GPS 與 PDR 運作)`, 'warn');
      return false;
    }
  }

  /**
   * 處理接收到的 BLE 廣播封包
   * @param {BluetoothAdvertisingEvent} event 
   */
  handleBluetoothAdvertisement(event) {
    const deviceId = (event.device.id || '').toLowerCase();
    const deviceName = (event.device.name || '').toLowerCase();
    const rssi = event.rssi;

    // 檢查是否命中字典中的 Beacon
    let matchedBeacon = this.beaconMap.get(deviceId) || this.beaconMap.get(deviceName);
    if (!matchedBeacon) {
      // 也比對 serviceData UUID
      if (event.serviceData) {
        for (const uuid of event.serviceData.keys()) {
          matchedBeacon = this.beaconMap.get(uuid.toLowerCase());
          if (matchedBeacon) break;
        }
      }
    }

    if (matchedBeacon) {
      this.log(`[P1-BLE] 發現已知 Beacon [${matchedBeacon.name}] RSSI: ${rssi} dBm`, 'debug');
      
      // 當 RSSI > -70 dBm (非常靠近) 時強制無條件 Snap
      if (rssi > this.config.bleRssiThreshold) {
        this.snapToBleAnchor(matchedBeacon, rssi);
      }
    }
  }

  /**
   * 【P1 核心】強制 Snap 座標至 Beacon 絕對錨點
   */
  snapToBleAnchor(beacon, rssi) {
    this.log(`[P1-BLE 錨定] RSSI (${rssi} dBm) > ${this.config.bleRssiThreshold} dBm！強制瞬移 Snap 至【${beacon.name}】`, 'info');

    const timestamp = Date.now();
    const snapCoords = {
      lat: beacon.lat,
      lng: beacon.lng,
      accuracy: 3.0, // 藍牙近場 Snap 視為 3 公尺內精準度
      source: 'BLE',
      heading: this.heading,
      steps: this.stepCount,
      timestamp: timestamp,
      beaconName: beacon.name,
      rssi: rssi
    };

    // 1. 強制設定為最新座標與最新 anchorLocation
    this.currentLocation = snapCoords;
    this.anchorLocation = {
      lat: beacon.lat,
      lng: beacon.lng,
      source: 'BLE',
      timestamp: timestamp
    };

    // 2. 徹底重置 PDR 的累積誤差
    this.motionHistory = [];
    this.waitingForValley = false;

    // 3. 廣播定位更新
    this.onLocationUpdate(this.currentLocation);
  }

  // =========================================================================
  // 一、 優先級 P2 - 【戶外主力】系統 A-GPS 高精準定位
  // =========================================================================

  /**
   * 啟動 GPS 監聽
   */
  startGeolocationWatch() {
    if (!navigator.geolocation) {
      this.log('[P2-GPS] 瀏覽器不支援 Geolocation API', 'error');
      return;
    }

    if (this.geoWatchId !== null) {
      navigator.geolocation.clearWatch(this.geoWatchId);
    }

    const geoOptions = {
      enableHighAccuracy: this.isHighAccuracy,
      timeout: 10000,
      maximumAge: 0
    };

    this.log(`[P2-GPS] 啟動監聽 (HighAccuracy: ${this.isHighAccuracy})`, 'info');

    this.geoWatchId = navigator.geolocation.watchPosition(
      (pos) => this.handleGeolocationSuccess(pos),
      (err) => this.handleGeolocationError(err),
      geoOptions
    );
  }

  /**
   * GPS 定位成功回傳處理 (P2 與 P4 分流判定)
   */
  handleGeolocationSuccess(position) {
    const coords = position.coords;
    const accuracy = coords.accuracy;
    const now = Date.now();

    this.lastGpsTimestamp = now;
    this.lastRawGpsCoords = {
      lat: coords.latitude,
      lng: coords.longitude,
      accuracy: accuracy,
      heading: coords.heading,
      speed: coords.speed,
      timestamp: now
    };

    // 【P2 條件】當 accuracy <= 15 公尺：視為高品質戶外訊號
    if (accuracy <= this.config.highAccuracyThreshold) {
      this.handleHighAccuracyGps(coords, accuracy, now);
    } else {
      // 【P4 條件】accuracy > 15 公尺 (可能是室內 Wi-Fi / 基地台粗略三角定位)
      this.handleCoarseGps(coords, accuracy, now);
    }
  }

  /**
   * 處理 P2 高品質戶外 GPS
   */
  handleHighAccuracyGps(coords, accuracy, timestamp) {
    this.updateState('OUTDOOR_GPS', `戶外高精度 GPS (誤差 ${accuracy.toFixed(1)}m)`);

    // 100% 採用此座標更新畫面
    this.currentLocation = {
      lat: coords.latitude,
      lng: coords.longitude,
      accuracy: accuracy,
      source: 'GPS',
      heading: (typeof coords.heading === 'number' && !isNaN(coords.heading)) ? coords.heading : this.heading,
      steps: this.stepCount,
      timestamp: timestamp
    };

    // 持續更新為可信 anchorLocation
    this.anchorLocation = {
      lat: coords.latitude,
      lng: coords.longitude,
      source: 'GPS',
      timestamp: timestamp
    };

    // 暫停採用 PDR 輸出 (在戶外 GPS 良好時直接以 GPS 為準)
    this.onLocationUpdate(this.currentLocation);
  }

  /**
   * 處理 P4 室內粗略 GPS / 基地台邊界防呆
   */
  handleCoarseGps(coords, accuracy, timestamp) {
    this.log(`[P4-CELL] 收到粗略定位 (誤差 ${accuracy.toFixed(1)}m > ${this.config.highAccuracyThreshold}m)`, 'debug');

    // 若尚未獲得任何初始座標，只好暫時先作為初始起點
    if (!this.currentLocation) {
      this.currentLocation = {
        lat: coords.latitude,
        lng: coords.longitude,
        accuracy: accuracy,
        source: 'GPS_COARSE',
        heading: this.heading,
        steps: this.stepCount,
        timestamp: timestamp
      };
      this.anchorLocation = {
        lat: coords.latitude,
        lng: coords.longitude,
        source: 'GPS_COARSE',
        timestamp: timestamp
      };
      this.onLocationUpdate(this.currentLocation);
      return;
    }

    // 若當前在「室內 PDR 接管模式」，嚴禁直接覆蓋當前座標（避免畫面游標瞬移拉扯）
    if (this.state === 'INDOOR_PDR') {
      const pdrLat = this.currentLocation.lat;
      const pdrLng = this.currentLocation.lng;
      const cellLat = coords.latitude;
      const cellLng = coords.longitude;

      // 計算目前 PDR 推算座標與基地台座標的距離 (Haversine 公式)
      const distance = HybridLocationEngine.calculateDistance(pdrLat, pdrLng, cellLat, cellLng);
      const boundaryThreshold = accuracy * 1.2;

      this.log(`[P4邊界檢查] PDR推算點與基地台距離: ${distance.toFixed(1)}m, 邊界閾值: ${boundaryThreshold.toFixed(1)}m`, 'debug');

      // 若偏離距離大於 coords.accuracy * 1.2，則平滑拉回校正 (0.85 * PDR + 0.15 * 基地台)
      if (distance > boundaryThreshold) {
        const correctedLat = 0.85 * pdrLat + 0.15 * cellLat;
        const correctedLng = 0.85 * pdrLng + 0.15 * cellLng;

        this.log(`[P4平滑校正] PDR 累積漂移超標 (${distance.toFixed(1)}m > ${boundaryThreshold.toFixed(1)}m)，啟動 0.85:0.15 平滑拉回`, 'warn');

        this.currentLocation = {
          lat: correctedLat,
          lng: correctedLng,
          accuracy: accuracy * 0.8, // 校正後精準度估算
          source: 'CELL_CORRECTED',
          heading: this.heading,
          steps: this.stepCount,
          timestamp: timestamp
        };

        // 更新錨點以防止後續推算發散
        this.anchorLocation = {
          lat: correctedLat,
          lng: correctedLng,
          source: 'CELL_CORRECTED',
          timestamp: timestamp
        };

        this.onLocationUpdate(this.currentLocation);
      }
    }
  }

  /**
   * Geolocation 錯誤處理與自動降級
   */
  handleGeolocationError(error) {
    this.log(`[P2-GPS 錯誤] code: ${error.code}, 訊息: ${error.message}`, 'warn');

    // 若發生 Timeout 且當前為高精準模式，自動降級為 false 重啟監聽
    if (error.code === error.TIMEOUT && this.isHighAccuracy) {
      this.log('[P2-GPS 降級] 高精度模式逾時，自動降級為 enableHighAccuracy: false 重新監聽', 'warn');
      this.isHighAccuracy = false;
      this.startGeolocationWatch();
    }
  }

  /**
   * 看門狗：監控 GPS 是否超時未更新 (> 5秒)
   */
  startGpsWatchdog() {
    if (this.gpsWatchdogTimer) clearInterval(this.gpsWatchdogTimer);
    this.gpsWatchdogTimer = setInterval(() => {
      this.evaluateGpsWatchdog();
    }, 1000);
  }

  evaluateGpsWatchdog() {
    if (!this.isRunning) return;
    const now = Date.now();
    const timeSinceLastGps = now - this.lastGpsTimestamp;

    // 當 GPS 超過 5 秒未更新 或 最後一次 GPS accuracy > 15m
    const isTimeout = this.lastGpsTimestamp === 0 || timeSinceLastGps > this.config.gpsTimeoutThreshold;
    const isCoarse = this.lastRawGpsCoords && this.lastRawGpsCoords.accuracy > this.config.highAccuracyThreshold;

    if (isTimeout || isCoarse) {
      if (this.state !== 'INDOOR_PDR') {
        const reason = isTimeout ? `GPS 超過 ${(timeSinceLastGps/1000).toFixed(1)} 秒無訊號` : `GPS 精度低於標準 (${this.lastRawGpsCoords.accuracy.toFixed(1)}m)`;
        this.updateState('INDOOR_PDR', `${reason}，自動切換為【室內 PDR 慣性接管模式】`);
      }
    }
  }

  // =========================================================================
  // 一、 優先級 P3 - 【室內移動推算】慣性導航 / PDR
  // =========================================================================

  /**
   * 啟動加速度計與陀螺儀監聽
   */
  startMotionSensors() {
    window.removeEventListener('devicemotion', this.handleDeviceMotion);
    window.addEventListener('devicemotion', this.handleDeviceMotion, { passive: true });

    // 優先監聽 deviceorientationabsolute (Android Chrome 絕對羅盤)，降級使用 deviceorientation
    if ('ondeviceorientationabsolute' in window) {
      window.removeEventListener('deviceorientationabsolute', this.handleDeviceOrientation);
      window.addEventListener('deviceorientationabsolute', this.handleDeviceOrientation, { passive: true });
    } else {
      window.removeEventListener('deviceorientation', this.handleDeviceOrientation);
      window.addEventListener('deviceorientation', this.handleDeviceOrientation, { passive: true });
    }

    this.log('[P3-PDR] 加速度計與方位角感測器監聽已就緒', 'info');
  }

  /**
   * 處理絕對方位角 (Compass Heading)
   * 相容 iOS 的 webkitCompassHeading 與 Android 的 360 - alpha
   */
  handleDeviceOrientation(event) {
    let compass = 0;

    if (typeof event.webkitCompassHeading === 'number' && !isNaN(event.webkitCompassHeading)) {
      // iOS Safari 原生絕對羅盤 (0~360, 0=正北, 順時針)
      compass = event.webkitCompassHeading;
    } else if (event.alpha !== null && !isNaN(event.alpha)) {
      // Android Chrome (標準 alpha 為逆時針，需轉為順時針正北航向)
      if (event.absolute === true || 'ondeviceorientationabsolute' in window) {
        compass = (360 - event.alpha) % 360;
      } else {
        compass = (360 - event.alpha) % 360;
      }
    }

    // 平滑處理方位角 (加權平均避免抖動)
    this.heading = Math.round(compass * 10) / 10;
  }

  /**
   * 處理加速度數據並實作波峰偵測 (Peak Detection)
   */
  handleDeviceMotion(event) {
    // 優先使用 accelerationIncludingGravity (包含重力分量，穩定度高)
    const acc = event.accelerationIncludingGravity || event.acceleration;
    if (!acc || acc.x === null) return;

    const x = acc.x || 0;
    const y = acc.y || 0;
    const z = acc.z || 0;

    // 計算 3 軸合加速度大小
    const magnitude = Math.sqrt(x * x + y * y + z * z);
    const now = Date.now();

    // 狀態機波峰檢測：先偵測到波峰 (> 10.8)，再落回波谷 (< 9.2)，且距離上次步伐 > 350ms
    if (!this.waitingForValley) {
      if (magnitude > this.accelThreshold && (now - this.lastStepTime) > this.config.stepCooldown) {
        this.waitingForValley = true; // 達到波峰，等待回到波谷確認完成一步
      }
    } else {
      if (magnitude < this.accelValleyThreshold) {
        // 完成一個完整的步伐波峰波谷週期
        this.waitingForValley = false;
        this.lastStepTime = now;
        this.onStepDetected(now);
      }
    }
  }

  /**
   * 偵測到有效步伐時的航位推算
   */
  onStepDetected(timestamp) {
    this.stepCount++;

    // 僅在「室內 PDR 接管模式」下將推算座標更新至畫面
    if (this.state === 'INDOOR_PDR') {
      // 若尚未有任何可信起點錨點，無法推算
      if (!this.anchorLocation && !this.currentLocation) {
        this.log('[P3-PDR] 偵測到步伐，但尚未獲得任何初始錨點 (P1/P2)，暫無法推算座標', 'warn');
        return;
      }

      // 以當前最新的座標（或起點 anchorLocation）為出發點
      const startPoint = this.currentLocation || this.anchorLocation;
      
      // 根據步長與方位角，利用地球幾何公式推算新座標
      const nextPoint = HybridLocationEngine.computeDeadReckoning(
        startPoint.lat,
        startPoint.lng,
        this.config.stepLength,
        this.heading
      );

      this.currentLocation = {
        lat: nextPoint.lat,
        lng: nextPoint.lng,
        accuracy: Math.min((startPoint.accuracy || 15) + (this.stepCount * 0.05), 30), // PDR 隨步數輕微增加估計誤差
        source: 'PDR',
        heading: this.heading,
        steps: this.stepCount,
        timestamp: timestamp
      };

      this.log(`[P3-PDR 推算] 第 ${this.stepCount} 步！方位角: ${this.heading}° 步長: ${this.config.stepLength}m -> (${nextPoint.lat.toFixed(6)}, ${nextPoint.lng.toFixed(6)})`, 'debug');

      // 觸發畫面更新
      this.onLocationUpdate(this.currentLocation);
    } else {
      // 在戶外 GPS 狀態下，僅記錄步數，不改動 GPS 畫面座標
      this.log(`[P3 步數統計] 戶外記錄步伐: 第 ${this.stepCount} 步 (當前以 GPS 主導)`, 'debug');
    }
  }

  // =========================================================================
  // 數學與幾何推算工具 (Math & Geodesy Utilities)
  // =========================================================================

  /**
   * 行人航位推算：根據目前座標、移動距離、絕對航向，推算目標經緯度
   * 使用球面大圓距離三角公式 (Great Circle Navigation)
   * @param {number} lat 當前緯度 (度)
   * @param {number} lng 當前經度 (度)
   * @param {number} distance 移動距離 (公尺)
   * @param {number} heading 絕對航向 (度, 0=正北, 順時針)
   * @returns {{ lat: number, lng: number }}
   */
  static computeDeadReckoning(lat, lng, distance, heading) {
    const R = 6378137; // 地球赤道半徑 (公尺)
    const delta = distance / R; // 角距離 (弧度)
    const theta = (heading * Math.PI) / 180; // 方位角 (弧度)

    const phi1 = (lat * Math.PI) / 180;
    const lambda1 = (lng * Math.PI) / 180;

    const sinPhi1 = Math.sin(phi1);
    const cosPhi1 = Math.cos(phi1);
    const sinDelta = Math.sin(delta);
    const cosDelta = Math.cos(delta);

    // 計算推算後的緯度 phi2
    const phi2 = Math.asin(sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(theta));

    // 計算推算後的經度 lambda2
    const y = Math.sin(theta) * sinDelta * cosPhi1;
    const x = cosDelta - sinPhi1 * Math.sin(phi2);
    const lambda2 = lambda1 + Math.atan2(y, x);

    // 轉回十進制度數並規範經度至 [-180, 180]
    const newLat = (phi2 * 180) / Math.PI;
    const newLng = (((lambda2 * 180) / Math.PI) + 540) % 360 - 180;

    return { lat: newLat, lng: newLng };
  }

  /**
   * 計算兩經緯度點的地面直線距離 (Haversine Formula)
   * @returns {number} 距離 (公尺)
   */
  static calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // 地球平均半徑 (公尺)
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // =========================================================================
  // 內部輔助 (Helpers)
  // =========================================================================

  updateState(newState, reason = '') {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      this.log(`[狀態切換] ${oldState} ➔ ${newState} (${reason})`, 'info');
      this.onStateChange({ state: newState, oldState: oldState, reason: reason });
    }
  }

  log(msg, level = 'info') {
    if (this.onLog) {
      this.onLog(`[${new Date().toLocaleTimeString()}] ${msg}`, level);
    }
  }
}
