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
  generateSafeRunnerId,
  sanitizeRunnerName,
  sanitizeRoomName,
  sanitizeRoomPassword,
  sanitizeColor,
  getSafeURLParam
} from './security.js';
import { firebaseService } from './services/firebase-service.js';
import { geolocationService } from './services/geolocation-service.js';
import { mapRenderer } from './components/map-renderer.js';
import { uiController } from './components/ui-controller.js';

class App {
  constructor() {
    this.config = getAppConfig();
    this.roomId = 'RUN-888';
    this.roomName = '跑友即時小隊';
    this.roomPassword = null;
    this.hasRoomPassword = false;
    this.selfRunner = null;
    this.isTracking = false;
    this.latestSelfCoords = null;
    this.cachedRunners = new Map();
    this.virtualRunnersInterval = null;
    this.isVirtualMode = false;
    this.heartbeatTimer = null;
    this.offlineSweepTimer = null;
  }

  async init() {
    console.log('[App] 正在啟動跑友即時地圖...');
    uiController.init();
    this.bindEvents();

    // 檢查 URL 房間參數與可能帶入之密碼
    const urlRoom = getSafeURLParam('room');
    const safeUrlRoom = validateAndSanitizeRoomId(urlRoom);
    this.roomId = safeUrlRoom || 'RUN-888';

    const urlPwd = getSafeURLParam('pwd');
    if (urlPwd) {
      this.roomPassword = sanitizeRoomPassword(urlPwd);
    }

    // 若從分享連結開啟，標記為加入的隊友
    this.loadSavedProfile(!!safeUrlRoom && safeUrlRoom !== 'RUN-888');

    uiController.renderRoomDetails(this.roomId, this.roomName, this.hasRoomPassword);
    uiController.setSelfRunnerId(this.selfRunner.id);
    mapRenderer.setSelfRunnerId(this.selfRunner.id);

    // 初始進入主畫面
    uiController.toggleJoinModal(false);
    uiController.togglePocketMode(false);

    await this.startServices();
  }

  loadSavedProfile(isInvitedTeammate = false) {
    try {
      const saved = localStorage.getItem('runner_gps_user_profile');
      if (saved) {
        const parsed = JSON.parse(saved);
        this.selfRunner = {
          id: parsed.id || generateSafeRunnerId(),
          name: sanitizeRunnerName(parsed.name, isInvitedTeammate ? '熱血隊友' : '小明隊長'),
          avatar: parsed.avatar || (isInvitedTeammate ? '🏃‍♀️' : '🏃‍♂️'),
          color: sanitizeColor(parsed.color, '#05D5A4'),
          isCaptain: isInvitedTeammate ? false : (parsed.isCaptain ?? true)
        };
      } else {
        this.selfRunner = {
          id: generateSafeRunnerId(),
          name: isInvitedTeammate ? '熱血隊友' : '小明隊長',
          avatar: isInvitedTeammate ? '🏃‍♀️' : '🏃‍♂️',
          color: '#05D5A4',
          isCaptain: !isInvitedTeammate
        };
        // 第一次透過分享連結加入的隊友，自動提示設定專屬暱稱
        if (isInvitedTeammate) {
          setTimeout(() => {
            uiController.openNicknameModal(this.selfRunner.name, this.selfRunner.avatar, this.selfRunner.color);
          }, 800);
        }
      }
    } catch (e) {
      this.selfRunner = {
        id: generateSafeRunnerId(),
        name: isInvitedTeammate ? '熱血隊友' : '小明隊長',
        avatar: '🏃‍♂️',
        color: '#05D5A4',
        isCaptain: !isInvitedTeammate
      };
    }
  }

  saveProfile() {
    try {
      localStorage.setItem('runner_gps_user_profile', JSON.stringify(this.selfRunner));
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

    // 點擊跑者名稱可修改個人設定
    if (el.stripRunnerName) {
      el.stripRunnerName.style.cursor = 'pointer';
      el.stripRunnerName.title = '點擊修改跑友暱稱與代表色';
      el.stripRunnerName.addEventListener('click', () => {
        uiController.toggleJoinModal(true);
      });
    }

    // 隊長專屬小隊管理彈窗
    if (el.btnOpenCaptainSettings) {
      el.btnOpenCaptainSettings.addEventListener('click', () => {
        uiController.openCaptainSettingsModal(this.roomName, this.roomId, this.roomPassword);
      });
    }
    if (el.btnCloseCaptainSettings) {
      el.btnCloseCaptainSettings.addEventListener('click', () => {
        uiController.closeCaptainSettingsModal();
      });
    }
    if (el.btnCaptainClearPwd) {
      el.btnCaptainClearPwd.addEventListener('click', () => {
        if (el.inputCaptainTeamPwd) el.inputCaptainTeamPwd.value = '';
        uiController.showToast('已清空密碼，儲存後將成為公開小隊', 'info');
      });
    }
    if (el.btnSaveCaptainSettings) {
      el.btnSaveCaptainSettings.addEventListener('click', () => this.handleSaveCaptainSettings());
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

    // 虛擬隊友切換
    if (el.btnToggleVirtual) {
      el.btnToggleVirtual.addEventListener('click', () => this.toggleVirtualRunners());
    }

    // 聚集伴跑隊友
    if (el.btnGatherTeam) {
      el.btnGatherTeam.addEventListener('click', () => this.gatherVirtualRunners());
    }

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
      try {
        await firebaseService.leaveRoom();
      } catch (e) {
        console.warn('退出房間出錯:', e);
      }

      // 清除網址上的房間與密碼參數
      const cleanUrl = new URL(window.location.origin + window.location.pathname);
      window.history.replaceState({}, '', cleanUrl.toString());

      // 清除本機已存的加入設定
      try {
        localStorage.removeItem('runner_gps_user_profile');
      } catch (e) {}

      // 重整回到初始大廳
      setTimeout(() => {
        window.location.reload();
      }, 500);
    };

    const btnHeaderLeave = document.getElementById('btn-header-leave-team');
    if (btnHeaderLeave) {
      btnHeaderLeave.addEventListener('click', handleLeaveTeamAction);
    }
    if (el.btnLeaveTeam) {
      el.btnLeaveTeam.addEventListener('click', handleLeaveTeamAction);
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
      uiController.showToast(`✅ 暱稱已更新為「${this.selfRunner.name}」！`, 'success');
    } catch (e) {
      console.warn('[App] 同步個人暱稱至雲端失敗:', e);
    }

    uiController.closeNicknameModal();
  }

  /**
   * 隊長儲存小隊權限設定 (名稱、代碼、密碼)
   */
  async handleSaveCaptainSettings() {
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

    if (isCodeChanged) {
      // 若代碼變更，遷移至新房間
      await firebaseService.leaveRoom();
      this.roomId = newCode;
      await firebaseService.verifyAndJoinRoom(
        this.roomId,
        this.roomName,
        this.roomPassword,
        this.selfRunner
      );
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
    uiController.closeCaptainSettingsModal();
    uiController.showToast('👑 隊長權限：小隊設定已成功更新！', 'success');
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
    this.roomName = sanitizeRoomName(rawRoomName, '跑友即時小隊');
    this.roomPassword = sanitizeRoomPassword(rawRoomPwd);
    this.hasRoomPassword = !!this.roomPassword;

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
                this.roomName = retryRes.roomName || this.roomName;
                this.hasRoomPassword = retryRes.hasPassword;
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

        this.roomName = joinRes.roomName || this.roomName;
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

    // 每 25 秒發送一次心跳包，維持線上活躍狀態
    this.heartbeatTimer = setInterval(() => {
      firebaseService.sendHeartbeat();
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

    // 監聽小隊名稱與密碼變更 (全體跑友同步更新)
    firebaseService.subscribeToRoomMetadata(this.roomId, (meta) => {
      if (meta && meta.name) {
        this.roomName = meta.name;
        this.hasRoomPassword = !!meta.hasPassword;
        uiController.renderRoomDetails(this.roomId, this.roomName, this.hasRoomPassword);
      }
    });
  }

  startTracking() {
    this.isTracking = true;
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
    const battery = uiController.getBatteryLevel();

    const selfData = {
      ...this.selfRunner,
      lat: coordsData.lat,
      lng: coordsData.lng,
      accuracy: coordsData.accuracy,
      speed: coordsData.speed,
      heading: coordsData.heading,
      totalDistanceMeters: coordsData.totalDistanceMeters || 0,
      battery: battery,
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
      this.selfRunner.isCaptain
    );
    uiController.updateSelfStrip(selfData);

    if (!this.hasInitiallyCentered) {
      mapRenderer.panTo(coordsData.lat, coordsData.lng, 16);
      this.hasInitiallyCentered = true;
    }

    // 推送至 Firebase
    firebaseService.updateLocation({
      ...coordsData,
      battery: battery
    });
  }

  handleRunnerUpdated(runnerId, runnerData) {
    this.cachedRunners.set(runnerId, runnerData);
    const isSelf = runnerId === this.selfRunner.id;
    mapRenderer.updateRunner(runnerId, runnerData, isSelf);
    uiController.upsertRunner(
      runnerId,
      runnerData,
      (id, r) => this.handleFocusRunner(id, r),
      (id, r) => this.handleKickRunner(id, r),
      this.selfRunner.isCaptain
    );

    if (isSelf) {
      uiController.updateSelfStrip(runnerData);
    }
  }

  handleRunnerRemoved(runnerId) {
    this.cachedRunners.delete(runnerId);
    // 若自己被隊長移出小隊或離線超時
    if (runnerId === this.selfRunner.id) {
      geolocationService.stopTracking();
      uiController.showToast('⚠️ 您已離開或被移出小隊', 'warning');
      setTimeout(() => {
        window.location.href = window.location.origin + window.location.pathname;
      }, 1500);
      return;
    }

    mapRenderer.removeRunner(runnerId);
    uiController.removeRunner(
      runnerId,
      (id, r) => this.handleFocusRunner(id, r),
      (id, r) => this.handleKickRunner(id, r),
      this.selfRunner.isCaptain
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

  /**
   * 切換虛擬隊友 (提供無伴時伴跑)
   */
  toggleVirtualRunners() {
    this.isVirtualMode = !this.isVirtualMode;
    const btn = uiController.elements.btnToggleVirtual;
    const tag = uiController.elements.headerModeTag;

    if (this.isVirtualMode) {
      if (btn) btn.textContent = '關閉虛擬隊友';
      if (tag) tag.textContent = '虛擬伴跑模式';
      uiController.showToast('已啟用 2 位虛擬伴跑隊友！', 'success');

      let step = 0;
      const baseLat = this.latestSelfCoords ? this.latestSelfCoords.lat : 25.033964;
      const baseLng = this.latestSelfCoords ? this.latestSelfCoords.lng : 121.564468;

      this.virtualRunnersInterval = setInterval(() => {
        step += 0.05;
        // 伴跑跑友 1: 小華
        const pacer1 = {
          id: 'virtual_runner_1',
          name: '小華 (陪跑員)',
          avatar: '🏃‍♀️',
          color: '#F59E0B',
          lat: baseLat + Math.sin(step) * 0.0015,
          lng: baseLng + Math.cos(step) * 0.0018,
          speed: 2.9, // ~10.4 km/h
          totalDistanceMeters: Math.round(step * 150),
          isOnline: true,
          battery: 92
        };
        // 伴跑跑友 2: 阿強
        const pacer2 = {
          id: 'virtual_runner_2',
          name: '阿強 (破風者)',
          avatar: '⚡',
          color: '#38BDF8',
          lat: baseLat + Math.cos(step * 0.8) * 0.002,
          lng: baseLng + Math.sin(step * 0.8) * 0.0022,
          speed: 3.4, // ~12.2 km/h
          totalDistanceMeters: Math.round(step * 180),
          isOnline: true,
          battery: 85
        };

        this.handleRunnerUpdated(pacer1.id, pacer1);
        this.handleRunnerUpdated(pacer2.id, pacer2);
      }, 2000);
    } else {
      if (btn) btn.textContent = '切為虛擬隊友';
      if (tag) tag.textContent = '純真實模式';
      if (this.virtualRunnersInterval) {
        clearInterval(this.virtualRunnersInterval);
        this.virtualRunnersInterval = null;
      }
      this.handleRunnerRemoved('virtual_runner_1');
      this.handleRunnerRemoved('virtual_runner_2');
      uiController.showToast('已切換回純真實模式', 'info');
    }
  }

  gatherVirtualRunners() {
    if (!this.latestSelfCoords) {
      uiController.showToast('請先確認本機 GPS 訊號', 'warning');
      return;
    }
    uiController.showToast('已將全體隊友位置重設至您的周邊！', 'success');
    mapRenderer.fitAllRunners();
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
