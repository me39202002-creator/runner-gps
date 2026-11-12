/**
 * @file config.example.js
 * @description 專案環境設定檔範本
 * 請複製本檔案為 config.js 並填入您的 Firebase 與 Google Maps API 金鑰。
 */

export const APP_CONFIG = {
  // Google Maps JavaScript API 金鑰
  // 需在 Google Cloud Console 啟用 "Maps JavaScript API"
  googleMapsApiKey: 'YOUR_GOOGLE_MAPS_API_KEY',

  // Firebase Realtime Database 設定
  // 可在 Firebase Console > 專案設定 > 一般 > 您的應用程式 中取得
  firebase: {
    apiKey: 'YOUR_FIREBASE_API_KEY',
    authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
    databaseURL: 'https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com',
    projectId: 'YOUR_PROJECT_ID',
    storageBucket: 'YOUR_PROJECT_ID.appspot.com',
    messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
    appId: 'YOUR_APP_ID'
  },

  // GPS 與定位設定
  geolocation: {
    // 最小更新移動距離（公尺），小於此距離且時間未達間隔時不上報，節省電力
    minDistanceChangeMeters: 3,
    // 最小上報間隔時間（毫秒）
    throttleIntervalMs: 2000,
    // 精度門檻（公尺）：若 GPS 誤差大於此數值，判定為不穩定座標不予繪製
    maxAcceptableAccuracyMeters: 50,
    // 是否強制高精準度 (呼叫硬體 GPS)
    enableHighAccuracy: true,
    // 超時時間 (毫秒)
    timeoutMs: 15000,
    // 座標快取時間 (毫秒)
    maximumAgeMs: 0
  },

  // 預設地圖初始視野 (台北市信義區)
  mapDefaults: {
    lat: 25.033964,
    lng: 121.564468,
    zoom: 16
  }
};
