// 文件操作留在 preload，页面只通过 customApis 访问本地能力。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomBytes } = require('node:crypto');

const CONFIG_KEY = 'find_and_config';
const DEFAULT_CONFIG = { searchPath: '', searchType: 'all', extensions: [], excludedFiles: [], excludedExtensions: [] };
const binaryExts = [
  '.class', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.heic',
  '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm',
  '.mp3', '.wav', '.aac', '.ogg', '.flac',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.whl',
  '.exe', '.dll', '.so', '.bin', '.dat', '.apk', '.iso',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
  '.woff', '.woff2', '.ttf', '.otf', '.db', '.sqlite'
];
let activeSearch = null;

function getConfig(requestId) {
  const startedAt = Date.now();
  console.debug('file_search.config_read_started', { requestId, key: CONFIG_KEY });
  try {
    const stored = utools.dbStorage.getItem(CONFIG_KEY);
    const config = stored && typeof stored === 'object' ? stored : {};
    console.debug('file_search.config_read_completed', { requestId, key: CONFIG_KEY, hit: Boolean(stored), durationMs: Date.now() - startedAt });
    return { ...DEFAULT_CONFIG, ...config, searchPath: typeof config.searchPath === 'string' ? config.searchPath : '' };
  } catch (error) {
    console.error('file_search.config_read_failed', { requestId, key: CONFIG_KEY, durationMs: Date.now() - startedAt }, error);
    return { ...DEFAULT_CONFIG, extensions: [] };
  }
}

function saveConfig(config, requestId) {
  const startedAt = Date.now();
  console.debug('file_search.config_write_started', { requestId, key: CONFIG_KEY, searchPath: config.searchPath });
  try {
    utools.dbStorage.setItem(CONFIG_KEY, config);
    console.debug('file_search.config_write_completed', { requestId, key: CONFIG_KEY, durationMs: Date.now() - startedAt });
  } catch (error) {
    console.error('file_search.config_write_failed', { requestId, key: CONFIG_KEY, durationMs: Date.now() - startedAt }, error);
    throw new Error('设置保存失败，请重试。');
  }
}

function normalizeExtensions(value) {
  return [...new Set(String(value || '').split(/[,，\s]+/).filter(Boolean).map(ext => (ext.startsWith('.') ? ext : '.' + ext).toLowerCase()))];
}

function sanitizeFileName(fileName) {
  // 按字符截断，避免中文关键词使文件名超过常见文件系统的字节限制。
  return Array.from(fileName.replace(/[<>:"|?*\\/\x00-\x1f]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')).slice(0, 40).join('');
}

function escapeMarkdown(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function formatResultsAsMarkdown(results) {
  if (!results.length) return '未找到匹配的结果。';
  const rows = results.map(result => '| ' + [result.project, result.filename, result.fileType, result.lineNumber, result.content].map(escapeMarkdown).join(' | ') + ' |');
  return ['| 项目名 | 文件名 | 文件类型 | 行号 | 内容 |', '| ------ | ------ | -------- | ---- | ---- |', ...rows].join('\n') + '\n';
}

async function saveMarkdownFile(content, searchText, requestId) {
  const startedAt = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `search_results_${sanitizeFileName(searchText) || 'search'}_${timestamp}_${randomBytes(3).toString('hex')}.md`;
  // 文件名包含用户查询；日志只记录目录、长度和关联标识，不记录查询文本。
  let directory;
  try {
    directory = utools.getPath('downloads');
    console.info('file_search.export_started', { requestId, directory, characters: content.length });
    const savedPath = path.join(directory, filename);
    await fs.promises.writeFile(savedPath, content, { encoding: 'utf8', flag: 'wx' });
    console.info('file_search.export_completed', { requestId, directory, durationMs: Date.now() - startedAt });
    return savedPath;
  } catch (error) {
    // 文件系统异常自带导出文件名，用错误码和去除首行的调用栈避免泄漏搜索内容。
    console.error('file_search.export_failed', { requestId, directory, code: error.code, durationMs: Date.now() - startedAt, stack: String(error.stack || '').split('\n').slice(1).join('\n') });
    throw new Error('搜索已完成，但无法保存到下载目录。请检查目录权限和磁盘空间。');
  }
}

function assertNotCancelled(task) {
  if (task.cancelled) {
    const error = new Error('搜索已取消');
    error.code = 'SEARCH_CANCELLED';
    throw error;
  }
}

async function collectFiles(root, extensions, excludedFiles, excludedExtensions, task, stats, report) {
  const directories = [root];
  const files = [];
  while (directories.length) {
    assertNotCancelled(task);
    const directory = directories.pop();
    const startedAt = Date.now();
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === root) throw error;
      stats.skippedEntries++;
      console.warn('file_search.directory_skipped', { requestId: task.id, directory, durationMs: Date.now() - startedAt }, error);
      continue;
    }
    console.debug('file_search.directory_loaded', { requestId: task.id, directory, count: entries.length, durationMs: Date.now() - startedAt });
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        stats.ignoredLinks++;
      } else if (entry.isDirectory()) {
        directories.push(filePath);
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (!binaryExts.includes(extension) && (!extensions || extensions.includes(extension)) && !excludedFiles.has(entry.name) && !excludedExtensions.has(extension)) files.push(filePath);
      }
      if (index % 500 === 499) {
        await new Promise(resolve => setTimeout(resolve, 0));
        assertNotCancelled(task);
      }
    }
    stats.totalFiles = files.length;
    report('scanning', `正在扫描目录，已找到 ${files.length} 个可搜索文件`);
  }
  return files;
}

async function searchFile(filePath, searchText, root, task, report) {
  const startedAt = Date.now();
  console.debug('file_search.file_started', { requestId: task.id, filePath });
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const matches = [];
  let lineNumber = 0;
  task.stream = stream;
  task.reader = reader;
  try {
    for await (const line of reader) {
      assertNotCancelled(task);
      lineNumber++;
      if (line.includes(searchText)) {
        const relativePath = path.relative(root, filePath);
        matches.push({
          project: relativePath.includes(path.sep) ? relativePath.split(path.sep)[0] : path.basename(root),
          filename: path.basename(filePath),
          fileType: path.extname(filePath),
          filePath,
          relativePath,
          lineNumber,
          content: line.trim()
        });
      }
      if (lineNumber % 1000 === 0) {
        report('searching', '正在读取文件内容…');
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    assertNotCancelled(task);
    console.debug('file_search.file_completed', { requestId: task.id, filePath, lines: lineNumber, matches: matches.length, durationMs: Date.now() - startedAt });
    return matches;
  } finally {
    reader.close();
    stream.destroy();
    task.stream = null;
    task.reader = null;
  }
}

async function performSearch(searchText, searchType, customExts, onProgress = () => {}, options = {}) {
  const startedAt = Date.now();
  const requestId = options.requestId || randomBytes(8).toString('hex');
  const stats = { totalFiles: 0, processedFiles: 0, matchedFiles: 0, totalMatches: 0, skippedEntries: 0, ignoredLinks: 0, durationMs: 0 };
  console.info('file_search.request_received', { requestId, searchType, queryLength: typeof searchText === 'string' ? searchText.length : 0 });
  if (activeSearch) {
    console.warn('file_search.request_busy', { requestId, activeRequestId: activeSearch.id });
    return { success: false, requestId, message: '已有搜索正在进行，请稍后再试。', results: [], stats };
  }
  const task = { id: requestId, cancelled: false, phase: 'validating', stream: null, reader: null };
  activeSearch = task;
  let lastProgressAt = 0;
  let root;
  const results = [];
  const report = (type, message, force = false) => {
    if (!force && Date.now() - lastProgressAt < 100) return;
    lastProgressAt = Date.now();
    onProgress(stats.processedFiles, stats.totalFiles, stats.matchedFiles, { type, message, requestId, totalMatches: stats.totalMatches, durationMs: Date.now() - startedAt });
  };
  try {
    const config = getConfig(requestId);
    root = config.searchPath;
    const extensions = normalizeExtensions(customExts);
    if (options.excludedFiles !== undefined && (!Array.isArray(options.excludedFiles) || options.excludedFiles.some(name => typeof name !== 'string' || !name))) {
      throw new Error('排除文件名格式不正确。');
    }
    const excludedFiles = new Set(options.excludedFiles || []);
    if (options.excludedExtensions !== undefined && (!Array.isArray(options.excludedExtensions) || options.excludedExtensions.some(ext => typeof ext !== 'string' || !/^\.[a-z0-9_+-]+$/i.test(ext)))) {
      throw new Error('排除文件类型格式不正确。');
    }
    const excludedExtensions = new Set((options.excludedExtensions || []).map(ext => ext.toLowerCase()));
    if (typeof searchText !== 'string' || !searchText.trim()) throw new Error('请输入要搜索的内容。');
    if (!root) throw new Error('请先选择要搜索的目录。');
    if (!['all', 'custom'].includes(searchType)) throw new Error('请选择有效的文件范围。');
    if (searchType === 'custom' && (!extensions.length || extensions.some(ext => !/^\.[a-z0-9_+-]+$/.test(ext) || binaryExts.includes(ext)))) {
      throw new Error('请选择有效的文本文件后缀，不能使用图片、视频等二进制文件类型。');
    }
    console.info('file_search.parameters_validated', { requestId, root, searchType, extensions: searchType === 'custom' ? extensions : [], excludedFileCount: excludedFiles.size, excludedExtensionCount: excludedExtensions.size });
    task.phase = 'scanning';
    const scanStartedAt = Date.now();
    report('scanning', '正在扫描目录…', true);
    console.info('file_search.scan_started', { requestId, root });
    const files = await collectFiles(root, searchType === 'custom' ? extensions : null, excludedFiles, excludedExtensions, task, stats, report);
    assertNotCancelled(task);
    console.info('file_search.scan_completed', { requestId, root, ...stats, durationMs: Date.now() - scanStartedAt });
    task.phase = 'searching';
    report('searching', `正在搜索 ${files.length} 个文件…`, true);
    const searchStartedAt = Date.now();
    console.info('file_search.content_started', { requestId, count: files.length });
    for (const filePath of files) {
      assertNotCancelled(task);
      const fileStartedAt = Date.now();
      try {
        const matches = await searchFile(filePath, searchText, root, task, report);
        if (matches.length) stats.matchedFiles++;
        for (const match of matches) results.push(match);
        stats.totalMatches += matches.length;
      } catch (error) {
        if (task.cancelled) throw error;
        stats.skippedEntries++;
        console.warn('file_search.file_skipped', { requestId, filePath, durationMs: Date.now() - fileStartedAt }, error);
      }
      stats.processedFiles++;
      report('searching', `已搜索 ${stats.processedFiles} / ${stats.totalFiles} 个文件`);
    }
    assertNotCancelled(task);
    console.info('file_search.content_completed', { requestId, ...stats, durationMs: Date.now() - searchStartedAt });
    task.phase = 'exporting';
    report('exporting', '搜索完成，正在保存 Markdown…', true);
    let savedPath = null;
    let exportError = null;
    try {
      savedPath = await saveMarkdownFile(formatResultsAsMarkdown(results), searchText, requestId);
    } catch (error) {
      exportError = error.message;
    }
    stats.durationMs = Date.now() - startedAt;
    report('complete', '搜索完成', true);
    console.info('file_search.completed', { requestId, ...stats, exported: Boolean(savedPath) });
    return { success: true, requestId, results, stats, savedPath, exportError };
  } catch (error) {
    stats.durationMs = Date.now() - startedAt;
    if (task.cancelled) {
      console.info('file_search.cancelled', { requestId, phase: task.phase, ...stats });
      return { success: false, cancelled: true, requestId, message: '搜索已取消，未生成结果文件。', results: [], stats, savedPath: null };
    }
    console.error('file_search.failed', { requestId, phase: task.phase, root, ...stats }, error);
    const message = ['ENOENT', 'ENOTDIR'].includes(error.code) ? '搜索目录不存在，请重新选择目录。' : error.code === 'EACCES' || error.code === 'EPERM' ? '无法读取搜索目录，请检查访问权限。' : error.message;
    return { success: false, requestId, message, results: [], stats, savedPath: null };
  } finally {
    if (activeSearch === task) activeSearch = null;
  }
}

function cancelSearch(requestId) {
  if (!activeSearch || activeSearch.id !== requestId || activeSearch.phase === 'exporting') return false;
  activeSearch.cancelled = true;
  if (activeSearch.reader) activeSearch.reader.close();
  if (activeSearch.stream) activeSearch.stream.destroy();
  console.info('file_search.cancel_requested', { requestId, phase: activeSearch.phase });
  return true;
}

async function openResult(filePath, reveal, requestId, source = false) {
  const startedAt = Date.now();
  const action = reveal ? 'reveal' : 'open';
  const target = source ? 'source' : 'export';
  console.info('file_search.result_open_started', { requestId, action, target });
  try {
    await fs.promises.access(filePath);
    const errorMessage = reveal ? await utools.shellShowItemInFolder(filePath) : await utools.shellOpenPath(filePath);
    if (typeof errorMessage === 'string' && errorMessage) throw new Error('系统无法打开结果文件，请检查默认应用设置。');
    console.info('file_search.result_open_completed', { requestId, action, target, durationMs: Date.now() - startedAt });
  } catch (error) {
    console.error('file_search.result_open_failed', { requestId, action, target, code: error.code, durationMs: Date.now() - startedAt, stack: String(error.stack || '').split('\n').filter(line => /^\s+at /.test(line)).join('\n') });
    if (source) throw new Error(error.code === 'ENOENT' ? '原文件已被移动或删除，请重新搜索。' : '无法打开原文件，请检查文件权限或默认应用设置。');
    throw new Error(error.code === 'ENOENT' ? '结果文件已被移动或删除，请重新搜索。' : '无法打开结果，请检查文件权限或默认应用设置。');
  }
}

function copyText(text, requestId) {
  const startedAt = Date.now();
  console.info('file_search.clipboard_started', { requestId, characters: text.length });
  try {
    if (utools.copyText(text) === false) throw new Error('Clipboard write failed');
    console.info('file_search.clipboard_completed', { requestId, characters: text.length, durationMs: Date.now() - startedAt });
  } catch (error) {
    console.error('file_search.clipboard_failed', { requestId, characters: text.length, durationMs: Date.now() - startedAt, code: error.code, stack: String(error.stack || '').split('\n').filter(line => /^\s+at /.test(line)).join('\n') });
    throw new Error('复制失败，请重试或手动选择文本复制。');
  }
}

window.customApis = {
  readFile: filename => fs.readFileSync(filename, { encoding: 'utf8' }),
  getFolder: filepath => path.dirname(filepath),
  getOSInfo: () => ({ arch: os.arch(), cpus: os.cpus(), release: os.release() }),
  execCommand: command => execSync(command),
  readdir: directory => fs.readdirSync(directory),
  stat: filepath => fs.statSync(filepath),
  writeFile: (filepath, content) => fs.writeFileSync(filepath, content, { encoding: 'utf8' }),
  pathJoin: (...paths) => path.join(...paths),
  getConfig,
  saveConfig,
  normalizeExtensions,
  sanitizeFileName,
  formatResultsAsMarkdown,
  saveMarkdownFile,
  performSearch,
  cancelSearch,
  openFile: (filePath, requestId) => openResult(filePath, false, requestId),
  openFileLocation: (filePath, requestId) => openResult(filePath, true, requestId),
  openSourceFile: (filePath, requestId) => openResult(filePath, false, requestId, true),
  openSourceFileLocation: (filePath, requestId) => openResult(filePath, true, requestId, true),
  copyText,
  selectDirectory: () => {
    const paths = utools.showOpenDialog({ title: '选择搜索目录', properties: ['openDirectory'] });
    return paths && paths[0] ? paths[0] : null;
  },
  isTextFile: filePath => !binaryExts.includes(path.extname(filePath).toLowerCase()),
  getBinaryExts: () => [...binaryExts]
};
