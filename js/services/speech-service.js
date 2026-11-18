/**
 * @file speech-service.js
 * @description 語音廣播與跑友快捷喊話服務
 * 整合瀏覽器與原生 WebView 之 Web Speech Synthesis API (TTS)，
 * 支援文字轉繁體中文語音自動朗讀、震動反饋 (Haptic Feedback) 與常用跑步快捷片語。
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
  }

  /**
   * 解鎖行動裝置之 Web Audio / Speech 播放限制
   * 需於使用者手勢事件 (如點擊按鈕) 觸發
   */
  primeAudio() {
    if (this.isAudioPrimed || !this.isSupported) return;
    try {
      const emptyUtter = new SpeechSynthesisUtterance('');
      emptyUtter.volume = 0;
      window.speechSynthesis.speak(emptyUtter);
      this.isAudioPrimed = true;
      console.log('[SpeechService] 語音引擎已解鎖就緒');
    } catch (e) {
      console.warn('[SpeechService] 語音解鎖異常:', e);
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
   * 朗讀跑友喊話內容 (TTS 繁體中文)
   * @param {string} text 喊話訊息
   * @param {string} senderName 發送者暱稱
   */
  speak(text, senderName = '') {
    if (!this.isTtsEnabled || !this.isSupported || !text) return;

    // 避免 2 秒內重複朗讀相同一句話
    const now = Date.now();
    if (this.lastSpokenText === text && (now - this.lastSpokenTime) < 2000) {
      return;
    }
    this.lastSpokenText = text;
    this.lastSpokenTime = now;

    try {
      // 停止目前正在念的句子
      window.speechSynthesis.cancel();

      const messageToSpeak = senderName ? `${senderName} 說：${text}` : text;
      const utterance = new SpeechSynthesisUtterance(messageToSpeak);

      utterance.lang = 'zh-TW';
      utterance.rate = 1.05; // 跑步時稍微敏捷明快的語速
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      // 嘗試選取 zh-TW 本地語音包
      const voices = window.speechSynthesis.getVoices();
      if (voices && voices.length > 0) {
        const twVoice = voices.find(v => v.lang === 'zh-TW' || v.lang === 'zh_TW' || v.lang.includes('TW'));
        if (twVoice) {
          utterance.voice = twVoice;
        }
      }

      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.warn('[SpeechService] 朗讀失敗:', err);
    }
  }

  /**
   * 觸發觸覺震動回饋 (Haptic Feedback)
   * @param {number[]} pattern 震動節奏毫秒
   */
  vibrate(pattern = [100, 50, 100]) {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch (e) {}
    }
  }
}

export const speechService = new SpeechService();
