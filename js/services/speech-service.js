/**
 * @file speech-service.js
 * @description 語音廣播與跑友快捷喊話服務 (針對 Android、iOS 與行動 WebView 深度相容優化)
 * 1. 雙重提示：Web Audio 雙音叮咚鈴聲 (Chime) + Web Speech Synthesis (TTS 語音朗讀)
 * 2. 徹底解決 Android Chrome / WebView 的 V8 記憶體回收 (GC)、暫停 (Paused) 及語音包延遲載入問題
 * 3. 支援全螢幕任意觸控自動解鎖 (Autoplay Policy Unlock) 與震動提示
 */

export const QUICK_SHOUT_TEMPLATES = [
  {
    id: 'cheer',
    icon: '🏃‍♂️',
    label: '加油衝刺',
    text: '大家加油！最後衝刺！',
    color: 'teal',
    bgClass: 'bg-teal-500/15 hover:bg-teal-500/25 border-teal-500/40 text-teal-300'
  },
  {
    id: 'wait',
    icon: '🛑',
    label: '等我一下',
    text: '等我一下！放慢配速',
    color: 'amber',
    bgClass: 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/40 text-amber-300'
  },
  {
    id: 'supply',
    icon: '🥤',
    label: '補給站見',
    text: '我在補給站等大家',
    color: 'sky',
    bgClass: 'bg-sky-500/15 hover:bg-sky-500/25 border-sky-500/40 text-sky-300'
  },
  {
    id: 'warning',
    icon: '⚠️',
    label: '注意路況',
    text: '注意前方路況，小心紅燈！',
    color: 'rose',
    bgClass: 'bg-rose-500/15 hover:bg-rose-500/25 border-rose-500/40 text-rose-300'
  },
  {
    id: 'turnaround',
    icon: '🔄',
    label: '準備折返',
    text: '即將抵達折返點！',
    color: 'indigo',
    bgClass: 'bg-indigo-500/15 hover:bg-indigo-500/25 border-indigo-500/40 text-indigo-300'
  },
  {
    id: 'sos',
    icon: '🆘',
    label: '抽筋求助',
    text: '需要協助！我抽筋了！',
    color: 'rose',
    bgClass: 'bg-rose-600/25 hover:bg-rose-600/40 border-rose-500 text-rose-200'
  }
];

class SpeechService {
  constructor() {
    this.isSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.isAudioPrimed = false;
    this.isTtsEnabled = localStorage.getItem('runner_gps_tts_enabled') !== 'false';
    this.lastSpokenText = null;
    this.lastSpokenTime = 0;
    this.activeUtterances = new Set(); // 關鍵：防止 Android V8 垃圾回收機制提早中止語音
    this.audioCtx = null;
    this.cachedVoices = [];

    this.initVoiceLoader();
    this.setupGlobalUnlock();
  }

  /**
   * 初始化非同步語音包載入監聽 (Android Chrome 語音包非同步機制)
   */
  initVoiceLoader() {
    if (!this.isSupported) return;
    try {
      this.cachedVoices = window.speechSynthesis.getVoices() || [];
      window.speechSynthesis.onvoiceschanged = () => {
        this.cachedVoices = window.speechSynthesis.getVoices() || [];
      };
    } catch (e) {
      console.warn('[SpeechService] 語音包清單讀取警告:', e);
    }
  }

  /**
   * 智慧全域解鎖：使用者在螢幕上點擊或滑動任意位置，即刻解除瀏覽器 Audio/Speech Autoplay 限制
   */
  setupGlobalUnlock() {
    if (typeof document === 'undefined') return;

    const unlockHandler = () => {
      this.primeAudio();
      document.removeEventListener('touchstart', unlockHandler, true);
      document.removeEventListener('touchend', unlockHandler, true);
      document.removeEventListener('click', unlockHandler, true);
      document.removeEventListener('pointerdown', unlockHandler, true);
    };

    document.addEventListener('touchstart', unlockHandler, { once: true, passive: true, capture: true });
    document.addEventListener('touchend', unlockHandler, { once: true, passive: true, capture: true });
    document.addEventListener('click', unlockHandler, { once: true, passive: true, capture: true });
    document.addEventListener('pointerdown', unlockHandler, { once: true, passive: true, capture: true });
  }

  /**
   * 解鎖行動裝置 AudioContext 與 SpeechSynthesis
   */
  primeAudio() {
    if (this.isAudioPrimed) return;

    // 1. 解鎖 Web AudioContext
    try {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (AudioCtxClass && !this.audioCtx) {
        this.audioCtx = new AudioCtxClass();
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
    } catch (e) {}

    // 2. 解鎖 SpeechSynthesis (Android / iOS 需由手勢發起微量語音)
    if (this.isSupported) {
      try {
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
        const dummyUtterance = new SpeechSynthesisUtterance(' ');
        dummyUtterance.volume = 0.01;
        this.activeUtterances.add(dummyUtterance);
        dummyUtterance.onend = () => this.activeUtterances.delete(dummyUtterance);
        dummyUtterance.onerror = () => this.activeUtterances.delete(dummyUtterance);
        window.speechSynthesis.speak(dummyUtterance);
      } catch (e) {}
    }

    this.isAudioPrimed = true;
    console.log('[SpeechService] 音訊與語音引擎已全面解鎖就緒');
  }

  /**
   * 播放科技感跑步提示雙音「叮咚 🎵」
   * 即使 TTS 在某些特殊 Android 機型被靜音，使用者依然能 100% 聽見響亮的提示鈴聲！
   */
  playChime() {
    try {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtxClass) return;

      if (!this.audioCtx) {
        this.audioCtx = new AudioCtxClass();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      const now = this.audioCtx.currentTime;

      // 第一音 (E5 - 659.25Hz)
      const osc1 = this.audioCtx.createOscillator();
      const gain1 = this.audioCtx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(659.25, now);
      gain1.gain.setValueAtTime(0.35, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      osc1.connect(gain1);
      gain1.connect(this.audioCtx.destination);
      osc1.start(now);
      osc1.stop(now + 0.16);

      // 第二音 (A5 - 880Hz)
      const osc2 = this.audioCtx.createOscillator();
      const gain2 = this.audioCtx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880, now + 0.12);
      gain2.gain.setValueAtTime(0.40, now + 0.12);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
      osc2.connect(gain2);
      gain2.connect(this.audioCtx.destination);
      osc2.start(now + 0.12);
      osc2.stop(now + 0.38);
    } catch (e) {
      console.warn('[SpeechService] 鈴聲播放受限:', e);
    }
  }

  /**
   * 切換語音朗讀開關 (開/關)
   * @param {boolean|null} enable 
   */
  setTtsEnabled(enable = null) {
    if (enable !== null) {
      this.isTtsEnabled = !!enable;
    } else {
      this.isTtsEnabled = !this.isTtsEnabled;
    }
    localStorage.setItem('runner_gps_tts_enabled', this.isTtsEnabled ? 'true' : 'false');
    return this.isTtsEnabled;
  }

  /**
   * 朗讀跑友喊話內容 (TTS 繁體中文，含 Android Chrome 深度相容修復)
   * @param {string} text 喊話訊息
   * @param {string} senderName 發送者暱稱
   */
  speak(text, senderName = '') {
    if (!this.isTtsEnabled || !text) return;

    // 避免 2 秒內重複朗讀相同一句話
    const now = Date.now();
    if (this.lastSpokenText === text && (now - this.lastSpokenTime) < 2000) {
      return;
    }
    this.lastSpokenText = text;
    this.lastSpokenTime = now;

    // 1. 無論如何優先播放響亮叮咚提示鈴聲（喚醒音訊硬體與藍牙耳機通道）
    this.playChime();

    if (!this.isSupported) return;

    try {
      // 確保 Android 未被卡在 paused 狀態
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }

      // Android 避坑：若目前正在唸，執行 cancel，並延遲 50ms 再呼叫 speak
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
      }

      setTimeout(() => {
        try {
          const messageToSpeak = senderName ? `${senderName} 說：${text}` : text;
          const utterance = new SpeechSynthesisUtterance(messageToSpeak);

          utterance.lang = 'zh-TW';
          utterance.rate = 1.05; // 跑步時稍微敏捷明快的語速
          utterance.pitch = 1.0;
          utterance.volume = 1.0;

          // 智慧篩選適合的繁體或中文語音包
          const voices = this.cachedVoices.length > 0 ? this.cachedVoices : window.speechSynthesis.getVoices();
          if (voices && voices.length > 0) {
            const twVoice = voices.find(v => {
              const lang = (v.lang || '').toLowerCase();
              return lang.includes('zh-tw') || lang.includes('zh_tw') || lang.includes('cmn-hant-tw') || lang.includes('cmn-tw');
            }) || voices.find(v => {
              const lang = (v.lang || '').toLowerCase();
              return lang.startsWith('zh') || lang.includes('cmn') || (v.name && (v.name.includes('Taiwan') || v.name.includes('台灣') || v.name.includes('國語')));
            });

            if (twVoice) {
              utterance.voice = twVoice;
            }
          }

          // 關鍵修復：將 utterance 存入 Set 中，防範 Android V8 GC 機制提早清除語音
          this.activeUtterances.add(utterance);
          utterance.onend = () => {
            this.activeUtterances.delete(utterance);
          };
          utterance.onerror = (e) => {
            this.activeUtterances.delete(utterance);
            console.warn('[SpeechService] 語音朗讀事件警示:', e);
          };

          window.speechSynthesis.speak(utterance);
        } catch (innerErr) {
          console.warn('[SpeechService] speak 呼叫異常:', innerErr);
        }
      }, 50);
    } catch (err) {
      console.warn('[SpeechService] 朗讀準備失敗:', err);
    }
  }

  /**
   * 觸發觸覺震動回饋 (Haptic Feedback)
   * @param {number[]} pattern 震動節奏毫秒
   */
  vibrate(pattern = [120, 60, 120]) {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch (e) {}
    }
  }
}

export const speechService = new SpeechService();
