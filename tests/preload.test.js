const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

async function createHarness(t, overrides = {}) {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'find-in-files-test-'));
    const root = path.join(directory, 'workspace');
    const downloads = path.join(directory, 'downloads');
    await fs.promises.mkdir(root);
    await fs.promises.mkdir(downloads);
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
    let config = { searchPath: root };
    const logs = [];
    const opened = [];
    const utools = {
        dbStorage: {
            getItem: () => config,
            setItem: (key, value) => { config = value; }
        },
        getPath: () => downloads,
        shellOpenPath: async filename => { opened.push(['open', filename]); return ''; },
        shellShowItemInFolder: filename => { opened.push(['reveal', filename]); },
        ...overrides.utools
    };
    const context = vm.createContext({
        window: {},
        utools,
        require: name => name === 'node:fs' && overrides.fs ? overrides.fs : require(name),
        console: Object.fromEntries(['info', 'debug', 'warn', 'error'].map(level => [level, (...args) => logs.push(args)])),
        setTimeout,
        clearTimeout
    });
    vm.runInContext(source, context);
    return { api: context.window.customApis, root, downloads, logs, opened, utools };
}

test('searches nested UTF-8 files, preserves literal matching and exports escaped Markdown', async t => {
    const { api, root, downloads, logs } = await createHarness(t);
    await fs.promises.mkdir(path.join(root, '项目'));
    await fs.promises.writeFile(path.join(root, '项目', 'demo.js'), 'no match\r\nneedle | <script>alert(1)</script>\r\nneedle again\r\nNeedle\n');
    await fs.promises.writeFile(path.join(root, 'readme.txt'), '中文 needle');
    await fs.promises.writeFile(path.join(root, 'ignored.png'), 'needle');
    const progress = [];
    const result = await api.performSearch('needle', 'all', '', (...args) => progress.push(args), { requestId: 'nested-search' });
    assert.equal(result.success, true);
    assert.equal(result.stats.totalFiles, 2);
    assert.equal(result.stats.matchedFiles, 2);
    assert.equal(result.stats.totalMatches, 3);
    const codeMatch = result.results.find(match => match.filename === 'demo.js');
    assert.equal(codeMatch.lineNumber, 2);
    assert.equal(codeMatch.project, '项目');
    assert.equal(codeMatch.relativePath, path.join('项目', 'demo.js'));
    const markdown = await fs.promises.readFile(result.savedPath, 'utf8');
    assert.match(markdown, /\\\| &lt;script&gt;/);
    assert.equal(path.dirname(result.savedPath), downloads);
    assert.ok(progress.some(item => item[3].type === 'scanning'));
    assert.ok(progress.some(item => item[3].type === 'searching'));
    assert.ok(progress.some(item => item[3].type === 'exporting'));
    assert.ok(logs.every(([event]) => /^[a-z0-9_.]+$/.test(event)));
    assert.ok(!JSON.stringify(logs).includes('needle'));
});

test('normalizes custom extensions and rejects empty or binary selections', async t => {
    const { api, root } = await createHarness(t);
    await fs.promises.writeFile(path.join(root, 'code.JS'), 'target');
    await fs.promises.writeFile(path.join(root, 'other.txt'), 'target');
    const result = await api.performSearch('target', 'custom', 'JS，.js  js');
    assert.equal(result.success, true);
    assert.equal(result.stats.totalFiles, 1);
    assert.equal(result.results[0].filename, 'code.JS');
    for (const extensions of ['', 'png', '<script>', '.tar.gz']) {
        const invalid = await api.performSearch('target', 'custom', extensions);
        assert.equal(invalid.success, false, extensions);
    }
});

test('handles empty directories, empty queries and missing roots without invalid progress', async t => {
    const { api, root } = await createHarness(t);
    const empty = await api.performSearch('anything', 'all', '');
    assert.equal(empty.success, true);
    assert.equal(empty.stats.totalFiles, 0);
    assert.equal(empty.stats.totalMatches, 0);
    assert.equal(await fs.promises.readFile(empty.savedPath, 'utf8'), '未找到匹配的结果。');
    assert.equal((await api.performSearch('   ', 'all', '')).success, false);
    api.saveConfig({ searchPath: path.join(root, 'missing') });
    const missing = await api.performSearch('anything', 'all', '');
    assert.equal(missing.success, false);
    assert.match(missing.message, /目录不存在/);
});

test('cancels during scanning without exporting, then allows a fresh search', async t => {
    const { api, root, downloads } = await createHarness(t);
    await fs.promises.writeFile(path.join(root, 'data.txt'), 'target');
    let requested = false;
    const result = await api.performSearch('target', 'all', '', (processed, total, matched, status) => {
        if (!requested && status.type === 'scanning') {
            requested = true;
            assert.equal(api.cancelSearch('wrong-request'), false);
            assert.equal(api.cancelSearch('cancel-scan'), true);
        }
    }, { requestId: 'cancel-scan' });
    assert.equal(result.cancelled, true);
    assert.equal((await fs.promises.readdir(downloads)).length, 0);
    assert.equal((await api.performSearch('target', 'all', '')).success, true);
});

test('cancels an active stream and rejects duplicate searches without hanging', { timeout: 5000 }, async t => {
    const { api, root, downloads } = await createHarness(t);
    await fs.promises.writeFile(path.join(root, 'large.log'), 'target\n'.repeat(150000));
    let cancelTimer;
    const pending = api.performSearch('target', 'all', '', (processed, total, matched, status) => {
        if (status.type === 'searching' && !cancelTimer) {
            cancelTimer = setTimeout(() => api.cancelSearch('cancel-content'), 10);
        }
    }, { requestId: 'cancel-content' });
    const duplicate = await api.performSearch('other', 'all', '');
    assert.equal(duplicate.success, false);
    assert.match(duplicate.message, /已有搜索/);
    const result = await pending;
    clearTimeout(cancelTimer);
    assert.equal(result.cancelled, true);
    assert.equal((await fs.promises.readdir(downloads)).length, 0);
});

test('skips symbolic links so cycles and paths outside the selected folder are not traversed', async t => {
    const { api, root } = await createHarness(t);
    await fs.promises.writeFile(path.join(root, 'text.txt'), 'target');
    await fs.promises.symlink(root, path.join(root, 'cycle'), 'dir');
    const result = await api.performSearch('target', 'all', '');
    assert.equal(result.success, true);
    assert.equal(result.stats.totalMatches, 1);
    assert.equal(result.stats.ignoredLinks, 1);
});

test('reports unreadable subdirectories while preserving readable results', async t => {
    const fakeFs = {
        ...fs,
        promises: {
            ...fs.promises,
            readdir: async (directory, options) => {
                if (path.basename(directory) === 'denied') {
                    throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
                }
                return fs.promises.readdir(directory, options);
            }
        }
    };
    const { api, root } = await createHarness(t, { fs: fakeFs });
    await fs.promises.mkdir(path.join(root, 'denied'));
    await fs.promises.writeFile(path.join(root, 'readable.txt'), 'target');
    const result = await api.performSearch('target', 'all', '');
    assert.equal(result.success, true);
    assert.equal(result.stats.totalMatches, 1);
    assert.equal(result.stats.skippedEntries, 1);
});

test('preserves results when export fails and protects query text in failure logs', async t => {
    const { api, root, downloads, logs } = await createHarness(t);
    const secret = 'example_token=private-value';
    await fs.promises.writeFile(path.join(root, 'data.txt'), secret);
    await fs.promises.rmdir(downloads);
    const result = await api.performSearch(secret, 'all', '');
    assert.equal(result.success, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.savedPath, null);
    assert.match(result.exportError, /无法保存/);
    assert.ok(!JSON.stringify(logs).includes(secret));
    await fs.promises.mkdir(downloads);
    const retried = await api.saveMarkdownFile(api.formatResultsAsMarkdown(result.results), secret, result.requestId);
    assert.ok((await fs.promises.readFile(retried, 'utf8')).includes(secret));
});

test('uses host file-opening APIs and handles both old and new API return values', async t => {
    const { api, root, opened, utools } = await createHarness(t);
    const filename = path.join(root, 'result $(not-a-command).md');
    await fs.promises.writeFile(filename, 'result');
    await api.openFile(filename, 'open-result');
    await api.openFileLocation(filename, 'open-result');
    assert.deepEqual(opened, [['open', filename], ['reveal', filename]]);
    utools.shellOpenPath = () => undefined;
    await api.openFile(filename);
    utools.shellOpenPath = async () => 'No application';
    await assert.rejects(api.openFile(filename), /无法打开/);
    await assert.rejects(api.openFile(path.join(root, 'missing.md')), /移动或删除/);
});

test('cleans reserved filename characters and bounds Unicode filename length', async t => {
    const { api } = await createHarness(t);
    assert.equal(api.sanitizeFileName(' /a:b?*|<>\\\\ '), 'a_b');
    assert.ok(Buffer.byteLength(api.sanitizeFileName('中文内容'.repeat(100)), 'utf8') <= 160);
    assert.ok(!api.formatResultsAsMarkdown([{ project: 'a|b', filename: '<img>', fileType: '.txt', lineNumber: 1, content: '<script>' }]).includes('<script>'));
});
