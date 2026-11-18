/**
 * @file app.js
 * @description 主協調控制器 (App Orchestrator)
 * 負責串接各層：
 * Geolocation -> App -> Firebase RTDB -> MapRenderer & UIController
 * 完美支援深藍運動科技風，包括 QR Code 分享、虛擬隊友切換、螢幕常亮與口袋防誤觸黑屏。
 */

import { getAppConfig, saveCustomConfig } from './config.js';
import {
  validateAndSanitizeRoomId,
  generateSafeRoomId,
  generateRandomRoomCode,
  generateSafeRunnerId,
  sanitizeRunnerName,
  sanitizeRoomName,
  sanitizeRoomPassword,
  sanitizeColor,
  getSafeURLParam
} from './security.js';
import { firebaseService } from './services/firebase-service.js';
import { geolocationService } from './services/geolocation-service.js';
import { backgroundTrackingService } from './services/background-tracking-service.js';
import { batteryService } from './services/battery-service.js';
import { speechService } from './services/speech-service.js';
import { mapRenderer } from './components/map-renderer.js';
import { uiController } from './components/ui-controller.js';

class App {
  constructor() {
    this.config = getAppConfig();
    this.roomId = localStorage.getItem('runner_gps_room_id') || generateRandomRoomCode();
    this.roomName = localStorage.getItem('runner_gps_room_name') || '跑友即時小隊';
    this.roomPassword = null;
    this.hasRoomPassword = false;
    this.selfRunner = null;
    this.captainId = null;
    this.isTracking = false;
    this.latestSelfCoords = null;
    this.cachedRunners = new Map();
    this.heartbeatTimer = null;
    this.offlineSweepTimer = null;
    this.lastProcessedShouts = new Map(); // 追蹤各跑友最後處理之喊話時間
    this.shoutTargetRunnerId = null;       // 當前指定喊話目標跑友 (null 為全隊)
  }

  async init() {
    console.log('[App] 正在啟動跑友即時地圖...');
    uiController.init();
    this.bindEvents();

    // 初始化電量服務與地圖快捷喊話
    batteryService.init().then(() => {
      if (this.selfRunner) {
        this.selfRunner.battery = batteryService.level;
        uiController.updateSelfStrip(this.selfRunner);
      }
    });

    mapRenderer.setOnQuickShout((text, type, targetId) => {
      speechService.primeAudio();
      this.handleSendShout(text, type, targetId);
    });

    // 檢查 URL 房間參數與可能帶入之密碼
    const urlRoom = getSafeURLParam('room');
    const safeUrlRoom = validateAndSanitizeRoomId(urlRoom);
    if (safeUrlRoom) {
      this.roomId = safeUrlRoom;
      localStorage.setItem('runner_gps_room_id', this.roomId);
    } else {
      const savedRoomId = localStorage.getItem('runner_gps_room_id');
      if (savedRoomId && validateAndSanitizeRoomId(savedRoomId)) {
        this.roomId = savedRoomId;
      } else {
        this.roomId = generateRandomRoomCode();
        localStorage.setItem('runner_gps_room_id', this.roomId);
      }
    }

    const urlPwd = getSafeURLParam('pwd');
    if (urlPwd) {
      this.roomPassword = sanitizeRoomPassword(urlPwd);
    }

    // 檢查是否曾經主動退出小隊或被移出
    const hasJoinedStatus = localStorage.getItem('runner_gps_has_joined');
    const needExplicitJoin = hasJoinedStatus === 'false';

    const savedRoomName = localStorage.getItem('runner_gps_room_name');
    if (savedRoomName) {
      this.roomName = savedRoomName;
    }

    this.loadSavedProfile(!!safeUrlRoom && safeUrlRoom !== 'RUN-888');

    uiController.renderRoomDetails(this.roomId, this.roomName, this.hasRoomPassword);
    uiController.setSelfRunnerId(this.selfRunner.id);
    mapRenderer.setSelfRunnerId(this.selfRunner.id);

    // 若使用者曾退出或被踢出，開啟設定彈窗供確認新小隊設定
    if (needExplicitJoin) {
      uiController.openCaptainSettingsModal(this.roomName, this.roomId, this.roomPassword, this.selfRunner, true);
      uiController.showToast(`已為您生成新代碼 [${this.roomId}]，暱稱「${this.selfRunner.name}」已直接套用！`, 'info');
    }
    await this.startServices();
  }

  /**
   * 載入個人資料：優先直接套用上次儲存的專屬個人暱稱
   */
  loadSavedProfile(isInvitedTeammate = false) {
    try {
      const saved = localStorage.getItem('runner_gps_user_profile');
      const savedNickname = localStorage.getItem('runner_gps_saved_nickname');
      const savedAvatar = localStorage.getItem('runner_gps_saved_avatar');
      const savedColor = localStorage.getItem('runner_gps_saved_color');

      if (saved) {
        const parsed = JSON.parse(saved);
        // 優先套用特別持久化之個人暱稱
        const resolvedName = savedNickname || parsed.name || (isInvitedTeammate ? '熱血隊友' : '熱血跑友');
        this.selfRunner = {
          id: parsed.id || generateSafeRunnerId(),
          name: sanitizeRunnerName(resolvedName, '熱血跑友'),
          avatar: savedAvatar || parsed.avatar || (isInvitedTeammate ? '🏃‍♀️' : '🏃‍♂️'),
          color: sanitizeColor(savedColor || parsed.color, '#05D5A4'),
          isCaptain: false // 隊長由房間入隊順序判定，先加入者為唯一隊長
        };
      } else {
        const defaultName = savedNickname || (isInvitedTeammate ? '熱血隊友' : '熱血跑友');
        this.selfRunner = {
          id: generateSafeRunnerId(),
          name: sanitizeRunnerName(defaultName, '熱血跑友'),
          avatar: savedAvatar || (isInvitedTeammate ? '🏃‍♀️' : '🏃‍♂️'),
          color: sanitizeColor(savedColor, '#05D5A4'),
          isCaptain: false
        };
        // 只有在從未設定過專屬暱稱且是第一次透過分享連結加入的隊友，才提示設定暱稱
        if (isInvitedTeammate && !savedNickname) {
          setTimeout(() => {
            uiController.openNicknameModal(this.selfRunner.name, this.selfRunner.avatar, this.selfRunner.color);
          }, 800);
        }
      }
    } catch (e) {
      const savedNickname = localStorage.getItem('runner_gps_saved_nickname');
      this.selfRunner = {
        id: generateSafeRunnerId(),
        name: sanitizeRunnerName(savedNickname || (isInvitedTeammate ? '熱血隊友' : '熱血跑友'), '熱血跑友'),
        avatar: '🏃‍♂️',
        color: '#05D5A4',
        isCaptain: false
      };
    }
  }

  /**
   * 儲存個人資料並永久持久化專屬暱稱，下次開啟或加入新小隊皆直接套用
   */
  saveProfile() {
    try {
      localStorage.setItem('runner_gps_user_profile', JSON.stringify(this.selfRunner));
      if (this.selfRunner && this.selfRunner.name) {
        localStorage.setItem('runner_gps_saved_nickname', this.selfRunner.name);
      }
      if (this.selfRunner && this.selfRunner.avatar) {
        localStorage.setItem('runner_gps_saved_avatar', this.selfRunner.avatar);
      }
      if (this.selfRunner && this.selfRunner.color) {
        localStorage.setItem('runner_gps_saved_color', this.selfRunner.color);
      }
    } catch (e) {
      console.warn('[App] 儲存失敗', e);
    }
  }

  bindEvents() {
    const el = uiController.elements;

    // 頭像與色彩選取
    if (el.avatarSelector) {
      el.avatarSelector.addEventListener('click', (e) => {
        const btn = e.target.closest('.avatar-opt');
        if (!btn) return;
        el.avatarSelector.querySelectorAll('.avatar-opt').forEach((b) => {
          b.classList.remove('border-teal-400', 'bg-teal-400/10');
          b.classList.add('border-transparent');
        });
        btn.classList.add('border-teal-400', 'bg-teal-400/10');
        btn.classList.remove('border-transparent');
        this.selfRunner.avatar = btn.dataset.avatar || '🏃‍♂️';
      });
    }

    if (el.colorSelector) {
      el.colorSelector.addEventListener('click', (e) => {
        const btn = e.target.closest('.color-opt');
        if (!btn) return;
        el.colorSelector.querySelectorAll('.color-opt').forEach((b) => {
          b.classList.remove('ring-4', 'ring-teal-400/30');
        });
        btn.classList.add('ring-4', 'ring-teal-400/30');
        this.selfRunner.color = sanitizeColor(btn.dataset.color, '#05D5A4');
      });
    }

    // 確認加入小隊
    if (el.btnConfirmJoin) {
      el.btnConfirmJoin.addEventListener('click', () => this.handleConfirmJoin());
    }

    // 自訂跑友暱稱彈窗開關與選擇
    if (el.btnEditMyNickname) {
      el.btnEditMyNickname.addEventListener('click', () => {
        uiController.openNicknameModal(this.selfRunner.name, this.selfRunner.avatar, this.selfRunner.color);
      });
    }
    if (el.btnCloseNicknameModal) {
      el.btnCloseNicknameModal.addEventListener('click', () => {
        uiController.closeNicknameModal();
      });
    }

    // 暱稱彈窗內選頭像
    if (el.nicknameAvatarSelector) {
      el.nicknameAvatarSelector.addEventListener('click', (e) => {
        const btn = e.target.closest('.avatar-opt');
        if (!btn) return;
        el.nicknameAvatarSelector.querySelectorAll('.avatar-opt').forEach((b) => {
          b.classList.remove('border-teal-400', 'bg-teal-400/10');
          b.classList.add('border-transparent');
        });
        btn.classList.add('border-teal-400', 'bg-teal-400/10');
        btn.classList.remove('border-transparent');
        this.selfRunner.avatar = btn.dataset.avatar || '🏃‍♂️';
      });
    }

    // 暱稱彈窗內選顏色
    if (el.nicknameColorSelector) {
      el.nicknameColorSelector.addEventListener('click', (e) => {
        const btn = e.target.closest('.color-opt');
        if (!btn) return;
        el.nicknameColorSelector.querySelectorAll('.color-opt').forEach((b) => {
          b.classList.remove('ring-4', 'ring-teal-400/30');
        });
        btn.classList.add('ring-4', 'ring-teal-400/30');
        this.selfRunner.color = sanitizeColor(btn.dataset.color, '#05D5A4');
      });
    }

    // 儲存自訂暱稱
    if (el.btnSaveNickname) {
      el.btnSaveNickname.addEventListener('click', () => this.handleSaveCustomNickname());
    }

    // 行動端快捷按鈕綁定
    if (el.btnTopInviteMobile) {
      el.btnTopInviteMobile.addEventListener('click', () => this.showInviteModal());
    }
    if (el.btnToggleWakelockMobile) {
      el.btnToggleWakelockMobile.addEventListener('click', () => uiController.toggleWakeLock());
    }
    if (el.btnPocketModeMobile) {
      el.btnPocketModeMobile.addEventListener('click', () => uiController.togglePocketMode(true));
    }


    // 邀請彈窗 (頂部鈕與大按鈕)
    if (el.btnTopInvite) {
      el.btnTopInvite.addEventListener('click', () => this.showInviteModal());
    }
    if (el.btnInviteModal) {
      el.btnInviteModal.addEventListener('click', () => this.showInviteModal());
    }
    if (el.btnCloseInvite) {
      el.btnCloseInvite.addEventListener('click', () => uiController.closeInviteModal());
    }
    if (el.btnCopyInviteLink) {
      el.btnCopyInviteLink.addEventListener('click', () => this.copyInviteUrl());
    }

    // 複製房間號碼
    if (el.btnCopyRoom) {
      el.btnCopyRoom.addEventListener('click', () => {
        navigator.clipboard.writeText(this.roomId);
        uiController.showToast(`已複製房間代碼: ${this.roomId}`, 'success');
      });
    }

    // 螢幕防休眠開關
    if (el.btnToggleWakelock) {
      el.btnToggleWakelock.addEventListener('click', () => {
        uiController.toggleWakeLock();
      });
    }

    // 點擊跑者名稱或頭像即可自訂個人暱稱與代表色 (下次直接套用)
    const openNicknameQuickModal = () => {
      uiController.openNicknameModal(this.selfRunner.name, this.selfRunner.avatar, this.selfRunner.color);
    };

    if (el.stripRunnerName) {
      el.stripRunnerName.style.cursor = 'pointer';
      el.stripRunnerName.title = '點擊修改個人暱稱 (儲存後下次直接套用)';
      el.stripRunnerName.addEventListener('click', openNicknameQuickModal);
    }
    if (el.stripRunnerAvatar) {
      el.stripRunnerAvatar.style.cursor = 'pointer';
      el.stripRunnerAvatar.title = '點擊修改個人頭像與暱稱';
      el.stripRunnerAvatar.addEventListener('click', openNicknameQuickModal);
    }

    // 系統與小隊綜合設定彈窗
    const openSettingsModal = (focusField = null) => {
      uiController.openCaptainSettingsModal(
        this.roomName,
        this.roomId,
        this.roomPassword,
        this.selfRunner,
        this.selfRunner.isCaptain
      );

      if (this.selfRunner.isCaptain) {
        if (focusField === 'teamName') {
          setTimeout(() => {
            if (el.inputCaptainTeamName) {
              el.inputCaptainTeamName.focus();
              el.inputCaptainTeamName.select();
            }
          }, 100);
        } else if (focusField === 'teamCode') {
          setTimeout(() => {
            if (el.inputCaptainTeamCode) {
              el.inputCaptainTeamCode.focus();
              el.inputCaptainTeamCode.select();
            }
          }, 100);
        }
      } else {
        // 隊員開啟設定彈窗時，自動定位並聚焦至個人跑友名片暱稱輸入框
        setTimeout(() => {
          if (el.settingsRunnerName) {
            el.settingsRunnerName.focus();
            el.settingsRunnerName.select();
          }
        }, 100);
      }
    };

    if (el.btnOpenCaptainSettings) {
      el.btnOpenCaptainSettings.addEventListener('click', () => openSettingsModal());
    }
    if (el.btnTopSettings) {
      el.btnTopSettings.addEventListener('click', () => openSettingsModal());
    }
    if (el.btnTopSettingsMobile) {
      el.btnTopSettingsMobile.addEventListener('click', () => openSettingsModal());
    }
    if (el.btnCloseCaptainSettings) {
      el.btnCloseCaptainSettings.addEventListener('click', () => {
        uiController.closeCaptainSettingsModal();
      });
    }
    if (el.btnCaptainClearPwd) {
      el.btnCaptainClearPwd.addEventListener('click', () => {
        if (el.inputCaptainTeamPwd) el.inputCaptainTeamPwd.value = '';
        uiController.showToast('已清空密碼，儲存後將成為公開免密碼小隊', 'info');
      });
    }
    if (el.btnSaveCaptainSettings) {
      el.btnSaveCaptainSettings.addEventListener('click', () => this.handleSaveCaptainSettings());
    }

    // 設定彈窗內的個人暱稱與頭像儲存
    if (el.btnSettingsSaveProfile) {
      el.btnSettingsSaveProfile.addEventListener('click', () => this.handleSaveSettingsRunnerProfile());
    }

    // 設定彈窗內的頭像與代表色點擊
    if (el.settingsAvatarSelector) {
      el.settingsAvatarSelector.addEventListener('click', (e) => {
        const btn = e.target.closest('.avatar-opt');
        if (!btn) return;
        el.settingsAvatarSelector.querySelectorAll('.avatar-opt').forEach((b) => {
          b.classList.remove('border-teal-400', 'bg-teal-400/10');
          b.classList.add('border-transparent');
        });
        btn.classList.add('border-teal-400', 'bg-teal-400/10');
        btn.classList.remove('border-transparent');
        this.selfRunner.avatar = btn.dataset.avatar || '🏃‍♂️';
      });
    }
    if (el.settingsColorSelector) {
      el.settingsColorSelector.addEventListener('click', (e) => {
        const btn = e.target.closest('.color-opt');
        if (!btn) return;
        el.settingsColorSelector.querySelectorAll('.color-opt').forEach((b) => {
          b.classList.remove('ring-4', 'ring-teal-400/30');
        });
        btn.classList.add('ring-4', 'ring-teal-400/30');
        this.selfRunner.color = btn.dataset.color || '#05D5A4';
      });
    }

    // 清除快取檔案與 Cookie (用戶強烈要求)
    if (el.btnClearAppCache) {
      el.btnClearAppCache.addEventListener('click', () => this.clearAppCacheAndCookies());
    }

    // 設定彈窗內的關屏背景定位開關 (綠色開啟 / 紅色關閉)
    if (el.btnSettingsToggleWakelock) {
      el.btnSettingsToggleWakelock.addEventListener('click', () => {
        uiController.toggleWakeLock();
      });
    }

    // 點擊主畫面小隊名稱或頂部標籤，直接開啟設定彈窗並聚焦
    const dashTitleBtn = document.getElementById('dash-team-title-btn');
    if (dashTitleBtn) {
      dashTitleBtn.addEventListener('click', () => openSettingsModal('teamName'));
    }
    const headerRoomPill = document.getElementById('btn-header-room-pill');
    if (headerRoomPill) {
      headerRoomPill.addEventListener('click', () => openSettingsModal('teamName'));
    }

    // 說明按鈕
    const btnHelp = document.getElementById('btn-help');
    if (btnHelp) {
      btnHelp.addEventListener('click', () => {
        uiController.showToast('💡 提示：點擊「加入/邀請跑友」可獲取小隊 QR Code；開啟「口袋黑屏」可省電防誤觸！', 'info');
      });
    }

    // 口袋黑屏模式開關
    if (el.btnPocketMode) {
      el.btnPocketMode.addEventListener('click', () => {
        uiController.togglePocketMode(true);
      });
    }
    if (el.pocketBlackScreen) {
      el.pocketBlackScreen.addEventListener('dblclick', () => {
        uiController.togglePocketMode(false);
      });
    }

    // 市區 / 衛星 地圖模式切換
    if (el.btnMapRoadmap && el.btnMapSatellite) {
      el.btnMapRoadmap.addEventListener('click', () => {
        mapRenderer.setMapType('roadmap');
        el.btnMapRoadmap.className = 'px-3 py-1 rounded-lg bg-teal-400 text-slate-950 font-bold transition shadow';
        el.btnMapSatellite.className = 'px-3 py-1 rounded-lg text-slate-300 hover:text-white transition';
      });
      el.btnMapSatellite.addEventListener('click', () => {
        mapRenderer.setMapType('satellite');
        el.btnMapSatellite.className = 'px-3 py-1 rounded-lg bg-teal-400 text-slate-950 font-bold transition shadow';
        el.btnMapRoadmap.className = 'px-3 py-1 rounded-lg text-slate-300 hover:text-white transition';
      });
    }

    // 視野按鈕
    if (el.btnRecenterSelf) {
      el.btnRecenterSelf.addEventListener('click', () => {
        if (this.latestSelfCoords) {
          mapRenderer.panTo(this.latestSelfCoords.lat, this.latestSelfCoords.lng, 17);
        } else {
          uiController.showToast('尚未獲取定位座標，正在連線 GPS...', 'warning');
        }
      });
    }

    if (el.btnFitAll) {
      el.btnFitAll.addEventListener('click', () => {
        mapRenderer.fitAllRunners();
      });
    }

    // 跑友一鍵快捷語音/泡泡喊話按鈕
    if (el.btnQuickShout) {
      el.btnQuickShout.addEventListener('click', () => {
        speechService.primeAudio();
        this.shoutTargetRunnerId = null;
        uiController.openQuickShoutModal();
      });
    }

    if (el.btnCloseQuickShout) {
      el.btnCloseQuickShout.addEventListener('click', () => {
        uiController.closeQuickShoutModal();
      });
    }

    if (el.btnToggleTts) {
      el.btnToggleTts.addEventListener('click', () => {
        speechService.primeAudio();
        const enabled = speechService.setTtsEnabled();
        uiController.updateTtsUI(enabled);
        uiController.showToast(enabled ? '🔊 已開啟隊友語音自動朗讀' : '🔇 已關閉語音朗讀 (靜音)', 'info');
      });
    }

    // 試聽語音與鈴聲按鈕
    const btnTestSpeech = document.getElementById('btn-test-speech');
    if (btnTestSpeech) {
      btnTestSpeech.addEventListener('click', () => {
        speechService.primeAudio();
        speechService.speak('語音廣播測試，大家加油！', '跑友小隊');
        uiController.showToast('🎵 正在試聽叮咚提示鈴聲與語音朗讀...', 'info');
      });
    }

    // 快捷跑步片語大按鈕
    document.querySelectorAll('.btn-shout-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        speechService.primeAudio();
        const text = btn.dataset.shout;
        const type = btn.dataset.type;
        this.handleSendShout(text, type, this.shoutTargetRunnerId);
        uiController.closeQuickShoutModal();
      });
    });

    // 自訂喊話發送
    if (el.btnSendCustomShout && el.inputCustomShout) {
      const sendCustom = () => {
        speechService.primeAudio();
        const text = el.inputCustomShout.value.trim();
        if (text) {
          this.handleSendShout(text, 'custom', this.shoutTargetRunnerId);
          uiController.closeQuickShoutModal();
        } else {
          uiController.showToast('請輸入喊話內容', 'warning');
        }
      };

      el.btnSendCustomShout.addEventListener('click', sendCustom);
      el.inputCustomShout.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          sendCustom();
        }
      });
    }

    // 監聽螢幕點亮或重新回到網頁 (Visibility Change) 即刻恢復在線並補發 GPS
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        console.log('[App] 螢幕重新點亮/回到前台，立即補發在線心跳與 GPS 定位');
        firebaseService.sendHeartbeat();
        if (this.latestSelfCoords) {
          this.handleLocationUpdate(this.latestSelfCoords);
        }
        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            (pos) => geolocationService.ingestPosition(pos),
            (err) => console.warn('[App] 喚醒 GPS 補發警告:', err),
            { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
          );
        }
      }
    });

    // 頂部小隊管理按鈕 (直接開啟隊長設定彈窗)
    if (el.btnJumpTeam) {
      el.btnJumpTeam.addEventListener('click', () => {
        uiController.openCaptainSettingsModal(this.roomName, this.roomId, this.roomPassword);
      });
    }

    // 退出小隊 (支援頂部狀態列按鈕與底部按鈕)
    const handleLeaveTeamAction = async () => {
      const teamName = this.roomName || '跑友小隊';
      const confirmed = confirm(`確定要退出小隊「${teamName}」嗎？\n退出後將停止 GPS 分享並清除地圖軌跡。`);
      if (!confirmed) return;

      uiController.showToast('正在退出小隊...', 'info');
      geolocationService.stopTracking();
      backgroundTrackingService.stop();
      uiController.updateWakelockSwitchUI(false);
      try {
        await firebaseService.leaveRoom();
      } catch (e) {
        console.warn('退出房間出錯:', e);
      }

      // 產生隨機小隊代碼：3 個大寫英文字母加上 3 個數字 (如 ABC-123, ZZZ-456)
      const newRandomRoom = generateRandomRoomCode();
      this.roomId = newRandomRoom;
      this.roomName = '跑友即時小隊';
      this.roomPassword = null;
      this.hasRoomPassword = false;
      this.captainId = null;
      this.selfRunner.isCaptain = true; // 隨機新房間的第一人自動成為隊長

      // 標記為未加入狀態並儲存新隨機代碼至本機
      localStorage.setItem('runner_gps_room_id', this.roomId);
      localStorage.setItem('runner_gps_room_name', this.roomName);
      localStorage.setItem('runner_gps_has_joined', 'false');

      // 清除本地跑友暫存與地圖標記
      this.cachedRunners.clear();
      this.latestSelfCoords = null;
      if (mapRenderer && mapRenderer.runners) {
        mapRenderer.clearAllRunners(false);
      }
      uiController.clearRunners(false);
      uiController.refreshDashboard(null, null, false, null);
      uiController.renderRoomDetails(this.roomId, this.roomName, this.hasRoomPassword);
      uiController.updateRole(this.selfRunner.isCaptain);

      // 清除網址上的房間與密碼參數
      const cleanUrl = new URL(window.location.origin + window.location.pathname);
      window.history.replaceState({}, '', cleanUrl.toString());

      // 自動開啟小隊設定彈窗，顯示新的隨機小隊代碼供使用者確認或修改
      uiController.openCaptainSettingsModal(this.roomName, this.roomId, this.roomPassword, this.selfRunner, true);
      uiController.showToast(`已退出小隊！新隨機小隊代碼已生成：[${this.roomId}]`, 'success');
    };

    const btnHeaderLeave = document.getElementById('btn-header-leave-team');
    if (btnHeaderLeave) {
      btnHeaderLeave.addEventListener('click', handleLeaveTeamAction);
    }
    if (el.btnLeaveTeam) {
      el.btnLeaveTeam.addEventListener('click', handleLeaveTeamAction);
    }
    if (el.btnSettingsLeaveTeam) {
      el.btnSettingsLeaveTeam.addEventListener('click', () => {
        uiController.closeCaptainSettingsModal();
        handleLeaveTeamAction();
      });
    }

    // 設定 Modal
    if (el.btnToggleSettings) {
      el.btnToggleSettings.addEventListener('click', () => {
        this.prefillSettings();
        uiController.toggleSettingsModal(true);
      });
    }
    if (el.btnCloseSettings) {
      el.btnCloseSettings.addEventListener('click', () => uiController.toggleSettingsModal(false));
    }
    if (el.btnSaveSettings) {
      el.btnSaveSettings.addEventListener('click', () => this.saveSettings());
    }
  }

  /**
   * 隊友儲存自訂暱稱與頭像
   */
  async handleSaveCustomNickname() {
    const el = uiController.elements;
    const rawName = el.inputCustomNickname ? el.inputCustomNickname.value : '';
    const newName = sanitizeRunnerName(rawName, this.selfRunner.name || '熱血跑友');

    this.selfRunner.name = newName;
    this.saveProfile();

    // 更新即時動態條
    uiController.updateSelfStrip(this.selfRunner);

    // 若地圖與服務已啟動，即刻同步到 Firebase 與地圖 Marker
    if (this.latestSelfCoords) {
      const updatedData = {
        ...this.selfRunner,
        lat: this.latestSelfCoords.lat,
        lng: this.latestSelfCoords.lng,
        speed: this.latestSelfCoords.speed,
        heading: this.latestSelfCoords.heading,
        totalDistanceMeters: this.latestSelfCoords.totalDistanceMeters || 0,
        isOnline: true,
        updatedAt: Date.now()
      };
      mapRenderer.updateRunner(this.selfRunner.id, updatedData, true);
      uiController.upsertRunner(this.selfRunner.id, updatedData, (id, r) => {
        mapRenderer.panTo(r.lat, r.lng, 17);
      });
    }

    try {
      await firebaseService.joinRoom(this.roomId, this.selfRunner);
      uiController.showToast(`✅ 個人暱稱已儲存為「${this.selfRunner.name}」，下次直接套用！`, 'success');
    } catch (e) {
      console.warn('[App] 同步個人暱稱至雲端失敗:', e);
      uiController.showToast(`✅ 個人暱稱已儲存為「${this.selfRunner.name}」，下次直接套用！`, 'success');
    }

    uiController.closeNicknameModal();
  }

  /**
   * 隊長儲存小隊權限設定 (名稱、代碼、密碼) - 嚴格限制僅隊長可執行
   */
  async handleSaveCaptainSettings() {
    if (!this.selfRunner || !this.selfRunner.isCaptain) {
      uiController.showToast('⚠️ 只有小隊隊長有權修改小隊房間設定！隊員僅可更改個人跑友名片', 'warning');
      return;
    }

    const el = uiController.elements;
    const rawName = el.inputCaptainTeamName ? el.inputCaptainTeamName.value : '';
    const rawCode = el.inputCaptainTeamCode ? el.inputCaptainTeamCode.value : '';
    const rawPwd = el.inputCaptainTeamPwd ? el.inputCaptainTeamPwd.value : '';

    const newName = sanitizeRoomName(rawName, '跑友即時小隊');
    const newCode = validateAndSanitizeRoomId(rawCode);
    const newPwd = sanitizeRoomPassword(rawPwd);

    if (!newCode) {
      uiController.showToast('小隊代碼格式不符 (3~32位英數字)', 'error');
      return;
    }

    const isCodeChanged = newCode !== this.roomId;
    this.roomName = newName;
    this.roomPassword = newPwd;
    this.hasRoomPassword = !!newPwd;
    localStorage.setItem('runner_gps_room_name', this.roomName);
    localStorage.setItem('runner_gps_room_id', newCode);

    if (isCodeChanged) {
      // 若代碼變更，遷移至新房間
      uiController.showToast(`正在切換至新小隊房間 [${newCode}]...`, 'info');
      await firebaseService.leaveRoom();

      // 清除舊房間的隊友（地圖 Marker + 排行榜清單），只保留自己
      mapRenderer.clearAllRunners(true);
      uiController.clearRunners(true);

      this.roomId = newCode;
      const joinRes = await firebaseService.verifyAndJoinRoom(
        this.roomId,
        this.roomName,
        this.roomPassword,
        this.selfRunner
      );
      if (joinRes.roomName && joinRes.roomName !== '跑友即時小隊') {
        this.roomName = joinRes.roomName;
        localStorage.setItem('runner_gps_room_name', this.roomName);
      }
      this.subscribeRoomRunners();
    } else {
      // 僅更新目前房間設定
      await firebaseService.updateRoomMetadata(this.roomId, this.roomName, this.roomPassword);
    }

    // 更新網址 Query String
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('room', this.roomId);
    if (this.roomPassword) {
      newUrl.searchParams.set('pwd', this.roomPassword);
    } else {
      newUrl.searchParams.delete('pwd');
    }
    window.history.replaceState({}, '', newUrl.toString());

    uiController.renderRoomDetails(this.roomId, this.roomName, this.hasRoomPassword);
    uiController.refreshDashboard(
      (id, r) => this.handleFocusRunner(id, r),
      (id, r) => this.handleKickRunner(id, r),
      this.selfRunner.isCaptain
    );
    uiController.closeCaptainSettingsModal();
    uiController.showToast(`✅ 小隊設定已更新生效！[${this.roomName} · ${this.roomId}]`, 'success');
  }

  /**
   * 在綜合設定彈窗中儲存個人暱稱、頭像與代表色
   */
  async handleSaveSettingsRunnerProfile() {
    const el = uiController.elements;
    const rawName = el.settingsRunnerName ? el.settingsRunnerName.value : '';
    const newName = sanitizeRunnerName(rawName, this.selfRunner.name || '熱血跑友');

    this.selfRunner.name = newName;
    this.saveProfile();
    uiController.updateSelfStrip(this.selfRunner);

    if (this.latestSelfCoords) {
      const updatedData = {
        ...this.selfRunner,
        lat: this.latestSelfCoords.lat,
        lng: this.latestSelfCoords.lng,
        speed: this.latestSelfCoords.speed,
        heading: this.latestSelfCoords.heading,
        totalDistanceMeters: this.latestSelfCoords.totalDistanceMeters || 0,
        isOnline: true,
        updatedAt: Date.now()
      };
      mapRenderer.updateRunner(this.selfRunner.id, updatedData, true);
      uiController.upsertRunner(
        this.selfRunner.id,
        updatedData,
        (id, r) => this.handleFocusRunner(id, r),
        (id, r) => this.handleKickRunner(id, r),
        this.selfRunner.isCaptain,
        this.captainId
      );
    }

    try {
      await firebaseService.joinRoom(this.roomId, this.selfRunner);
      uiController.showToast(`✅ 個人暱稱已儲存為「${this.selfRunner.name}」，下次直接套用！`, 'success');
    } catch (e) {
      console.warn('[App] 更新個人資料至雲端警告:', e);
      uiController.showToast(`✅ 個人暱稱已儲存為「${this.selfRunner.name}」，下次直接套用！`, 'success');
    }
  }

  /**
   * 清除應用程式所有快取檔案、Cookie 與本地暫存並重整
   * 智慧保留使用者設定的專屬個人暱稱，確保重整後下次直接套用
   */
  async clearAppCacheAndCookies() {
    const confirmed = confirm(
      '⚠️ 清除快取確認：\n\n這將會清除本程式在瀏覽器中的所有快取檔案、Cookie、房間小隊紀錄並重新載入最新版本。\n您的個人專屬暱稱會完整保留，下次開啟依然直接套用。\n\n確定要立即清除並重整嗎？'
    );
    if (!confirmed) return;

    uiController.showToast('🧹 正在清除快取與 Cookie (保留個人暱稱)...', 'info');

    try {
      // 備份個人專屬暱稱與頭像色彩設定
      const savedNickname = localStorage.getItem('runner_gps_saved_nickname') || this.selfRunner?.name;
      const savedAvatar = localStorage.getItem('runner_gps_saved_avatar') || this.selfRunner?.avatar;
      const savedColor = localStorage.getItem('runner_gps_saved_color') || this.selfRunner?.color;

      // 1. 清除 LocalStorage
      localStorage.clear();

      // 2. 清除 SessionStorage
      sessionStorage.clear();

      // 3. 還原個人專屬暱稱設定，重整後下次直接套用
      if (savedNickname) localStorage.setItem('runner_gps_saved_nickname', savedNickname);
      if (savedAvatar) localStorage.setItem('runner_gps_saved_avatar', savedAvatar);
      if (savedColor) localStorage.setItem('runner_gps_saved_color', savedColor);

      // 3. 清除所有 Cookies
      const cookies = document.cookie.split(';');
      for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i];
        const eqPos = cookie.indexOf('=');
        const name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
        if (name) {
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=${window.location.hostname}`;
        }
      }

      // 4. 清除 CacheStorage API
      if (typeof window !== 'undefined' && 'caches' in window) {
        const cacheKeys = await window.caches.keys();
        await Promise.all(cacheKeys.map(key => window.caches.delete(key)));
      }

      // 5. 註銷 Service Workers
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const reg of registrations) {
          await reg.unregister();
        }
      }
    } catch (err) {
      console.warn('[App] 清除快取部分過程警告:', err);
    }

    // 6. 強制無快取重新載入網頁
    setTimeout(() => {
      const cleanUrl = window.location.origin + window.location.pathname + '?nocache=' + Date.now();
      window.location.replace(cleanUrl);
    }, 400);
  }

  async handleConfirmJoin() {
    const el = uiController.elements;
    const rawName = el.inputRunnerName ? el.inputRunnerName.value : '';
    const rawRoom = el.inputRoomId ? el.inputRoomId.value : '';
    const rawRoomName = el.inputRoomName ? el.inputRoomName.value : '';
    const rawRoomPwd = el.inputRoomPassword ? el.inputRoomPassword.value : '';

    this.selfRunner.name = sanitizeRunnerName(rawName, '小明隊長');
    const validatedRoom = validateAndSanitizeRoomId(rawRoom);

    if (!validatedRoom) {
      uiController.showToast('隊伍房間 ID 格式不符 (3~32位英數字)', 'error');
      return;
    }

    this.roomId = validatedRoom;
    localStorage.setItem('runner_gps_room_id', this.roomId);
    if (rawRoomName && rawRoomName.trim()) {
      this.roomName = sanitizeRoomName(rawRoomName, '跑友即時小隊');
      localStorage.setItem('runner_gps_room_name', this.roomName);
    } else {
      this.roomName = sanitizeRoomName(rawRoomName, this.roomName || '跑友即時小隊');
    }
    this.roomPassword = sanitizeRoomPassword(rawRoomPwd);
    this.hasRoomPassword = !!this.roomPassword;

    // 標記為已確認加入小隊
    localStorage.setItem('runner_gps_has_joined', 'true');
    this.saveProfile();
    uiController.renderRoomDetails(this.roomId, this.roomName, this.hasRoomPassword);
    uiController.setSelfRunnerId(this.selfRunner.id);
    mapRenderer.setSelfRunnerId(this.selfRunner.id);

    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('room', this.roomId);
    if (this.roomPassword) {
      newUrl.searchParams.set('pwd', this.roomPassword);
    } else {
      newUrl.searchParams.delete('pwd');
    }
    window.history.replaceState({}, '', newUrl.toString());

    uiController.toggleJoinModal(false);
    await this.startServices();
  }

  async startServices() {
    // 1. 初始化 Google Maps
    try {
      await mapRenderer.loadGoogleMaps(this.config.googleMapsApiKey);
      mapRenderer.initMap('map', this.config.mapDefaults);
    } catch (err) {
      uiController.showToast(err.message, 'error');
    }

    // 2. 驗證房間密碼並加入 Firebase Realtime Database
    const fbReady = firebaseService.init(this.config.firebase);
    if (fbReady) {
      try {
        const joinRes = await firebaseService.verifyAndJoinRoom(
          this.roomId,
          this.roomName,
          this.roomPassword,
          this.selfRunner
        );

        // 同步已通過驗證之身分識別碼 (UID)
        uiController.setSelfRunnerId(this.selfRunner.id);
        mapRenderer.setSelfRunnerId(this.selfRunner.id);

        if (!joinRes.success && joinRes.reason === 'WRONG_PASSWORD') {
          // 密碼錯誤或需要密碼，彈出密碼輸入彈窗
          uiController.openPasswordModal(
            joinRes.roomName,
            async (inputPwd) => {
              this.roomPassword = sanitizeRoomPassword(inputPwd);
              const retryRes = await firebaseService.verifyAndJoinRoom(
                this.roomId,
                this.roomName,
                this.roomPassword,
                this.selfRunner
              );
              if (retryRes.success) {
                uiController.closePasswordModal();
                uiController.setSelfRunnerId(this.selfRunner.id);
                mapRenderer.setSelfRunnerId(this.selfRunner.id);
                this.roomName = retryRes.roomName || this.roomName;
                this.hasRoomPassword = retryRes.hasPassword;
                if (retryRes.captainId) {
                  this.captainId = retryRes.captainId;
                  this.selfRunner.isCaptain = !!retryRes.isCaptain;
                  this.saveProfile();
                  uiController.updateRole(this.selfRunner.isCaptain);
                  uiController.updateSelfStrip(this.selfRunner);
                }
                uiController.renderRoomDetails(this.roomId, this.roomName, this.hasRoomPassword);
                uiController.showToast(`密碼正確！已進入 [${this.roomName}]`, 'success');
                this.subscribeRoomRunners();
              } else {
                uiController.showPasswordError('密碼錯誤，請重新確認！');
              }
            },
            () => {
              uiController.showToast('已取消加入受保護小隊', 'info');
            }
          );
          return;
        }

        if (joinRes.roomName && joinRes.roomName !== '跑友即時小隊') {
          this.roomName = joinRes.roomName;
          localStorage.setItem('runner_gps_room_name', this.roomName);
        } else if (this.roomName && this.roomName !== '跑友即時小隊') {
          // 若本機有自訂名稱，但 Firebase 還是預設名稱，立即同步至 Firebase
          await firebaseService.updateRoomMetadata(this.roomId, this.roomName, this.roomPassword);
        }
        if (joinRes.captainId) {
          this.captainId = joinRes.captainId;
          this.selfRunner.isCaptain = !!joinRes.isCaptain;
          this.saveProfile();
          uiController.updateRole(this.selfRunner.isCaptain);
          uiController.updateSelfStrip(this.selfRunner);
        }
        this.hasRoomPassword = joinRes.hasPassword;
        uiController.renderRoomDetails(this.roomId, this.roomName, this.hasRoomPassword);
        uiController.showToast(`已成功加入小隊 [${this.roomName}]`, 'success');

        this.subscribeRoomRunners();
      } catch (err) {
        console.error('[App] Firebase 加入房間失敗:', err);
      }
    }

    // 3. 自動啟動 GPS 追蹤
    this.startTracking();

    // 4. 啟動在線心跳與「離線 3 分鐘自動退出小隊」定期清理機制
    this.startHeartbeatAndSweep();
  }

  /**
   * 啟動在線心跳包與離線 3 分鐘自動清理排程
   */
  startHeartbeatAndSweep() {
    // 清除舊定時器
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.offlineSweepTimer) clearInterval(this.offlineSweepTimer);

    // 每 25 秒發送一次心跳包，維持線上活躍狀態與最新電量
    this.heartbeatTimer = setInterval(() => {
      firebaseService.sendHeartbeat(batteryService.level);
    }, 25000);

    // 每 15 秒掃描一次小隊成員，若有人離線超過 3 分鐘 (180,000 ms) 自動移出小隊
    this.offlineSweepTimer = setInterval(() => {
      this.checkOfflineRunnersSweep();
    }, 15000);
  }

  /**
   * 檢查並自動移出離線超過 3 分鐘的跑友
   */
  checkOfflineRunnersSweep() {
    const now = Date.now();
    const THREE_MINUTES_MS = 3 * 60 * 1000; // 3 分鐘

    for (const [runnerId, runner] of this.cachedRunners.entries()) {
      if (runnerId === this.selfRunner.id) continue;

      const lastActive = runner.updatedAt || runner.lastSeen || runner.joinedAt || 0;
      const isOverdue = (now - lastActive) > THREE_MINUTES_MS;
      const isOfflineTimeout = (runner.isOnline === false) && ((now - (runner.lastSeen || lastActive)) > THREE_MINUTES_MS);

      if (isOverdue || isOfflineTimeout) {
        console.log(`[App] 跑友 ${runner.name} (${runnerId}) 已離線超過 3 分鐘，自動退出隊伍`);
        
        // 若自己是隊長，自 Firebase Realtime Database 移除該節點
        if (this.selfRunner && this.selfRunner.isCaptain) {
          firebaseService.kickRunner(this.roomId, runnerId);
        } else {
          // 一般隊友端本機立即移除
          this.handleRunnerRemoved(runnerId);
        }

        uiController.showToast(`跑友「${runner.name || '跑友'}」離線已滿 3 分鐘，已自動移出小隊`, 'info');
      }
    }
  }

  subscribeRoomRunners() {
    // 監聽小隊跑友位置與狀態
    firebaseService.subscribeToRoom(
      this.roomId,
      (runnerId, runnerData) => {
        this.handleRunnerUpdated(runnerId, runnerData);
      },
      (runnerId) => {
        this.handleRunnerRemoved(runnerId);
      }
    );

    // 監聽小隊名稱、密碼與隊長身份變更 (全體跑友同步更新)
    firebaseService.subscribeToRoomMetadata(this.roomId, (meta) => {
      if (meta) {
        if (meta.name) {
          this.roomName = meta.name;
          this.hasRoomPassword = !!meta.hasPassword;
          localStorage.setItem('runner_gps_room_name', this.roomName);
          uiController.renderRoomDetails(this.roomId, this.roomName, this.hasRoomPassword);
        }
        if (meta.captainId) {
          this.captainId = meta.captainId;
          const wasCaptain = this.selfRunner.isCaptain;
          const nowCaptain = (this.selfRunner.id === meta.captainId);
          this.selfRunner.isCaptain = nowCaptain;
          this.saveProfile();
          if (wasCaptain !== nowCaptain) {
            uiController.showToast(nowCaptain ? '👑 您已成為本小隊隊長！' : '🏃 您目前為小隊隊友', 'info');
          }
          uiController.updateRole(this.selfRunner.isCaptain);
          uiController.updateSelfStrip(this.selfRunner);
          uiController.refreshDashboard(
            (id, r) => this.handleFocusRunner(id, r),
            (id, r) => this.handleKickRunner(id, r),
            this.selfRunner.isCaptain,
            this.captainId
          );
        }
      }
    });
  }

  startTracking() {
    this.isTracking = true;

    // 啟動關屏背景保活與 GPS 脈衝 (支援手機螢幕物理關閉後持續在背景定位)
    backgroundTrackingService.start((pos) => {
      geolocationService.ingestPosition(pos);
    });
    uiController.updateWakelockSwitchUI(true);

    geolocationService.startTracking(
      this.config.geolocation,
      (coordsData) => {
        this.handleLocationUpdate(coordsData);
      },
      (error) => {
        console.warn('[App] GPS 定位獲取中或受限，啟動桌機平滑模擬:', error.message);
        // 若在室內電腦無 GPS，自動開啟模擬跑步確保畫面運作流暢
        if (!this.latestSelfCoords) {
          geolocationService.startMockTracking(
            this.config.mapDefaults.lat,
            this.config.mapDefaults.lng,
            (coords) => this.handleLocationUpdate(coords)
          );
        }
      }
    );
  }

  handleLocationUpdate(coordsData) {
    this.latestSelfCoords = coordsData;
    const batteryInfo = batteryService.getBatteryInfo();
    const batteryLevel = batteryInfo.level;

    const selfData = {
      ...this.selfRunner,
      lat: coordsData.lat,
      lng: coordsData.lng,
      accuracy: coordsData.accuracy,
      speed: coordsData.speed,
      heading: coordsData.heading,
      totalDistanceMeters: coordsData.totalDistanceMeters || 0,
      battery: batteryLevel,
      isOnline: true,
      updatedAt: Date.now()
    };

    // 本機 Optimistic UI 零延遲更新
    mapRenderer.updateRunner(this.selfRunner.id, selfData, true);
    uiController.upsertRunner(
      this.selfRunner.id,
      selfData,
      (id, r) => this.handleFocusRunner(id, r),
      (id, r) => this.handleKickRunner(id, r),
      this.selfRunner.isCaptain,
      this.captainId,
      (id, r) => this.openShoutForRunner(id, r)
    );
    uiController.updateSelfStrip(selfData);

    if (!this.hasInitiallyCentered) {
      mapRenderer.panTo(coordsData.lat, coordsData.lng, 16);
      this.hasInitiallyCentered = true;
    }

    // 推送至 Firebase
    firebaseService.updateLocation({
      ...coordsData,
      battery: batteryLevel
    });
  }

  handleRunnerUpdated(runnerId, runnerData) {
    this.cachedRunners.set(runnerId, runnerData);
    const isSelf = runnerId === this.selfRunner.id;

    // 處理最新喊話 (雙重保證：叮咚鈴聲 + 語音朗讀、震動與地圖氣泡)
    if (runnerData.latestShout && runnerData.latestShout.text) {
      const shout = runnerData.latestShout;
      const shoutId = shout.id || `${shout.localTimestamp || shout.timestamp}_${shout.text}`;
      const lastId = this.lastProcessedShouts.get(runnerId);
      const shoutTime = shout.localTimestamp || shout.timestamp || 0;

      // 檢查是否為新抵達的喊話 (利用 unique shoutId，避免受手機與主機之間的時間差影響)
      const isNewShout = shoutId && shoutId !== lastId;
      // 若是剛進入房間看到 45 秒前的歷史喊話則不朗讀，避免剛進房被轟炸
      const isNotExpired = !shoutTime || Math.abs(Date.now() - shoutTime) < 45000;

      if (isNewShout && isNotExpired) {
        this.lastProcessedShouts.set(runnerId, shoutId);

        if (!isSelf) {
          // 1. 播放叮咚鈴聲與語音朗讀 (Android 深度優化版)
          speechService.speak(shout.text, runnerData.name);
          // 2. 觸覺震動
          speechService.vibrate([120, 60, 120]);
          // 3. 頂部 Toast 提示
          uiController.showToast(`💬 ${runnerData.name}：${shout.text}`, 'info');
        }

        // 4. 在地圖該跑友標記上方彈出動態氣泡 (泡泡)
        mapRenderer.showShoutBubble(runnerId, shout.text, runnerData.avatar);
      }
    }

    mapRenderer.updateRunner(runnerId, runnerData, isSelf);
    uiController.upsertRunner(
      runnerId,
      runnerData,
      (id, r) => this.handleFocusRunner(id, r),
      (id, r) => this.handleKickRunner(id, r),
      this.selfRunner.isCaptain,
      this.captainId,
      (id, r) => this.openShoutForRunner(id, r)
    );

    if (isSelf) {
      uiController.updateSelfStrip(runnerData);
    }
  }

  /**
   * 發送一鍵快捷語音/泡泡喊話
   */
  async handleSendShout(text, type = 'cheer', targetRunnerId = null) {
    if (!text) return;
    speechService.primeAudio();
    const success = await firebaseService.sendQuickShout(text, type, targetRunnerId);
    if (success) {
      mapRenderer.showShoutBubble(this.selfRunner.id, text, this.selfRunner.avatar);
      uiController.showToast(`💬 您已廣播喊話：「${text}」`, 'success');
      speechService.vibrate([80]);
    } else {
      uiController.showToast('發送失敗，請確認網路連線', 'error');
    }
  }

  /**
   * 對特定隊友開啟喊話對話視窗
   */
  openShoutForRunner(runnerId, runner) {
    speechService.primeAudio();
    this.shoutTargetRunnerId = runnerId;
    uiController.openQuickShoutModal(runner);
  }

  handleRunnerRemoved(runnerId) {
    this.cachedRunners.delete(runnerId);
    
    // 若自己被隊長移出小隊
    if (runnerId === this.selfRunner.id) {
      geolocationService.stopTracking();
      backgroundTrackingService.stop();
      uiController.updateWakelockSwitchUI(false);

      // 隨機生成 3 個大寫英文字母加上 3 個數字代碼 (如 ABC-123)
      const newRandomRoom = generateRandomRoomCode();
      this.roomId = newRandomRoom;
      this.roomName = '跑友即時小隊';
      this.roomPassword = null;
      this.hasRoomPassword = false;
      this.captainId = null;
      this.selfRunner.isCaptain = true;

      // 標記為未加入狀態並儲存新隨機代碼至本機
      localStorage.setItem('runner_gps_room_id', this.roomId);
      localStorage.setItem('runner_gps_room_name', this.roomName);
      localStorage.setItem('runner_gps_has_joined', 'false');

      // 清除本地跑友暫存與地圖標記
      this.cachedRunners.clear();
      this.latestSelfCoords = null;
      if (mapRenderer && mapRenderer.runners) {
        mapRenderer.clearAllRunners(false);
      }
      uiController.clearRunners(false);
      uiController.refreshDashboard(null, null, false, null);
      uiController.renderRoomDetails(this.roomId, this.roomName, this.hasRoomPassword);
      uiController.updateRole(this.selfRunner.isCaptain);

      // 清除網址參數
      const cleanUrl = new URL(window.location.origin + window.location.pathname);
      window.history.replaceState({}, '', cleanUrl.toString());

      uiController.showToast(`⚠️ 您已被隊長移出小隊，已為您隨機生成新代碼 [${this.roomId}]！`, 'error');

      // 自動開啟小隊設定彈窗
      setTimeout(() => {
        uiController.openCaptainSettingsModal(this.roomName, this.roomId, this.roomPassword, this.selfRunner, true);
      }, 800);
      return;
    }

    mapRenderer.removeRunner(runnerId);
    uiController.removeRunner(
      runnerId,
      (id, r) => this.handleFocusRunner(id, r),
      (id, r) => this.handleKickRunner(id, r),
      this.selfRunner.isCaptain,
      this.captainId
    );
  }

  /**
   * 點選隊友卡片：將隊友平滑移至地圖正中央，並自動滑動手機視角至地圖
   */
  handleFocusRunner(runnerId, runner) {
    const runnerName = runner.name || '跑友';

    // 1. 嘗試透過地圖專屬聚焦 (包含標記跳動動畫與彈出即時氣泡)
    const focused = mapRenderer.focusRunner(runnerId);

    // 若尚未生成 marker，直接透過經緯度平滑聚焦
    if (!focused) {
      const lat = runner.lat || (this.latestSelfCoords ? this.latestSelfCoords.lat : null);
      const lng = runner.lng || (this.latestSelfCoords ? this.latestSelfCoords.lng : null);
      if (lat && lng) {
        mapRenderer.panTo(lat, lng, 17);
      }
    }

    // 2. 在手機螢幕上，自動平滑滾動畫面回到頂部地圖，讓使用者清楚看見隊友
    const mapElement = document.getElementById('map');
    if (mapElement) {
      mapElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    uiController.showToast(`🎯 已將「${runnerName}」移至地圖正中央！`, 'success');
  }

  /**
   * 隊長移出/刪除隊友
   */
  async handleKickRunner(runnerId, runner) {
    if (!this.selfRunner.isCaptain) {
      uiController.showToast('只有隊長有權限移出隊友', 'warning');
      return;
    }

    const runnerName = runner.name || '此跑友';
    const confirmed = confirm(`👑 隊長權限確認：\n確定要將「${runnerName}」移出小隊嗎？`);
    if (!confirmed) return;

    try {
      await firebaseService.kickRunner(this.roomId, runnerId);
      uiController.showToast(`已成功將「${runnerName}」移出小隊`, 'success');
    } catch (err) {
      console.error('[App] 移出隊友出錯:', err);
      uiController.showToast('移出隊友失敗，請重試', 'error');
    }
  }

  showInviteModal() {
    const inviteUrl = new URL(window.location.origin + window.location.pathname);
    inviteUrl.searchParams.set('room', this.roomId);
    if (this.roomPassword) {
      // 產生的連結包含房間代碼
      inviteUrl.searchParams.set('pwd', this.roomPassword);
    }
    uiController.openInviteModal(inviteUrl.toString(), this.roomId, this.roomName, this.roomPassword);
  }

  async copyInviteUrl() {
    const inviteUrl = new URL(window.location.origin + window.location.pathname);
    inviteUrl.searchParams.set('room', this.roomId);
    if (this.roomPassword) {
      inviteUrl.searchParams.set('pwd', this.roomPassword);
    }
    try {
      await navigator.clipboard.writeText(inviteUrl.toString());
      uiController.showToast('邀請連結已複製！隊友點開可自動帶入密碼加入', 'success');
    } catch (e) {
      uiController.showToast(`邀請網址: ${inviteUrl.toString()}`, 'info');
    }
  }

  prefillSettings() {
    const el = uiController.elements;
    if (el.inputGoogleKey) el.inputGoogleKey.value = this.config.googleMapsApiKey || '';
    if (el.inputFirebaseDbUrl) el.inputFirebaseDbUrl.value = this.config.firebase.databaseURL || '';
    if (el.inputFirebaseApiKey) el.inputFirebaseApiKey.value = this.config.firebase.apiKey || '';
  }

  saveSettings() {
    const el = uiController.elements;
    const newConfig = {
      googleMapsApiKey: el.inputGoogleKey.value.trim(),
      firebase: {
        ...this.config.firebase,
        apiKey: el.inputFirebaseApiKey.value.trim(),
        databaseURL: el.inputFirebaseDbUrl.value.trim()
      }
    };
    saveCustomConfig(newConfig);
    uiController.showToast('設定已儲存，正在重新整理...', 'success');
    setTimeout(() => window.location.reload(), 600);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
