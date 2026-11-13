/**
 * @file ui-controller.js
 * @description UI 控制層：精準對標深藍科技運動風 (Deep Navy Runner UI)
 * 負責排行榜渲染、QR Code 彈窗、螢幕防休眠 (WakeLock)、口袋黑屏 (Pocket Mode) 及數據儀表板更新。
 * 遵循安全規範，全數採用 safe DOM 與 textContent 操作，嚴格杜絕 innerHTML XSS 漏洞。
 */

import { createSafeElement, escapeHTML } from '../security.js';
import { formatPace } from '../services/geolocation-service.js';

class UIController {
  constructor() {
    this.elements = {};
    this.cachedRunners = new Map();
    this.selfRunnerId = null;
    this.wakeLock = null;
    this.batteryLevel = null;
    this.qrCodeInstance = null;
  }

  /**
   * 快取 DOM 元素
   */
  init() {
    this.elements = {
      // 頂部導航
      headerRoomDisplay: document.getElementById('header-room-display'),
      headerLockIcon: document.getElementById('header-lock-icon'),
      headerModeTag: document.getElementById('header-mode-tag'),
      statRealCount: document.getElementById('stat-real-count'),
      statOnlineCount: document.getElementById('stat-online-count'),
      btnTopInvite: document.getElementById('btn-top-invite'),
      btnTopInviteMobile: document.getElementById('btn-top-invite-mobile'),
      btnToggleWakelock: document.getElementById('btn-toggle-wakelock'),
      btnToggleWakelockMobile: document.getElementById('btn-toggle-wakelock-mobile'),
      wakelockBtnText: document.getElementById('wakelock-btn-text'),
      btnPocketMode: document.getElementById('btn-pocket-mode'),
      btnPocketModeMobile: document.getElementById('btn-pocket-mode-mobile'),

      // 跑者狀態條
      roleBadge: document.getElementById('role-badge'),
      stripRunnerAvatar: document.getElementById('strip-runner-avatar'),
      stripRunnerName: document.getElementById('strip-runner-name'),
      btnEditMyNickname: document.getElementById('btn-edit-my-nickname'),
      stripPace: document.getElementById('strip-pace'),
      stripSpeed: document.getElementById('strip-speed'),
      stripRunningPhase: document.getElementById('strip-running-phase'),
      teamRealCount: document.getElementById('team-real-count'),
      btnJumpTeam: document.getElementById('btn-jump-team'),

      // 自訂暱稱彈窗
      nicknameModal: document.getElementById('nickname-modal'),
      btnCloseNicknameModal: document.getElementById('btn-close-nickname-modal'),
      inputCustomNickname: document.getElementById('input-custom-nickname'),
      nicknameAvatarSelector: document.getElementById('nickname-avatar-selector'),
      nicknameColorSelector: document.getElementById('nickname-color-selector'),
      btnSaveNickname: document.getElementById('btn-save-nickname'),

      // 地圖浮動控制
      mapRunnerRatio: document.getElementById('map-runner-ratio'),
      btnMapRoadmap: document.getElementById('btn-map-roadmap'),
      btnMapSatellite: document.getElementById('btn-map-satellite'),
      btnRecenterSelf: document.getElementById('btn-recenter-self'),
      btnFitAll: document.getElementById('btn-fit-all'),
      btnFitCount: document.getElementById('btn-fit-count'),

      // 儀表板與數據
      dashTeamTitle: document.getElementById('dash-team-title'),
      captainBadge: document.getElementById('captain-badge'),
      btnOpenCaptainSettings: document.getElementById('btn-open-captain-settings'),
      dashRoomId: document.getElementById('dash-room-id'),
      dashRealCount: document.getElementById('dash-real-count'),
      dashOnlineCount: document.getElementById('dash-online-count'),
      btnCopyRoom: document.getElementById('btn-copy-room'),
      btnInviteModal: document.getElementById('btn-invite-modal'),
      btnToggleVirtual: document.getElementById('btn-toggle-virtual'),
      statTeamDistance: document.getElementById('stat-team-distance'),
      statActiveRunners: document.getElementById('stat-active-runners'),
      statOnlineNum: document.getElementById('stat-online-num'),
      btnGatherTeam: document.getElementById('btn-gather-team'),
      leaderboardContainer: document.getElementById('leaderboard-container'),
      footerRoomId: document.getElementById('footer-room-id'),
      btnLeaveTeam: document.getElementById('btn-leave-team'),

      // 邀請彈窗
      inviteModal: document.getElementById('invite-modal'),
      qrcodeContainer: document.getElementById('qrcode'),
      inviteRoomNameDisplay: document.getElementById('invite-room-name-display'),
      inviteRoomCode: document.getElementById('invite-room-code'),
      inviteRoomPwdDisplay: document.getElementById('invite-room-pwd-display'),
      btnCopyInviteLink: document.getElementById('btn-copy-invite-link'),
      btnCloseInvite: document.getElementById('btn-close-invite'),

      // 密碼驗證彈窗
      passwordModal: document.getElementById('password-modal'),
      pwdModalRoomName: document.getElementById('pwd-modal-room-name'),
      inputVerifyPassword: document.getElementById('input-verify-password'),
      pwdErrorMsg: document.getElementById('pwd-error-msg'),
      btnConfirmVerifyPwd: document.getElementById('btn-confirm-verify-pwd'),
      btnCancelVerifyPwd: document.getElementById('btn-cancel-verify-pwd'),

      // 隊長專屬設定彈窗 (綜合設定彈窗)
      captainSettingsModal: document.getElementById('captain-settings-modal'),
      btnCloseCaptainSettings: document.getElementById('btn-close-captain-settings'),
      inputCaptainTeamName: document.getElementById('input-captain-team-name'),
      inputCaptainTeamCode: document.getElementById('input-captain-team-code'),
      inputCaptainTeamPwd: document.getElementById('input-captain-team-pwd'),
      btnCaptainClearPwd: document.getElementById('btn-captain-clear-pwd'),
      btnSaveCaptainSettings: document.getElementById('btn-save-captain-settings'),
      settingsTeamPermBadge: document.getElementById('settings-team-perm-badge'),
      settingsTeamTeammateNotice: document.getElementById('settings-team-teammate-notice'),
      btnTopSettings: document.getElementById('btn-top-settings'),
      btnTopSettingsMobile: document.getElementById('btn-top-settings-mobile'),
      btnClearAppCache: document.getElementById('btn-clear-app-cache'),
      btnSettingsSaveProfile: document.getElementById('btn-settings-save-profile'),
      btnSettingsLeaveTeam: document.getElementById('btn-settings-leave-team'),
      settingsRunnerName: document.getElementById('settings-runner-name'),
      settingsAvatarSelector: document.getElementById('settings-avatar-selector'),
      settingsColorSelector: document.getElementById('settings-color-selector'),

      // 口袋黑屏
      pocketBlackScreen: document.getElementById('pocket-black-screen'),

      // 加入房間 Modal
      joinModal: document.getElementById('join-modal'),
      inputRunnerName: document.getElementById('input-runner-name'),
      inputRoomId: document.getElementById('input-room-id'),
      inputRoomName: document.getElementById('input-room-name'),
      inputRoomPassword: document.getElementById('input-room-password'),
      avatarSelector: document.getElementById('avatar-selector'),
      colorSelector: document.getElementById('color-selector'),
      btnConfirmJoin: document.getElementById('btn-confirm-join'),

      // 設定 Modal
      settingsModal: document.getElementById('settings-modal'),
      btnCloseSettings: document.getElementById('btn-close-settings'),
      inputGoogleKey: document.getElementById('input-google-key'),
      inputFirebaseDbUrl: document.getElementById('input-firebase-dburl'),
      inputFirebaseApiKey: document.getElementById('input-firebase-apikey'),
      btnSaveSettings: document.getElementById('btn-save-settings'),

      // Toast 容器
      toastContainer: document.getElementById('toast-container')
    };

    // 初始化裝置電量監聽 (若瀏覽器支援)
    this.initBatteryListener();

    // 啟動螢幕防休眠 (Wake Lock)
    this.requestWakeLock();
  }

  setSelfRunnerId(id) {
    this.selfRunnerId = id;
  }

  /**
   * 取得運動階段與標籤名稱
   */
  getRunningPhase(speedMps) {
    if (!speedMps || speedMps < 0.8) {
      return { text: '狀態: 靜止休整', color: 'text-slate-400', bg: 'bg-slate-700/20', dot: 'bg-slate-400' };
    }
    const kmh = speedMps * 3.6;
    if (kmh < 8.0) {
      return { text: '狀態: 輕鬆慢跑', color: 'text-teal-400', bg: 'bg-teal-500/10', dot: 'bg-teal-400' };
    } else if (kmh < 13.5) {
      return { text: '狀態: 節奏快跑', color: 'text-amber-400', bg: 'bg-amber-500/10', dot: 'bg-amber-400' };
    } else {
      return { text: '狀態: 間歇衝刺', color: 'text-rose-400', bg: 'bg-rose-500/10', dot: 'bg-rose-400' };
    }
  }

  /**
   * 更新自身即時動態條
   */
  updateSelfStrip(runnerData) {
    if (this.elements.stripRunnerName && runnerData.name) {
      this.elements.stripRunnerName.textContent = runnerData.name;
    }
    if (this.elements.stripRunnerAvatar && runnerData.avatar) {
      this.elements.stripRunnerAvatar.textContent = runnerData.avatar;
    }
    if (this.elements.roleBadge) {
      if (runnerData.isCaptain) {
        this.elements.roleBadge.textContent = '👑 隊長';
        this.elements.roleBadge.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-bold border border-amber-500/40 text-[11px]';
      } else {
        this.elements.roleBadge.textContent = '🏃 隊友';
        this.elements.roleBadge.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-teal-500/20 text-teal-400 font-bold border border-teal-500/40 text-[11px]';
      }
    }

    const speed = runnerData.speed || 0;
    const speedKmh = (speed * 3.6).toFixed(1);
    const paceStr = formatPace(speed);

    if (this.elements.stripPace) {
      this.elements.stripPace.textContent = paceStr.replace(' /km', '');
    }
    if (this.elements.stripSpeed) {
      this.elements.stripSpeed.textContent = `${speedKmh} km/h`;
    }

    const phase = this.getRunningPhase(speed);
    if (this.elements.stripRunningPhase) {
      this.elements.stripRunningPhase.className = `px-2.5 py-0.5 rounded-full ${phase.bg} ${phase.color} border border-amber-500/30 text-[11px] font-medium flex items-center gap-1.5`;
      this.elements.stripRunningPhase.replaceChildren(
        createSafeElement('span', { class: `w-1.5 h-1.5 rounded-full ${phase.dot}` }),
        document.createTextNode(phase.text)
      );
    }
  }

  /**
   * 更新房間 ID 與名稱顯示 (安全防護)
   */
  renderRoomDetails(roomId, roomName, hasPassword = false) {
    const displayName = roomName || '跑友即時小隊';
    if (this.elements.headerRoomDisplay) {
      this.elements.headerRoomDisplay.textContent = `${displayName} (${roomId})`;
    }
    if (this.elements.dashTeamTitle) {
      this.elements.dashTeamTitle.textContent = displayName;
    }
    if (this.elements.headerLockIcon) {
      if (hasPassword) {
        this.elements.headerLockIcon.classList.remove('hidden');
      } else {
        this.elements.headerLockIcon.classList.add('hidden');
      }
    }
    if (this.elements.dashRoomId) this.elements.dashRoomId.textContent = roomId;
    if (this.elements.inviteRoomCode) this.elements.inviteRoomCode.textContent = roomId;
    if (this.elements.footerRoomId) this.elements.footerRoomId.textContent = `${displayName} · ${roomId}`;
  }

  /**
   * 舊相容
   */
  renderRoomId(roomId) {
    this.renderRoomDetails(roomId, null, false);
  }

  /**
   * 更新使用者角色標籤 (隊長 / 隊友)
   */
  updateRole(isCaptain) {
    if (this.elements.roleBadge) {
      if (isCaptain) {
        this.elements.roleBadge.textContent = '👑 隊長';
        this.elements.roleBadge.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-bold border border-amber-500/40 text-[11px]';
      } else {
        this.elements.roleBadge.textContent = '🏃 隊友';
        this.elements.roleBadge.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-teal-500/20 text-teal-400 font-bold border border-teal-500/40 text-[11px]';
      }
    }
    if (this.elements.captainBadge) {
      if (isCaptain) {
        this.elements.captainBadge.textContent = '你是隊長';
        this.elements.captainBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-400 text-slate-950';
      } else {
        this.elements.captainBadge.textContent = '隊友';
        this.elements.captainBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-800 text-teal-400 border border-slate-700';
      }
    }
    const dashPencil = document.getElementById('dash-team-title-pencil');
    if (dashPencil) {
      dashPencil.textContent = isCaptain ? '✏️' : '🔒';
    }
  }

  /**
   * 更新跑友或新增
   */
  upsertRunner(runnerId, runnerData, onFocusRunner, onKickRunner = null, isCaptain = false, captainId = null) {
    this.cachedRunners.set(runnerId, runnerData);
    this.refreshDashboard(onFocusRunner, onKickRunner, isCaptain, captainId);
  }

  removeRunner(runnerId, onFocusRunner, onKickRunner = null, isCaptain = false, captainId = null) {
    this.cachedRunners.delete(runnerId);
    this.refreshDashboard(onFocusRunner, onKickRunner, isCaptain, captainId);
  }

  /**
   * 清除跑友清單快取 (例如切換小隊房間時)
   * @param {boolean} keepSelf 是否保留自身
   */
  clearRunners(keepSelf = false) {
    if (keepSelf && this.selfRunnerId && this.cachedRunners.has(this.selfRunnerId)) {
      const selfData = this.cachedRunners.get(this.selfRunnerId);
      this.cachedRunners.clear();
      this.cachedRunners.set(this.selfRunnerId, selfData);
    } else {
      this.cachedRunners.clear();
    }
  }

  /**
   * 刷新排行榜與三大統計數據卡片 (安全 DOM 渲染)
   */
  refreshDashboard(onFocusRunner, onKickRunner = null, isCaptain = false, captainId = null) {
    const list = Array.from(this.cachedRunners.entries());
    const totalCount = list.length;
    const onlineCount = list.filter(([_, r]) => r.isOnline !== false).length;

    // 更新計數標籤
    if (this.elements.statRealCount) this.elements.statRealCount.textContent = totalCount.toString();
    if (this.elements.statOnlineCount) this.elements.statOnlineCount.textContent = onlineCount.toString();
    if (this.elements.teamRealCount) this.elements.teamRealCount.textContent = totalCount.toString();
    if (this.elements.dashRealCount) this.elements.dashRealCount.textContent = totalCount.toString();
    if (this.elements.dashOnlineCount) this.elements.dashOnlineCount.textContent = onlineCount.toString();
    if (this.elements.mapRunnerRatio) this.elements.mapRunnerRatio.textContent = `${onlineCount} / 10`;
    if (this.elements.statOnlineNum) this.elements.statOnlineNum.textContent = onlineCount.toString();
    if (this.elements.btnFitCount) this.elements.btnFitCount.textContent = onlineCount.toString();
    if (this.elements.statActiveRunners) this.elements.statActiveRunners.textContent = `${onlineCount} 人`;

    // 計算團隊總累積里程
    let teamDist = 0;
    list.forEach(([_, r]) => {
      teamDist += (r.totalDistanceMeters || 0);
    });
    const teamKm = (teamDist / 1000).toFixed(1);
    if (this.elements.statTeamDistance) {
      this.elements.statTeamDistance.textContent = `${teamKm} km`;
    }

    // 渲染排行榜 (依里程與配速排序)
    const container = this.elements.leaderboardContainer;
    if (!container) return;

    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    if (list.length === 0) {
      const empty = createSafeElement('div', { class: 'text-center py-6 text-slate-500 text-xs' }, '尚未有跑友加入小隊');
      container.appendChild(empty);
      return;
    }

    // 排序：自身或里程高者優先
    list.sort((a, b) => {
      if (a[0] === this.selfRunnerId) return -1;
      if (b[0] === this.selfRunnerId) return 1;
      return (b[1].totalDistanceMeters || 0) - (a[1].totalDistanceMeters || 0);
    });

    list.forEach(([id, runner], idx) => {
      const isSelf = id === this.selfRunnerId;
      const isThisRunnerCaptain = captainId ? (id === captainId) : !!runner.isCaptain;
      const isOnline = runner.isOnline !== false;
      const speed = runner.speed || 0;
      const kmh = (speed * 3.6).toFixed(1);
      const pace = formatPace(speed).replace(' /km', '');
      const distKm = ((runner.totalDistanceMeters || 0) / 1000).toFixed(1);
      const batteryStr = runner.battery != null ? `🔋 ${runner.battery}%` : '🔋 100%';

      let roleBadge;
      if (isSelf) {
        if (isThisRunnerCaptain) {
          roleBadge = createSafeElement('span', { class: 'text-[10px] font-bold px-1.5 py-0.2 bg-amber-400 text-slate-950 rounded' }, '👑 隊長 (我)');
        } else {
          roleBadge = createSafeElement('span', { class: 'text-[10px] font-medium px-1.5 py-0.2 bg-teal-500/20 text-teal-300 rounded border border-teal-500/40' }, '🏃 隊友 (我)');
        }
      } else {
        if (isThisRunnerCaptain) {
          roleBadge = createSafeElement('span', { class: 'text-[10px] font-bold px-1.5 py-0.2 bg-amber-400 text-slate-950 rounded' }, '👑 隊長');
        } else {
          roleBadge = createSafeElement('span', { class: 'text-[10px] font-medium px-1.5 py-0.2 bg-slate-800 text-slate-400 rounded' }, '跑友');
        }
      }

      const card = createSafeElement('div', {
        class: `p-3 rounded-2xl border transition flex items-center justify-between gap-3 cursor-pointer ${
          isSelf
            ? 'bg-[#18263E] border-teal-500/50 shadow-md shadow-teal-500/5'
            : isOnline
              ? 'bg-[#142036] border-slate-800 hover:border-slate-700'
              : 'bg-[#0E1626] border-slate-900 opacity-50'
        }`
      }, [
        // 左側：排名、圖示與跑友資訊
        createSafeElement('div', { class: 'flex items-center gap-2.5 min-w-0' }, [
          // 排名序號
          createSafeElement('span', { class: 'text-xs font-mono font-bold text-slate-500 w-4 text-center' }, (idx + 1).toString()),

          // 閃電/頭像圖示
          createSafeElement('div', {
            class: 'w-9 h-9 rounded-xl flex items-center justify-center text-lg relative flex-shrink-0',
            style: { backgroundColor: `${runner.color || '#05D5A4'}20`, border: `1.5px solid ${runner.color || '#05D5A4'}` }
          }, [
            createSafeElement('span', {}, runner.avatar || '🏃‍♂️'),
            createSafeElement('span', {
              class: `absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#131E32] ${
                isOnline ? 'bg-emerald-400' : 'bg-slate-500'
              }`
            })
          ]),

          // 名稱、身份標籤與次要動態
          createSafeElement('div', { class: 'min-w-0' }, [
            createSafeElement('div', { class: 'flex items-center gap-1.5' }, [
              createSafeElement('span', { class: 'font-bold text-white text-xs truncate' }, runner.name || '熱血跑友'),
              roleBadge
            ]),
            createSafeElement('div', { class: 'flex items-center gap-2 text-[11px] text-slate-400 mt-0.5' }, [
              createSafeElement('span', { class: 'text-amber-400 font-medium' }, `● 節奏快跑 ${kmh} km/h`),
              createSafeElement('span', { class: 'text-slate-500 font-mono text-[10px]' }, batteryStr)
            ])
          ])
        ]),

        // 右側：配速與里程
        createSafeElement('div', { class: 'text-right flex-shrink-0 font-mono' }, [
          createSafeElement('div', { class: 'text-sm font-bold text-teal-400' }, pace),
          createSafeElement('div', { class: 'text-[11px] text-slate-400' }, `${distKm} km`)
        ]),

        // 隊長專屬：移出/刪除隊友按鈕 (僅隊長看得到，且不顯示在自己身上)
        isCaptain && !isSelf
          ? createSafeElement('button', {
              type: 'button',
              class: 'p-1.5 px-2 text-[10px] font-bold rounded-lg bg-rose-500/10 hover:bg-rose-500/25 text-rose-400 border border-rose-500/30 transition flex items-center gap-1 active:scale-90 flex-shrink-0 ml-1',
              title: '將此跑友移出小隊'
            }, [
              createSafeElement('span', {}, '✕'),
              createSafeElement('span', { class: 'hidden sm:inline' }, '移出')
            ])
          : null
      ].filter(Boolean));

      // 若有移出按鈕，綁定踢出事件 (阻止事件冒泡以免觸發點擊定位)
      if (isCaptain && !isSelf) {
        const kickBtn = card.querySelector('button[title="將此跑友移出小隊"]');
        if (kickBtn && typeof onKickRunner === 'function') {
          kickBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            onKickRunner(id, runner);
          });
        }
      }

      // 點擊跑者卡片即可定位地圖視角
      card.addEventListener('click', () => {
        if (typeof onFocusRunner === 'function') {
          onFocusRunner(id, runner);
        }
      });

      container.appendChild(card);
    });
  }

  /**
   * 顯示 QR Code 邀請彈窗 (含自訂名稱與入隊密碼)
   */
  openInviteModal(roomUrl, roomId, roomName = '跑友即時小隊', password = null) {
    if (!this.elements.inviteModal) return;

    this.elements.inviteModal.classList.remove('hidden');
    if (this.elements.inviteRoomCode) {
      this.elements.inviteRoomCode.textContent = roomId;
    }
    if (this.elements.inviteRoomNameDisplay) {
      this.elements.inviteRoomNameDisplay.textContent = roomName;
    }
    if (this.elements.inviteRoomPwdDisplay) {
      if (password) {
        this.elements.inviteRoomPwdDisplay.textContent = password;
        this.elements.inviteRoomPwdDisplay.className = 'text-sm font-mono font-bold text-amber-400 bg-amber-500/10 px-2.5 py-0.5 rounded border border-amber-500/40 tracking-wider';
      } else {
        this.elements.inviteRoomPwdDisplay.textContent = '無密碼 (公開小隊)';
        this.elements.inviteRoomPwdDisplay.className = 'text-xs text-slate-400 bg-slate-800 px-2 py-0.5 rounded';
      }
    }

    // 生成 QR Code (qrcodejs)
    if (this.elements.qrcodeContainer && window.QRCode) {
      this.elements.qrcodeContainer.replaceChildren();
      try {
        new QRCode(this.elements.qrcodeContainer, {
          text: roomUrl,
          width: 180,
          height: 180,
          colorDark: '#0A0F1D',
          colorLight: '#FFFFFF',
          correctLevel: QRCode.CorrectLevel.M
        });
      } catch (err) {
        console.warn('[UI] QR Code 生成異常:', err);
      }
    }
  }

  /**
   * 密碼驗證彈窗開關
   */
  openPasswordModal(roomName, onConfirm, onCancel) {
    if (!this.elements.passwordModal) return;
    this.elements.passwordModal.classList.remove('hidden');
    if (this.elements.pwdModalRoomName) {
      this.elements.pwdModalRoomName.textContent = `小隊：${roomName || '跑友即時小隊'}`;
    }
    if (this.elements.pwdErrorMsg) {
      this.elements.pwdErrorMsg.classList.add('hidden');
    }
    if (this.elements.inputVerifyPassword) {
      this.elements.inputVerifyPassword.value = '';
      this.elements.inputVerifyPassword.focus();
    }

    // 替換確認按鈕事件
    const newBtn = this.elements.btnConfirmVerifyPwd.cloneNode(true);
    this.elements.btnConfirmVerifyPwd.parentNode.replaceChild(newBtn, this.elements.btnConfirmVerifyPwd);
    this.elements.btnConfirmVerifyPwd = newBtn;
    this.elements.btnConfirmVerifyPwd.addEventListener('click', () => {
      const pwd = this.elements.inputVerifyPassword.value.trim();
      onConfirm(pwd);
    });

    // 取消按鈕
    const cancelBtn = this.elements.btnCancelVerifyPwd.cloneNode(true);
    this.elements.btnCancelVerifyPwd.parentNode.replaceChild(cancelBtn, this.elements.btnCancelVerifyPwd);
    this.elements.btnCancelVerifyPwd = cancelBtn;
    this.elements.btnCancelVerifyPwd.addEventListener('click', () => {
      this.closePasswordModal();
      if (onCancel) onCancel();
    });
  }

  showPasswordError(msg = '密碼錯誤，請重新輸入') {
    if (this.elements.pwdErrorMsg) {
      this.elements.pwdErrorMsg.textContent = msg;
      this.elements.pwdErrorMsg.classList.remove('hidden');
    }
  }

  closePasswordModal() {
    if (this.elements.passwordModal) {
      this.elements.passwordModal.classList.add('hidden');
    }
  }

  closeInviteModal() {
    if (this.elements.inviteModal) {
      this.elements.inviteModal.classList.add('hidden');
    }
  }

  /**
   * 口袋黑屏模式切換 (防誤觸與螢幕極致省電)
   */
  togglePocketMode(enable = null) {
    const el = this.elements.pocketBlackScreen;
    if (!el) return;

    const isActive = el.classList.contains('active');
    const targetState = enable !== null ? enable : !isActive;

    if (targetState) {
      el.classList.add('active');
      this.showToast('已進入口袋防誤觸黑屏模式', 'info');
    } else {
      el.classList.remove('active');
      this.showToast('已解除口袋黑屏', 'info');
    }
  }

  /**
   * 螢幕防休眠 (Screen Wake Lock API)
   */
  async requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
        if (this.elements.wakelockBtnText) {
          this.elements.wakelockBtnText.textContent = '熄屏追蹤中 (點擊關閉)';
        }
        this.wakeLock.addEventListener('release', () => {
          if (this.elements.wakelockBtnText) {
            this.elements.wakelockBtnText.textContent = '螢幕常亮已釋放 (點擊啟用)';
          }
        });
      } catch (err) {
        console.warn('[WakeLock] 螢幕保持喚醒未被允許:', err);
      }
    }
  }

  toggleWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().then(() => {
        this.wakeLock = null;
        this.showToast('已關閉螢幕防休眠', 'info');
      });
    } else {
      this.requestWakeLock().then(() => {
        this.showToast('已啟用螢幕常亮防休眠', 'success');
      });
    }
  }

  /**
   * 電量資訊監聽 (Battery API)
   */
  async initBatteryListener() {
    if ('getBattery' in navigator) {
      try {
        const battery = await navigator.getBattery();
        this.batteryLevel = Math.round(battery.level * 100);
        battery.addEventListener('levelchange', () => {
          this.batteryLevel = Math.round(battery.level * 100);
        });
      } catch (e) {
        this.batteryLevel = 100;
      }
    } else {
      this.batteryLevel = 100;
    }
  }

  getBatteryLevel() {
    return this.batteryLevel || 100;
  }

  /**
   * 顯示 Toast 訊息
   */
  showToast(message, type = 'info') {
    if (!this.elements.toastContainer) return;

    const colors = {
      info: 'bg-[#18263E] border border-slate-700 text-white',
      success: 'bg-teal-500/20 border border-teal-500/50 text-teal-300',
      warning: 'bg-amber-500/20 border border-amber-500/50 text-amber-300',
      error: 'bg-rose-500/20 border border-rose-500/50 text-rose-300'
    };

    const toast = createSafeElement('div', {
      class: `flex items-center gap-2 px-4 py-2.5 rounded-2xl shadow-2xl text-xs font-semibold backdrop-blur-md transition-all duration-300 transform translate-y-2 opacity-0 ${colors[type] || colors.info}`
    }, message);

    this.elements.toastContainer.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.remove('translate-y-2', 'opacity-0');
    });

    setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-2');
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 3200);
  }

  /**
   * 自訂暱稱與個人化設定彈窗
   */
  openNicknameModal(currentName, currentAvatar, currentColor) {
    if (!this.elements.nicknameModal) return;
    this.elements.nicknameModal.classList.remove('hidden');
    if (this.elements.inputCustomNickname) {
      this.elements.inputCustomNickname.value = currentName || '熱血跑友';
      this.elements.inputCustomNickname.focus();
    }
  }

  closeNicknameModal() {
    if (this.elements.nicknameModal) {
      this.elements.nicknameModal.classList.add('hidden');
    }
  }

  /**
   * 隊長專屬小隊設定彈窗開關 (綜合設定彈窗)
   * 僅隊長有權修改小隊名稱與房間設定；隊友僅能修改個人跑友名片
   */
  openCaptainSettingsModal(roomName, roomCode, roomPwd, runnerProfile = null, isCaptain = false) {
    if (!this.elements.captainSettingsModal) return;
    this.elements.captainSettingsModal.classList.remove('hidden');

    const amICaptain = isCaptain || !!runnerProfile?.isCaptain;

    // 小隊名稱欄位
    if (this.elements.inputCaptainTeamName) {
      this.elements.inputCaptainTeamName.value = roomName || '跑友即時小隊';
      this.elements.inputCaptainTeamName.disabled = !amICaptain;
      if (!amICaptain) {
        this.elements.inputCaptainTeamName.classList.add('opacity-60', 'cursor-not-allowed', 'bg-[#0f172a]');
      } else {
        this.elements.inputCaptainTeamName.classList.remove('opacity-60', 'cursor-not-allowed', 'bg-[#0f172a]');
      }
    }

    // 小隊代碼欄位
    if (this.elements.inputCaptainTeamCode) {
      this.elements.inputCaptainTeamCode.value = roomCode || 'RUN-888';
      this.elements.inputCaptainTeamCode.disabled = !amICaptain;
      if (!amICaptain) {
        this.elements.inputCaptainTeamCode.classList.add('opacity-60', 'cursor-not-allowed', 'bg-[#0f172a]');
      } else {
        this.elements.inputCaptainTeamCode.classList.remove('opacity-60', 'cursor-not-allowed', 'bg-[#0f172a]');
      }
    }

    // 入隊密碼欄位
    if (this.elements.inputCaptainTeamPwd) {
      this.elements.inputCaptainTeamPwd.value = roomPwd || '';
      this.elements.inputCaptainTeamPwd.disabled = !amICaptain;
      if (!amICaptain) {
        this.elements.inputCaptainTeamPwd.classList.add('opacity-60', 'cursor-not-allowed', 'bg-[#0f172a]');
      } else {
        this.elements.inputCaptainTeamPwd.classList.remove('opacity-60', 'cursor-not-allowed', 'bg-[#0f172a]');
      }
    }

    // 免密碼與儲存小隊設定按鈕（僅隊長可見）
    if (this.elements.btnCaptainClearPwd) {
      if (amICaptain) {
        this.elements.btnCaptainClearPwd.classList.remove('hidden');
      } else {
        this.elements.btnCaptainClearPwd.classList.add('hidden');
      }
    }
    if (this.elements.btnSaveCaptainSettings) {
      if (amICaptain) {
        this.elements.btnSaveCaptainSettings.classList.remove('hidden');
      } else {
        this.elements.btnSaveCaptainSettings.classList.add('hidden');
      }
    }

    // 隊友唯讀提示條
    if (this.elements.settingsTeamTeammateNotice) {
      if (amICaptain) {
        this.elements.settingsTeamTeammateNotice.classList.add('hidden');
      } else {
        this.elements.settingsTeamTeammateNotice.classList.remove('hidden');
      }
    }

    // 權限徽章
    if (this.elements.settingsTeamPermBadge) {
      if (amICaptain) {
        this.elements.settingsTeamPermBadge.textContent = '👑 隊長權限';
        this.elements.settingsTeamPermBadge.className = 'text-[10px] text-amber-300 bg-amber-500/20 px-2 py-0.5 rounded font-normal ml-auto border border-amber-500/30';
      } else {
        this.elements.settingsTeamPermBadge.textContent = '🔒 僅隊長可修改 (隊友唯讀)';
        this.elements.settingsTeamPermBadge.className = 'text-[10px] text-slate-400 bg-slate-800 px-2 py-0.5 rounded font-normal ml-auto border border-slate-700';
      }
    }

    // 填充個人資料設定 (全體跑友皆可修改)
    if (runnerProfile) {
      if (this.elements.settingsRunnerName) {
        this.elements.settingsRunnerName.value = runnerProfile.name || '';
      }
      if (this.elements.settingsAvatarSelector && runnerProfile.avatar) {
        this.elements.settingsAvatarSelector.querySelectorAll('.avatar-opt').forEach((b) => {
          if (b.dataset.avatar === runnerProfile.avatar) {
            b.classList.remove('border-transparent');
            b.classList.add('border-teal-400', 'bg-teal-400/10');
          } else {
            b.classList.remove('border-teal-400', 'bg-teal-400/10');
            b.classList.add('border-transparent');
          }
        });
      }
      if (this.elements.settingsColorSelector && runnerProfile.color) {
        this.elements.settingsColorSelector.querySelectorAll('.color-opt').forEach((b) => {
          if (b.dataset.color && b.dataset.color.toLowerCase() === runnerProfile.color.toLowerCase()) {
            b.classList.add('ring-4', 'ring-teal-400/30');
          } else {
            b.classList.remove('ring-4', 'ring-teal-400/30');
          }
        });
      }
    }
  }

  closeCaptainSettingsModal() {
    if (this.elements.captainSettingsModal) {
      this.elements.captainSettingsModal.classList.add('hidden');
    }
  }

  toggleSettingsModal(open) {
    if (!this.elements.settingsModal) return;
    if (open) {
      this.elements.settingsModal.classList.remove('hidden');
    } else {
      this.elements.settingsModal.classList.add('hidden');
    }
  }

  toggleJoinModal(open) {
    if (!this.elements.joinModal) return;
    if (open) {
      this.elements.joinModal.classList.remove('hidden');
    } else {
      this.elements.joinModal.classList.add('hidden');
    }
  }
}

export const uiController = new UIController();
