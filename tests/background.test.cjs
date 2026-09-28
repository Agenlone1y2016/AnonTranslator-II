const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('src/background.js', 'utf8');
const toolbar = {};
const storageReads = [];
const storageListeners = [];
const startupListeners = [];
const installedListeners = [];
let toolbarUpdates = 0;
const chrome = {
  action: {
    setBadgeText({ text }, callback) { toolbar.text = text; toolbarUpdates += 1; callback(); },
    setBadgeBackgroundColor({ color }, callback) { toolbar.color = color; callback(); },
    setTitle({ title }, callback) { toolbar.title = title; callback(); }
  },
  runtime: {
    lastError: null,
    getURL: path => path,
    onInstalled: { addListener(listener) { installedListeners.push(listener); } },
    onStartup: { addListener(listener) { startupListeners.push(listener); } },
    onMessage: { addListener() {} }
  },
  storage: {
    onChanged: { addListener(listener) { storageListeners.push(listener); } },
    sync: {
      get(_keys, callback) { storageReads.push(callback); },
      set() {},
      remove() {}
    },
    local: {
      get() {}
    }
  }
};

const context = vm.createContext({
  AbortController,
  URLSearchParams,
  chrome,
  clearTimeout,
  console,
  fetch,
  setTimeout
});
vm.runInContext(source, context, { filename: 'src/background.js' });

function evaluate(expression) {
  return vm.runInContext(expression, context);
}

// 未保存开关时默认关闭；启动时恢复已保存状态。
storageReads.shift()({});
assert.equal(toolbar.text, 'OFF');
assert.equal(toolbar.color, '#6B7280');
assert.match(toolbar.title, /OFF（已关闭）/);
startupListeners.forEach(listener => listener());
storageReads.shift()({ pluginSwitch: true });
assert.equal(toolbar.text, 'ON');
assert.equal(toolbar.color, '#15803D');
assert.match(toolbar.title, /ON（已开启）/);

// 开关由 popup 或 Chrome Sync 修改时，后台独立更新工具栏。
const notifyStorage = (changes, area = 'sync') => {
  storageListeners.forEach(listener => listener(changes, area));
};
notifyStorage({ pluginSwitch: { newValue: false } });
assert.equal(toolbar.text, 'OFF');
notifyStorage({ pluginSwitch: { newValue: true } });
assert.equal(toolbar.text, 'ON');
const previousUpdates = toolbarUpdates;
notifyStorage({ deepseekApiKey: { newValue: 'local-key' } }, 'local');
notifyStorage({ pluginSwitch: { newValue: false } }, 'local');
notifyStorage({ google: { newValue: true } });
assert.equal(toolbarUpdates, previousUpdates, 'unrelated changes must not change the badge');
notifyStorage({ pluginSwitch: { oldValue: true } });
assert.equal(toolbar.text, 'OFF', 'removing the setting should restore the default OFF state');

// 延迟返回的旧读取不能覆盖用户刚切换的新状态。
evaluate('restoreToolbarStatus()');
notifyStorage({ pluginSwitch: { newValue: true } });
storageReads.shift()({ pluginSwitch: false });
assert.equal(toolbar.text, 'ON');
assert.ok(installedListeners.includes(evaluate('restoreToolbarStatus')));

assert.equal(evaluate("normalizeLanguageForGoogle('ZH', false)"), 'zh-CN');
assert.equal(evaluate("normalizeLanguageForGoogle('', true)"), 'auto');
assert.equal(evaluate("decodeHtmlEntities('&lt;猫&#x1F431;&gt;')"), '<猫🐱>');
assert.equal(evaluate("decodeHtmlEntities('&#x110000;')"), '&#x110000;');

const annotations = JSON.parse(JSON.stringify(evaluate(`
  normalizeWordAnnotations(
    '魔法学校へ行った',
    [
      { surface: '魔', reading: 'マ' },
      { surface: '法', reading: 'ホウ' },
      { surface: '学', reading: 'ガク' },
      { surface: '校', reading: 'コウ' },
      { surface: '行った', reading: 'イッタ' }
    ]
  )
`)));
assert.deepEqual(annotations, {
  annotations: [
    { start: 0, end: 4, reading: 'まほうがくこう' },
    { start: 5, end: 8, reading: 'いった' }
  ]
});

assert.throws(
  () => evaluate("parseJsonOrThrow('<html>', '测试接口')"),
  /测试接口 返回的内容不是有效 JSON/
);

(async () => {
  await assert.rejects(
    evaluate("translateText('a'.repeat(MAX_TRANSLATION_CHARACTERS + 1), 'ja', 'zh-CN', 'google')"),
    /单次翻译最多支持/
  );
  await assert.rejects(
    evaluate("translateText({}, 'ja', 'zh-CN', 'google')"),
    /没有提供翻译文本/
  );

  context.fetch = async () => new Response(
    JSON.stringify([[['猫', 'cat']]]),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
  assert.equal(await evaluate("googleTranslate('cat', 'en', 'ja')"), '猫');

  chrome.storage.local.get = (_keys, callback) => {
    callback({ deepseekApiKey: 'test-key' });
  };
  let capturedRequest;
  context.fetch = async (url, options) => {
    capturedRequest = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            translation: '魔法学校',
            annotations: [{ surface: '魔法学校', reading: 'まほうがっこう' }]
          })
        }
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const deepseekResult = JSON.parse(JSON.stringify(
    await evaluate("deepseekTranslate('魔法学校', 'ja', 'zh-CN', 'deepseek-v4-pro')")
  ));
  assert.equal(capturedRequest.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(capturedRequest.body.model, 'deepseek-v4-pro');
  assert.deepEqual(capturedRequest.body.thinking, { type: 'disabled' });
  assert.deepEqual(deepseekResult.furiganaAnnotations, [
    { start: 0, end: 4, reading: 'まほうがっこう' }
  ]);

  context.fetch = async (url, options) => {
    capturedRequest = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            translation: '常规译文',
            annotations: [{ surface: 'ignored', reading: 'ignored' }]
          })
        }
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const generalResult = JSON.parse(JSON.stringify(
    await evaluate("deepseekTranslate('General English text', 'auto', 'zh-CN', 'deepseek-v4-flash', 'general')")
  ));
  assert.equal(generalResult.translatedText, '常规译文');
  assert.deepEqual(generalResult.furiganaAnnotations, []);
  assert.ok(capturedRequest.body.messages[0].content.includes('专业翻译'));
  assert.ok(!capturedRequest.body.messages[0].content.includes('振假名标注器'));
  assert.ok(capturedRequest.body.messages[1].content.includes('General English text'));

  context.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'length', message: { content: '{}' } }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(
    evaluate("deepseekTranslate('長文', 'ja', 'zh-CN', 'deepseek-v4-flash')"),
    /输出达到长度上限/
  );

  console.log('background tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
