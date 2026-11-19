/**
 * @file speech-service.js
 * @description 語音廣播與跑友快捷喊話服務 (針對 Android、iOS 與行動 WebView 深度相容優化)
 * 1. 頂級三重音訊保證：
 *    - 第一重：Web Audio 科技感雙音叮咚鈴聲 (Chime - 100% 硬體直出)
 *    - 第二重：本機預錄高清中文語音包 (Web Audio Buffer / HTML5 Audio 直播，零延遲、免本機 TTS 引擎、無痛相容所有安卓與小折疊/平價機)
 *    - 第三重：動態高音質雲端語音串流 + 系統 Web Speech Synthesis (自訂喊話彈性備援)
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

export const PRESET_AUDIO_CONFIG = [
  { id: 'cheer', keywords: ['加油', '衝刺'], file: 'audio/shout_cheer.mp3', text: '大家加油！最後衝刺！' },
  { id: 'wait', keywords: ['等我', '放慢'], file: 'audio/shout_wait.mp3', text: '等我一下！放慢配速' },
  { id: 'supply', keywords: ['補給'], file: 'audio/shout_supply.mp3', text: '我在補給站等大家' },
  { id: 'warning', keywords: ['路況', '紅燈', '小心'], file: 'audio/shout_warning.mp3', text: '注意前方路況，小心紅燈！' },
  { id: 'turnaround', keywords: ['折返'], file: 'audio/shout_turnaround.mp3', text: '即將抵達折返點！' },
  { id: 'sos', keywords: ['抽筋', '協助', '求助'], file: 'audio/shout_sos.mp3', text: '需要協助！我抽筋了！' },
  { id: 'test', keywords: ['測試', '試聽'], file: 'audio/test_speech.mp3', text: '語音廣播測試，大家加油！' }
];

class SpeechService {
  constructor() {
    this.isSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.isAudioPrimed = false;
    this.isTtsEnabled = localStorage.getItem('runner_gps_tts_enabled') !== 'false';
    this.lastSpokenText = null;
    this.lastSpokenTime = 0;
    this.activeUtterances = new Set();
    this.audioCtx = null;
    this.cachedVoices = [];
    this.audioBuffers = new Map(); // 預先解碼的 Web Audio Buffer (0ms 極速播放)
    this.audioPlayer = null; // HTML5 Audio 播放器單例

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
   * 解鎖行動裝置 AudioContext、HTML5 Audio 與 SpeechSynthesis
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
      // 異步預載入常用音效緩衝區 (Web Audio Pipeline)
      this.preloadAudioBuffers();
    } catch (e) {}

    // 2. 解鎖 HTML5 Audio 播放實例
    try {
      if (!this.audioPlayer) {
        this.audioPlayer = new Audio();
      }
      // 播放一段極微小的靜音 wav 進行授權解鎖
      this.audioPlayer.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      const playPromise = this.audioPlayer.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          this.audioPlayer.pause();
        }).catch(() => {});
      }
    } catch (e) {}

    // 3. 解鎖 SpeechSynthesis (Android / iOS 需由手勢發起微量語音)
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
    console.log('[SpeechService] 頂級多通道音訊引擎已全面解鎖就緒');
  }

  /**
   * 預先非同步加載預錄音頻至 Web AudioContext 記憶體中
   */
  async preloadAudioBuffers() {
    if (!this.audioCtx) return;
    for (const item of PRESET_AUDIO_CONFIG) {
      if (this.audioBuffers.has(item.id)) continue;
      try {
        const response = await fetch(item.file);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
          this.audioBuffers.set(item.id, audioBuffer);
        }
      } catch (err) {
        // 略過靜態載入失敗，播放時仍有 HTML5 Audio 與 TTS 雙重後備
      }
    }
  }

  /**
   * 播放科技感跑步提示雙音「叮咚 🎵」
   * 雙頻率合成 (E5 659.25Hz -> A5 880Hz)，長度約 380ms
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
   * 透過 Web Audio 管道直接播放預解碼的音頻緩衝區 (與 Chime 同一管線，100% 成功且無衝突)
   * @param {string} bufferId 
   * @param {number} delaySec 延遲秒數 (等鈴聲播放完畢)
   * @returns {boolean} 是否成功發起播放
   */
  playBufferSource(bufferId, delaySec = 0.40) {
    if (!this.audioCtx || !this.audioBuffers.has(bufferId)) return false;
    try {
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      const buffer = this.audioBuffers.get(bufferId);
      const source = this.audioCtx.createBufferSource();
      const gainNode = this.audioCtx.createGain();
      gainNode.gain.setValueAtTime(1.0, this.audioCtx.currentTime);

      source.buffer = buffer;
      source.connect(gainNode);
      gainNode.connect(this.audioCtx.destination);

      source.start(this.audioCtx.currentTime + delaySec);
      return true;
    } catch (e) {
      console.warn('[SpeechService] Buffer 播放失敗:', e);
      return false;
    }
  }

  /**
   * 透過 HTML5 Audio 標籤播放音訊 (本地 mp3 或線上語音串流)
   * @param {string} src 音訊 URL
   * @param {number} delayMs 延遲毫秒數
   */
  playAudioFile(src, delayMs = 400) {
    setTimeout(() => {
      try {
        if (!this.audioPlayer) {
          this.audioPlayer = new Audio();
        }
        this.audioPlayer.pause();
        this.audioPlayer.currentTime = 0;
        this.audioPlayer.volume = 1.0;
        this.audioPlayer.src = src;

        const playPromise = this.audioPlayer.play();
        if (playPromise !== undefined) {
          playPromise.catch((err) => {
            console.warn('[SpeechService] Audio 元素播放異常，轉入 TTS 備援:', err);
            // 若音訊串流失敗，最後回退到本機 Web Speech
            this.speakNativeTts(this.lastSpokenText || '');
          });
        }
      } catch (err) {
        console.warn('[SpeechService] playAudioFile 失敗:', err);
      }
    }, delayMs);
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
   * 朗讀跑友喊話內容 (多層保證：叮咚 -> 預錄語音/雲端語音串流 -> 本機系統 TTS)
   * @param {string} text 喊話訊息
   * @param {string} senderName 發送者暱稱
   */
  speak(text, senderName = '') {
    if (!this.isTtsEnabled || !text) return;

    // 避免 1.5 秒內重複觸發同一句話
    const now = Date.now();
    if (this.lastSpokenText === text && (now - this.lastSpokenTime) < 1500) {
      return;
    }
    this.lastSpokenText = text;
    this.lastSpokenTime = now;

    // 1. 優先播放科技感雙音叮咚鈴聲 (與耳機/揚聲器建立通道)
    this.playChime();

    // 2. 檢測是否匹配預錄語音庫 (涵蓋所有 6 大快捷按鈕與測試按鈕)
    const matchedPreset = PRESET_AUDIO_CONFIG.find(item => {
      return item.keywords.some(kw => text.includes(kw)) || text.includes(item.text);
    });

    if (matchedPreset) {
      // 2A. 首選：Web Audio Buffer 直播 (零延遲、同通道硬體直出)
      const bufferPlayed = this.playBufferSource(matchedPreset.id, 0.40);
      if (bufferPlayed) {
        console.log(`[SpeechService] 使用 Web Audio Buffer 播放預錄語音: ${matchedPreset.text}`);
        return;
      }

      // 2B. 次選：HTML5 Audio 本地 mp3 檔案播放
      console.log(`[SpeechService] 使用本地音檔播放: ${matchedPreset.file}`);
      this.playAudioFile(matchedPreset.file, 400);
      return;
    }

    // 3. 自訂內容處理 (跑友自己輸入的非快捷喊話內容)
    const messageToSpeak = senderName ? `${senderName}說：${text}` : text;

    // 3A. 首選：使用高音質中文雲端語音串流 (對安卓 WebView 100% 有效)
    try {
      const cloudTtsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-TW&q=${encodeURIComponent(messageToSpeak)}`;
      console.log(`[SpeechService] 播放高音質自訂語音串流: ${messageToSpeak}`);
      this.playAudioFile(cloudTtsUrl, 400);
    } catch (e) {
      // 3B. 備選：原生系統 TTS 朗讀
      this.speakNativeTts(messageToSpeak, 420);
    }
  }

  /**
   * 系統原生 Web Speech API 朗讀備援 (當所有音訊檔案與線上串流受阻時觸發)
   * @param {string} message 
   * @param {number} delayMs 
   */
  speakNativeTts(message, delayMs = 420) {
    if (!this.isSupported || !message) return;

    try {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
      }

      setTimeout(() => {
        try {
          const utterance = new SpeechSynthesisUtterance(message);
          utterance.rate = 1.05;
          utterance.pitch = 1.0;
          utterance.volume = 1.0;

          const liveVoices = window.speechSynthesis.getVoices() || [];
          const voices = liveVoices.length > 0 ? liveVoices : this.cachedVoices;
          let selectedVoice = null;

          if (voices && voices.length > 0) {
            selectedVoice = voices.find(v => {
              const lang = (v.lang || '').toLowerCase();
              return lang.includes('zh-tw') || lang.includes('zh_tw') || lang.includes('cmn-hant-tw') || lang.includes('cmn-tw');
            });
            if (!selectedVoice) {
              selectedVoice = voices.find(v => {
                const lang = (v.lang || '').toLowerCase();
                const name = (v.name || '').toLowerCase();
                return lang.startsWith('zh') || lang.includes('cmn') || name.includes('taiwan') || name.includes('chinese') || name.includes('中文') || name.includes('國語');
              });
            }
            if (!selectedVoice) {
              selectedVoice = voices.find(v => v.default) || voices[0];
            }
          }

          if (selectedVoice) {
            utterance.voice = selectedVoice;
            utterance.lang = selectedVoice.lang || 'zh-TW';
          } else {
            utterance.lang = 'zh-TW';
          }

          this.activeUtterances.add(utterance);
          utterance.onend = () => this.activeUtterances.delete(utterance);
          utterance.onerror = (e) => {
            this.activeUtterances.delete(utterance);
            console.warn('[SpeechService] 原生 TTS 朗讀警示:', e.error || e);
          };

          window.speechSynthesis.speak(utterance);
        } catch (innerErr) {
          console.warn('[SpeechService] speakNativeTts 內部異常:', innerErr);
        }
      }, delayMs);
    } catch (err) {
      console.warn('[SpeechService] 原生 TTS 呼叫失敗:', err);
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
