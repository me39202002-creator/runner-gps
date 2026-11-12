/**
 * @file geolocation-service.js
 * @description 硬體定位層：封裝 HTML5 Geolocation API (watchPosition)，提供高精度定位、座標距離計算、配速估算與傳輸節流
 */

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
   * 內部處理座標、節流與過濾
   */
  handlePositionUpdate(position, minDistance, throttleMs, maxAccuracy) {
    const coords = position.coords;
    const now = Date.now();

    // 1. 精度過濾：若誤差過大（如大於 50m），暫不派發跳動座標
    if (coords.accuracy && coords.accuracy > maxAccuracy) {
      console.warn(`[GeolocationService] 忽略低精度座標: 誤差 ${coords.accuracy.toFixed(1)}m > ${maxAccuracy}m`);
      return;
    }

    // 2. 節流機制 (Throttling)
    if (this.lastEmittedPosition) {
      const timeDiff = now - this.lastEmittedTimestamp;
      const dist = calculateDistanceMeters(
        this.lastEmittedPosition.lat,
        this.lastEmittedPosition.lng,
        coords.latitude,
        coords.longitude
      );

      // 時間未達門檻且移動距離小於最小位移時跳過
      if (timeDiff < throttleMs && dist < minDistance) {
        return;
      }

      this.totalDistanceMeters += dist;
    }

    const coordsData = {
      lat: coords.latitude,
      lng: coords.longitude,
      accuracy: coords.accuracy,
      speed: coords.speed, // m/s
      heading: coords.heading,
      pace: formatPace(coords.speed),
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
    console.log('[GeolocationService] 已停止定位追蹤');
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
