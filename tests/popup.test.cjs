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
  document.getElementById('sentenceThreshold').value = '0';
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
  assert.ok(document.querySelector('.upper-part').classList.contains('plugin-on'));

  popup.input.click();
  assert.deepEqual(popup.syncWrites[1], { pluginSwitch: false });
  popup.completeWrite();
  assert.equal(popup.store.pluginSwitch, false);
  assert.ok(document.querySelector('.upper-part').classList.contains('plugin-off'));

  // 存储失败必须回退开关和背景，并让用户重试。
  popup.input.click();
  popup.completeWrite('storage quota exceeded');
  assert.equal(popup.store.pluginSwitch, false);
  assert.equal(popup.input.checked, false);
  assert.equal(popup.input.disabled, false);
  assert.ok(document.querySelector('.upper-part').classList.contains('plugin-off'));
  assert.equal(document.querySelector('.save').textContent, '切换失败');
  popup.input.click();
  popup.completeWrite();
  assert.equal(popup.store.pluginSwitch, true);

  // 其他设置仍可保存，不重复写入已即时保存的总开关，也不改变其背景。
  document.getElementById('sentenceThreshold').value = '80';
  document.getElementById('settingsForm').dispatchEvent(new popup.window.Event('submit', { cancelable: true }));
  const manualWrite = popup.syncWrites.at(-1);
  assert.equal(Object.hasOwn(manualWrite, 'pluginSwitch'), false);
  assert.equal(Object.hasOwn(manualWrite, 'deepseekApiKey'), false);
  assert.equal(manualWrite.sentenceThreshold, 80);
  assert.deepEqual(popup.localWrites, [{ deepseekApiKey: 'unsaved-key' }]);
  popup.completeWrite();
  assert.ok(document.querySelector('.upper-part').classList.contains('plugin-on'));
  popup.dom.window.close();

  // 关闭再打开，以及后台不可用时的存储回退，都应恢复已保存的开启状态。
  for (const failLoad of [false, true]) {
    const reopened = await loadPopup({ settings: popup.store, failLoad });
    assert.equal(reopened.input.checked, true);
    assert.equal(reopened.input.disabled, false);
    reopened.input.click();
    reopened.completeWrite('storage unavailable');
    assert.equal(reopened.input.checked, true, 'failed OFF writes should also restore the previous state');
    assert.ok(reopened.window.document.querySelector('.upper-part').classList.contains('plugin-on'));
    reopened.dom.window.close();
  }
  console.log('popup tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
