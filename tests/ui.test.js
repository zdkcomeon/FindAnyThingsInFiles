const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// 仅模拟本页面使用的 DOM 能力；测试直接执行页面代码和实际 HTML 中的控件。
class Element {
    constructor(tagName, document) {
        this.tagName = tagName;
        this.document = document;
        this.children = [];
        this.attributes = {};
        this.dataset = {};
        this.style = {};
        this.listeners = {};
        this.className = '';
        this.value = '';
        this.hidden = false;
        this.disabled = false;
        this.classList = {
            toggle: (name, enabled) => {
                const names = new Set(this.className.split(/\s+/).filter(Boolean));
                if (enabled === undefined) enabled = !names.has(name);
                if (enabled) names.add(name); else names.delete(name);
                this.className = [...names].join(' ');
            }
        };
    }

    set checked(value) {
        this._checked = value;
        if (value && this.attributes.type === 'radio') {
            this.document.querySelectorAll('input').forEach(input => {
                if (input !== this && input.attributes.name === this.attributes.name) input._checked = false;
            });
        }
    }

    get checked() { return this._checked; }
    get textContent() { return this.children.map(child => child.textContent).join('') || this.text || ''; }
    set textContent(value) { this.replaceChildren(); this.text = String(value); }

    append(...children) {
        this.text = '';
        for (const child of children) {
            this.children.push(child);
            child.parentNode = this;
        }
    }

    replaceChildren(...children) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        this.text = '';
        this.append(...children);
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (['id', 'value', 'title'].includes(name)) this[name] = String(value);
        if (name === 'class') this.className = value;
        if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
        if (['hidden', 'disabled', 'checked'].includes(name)) this[name] = true;
    }

    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    focus() { this.document.activeElement = this; }
    select() { this.selected = true; }
    scrollIntoView() { this.document.scrolledTo = this; }

    async dispatch(name, properties = {}) {
        const event = { target: this, preventDefault() {}, ...properties };
        for (const callback of this.listeners[name] || []) await callback(event);
    }

    querySelectorAll(selector) {
        const matches = element => {
            const tag = selector.match(/^[a-z]+/);
            if (tag && element.tagName !== tag[0]) return false;
            if (selector.startsWith('.') && !element.className.split(/\s+/).includes(selector.slice(1))) return false;
            if (selector.startsWith('#') && element.id !== selector.slice(1)) return false;
            for (const [, name, value] of selector.matchAll(/\[([\w-]+)="([^"]*)"\]/g)) {
                if (element.getAttribute(name) !== value) return false;
            }
            return !selector.includes(':checked') || element.checked;
        };
        const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
        return selector === '*' ? descendants : descendants.filter(matches);
    }

    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function createHarness(overrides = {}) {
    const document = new Element('document', null);
    document.document = document;
    document.createElement = tag => new Element(tag, document);
    document.createTextNode = text => Object.assign(new Element('#text', document), { text });
    document.getElementById = id => document.querySelector('#' + id);
    const stack = [document];
    const voidTags = new Set(['meta', 'link', 'input', 'br']);
    for (const token of html.match(/<[^>]+>|[^<]+/g)) {
        if (token.startsWith('<!')) continue;
        if (token.startsWith('</')) { stack.pop(); continue; }
        if (!token.startsWith('<')) {
            stack[stack.length - 1].append(document.createTextNode(token));
            continue;
        }
        const [, tag, attributes] = token.match(/^<([\w-]+)([\s\S]*?)\/?\s*>$/);
        const element = document.createElement(tag);
        stack[stack.length - 1].append(element);
        for (const [, name, value] of attributes.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) element.setAttribute(name, value || '');
        if (!voidTags.has(tag) && !token.endsWith('/>')) stack.push(element);
    }
    document.body = document.querySelector('body');
    document.activeElement = document.body;
    const copied = [];
    const opened = [];
    const saved = [];
    const logs = [];
    const api = {
        getConfig: () => ({ searchPath: '/workspace', searchType: 'all', extensions: [] }),
        saveConfig: config => saved.push(JSON.parse(JSON.stringify(config))),
        getBinaryExts: () => ['.png'],
        performSearch: async () => makeResult(),
        selectDirectory: () => '/other-workspace',
        cancelSearch: () => true,
        copyText: text => copied.push(text),
        openSourceFile: filename => opened.push(['open', filename]),
        openSourceFileLocation: filename => opened.push(['reveal', filename]),
        openFile: filename => opened.push(['export', filename]),
        openFileLocation: filename => opened.push(['export-reveal', filename]),
        formatResultsAsMarkdown: () => 'markdown',
        saveMarkdownFile: async () => '/downloads/retried.md',
        ...overrides
    };
    const context = vm.createContext({
        document,
        navigator: { platform: 'MacIntel' },
        window: { customApis: api },
        console: Object.fromEntries(['info', 'error'].map(level => [level, (...args) => logs.push(args)])),
        setInterval: () => 1,
        clearInterval() {},
        setTimeout: () => 1,
        clearTimeout() {}
    });
    vm.runInContext(source, context);
    document.listeners.DOMContentLoaded[0]();
    const byId = id => document.getElementById(id);
    byId('searchInput').value = 'needle';
    return { context, document, api, byId, copied, opened, saved, logs, submit: () => context.startSearch({ preventDefault() {} }), state: () => vm.runInContext('state', context) };
}

function makeResult(count = 1, options = {}) {
    return {
        success: true,
        requestId: 'completed-search',
        results: Array.from({ length: count }, (_, index) => ({ filePath: '/workspace/app/demo.js', relativePath: 'app/demo.js', filename: 'demo.js', lineNumber: index + 1, content: `needle ${index}` })),
        stats: { totalMatches: count, processedFiles: 2, matchedFiles: count ? 1 : 0, durationMs: 100, skippedEntries: 0, ignoredLinks: 0 },
        savedPath: '/downloads/result.md',
        ...options
    };
}

test('keeps completed results and their context through cancellation and failure, replacing them only on success', async () => {
    const h = createHarness();
    await h.submit();
    const firstRow = h.byId('match-row-0');
    const firstResult = h.state().lastResult;
    let finish;
    h.api.performSearch = () => new Promise(resolve => { finish = resolve; });
    h.byId('searchInput').value = 'another query';
    const pending = h.submit();
    assert.equal(h.byId('match-row-0'), firstRow);
    assert.equal(h.byId('resultQuery').textContent, 'needle');
    assert.equal(h.byId('previousResultsNote').hidden, false);
    assert.equal(h.byId('progressSection').hidden, false);
    assert.equal(h.byId('searchControls').disabled, true);
    await h.byId('cancelSearchBtn').dispatch('click');
    finish({ success: false, cancelled: true });
    await pending;
    assert.equal(h.state().lastResult, firstResult);
    assert.equal(h.byId('match-row-0'), firstRow);
    assert.match(h.byId('previousResultsNote').textContent, /已取消/);
    assert.equal(h.byId('searchControls').disabled, false);

    h.api.performSearch = async () => ({ success: false, message: '搜索目录不存在' });
    await h.submit();
    assert.equal(h.state().lastResult, firstResult);
    assert.equal(h.byId('searchFeedback').dataset.kind, 'error');
    assert.match(h.byId('searchFeedbackMessage').textContent, /目录不存在/);

    h.api.performSearch = async () => makeResult(2);
    await h.submit();
    assert.notEqual(h.byId('match-row-0'), firstRow);
    assert.equal(h.byId('resultQuery').textContent, 'another query');
    assert.equal(h.byId('previousResultsNote').hidden, true);
});

test('confirms custom extensions explicitly, supports IME input and expands invalid hidden fields', async () => {
    const h = createHarness();
    const custom = h.document.querySelector('input[name="searchType"][value="custom"]');
    custom.checked = true;
    await custom.dispatch('change');
    h.byId('customExtInput').value = 'vue，.go';
    await h.byId('customExtInput').dispatch('input');
    assert.equal(h.state().extensions.size, 0);
    assert.match(h.byId('selectedExtTags').textContent, /尚未选择/);
    assert.equal(h.byId('pendingExtNote').hidden, false);
    await h.byId('customExtInput').dispatch('keydown', { key: 'Enter', isComposing: true });
    assert.equal(h.state().extensions.size, 0);
    await h.byId('customExtInput').dispatch('keydown', { key: 'Enter', isComposing: false });
    assert.deepEqual([...h.state().extensions], ['.vue', '.go']);
    assert.equal(h.byId('pendingExtNote').hidden, true);
    assert.deepEqual(h.saved.at(-1).extensions, ['.vue', '.go']);
    h.byId('customExtInput').value = '.png';
    await h.byId('toggleExtBtn').dispatch('click');
    await h.submit();
    assert.equal(h.byId('customExtPanel').hidden, false);
    assert.equal(h.document.activeElement, h.byId('customExtInput'));
    assert.match(h.byId('formError').textContent, /不支持搜索/);
});

test('appends pages without rebuilding rows and supports folding, expanding, copying and opening source files', async () => {
    const result = makeResult(205);
    const fullLine = 'prefix '.repeat(90) + 'needle <script>alert(1)</script> ' + 'suffix '.repeat(100);
    result.results[0].content = fullLine;
    const h = createHarness({ performSearch: async () => result });
    await h.submit();
    const row = h.byId('match-row-0');
    const group = h.state().resultGroups.values().next().value;
    assert.equal(h.byId('resultList').querySelectorAll('.result-line').length, 100);
    assert.equal(row.querySelector('script'), null);
    assert.ok(h.byId('match-content-0').textContent.length < fullLine.length);
    await row.querySelectorAll('button')[0].dispatch('click');
    assert.equal(h.byId('match-content-0').textContent, fullLine);
    await row.querySelectorAll('button')[1].dispatch('click');
    assert.equal(h.copied.at(-1), fullLine);
    await group.name.dispatch('click');
    await group.element.querySelector('.file-actions').children[0].dispatch('click');
    await group.element.querySelector('.file-actions').children[1].dispatch('click');
    assert.deepEqual(h.opened, [['open', '/workspace/app/demo.js'], ['reveal', '/workspace/app/demo.js']]);
    assert.equal(h.copied.at(-1), '/workspace/app/demo.js');
    await group.toggle.dispatch('click');
    assert.equal(group.body.hidden, true);
    assert.equal(group.toggle.getAttribute('aria-expanded'), 'false');
    await h.byId('loadMoreBtn').dispatch('click');
    assert.equal(h.byId('match-row-0'), row);
    assert.equal(group.body.hidden, true);
    assert.equal(h.document.activeElement, group.toggle);
    await h.byId('loadMoreBtn').dispatch('click');
    assert.equal(h.byId('resultList').querySelectorAll('.result-line').length, 205);
    assert.equal(h.byId('loadMoreBtn').hidden, true);
    assert.match(h.byId('previewNote').textContent, /205 \/ 205/);
    assert.equal(h.byId('match-content-0').textContent, fullLine);
});

test('offers recovery from empty results and preserves keyboard focus when a user browses old results during a search', async () => {
    const h = createHarness({ getConfig: () => ({ searchPath: '/workspace', searchType: 'custom', extensions: ['.js'] }), performSearch: async () => makeResult(0) });
    assert.equal(h.byId('customExtPanel').hidden, true);
    await h.submit();
    assert.equal(h.byId('widenScopeBtn').hidden, false);
    let searchedType;
    h.api.performSearch = async (query, type) => { searchedType = type; return makeResult(); };
    await h.byId('widenScopeBtn').dispatch('click');
    // 点击处理器启动异步搜索，等待其完成。
    await Promise.resolve();
    assert.equal(searchedType, 'all');
    assert.equal(h.byId('emptyState').hidden, true);
    assert.equal(h.byId('searchFeedback').hidden, true);

    let finish;
    h.api.performSearch = () => new Promise(resolve => { finish = resolve; });
    const pending = h.submit();
    await h.byId('focusResultsBtn').dispatch('click');
    const focused = h.document.activeElement;
    finish({ success: false, cancelled: true });
    await pending;
    assert.equal(h.document.activeElement, focused);
    await h.byId('editQueryBtn').dispatch('click');
    assert.equal(h.document.activeElement, h.byId('searchInput'));
    assert.equal(h.byId('searchInput').selected, true);
});

test('retries export without resetting the preview or mixing queries and ignores outdated progress', async () => {
    const h = createHarness({ performSearch: async () => makeResult(120, { savedPath: null, exportError: '无法保存' }) });
    await h.submit();
    await h.byId('loadMoreBtn').dispatch('click');
    const row = h.byId('match-row-0');
    let finishExport;
    let exportQuery;
    h.api.saveMarkdownFile = (markdown, query) => { exportQuery = query; return new Promise(resolve => { finishExport = resolve; }); };
    const retry = h.byId('retryExportBtn').dispatch('click');
    let finishSearch;
    let progress;
    let requestId;
    h.api.performSearch = (query, type, extensions, onProgress, options) => {
        progress = onProgress;
        requestId = options.requestId;
        return new Promise(resolve => { finishSearch = resolve; });
    };
    h.byId('searchInput').value = 'new query';
    const pending = h.submit();
    progress(1, 2, 1, { type: 'searching', message: '当前任务', requestId });
    progress(2, 2, 2, { type: 'complete', message: '过期任务', requestId: 'old-request' });
    assert.equal(h.byId('progressMessage').textContent, '正在搜索文件内容…');
    assert.equal(h.byId('progressBarFill').style.transform, 'scaleX(0.5)');
    finishExport('/downloads/retried.md');
    await retry;
    assert.equal(exportQuery, 'needle');
    assert.equal(h.byId('match-row-0'), row);
    assert.equal(h.state().visibleMatches, 120);
    assert.equal(h.byId('retryExportBtn').disabled, true);
    assert.equal(h.byId('stateLabel').textContent, '搜索进行中');
    finishSearch({ success: false, cancelled: true });
    await pending;
    assert.equal(h.byId('exportFilename').textContent, 'retried.md');
});

test('reports source action errors next to the file and never logs copied contents', async () => {
    const secret = 'example_token=private-value';
    const result = makeResult();
    result.results[0].content = secret;
    const h = createHarness({ performSearch: async () => result, openSourceFile: async () => { throw new Error('原文件已被移动或删除'); } });
    await h.submit();
    const group = h.state().resultGroups.values().next().value;
    await group.name.dispatch('click');
    assert.equal(group.error.hidden, false);
    assert.match(group.error.textContent, /原文件/);
    assert.equal(group.name.disabled, false);
    await h.byId('match-row-0').querySelector('button').dispatch('click');
    assert.equal(h.copied.at(-1), secret);
    assert.ok(!JSON.stringify(h.logs).includes(secret));
    assert.ok(h.logs.every(([event]) => /^[a-z0-9_.]+$/.test(event)));
});
