const PREVIEW_LIMIT = 100;
const byId = id => document.getElementById(id);
const state = {
    config: { searchPath: '', searchType: 'all', extensions: [] },
    extensions: new Set(),
    running: false,
    requestId: null,
    lastResult: null,
    lastQuery: '',
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
        byId(field).setAttribute('aria-invalid', 'true');
        byId(field).focus();
    }
}

function setStatus(label, status = '') {
    byId('stateLabel').textContent = label;
    byId('stateLabel').dataset.state = status;
}

function updatePath() {
    const path = state.config.searchPath;
    byId('searchPath').textContent = path || '选择要搜索的文件夹';
    byId('searchPath').classList.toggle('has-path', Boolean(path));
    byId('updatePathBtn').title = path || '选择搜索目录，包含所有子目录';
    byId('pathAction').textContent = path ? '更换目录' : '选择目录';
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
    const extensions = getSelectedExtensions();
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
            byId('customExtInput').value = parseExtensions(byId('customExtInput').value).filter(value => value !== ext).join(', ');
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
    byId('clearExtBtn').disabled = !extensions.length;
    const custom = document.querySelector('input[name="searchType"]:checked').value === 'custom';
    byId('filterHint').textContent = custom ? `已选择 ${extensions.length} 种文件类型` : '自动排除图片、视频等二进制文件';
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

function updateSearchMode() {
    const custom = document.querySelector('input[name="searchType"]:checked').value === 'custom';
    byId('customExtPanel').hidden = !custom;
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
    byId('progressBarFill').style.width = scanning ? '35%' : `${percentage}%`;
    byId('progressMessage').textContent = state.cancelling ? '正在取消搜索…' : status.message;
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

function appendHighlightedText(container, content, query) {
    // 仅创建文本节点，匹配的 HTML、脚本与后缀都不会作为页面内容执行。
    const matchIndex = content.indexOf(query);
    const start = matchIndex > 160 ? matchIndex - 160 : 0;
    const previewLength = Math.max(600, query.length + 320);
    const visible = content.slice(start, start + previewLength);
    if (start) container.append(document.createTextNode('…'));
    let cursor = 0;
    let index = visible.indexOf(query);
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
}

function renderResults(result, query) {
    const { stats, results } = result;
    const count = byId('resultCount');
    count.textContent = `${stats.totalMatches} 处匹配`;
    count.hidden = false;
    byId('resultContent').hidden = false;
    const summaries = [`搜索 ${stats.processedFiles} 个文件`, `${stats.matchedFiles} 个文件有匹配`, `用时 ${(stats.durationMs / 1000).toFixed(1)} 秒`];
    if (stats.skippedEntries) summaries.push(`${stats.skippedEntries} 个文件或目录无法读取，结果可能不完整`);
    if (stats.ignoredLinks) summaries.push(`已跳过 ${stats.ignoredLinks} 个符号链接`);
    byId('resultSummary').textContent = summaries.join(' · ');
    if (!results.length) {
        showEmptyState('没有找到匹配内容', '试试其他关键词、扩大文件范围，或检查目录是否正确。搜索区分大小写。');
    }
    const groups = new Map();
    results.slice(0, PREVIEW_LIMIT).forEach(resultLine => {
        const file = resultLine.relativePath || resultLine.filename;
        if (!groups.has(file)) groups.set(file, []);
        groups.get(file).push(resultLine);
    });
    const fragment = document.createDocumentFragment();
    groups.forEach((matches, file) => {
        const group = document.createElement('div');
        group.className = 'result-group';
        const heading = document.createElement('div');
        heading.className = 'result-file-heading';
        const name = document.createElement('span');
        name.className = 'result-file-path';
        name.textContent = file;
        name.title = matches[0].filePath || file;
        const matchCount = document.createElement('span');
        matchCount.className = 'result-file-count';
        matchCount.textContent = `预览 ${matches.length} 行`;
        heading.append(name, matchCount);
        group.append(heading);
        matches.forEach(match => {
            const row = document.createElement('div');
            row.className = 'result-line';
            const lineNumber = document.createElement('span');
            lineNumber.className = 'line-number';
            lineNumber.textContent = String(match.lineNumber);
            lineNumber.setAttribute('aria-label', `第 ${match.lineNumber} 行`);
            const content = document.createElement('code');
            content.className = 'line-content';
            appendHighlightedText(content, match.content, query);
            row.append(lineNumber, content);
            group.append(row);
        });
        fragment.append(group);
    });
    byId('resultList').replaceChildren(fragment);
    byId('previewNote').hidden = !results.length;
    const previewDescription = results.length > PREVIEW_LIMIT ? `已预览前 ${PREVIEW_LIMIT} 条匹配，长行会省略部分文字。` : '长行预览会省略部分文字。';
    byId('previewNote').textContent = previewDescription + (result.exportError ? '完整结果已保留，可点击下方按钮重新保存。' : '完整内容请查看导出的 Markdown 文件。');
    if (result.savedPath) {
        byId('exportBar').hidden = false;
        byId('exportFilename').textContent = result.savedPath.split(/[\\/]/).pop();
        byId('exportFilename').title = result.savedPath;
    }
    if (result.exportError) {
        byId('resultError').textContent = result.exportError;
        byId('resultError').hidden = false;
        byId('retryExportBtn').hidden = false;
    }
    setStatus(result.exportError ? '已完成 · 保存失败' : stats.skippedEntries ? '已完成 · 部分内容未读取' : '搜索完成', result.exportError || stats.skippedEntries ? 'error' : 'success');
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
    state.running = true;
    state.cancelling = false;
    state.lastResult = null;
    state.lastQuery = query;
    state.requestId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    state.startedAt = Date.now();
    byId('searchControls').disabled = true;
    byId('searchButtonLabel').textContent = '搜索中';
    byId('searchForm').setAttribute('aria-busy', 'true');
    ['emptyState', 'resultContent', 'exportBar', 'resultError', 'resultCount', 'retryExportBtn'].forEach(id => { byId(id).hidden = true; });
    byId('resultList').replaceChildren();
    byId('progressSection').hidden = false;
    updateProgress(0, 0, 0, { type: 'scanning', message: '正在准备搜索…' });
    state.timer = setInterval(updateElapsedTime, 100);
    console.info('file_search.ui_submitted', { requestId: state.requestId, searchType, queryLength: query.length });
    try {
        const result = await window.customApis.performSearch(query, searchType, getSelectedExtensions().join(','), updateProgress, { requestId: state.requestId });
        if (result.cancelled) {
            setStatus('已取消');
            showEmptyState('搜索已取消', '未生成结果文件。可以调整条件后重新搜索。');
        } else if (!result.success) {
            setStatus('搜索未完成', 'error');
            showEmptyState('搜索遇到了一点问题', result.message || '请检查目录权限后重试。');
        } else {
            state.lastResult = result;
            renderResults(result, query);
        }
        console.info('file_search.ui_finished', { requestId: state.requestId, success: result.success, cancelled: Boolean(result.cancelled), durationMs: Date.now() - state.startedAt });
    } catch (error) {
        setStatus('搜索未完成', 'error');
        showEmptyState('搜索遇到了一点问题', error.message || '请重试。');
        console.error('file_search.ui_failed', { requestId: state.requestId, durationMs: Date.now() - state.startedAt }, error);
    } finally {
        clearInterval(state.timer);
        state.running = false;
        state.cancelling = false;
        byId('searchControls').disabled = false;
        byId('searchForm').removeAttribute('aria-busy');
        byId('searchButtonLabel').textContent = '开始搜索';
        byId('progressSection').hidden = true;
        byId('searchInput').focus({ preventScroll: true });
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
    button.disabled = true;
    byId('resultError').hidden = true;
    try {
        const open = reveal ? window.customApis.openFileLocation : window.customApis.openFile;
        await open(result.savedPath, result.requestId);
    } catch (error) {
        if (state.lastResult === result) {
            byId('resultError').textContent = error.message || '打开失败，请重试。';
            byId('resultError').hidden = false;
        }
    } finally {
        button.disabled = false;
    }
}

async function retryExport() {
    const result = state.lastResult;
    if (!result || state.running) return;
    const button = byId('retryExportBtn');
    button.disabled = true;
    button.textContent = '正在保存…';
    try {
        const markdown = window.customApis.formatResultsAsMarkdown(result.results);
        const savedPath = await window.customApis.saveMarkdownFile(markdown, state.lastQuery, result.requestId);
        if (state.lastResult === result) {
            result.savedPath = savedPath;
            result.exportError = null;
            byId('resultError').hidden = true;
            button.hidden = true;
            renderResults(result, state.lastQuery);
        }
    } catch (error) {
        if (state.lastResult === result) {
            byId('resultError').textContent = error.message || '保存失败，请检查下载目录后重试。';
            byId('resultError').hidden = false;
        }
    } finally {
        button.disabled = false;
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
        updateSearchMode();
        savePreferences();
    }));
    document.querySelectorAll('.ext-button').forEach(button => button.addEventListener('click', () => {
        const extension = button.dataset.ext;
        if (getSelectedExtensions().includes(extension)) {
            state.extensions.delete(extension);
            byId('customExtInput').value = parseExtensions(byId('customExtInput').value).filter(ext => ext !== extension).join(', ');
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
