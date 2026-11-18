/**
 * @file geolocation-service.js
 * @description 硬體定位層：封裝 HTML5 Geolocation API (watchPosition)，提供高精度定位、座標距離計算、配速估算與傳輸節流
 */

import { GPSKalmanFilter } from './kalman-filter.js';

/**
 * 使用 Haversine 公式計算兩點經緯度之球面距離（單位：公尺）
 */
export function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // 地球半徑 (公尺)
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * 將速度 (m/s) 轉換為跑者標準配速格式 (分'秒" / 公里)
 * 例如 3.33 m/s (12 km/h) -> 5'00" / km
 * @param {number|null} speedMps 每秒公尺數
 * @returns {string} 配速字串
 */
export function formatPace(speedMps) {
  if (!speedMps || speedMps < 0.5) {
    return '--\'--" /km';
  }
  // 1 km 所需秒數 = 1000 / speedMps
  const secondsPerKm = 1000 / speedMps;
  // 若配速慢於 20 分鐘/公里 (步行或停下)，顯示休止
  if (secondsPerKm > 1200) {
    return '--\'--" /km';
  }
  const mins = Math.floor(secondsPerKm / 60);
  const secs = Math.floor(secondsPerKm % 60);
  return `${mins}'${secs.toString().padStart(2, '0')}" /km`;
}

class GeolocationService {
  constructor() {
    this.watchId = null;
    this.isTracking = false;
    this.lastEmittedPosition = null;
    this.lastEmittedTimestamp = 0;
    this.totalDistanceMeters = 0;

    // 專屬卡爾曼濾波器與運動學門檻
    this.kalmanFilter = new GPSKalmanFilter(3.0);
    this.speedFilterThresholdMps = 12.5; // 人類跑步速度極限 45 km/h，超過者判定為 GPS 瞬移噪點直接拋棄
    this.stillnessSpeedThresholdMps = 0.6; // 約 2.1 km/h，低於此速度視為原地靜止/等紅燈
    this.stillnessDistanceThresholdMeters = 2.5; // 2.5 公尺內微幅漂移死區，不累計幽靈里程

    // 模擬移動模式 (用於在無 GPS 之桌機進行除錯與預覽)
    this.isMocking = false;
    this.mockInterval = null;

    // 回呼
    this.onLocationCallback = null;
    this.onErrorCallback = null;
  }

  /**
   * 啟動 GPS 即時追蹤
   * @param {Object} options 定位設定 { minDistanceChangeMeters, throttleIntervalMs, maxAcceptableAccuracyMeters }
   * @param {Function} onLocation (coordsData)
   * @param {Function} onError (error)
   */
  startTracking(options = {}, onLocation, onError) {
    if (this.isTracking) {
      console.warn('[GeolocationService] 追蹤已在執行中');
      return;
    }

    if (!('geolocation' in navigator)) {
      const err = new Error('此裝置或瀏覽器不支援 HTML5 Geolocation API');
      if (onError) onError(err);
      return;
    }

    this.onLocationCallback = onLocation;
    this.onErrorCallback = onError;
    this.isTracking = true;
    this.totalDistanceMeters = 0;
    this.lastEmittedPosition = null;
    this.lastEmittedTimestamp = 0;
    this.kalmanFilter.reset(); // 重置濾波器起點狀態

    const minDistance = options.minDistanceChangeMeters || 3;
    const throttleMs = options.throttleIntervalMs || 2000;
    const maxAccuracy = options.maxAcceptableAccuracyMeters || 50;

    const geoOptions = {
      enableHighAccuracy: options.enableHighAccuracy ?? true,
      timeout: options.timeoutMs || 15000,
      maximumAge: options.maximumAgeMs || 0
    };

    console.log('[GeolocationService] 啟動 watchPosition...');

    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        this.handlePositionUpdate(position, minDistance, throttleMs, maxAccuracy);
      },
      (error) => {
        let msg = '定位發生錯誤';
        switch (error.code) {
          case error.PERMISSION_DENIED:
            msg = 'GPS 定位存取權限被拒絕，請在瀏覽器設定中允許位置資訊。';
            break;
          case error.POSITION_UNAVAILABLE:
            msg = '無法獲取目前位置資訊，請確認裝置 GPS 是否開啟。';
            break;
          case error.TIMEOUT:
            msg = '取得 GPS 定位逾時，正在重新嘗試...';
            break;
        }
        console.error('[GeolocationService]', msg, error);
        if (typeof this.onErrorCallback === 'function') {
          this.onErrorCallback(new Error(msg));
        }
      },
      geoOptions
    );
  }

  /**
   * 內部處理座標：結合速度防飄門檻、卡爾曼濾波、靜止死區防幽靈里程與節流發布
   */
  handlePositionUpdate(position, minDistance, throttleMs, maxAccuracy) {
    const coords = position.coords;
    const now = Date.now();
    const rawLat = coords.latitude;
    const rawLng = coords.longitude;
    const rawAccuracy = coords.accuracy || 15;

    // 1. 粗略精度過濾：若誤差過大（如大於門檻），直接忽略
    if (coords.accuracy && coords.accuracy > maxAccuracy) {
      console.warn(`[GeolocationService] 忽略低精度座標: 誤差 ${coords.accuracy.toFixed(1)}m > ${maxAccuracy}m`);
      return;
    }

    // 2. 速度防飄門檻 (Speed-based Anti-Drift)
    // 依據人類跑步生理極限 (時速 45 km/h ≈ 12.5 m/s) 攔截大樓多路徑反射引起的瞬移噪點 (Spikes)
    if (this.lastEmittedPosition) {
      const timeSec = (now - this.lastEmittedTimestamp) / 1000;
      if (timeSec > 0.5) {
        const rawJumpDist = calculateDistanceMeters(
          this.lastEmittedPosition.lat,
          this.lastEmittedPosition.lng,
          rawLat,
          rawLng
        );
        const instantSpeedMps = rawJumpDist / timeSec;

        if (instantSpeedMps > this.speedFilterThresholdMps) {
          console.warn(`[GeolocationService 速度防飄] 攔截異常 GPS 瞬移飄移: 瞬間位移 ${rawJumpDist.toFixed(1)}m, 換算時速 ${(instantSpeedMps * 3.6).toFixed(1)} km/h (超過 ${this.speedFilterThresholdMps * 3.6} km/h 極限門檻)，已濾除跳點！`);
          return;
        }
      }
    }

    // 3. 卡爾曼濾波平滑處理 (2D GPS Kalman Filter)
    // 結合量測精準度，在高樓遮蔽時自動抑制抖動，高速運動時維持即時反應
    const filtered = this.kalmanFilter.filter(
      rawLat,
      rawLng,
      rawAccuracy,
      position.timestamp || now
    );

    let isMoving = true;

    // 4. 節流機制 (Throttling) 與 靜止死區防幽靈里程 (Stillness Deadband)
    if (this.lastEmittedPosition) {
      const timeDiff = now - this.lastEmittedTimestamp;
      const dist = calculateDistanceMeters(
        this.lastEmittedPosition.lat,
        this.lastEmittedPosition.lng,
        filtered.lat,
        filtered.lng
      );

      // 時間未達節流門檻且移動距離小於最小位移時跳過
      if (timeDiff < throttleMs && dist < minDistance) {
        return;
      }

      // 判斷是否處於原地等待/靜止休息
      // 若手機回傳速度小於 0.6 m/s (約 2.1 km/h) 且平滑位移 < 2.5m，視為原地微幅擾動，嚴禁累加里程！
      const currentSpeed = (typeof coords.speed === 'number' && !isNaN(coords.speed) && coords.speed >= 0)
        ? coords.speed
        : (dist / Math.max(timeDiff / 1000, 1));

      if (currentSpeed < this.stillnessSpeedThresholdMps && dist < this.stillnessDistanceThresholdMeters) {
        isMoving = false;
        // 原地靜止微晃，不累計至 totalDistanceMeters (徹底根絕幽靈里程)
      } else {
        this.totalDistanceMeters += dist;
      }
    }

    const currentSpeed = isMoving ? (coords.speed ?? 0) : 0;
    const coordsData = {
      lat: filtered.lat,
      lng: filtered.lng,
      rawLat: rawLat,
      rawLng: rawLng,
      accuracy: Math.round(filtered.accuracy * 10) / 10,
      speed: currentSpeed, // m/s
      heading: coords.heading,
      pace: isMoving ? formatPace(coords.speed) : '--\'--" /km',
      totalDistanceMeters: Math.round(this.totalDistanceMeters),
      timestamp: position.timestamp || now
    };

    this.lastEmittedPosition = coordsData;
    this.lastEmittedTimestamp = now;

    if (typeof this.onLocationCallback === 'function') {
      this.onLocationCallback(coordsData);
    }
  }

  /**
   * 接收外部/背景 GPS 脈衝資料並統一進行精度過濾、距離累計與狀態分發
   * 用於手機螢幕關閉時由背景保活服務定時傳入之 GPS 座標
   */
  ingestPosition(position, minDistance = 3, throttleMs = 2000, maxAccuracy = 50) {
    if (!position || !position.coords) return;
    this.handlePositionUpdate(position, minDistance, throttleMs, maxAccuracy);
  }

  /**
   * 停止 GPS 追蹤
   */
  stopTracking() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.mockInterval) {
      clearInterval(this.mockInterval);
      this.mockInterval = null;
      this.isMocking = false;
    }
    this.isTracking = false;
    this.kalmanFilter.reset();
    console.log('[GeolocationService] 已停止定位追蹤並重置濾波器');
  }

  /**
   * 桌面測試用模擬器：在指定經緯度周圍模擬跑者繞圈移動
   */
  startMockTracking(baseLat = 25.033964, baseLng = 121.564468, onLocation) {
    this.stopTracking();
    this.isTracking = true;
    this.isMocking = true;
    this.onLocationCallback = onLocation;

    let angle = 0;
    const radius = 0.002; // 約 200 公尺半徑
    this.totalDistanceMeters = 0;

    console.log('[GeolocationService] 啟動模擬跑步定位...');

    this.mockInterval = setInterval(() => {
      angle += 0.08;
      const lat = baseLat + Math.sin(angle) * radius;
      const lng = baseLng + Math.cos(angle) * (radius * 1.2);

      const mockData = {
        lat,
        lng,
        accuracy: 5.0,
        speed: 3.1 + Math.random() * 0.4, // ~11-12 km/h
        heading: ((angle + Math.PI / 2) * 180) / Math.PI % 360,
        pace: formatPace(3.2),
        totalDistanceMeters: (this.totalDistanceMeters += 6),
        timestamp: Date.now()
      };

      if (typeof this.onLocationCallback === 'function') {
        this.onLocationCallback(mockData);
      }
    }, 2000);
  }
}

export const geolocationService = new GeolocationService();
