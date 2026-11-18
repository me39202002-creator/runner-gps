/**
 * @file map-renderer.js
 * @description UI 與地圖渲染層：Google Maps 向量渲染器
 * 針對深藍運動科技風優化，支援客製化夜間模式配色 (Night Mode Styling)、
 * 向量指針 Marker、自訂軌跡 Polyline 及視角邊界縮放。
 */

import { createSafeElement } from '../security.js';
import { formatPace } from '../services/geolocation-service.js';
import { batteryService } from '../services/battery-service.js';

// Google 地圖深藍夜間模式配色方案
const DARK_MAP_STYLES = [
  { elementType: 'geometry', stylers: [{ color: '#131E32' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0A0F1D' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#94A3B8' }] },
  {
    featureType: 'administrative.locality',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#CBD5E1' }]
  },
  {
    featureType: 'poi',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }]
  },
  {
    featureType: 'road',
    elementType: 'geometry',
    stylers: [{ color: '#24344D' }]
  },
  {
    featureType: 'road',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#18263E' }]
  },
  {
    featureType: 'road',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#64748B' }]
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry',
    stylers: [{ color: '#2A436A' }]
  },
  {
    featureType: 'transit',
    elementType: 'geometry',
    stylers: [{ color: '#1A2942' }]
  },
  {
    featureType: 'water',
    elementType: 'geometry',
    stylers: [{ color: '#091322' }]
  },
  {
    featureType: 'water',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#38BDF8' }]
  }
];

class MapRenderer {
  constructor() {
    this.map = null;
    this.isMapReady = false;
    this.runners = new Map();
    this.selfRunnerId = null;
    this.activeInfoWindow = null;
    this.onQuickShoutCallback = null;
  }

  setOnQuickShout(callback) {
    this.onQuickShoutCallback = callback;
  }

  /**
   * 動態載入 Google Maps API
   */
  async loadGoogleMaps(apiKey) {
    if (window.google && window.google.maps) {
      this.isMapReady = true;
      return;
    }

    if (!apiKey) {
      throw new Error('未設定 Google Maps API Key');
    }

    // 監聽 Google Maps 認證狀態
    window.gm_authFailure = () => {
      console.warn('[MapRenderer] Google Maps API 認證警告：請確認 Google Cloud 專案是否啟用 Maps JavaScript API。');
    };

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=geometry`;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        this.isMapReady = true;
        console.log('[MapRenderer] Google Maps API 載入成功');
        resolve();
      };
      script.onerror = () => {
        reject(new Error('Google Maps 載入失敗，請確認網路連線。'));
      };
      document.head.appendChild(script);
    });
  }

  /**
   * 初始化深色地圖實例
   */
  initMap(containerId, defaultCenter = { lat: 25.033964, lng: 121.564468, zoom: 16 }) {
    if (!this.isMapReady || !window.google || !window.google.maps) {
      throw new Error('Google Maps API 尚未就緒');
    }

    const container = document.getElementById(containerId);
    if (!container) return;

    this.map = new google.maps.Map(container, {
      center: { lat: defaultCenter.lat, lng: defaultCenter.lng },
      zoom: defaultCenter.zoom,
      mapTypeId: google.maps.MapTypeId.ROADMAP,
      styles: DARK_MAP_STYLES,
      fullscreenControl: false,
      streetViewControl: false,
      mapTypeControl: false,
      zoomControl: true,
      zoomControlOptions: {
        position: google.maps.ControlPosition.RIGHT_CENTER
      }
    });

    console.log('[MapRenderer] 暗黑模式 Google 地圖初始化完成');
  }

  setSelfRunnerId(id) {
    this.selfRunnerId = id;
  }

  /**
   * 生成運動風 Marker SVG
   */
  generateMarkerIcon(color, avatar, isOnline = true, isSelf = false) {
    const opacity = isOnline ? '1.0' : '0.5';
    const ringColor = isSelf ? '#05D5A4' : '#F59E0B';
    const mainColor = color || '#05D5A4';

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="58" viewBox="0 0 48 58" opacity="${opacity}">
        <defs>
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="${mainColor}" flood-opacity="0.45"/>
          </filter>
        </defs>
        <!-- 跑友指針外框 -->
        <path d="M 24 2 C 12 2 3 11 3 23 C 3 35 24 56 24 56 C 24 56 45 35 45 23 C 45 11 36 2 24 2 Z"
              fill="#0E172B" stroke="${mainColor}" stroke-width="${isSelf ? '3' : '2'}" filter="url(#glow)"/>
        <!-- 內圈呼吸色環 -->
        <circle cx="24" cy="23" r="14" fill="#18263E" stroke="${ringColor}" stroke-width="1.5" />
        <!-- 跑友 Emoji / 隊長皇冠 -->
        <text x="24" y="29" font-size="16" text-anchor="middle" font-family="Apple Color Emoji, Segoe UI Emoji, sans-serif">${avatar || '🏃'}</text>
      </svg>
    `;

    return {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      scaledSize: new google.maps.Size(48, 58),
      anchor: new google.maps.Point(24, 56)
    };
  }

  /**
   * 安全建立 InfoWindow 內容 (含跑友即時電量與一鍵喊話快捷鍵)
   */
  createSafeInfoWindowContent(runner, isSelf = false) {
    const isOnline = runner.isOnline !== false;
    const speedStr = runner.speed ? `${(runner.speed * 3.6).toFixed(1)} km/h` : '靜止中';
    const paceStr = formatPace(runner.speed);
    const distStr = `${((runner.totalDistanceMeters || 0) / 1000).toFixed(1)} km`;

    // 格式化跑友電量
    const bat = batteryService.formatBattery(runner.battery);

    // 快速喊話按鈕區 (針對隊友，點擊可直接發送語音/泡泡)
    let shoutActions = null;
    if (!isSelf && this.onQuickShoutCallback) {
      shoutActions = createSafeElement('div', { class: 'pt-2 border-t border-slate-700/80 space-y-1.5' }, [
        createSafeElement('div', { class: 'text-[10px] text-teal-400 font-bold flex items-center gap-1' }, [
          createSafeElement('span', {}, '💬'),
          createSafeElement('span', {}, '一鍵對他喊話：')
        ]),
        createSafeElement('div', { class: 'grid grid-cols-2 gap-1 text-[11px]' }, [
          createSafeElement('button', {
            type: 'button',
            class: 'p-1 px-1.5 rounded-lg bg-teal-500/15 hover:bg-teal-500/30 text-teal-300 border border-teal-500/30 font-semibold transition active:scale-95 text-center',
            'data-shout': '大家加油！最後衝刺！',
            'data-type': 'cheer'
          }, '🏃‍♂️ 加油衝刺'),
          createSafeElement('button', {
            type: 'button',
            class: 'p-1 px-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 font-semibold transition active:scale-95 text-center',
            'data-shout': '等我一下！放慢配速',
            'data-type': 'wait'
          }, '🛑 等我一下'),
          createSafeElement('button', {
            type: 'button',
            class: 'p-1 px-1.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/30 text-sky-300 border border-sky-500/30 font-semibold transition active:scale-95 text-center',
            'data-shout': '我在補給站等大家',
            'data-type': 'supply'
          }, '🥤 補給站見'),
          createSafeElement('button', {
            type: 'button',
            class: 'p-1 px-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300 border border-rose-500/30 font-semibold transition active:scale-95 text-center',
            'data-shout': '注意前方路況，小心紅燈！',
            'data-type': 'warning'
          }, '⚠️ 注意路況')
        ])
      ]);

      // 綁定喊話點擊
      shoutActions.querySelectorAll('button[data-shout]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const text = btn.dataset.shout;
          const type = btn.dataset.type;
          this.onQuickShoutCallback(text, type, runner.id || null);
          if (this.activeInfoWindow) this.activeInfoWindow.close();
        });
      });
    }

    return createSafeElement('div', { class: 'p-2 min-w-[190px] bg-[#131E32] text-white rounded-xl font-sans text-xs space-y-1.5' }, [
      // 標題列：頭像、暱稱、電量標籤、在線狀態
      createSafeElement('div', { class: 'flex items-center gap-1.5 border-b border-slate-700 pb-1.5' }, [
        createSafeElement('span', { class: 'text-lg' }, runner.avatar || '🏃'),
        createSafeElement('span', { class: 'font-bold text-sm text-teal-300 truncate max-w-[90px]' }, runner.name || '跑友'),
        // 電量膠囊標籤
        createSafeElement('span', {
          class: `text-[10px] px-1.5 py-0.5 rounded font-mono ${bat.badgeBg} ${bat.colorClass} border ${bat.badgeBorder} flex items-center gap-0.5 ml-auto`
        }, `${bat.icon} ${bat.text}`),
        // 在線狀態點
        createSafeElement('span', {
          class: `w-2 h-2 rounded-full flex-shrink-0 ${isOnline ? 'bg-emerald-400' : 'bg-slate-500'}`
        })
      ]),
      createSafeElement('div', { class: 'flex justify-between text-slate-300' }, [
        createSafeElement('span', { class: 'text-slate-400' }, '即時配速:'),
        createSafeElement('span', { class: 'font-mono font-bold text-teal-400' }, paceStr)
      ]),
      createSafeElement('div', { class: 'flex justify-between text-slate-300' }, [
        createSafeElement('span', { class: 'text-slate-400' }, '當前速度:'),
        createSafeElement('span', { class: 'font-mono' }, speedStr)
      ]),
      createSafeElement('div', { class: 'flex justify-between text-slate-300' }, [
        createSafeElement('span', { class: 'text-slate-400' }, '累積里程:'),
        createSafeElement('span', { class: 'font-mono font-semibold' }, distStr)
      ]),
      shoutActions
    ].filter(Boolean));
  }

  /**
   * 更新或繪製跑友標記與軌跡
   */
  updateRunner(runnerId, runnerData, isSelf = false) {
    if (!this.map || !runnerData || runnerData.lat == null || runnerData.lng == null) return;

    const pos = new google.maps.LatLng(runnerData.lat, runnerData.lng);
    const color = runnerData.color || '#05D5A4';
    const avatar = runnerData.avatar || '🏃‍♂️';
    const isOnline = runnerData.isOnline !== false;

    let runnerObj = this.runners.get(runnerId);

    if (!runnerObj) {
      const marker = new google.maps.Marker({
        position: pos,
        map: this.map,
        title: runnerData.name || '跑友',
        icon: this.generateMarkerIcon(color, avatar, isOnline, isSelf),
        zIndex: isSelf ? 999 : 100
      });

      const polyline = new google.maps.Polyline({
        path: [pos],
        geodesic: true,
        strokeColor: color,
        strokeOpacity: 0.85,
        strokeWeight: 4,
        map: this.map
      });

      const infoWindow = new google.maps.InfoWindow({
        content: this.createSafeInfoWindowContent(runnerData, isSelf)
      });

      marker.addListener('click', () => {
        if (this.activeInfoWindow) this.activeInfoWindow.close();
        infoWindow.setContent(this.createSafeInfoWindowContent(runnerData, isSelf));
        infoWindow.open(this.map, marker);
        this.activeInfoWindow = infoWindow;
      });

      let accuracyCircle = null;
      if (isSelf && runnerData.accuracy) {
        accuracyCircle = new google.maps.Circle({
          strokeColor: color,
          strokeOpacity: 0.5,
          strokeWeight: 1,
          fillColor: color,
          fillOpacity: 0.1,
          map: this.map,
          center: pos,
          radius: runnerData.accuracy
        });
      }

      runnerObj = { marker, polyline, infoWindow, accuracyCircle, lastPos: pos, shoutOverlay: null, shoutTimer: null };
      this.runners.set(runnerId, runnerObj);
    } else {
      runnerObj.marker.setPosition(pos);
      runnerObj.marker.setIcon(this.generateMarkerIcon(color, avatar, isOnline, isSelf));

      const path = runnerObj.polyline.getPath();
      path.push(pos);
      if (path.getLength() > 300) {
        path.removeAt(0);
      }

      if (runnerObj.accuracyCircle) {
        runnerObj.accuracyCircle.setCenter(pos);
        if (runnerData.accuracy) {
          runnerObj.accuracyCircle.setRadius(runnerData.accuracy);
        }
      }

      // 若當前跑友頭頂正有語音泡泡，隨跑友座標即時更新位置
      if (runnerObj.shoutOverlay) {
        runnerObj.shoutOverlay.setPosition(pos);
      }

      runnerObj.lastPos = pos;
    }
  }

  /**
   * 在跑友地圖標記上方顯示動態氣泡 (Speech Bubble)
   * @param {string} runnerId 
   * @param {string} text 喊話內容
   * @param {string} avatar 跑友圖示
   */
  showShoutBubble(runnerId, text, avatar = '🏃') {
    if (!this.map || !window.google || !window.google.maps) return;
    const runnerObj = this.runners.get(runnerId);
    if (!runnerObj || !runnerObj.lastPos) return;

    // 清除該跑友先前的泡泡
    if (runnerObj.shoutTimer) {
      clearTimeout(runnerObj.shoutTimer);
      runnerObj.shoutTimer = null;
    }
    if (runnerObj.shoutOverlay) {
      runnerObj.shoutOverlay.setMap(null);
      runnerObj.shoutOverlay = null;
    }

    // 建立 Google Maps 自訂 Overlay 類別 (若尚未定義)
    if (!this.ShoutOverlayClass) {
      this.ShoutOverlayClass = class extends google.maps.OverlayView {
        constructor(position, contentNode, mapInstance) {
          super();
          this.position = position;
          this.contentNode = contentNode;
          this.div = null;
          this.setMap(mapInstance);
        }

        onAdd() {
          this.div = document.createElement('div');
          this.div.className = 'runner-shout-overlay';
          this.div.appendChild(this.contentNode);
          const panes = this.getPanes();
          if (panes && panes.overlayMouseTarget) {
            panes.overlayMouseTarget.appendChild(this.div);
          }
        }

        draw() {
          const overlayProjection = this.getProjection();
          if (!overlayProjection || !this.div || !this.position) return;
          const point = overlayProjection.fromLatLngToDivPixel(this.position);
          if (point) {
            this.div.style.left = point.x + 'px';
            this.div.style.top = (point.y - 60) + 'px';
          }
        }

        setPosition(pos) {
          this.position = pos;
          this.draw();
        }

        onRemove() {
          if (this.div && this.div.parentNode) {
            this.div.parentNode.removeChild(this.div);
            this.div = null;
          }
        }
      };
    }

    // 建立安全泡泡 DOM 結構
    const bubbleEl = createSafeElement('div', { class: 'runner-shout-bubble' }, [
      createSafeElement('span', { class: 'text-sm' }, avatar || '🏃'),
      createSafeElement('span', { class: 'truncate max-w-[160px]' }, text)
    ]);

    const overlay = new this.ShoutOverlayClass(runnerObj.lastPos, bubbleEl, this.map);
    runnerObj.shoutOverlay = overlay;

    // 6 秒後自動淡出移除
    runnerObj.shoutTimer = setTimeout(() => {
      if (runnerObj.shoutOverlay) {
        runnerObj.shoutOverlay.setMap(null);
        runnerObj.shoutOverlay = null;
      }
      runnerObj.shoutTimer = null;
    }, 6000);
  }

  removeRunner(runnerId) {
    const runnerObj = this.runners.get(runnerId);
    if (runnerObj) {
      if (runnerObj.shoutTimer) clearTimeout(runnerObj.shoutTimer);
      if (runnerObj.shoutOverlay) runnerObj.shoutOverlay.setMap(null);
      if (runnerObj.marker) runnerObj.marker.setMap(null);
      if (runnerObj.polyline) runnerObj.polyline.setMap(null);
      if (runnerObj.accuracyCircle) runnerObj.accuracyCircle.setMap(null);
      if (runnerObj.infoWindow) runnerObj.infoWindow.close();
      this.runners.delete(runnerId);
    }
  }

  /**
   * 清除所有跑友標記 (例如切換小隊房間時)
   * @param {boolean} keepSelf 是否保留自身標記
   */
  clearAllRunners(keepSelf = false) {
    this.runners.forEach((runnerObj, id) => {
      if (keepSelf && id === this.selfRunnerId) return;
      if (runnerObj.shoutTimer) clearTimeout(runnerObj.shoutTimer);
      if (runnerObj.shoutOverlay) runnerObj.shoutOverlay.setMap(null);
      if (runnerObj.marker) runnerObj.marker.setMap(null);
      if (runnerObj.polyline) runnerObj.polyline.setMap(null);
      if (runnerObj.accuracyCircle) runnerObj.accuracyCircle.setMap(null);
      if (runnerObj.infoWindow) runnerObj.infoWindow.close();
      this.runners.delete(id);
    });
  }

  panTo(lat, lng, zoom = null) {
    if (!this.map) return;
    this.map.panTo(new google.maps.LatLng(lat, lng));
    if (zoom) this.map.setZoom(zoom);
  }

  /**
   * 聚焦特定跑友至地圖正中央，並彈出資訊視窗與跳動提示
   * @param {string} runnerId 
   */
  focusRunner(runnerId) {
    if (!this.map) return false;
    const runnerObj = this.runners.get(runnerId);
    if (!runnerObj || !runnerObj.marker) return false;

    const pos = runnerObj.marker.getPosition();
    if (!pos) return false;

    // 平滑移至中央
    this.map.panTo(pos);
    this.map.setZoom(17);

    // 跳出該隊友的即時資訊氣泡 (InfoWindow)
    if (runnerObj.infoWindow) {
      if (this.activeInfoWindow) this.activeInfoWindow.close();
      runnerObj.infoWindow.open(this.map, runnerObj.marker);
      this.activeInfoWindow = runnerObj.infoWindow;
    }

    // 觸發標記短暫跳動動畫 (Bounce)
    if (runnerObj.marker.setAnimation) {
      runnerObj.marker.setAnimation(google.maps.Animation.BOUNCE);
      setTimeout(() => {
        runnerObj.marker.setAnimation(null);
      }, 1400);
    }

    return true;
  }

  fitAllRunners() {
    if (!this.map || this.runners.size === 0) return;
    const bounds = new google.maps.LatLngBounds();
    let count = 0;
    this.runners.forEach((r) => {
      if (r.marker && r.marker.getPosition()) {
        bounds.extend(r.marker.getPosition());
        count++;
      }
    });

    if (count === 1) {
      this.map.panTo(bounds.getCenter());
      this.map.setZoom(16);
    } else if (count > 1) {
      this.map.fitBounds(bounds, 50);
    }
  }

  setMapType(type) {
    if (!this.map) return;
    if (type === 'satellite' || type === 'hybrid') {
      this.map.setMapTypeId(google.maps.MapTypeId.HYBRID);
    } else {
      this.map.setMapTypeId(google.maps.MapTypeId.ROADMAP);
      this.map.setOptions({ styles: DARK_MAP_STYLES });
    }
  }
}

export const mapRenderer = new MapRenderer();
