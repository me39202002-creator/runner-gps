/**
 * @file kalman-filter.js
 * @description 跑者專屬經緯度卡爾曼濾波器 (2D GPS Kalman Filter)
 * 用於高樓遮蔽、玻璃反射下的 GPS 軌跡平滑，結合量測誤差 (Accuracy) 動態調整濾波增益。
 */

export class GPSKalmanFilter {
  /**
   * @param {number} processNoise 過程雜訊速度 (跑者預期速度變異 m/s，預設 3.0 m/s)
   */
  constructor(processNoise = 3.0) {
    this.processNoise = processNoise; // 狀態轉移不確定性 (Q 參數)
    this.lat = null;
    this.lng = null;
    this.variance = -1; // 估計誤差方差 (公尺^2)，-1 代表尚未初始化
    this.lastTimestamp = 0;
  }

  /**
   * 重置濾波器狀態 (重新開始跑步時使用)
   */
  reset() {
    this.lat = null;
    this.lng = null;
    this.variance = -1;
    this.lastTimestamp = 0;
  }

  /**
   * 輸入原始 GPS 經緯度與精準度，輸出平滑後的座標
   * @param {number} measuredLat 原始緯度
   * @param {number} measuredLng 原始經度
   * @param {number} accuracy 原始定位精準度 (公尺)
   * @param {number} timestamp 座標時間戳 (毫秒)
   * @returns {{ lat: number, lng: number, accuracy: number }}
   */
  filter(measuredLat, measuredLng, accuracy, timestamp) {
    const rawAccuracy = Math.max(accuracy || 10, 1.0);
    const now = timestamp || Date.now();

    // 首次輸入直接初始化為起點錨點
    if (this.variance < 0 || this.lat === null) {
      this.lat = measuredLat;
      this.lng = measuredLng;
      this.variance = rawAccuracy * rawAccuracy;
      this.lastTimestamp = now;
      return { lat: this.lat, lng: this.lng, accuracy: rawAccuracy };
    }

    // 計算時間差 (秒，限制最小 0.1s 防止除以 0)
    const dt = Math.max((now - this.lastTimestamp) / 1000, 0.1);
    this.lastTimestamp = now;

    // 1. 預測階段 (Predict)
    // 隨時間推移，位置估計的不確定性增加 (加上過程雜訊 Q)
    this.variance += (this.processNoise * this.processNoise) * dt;

    // 2. 更新階段 (Update)
    // 量測雜訊 R (以 GPS accuracy 平方為基準)
    const measurementNoise = rawAccuracy * rawAccuracy;

    // 計算卡爾曼增益 K (0 ~ 1 之間)
    // 當 GPS 精度極差 (例如 40m) 時，measurementNoise 很大，K 很小 -> 傾向維持現狀防飄移
    // 當 GPS 精度極高 (例如 3m) 時，measurementNoise 很小，K 接近 1 -> 快速跟進真實運動
    const K = this.variance / (this.variance + measurementNoise);

    // 更新估計座標 (平滑拉動)
    this.lat += K * (measuredLat - this.lat);
    this.lng += K * (measuredLng - this.lng);

    // 更新估計方差
    this.variance = (1 - K) * this.variance;

    return {
      lat: this.lat,
      lng: this.lng,
      accuracy: Math.sqrt(this.variance)
    };
  }
}
