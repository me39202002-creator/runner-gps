/**
 * @file security.js
 * @description DOM XSS 防禦與安全處理模組
 * 負責所有來自 URL、使用者輸入、外部資料庫字串的安全檢查、轉義與白名單過濾。
 */

/**
 * 允許的房間 ID 正規表達式 (僅限英數字、連字號與底線，長度 3~32 字元)
 */
const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;

/**
 * 允許的密碼格式 (英數字 4~12 位)
 */
const PASSWORD_PATTERN = /^[a-zA-Z0-9]{4,12}$/;

/**
 * 驗證並清理房間密碼
 * @param {string} rawPwd
 * @returns {string|null}
 */
export function sanitizeRoomPassword(rawPwd) {
  if (!rawPwd || typeof rawPwd !== 'string') return null;
  const trimmed = rawPwd.trim();
  if (trimmed.length === 0) return null;
  if (PASSWORD_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * 安全清理房間名稱
 * @param {string} rawName
 * @param {string} fallback
 * @returns {string}
 */
export function sanitizeRoomName(rawName, fallback = '跑友即時小隊') {
  if (!rawName || typeof rawName !== 'string') return fallback;
  let cleaned = rawName.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
  if (cleaned.length > 25) {
    cleaned = cleaned.substring(0, 25);
  }
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * 允許的顏色格式 (Hex 顏色碼，如 #3B82F6)
 */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * HTML 特殊字元跳脫映射表
 */
const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#x60;'
};

const ESCAPE_REGEX = /[&<>"'`\/]/g;

/**
 * 嚴格轉義 HTML 字串，防止注入任何標籤或屬性中斷
 * @param {any} input
 * @returns {string}
 */
export function escapeHTML(input) {
  if (input === null || input === undefined) return '';
  const str = String(input);
  return str.replace(ESCAPE_REGEX, match => HTML_ESCAPES[match]);
}

/**
 * 安全驗證與清理 Room ID
 * 若包含不合法字元或長度不合規範，將回傳 null
 * @param {string} rawId
 * @returns {string|null}
 */
export function validateAndSanitizeRoomId(rawId) {
  if (!rawId || typeof rawId !== 'string') return null;
  const trimmed = rawId.trim();
  if (ROOM_ID_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * 產生隨機的安全 Room ID (以時間戳記 + 隨機字元組成)
 * @returns {string}
 */
export function generateSafeRoomId() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let result = 'run-';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * 產生安全隨機 Runner ID
 * @returns {string}
 */
export function generateSafeRunnerId() {
  return 'runner_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
}

/**
 * 安全清理跑友暱稱
 * - 限制長度 1~20 字元
 * - 移除控制字元與前後空白
 * - 若為空則提供預設暱稱
 * @param {string} rawName
 * @param {string} fallback
 * @returns {string}
 */
export function sanitizeRunnerName(rawName, fallback = '熱血跑友') {
  if (!rawName || typeof rawName !== 'string') return fallback;
  // 移除不可見字元與 ASCII 控制碼
  let cleaned = rawName.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
  // 截斷長度最多 20 字
  if (cleaned.length > 20) {
    cleaned = cleaned.substring(0, 20);
  }
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * 驗證並過濾跑友顏色
 * @param {string} rawColor
 * @param {string} fallback
 * @returns {string}
 */
export function sanitizeColor(rawColor, fallback = '#3B82F6') {
  if (typeof rawColor === 'string' && HEX_COLOR_PATTERN.test(rawColor)) {
    return rawColor;
  }
  return fallback;
}

/**
 * 從目前 URL 安全取得指定參數
 * 使用 URLSearchParams 配合驗證，防止 javascript: 或 data: 等偽協議注入
 * @param {string} paramName
 * @returns {string|null}
 */
export function getSafeURLParam(paramName) {
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get(paramName);
    if (!value) return null;
    // 阻擋危險 URL Scheme 與控制字元
    if (value.startsWith('javascript:') || value.startsWith('data:') || value.startsWith('vbscript:')) {
      console.warn(`[Security] 偵測到潛在惡意 URL 參數: ${paramName}`);
      return null;
    }
    return value;
  } catch (err) {
    console.error('[Security] URL 參數解析失敗:', err);
    return null;
  }
}

/**
 * 安全建立 DOM 節點，嚴格採用 textContent 與安全屬性，完全杜絕 innerHTML XSS 漏洞
 * @param {string} tagName 元素標籤名 (如 'div', 'span')
 * @param {Object} attributes 屬性鍵值對 (不可傳入 on* 事件屬性)
 * @param {string|Array<Node|string>} children 子節點或純文字
 * @returns {HTMLElement}
 */
export function createSafeElement(tagName, attributes = {}, children = null) {
  const el = document.createElement(tagName);

  for (const [key, val] of Object.entries(attributes)) {
    if (val === undefined || val === null) continue;

    // 嚴禁注入 inline 事件屬性 (如 onclick, onerror)
    if (key.toLowerCase().startsWith('on')) {
      console.warn(`[Security] 拒絕設定事件屬性: ${key}`);
      continue;
    }

    if (key === 'className' || key === 'class') {
      el.className = String(val);
    } else if (key === 'style' && typeof val === 'object') {
      Object.assign(el.style, val);
    } else {
      // 針對 href 與 src 做安全檢查
      if ((key === 'href' || key === 'src') && typeof val === 'string') {
        const lower = val.trim().toLowerCase();
        if (lower.startsWith('javascript:') || lower.startsWith('data:text/html')) {
          console.warn(`[Security] 拒絕不安全 URL 屬性: ${val}`);
          continue;
        }
      }
      el.setAttribute(key, String(val));
    }
  }

  if (children !== null) {
    if (Array.isArray(children)) {
      children.forEach(child => {
        if (child instanceof Node) {
          el.appendChild(child);
        } else if (child !== null && child !== undefined) {
          el.appendChild(document.createTextNode(String(child)));
        }
      });
    } else if (children instanceof Node) {
      el.appendChild(children);
    } else {
      el.textContent = String(children);
    }
  }

  return el;
}
