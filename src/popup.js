/* popup.js */

const version = chrome.runtime.getManifest().version;
const LOCAL_ONLY_FIELDS = new Set(['deepseekApiKey']);
// select 控件的 value 是字符串，这些设置在存储里统一保存为数字。
const NUMERIC_FIELDS = new Set(['translationCacheDays']);
const TRANSLATION_CACHE_KEY_PREFIX = 'anontranslator.translationCache.';
let saveStateTimeout;
let cacheClearTimeout;
document.getElementById('extensionVersion').textContent = `Ver ${version} `;

function updateBackgroundImage(isPluginOn) {
  const upperPart = document.querySelector('.upper-part');
  if (!upperPart) return;
  upperPart.classList.toggle('plugin-on', isPluginOn);
  upperPart.classList.toggle('plugin-off', !isPluginOn);
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  document.getElementById('settingsForm').addEventListener('submit', event => {
    event.preventDefault();
    saveSettings();
  });

  document.getElementById('pluginSwitch').addEventListener('change', event => {
    persistPluginSwitch(event.target.checked);
  });

  document.getElementById('translationMode').addEventListener('change', event => {
    persistTranslationMode(event.target.value);
  });

  document.getElementById('clearTranslationCache').addEventListener('click', clearTranslationCache);
});

function applySettingsToForm(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const element = document.getElementById(key);
    if (!element) continue;

    if (element.type === 'checkbox' || element.type === 'radio') {
      element.checked = Boolean(value);
    } else if (
      element.type === 'color' ||
      element.type === 'text' ||
      element.type === 'number' ||
      element.type === 'password' ||
      element.tagName === 'SELECT'
    ) {
      element.value = value ?? '';
    }
  }
}

function updateTranslationModeHint(mode) {
  const hint = document.getElementById('translationModeHint');
  if (!hint) return;
  hint.textContent = mode === 'general'
    ? '选中文本后，点击选区旁的按钮翻译。'
    : '悬停并点击段落，显示译文和日语假名。';
}

function persistTranslationMode(mode) {
  const normalizedMode = mode === 'general' ? 'general' : 'novel';
  updateTranslationModeHint(normalizedMode);
  chrome.storage.sync.set({ translationMode: normalizedMode }, () => {
    if (chrome.runtime.lastError) {
      console.error('[AnonTranslator II] Failed to switch translation mode:', chrome.runtime.lastError.message);
      showSaveState('error', 'error');
      return;
    }
    showSaveState('已切换', 'saved');
  });
}

function persistPluginSwitch(isPluginOn) {
  const pluginSwitch = document.getElementById('pluginSwitch');
  pluginSwitch.disabled = true;
  updateBackgroundImage(isPluginOn);
  // 只保存开关，避免顺带提交其他尚未保存的设置。
  chrome.storage.sync.set({ pluginSwitch: isPluginOn }, () => {
    pluginSwitch.disabled = false;
    if (chrome.runtime.lastError) {
      console.error('[AnonTranslator II] Failed to switch plugin:', chrome.runtime.lastError.message);
      pluginSwitch.checked = !isPluginOn;
      updateBackgroundImage(!isPluginOn);
      showSaveState('切换失败', 'error');
      return;
    }
    showSaveState(isPluginOn ? '已开启' : '已关闭', 'saved');
  });
}

function loadSettings() {
  chrome.runtime.sendMessage({ type: 'getSettings' }, settings => {
    if (chrome.runtime.lastError || !settings || settings.error) {
      chrome.storage.sync.get(null, syncSettings => {
        if (chrome.runtime.lastError) {
          console.error('[AnonTranslator II] Failed to load sync settings:', chrome.runtime.lastError.message);
          showSaveState('error', 'error');
          return;
        }
        const fallbackSettings = {
          translationMode: 'novel',
          ...syncSettings
        };
        applySettingsToForm(fallbackSettings);
        document.getElementById('pluginSwitch').disabled = false;
        updateBackgroundImage(Boolean(syncSettings.pluginSwitch));
        updateTranslationModeHint(fallbackSettings.translationMode);
      });
      return;
    }
    applySettingsToForm(settings);
    document.getElementById('pluginSwitch').disabled = false;
    updateBackgroundImage(Boolean(settings.pluginSwitch));
    updateTranslationModeHint(settings.translationMode);
  });

  chrome.storage.local.get(['deepseekApiKey'], localSettings => {
    if (chrome.runtime.lastError) {
      console.error('[AnonTranslator II] Failed to load local settings:', chrome.runtime.lastError.message);
      showSaveState('error', 'error');
      return;
    }
    applySettingsToForm(localSettings);
  });
}

function getElementValue(element) {
  if (element.type === 'checkbox' || element.type === 'radio') {
    return element.checked;
  }
  if (element.type === 'number') {
    return Number.isFinite(element.valueAsNumber) ? element.valueAsNumber : '';
  }
  return element.value;
}

// 清除本机保存的全部翻译缓存（兼容 v1/v2 前缀），不触碰 API Key 等其他 local 数据。
function clearTranslationCache() {
  const button = document.getElementById('clearTranslationCache');
  const defaultLabel = button.dataset.defaultLabel || button.textContent;
  button.dataset.defaultLabel = defaultLabel;

  const finish = label => {
    button.disabled = false;
    button.textContent = label;
    clearTimeout(cacheClearTimeout);
    cacheClearTimeout = setTimeout(() => {
      button.textContent = defaultLabel;
    }, 1400);
  };

  button.disabled = true;
  chrome.storage.local.get(null, items => {
    if (chrome.runtime.lastError) {
      console.error('[AnonTranslator II] Failed to read translation cache:', chrome.runtime.lastError.message);
      finish('清除失败');
      return;
    }

    const cacheKeys = Object.keys(items || {}).filter(key => key.startsWith(TRANSLATION_CACHE_KEY_PREFIX));
    if (cacheKeys.length === 0) {
      finish('没有可清除的缓存');
      return;
    }

    chrome.storage.local.remove(cacheKeys, () => {
      if (chrome.runtime.lastError) {
        console.error('[AnonTranslator II] Failed to clear translation cache:', chrome.runtime.lastError.message);
        finish('清除失败');
        return;
      }
      finish(`已清除 ${cacheKeys.length} 条`);
    });
  });
}

function showSaveState(text, className) {
  const saveButton = document.querySelector('.save');
  clearTimeout(saveStateTimeout);
  saveButton.classList.remove('saved', 'error');
  saveButton.classList.add(className);
  saveButton.textContent = text;
  saveStateTimeout = setTimeout(() => {
    saveButton.classList.remove('saved', 'error');
    saveButton.textContent = 'save';
  }, 1400);
}

function saveSettings() {
  const syncSettings = {};
  const localSettings = {};
  const elements = document.getElementById('settingsForm').elements;
  const saveButton = document.querySelector('.save');

  Array.from(elements).forEach(element => {
    if (!element.id || element.classList.contains('tab') || element.tagName === 'BUTTON') return;
    if (element.id === 'pluginSwitch') return;

    const target = LOCAL_ONLY_FIELDS.has(element.id) ? localSettings : syncSettings;
    let value = getElementValue(element);
    if (LOCAL_ONLY_FIELDS.has(element.id) && typeof value === 'string') {
      value = value.trim();
    }
    if (NUMERIC_FIELDS.has(element.id)) {
      value = Number(value);
    }
    target[element.id] = value;
  });

  saveButton.disabled = true;
  let pendingWrites = 2;
  const errors = [];
  const handleWriteComplete = areaName => {
    if (chrome.runtime.lastError) {
      errors.push(`${areaName}: ${chrome.runtime.lastError.message}`);
    }
    pendingWrites -= 1;
    if (pendingWrites === 0) {
      saveButton.disabled = false;
      if (errors.length > 0) {
        console.error('[AnonTranslator II] Failed to save settings:', errors.join('; '));
        showSaveState('error', 'error');
      } else {
        showSaveState('√', 'saved');
      }
    }
  };

  chrome.storage.sync.set(syncSettings, () => handleWriteComplete('sync'));
  chrome.storage.local.set(localSettings, () => handleWriteComplete('local'));
}
