/**
 * @file config.js
 * @description 實際運行的設定檔 (已填入您的專屬 Google Maps 與 Firebase 金鑰)
 */

const DEFAULT_CONFIG = {
  // Google Maps JavaScript API 金鑰
  googleMapsApiKey: 'AIzaSyDlZZObJLVB69jtS8wvlAHWEKgcZlEC63I',

  // Firebase Realtime Database 設定
  firebase: {
    apiKey: 'AIzaSyCQwblsaxnWx8BsaJb_kY2hsEHT2uSYi0U',
    authDomain: 'runner-gps.firebaseapp.com',
    databaseURL: 'https://runner-gps-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'runner-gps',
    storageBucket: 'runner-gps.firebasestorage.app',
    messagingSenderId: '469222714638',
    appId: '1:469222714638:web:e025c0cf3bf2637858fb5f',
    measurementId: 'G-742GJE4GQJ'
  },

  geolocation: {
    minDistanceChangeMeters: 3,
    throttleIntervalMs: 2000,
    maxAcceptableAccuracyMeters: 50,
    enableHighAccuracy: true,
    timeoutMs: 15000,
    maximumAgeMs: 0
  },

  mapDefaults: {
    lat: 25.033964,
    lng: 121.564468,
    zoom: 16
  }
};

/**
 * 載入並整合設定 (若 localStorage 有使用者填寫的金鑰，優先覆蓋)
 */
export function getAppConfig() {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  try {
    const savedCustomConfig = localStorage.getItem('runner_gps_custom_config');
    if (savedCustomConfig) {
      const parsed = JSON.parse(savedCustomConfig);
      if (parsed.googleMapsApiKey && parsed.googleMapsApiKey.trim()) {
        config.googleMapsApiKey = parsed.googleMapsApiKey.trim();
      }
      if (parsed.firebase && parsed.firebase.apiKey && parsed.firebase.apiKey.trim()) {
        config.firebase = { ...config.firebase, ...parsed.firebase };
      }
    }
  } catch (e) {
    console.warn('[Config] 讀取自訂設定失敗，使用預設值', e);
  }

  return config;
}

/**
 * 儲存使用者的金鑰設定到 localStorage
 */
export function saveCustomConfig(customConfig) {
  try {
    localStorage.setItem('runner_gps_custom_config', JSON.stringify(customConfig));
    return true;
  } catch (e) {
    console.error('[Config] 儲存自訂設定失敗', e);
    return false;
  }
}
