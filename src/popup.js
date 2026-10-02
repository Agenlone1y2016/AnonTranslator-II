/* popup.js */

const LOCAL_ONLY_FIELDS = new Set(['deepseekApiKey']);
// select 控件的 value 是字符串，这些设置在存储里统一保存为数字。
const NUMERIC_FIELDS = new Set(['translationCacheDays']);
// 这些设置在切换时立即保存，不计入“未保存的更改”。
const AUTO_SAVED_FIELDS = new Set(['pluginSwitch', 'translationMode']);
const TRANSLATION_CACHE_KEY_PREFIX = 'anontranslator.translationCache.';
const STYLE_PREVIEW_PROPERTIES = {
  borderWidth: '--pv-width',
  borderStyle: '--pv-style',
  borderRadius: '--pv-radius',
  freeBorderColor: '--pv-free',
  selectedBorderColor: '--pv-selected',
  sentenceColor: '--pv-sentence'
};
const ENGINE_COLOR_CARDS = {
  googleColor: 'engineGoogle',
  deepseekColor: 'engineDeepSeek'
};
let saveStateTimeout;
let cacheClearTimeout;
let hasUnsavedChanges = false;
let changeRevision = 0;
document.getElementById('extensionVersion').textContent = `v${chrome.runtime.getManifest().version}`;

function updatePluginState(isPluginOn) {
  const header = document.querySelector('.app-header');
  header.classList.toggle('plugin-on', isPluginOn);
  header.classList.toggle('plugin-off', !isPluginOn);
  document.getElementById('pluginState').textContent = isPluginOn ? '已开启' : '已关闭';
}

document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  renderSaveStatus();
  loadSettings();

  const form = document.getElementById('settingsForm');
  form.addEventListener('submit', event => {
    event.preventDefault();
    saveSettings();
  });
  form.addEventListener('input', handleFormEdit);

  document.getElementById('pluginSwitch').addEventListener('change', event => {
    persistPluginSwitch(event.target.checked);
  });

  document.getElementById('translationMode').addEventListener('change', event => {
    persistTranslationMode(event.target.value);
  });

  document.getElementById('clearTranslationCache').addEventListener('click', clearTranslationCache);
});

function setupTabs() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const panels = document.querySelector('.panels');
  const selectTab = (selectedTab, focus = false) => {
    for (const tab of tabs) {
      const isSelected = tab === selectedTab;
      tab.setAttribute('aria-selected', String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !isSelected;
    }
    panels.scrollTop = 0;
    if (focus) selectedTab.focus();
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      const offset = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
      if (!offset) return;
      event.preventDefault();
      selectTab(tabs[(index + offset + tabs.length) % tabs.length], true);
    });
  });
}

function handleFormEdit(event) {
  const target = event.target;
  if (AUTO_SAVED_FIELDS.has(target.id) || AUTO_SAVED_FIELDS.has(target.name)) return;
  updatePreviews();
  changeRevision += 1;
  hasUnsavedChanges = true;
  clearTimeout(saveStateTimeout);
  renderSaveStatus();
}

// 让样式预览和引擎色点跟随当前表单值。
function updatePreviews() {
  const preview = document.getElementById('stylePreview');
  for (const [id, property] of Object.entries(STYLE_PREVIEW_PROPERTIES)) {
    preview.style.setProperty(property, document.getElementById(id).value);
  }
  for (const [id, cardId] of Object.entries(ENGINE_COLOR_CARDS)) {
    document.getElementById(cardId).style.setProperty('--engine-color', document.getElementById(id).value);
  }
}

function applySettingsToForm(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const radios = document.querySelectorAll(`input[type="radio"][name="${key}"]`);
    if (radios.length > 0) {
      radios.forEach(radio => { radio.checked = radio.value === value; });
      continue;
    }

    const element = document.getElementById(key);
    if (!element) continue;

    if (element.type === 'checkbox') {
      element.checked = Boolean(value);
    } else if (element.tagName === 'INPUT' || element.tagName === 'SELECT') {
      element.value = value ?? '';
    }
  }
  updatePreviews();
}

function persistTranslationMode(mode) {
  const normalizedMode = mode === 'general' ? 'general' : 'novel';
  chrome.storage.sync.set({ translationMode: normalizedMode }, () => {
    if (chrome.runtime.lastError) {
      console.error('[AnonTranslator II] Failed to switch translation mode:', chrome.runtime.lastError.message);
      showSaveState('模式切换失败', 'error');
      return;
    }
    showSaveState(normalizedMode === 'general' ? '已切换到常规翻译' : '已切换到日语轻小说', 'saved');
  });
}

function persistPluginSwitch(isPluginOn) {
  const pluginSwitch = document.getElementById('pluginSwitch');
  pluginSwitch.disabled = true;
  updatePluginState(isPluginOn);
  // 只保存开关，避免顺带提交其他尚未保存的设置。
  chrome.storage.sync.set({ pluginSwitch: isPluginOn }, () => {
    pluginSwitch.disabled = false;
    if (chrome.runtime.lastError) {
      console.error('[AnonTranslator II] Failed to switch plugin:', chrome.runtime.lastError.message);
      pluginSwitch.checked = !isPluginOn;
      updatePluginState(!isPluginOn);
      showSaveState('切换失败', 'error');
      return;
    }
    showSaveState(isPluginOn ? '已开启' : '已关闭', 'saved');
  });
}

function loadSettings() {
  const applyLoadedSettings = settings => {
    applySettingsToForm({ translationMode: 'novel', ...settings });
    document.getElementById('pluginSwitch').disabled = false;
    updatePluginState(Boolean(settings.pluginSwitch));
  };

  // 优先读取后台合并好的“默认值 + 已保存值”，后台不可用时退回同步存储。
  chrome.runtime.sendMessage({ type: 'getSettings' }, settings => {
    if (!chrome.runtime.lastError && settings && !settings.error) {
      applyLoadedSettings(settings);
      return;
    }
    chrome.storage.sync.get(null, syncSettings => {
      if (chrome.runtime.lastError) {
        console.error('[AnonTranslator II] Failed to load sync settings:', chrome.runtime.lastError.message);
        showSaveState('读取设置失败', 'error');
        return;
      }
      applyLoadedSettings(syncSettings);
    });
  });

  chrome.storage.local.get(['deepseekApiKey'], localSettings => {
    if (chrome.runtime.lastError) {
      console.error('[AnonTranslator II] Failed to load local settings:', chrome.runtime.lastError.message);
      showSaveState('读取设置失败', 'error');
      return;
    }
    applySettingsToForm(localSettings);
  });
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
      finish('暂无缓存');
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

// 底栏空闲时提示是否有未保存的更改。
function renderSaveStatus() {
  const status = document.getElementById('saveStatus');
  status.dataset.state = hasUnsavedChanges ? 'dirty' : '';
  status.textContent = hasUnsavedChanges ? '有未保存的更改' : '开关和模式会自动保存';
}

function showSaveState(text, state) {
  const status = document.getElementById('saveStatus');
  clearTimeout(saveStateTimeout);
  status.dataset.state = state;
  status.textContent = text;
  saveStateTimeout = setTimeout(renderSaveStatus, 1600);
}

function saveSettings() {
  const syncSettings = {};
  const localSettings = {};
  const elements = document.getElementById('settingsForm').elements;
  const saveButton = document.querySelector('.save');
  const savedRevision = changeRevision;

  // 已即时保存的开关和模式单选框（无 id）不重复提交。
  Array.from(elements).forEach(element => {
    if (!element.id || element.tagName === 'BUTTON' || AUTO_SAVED_FIELDS.has(element.id)) return;

    let value = element.type === 'checkbox' ? element.checked : element.value;
    if (LOCAL_ONLY_FIELDS.has(element.id)) {
      localSettings[element.id] = value.trim();
      return;
    }
    if (NUMERIC_FIELDS.has(element.id)) {
      value = Number(value);
    }
    syncSettings[element.id] = value;
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
        showSaveState('保存失败，请重试', 'error');
      } else {
        // 保存期间又有新的编辑时，仍保留未保存提示。
        if (changeRevision === savedRevision) hasUnsavedChanges = false;
        showSaveState('已保存', 'saved');
      }
    }
  };

  chrome.storage.sync.set(syncSettings, () => handleWriteComplete('sync'));
  chrome.storage.local.set(localSettings, () => handleWriteComplete('local'));
}
