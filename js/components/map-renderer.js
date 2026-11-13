/**
 * @file map-renderer.js
 * @description UI 與地圖渲染層：Google Maps 向量渲染器
 * 針對深藍運動科技風優化，支援客製化夜間模式配色 (Night Mode Styling)、
 * 向量指針 Marker、自訂軌跡 Polyline 及視角邊界縮放。
 */

import { createSafeElement } from '../security.js';
import { formatPace } from '../services/geolocation-service.js';

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
   * 安全建立 InfoWindow 內容
   */
  createSafeInfoWindowContent(runner) {
    const isOnline = runner.isOnline !== false;
    const speedStr = runner.speed ? `${(runner.speed * 3.6).toFixed(1)} km/h` : '靜止中';
    const paceStr = formatPace(runner.speed);
    const distStr = `${((runner.totalDistanceMeters || 0) / 1000).toFixed(1)} km`;

    return createSafeElement('div', { class: 'p-2 min-w-[170px] bg-[#131E32] text-white rounded-xl font-sans text-xs space-y-1.5' }, [
      createSafeElement('div', { class: 'flex items-center gap-2 border-b border-slate-700 pb-1.5' }, [
        createSafeElement('span', { class: 'text-lg' }, runner.avatar || '🏃'),
        createSafeElement('span', { class: 'font-bold text-sm text-teal-300 truncate' }, runner.name || '跑友'),
        createSafeElement('span', {
          class: `text-[10px] px-1.5 py-0.5 rounded-full ml-auto ${
            isOnline ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-400'
          }`
        }, isOnline ? '在線' : '離線')
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
      ])
    ]);
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
        content: this.createSafeInfoWindowContent(runnerData)
      });

      marker.addListener('click', () => {
        if (this.activeInfoWindow) this.activeInfoWindow.close();
        infoWindow.setContent(this.createSafeInfoWindowContent(runnerData));
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

      runnerObj = { marker, polyline, infoWindow, accuracyCircle, lastPos: pos };
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

      runnerObj.lastPos = pos;
    }
  }

  removeRunner(runnerId) {
    const runnerObj = this.runners.get(runnerId);
    if (runnerObj) {
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
