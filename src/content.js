/* content.js */

(() => {
    'use strict';

/* ------------------------------------------------------------全局变量 */

// 记录最后点击的段落
let lastClickedPtag = null;

// 插件开关状态
let pluginEnabled = false;

// 设置只在启动时读取一次，后续由 storage.onChanged 实时更新。
const extensionSettings = {};

// 可读文本块。现代阅读站常用 div/article/section，而不只使用 p 标签。
const strictReadableTags = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'BLOCKQUOTE', 'PRE', 'FIGCAPTION', 'DT', 'DD', 'TD', 'TH'
]);
const genericReadableTags = new Set(['DIV', 'ARTICLE', 'SECTION', 'MAIN']);
const strictReadableSelector = [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'blockquote', 'pre', 'figcaption', 'dt', 'dd', 'td', 'th',
    '[role="paragraph"]'
].join(',');
const whitespaceCharacterPattern = /\s/u;
const extensionClasses = {
    translation: 'anontranslator-translation',
    translationCollapsed: 'anontranslator-translation-collapsed',
    translationToggle: 'anontranslator-translation-toggle',
    translationBody: 'anontranslator-translation-body',
    translationError: 'anontranslator-translation-error',
    sentence: 'anontranslator-sentence',
    splitSentences: 'anontranslator-split-sentences',
    hovered: 'anontranslator-hovered',
    selected: 'anontranslator-selected',
    furiganaSource: 'anontranslator-furigana-source-line',
    generalAction: 'anontranslator-general-action',
    generalCard: 'anontranslator-general-card',
    generalCardBody: 'anontranslator-general-card-body',
    generalResult: 'anontranslator-general-result'
};

// 当前鼠标预选的文本块
let currentHoveredBlock = null;

// 页面监听器只绑定一次，之后由 pluginEnabled 控制是否生效。
let listenersAttached = false;

// 保存插件覆盖前的局部样式，避免清空网页原有的整个 style 属性
const originalVisualStyles = new WeakMap();

// 保存句子拆分前的原始节点，切换段落或关闭插件时完整还原页面。
const originalBlockContents = new WeakMap();
const splitBlocks = new Set();
const translationToggles = new WeakMap();
const activeTranslationDivs = new Set();
let translationToggleFrame = null;
let translationDomObserver = null;

// 常规翻译模式只维护一个选区按钮和一个结果浮层。
let generalSelectionButton = null;
let generalTranslationCard = null;
let generalSelectionSnapshot = null;
let generalDismissedSelectionSnapshot = null;
let generalRequestGeneration = 0;
let generalSelectionFrame = null;
let generalDomObserver = null;

// 临时覆盖图片鼠标样式时，只恢复插件改动过的局部属性。
const originalImageCursors = new WeakMap();
let currentHoveredImage = null;

// 存储定时器的变量
let notificationTimeout;

// 复制/缓存提示元素按需创建，未用到时不向页面注入任何节点。
const copyNotificationId = 'anontranslator-copy-notification';
let copyNotification = null;

function ensureCopyNotification() {
    if (!copyNotification) {
        copyNotification = document.getElementById(copyNotificationId) || document.createElement('div');
        copyNotification.id = copyNotificationId;
    }
    if (!copyNotification.isConnected) {
        document.documentElement.appendChild(copyNotification);
    }
    return copyNotification;
}

// 各版本缓存键共用根前缀；只有 v2 是当前格式，其余在清理时删除。
const translationCacheRootPrefix = 'anontranslator.translationCache.';
const translationCachePrefix = `${translationCacheRootPrefix}v2:`;
const translationCacheVersion = 2;
const translationCacheMaxEntries = 500;
const translationCachePruneIntervalMs = 5 * 60 * 1000;
let lastTranslationCachePruneAt = 0;


/* ------------------------------------------------------------总开关 */

function initializeSettings(data) {
    Object.assign(extensionSettings, data);
    extensionSettings.translationMode = normalizeTranslationMode(extensionSettings.translationMode);
    pluginEnabled = Boolean(extensionSettings.pluginSwitch);
    if (pluginEnabled) {
        enablePlugin();
    }
}

function enablePlugin() {
    attachListeners();
    if (!isNovelMode()) {
        scheduleGeneralSelectionUpdate();
    }
}

// 关闭插件时移除所有插件插入的内容，恢复网页原样。
function disablePlugin() {
    clearGeneralTranslationUi();
    Array.from(activeTranslationDivs).forEach(removeTranslationDiv);
    clearNovelInteractionState();
    restoreImageCursor(currentHoveredImage);
    currentHoveredImage = null;
    clearTimeout(notificationTimeout);
    copyNotification?.classList.remove('show');
    copyNotification?.remove();
}

// 优先从后台读取“默认值 + 已保存值”，后台不可用时再退回同步存储。
chrome.runtime.sendMessage({ type: 'getSettings' }, (response) => {
    if (!chrome.runtime.lastError && response && !response.error) {
        initializeSettings(response);
        return;
    }

    chrome.storage.sync.get(null, initializeSettings);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;

    for (const [key, change] of Object.entries(changes)) {
        extensionSettings[key] = change.newValue;
    }

    if (changes.translationMode) {
        extensionSettings.translationMode = normalizeTranslationMode(extensionSettings.translationMode);
        if (extensionSettings.translationMode === 'general') {
            clearNovelInteractionState();
            scheduleGeneralSelectionUpdate();
        } else {
            clearGeneralTranslationUi();
        }
    }

    if (changes.extraImage && !extensionSettings.extraImage) {
        restoreImageCursor(currentHoveredImage);
        currentHoveredImage = null;
    }
    if (!changes.pluginSwitch) return;

    pluginEnabled = Boolean(extensionSettings.pluginSwitch);
    if (pluginEnabled) {
        enablePlugin();
    } else {
        disablePlugin();
    }
});

function normalizeTranslationMode(mode) {
    return mode === 'general' ? 'general' : 'novel';
}

function isNovelMode() {
    return extensionSettings.translationMode !== 'general';
}


/* ------------------------------------------------------------文本模块 */

// 整段被同一对括号或引号包住时，复制和翻译前去掉，译文再原样包回。
const enclosingSymbolPairs = [
    ['「', '」'], ['『', '』'], ['（', '）'], ['(', ')'], ['【', '】'],
    ['《', '》'], ['〈', '〉'], ['“', '”'], ['‘', '’'], ['〔', '〕']
];
// 句末标点；紧跟其后的连续标点、闭括号和空白都归入同一句。
const sentenceEndings = new Set(Array.from('。！？!?｡‼⁉'));
const closingBrackets = new Set(Array.from('」』）)】》〉”’〕'));

function getElementTextLength(element, maxLength) {
    if (!(element instanceof Element)) return 0;

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let length = 0;
    let hasText = false;
    let pendingWhitespace = false;
    let textNode;

    while ((textNode = walker.nextNode())) {
        const value = textNode.nodeValue || '';
        for (const character of value) {
            if (whitespaceCharacterPattern.test(character)) {
                if (hasText) pendingWhitespace = true;
                continue;
            }

            if (pendingWhitespace) {
                length += 1;
                pendingWhitespace = false;
            }
            length += character.length;
            hasText = true;
            if (length > maxLength) {
                return length;
            }
        }
    }
    return length;
}

function isReadableBlock(element) {
    if (!(element instanceof Element) || !element.isConnected) {
        return false;
    }

    const isStrictReadable = strictReadableTags.has(element.nodeName) ||
        element.getAttribute('role') === 'paragraph';
    const isGenericReadable = genericReadableTags.has(element.nodeName);
    if (!isStrictReadable && !isGenericReadable) {
        return false;
    }

    if (
        element.classList.contains(extensionClasses.translation) ||
        element.closest(`.${extensionClasses.translation}`) ||
        element.matches('button,input,textarea,select,option,[role="button"],[hidden],[aria-hidden="true"]') ||
        element.closest('[contenteditable="true"]')
    ) {
        return false;
    }

    if (isGenericReadable && !isStrictReadable) {
        // 容器里已经有更精确的段落标签时，不把整个章节/页面误判成一个段落。
        if (element.querySelector(strictReadableSelector)) {
            return false;
        }

        // 对通用容器选择最靠近文字的叶子节点，并避免先复制整个大型容器的文本。
        const hasReadableGenericChild = Array.from(element.children).some(child => {
            if (child.classList.contains(extensionClasses.translation)) {
                return false;
            }
            return genericReadableTags.has(child.nodeName) && getElementTextLength(child, 0) > 0;
        });
        if (hasReadableGenericChild) {
            return false;
        }
    }

    const textLength = getElementTextLength(element, isStrictReadable ? 0 : 5000);
    if (textLength === 0) {
        return false;
    }
    return isStrictReadable || textLength <= 5000;
}

function findReadableBlockFromNode(node, eventPath = []) {
    if (eventPath.length > 0) {
        for (const pathNode of eventPath) {
            if (isReadableBlock(pathNode)) {
                return pathNode;
            }
        }
        return null;
    }

    let element = node instanceof Element ? node : node?.parentElement;
    while (element) {
        if (isReadableBlock(element)) {
            return element;
        }
        element = element.parentElement;
    }
    return null;
}

function findReadableBlockFromEvent(event) {
    if (
        event.target instanceof Element &&
        (
            event.target.closest('a,button,input,textarea,select,option,[role="button"],[contenteditable="true"]') ||
            event.target.closest(`.${extensionClasses.translation}`)
        )
    ) {
        return null;
    }

    const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return findReadableBlockFromNode(event.target, eventPath);
}

function applyOutline(tag, color) {
    if (!originalVisualStyles.has(tag)) {
        originalVisualStyles.set(tag, {
            outline: tag.style.outline,
            borderRadius: tag.style.borderRadius
        });
    }

    tag.style.outline = `${extensionSettings.borderWidth} ${extensionSettings.borderStyle} ${color}`;
    tag.style.borderRadius = extensionSettings.borderRadius;
}

function restoreOutline(tag) {
    if (!tag) return;

    const originalStyles = originalVisualStyles.get(tag);
    if (originalStyles) {
        tag.style.outline = originalStyles.outline;
        tag.style.borderRadius = originalStyles.borderRadius;
        originalVisualStyles.delete(tag);
    } else {
        tag.style.removeProperty('outline');
        tag.style.removeProperty('border-radius');
    }

    tag.classList.remove(extensionClasses.hovered);
    tag.classList.remove(extensionClasses.selected);
}

function getDirectTranslationDivs(tag) {
    return Array.from(tag.children).filter(child => {
        return child.classList.contains(extensionClasses.translation);
    });
}

function canSafelySplitSentences(tag) {
    // 仅处理纯文本块；已有翻译是插件自己的节点，不应妨碍再次拆句。
    return Array.from(tag.childNodes).every(node => {
        return node.nodeType === Node.TEXT_NODE ||
            (
                node.nodeType === Node.ELEMENT_NODE &&
                node.classList.contains(extensionClasses.translation)
            );
    });
}

// 只有当首尾符号是同一对（中途没有先闭合）时才视为包裹整段，
// 避免「A」「B」这类多段引号被误剥离首尾字符。
function findEnclosingSymbolPair(text) {
    const characters = Array.from(text);
    if (characters.length < 2) return null;

    const enclosingPair = enclosingSymbolPairs.find(([open, close]) => {
        if (characters[0] !== open || characters[characters.length - 1] !== close) {
            return false;
        }
        if (open === close) {
            // 开闭相同的符号无法判断嵌套，只有恰好首尾各出现一次才算包裹。
            return !characters.slice(1, -1).includes(open);
        }

        let depth = 0;
        for (let index = 0; index < characters.length; index += 1) {
            const character = characters[index];
            if (character === open) {
                depth += 1;
            } else if (character === close) {
                depth -= 1;
                if (depth < 0 || (depth === 0 && index < characters.length - 1)) {
                    return false;
                }
            }
        }
        return depth === 0;
    });
    return enclosingPair || null;
}

// 提取文本块的纯文本和带读音文本（漢字(かんじ)），排除插件自己插入的译文。
function cleanText(source) {
    const extractText = withFurigana => {
        const clone = source.cloneNode(true);
        clone.querySelectorAll(`.${extensionClasses.translation}, rp`).forEach(node => node.remove());
        clone.querySelectorAll('rt').forEach(rt => {
            rt.replaceWith(withFurigana ? `(${rt.textContent})` : '');
        });
        return clone.textContent;
    };

    const originalText = extractText(false);
    const trimmedText = originalText.trimStart();
    const leadingSpaces = originalText.slice(0, originalText.length - trimmedText.length);
    if (!trimmedText) {
        return { text: '-', textFurigana: '-', space: leadingSpaces, symbolPair: null };
    }

    let text = trimmedText.trim();
    let textFurigana = extractText(true).trim();
    const symbolPair = findEnclosingSymbolPair(text);
    if (symbolPair) {
        const [open, close] = symbolPair;
        text = text.slice(open.length, -close.length).trim();
        if (textFurigana.startsWith(open) && textFurigana.endsWith(close)) {
            textFurigana = textFurigana.slice(open.length, -close.length).trim();
        }
    }
    return { text, textFurigana, space: leadingSpaces, symbolPair };
}

function showBottomNotification(message = '已复制', duration = 800) {
    const notification = ensureCopyNotification();
    notification.textContent = message;
    notification.classList.add('show');
    clearTimeout(notificationTimeout);
    notificationTimeout = setTimeout(() => {
        notification.classList.remove('show');
    }, duration);
}

// 复制文本到剪贴板
function copyTextToClipboard(text) {
    if (!extensionSettings.copy) return;

    if (document.hasFocus()) {
        const copyPromise = navigator.clipboard?.writeText
            ? navigator.clipboard.writeText(text)
            : fallbackCopyText(text);
        copyPromise.then(() => {
            if (extensionSettings.showCopyContent) {
                showBottomNotification();
            }
        }).catch(error => {
            console.warn('[AnonTranslator II] Failed to copy text:', error);
        });
    } else {
        console.warn('[AnonTranslator II] Document is not focused; copy skipped.');
    }
}

function fallbackCopyText(text) {
    return new Promise((resolve, reject) => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        document.documentElement.appendChild(textarea);
        textarea.select();

        try {
            if (document.execCommand('copy')) {
                resolve();
            } else {
                reject(new Error('浏览器拒绝了复制命令'));
            }
        } catch (error) {
            reject(error);
        } finally {
            textarea.remove();
        }
    });
}

// 复制段落或句子；是否带读音由「忽略振假名」决定。
function copyElementText(element) {
    const textObj = cleanText(element);
    copyTextToClipboard(extensionSettings.ignoreFurigana ? textObj.text : textObj.textFurigana);
}


/* ------------------------------------------------------------翻译模块 */

function getTranslationBody(translationDiv) {
    let body = translationDiv.querySelector(`.${extensionClasses.translationBody}`);
    if (!body) {
        body = document.createElement('div');
        body.className = extensionClasses.translationBody;
        translationDiv.appendChild(body);
    }
    return body;
}

function updateTranslationToggle(translationDiv, collapsed) {
    const toggle = translationToggles.get(translationDiv);
    if (!toggle) return;

    translationDiv.classList.toggle(extensionClasses.translationCollapsed, collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = collapsed ? '展开翻译' : '收起翻译';
    toggle.setAttribute('aria-label', collapsed ? '展开翻译' : '收起翻译');
    positionTranslationToggle(translationDiv);
}

function createTranslationDiv() {
    const translationDiv = document.createElement('div');
    translationDiv.className = extensionClasses.translation;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = extensionClasses.translationToggle;
    toggle.tabIndex = 0;
    toggle.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        updateTranslationToggle(
            translationDiv,
            !translationDiv.classList.contains(extensionClasses.translationCollapsed)
        );
    });

    translationToggles.set(translationDiv, toggle);
    activeTranslationDivs.add(translationDiv);
    document.documentElement.appendChild(toggle);
    ensureTranslationDomObserver();
    getTranslationBody(translationDiv);
    updateTranslationToggle(translationDiv, false);
    scheduleTranslationTogglePositions();
    return translationDiv;
}

function removeTranslationDiv(translationDiv) {
    const toggle = translationToggles.get(translationDiv);
    if (toggle) {
        toggle.remove();
    }
    translationToggles.delete(translationDiv);
    activeTranslationDivs.delete(translationDiv);
    translationDiv.remove();
    stopTranslationTrackingIfIdle();
}

function ensureTranslationDomObserver() {
    if (translationDomObserver || !document.documentElement) return;

    translationDomObserver = new MutationObserver(() => {
        scheduleTranslationTogglePositions();
    });
    translationDomObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
}

function stopTranslationTrackingIfIdle() {
    if (activeTranslationDivs.size > 0) return;

    if (translationDomObserver) {
        translationDomObserver.disconnect();
        translationDomObserver = null;
    }
    if (translationToggleFrame !== null) {
        cancelAnimationFrame(translationToggleFrame);
        translationToggleFrame = null;
    }
}

function getOriginalContentLineRects(tag) {
    const rects = [];
    for (const child of Array.from(tag.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE && child.classList.contains(extensionClasses.translation)) {
            continue;
        }
        const range = document.createRange();
        range.selectNode(child);
        rects.push(...Array.from(range.getClientRects()));
    }
    return rects.filter(rect => rect.width > 0 && rect.height > 0);
}

function getLastOriginalLineRect(tag) {
    const rects = getOriginalContentLineRects(tag);
    if (rects.length > 0) {
        return rects[rects.length - 1];
    }
    return tag.getBoundingClientRect();
}

function positionTranslationToggle(translationDiv) {
    const toggle = translationToggles.get(translationDiv);
    const tag = translationDiv.parentElement;
    if (!toggle || !tag || !tag.isConnected || !translationDiv.isConnected) {
        if (toggle && !translationDiv.isConnected) {
            toggle.style.visibility = 'hidden';
        }
        return;
    }

    const lineRect = getLastOriginalLineRect(tag);
    const toggleRect = toggle.getBoundingClientRect();
    const toggleWidth = toggleRect.width || 32;
    const toggleHeight = toggleRect.height || 32;
    const gap = Math.max(6, Math.round(toggleWidth * 0.18));
    const left = Math.round(window.scrollX + lineRect.left - toggleWidth - gap);
    const top = Math.round(window.scrollY + lineRect.top + (lineRect.height - toggleHeight) / 2);
    const outsideViewport =
        lineRect.bottom < 0 ||
        lineRect.top > window.innerHeight ||
        lineRect.left - gap < 0 ||
        left - window.scrollX > window.innerWidth;

    toggle.style.visibility = outsideViewport ? 'hidden' : '';
    toggle.style.color = getComputedStyle(tag).color;
    toggle.style.left = `${left}px`;
    toggle.style.top = `${top}px`;
}

function positionAllTranslationToggles() {
    Array.from(activeTranslationDivs).forEach(translationDiv => {
        if (!translationDiv.isConnected) {
            removeTranslationDiv(translationDiv);
            return;
        }
        positionTranslationToggle(translationDiv);
    });
}

function scheduleTranslationTogglePositions() {
    if (activeTranslationDivs.size === 0 || translationToggleFrame !== null) return;

    translationToggleFrame = requestAnimationFrame(() => {
        translationToggleFrame = null;
        positionAllTranslationToggles();
    });
}

function getPageCacheScope() {
    try {
        const url = new URL(window.location.href);
        url.hash = '';
        return url.href;
    } catch (_) {
        return window.location.href.split('#')[0];
    }
}

function hashString(value) {
    let hashA = 0xdeadbeef;
    let hashB = 0x41c6ce57;
    for (const character of Array.from(value)) {
        const codePoint = character.codePointAt(0);
        hashA = Math.imul(hashA ^ codePoint, 2654435761);
        hashB = Math.imul(hashB ^ codePoint, 1597334677);
    }
    hashA = Math.imul(hashA ^ (hashA >>> 16), 2246822507) ^
        Math.imul(hashB ^ (hashB >>> 13), 3266489909);
    hashB = Math.imul(hashB ^ (hashB >>> 16), 2246822507) ^
        Math.imul(hashA ^ (hashA >>> 13), 3266489909);
    return (4294967296 * (2097151 & hashB) + (hashA >>> 0)).toString(36);
}

function getTranslationTextSignature(text) {
    const sourceText = String(text ?? '');
    return {
        hash: hashString(sourceText),
        length: Array.from(sourceText).length
    };
}

function getTranslationCacheKey(text, provider, mode) {
    const parts = [
        getPageCacheScope(),
        getTranslationTextSignature(text).hash,
        provider.translator,
        provider.from || '',
        provider.to || '',
        provider.model || ''
    ];
    // 保持轻小说模式的 v2 key 不变，常规模式另加身份，避免读取含假名的旧结果。
    if (mode === 'general') {
        parts.push('general');
    }
    return `${translationCachePrefix}${parts.map(part => encodeURIComponent(String(part))).join(':')}`;
}

// 扩展重载后，旧页面里的孤儿脚本访问 chrome.storage 会同步抛错；统一降级为无缓存。
function storageLocal(method, argument, action) {
    return new Promise(resolve => {
        try {
            chrome.storage.local[method](argument, result => {
                const error = chrome.runtime.lastError;
                if (error) {
                    console.warn(`[AnonTranslator II] Failed to ${action} translation cache:`, error.message);
                }
                resolve(error ? undefined : result);
            });
        } catch (error) {
            console.warn(`[AnonTranslator II] Failed to ${action} translation cache:`, error);
            resolve(undefined);
        }
    });
}

function getTranslationCacheTtlMs() {
    const days = Number(extensionSettings.translationCacheDays);
    if (!Number.isFinite(days) || days < 0) {
        return 30 * 24 * 60 * 60 * 1000;
    }
    return days === 0 ? Infinity : days * 24 * 60 * 60 * 1000;
}

// 删除旧格式、过期和超出数量上限的缓存；每隔一段时间最多执行一次。
function pruneTranslationCache() {
    const now = Date.now();
    if (now - lastTranslationCachePruneAt < translationCachePruneIntervalMs) {
        return;
    }
    lastTranslationCachePruneAt = now;

    storageLocal('get', null, 'inspect').then(items => {
        if (!items) return;

        const ttlMs = getTranslationCacheTtlMs();
        const keys = Object.keys(items).filter(key => key.startsWith(translationCacheRootPrefix));
        const entries = keys
            .filter(key => key.startsWith(translationCachePrefix))
            .map(key => ({ key, createdAt: Number(items[key]?.createdAt) || 0 }))
            .sort((a, b) => b.createdAt - a.createdAt);
        const keysToRemove = new Set([
            ...keys.filter(key => !key.startsWith(translationCachePrefix)),
            ...entries.filter(entry => now - entry.createdAt > ttlMs).map(entry => entry.key),
            ...entries.slice(translationCacheMaxEntries).map(entry => entry.key)
        ]);
        if (keysToRemove.size > 0) {
            storageLocal('remove', Array.from(keysToRemove), 'prune');
        }
    });
}

async function getCachedTranslation(text, provider, mode) {
    if (!extensionSettings.translationCache) return null;

    const key = getTranslationCacheKey(text, provider, mode);
    const cached = (await storageLocal('get', [key], 'read'))?.[key];
    const textSignature = getTranslationTextSignature(text);
    if (
        !cached ||
        cached.version !== translationCacheVersion ||
        cached.textHash !== textSignature.hash ||
        cached.textLength !== textSignature.length ||
        cached.provider !== provider.translator ||
        (mode === 'general' && cached.mode !== 'general') ||
        Date.now() - Number(cached.createdAt) > getTranslationCacheTtlMs() ||
        typeof cached.translatedText !== 'string' ||
        !cached.translatedText
    ) {
        if (cached) {
            storageLocal('remove', [key], 'prune');
        }
        return null;
    }

    return {
        translatedText: cached.translatedText,
        provider: cached.provider,
        furiganaAnnotations: Array.isArray(cached.furiganaAnnotations)
            ? cached.furiganaAnnotations
            : [],
        warning: cached.warning
    };
}

function cacheTranslation(text, provider, response, mode) {
    if (!extensionSettings.translationCache || !response?.translatedText) return;

    const key = getTranslationCacheKey(text, provider, mode);
    const textSignature = getTranslationTextSignature(text);
    const entry = {
        version: translationCacheVersion,
        page: getPageCacheScope(),
        textHash: textSignature.hash,
        textLength: textSignature.length,
        provider: response.provider || provider.translator,
        from: provider.from || '',
        to: provider.to || '',
        model: provider.model || '',
        mode,
        translatedText: response.translatedText,
        furiganaAnnotations: Array.isArray(response.furiganaAnnotations)
            ? response.furiganaAnnotations
            : [],
        warning: typeof response.warning === 'string' ? response.warning : '',
        createdAt: Date.now()
    };
    storageLocal('set', { [key]: entry }, 'write').then(pruneTranslationCache);
}

function renderTranslationResult(translationDiv, textObj, response, provider) {
    const body = getTranslationBody(translationDiv);
    const providerName = response.provider || provider.translator;

    if (providerName === 'deepseek' && !body.querySelector(`.${extensionClasses.furiganaSource}`)) {
        const sourceLine = createFuriganaSourceLine(textObj, response.furiganaAnnotations);
        if (response.warning) {
            sourceLine.title = response.warning;
            console.warn(`[AnonTranslator II] ${response.warning}`);
        }
        body.insertBefore(sourceLine, body.firstChild);
    }

    const result = document.createElement('div');
    result.style.color = provider.color;
    result.dataset.translationProvider = providerName;
    if (response.warning) {
        result.title = response.warning;
    }
    const [open, close] = textObj.symbolPair || ['', ''];
    result.textContent = textObj.space + open + response.translatedText + close;
    body.appendChild(result);
    scheduleTranslationTogglePositions();
}

// 发送消息到背景脚本并获取翻译结果
function requestTranslation(tag, translationDiv, textObj, provider) {
    try {
        chrome.runtime.sendMessage({
            action: 'translate',
            text: textObj.text,
            from: provider.from,
            to: provider.to,
            translator: provider.translator,
            model: provider.model,
            mode: 'novel'
        }, response => {
            if (!translationDiv.isConnected || !tag.contains(translationDiv)) {
                return;
            }
            if (chrome.runtime.lastError) {
                renderTranslationError(translationDiv, provider.color, chrome.runtime.lastError.message);
                return;
            }
            if (response?.ok && response.translatedText) {
                const normalizedResponse = {
                    ...response,
                    provider: response.provider || provider.translator
                };
                renderTranslationResult(translationDiv, textObj, normalizedResponse, provider);
                cacheTranslation(textObj.text, provider, normalizedResponse, 'novel');
            } else {
                renderTranslationError(translationDiv, provider.color, response?.error || '翻译没有返回结果');
            }
        });
    } catch (_) {
        // 扩展更新或重载后，旧页面的孤儿脚本无法再连接后台，明确提示刷新而不是留空框。
        renderTranslationError(translationDiv, provider.color, '扩展已更新或重新加载，请刷新页面后重试');
    }
}

function renderTranslationError(translationDiv, color, error) {
    const errorDiv = document.createElement('div');
    errorDiv.className = extensionClasses.translationError;
    errorDiv.style.color = color;
    errorDiv.textContent = `翻译失败：${error}`;
    getTranslationBody(translationDiv).appendChild(errorDiv);
    console.error('[AnonTranslator II] Translation failed:', error);
}

function appendAnnotatedText(container, text, annotations) {
    const characters = Array.from(text);
    const safeAnnotations = Array.isArray(annotations) ? annotations : [];
    let cursor = 0;

    safeAnnotations.forEach(annotation => {
        const start = Number(annotation?.start);
        const end = Number(annotation?.end);
        const reading = typeof annotation?.reading === 'string'
            ? annotation.reading
            : '';

        if (
            !Number.isInteger(start) ||
            !Number.isInteger(end) ||
            start < cursor ||
            end <= start ||
            end > characters.length ||
            !reading
        ) {
            return;
        }

        container.appendChild(document.createTextNode(
            characters.slice(cursor, start).join('')
        ));

        const ruby = document.createElement('ruby');
        ruby.className = 'anon-furigana';
        ruby.appendChild(document.createTextNode(
            characters.slice(start, end).join('')
        ));

        const rt = document.createElement('rt');
        rt.textContent = reading;
        ruby.appendChild(rt);
        container.appendChild(ruby);
        cursor = end;
    });

    container.appendChild(document.createTextNode(
        characters.slice(cursor).join('')
    ));
}

function createFuriganaSourceLine(textObj, annotations) {
    const sourceLine = document.createElement('div');
    sourceLine.className = extensionClasses.furiganaSource;

    if (textObj.space) {
        sourceLine.appendChild(document.createTextNode(textObj.space));
    }
    if (textObj.symbolPair) {
        sourceLine.appendChild(document.createTextNode(textObj.symbolPair[0]));
    }

    appendAnnotatedText(sourceLine, textObj.text, annotations);

    if (textObj.symbolPair) {
        sourceLine.appendChild(document.createTextNode(textObj.symbolPair[1]));
    }
    return sourceLine;
}

async function renderCachedOrRequestTranslation(tag, translationDiv, textObj, provider) {
    const cached = await getCachedTranslation(textObj.text, provider, 'novel');
    if (!translationDiv.isConnected || !tag.contains(translationDiv)) {
        return;
    }
    if (cached) {
        renderTranslationResult(translationDiv, textObj, cached, provider);
        showBottomNotification('已读取缓存', 900);
        return;
    }
    requestTranslation(tag, translationDiv, textObj, provider);
}

// 两种模式共用的已启用翻译引擎配置。
function getEnabledProviders() {
    const providers = [];
    if (extensionSettings.google) {
        providers.push({
            translator: 'google',
            label: 'Google',
            color: extensionSettings.googleColor,
            from: extensionSettings.googleFrom,
            to: extensionSettings.googleTo,
            model: undefined
        });
    }
    if (extensionSettings.deepseek) {
        providers.push({
            translator: 'deepseek',
            label: 'DeepSeek',
            color: extensionSettings.deepseekColor,
            from: extensionSettings.deepseekFrom,
            to: extensionSettings.deepseekTo,
            model: extensionSettings.deepseekModel
        });
    }
    return providers;
}

// 翻译文本并显示结果
function translate(tag) {
    const existingTranslation = tag.querySelector(`.${extensionClasses.translation}`);

    // 点击失败的段落时允许直接重试，不需要先切换到其他段落。
    if (existingTranslation?.querySelector(`.${extensionClasses.translationError}`)) {
        removeTranslationDiv(existingTranslation);
    }

    const providers = getEnabledProviders();
    if (providers.length === 0 || tag.querySelector(`.${extensionClasses.translation}`)) return;

    const textObj = cleanText(tag);
    const translationDiv = createTranslationDiv();
    tag.appendChild(translationDiv);
    scheduleTranslationTogglePositions();
    providers.forEach(provider => {
        renderCachedOrRequestTranslation(tag, translationDiv, textObj, provider);
    });
}

/* ------------------------------------------------------------常规翻译模式 */

function clearNovelInteractionState() {
    if (currentHoveredBlock) {
        restoreOutline(currentHoveredBlock);
    }
    if (lastClickedPtag && lastClickedPtag !== currentHoveredBlock) {
        restoreOutline(lastClickedPtag);
    }
    Array.from(splitBlocks).forEach(restoreSentenceSplitting);
    currentHoveredBlock = null;
    lastClickedPtag = null;
}

function isGeneralUiNode(node) {
    const element = node instanceof Element
        ? node
        : node?.parentElement;
    return Boolean(element?.closest(
        `.${extensionClasses.generalAction},` +
        `.${extensionClasses.generalCard},` +
        `.${extensionClasses.translation},` +
        `.${extensionClasses.translationToggle},` +
        `#${copyNotificationId}`
    ));
}

function isExcludedSelectionNode(node) {
    const element = node instanceof Element
        ? node
        : node?.parentElement;
    if (!element || isGeneralUiNode(element)) return true;
    return Boolean(element.closest(
        'input,textarea,select,option,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]'
    ));
}

function getRangeAnchorRect(range) {
    if (!range) return null;
    if (!range.commonAncestorContainer?.isConnected) return null;
    const rects = Array.from(range.getClientRects?.() || [])
        .filter(rect => rect.width > 0 || rect.height > 0);
    const rect = rects[rects.length - 1] || range.getBoundingClientRect?.();
    return rect && (rect.width || rect.height) ? rect : null;
}

function readGeneralSelection() {
    if (!pluginEnabled || isNovelMode()) return null;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    if (
        isExcludedSelectionNode(selection.anchorNode) ||
        isExcludedSelectionNode(selection.focusNode)
    ) {
        return null;
    }

    const text = selection.toString().replace(/\r\n?/g, '\n').trim();
    if (!text) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const rect = getRangeAnchorRect(range);
    if (!rect) return null;
    return { text, range, rect };
}

function positionGeneralSelectionButton() {
    if (!generalSelectionButton || !generalSelectionSnapshot) return;
    const rect = getRangeAnchorRect(generalSelectionSnapshot.range) || generalSelectionSnapshot.rect;
    if (!rect) {
        generalSelectionButton.style.display = 'none';
        return;
    }
    generalSelectionSnapshot.rect = rect;
    const buttonRect = generalSelectionButton.getBoundingClientRect();
    const width = buttonRect.width || 34;
    const height = buttonRect.height || 34;
    const gap = 8;
    const left = Math.min(
        Math.max(gap, rect.right + gap),
        Math.max(gap, window.innerWidth - width - gap)
    );
    const top = Math.min(
        Math.max(gap, rect.bottom + gap),
        Math.max(gap, window.innerHeight - height - gap)
    );
    generalSelectionButton.style.display = '';
    generalSelectionButton.style.left = `${Math.round(left)}px`;
    generalSelectionButton.style.top = `${Math.round(top)}px`;
}

function positionGeneralTranslationCard() {
    if (!generalTranslationCard || !generalSelectionSnapshot) return;
    const rect = getRangeAnchorRect(generalSelectionSnapshot.range) || generalSelectionSnapshot.rect;
    if (!rect) return;
    generalSelectionSnapshot.rect = rect;
    const gap = 10;
    const cardRect = generalTranslationCard.getBoundingClientRect();
    const width = cardRect.width || Math.min(380, window.innerWidth - gap * 2);
    const height = cardRect.height || 120;
    const left = Math.min(
        Math.max(gap, rect.left),
        Math.max(gap, window.innerWidth - width - gap)
    );
    const belowTop = rect.bottom + gap;
    const top = belowTop + height <= window.innerHeight - gap
        ? belowTop
        : Math.max(gap, rect.top - height - gap);
    generalTranslationCard.style.left = `${Math.round(left)}px`;
    generalTranslationCard.style.top = `${Math.round(top)}px`;
}

function removeGeneralSelectionButton() {
    generalSelectionButton?.remove();
    generalSelectionButton = null;
    stopGeneralDomObserverIfIdle();
}

function removeGeneralTranslationCard() {
    generalRequestGeneration += 1;
    generalTranslationCard?.remove();
    generalTranslationCard = null;
    stopGeneralDomObserverIfIdle();
}

function stopGeneralDomObserverIfIdle() {
    if (generalSelectionButton || generalTranslationCard || !generalDomObserver) return;
    generalDomObserver.disconnect();
    generalDomObserver = null;
}

function clearGeneralTranslationUi() {
    if (generalSelectionFrame !== null) {
        cancelAnimationFrame(generalSelectionFrame);
        generalSelectionFrame = null;
    }
    removeGeneralSelectionButton();
    removeGeneralTranslationCard();
    generalSelectionSnapshot = null;
    generalDismissedSelectionSnapshot = null;
}

function dismissGeneralTranslationUi() {
    const dismissedSnapshot = generalSelectionSnapshot;
    clearGeneralTranslationUi();
    generalDismissedSelectionSnapshot = dismissedSnapshot;
}

function ensureGeneralDomObserver() {
    if (generalDomObserver || !document.documentElement) return;
    generalDomObserver = new MutationObserver(() => {
        if (
            generalSelectionSnapshot?.range?.commonAncestorContainer &&
            !generalSelectionSnapshot.range.commonAncestorContainer.isConnected
        ) {
            clearGeneralTranslationUi();
            return;
        }
        positionGeneralSelectionButton();
        positionGeneralTranslationCard();
    });
    generalDomObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
}

function createGeneralSelectionButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = extensionClasses.generalAction;
    button.textContent = '译';
    button.title = '翻译选中文本';
    button.setAttribute('aria-label', '翻译选中文本');
    button.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
    });
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        translateGeneralSelection();
    });
    (document.body || document.documentElement).appendChild(button);
    ensureGeneralDomObserver();
    return button;
}

function isSameGeneralSelection(first, second) {
    if (!first?.range || !second?.range || first.text !== second.text) return false;
    return first.range.startContainer === second.range.startContainer &&
        first.range.startOffset === second.range.startOffset &&
        first.range.endContainer === second.range.endContainer &&
        first.range.endOffset === second.range.endOffset;
}

function updateGeneralSelectionUi() {
    generalSelectionFrame = null;
    const snapshot = readGeneralSelection();
    if (!snapshot) {
        generalDismissedSelectionSnapshot = null;
        removeGeneralSelectionButton();
        return;
    }

    if (isSameGeneralSelection(generalDismissedSelectionSnapshot, snapshot)) {
        removeGeneralSelectionButton();
        return;
    }
    generalDismissedSelectionSnapshot = null;

    const sameSelection = isSameGeneralSelection(generalSelectionSnapshot, snapshot);
    if (!sameSelection) {
        removeGeneralTranslationCard();
    }
    generalSelectionSnapshot = snapshot;
    if (sameSelection && generalTranslationCard) {
        removeGeneralSelectionButton();
        positionGeneralTranslationCard();
        return;
    }
    if (!generalSelectionButton) {
        generalSelectionButton = createGeneralSelectionButton();
    }
    positionGeneralSelectionButton();
}

function scheduleGeneralSelectionUpdate() {
    if (!pluginEnabled || isNovelMode() || generalSelectionFrame !== null) return;
    generalSelectionFrame = requestAnimationFrame(updateGeneralSelectionUi);
}

function createGeneralTranslationCard() {
    removeGeneralTranslationCard();
    const card = document.createElement('section');
    card.className = extensionClasses.generalCard;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '选中文本的翻译结果');

    const header = document.createElement('div');
    header.className = 'anontranslator-general-card-header';
    const title = document.createElement('strong');
    title.textContent = '翻译结果';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'anontranslator-general-close';
    close.textContent = '×';
    close.title = '关闭翻译';
    close.setAttribute('aria-label', '关闭翻译');
    close.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        dismissGeneralTranslationUi();
    });
    header.append(title, close);

    const body = document.createElement('div');
    body.className = extensionClasses.generalCardBody;
    card.append(header, body);
    (document.body || document.documentElement).appendChild(card);
    ensureGeneralDomObserver();
    generalTranslationCard = card;
    positionGeneralTranslationCard();
    return body;
}

function createGeneralProviderResult(body, provider) {
    const result = document.createElement('div');
    result.className = extensionClasses.generalResult;
    result.dataset.translationProvider = provider.translator;
    result.style.color = provider.color;
    const label = document.createElement('strong');
    label.className = 'anontranslator-general-provider';
    label.textContent = provider.label;
    const text = document.createElement('div');
    text.className = 'anontranslator-general-result-text';
    text.textContent = '翻译中…';
    text.setAttribute('role', 'status');
    result.append(label, text);
    body.appendChild(result);
    return text;
}

function requestGeneralTranslation(text, provider, resultNode, generation) {
    try {
        chrome.runtime.sendMessage({
            action: 'translate',
            text,
            from: provider.from,
            to: provider.to,
            translator: provider.translator,
            model: provider.model,
            mode: 'general'
        }, response => {
            if (
                generation !== generalRequestGeneration ||
                !generalTranslationCard?.isConnected ||
                !resultNode.isConnected
            ) return;
            if (chrome.runtime.lastError) {
                resultNode.textContent = `翻译失败：${chrome.runtime.lastError.message}`;
            } else if (response?.ok && response.translatedText) {
                resultNode.textContent = response.translatedText;
                cacheTranslation(
                    text,
                    provider,
                    { ...response, provider: response.provider || provider.translator },
                    'general'
                );
            } else {
                resultNode.textContent = `翻译失败：${response?.error || '翻译没有返回结果'}`;
            }
            positionGeneralTranslationCard();
        });
    } catch (_) {
        resultNode.textContent = '翻译失败：扩展已更新或重新加载，请刷新页面后重试';
        positionGeneralTranslationCard();
    }
}

async function renderCachedOrRequestGeneralTranslation(text, provider, resultNode, generation) {
    const cached = await getCachedTranslation(text, provider, 'general');
    if (
        generation !== generalRequestGeneration ||
        !generalTranslationCard?.isConnected ||
        !resultNode.isConnected
    ) return;
    if (cached) {
        resultNode.textContent = cached.translatedText;
        resultNode.title = '已读取缓存';
        positionGeneralTranslationCard();
        return;
    }
    requestGeneralTranslation(text, provider, resultNode, generation);
}

function translateGeneralSelection() {
    if (!pluginEnabled || isNovelMode() || !generalSelectionSnapshot?.text) return;
    const text = generalSelectionSnapshot.text;
    removeGeneralSelectionButton();
    const body = createGeneralTranslationCard();
    const generation = generalRequestGeneration;
    const providers = getEnabledProviders();
    if (providers.length === 0) {
        const empty = document.createElement('div');
        empty.className = extensionClasses.generalResult;
        empty.textContent = '请先在插件设置中启用 Google 或 DeepSeek 翻译。';
        body.appendChild(empty);
        positionGeneralTranslationCard();
        return;
    }
    providers.forEach(provider => {
        const resultNode = createGeneralProviderResult(body, provider);
        renderCachedOrRequestGeneralTranslation(text, provider, resultNode, generation);
    });
    positionGeneralTranslationCard();
}

/* ------------------------------------------------------------用户界面交互模块 */

// 按句末标点拆句，例如「本当？」「うん。」→「本当？」|「うん。」。
// 「……。」と言った 这类引用后接「と」时视为同一句，不拆开。
function splitIntoSentences(text) {
    const characters = Array.from(text);
    const sentences = [];
    let current = '';

    for (let index = 0; index < characters.length; index += 1) {
        current += characters[index];
        if (!sentenceEndings.has(characters[index])) continue;

        while (
            index + 1 < characters.length &&
            (
                sentenceEndings.has(characters[index + 1]) ||
                closingBrackets.has(characters[index + 1]) ||
                whitespaceCharacterPattern.test(characters[index + 1])
            )
        ) {
            index += 1;
            current += characters[index];
        }
        if (characters[index + 1] === 'と' && closingBrackets.has(characters[index])) continue;

        sentences.push(current);
        current = '';
    }
    if (current || sentences.length === 0) {
        sentences.push(current);
    }
    return sentences;
}

// 用 DOM API 创建安全的句子节点。
function createSentenceFragment(text) {
    const fragment = document.createDocumentFragment();
    for (const sentence of splitIntoSentences(text)) {
        const span = document.createElement('span');
        span.className = extensionClasses.sentence;
        span.textContent = sentence;
        fragment.appendChild(span);
    }
    return fragment;
}

function splitTagSentences(tag) {
    if (!canSafelySplitSentences(tag) || originalBlockContents.has(tag)) {
        return;
    }

    const translationDivs = getDirectTranslationDivs(tag);
    translationDivs.forEach(div => div.remove());

    const originalContent = document.createDocumentFragment();
    const text = tag.textContent || '';
    while (tag.firstChild) {
        originalContent.appendChild(tag.firstChild);
    }
    originalBlockContents.set(tag, originalContent);
    tag.appendChild(createSentenceFragment(text));
    translationDivs.forEach(div => tag.appendChild(div));
    tag.classList.add(extensionClasses.splitSentences);
    splitBlocks.add(tag);
    scheduleTranslationTogglePositions();
}

function restoreSentenceSplitting(tag) {
    const originalContent = originalBlockContents.get(tag);
    if (!tag || !originalContent) return;

    const translationDivs = getDirectTranslationDivs(tag);
    tag.replaceChildren();
    tag.appendChild(originalContent);
    translationDivs.forEach(div => tag.appendChild(div));
    tag.classList.remove(extensionClasses.splitSentences);
    originalBlockContents.delete(tag);
    splitBlocks.delete(tag);
    scheduleTranslationTogglePositions();
}

function restoreImageCursor(image) {
    if (!image || !originalImageCursors.has(image)) return;
    image.style.cursor = originalImageCursors.get(image);
    originalImageCursors.delete(image);
}

function getSafeImageUrl(image) {
    const rawUrl = image.nodeName === 'IMG'
        ? image.currentSrc || image.src
        : image.getAttribute('href') || image.getAttribute('xlink:href');
    if (!rawUrl) return null;

    try {
        const url = new URL(rawUrl, document.baseURI);
        if (['http:', 'https:', 'blob:', 'file:'].includes(url.protocol)) {
            return url.href;
        }
        if (url.protocol === 'data:' && /^data:image\//i.test(url.href)) {
            return url.href;
        }
        return null;
    } catch (_) {
        return null;
    }
}

// 轻小说模式：左键点击段落，复制并翻译。
function handleClick(event) {
    if (!pluginEnabled || !isNovelMode() || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('img, svg image')) return;

    const block = findReadableBlockFromEvent(event);
    if (!block) return;

    activateBlock(block);
    copyElementText(block);
    translate(block);
}

// 切换激活段落：还原上一段的拆句和激活框（译文保留），再拆句并框住当前段落。
function activateBlock(tag) {
    if (lastClickedPtag && lastClickedPtag !== tag) {
        restoreSentenceSplitting(lastClickedPtag);
        restoreOutline(lastClickedPtag);
    }
    splitTagSentences(tag);
    tag.classList.add(extensionClasses.selected);
    lastClickedPtag = tag;
    applyOutline(tag, extensionSettings.selectedBorderColor);
}

function repositionFloatingUi() {
    scheduleTranslationTogglePositions();
    positionGeneralSelectionButton();
    positionGeneralTranslationCard();
}

function attachListeners() {
    if (listenersAttached) return;
    listenersAttached = true;

    // 轻小说模式：悬停段落显示预选框。
    document.addEventListener('mouseover', (event) => {
        if (!pluginEnabled || !isNovelMode()) return;

        const targetElement = findReadableBlockFromEvent(event);
        if (targetElement === currentHoveredBlock) return;

        if (currentHoveredBlock && currentHoveredBlock !== lastClickedPtag) {
            restoreOutline(currentHoveredBlock);
        }
        currentHoveredBlock = targetElement;

        if (
            targetElement &&
            targetElement !== lastClickedPtag &&
            !targetElement.classList.contains(extensionClasses.hovered)
        ) {
            targetElement.classList.add(extensionClasses.hovered);
            applyOutline(targetElement, extensionSettings.freeBorderColor);
        }
    }, true);

    document.addEventListener('mouseout', (event) => {
        if (!pluginEnabled || !isNovelMode()) return;

        const fromElement = findReadableBlockFromEvent(event);
        const toElement = findReadableBlockFromNode(event.relatedTarget);

        if (
            fromElement &&
            fromElement === currentHoveredBlock &&
            toElement !== fromElement
        ) {
            if (fromElement !== lastClickedPtag) {
                restoreOutline(fromElement);
            }
            // 让随后进入新段落的 mouseover 正常应用预选框。
            currentHoveredBlock = null;
        }
    }, true);

    document.addEventListener('click', handleClick, true);
    window.addEventListener('scroll', repositionFloatingUi, true);
    window.addEventListener('resize', repositionFloatingUi);

    // 常规翻译模式：拖选过程中 selectionchange 会连续触发；只在松开指针或键盘操作结束后显示按钮。
    document.addEventListener('pointerup', scheduleGeneralSelectionUpdate, true);
    document.addEventListener('keyup', scheduleGeneralSelectionUpdate, true);
    document.addEventListener('pointerdown', event => {
        if (!pluginEnabled || isNovelMode() || isGeneralUiNode(event.target)) return;
        if (generalTranslationCard || generalSelectionButton) {
            dismissGeneralTranslationUi();
        }
    }, true);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !isNovelMode()) {
            dismissGeneralTranslationUi();
        }
    }, true);

    // 仅在扩展生成的句子上接管右键，用于复制当前句子。
    document.addEventListener('contextmenu', (event) => {
        if (!pluginEnabled || !isNovelMode() || !extensionSettings.copy) return;

        const targetElement = event.target instanceof Element ? event.target : null;
        const sentence = targetElement?.closest(`.${extensionClasses.sentence}`);
        if (sentence && lastClickedPtag?.contains(sentence)) {
            event.preventDefault();
            copyElementText(sentence);
        }
    });

    // 句子高亮，以及「点击提取图片」时的手形光标。
    document.addEventListener('mouseover', (event) => {
        if (!pluginEnabled) return;

        const targetElement = event.target instanceof Element ? event.target : null;
        const sentence = targetElement?.closest(`.${extensionClasses.sentence}`);
        if (isNovelMode() && sentence) {
            sentence.style.backgroundColor = extensionSettings.sentenceColor;
        }

        // 图片本身也能被识别；鼠标离开后恢复网页原有 cursor。
        const image = targetElement?.closest('img, svg image');
        if (extensionSettings.extraImage && image && !image.closest('a')) {
            if (!originalImageCursors.has(image)) {
                originalImageCursors.set(image, image.style.cursor);
            }
            image.style.cursor = 'pointer';
            currentHoveredImage = image;
        }
    });

    document.addEventListener('mouseout', (event) => {
        if (!pluginEnabled) return;

        const targetElement = event.target instanceof Element ? event.target : null;
        const sentence = targetElement?.closest(`.${extensionClasses.sentence}`);
        if (isNovelMode() && sentence && !sentence.contains(event.relatedTarget)) {
            sentence.style.backgroundColor = '';
        }

        const image = targetElement?.closest('img, svg image');
        if (image && !image.contains(event.relatedTarget)) {
            restoreImageCursor(image);
            if (currentHoveredImage === image) {
                currentHoveredImage = null;
            }
        }
    });

    document.addEventListener('click', (event) => {
        if (!pluginEnabled || !extensionSettings.extraImage) return;

        const targetElement = event.target instanceof Element ? event.target : null;
        const image = targetElement?.closest('img, svg image');
        if (!image || image.closest('a')) return;

        const url = getSafeImageUrl(image);
        if (url) {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    });
}

})();
