const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const contentSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');
const defaultSettings = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'defaultSettings.json'), 'utf8')
);

const unhandledRejections = [];
process.on('unhandledRejection', error => unhandledRejections.push(error));

function createLocalStorageArea(store) {
  return {
    get(keys, callback) {
      if (keys === null) {
        callback({ ...store });
        return;
      }
      const requested = Array.isArray(keys) ? keys : [keys];
      callback(Object.fromEntries(requested.map(key => [key, store[key]])));
    },
    set(values, callback) {
      Object.assign(store, values);
      if (callback) callback();
    },
    remove(keys, callback) {
      (Array.isArray(keys) ? keys : [keys]).forEach(key => delete store[key]);
      if (callback) callback();
    }
  };
}

// 在 jsdom 中加载 content.js，模拟 chrome.* 环境，返回可交互的页面句柄。
function loadPage({
  html,
  url = 'https://example.com/novel/1',
  settings = {},
  localStore = {},
  localAreaOverrides = null,
  translateImpl = null
} = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html lang="ja"><body>${html}</body></html>`, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const pageSettings = {
    ...defaultSettings,
    pluginSwitch: true,
    copy: false,
    deepseek: true,
    deepseekFrom: 'ja',
    deepseekTo: 'zh-CN',
    translationCache: false,
    ...settings
  };
  const translateCalls = [];
  const storageChangeListeners = [];

  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message?.type === 'getSettings') {
          if (callback) callback({ ...pageSettings });
          return;
        }
        if (message?.action === 'translate') {
          translateCalls.push(message);
          if (translateImpl) {
            translateImpl(message, callback);
            return;
          }
          if (callback) {
            callback({
              ok: true,
              translatedText: `译:${message.text}`,
              provider: message.translator,
              furiganaAnnotations: []
            });
          }
        }
      }
    },
    storage: {
      sync: {
        get(_keys, callback) { callback({ ...pageSettings }); },
        set(_values, callback) { if (callback) callback(); }
      },
      local: localAreaOverrides || createLocalStorageArea(localStore),
      onChanged: {
        addListener(listener) { storageChangeListeners.push(listener); }
      }
    }
  };

  // jsdom 的 Range 没有布局信息，补齐折叠按钮定位用到的接口。
  if (typeof window.Range.prototype.getClientRects !== 'function') {
    window.Range.prototype.getClientRects = function () { return []; };
  }
  if (typeof window.Range.prototype.getBoundingClientRect !== 'function') {
    window.Range.prototype.getBoundingClientRect = function () {
      return { left: 40, right: 180, top: 40, bottom: 60, width: 140, height: 20 };
    };
  }

  window.eval(contentSource);
  return {
    dom,
    window,
    document: window.document,
    translateCalls,
    localStore,
    changeSyncSetting(key, value) {
      pageSettings[key] = value;
      storageChangeListeners.forEach(listener => listener({
        [key]: { oldValue: undefined, newValue: value }
      }, 'sync'));
    }
  };
}

function click(window, element) {
  element.dispatchEvent(new window.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    view: window
  }));
}

function flush(ms = 40) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function selectText(
  window,
  startNode,
  startOffset,
  endNode = startNode,
  endOffset = null,
  complete = true
) {
  const range = window.document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset ?? endNode.nodeValue.length);
  range.getClientRects = () => [{
    left: 40,
    right: 180,
    top: 40,
    bottom: 60,
    width: 140,
    height: 20
  }];
  range.getBoundingClientRect = () => range.getClientRects()[0];
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  window.document.dispatchEvent(new window.Event('selectionchange'));
  if (complete) {
    window.document.dispatchEvent(new window.MouseEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      button: 0,
      view: window
    }));
  }
}

function translationTextOf(tag) {
  const translationDiv = tag.querySelector(':scope > .anontranslator-translation');
  return translationDiv ? translationDiv.textContent : null;
}

(async () => {
  // 点击普通段落：发送翻译请求并渲染结果；未用到提示时不注入通知元素。
  {
    const page = loadPage({ html: '<p id="p1">今日はいい天気だ。</p>' });
    assert.equal(
      page.document.getElementById('anontranslator-copy-notification'),
      null,
      'notification element must not be injected before it is needed'
    );

    const p1 = page.document.getElementById('p1');
    click(page.window, p1);
    await flush();

    assert.equal(page.translateCalls.length, 1);
    assert.equal(page.translateCalls[0].text, '今日はいい天気だ。');
    assert.equal(page.translateCalls[0].translator, 'deepseek');
    assert.equal(page.translateCalls[0].model, defaultSettings.deepseekModel);
    assert.ok(
      translationTextOf(p1).includes('译:今日はいい天気だ。'),
      'translation should be rendered inside the clicked paragraph'
    );
    assert.ok(
      page.document.querySelector('.anontranslator-translation-toggle'),
      'translation toggle button should be created'
    );
    assert.equal(
      page.document.getElementById('anontranslator-copy-notification'),
      null,
      'a fresh translation without copy must not create the toast element'
    );
    assert.equal(Object.keys(page.localStore).length, 0, 'cache disabled: nothing persisted');

    // 折叠开关：点一下收起，再点一下展开。
    const toggle = page.document.querySelector('.anontranslator-translation-toggle');
    const translationDiv = p1.querySelector(':scope > .anontranslator-translation');
    click(page.window, toggle);
    assert.ok(translationDiv.classList.contains('anontranslator-translation-collapsed'));
    click(page.window, toggle);
    assert.ok(!translationDiv.classList.contains('anontranslator-translation-collapsed'));
    page.dom.window.close();
  }

  // 整段被同一对引号包裹：剥离后翻译，结果重新包裹。
  {
    const page = loadPage({ html: '<p id="quoted">「おはよう」</p>' });
    click(page.window, page.document.getElementById('quoted'));
    await flush();

    assert.equal(page.translateCalls[0].text, 'おはよう');
    const rendered = page.document.querySelector('#quoted [data-translation-provider="deepseek"]');
    assert.equal(rendered.textContent, '「译:おはよう」');
    page.dom.window.close();
  }

  // 多段引号（轻小说连续对话）不能被误剥离首尾字符。
  {
    const page = loadPage({ html: '<p id="multi">「おはよう」「こんにちは」</p>' });
    click(page.window, page.document.getElementById('multi'));
    await flush();

    assert.equal(
      page.translateCalls[0].text,
      '「おはよう」「こんにちは」',
      'consecutive quoted sentences must be sent unmodified'
    );
    page.dom.window.close();
  }

  // 嵌套引号仍按整段包裹处理。
  {
    const page = loadPage({ html: '<p id="nested">「彼は「はい」と答えた」</p>' });
    click(page.window, page.document.getElementById('nested'));
    await flush();

    assert.equal(page.translateCalls[0].text, '彼は「はい」と答えた');
    page.dom.window.close();
  }

  // 句子拆分：点击后拆成句子 span，切换段落时还原原始节点且保留翻译。
  {
    const page = loadPage({
      html: '<p id="s1">一文目。二文目。</p><p id="s2">別の段落。</p>',
      settings: { sentenceThreshold: 4 }
    });
    const s1 = page.document.getElementById('s1');
    const s2 = page.document.getElementById('s2');

    click(page.window, s1);
    await flush();
    const sentences = s1.querySelectorAll('.anontranslator-sentence');
    assert.equal(sentences.length, 2, 'paragraph should split into sentence spans');
    assert.equal(
      Array.from(sentences).map(span => span.textContent).join(''),
      '一文目。二文目。',
      'splitting must not alter the visible text'
    );

    click(page.window, s2);
    await flush();
    assert.equal(
      s1.querySelectorAll('.anontranslator-sentence').length,
      0,
      'previous paragraph should be restored to its original nodes'
    );
    assert.ok(translationTextOf(s1).includes('译:'), 'translation preserved after switching paragraphs');
    assert.ok(translationTextOf(s2).includes('译:別の段落。'));
    page.dom.window.close();
  }

  // 段落识别：div 叶子可翻译；含段落标签的容器让位给内部段落。
  {
    const page = loadPage({
      html: '<div id="leaf">divだけの本文。</div><div id="wrap"><p id="inner">内側の段落。</p></div>'
    });
    const leaf = page.document.getElementById('leaf');
    const wrap = page.document.getElementById('wrap');
    const inner = page.document.getElementById('inner');

    click(page.window, leaf);
    await flush();
    assert.ok(translationTextOf(leaf).includes('译:divだけの本文。'));

    click(page.window, inner);
    await flush();
    assert.ok(translationTextOf(inner).includes('译:内側の段落。'));
    assert.equal(
      wrap.querySelector(':scope > .anontranslator-translation'),
      null,
      'container with paragraph children must not be treated as a paragraph'
    );

    const callsBefore = page.translateCalls.length;
    click(page.window, wrap);
    await flush();
    assert.equal(page.translateCalls.length, callsBefore, 'clicking the container itself does nothing');
    page.dom.window.close();
  }

  // 翻译缓存：首次写入 v2 条目并清理 v1 旧格式；二次加载零请求命中并弹缓存提示。
  {
    const legacyKey = 'anontranslator.translationCache.v1:legacy';
    const store = { [legacyKey]: { createdAt: Date.now() } };
    const html = '<p id="c1">キャッシュ対象の文。</p>';

    const page1 = loadPage({ html, settings: { translationCache: true }, localStore: store });
    click(page1.window, page1.document.getElementById('c1'));
    await flush();

    assert.equal(page1.translateCalls.length, 1);
    const v2Keys = Object.keys(store).filter(key =>
      key.startsWith('anontranslator.translationCache.v2:')
    );
    assert.equal(v2Keys.length, 1, 'a fresh translation should be cached with the v2 prefix');
    assert.equal(store[v2Keys[0]].translatedText, '译:キャッシュ対象の文。');
    assert.ok(!(legacyKey in store), 'legacy v1 entries should be pruned after a write');
    page1.dom.window.close();

    const page2 = loadPage({ html, settings: { translationCache: true }, localStore: store });
    click(page2.window, page2.document.getElementById('c1'));
    await flush();

    assert.equal(page2.translateCalls.length, 0, 'second visit should render from cache without a request');
    assert.ok(
      translationTextOf(page2.document.getElementById('c1')).includes('译:キャッシュ対象の文。')
    );
    const toast = page2.document.getElementById('anontranslator-copy-notification');
    assert.ok(toast, 'cache hit should lazily create the toast element');
    assert.equal(toast.textContent, '已读取缓存');
    page2.dom.window.close();
  }

  // 扩展被更新/重载后（孤儿脚本）：sendMessage 同步抛错时渲染错误提示，而不是留下空框。
  {
    const page = loadPage({
      html: '<p id="o1">孤児スクリプトの検証。</p>',
      translateImpl: () => {
        throw new Error('Extension context invalidated.');
      }
    });
    click(page.window, page.document.getElementById('o1'));
    await flush();

    const errorDiv = page.document.querySelector('#o1 .anontranslator-translation-error');
    assert.ok(errorDiv, 'orphaned content script must render an error instead of an empty box');
    assert.ok(errorDiv.textContent.includes('刷新'), 'error message should tell the user to refresh');
    page.dom.window.close();
  }

  // 孤儿脚本的另一路径：chrome.storage 同步抛错时缓存读写降级，翻译仍然完成。
  {
    const throwingArea = {
      get() { throw new Error('Extension context invalidated.'); },
      set() { throw new Error('Extension context invalidated.'); },
      remove() { throw new Error('Extension context invalidated.'); }
    };
    const page = loadPage({
      html: '<p id="st1">ストレージ障害の検証。</p>',
      settings: { translationCache: true },
      localAreaOverrides: throwingArea
    });
    click(page.window, page.document.getElementById('st1'));
    await flush();

    assert.ok(
      translationTextOf(page.document.getElementById('st1')).includes('译:ストレージ障害の検証。'),
      'storage failures must not block translation'
    );
    page.dom.window.close();
  }

  // 常规模式：段落点击完全不接管；任意选区显示按钮并只翻译选中的文本。
  {
    const page = loadPage({
      html: '<p id="g1">Translate only this phrase.</p><p id="g2">Second paragraph.</p>',
      settings: {
        translationMode: 'general',
        deepseekFrom: 'auto',
        deepseekTo: 'zh-CN'
      }
    });
    const g1 = page.document.getElementById('g1');
    const g2 = page.document.getElementById('g2');

    click(page.window, g1);
    await flush();
    assert.equal(page.translateCalls.length, 0, 'general mode must not translate paragraph clicks');
    assert.equal(g1.classList.contains('anontranslator-selected'), false);
    assert.equal(g1.querySelector('.anontranslator-sentence'), null);

    selectText(page.window, g1.firstChild, 0, g1.firstChild, 14, false);
    await flush();
    assert.equal(
      page.document.querySelector('.anontranslator-general-action'),
      null,
      'the translate action must stay hidden while the pointer selection is still changing'
    );
    page.document.dispatchEvent(new page.window.MouseEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      button: 0,
      view: page.window
    }));
    await flush();
    const action = page.document.querySelector('.anontranslator-general-action');
    assert.ok(action, 'a non-empty page selection should show the translate action');
    click(page.window, action);
    await flush();

    assert.equal(page.translateCalls.length, 1);
    assert.equal(page.translateCalls[0].text, 'Translate only');
    assert.equal(page.translateCalls[0].mode, 'general');
    assert.ok(
      page.document.querySelector('.anontranslator-general-card').textContent.includes('译:Translate only')
    );
    assert.equal(
      page.document.querySelector('.anontranslator-furigana-source-line'),
      null,
      'general translation never renders furigana'
    );
    page.document.dispatchEvent(new page.window.Event('selectionchange'));
    await flush();
    assert.equal(
      page.document.querySelector('.anontranslator-general-action'),
      null,
      'the action must stay hidden while the same selection already has a result card'
    );

    // 新的跨段选区替换旧卡片；Esc 清理全部常规模式 UI。
    selectText(page.window, g1.firstChild, 10, g2.firstChild, 6);
    await flush();
    assert.equal(page.document.querySelector('.anontranslator-general-card'), null);
    assert.ok(page.document.querySelector('.anontranslator-general-action'));
    page.document.dispatchEvent(new page.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true
    }));
    page.document.dispatchEvent(new page.window.KeyboardEvent('keyup', {
      key: 'Escape', bubbles: true
    }));
    await flush();
    assert.equal(page.document.querySelector('.anontranslator-general-action'), null);
    assert.equal(page.document.querySelector('.anontranslator-general-card'), null);
    page.dom.window.close();
  }

  // 常规模式忽略可编辑区域，避免接管表单或编辑器里的选择。
  {
    const page = loadPage({
      html: '<div id="editor" contenteditable="true">Editable English text</div>',
      settings: { translationMode: 'general' }
    });
    const text = page.document.getElementById('editor').firstChild;
    selectText(page.window, text, 0, text, 8);
    await flush();
    assert.equal(page.document.querySelector('.anontranslator-general-action'), null);
    page.dom.window.close();
  }

  // 模式即时切换：清理轻小说交互状态、保留已有译文，并启用选区翻译。
  {
    const page = loadPage({
      html: '<p id="m1">一つ目の段落。</p><p id="m2">General selection text.</p>'
    });
    const m1 = page.document.getElementById('m1');
    const m2 = page.document.getElementById('m2');
    click(page.window, m1);
    await flush();
    assert.equal(page.translateCalls.length, 1);
    assert.ok(translationTextOf(m1));

    page.changeSyncSetting('translationMode', 'general');
    await flush();
    assert.ok(translationTextOf(m1), 'existing novel translation should remain visible');
    assert.equal(m1.classList.contains('anontranslator-selected'), false);

    click(page.window, m2);
    await flush();
    assert.equal(page.translateCalls.length, 1, 'paragraph clicks stop after switching mode');
    selectText(page.window, m2.firstChild, 0, m2.firstChild, 7);
    await flush();
    click(page.window, page.document.querySelector('.anontranslator-general-action'));
    await flush();
    assert.equal(page.translateCalls.length, 2);
    assert.equal(page.translateCalls[1].mode, 'general');

    page.changeSyncSetting('translationMode', 'novel');
    assert.equal(page.document.querySelector('.anontranslator-general-card'), null);
    page.dom.window.close();
  }

  // 相同文本在轻小说与常规模式使用不同缓存；常规模式自身可再次命中。
  {
    const store = {};
    const html = '<p id="cache-mode">Same text</p>';
    const novel = loadPage({ html, settings: { translationCache: true }, localStore: store });
    click(novel.window, novel.document.getElementById('cache-mode'));
    await flush();
    assert.equal(novel.translateCalls.length, 1);
    novel.dom.window.close();

    const general1 = loadPage({
      html,
      settings: { translationMode: 'general', translationCache: true },
      localStore: store
    });
    selectText(general1.window, general1.document.getElementById('cache-mode').firstChild, 0);
    await flush();
    click(general1.window, general1.document.querySelector('.anontranslator-general-action'));
    await flush();
    assert.equal(general1.translateCalls.length, 1, 'general mode must not reuse novel cache');
    general1.dom.window.close();

    const general2 = loadPage({
      html,
      settings: { translationMode: 'general', translationCache: true },
      localStore: store
    });
    selectText(general2.window, general2.document.getElementById('cache-mode').firstChild, 0);
    await flush();
    click(general2.window, general2.document.querySelector('.anontranslator-general-action'));
    await flush();
    assert.equal(general2.translateCalls.length, 0, 'general mode should reuse its own cache');
    assert.ok(general2.document.querySelector('.anontranslator-general-card').textContent.includes('译:Same text'));
    general2.dom.window.close();
  }

  // 总开关关闭：不响应点击，也不向页面注入任何节点。
  {
    const page = loadPage({
      html: '<p id="off1">無効時の段落。</p>',
      settings: { pluginSwitch: false }
    });
    click(page.window, page.document.getElementById('off1'));
    await flush();

    assert.equal(page.translateCalls.length, 0);
    assert.equal(page.document.querySelector('.anontranslator-translation'), null);
    assert.equal(page.document.getElementById('anontranslator-copy-notification'), null);

    // popup 保存开关后，当前页面通过 storage 事件立即启停，无需刷新。
    page.changeSyncSetting('pluginSwitch', true);
    click(page.window, page.document.getElementById('off1'));
    await flush();
    assert.equal(page.translateCalls.length, 1);
    assert.ok(page.document.querySelector('.anontranslator-translation'));
    page.changeSyncSetting('pluginSwitch', false);
    assert.equal(page.document.querySelector('.anontranslator-translation'), null);
    click(page.window, page.document.getElementById('off1'));
    await flush();
    assert.equal(page.translateCalls.length, 1, 'turning off should stop translation immediately');
    page.dom.window.close();
  }

  await flush();
  assert.deepEqual(unhandledRejections, [], 'content script must not leak unhandled rejections');
  console.log('content tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
