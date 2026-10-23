const PREVIEW_LIMIT = 100;
const byId = id => document.getElementById(id);
const state = {
    config: { searchPath: '', searchType: 'all', extensions: [] },
    extensions: new Set(),
    running: false,
    requestId: null,
    lastResult: null,
    lastQuery: '',
    lastContext: null,
    visibleMatches: 0,
    resultGroups: new Map(),
    extensionsExpanded: false,
    exporting: false,
    startedAt: 0,
    timer: null,
    cancelling: false
};

function parseExtensions(value) {
    return [...new Set(String(value || '').split(/[,，\s]+/).filter(Boolean).map(ext => (ext.startsWith('.') ? ext : '.' + ext).toLowerCase()))];
}

function getSelectedExtensions() {
    return [...new Set([...state.extensions, ...parseExtensions(byId('customExtInput').value)])];
}

function showFormError(message, field) {
    const error = byId('formError');
    error.textContent = message;
    error.hidden = !message;
    ['searchInput', 'customExtInput', 'updatePathBtn'].forEach(id => byId(id).removeAttribute('aria-invalid'));
    if (field && message) {
        if (field === 'customExtInput') setExtensionPanel(true);
        byId(field).setAttribute('aria-invalid', 'true');
        byId(field).focus();
    }
}

function setStatus(label, status = '') {
    if (byId('stateLabel').textContent !== label) byId('stateLabel').textContent = label;
    byId('stateLabel').dataset.state = status;
}

function setPathText(element, value) {
    const separators = [...value.matchAll(/[\\/]/g)];
    const split = separators.length ? separators[separators.length - 1].index + 1 : value.length > 48 ? value.length - 24 : 0;
    const parentStart = separators.length > 1 ? separators[separators.length - 2].index + 1 : split;
    element.replaceChildren();
    if (split) {
        const prefix = document.createElement('span');
        prefix.className = 'path-prefix';
        prefix.textContent = value.slice(0, parentStart);
        element.append(prefix);
    }
    if (parentStart < split) {
        const parent = document.createElement('span');
        parent.className = 'path-parent';
        parent.textContent = value.slice(parentStart, split);
        element.append(parent);
    }
    const tail = document.createElement('span');
    tail.className = 'path-tail';
    tail.textContent = value.slice(split);
    element.append(tail);
    element.title = value;
}

function updatePath() {
    const path = state.config.searchPath;
    setPathText(byId('searchPath'), path || '选择要搜索的文件夹');
    byId('searchPath').classList.toggle('has-path', Boolean(path));
    byId('updatePathBtn').title = path || '选择搜索目录，包含所有子目录';
    byId('pathAction').textContent = path ? '更换目录' : '选择目录';
    byId('copyDirectoryBtn').hidden = !path;
}

function savePreferences() {
    if (!window.customApis) return;
    state.config.searchType = document.querySelector('input[name="searchType"]:checked').value;
    state.config.extensions = [...state.extensions];
    try {
        window.customApis.saveConfig(state.config, state.requestId);
    } catch (error) {
        showFormError('当前筛选已生效，但未能保存设置，下次打开时需要重新选择。');
        console.error('file_search.ui_preferences_failed', { requestId: state.requestId }, error);
    }
}

function validateExtensions(extensions) {
    const malformed = extensions.filter(ext => !/^\.[a-z0-9_+-]+$/.test(ext));
    if (malformed.length) return `后缀格式不正确：${malformed.join('、')}。请使用 .js、.vue 等格式。`;
    const blocked = window.customApis ? window.customApis.getBinaryExts() : [];
    const invalid = extensions.filter(ext => blocked.includes(ext));
    return invalid.length ? `不支持搜索 ${invalid.join('、')}，请选择文本文件类型。` : '';
}

function updateSelectedExtensionsDisplay() {
    const extensions = [...state.extensions];
    const container = byId('selectedExtTags');
    container.replaceChildren();
    if (!extensions.length) {
        container.textContent = '尚未选择类型，请选择常用类型或添加后缀。';
    }
    extensions.forEach(ext => {
        const tag = document.createElement('span');
        tag.className = 'extension-tag';
        tag.append(document.createTextNode(ext));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `移除 ${ext}`);
        remove.addEventListener('click', () => {
            state.extensions.delete(ext);
            showFormError('');
            updateSelectedExtensionsDisplay();
            savePreferences();
            byId('customExtInput').focus();
        });
        tag.append(remove);
        container.append(tag);
    });
    document.querySelectorAll('.ext-button').forEach(button => {
        button.setAttribute('aria-pressed', String(extensions.includes(button.dataset.ext)));
    });
    const pending = parseExtensions(byId('customExtInput').value);
    byId('clearExtBtn').disabled = !extensions.length && !pending.length;
    byId('addExtBtn').disabled = !pending.length;
    byId('pendingExtNote').hidden = !pending.length;
    byId('pendingExtNote').textContent = pending.length ? `${pending.length} 项输入待确认；按 Enter 添加，开始搜索时也会自动确认。` : '';
    const custom = document.querySelector('input[name="searchType"]:checked').value === 'custom';
    byId('filterHint').textContent = custom ? `已确认 ${extensions.length} 种类型${extensions.length ? ' · ' + extensions.slice(0, 3).join('、') + (extensions.length > 3 ? ' 等' : '') : ''}` : '自动排除图片、视频等二进制文件';
}

function commitExtensions() {
    const extensions = getSelectedExtensions();
    const error = validateExtensions(extensions);
    if (error) {
        showFormError(error, 'customExtInput');
        return false;
    }
    state.extensions = new Set(extensions);
    byId('customExtInput').value = '';
    updateSelectedExtensionsDisplay();
    savePreferences();
    return true;
}

function setExtensionPanel(expanded) {
    const custom = document.querySelector('input[name="searchType"]:checked').value === 'custom';
    state.extensionsExpanded = custom && expanded;
    byId('customExtPanel').hidden = !state.extensionsExpanded;
    byId('toggleExtBtn').hidden = !custom;
    byId('toggleExtBtn').setAttribute('aria-expanded', String(state.extensionsExpanded));
    byId('toggleExtBtn').textContent = state.extensionsExpanded ? '收起类型' : '调整类型';
}

function updateSearchMode(expand = false) {
    setExtensionPanel(expand || !state.extensions.size);
    showFormError('');
    updateSelectedExtensionsDisplay();
}

async function selectDirectory() {
    if (!window.customApis || state.running) return;
    showFormError('');
    const button = byId('updatePathBtn');
    button.disabled = true;
    try {
        const path = await window.customApis.selectDirectory();
        if (!path) return;
        const config = { ...state.config, searchPath: path };
        window.customApis.saveConfig(config, state.requestId);
        state.config = config;
        updatePath();
        byId('searchFeedback').hidden = true;
        byId('searchInput').focus();
    } catch (error) {
        showFormError(error.message || '目录选择失败，请重试。');
        console.error('file_search.ui_directory_failed', { requestId: state.requestId }, error);
    } finally {
        button.disabled = false;
    }
}

function updateElapsedTime() {
    byId('progressTime').textContent = `${((Date.now() - state.startedAt) / 1000).toFixed(1)} 秒`;
}

function updateProgress(processed, total, matchedFiles, status) {
    if (!state.running || (status.requestId && status.requestId !== state.requestId)) return;
    const scanning = status.type === 'scanning';
    const exporting = status.type === 'exporting' || status.type === 'complete';
    const percentage = total > 0 ? Math.min(100, Math.round(processed / total * 100)) : exporting ? 100 : 0;
    const bar = byId('progressBar');
    bar.classList.toggle('indeterminate', scanning);
    if (scanning) {
        bar.removeAttribute('aria-valuenow');
    } else {
        bar.setAttribute('aria-valuenow', String(percentage));
    }
    bar.setAttribute('aria-valuetext', scanning ? '正在统计可搜索文件' : exporting ? '正在保存结果' : `已搜索 ${processed} / ${total} 个文件`);
    byId('progressBarFill').style.transform = `scaleX(${scanning ? 1 : percentage / 100})`;
    const message = state.cancelling ? '正在取消搜索…' : scanning ? '正在扫描目录…' : exporting ? '正在保存 Markdown…' : '正在搜索文件内容…';
    if (byId('progressMessage').textContent !== message) byId('progressMessage').textContent = message;
    byId('progressFiles').textContent = scanning ? `已发现 ${total} 个文件` : `${processed} / ${total} 个文件 · ${matchedFiles} 个匹配文件`;
    byId('cancelSearchBtn').disabled = state.cancelling || exporting;
    byId('cancelSearchBtn').textContent = exporting ? '正在保存…' : state.cancelling ? '正在取消…' : '取消搜索';
    setStatus(scanning ? '扫描目录中' : exporting ? '正在保存' : '搜索进行中', 'running');
    updateElapsedTime();
}

function showEmptyState(title, description) {
    byId('emptyState').hidden = false;
    byId('emptyTitle').textContent = title;
    byId('emptyDescription').textContent = description;
    byId('emptySteps').hidden = true;
}

function showSearchFeedback(message, kind) {
    byId('searchFeedbackMessage').textContent = message;
    byId('searchFeedback').dataset.kind = kind;
    byId('searchFeedback').hidden = false;
    byId('widenScopeBtn').hidden = kind !== 'empty' || document.querySelector('input[name="searchType"]:checked').value !== 'custom';
}

async function runAction(button, action, { name, requestId, errorElement = byId('resultError'), copied = false, result = null }) {
    const startedAt = Date.now();
    const restoreFocus = document.activeElement === button;
    button.disabled = true;
    errorElement.hidden = true;
    console.info('file_search.ui_action_started', { requestId, action: name });
    try {
        await action();
        if (copied) {
            const label = button.dataset.label || button.textContent;
            button.dataset.label = label;
            clearTimeout(button.copyTimer);
            button.textContent = '已复制';
            button.copyTimer = setTimeout(() => { button.textContent = label; }, 1500);
            byId('actionFeedback').textContent = '已复制到剪贴板。';
        }
        console.info('file_search.ui_action_completed', { requestId, action: name, durationMs: Date.now() - startedAt });
    } catch (error) {
        if (!result || state.lastResult === result) {
            errorElement.textContent = error.message || '操作未完成，请重试。';
            errorElement.hidden = false;
        }
        console.error('file_search.ui_action_failed', { requestId, action: name, durationMs: Date.now() - startedAt, code: error.code, stack: String(error.stack || '').split('\n').filter(line => /^\s+at /.test(line)).join('\n') });
    } finally {
        button.disabled = false;
        if (restoreFocus && document.activeElement === document.body && button.isConnected) button.focus({ preventScroll: true });
    }
}

function createButton(label, className = 'text-button') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    return button;
}

function appendHighlightedText(container, content, query, expanded = false) {
    // 仅创建文本节点，匹配的 HTML、脚本与后缀都不会作为页面内容执行。
    const matchIndex = content.indexOf(query);
    const start = !expanded && matchIndex > 160 ? matchIndex - 160 : 0;
    const previewLength = expanded ? content.length : Math.max(600, query.length + 320);
    const visible = content.slice(start, start + previewLength);
    if (start) container.append(document.createTextNode('…'));
    let cursor = 0;
    let index = query ? visible.indexOf(query) : -1;
    while (index !== -1) {
        container.append(document.createTextNode(visible.slice(cursor, index)));
        const mark = document.createElement('mark');
        mark.textContent = visible.slice(index, index + query.length);
        container.append(mark);
        cursor = index + query.length;
        index = visible.indexOf(query, cursor);
    }
    container.append(document.createTextNode(visible.slice(cursor)));
    if (start + previewLength < content.length) container.append(document.createTextNode('…'));
    return start > 0 || start + previewLength < content.length;
}

function createFileGroup(match, result) {
    const file = match.relativePath || match.filename;
    const element = document.createElement('div');
    element.className = 'result-group';
    const heading = document.createElement('div');
    heading.className = 'result-file-heading';
    const body = document.createElement('div');
    body.id = `match-group-${state.resultGroups.size}`;
    const toggle = createButton('▾', 'icon-button result-toggle');
    toggle.setAttribute('aria-controls', body.id);
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', `收起 ${file}`);
    toggle.addEventListener('click', () => {
        body.hidden = !body.hidden;
        toggle.textContent = body.hidden ? '▸' : '▾';
        toggle.setAttribute('aria-expanded', String(!body.hidden));
        toggle.setAttribute('aria-label', `${body.hidden ? '展开' : '收起'} ${file}`);
    });
    const error = document.createElement('p');
    error.className = 'file-action-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const options = { requestId: result.requestId, result, errorElement: error };
    const name = createButton('', 'result-file-path file-open-button');
    setPathText(name, file);
    name.title = match.filePath;
    name.setAttribute('aria-label', `打开原文件 ${file}`);
    name.addEventListener('click', () => runAction(name, () => window.customApis.openSourceFile(match.filePath, result.requestId), { ...options, name: 'source_open' }));
    const count = document.createElement('span');
    count.className = 'result-file-count';
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const reveal = createButton('打开位置');
    reveal.setAttribute('aria-label', `打开 ${file} 所在位置`);
    reveal.addEventListener('click', () => runAction(reveal, () => window.customApis.openSourceFileLocation(match.filePath, result.requestId), { ...options, name: 'source_reveal' }));
    const copy = createButton('复制路径');
    copy.setAttribute('aria-label', `复制 ${file} 的完整路径`);
    copy.addEventListener('click', () => runAction(copy, () => window.customApis.copyText(match.filePath, result.requestId), { ...options, name: 'path_copy', copied: true }));
    actions.append(reveal, copy);
    heading.append(toggle, name, count, actions);
    element.append(heading, error, body);
    return { element, body, toggle, name, count, error, shown: 0 };
}

function createResultLine(match, index, result, errorElement) {
    const row = document.createElement('div');
    row.id = `match-row-${index}`;
    row.className = 'result-line';
    row.tabIndex = -1;
    const lineNumber = document.createElement('span');
    lineNumber.className = 'line-number';
    lineNumber.textContent = String(match.lineNumber);
    lineNumber.setAttribute('aria-label', `第 ${match.lineNumber} 行`);
    const content = document.createElement('code');
    content.id = `match-content-${index}`;
    content.className = 'line-content';
    const truncated = appendHighlightedText(content, match.content, state.lastQuery);
    const actions = document.createElement('div');
    actions.className = 'line-actions';
    if (truncated) {
        const expand = createButton('展开');
        expand.setAttribute('aria-expanded', 'false');
        expand.setAttribute('aria-controls', content.id);
        expand.setAttribute('aria-label', `展开第 ${match.lineNumber} 行全文`);
        expand.addEventListener('click', () => {
            const expanded = expand.getAttribute('aria-expanded') !== 'true';
            content.replaceChildren();
            appendHighlightedText(content, match.content, state.lastQuery, expanded);
            expand.textContent = expanded ? '收起' : '展开';
            expand.setAttribute('aria-expanded', String(expanded));
            expand.setAttribute('aria-label', `${expanded ? '收起' : '展开'}第 ${match.lineNumber} 行全文`);
        });
        actions.append(expand);
    }
    const copy = createButton('复制行');
    copy.setAttribute('aria-label', `复制第 ${match.lineNumber} 行内容`);
    copy.addEventListener('click', () => runAction(copy, () => window.customApis.copyText(match.content, result.requestId), { name: 'line_copy', requestId: result.requestId, result, errorElement, copied: true }));
    actions.append(copy);
    row.append(lineNumber, content, actions);
    return row;
}

function appendResultPage() {
    const startedAt = Date.now();
    const result = state.lastResult;
    if (!result) return;
    const start = state.visibleMatches;
    const end = Math.min(start + PREVIEW_LIMIT, result.results.length);
    for (let index = start; index < end; index++) {
        const match = result.results[index];
        const file = match.filePath || match.relativePath || match.filename;
        if (!state.resultGroups.has(file)) {
            const group = createFileGroup(match, result);
            state.resultGroups.set(file, group);
            byId('resultList').append(group.element);
        }
        const group = state.resultGroups.get(file);
        group.body.append(createResultLine(match, index, result, group.error));
        group.shown++;
        group.count.textContent = `${group.shown.toLocaleString()} 行已显示`;
    }
    state.visibleMatches = end;
    byId('previewNote').hidden = !result.results.length;
    byId('previewNote').textContent = `已显示 ${end.toLocaleString()} / ${result.results.length.toLocaleString()} 行匹配；长行可展开或复制完整内容。`;
    byId('loadMoreBtn').hidden = end >= result.results.length;
    byId('loadMoreBtn').textContent = `再显示 ${Math.min(PREVIEW_LIMIT, result.results.length - end)} 行`;
    console.info('file_search.ui_preview_appended', { requestId: result.requestId, start, shown: end - start, visible: end, durationMs: Date.now() - startedAt });
}

function updateExportState(result) {
    byId('exportBar').hidden = !result.savedPath;
    if (result.savedPath) {
        byId('exportFilename').textContent = result.savedPath.split(/[\\/]/).pop();
        byId('exportFilename').title = result.savedPath;
    }
    byId('resultError').hidden = !result.exportError;
    byId('resultError').textContent = result.exportError || '';
    byId('retryExportBtn').hidden = !result.exportError;
    byId('retryExportBtn').disabled = state.running || state.exporting;
}

function setResultStatus(result) {
    setStatus(result.exportError ? '已完成 · 保存失败' : result.stats.skippedEntries ? '已完成 · 部分内容未读取' : '搜索完成', result.exportError || result.stats.skippedEntries ? 'error' : 'success');
}

function renderResults(result, query) {
    const { stats, results } = result;
    byId('resultCount').textContent = `${stats.totalMatches.toLocaleString()} 行匹配`;
    byId('resultCount').hidden = false;
    byId('resultContent').hidden = false;
    byId('resultContext').hidden = false;
    byId('resultQuery').textContent = query;
    byId('resultQuery').title = query;
    setPathText(byId('resultPath'), state.lastContext.searchPath);
    byId('resultScope').textContent = state.lastContext.searchType === 'custom' ? `类型：${state.lastContext.extensions.join('、')}` : '全部文本文件';
    byId('focusResultsBtn').hidden = !results.length;
    byId('previousResultsNote').hidden = true;
    byId('emptyState').hidden = results.length > 0;
    const summaries = [`搜索 ${stats.processedFiles.toLocaleString()} 个文件`, `${stats.matchedFiles.toLocaleString()} 个文件有匹配`, `用时 ${(stats.durationMs / 1000).toFixed(1)} 秒`];
    if (stats.skippedEntries) summaries.push(`${stats.skippedEntries} 个文件或目录无法读取，结果可能不完整`);
    if (stats.ignoredLinks) summaries.push(`已跳过 ${stats.ignoredLinks} 个符号链接`);
    byId('resultSummary').textContent = summaries.join(' · ');
    if (!results.length) {
        showEmptyState('没有找到匹配内容', '可以修改关键词、选择其他目录，或扩大文件范围。搜索区分大小写。');
        showSearchFeedback('没有找到匹配内容，可以调整下面的搜索条件后重试。', 'empty');
    } else if (stats.skippedEntries) {
        showSearchFeedback(`${stats.skippedEntries} 个文件或目录无法读取；下方展示已读取内容中的匹配。检查目录权限后可重新搜索。`, 'warning');
    }
    state.visibleMatches = 0;
    state.resultGroups.clear();
    byId('resultList').replaceChildren();
    appendResultPage();
    updateExportState(result);
    setResultStatus(result);
}

async function startSearch(event) {
    event.preventDefault();
    if (state.running || !window.customApis) return;
    showFormError('');
    const query = byId('searchInput').value.trim();
    if (!query) return showFormError('请输入要搜索的关键词或文本内容。', 'searchInput');
    if (!state.config.searchPath) return showFormError('请先选择要搜索的目录。', 'updatePathBtn');
    const searchType = document.querySelector('input[name="searchType"]:checked').value;
    if (searchType === 'custom') {
        if (!getSelectedExtensions().length) return showFormError('请至少选择一种文件类型，或切换到全部文本文件。', 'customExtInput');
        if (!commitExtensions()) return;
    }
    const context = { query, searchPath: state.config.searchPath, searchType, extensions: searchType === 'custom' ? [...state.extensions] : [] };
    state.running = true;
    state.cancelling = false;
    state.requestId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    state.startedAt = Date.now();
    byId('searchControls').disabled = true;
    byId('searchButtonLabel').textContent = '搜索中';
    byId('searchForm').setAttribute('aria-busy', 'true');
    byId('searchFeedback').hidden = true;
    byId('retryExportBtn').disabled = true;
    byId('previousResultsNote').hidden = !state.lastResult;
    byId('previousResultsNote').textContent = '正在搜索新的条件，下方保留上一轮结果。';
    if (!state.lastResult) byId('emptyState').hidden = true;
    setExtensionPanel(false);
    byId('progressSection').hidden = false;
    updateProgress(0, 0, 0, { type: 'scanning', message: '正在准备搜索…' });
    byId('cancelSearchBtn').focus({ preventScroll: true });
    state.timer = setInterval(updateElapsedTime, 100);
    console.info('file_search.ui_submitted', { requestId: state.requestId, searchType, queryLength: query.length });
    try {
        const result = await window.customApis.performSearch(query, searchType, context.extensions.join(','), updateProgress, { requestId: state.requestId });
        if (result.cancelled) {
            setStatus('已取消');
            showSearchFeedback('搜索已取消，未生成本次结果文件。可以调整条件后重新搜索。', 'cancelled');
            byId('previousResultsNote').textContent = '本次搜索已取消，下方仍为上一轮结果。';
            if (!state.lastResult) showEmptyState('搜索已取消', '可以调整条件后重新搜索。');
        } else if (!result.success) {
            setStatus('搜索未完成', 'error');
            showSearchFeedback(result.message || '请检查目录权限后重试。', 'error');
            byId('previousResultsNote').textContent = '本次搜索未完成，下方仍为上一轮结果。';
            if (!state.lastResult) showEmptyState('搜索未完成', '可以重新选择目录或调整搜索条件。');
        } else {
            state.lastResult = result;
            state.lastQuery = query;
            state.lastContext = context;
            renderResults(result, query);
        }
        console.info('file_search.ui_finished', { requestId: state.requestId, success: result.success, cancelled: Boolean(result.cancelled), durationMs: Date.now() - state.startedAt });
    } catch (error) {
        setStatus('搜索未完成', 'error');
        showSearchFeedback(error.message || '搜索未完成，请重试。', 'error');
        byId('previousResultsNote').textContent = '本次搜索未完成，下方仍为上一轮结果。';
        if (!state.lastResult) showEmptyState('搜索未完成', '可以重新选择目录或调整搜索条件。');
        console.error('file_search.ui_failed', { requestId: state.requestId, durationMs: Date.now() - state.startedAt }, error);
    } finally {
        clearInterval(state.timer);
        state.running = false;
        state.cancelling = false;
        byId('searchControls').disabled = false;
        byId('searchForm').removeAttribute('aria-busy');
        byId('searchButtonLabel').textContent = '开始搜索';
        byId('progressSection').hidden = true;
        byId('retryExportBtn').disabled = state.exporting;
        if (document.activeElement === byId('cancelSearchBtn') || document.activeElement === document.body) {
            byId('searchInput').focus({ preventScroll: true });
        }
    }
}

function cancelSearch() {
    if (!state.running || state.cancelling || byId('cancelSearchBtn').disabled) return;
    if (window.customApis.cancelSearch(state.requestId)) {
        state.cancelling = true;
        byId('cancelSearchBtn').disabled = true;
        byId('cancelSearchBtn').textContent = '正在取消…';
        byId('progressMessage').textContent = '正在取消搜索…';
        console.info('file_search.ui_cancel_requested', { requestId: state.requestId });
    }
}

async function openResult(reveal) {
    if (!state.lastResult || !state.lastResult.savedPath) return;
    const result = state.lastResult;
    const button = byId(reveal ? 'openLocationBtn' : 'openFileBtn');
    const open = reveal ? window.customApis.openFileLocation : window.customApis.openFile;
    await runAction(button, () => open(result.savedPath, result.requestId), { name: reveal ? 'export_reveal' : 'export_open', requestId: result.requestId, result });
}

async function retryExport() {
    const result = state.lastResult;
    if (!result || state.running || state.exporting) return;
    const button = byId('retryExportBtn');
    const query = state.lastQuery;
    state.exporting = true;
    button.disabled = true;
    button.textContent = '正在保存…';
    try {
        const markdown = window.customApis.formatResultsAsMarkdown(result.results);
        const savedPath = await window.customApis.saveMarkdownFile(markdown, query, result.requestId);
        if (state.lastResult === result) {
            result.savedPath = savedPath;
            result.exportError = null;
            updateExportState(result);
            if (!state.running) setResultStatus(result);
        }
    } catch (error) {
        if (state.lastResult === result) {
            byId('resultError').textContent = error.message || '保存失败，请检查下载目录后重试。';
            byId('resultError').hidden = false;
        }
    } finally {
        state.exporting = false;
        button.disabled = state.running;
        button.textContent = '重新保存 Markdown';
    }
}

function bindEvents() {
    byId('searchForm').addEventListener('submit', startSearch);
    byId('updatePathBtn').addEventListener('click', selectDirectory);
    byId('searchInput').addEventListener('input', () => {
        byId('clearSearchBtn').hidden = !byId('searchInput').value;
        showFormError('');
    });
    byId('clearSearchBtn').addEventListener('click', () => {
        byId('searchInput').value = '';
        byId('clearSearchBtn').hidden = true;
        showFormError('');
        byId('searchInput').focus();
    });
    byId('searchInput').addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.isComposing) event.preventDefault();
    });
    document.querySelectorAll('input[name="searchType"]').forEach(input => input.addEventListener('change', () => {
        updateSearchMode(true);
        savePreferences();
    }));
    document.querySelectorAll('.ext-button').forEach(button => button.addEventListener('click', () => {
        const extension = button.dataset.ext;
        if (state.extensions.has(extension)) {
            state.extensions.delete(extension);
        } else {
            state.extensions.add(extension);
        }
        showFormError('');
        updateSelectedExtensionsDisplay();
        savePreferences();
    }));
    byId('customExtInput').addEventListener('input', () => {
        showFormError('');
        updateSelectedExtensionsDisplay();
    });
    byId('customExtInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            if (!event.isComposing) {
                showFormError('');
                commitExtensions();
            }
        }
    });
    byId('addExtBtn').addEventListener('click', () => {
        showFormError('');
        commitExtensions();
        byId('customExtInput').focus();
    });
    byId('clearExtBtn').addEventListener('click', () => {
        state.extensions.clear();
        byId('customExtInput').value = '';
        showFormError('');
        updateSelectedExtensionsDisplay();
        savePreferences();
    });
    byId('toggleExtBtn').addEventListener('click', () => setExtensionPanel(!state.extensionsExpanded));
    byId('copyDirectoryBtn').addEventListener('click', () => runAction(byId('copyDirectoryBtn'), () => window.customApis.copyText(state.config.searchPath, state.requestId), { name: 'directory_copy', requestId: state.requestId, errorElement: byId('formError'), copied: true }));
    byId('changeDirectoryBtn').addEventListener('click', selectDirectory);
    byId('editQueryBtn').addEventListener('click', () => {
        byId('searchInput').focus();
        byId('searchInput').select();
    });
    byId('widenScopeBtn').addEventListener('click', event => {
        document.querySelector('input[name="searchType"][value="all"]').checked = true;
        updateSearchMode();
        savePreferences();
        startSearch(event);
    });
    byId('focusResultsBtn').addEventListener('click', () => {
        const first = state.resultGroups.values().next().value;
        if (first) first.name.focus();
    });
    byId('loadMoreBtn').addEventListener('click', () => {
        const index = state.visibleMatches;
        appendResultPage();
        const match = state.lastResult.results[index];
        if (!match) return;
        const group = state.resultGroups.get(match.filePath || match.relativePath || match.filename);
        const target = group.body.hidden ? group.toggle : byId(`match-row-${index}`);
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'nearest' });
    });
    byId('cancelSearchBtn').addEventListener('click', cancelSearch);
    byId('openFileBtn').addEventListener('click', () => openResult(false));
    byId('openLocationBtn').addEventListener('click', () => openResult(true));
    byId('retryExportBtn').addEventListener('click', retryExport);
    document.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !state.running) {
            event.preventDefault();
            byId('searchInput').focus();
            byId('searchInput').select();
        }
        if (event.key === 'Escape' && state.running && !event.isComposing) {
            event.preventDefault();
            cancelSearch();
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    let configError = false;
    byId('focusShortcut').textContent = /Mac/i.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
    if (!window.customApis) {
        byId('environmentNotice').hidden = false;
        byId('searchButton').disabled = true;
        byId('updatePathBtn').disabled = true;
    } else {
        try {
            state.config = window.customApis.getConfig();
            state.extensions = new Set(parseExtensions(Array.isArray(state.config.extensions) ? state.config.extensions.join(',') : ''));
            const mode = state.config.searchType === 'custom' ? 'custom' : 'all';
            document.querySelector(`input[name="searchType"][value="${mode}"]`).checked = true;
        } catch (error) {
            configError = true;
            console.error('file_search.ui_config_failed', error);
        }
    }
    updatePath();
    updateSearchMode();
    if (configError) showFormError('无法恢复上次的设置，请重新选择搜索目录。');
    byId('searchInput').focus({ preventScroll: true });
});
