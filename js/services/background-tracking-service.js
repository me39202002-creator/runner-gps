/**
 * @file background-tracking-service.js
 * @description 實現手機「螢幕關閉 / 物理鎖定螢幕」時仍能持續 GPS 定位與雲端同步之背景保活服務
 * 
 * 解決手機瀏覽器 (iOS Safari / Android Chrome) 按電源鍵關閉螢幕時系統強制暫停 GPS 的問題：
 * 1. 背景靜音音訊循環 (Silent Audio Loop - 取得 iOS/Android 背景多媒體執行權限)
 * 2. 鎖定螢幕媒體控制器 (MediaSession API - 防止系統凍結 JS 引擎並於鎖屏顯示追蹤狀態)
 * 3. 雙重定位脈衝 (watchPosition + getCurrentPosition 定期主動喚醒 GPS 晶片)
 */

class BackgroundTrackingService {
  constructor() {
    this.audioElement = null;
    this.isActive = false;
    this.pulseInterval = null;
    this.onLocationPulse = null;
  }

  /**
   * 產生標準 8-bit mono 8000Hz 靜音 WAV 音訊
   * 檔案極小 (僅 44 bytes)，完全無聲、不耗流量，且符合 WebKit 媒體播放器規格
   */
  getSilentAudioURI() {
    return 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
  }

  /**
   * 啟動背景鎖屏追蹤保活機制 (需由使用者點擊或手勢觸發)
   * @param {Function} onPulseCallback 每次背景 GPS 脈衝回呼
   * @returns {Promise<boolean>}
   */
  async start(onPulseCallback = null) {
    if (this.isActive) return true;
    if (onPulseCallback) {
      this.onLocationPulse = onPulseCallback;
    }

    try {
      if (!this.audioElement) {
        this.audioElement = new Audio(this.getSilentAudioURI());
        this.audioElement.loop = true;
        this.audioElement.volume = 0.05; // 避免 iOS 零音量自動休眠最佳化，微量實質完全靜音
        this.audioElement.setAttribute('playsinline', 'true');
        this.audioElement.setAttribute('webkit-playsinline', 'true');

        // 音訊結束時強制循環重播
        this.audioElement.addEventListener('ended', () => {
          if (this.isActive) {
            this.audioElement.play().catch(() => {});
          }
        });

        // 監聽螢幕可見度變化 (鎖定螢幕或切換時確保不被休眠)
        document.addEventListener('visibilitychange', () => {
          if (this.isActive && document.visibilityState === 'hidden') {
            if (this.audioElement && this.audioElement.paused) {
              this.audioElement.play().catch(() => {});
            }
          }
        });
      }

      await this.audioElement.play();
      this.isActive = true;

      // 註冊手機鎖定螢幕 (Lock Screen) 之媒體控制器資訊
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: '跑友即時 GPS 追蹤中 🏃‍♂️',
          artist: '螢幕關閉持續背景定位中',
          album: '跑友即時地圖 (Runner GPS)'
        });
        navigator.mediaSession.playbackState = 'playing';

        // 監聽播放/暫停事件，維持背景活躍
        navigator.mediaSession.setActionHandler('play', async () => {
          if (this.audioElement) await this.audioElement.play();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          if (this.audioElement) this.audioElement.play();
        });
      }

      // 啟動主動 GPS 背景脈衝 (每 4 秒主動觸發一次，防止 watchPosition 在螢幕關閉時休眠)
      if (this.pulseInterval) clearInterval(this.pulseInterval);
      this.pulseInterval = setInterval(() => {
        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (typeof this.onLocationPulse === 'function') {
                this.onLocationPulse(pos);
              }
            },
            (err) => {
              // 忽略單次逾時，持續背景重試
            },
            { enableHighAccuracy: true, timeout: 5000, maximumAge: 3000 }
          );
        }
      }, 4000);

      console.log('[BackgroundTrackingService] 鎖屏/熄屏背景保活與 GPS 脈衝已啟動');
      return true;
    } catch (err) {
      console.warn('[BackgroundTrackingService] 背景音訊啟動受阻 (需手勢操作):', err);
      return false;
    }
  }

  /**
   * 停止背景鎖屏保活
   */
  stop() {
    if (this.audioElement) {
      try {
        this.audioElement.pause();
      } catch (e) {}
    }
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval);
      this.pulseInterval = null;
    }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
    }
    this.isActive = false;
    console.log('[BackgroundTrackingService] 背景鎖屏追蹤已停止');
  }
}

export const backgroundTrackingService = new BackgroundTrackingService();
