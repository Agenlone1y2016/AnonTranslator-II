const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const defaults = JSON.parse(fs.readFileSync('config/defaultSettings.json', 'utf8'));
const popup = fs.readFileSync('popup.html', 'utf8');
const background = fs.readFileSync('src/background.js', 'utf8');
const content = fs.readFileSync('src/content.js', 'utf8');
const popupScript = fs.readFileSync('src/popup.js', 'utf8');

// manifest 引用的文件必须都存在。
const referencedFiles = [
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  ...Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap(entry => [
    ...(entry.js || []),
    ...(entry.css || [])
  ])
].filter(Boolean);

for (const referencedFile of referencedFiles) {
  assert.ok(
    fs.existsSync(path.resolve(referencedFile)),
    `manifest references missing file: ${referencedFile}`
  );
}

// 扩展版本号与 npm 包版本号保持一致。
assert.equal(
  manifest.version,
  packageJson.version,
  'manifest.json and package.json versions must match'
);

// popup 控件 id 唯一，且每个默认设置都有对应控件。
const ids = Array.from(popup.matchAll(/\bid="([^"]+)"/g), match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'popup.html contains duplicate ids');

for (const key of Object.keys(defaults)) {
  assert.ok(ids.includes(key), `default setting has no popup control: ${key}`);
}

// label 标签配对完整、不嵌套。
const labelTokens = popup.match(/<\/?label\b[^>]*>/gi) || [];
let labelDepth = 0;
for (const token of labelTokens) {
  if (/^<\//.test(token)) {
    labelDepth -= 1;
    assert.ok(labelDepth >= 0, 'popup.html has an unmatched closing label');
  } else {
    assert.equal(labelDepth, 0, 'popup.html contains nested labels');
    labelDepth += 1;
  }
}
assert.equal(labelDepth, 0, 'popup.html has an unclosed label');

// popup 提供的 DeepSeek 模型必须被 background 白名单接受。
const configuredModels = Array.from(
  popup.matchAll(/<option value="(deepseek-[^"]+)"/g),
  match => match[1]
);
for (const model of configuredModels) {
  assert.ok(background.includes(`'${model}'`), `background does not allow model: ${model}`);
}
assert.ok(
  configuredModels.includes(defaults.deepseekModel),
  'default DeepSeek model must be selectable in the popup'
);

assert.equal(defaults.translationMode, 'novel', 'existing users must default to novel mode');
assert.match(popup, /<input type="radio" name="translationMode" value="novel"[^>]*>\s*<span class="mode-card">\s*<span class="mode-name">日语轻小说<\/span>/);
assert.match(popup, /<input type="radio" name="translationMode" value="general"[^>]*>\s*<span class="mode-card">\s*<span class="mode-name">常规翻译<\/span>/);
assert.match(
  popupScript,
  /chrome\.storage\.sync\.set\(\{ translationMode: normalizedMode \}/,
  'translation mode should persist immediately without submitting the form'
);

// 安全底线：内容脚本不得用 innerHTML 重新解析网页内容。
assert.doesNotMatch(content, /\.innerHTML\s*=/, 'content script should not reparse page HTML');

console.log('project tests passed');
