const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('popup.html', 'utf8');
const source = fs.readFileSync('src/popup.js', 'utf8');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const defaults = JSON.parse(fs.readFileSync('config/defaultSettings.json', 'utf8'));

async function loadPopup({ settings = {}, failLoad = false, deferLoad = false } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  const store = { ...defaults, ...settings };
  const syncWrites = [];
  const localWrites = [];
  const pendingWrites = [];
  let completeLoad;
  window.console.error = () => {};
  window.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => manifest,
      sendMessage(_message, callback) {
        completeLoad = () => callback(failLoad ? { error: 'worker unavailable' } : { ...store });
        if (!deferLoad) completeLoad();
      }
    },
    storage: {
      sync: {
        get(_keys, callback) { callback({ ...store }); },
        set(values, callback) {
          syncWrites.push({ ...values });
          pendingWrites.push({ values, callback });
        }
      },
      local: {
        get(_keys, callback) { callback({ deepseekApiKey: 'saved-key' }); },
        set(values, callback) { localWrites.push({ ...values }); callback(); }
      }
    }
  };
  window.eval(source);
  await new Promise(resolve => window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  return {
    dom, window, store, syncWrites, localWrites,
    input: window.document.getElementById('pluginSwitch'),
    completeLoad: () => completeLoad(),
    completeWrite(error = null) {
      const write = pendingWrites.shift();
      assert.ok(write, 'there must be a pending storage write');
      if (!error) Object.assign(store, write.values);
      window.chrome.runtime.lastError = error ? { message: error } : null;
      write.callback();
      window.chrome.runtime.lastError = null;
    }
  };
}

(async () => {
  // 只切换开关就立即发起持久化，其他未保存设置和 API key 不应被提交。
  const popup = await loadPopup({ deferLoad: true });
  assert.equal(popup.input.disabled, true, 'wait for the actual stored state before allowing changes');
  popup.completeLoad();
  assert.equal(popup.input.disabled, false);
  const { document } = popup.window;
  document.getElementById('borderWidth').value = '9px';
  document.getElementById('deepseekApiKey').value = 'unsaved-key';
  popup.input.click();
  assert.deepEqual(popup.syncWrites, [{ pluginSwitch: true }]);
  assert.deepEqual(popup.localWrites, []);
  assert.equal(popup.input.disabled, true);
  popup.input.click();
  assert.equal(popup.syncWrites.length, 1, 'a pending write must not be overtaken by another click');
  popup.completeWrite();
  assert.equal(popup.store.pluginSwitch, true);
  assert.equal(popup.input.disabled, false);
  assert.ok(document.querySelector('.app-header').classList.contains('plugin-on'));

  popup.input.click();
  assert.deepEqual(popup.syncWrites[1], { pluginSwitch: false });
  popup.completeWrite();
  assert.equal(popup.store.pluginSwitch, false);
  assert.ok(document.querySelector('.app-header').classList.contains('plugin-off'));

  // 存储失败必须回退开关和背景，并让用户重试。
  popup.input.click();
  popup.completeWrite('storage quota exceeded');
  assert.equal(popup.store.pluginSwitch, false);
  assert.equal(popup.input.checked, false);
  assert.equal(popup.input.disabled, false);
  assert.ok(document.querySelector('.app-header').classList.contains('plugin-off'));
  assert.equal(document.getElementById('saveStatus').textContent, '切换失败');
  popup.input.click();
  popup.completeWrite();
  assert.equal(popup.store.pluginSwitch, true);

  // 模式卡片立即单独保存，不算作未保存的更改。
  const status = document.getElementById('saveStatus');
  assert.notEqual(status.dataset.state, 'dirty');
  document.querySelector('input[name="translationMode"][value="general"]').click();
  assert.deepEqual(popup.syncWrites.at(-1), { translationMode: 'general' });
  popup.completeWrite();
  assert.equal(popup.store.translationMode, 'general');
  assert.equal(status.dataset.state, 'saved');

  // 普通设置的编辑会提示未保存，保存成功后提示消失。
  const borderWidth = document.getElementById('borderWidth');
  borderWidth.value = '3px';
  borderWidth.dispatchEvent(new popup.window.Event('input', { bubbles: true }));
  assert.equal(status.dataset.state, 'dirty');

  // 其他设置仍可保存，不重复写入已即时保存的总开关，也不改变其背景。
  document.getElementById('settingsForm').dispatchEvent(new popup.window.Event('submit', { cancelable: true }));
  const manualWrite = popup.syncWrites.at(-1);
  assert.equal(Object.hasOwn(manualWrite, 'pluginSwitch'), false);
  assert.equal(Object.hasOwn(manualWrite, 'deepseekApiKey'), false);
  assert.equal(manualWrite.borderWidth, '3px');
  assert.equal(Object.hasOwn(manualWrite, 'translationMode'), false, 'auto-saved mode is not resubmitted');
  assert.equal(Object.keys(manualWrite).some(key => /^tab|^panel/.test(key)), false);
  assert.deepEqual(popup.localWrites, [{ deepseekApiKey: 'unsaved-key' }]);
  popup.completeWrite();
  assert.equal(status.dataset.state, 'saved');
  assert.ok(document.querySelector('.app-header').classList.contains('plugin-on'));

  // 标签页一次只显示一个面板。
  document.getElementById('tabStyle').click();
  assert.equal(document.getElementById('panelStyle').hidden, false);
  assert.equal(document.getElementById('panelReading').hidden, true);
  assert.equal(document.getElementById('tabStyle').getAttribute('aria-selected'), 'true');
  popup.dom.window.close();

  // 关闭再打开，以及后台不可用时的存储回退，都应恢复已保存的开启状态。
  for (const failLoad of [false, true]) {
    const reopened = await loadPopup({ settings: popup.store, failLoad });
    assert.equal(reopened.input.checked, true);
    assert.equal(reopened.input.disabled, false);
    assert.equal(
      reopened.window.document.querySelector('input[name="translationMode"]:checked').value,
      'general',
      'the saved translation mode should be selected on reopen'
    );
    reopened.input.click();
    reopened.completeWrite('storage unavailable');
    assert.equal(reopened.input.checked, true, 'failed OFF writes should also restore the previous state');
    assert.ok(reopened.window.document.querySelector('.app-header').classList.contains('plugin-on'));
    reopened.dom.window.close();
  }
  console.log('popup tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
