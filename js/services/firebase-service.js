/**
 * @file firebase-service.js
 * @description 資料處理層：負責 Firebase Realtime Database 實體連線、座標同步與在線 Presence 機制
 * 完全與 UI 及地圖渲染解耦，僅透過回呼函式 (Callbacks) 與自訂事件傳遞資料。
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  onValue,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  off,
  onDisconnect,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';

class FirebaseService {
  constructor() {
    this.app = null;
    this.db = null;
    this.currentRoomId = null;
    this.currentRunnerId = null;
    this.runnersRef = null;
    this.metaRef = null;
    this.connectedRef = null;
    this.isInitialized = false;
    this.isConnected = false;

    // 回呼函式儲存
    this.onRunnerUpdatedCallback = null;
    this.onRunnerRemovedCallback = null;
    this.onConnectionStatusChangeCallback = null;
  }

  /**
   * 初始化 Firebase 應用與 Realtime Database
   * @param {Object} firebaseConfig 
   * @returns {boolean}
   */
  init(firebaseConfig) {
    if (!firebaseConfig || !firebaseConfig.apiKey || !firebaseConfig.databaseURL) {
      console.warn('[FirebaseService] 缺少必要的 Firebase 設定參數');
      return false;
    }

    try {
      this.app = initializeApp(firebaseConfig);
      this.db = getDatabase(this.app);
      this.isInitialized = true;

      // 監聽本機與 Firebase RTDB 伺服器之連線狀態 (.info/connected)
      this.connectedRef = ref(this.db, '.info/connected');
      onValue(this.connectedRef, (snapshot) => {
        this.isConnected = snapshot.val() === true;
        if (typeof this.onConnectionStatusChangeCallback === 'function') {
          this.onConnectionStatusChangeCallback(this.isConnected);
        }
      });

      console.log('[FirebaseService] 初始化成功');
      return true;
    } catch (err) {
      console.error('[FirebaseService] 初始化失敗:', err);
      return false;
    }
  }

  /**
   * 註冊連線狀態改變回呼
   */
  onConnectionChange(callback) {
    this.onConnectionStatusChangeCallback = callback;
    if (this.isInitialized) {
      callback(this.isConnected);
    }
  }

  /**
   * 驗證房間密碼並加入小隊
   * @param {string} roomId 房間 ID
   * @param {string} roomName 房間名稱 (自訂)
   * @param {string|null} password 房間密碼 (可為空)
   * @param {Object} runnerInfo 跑友資訊
   * @returns {Promise<{success: boolean, isNewRoom?: boolean, roomName?: string, reason?: string}>}
   */
  async verifyAndJoinRoom(roomId, roomName, password, runnerInfo) {
    if (!this.db) throw new Error('Firebase 尚未初始化');

    const metaRef = ref(this.db, `rooms/${roomId}/metadata`);
    const snapshot = await get(metaRef);

    if (!snapshot.exists()) {
      // 房間尚不存在，建立新房間，第一位加入者即為唯一隊長
      const metadata = {
        name: roomName || '跑友即時小隊',
        password: password || null,
        hasPassword: !!password,
        captainId: runnerInfo.id,
        creatorId: runnerInfo.id,
        createdAt: serverTimestamp()
      };
      await set(metaRef, metadata);
      runnerInfo.isCaptain = true;
      await this.joinRoom(roomId, runnerInfo);
      return {
        success: true,
        isNewRoom: true,
        roomName: metadata.name,
        hasPassword: metadata.hasPassword,
        captainId: runnerInfo.id,
        isCaptain: true
      };
    } else {
      // 房間已存在，檢查是否需要密碼
      const metadata = snapshot.val();
      if (metadata.hasPassword) {
        if (!password || String(password).trim() !== String(metadata.password).trim()) {
          return {
            success: false,
            reason: 'WRONG_PASSWORD',
            roomName: metadata.name,
            hasPassword: true
          };
        }
      }

      // 若有傳入新的自訂名稱且不同於現存名稱，自動同步更新至 Firebase
      if (roomName && roomName !== '跑友即時小隊' && roomName !== metadata.name) {
        try {
          await update(metaRef, { name: roomName, updatedAt: serverTimestamp() });
          metadata.name = roomName;
        } catch (e) {
          console.warn('[FirebaseService] 更新房間名稱警告:', e);
        }
      }

      // 嚴格判定隊長身份：隊長只有一人，先加入的是隊長
      let currentCaptainId = metadata.captainId || metadata.creatorId;

      // 若資料庫尚未指定 captainId，或原本隊長已不在房間，檢查房間內最早加入的在線跑友
      const runnersSnap = await get(ref(this.db, `rooms/${roomId}/runners`));
      const existingRunners = runnersSnap.exists() ? runnersSnap.val() : {};

      if (!currentCaptainId || !existingRunners[currentCaptainId]) {
        let earliestJoinedTime = Infinity;
        let earliestRunnerId = null;

        Object.entries(existingRunners).forEach(([rid, r]) => {
          if (r.isOnline !== false) {
            const jt = r.joinedAt || r.createdAt || Infinity;
            if (jt < earliestJoinedTime) {
              earliestJoinedTime = jt;
              earliestRunnerId = rid;
            }
          }
        });

        // 若無其他在線跑友，則此人就是最早也是唯一的隊長
        currentCaptainId = earliestRunnerId || runnerInfo.id;
        try {
          await update(metaRef, { captainId: currentCaptainId });
        } catch (e) {}
      }

      const isCaptain = (currentCaptainId === runnerInfo.id);
      runnerInfo.isCaptain = isCaptain;

      await this.joinRoom(roomId, runnerInfo);
      return {
        success: true,
        isNewRoom: false,
        roomName: metadata.name || roomName,
        hasPassword: metadata.hasPassword,
        captainId: currentCaptainId,
        isCaptain: isCaptain
      };
    }
  }

  /**
   * 隊長更新小隊設定 (名稱、代碼、密碼)
   * @param {string} roomId 
   * @param {string} newName 
   * @param {string|null} newPassword 
   */
  async updateRoomMetadata(roomId, newName, newPassword) {
    if (!this.db) throw new Error('Firebase 尚未初始化');
    const metaRef = ref(this.db, `rooms/${roomId}/metadata`);
    await update(metaRef, {
      name: newName || '跑友即時小隊',
      password: newPassword || null,
      hasPassword: !!newPassword,
      updatedAt: serverTimestamp()
    });
  }

  /**
   * 監聽小隊設定變更 (讓隊友畫面即時同步隊長修改的名稱與密碼狀態)
   */
  subscribeToRoomMetadata(roomId, onMetadataUpdated) {
    if (!this.db || !roomId) return;
    if (this.metaRef) {
      try { off(this.metaRef); } catch (e) {}
      this.metaRef = null;
    }
    this.metaRef = ref(this.db, `rooms/${roomId}/metadata`);
    onValue(this.metaRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        if (typeof onMetadataUpdated === 'function') {
          onMetadataUpdated(data);
        }
      }
    });
  }

  /**
   * 加入特定跑步房間並設定 Presence (在線狀態與離線保護)
   * @param {string} roomId 房間 ID
   * @param {Object} runnerInfo 跑友資訊 { id, name, color, avatar }
   */
  async joinRoom(roomId, runnerInfo) {
    if (!this.db) throw new Error('Firebase 尚未初始化');
    if (!roomId || !runnerInfo || !runnerInfo.id) throw new Error('加入房間參數不合法');

    this.currentRoomId = roomId;
    this.currentRunnerId = runnerInfo.id;

    const myRunnerRef = ref(this.db, `rooms/${roomId}/runners/${runnerInfo.id}`);

    // 設定離線保護 (onDisconnect): 斷線時自動將 isOnline 改為 false
    const disconnectRef = onDisconnect(myRunnerRef);
    await disconnectRef.update({
      isOnline: false,
      lastSeen: serverTimestamp()
    });

    // 寫入上線初始狀態
    const initialData = {
      id: runnerInfo.id,
      name: runnerInfo.name,
      color: runnerInfo.color,
      avatar: runnerInfo.avatar || '🏃',
      isOnline: true,
      isCaptain: !!runnerInfo.isCaptain,
      joinedAt: serverTimestamp(),
      lastSeen: serverTimestamp()
    };

    await update(myRunnerRef, initialData);
    console.log(`[FirebaseService] 已加入房間 ${roomId}，跑友 ID: ${runnerInfo.id}`);
  }

  /**
   * 上報本機即時 GPS 座標至資料庫
   * @param {Object} coordsData { lat, lng, accuracy, speed, heading }
   */
  async updateLocation(coordsData) {
    if (!this.db || !this.currentRoomId || !this.currentRunnerId) return;

    const myRunnerRef = ref(this.db, `rooms/${this.currentRoomId}/runners/${this.currentRunnerId}`);
    const updatePayload = {
      lat: coordsData.lat,
      lng: coordsData.lng,
      accuracy: coordsData.accuracy ?? null,
      speed: coordsData.speed ?? null,
      heading: coordsData.heading ?? null,
      updatedAt: serverTimestamp(),
      isOnline: true
    };

    try {
      await update(myRunnerRef, updatePayload);
    } catch (err) {
      console.error('[FirebaseService] 座標上傳失敗:', err);
    }
  }

  /**
   * 訂閱該房間所有跑友的變更 (即時資料串流)
   * @param {string} roomId 
   * @param {Function} onRunnerUpdated (runnerId, runnerData)
   * @param {Function} onRunnerRemoved (runnerId)
   */
  subscribeToRoom(roomId, onRunnerUpdated, onRunnerRemoved) {
    if (!this.db) throw new Error('Firebase 尚未初始化');
    this.unsubscribe(); // 清除先前的監聽

    this.onRunnerUpdatedCallback = onRunnerUpdated;
    this.onRunnerRemovedCallback = onRunnerRemoved;
    this.runnersRef = ref(this.db, `rooms/${roomId}/runners`);

    // 監聽新增跑友
    onChildAdded(this.runnersRef, (snapshot) => {
      const runnerId = snapshot.key;
      const runnerData = snapshot.val();
      if (typeof this.onRunnerUpdatedCallback === 'function') {
        this.onRunnerUpdatedCallback(runnerId, runnerData);
      }
    });

    // 監聽跑友位置或屬性變更
    onChildChanged(this.runnersRef, (snapshot) => {
      const runnerId = snapshot.key;
      const runnerData = snapshot.val();
      if (typeof this.onRunnerUpdatedCallback === 'function') {
        this.onRunnerUpdatedCallback(runnerId, runnerData);
      }
    });

    // 監聽跑友退出
    onChildRemoved(this.runnersRef, (snapshot) => {
      const runnerId = snapshot.key;
      if (typeof this.onRunnerRemovedCallback === 'function') {
        this.onRunnerRemovedCallback(runnerId);
      }
    });
  }

  /**
   * 發送線上心跳包 (Heartbeat)，防止靜止休息時被誤判超時
   */
  async sendHeartbeat() {
    if (!this.db || !this.currentRoomId || !this.currentRunnerId) return;
    const myRunnerRef = ref(this.db, `rooms/${this.currentRoomId}/runners/${this.currentRunnerId}`);
    try {
      await update(myRunnerRef, {
        isOnline: true,
        lastSeen: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } catch (e) {
      // 斷線時忽略
    }
  }

  /**
   * 隊長將特定跑友移出小隊
   * @param {string} roomId 
   * @param {string} runnerId 
   */
  async kickRunner(roomId, runnerId) {
    if (!this.db || !roomId || !runnerId) return;
    const runnerRef = ref(this.db, `rooms/${roomId}/runners/${runnerId}`);
    await remove(runnerRef);
  }

  /**
   * 主動退出房間並清除監聽
   */
  async leaveRoom() {
    if (this.db && this.currentRoomId && this.currentRunnerId) {
      const roomId = this.currentRoomId;
      const runnerId = this.currentRunnerId;
      const myRunnerRef = ref(this.db, `rooms/${roomId}/runners/${runnerId}`);
      try {
        await onDisconnect(myRunnerRef).cancel();
        await update(myRunnerRef, {
          isOnline: false,
          lastSeen: serverTimestamp()
        });

        // 隊長傳承機制：若退出的正是隊長，自動傳承給下一個最早加入的在線跑友
        const metaRef = ref(this.db, `rooms/${roomId}/metadata`);
        const metaSnap = await get(metaRef);
        if (metaSnap.exists()) {
          const meta = metaSnap.val();
          if (meta.captainId === runnerId) {
            const runnersSnap = await get(ref(this.db, `rooms/${roomId}/runners`));
            if (runnersSnap.exists()) {
              const allRunners = runnersSnap.val();
              let nextCaptainId = null;
              let earliestTime = Infinity;

              Object.entries(allRunners).forEach(([rid, r]) => {
                if (rid !== runnerId && r.isOnline !== false) {
                  const jt = r.joinedAt || r.createdAt || Infinity;
                  if (jt < earliestTime) {
                    earliestTime = jt;
                    nextCaptainId = rid;
                  }
                }
              });

              if (nextCaptainId) {
                await update(metaRef, { captainId: nextCaptainId });
                await update(ref(this.db, `rooms/${roomId}/runners/${nextCaptainId}`), { isCaptain: true });
                console.log(`[FirebaseService] 隊長已傳承給最早加入的隊友: ${nextCaptainId}`);
              }
            }
          }
        }
      } catch (err) {
        console.warn('[FirebaseService] 離線狀態註記錯誤:', err);
      }
    }
    this.unsubscribe();
    this.currentRoomId = null;
    this.currentRunnerId = null;
  }

  /**
   * 取消資料庫監聽
   */
  unsubscribe() {
    if (this.runnersRef) {
      try { off(this.runnersRef); } catch (e) {}
      this.runnersRef = null;
    }
    if (this.metaRef) {
      try { off(this.metaRef); } catch (e) {}
      this.metaRef = null;
    }
    this.onRunnerUpdatedCallback = null;
    this.onRunnerRemovedCallback = null;
  }
}

export const firebaseService = new FirebaseService();
