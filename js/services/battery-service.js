/**
 * @file battery-service.js
 * @description 電量監控服務：封裝瀏覽器與 APP 原生 Battery Status API
 * 支援獲取即時剩餘電量百分比 (0-100%)、充電狀態 (Charging State)，
 * 並即時監聽電量變化與充電線拔插事件，低於 20% 提供低電量警示。
 */

class BatteryService {
  constructor() {
    this.battery = null;
    this.level = null;       // 0 ~ 100
    this.charging = false;   // boolean
    this.isSupported = false;
    this.listeners = new Set();
  }

  /**
   * 初始化電量監聽
   * @returns {Promise<boolean>} 是否支援 Battery API
   */
  async init() {
    if (typeof navigator !== 'undefined' && 'getBattery' in navigator) {
      try {
        this.battery = await navigator.getBattery();
        this.isSupported = true;
        this.updateState();

        // 綁定原生電量變更事件
        this.battery.addEventListener('levelchange', () => {
          this.updateState();
          this.notify();
        });

        // 綁定充電狀態變更事件 (接上或拔除充電器)
        this.battery.addEventListener('chargingchange', () => {
          this.updateState();
          this.notify();
        });

        console.log(`[BatteryService] 電量服務就緒: ${this.level}% (${this.charging ? '充電中' : '放電中'})`);
        return true;
      } catch (err) {
        console.warn('[BatteryService] Battery API 呼叫受限或被阻擋:', err);
        this.isSupported = false;
        return false;
      }
    } else {
      console.log('[BatteryService] 當前環境不支援 Battery API (如 iOS Safari)，採優雅降級');
      this.isSupported = false;
      return false;
    }
  }

  /**
   * 更新內部電量數據
   */
  updateState() {
    if (!this.battery) return;
    this.level = Math.round(this.battery.level * 100);
    this.charging = !!this.battery.charging;
  }

  /**
   * 取得本機即時電量資料物件
   * @returns {{ level: number|null, charging: boolean, isSupported: boolean }}
   */
  getBatteryInfo() {
    if (!this.isSupported || this.level == null) {
      return {
        level: null,
        charging: false,
        isSupported: false
      };
    }
    return {
      level: this.level,
      charging: this.charging,
      isSupported: true
    };
  }

  /**
   * 格式化跑友電量物件為 UI 顯示字串與顏色樣式
   * @param {Object|number|null} batteryData 
   * @returns {{ icon: string, text: string, colorClass: string, isLow: boolean, isCharging: boolean }}
   */
  formatBattery(batteryData) {
    if (batteryData == null) {
      return {
        icon: '🔋',
        text: '--%',
        fullText: '電量未知',
        colorClass: 'text-slate-400',
        badgeBg: 'bg-slate-800',
        badgeBorder: 'border-slate-700',
        isLow: false,
        isCharging: false
      };
    }

    let level = null;
    let charging = false;

    if (typeof batteryData === 'number') {
      level = Math.round(batteryData);
    } else if (typeof batteryData === 'object') {
      level = batteryData.level != null ? Math.round(batteryData.level) : null;
      charging = !!batteryData.charging;
    }

    if (level == null || isNaN(level)) {
      return {
        icon: '🔋',
        text: '--%',
        fullText: '電量未知',
        colorClass: 'text-slate-400',
        badgeBg: 'bg-slate-800',
        badgeBorder: 'border-slate-700',
        isLow: false,
        isCharging: false
      };
    }

    // 限制範圍在 0 ~ 100
    level = Math.max(0, Math.min(100, level));

    if (charging) {
      return {
        icon: '⚡',
        text: `${level}%`,
        fullText: `⚡ ${level}% (充電中)`,
        colorClass: 'text-emerald-400 font-bold',
        badgeBg: 'bg-emerald-500/15',
        badgeBorder: 'border-emerald-500/40',
        isLow: false,
        isCharging: true
      };
    }

    if (level <= 20) {
      return {
        icon: '🪫',
        text: `${level}%`,
        fullText: `🪫 ${level}% (低電量)`,
        colorClass: 'text-rose-400 font-bold animate-pulse',
        badgeBg: 'bg-rose-500/20',
        badgeBorder: 'border-rose-500/50',
        isLow: true,
        isCharging: false
      };
    }

    if (level <= 50) {
      return {
        icon: '🔋',
        text: `${level}%`,
        fullText: `🔋 ${level}%`,
        colorClass: 'text-amber-400 font-medium',
        badgeBg: 'bg-amber-500/15',
        badgeBorder: 'border-amber-500/30',
        isLow: false,
        isCharging: false
      };
    }

    return {
      icon: '🔋',
      text: `${level}%`,
      fullText: `🔋 ${level}%`,
      colorClass: 'text-emerald-400 font-medium',
      badgeBg: 'bg-emerald-500/10',
      badgeBorder: 'border-emerald-500/30',
      isLow: false,
      isCharging: false
    };
  }

  /**
   * 註冊電量改變監聽器
   */
  onChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.add(callback);
    }
  }

  notify() {
    const info = this.getBatteryInfo();
    this.listeners.forEach((fn) => {
      try { fn(info); } catch (e) {}
    });
  }
}

export const batteryService = new BatteryService();
