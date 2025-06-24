// 在文件最开始添加调试信息
console.log('preload.js 开始执行');
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execSync } = require("node:child_process");

// 默认配置
const DEFAULT_CONFIG = {
  searchPath: 'C:\\Users'
};

// 配置存储的key
const CONFIG_KEY = 'find_and_config';

// 获取配置
function getConfig() {
  console.log('获取配置');
  try {
    const config = utools.dbStorage.getItem(CONFIG_KEY);
    if (config) {
      return config;
    }
  } catch (error) {
    console.error('读取配置失败:', error);
  }
  return DEFAULT_CONFIG;
}

// 保存配置
function saveConfig(config) {
  try {
    utools.dbStorage.setItem(CONFIG_KEY, config);
  } catch (error) {
    console.error('保存配置失败:', error);
  }
}

const binaryExts = [
  '.class', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', // 图片
  '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm', // 视频
  '.mp3', '.wav', '.aac', '.ogg', '.flac', // 音频
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', // 压缩包
  '.exe', '.dll', '.so', '.bin', '.dat', '.apk', '.iso', // 可执行/镜像
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx' // 办公文档（可选）
];

window.customApis = {
  // 文件系统操作
  readFile: (filename) => {
    return fs.readFileSync(filename, { encoding: "utf-8" });
  },
  getFolder: (filepath) => {
    return path.dirname(filepath);
  },
  getOSInfo: () => {
    return { arch: os.arch(), cpus: os.cpus(), release: os.release() };
  },
  execCommand: (command) => {
    execSync(command);
  },
  readdir: (dir) => {
    return fs.readdirSync(dir);
  },
  stat: (filepath) => {
    return fs.statSync(filepath);
  },
  writeFile: (filepath, content) => {
    return fs.writeFileSync(filepath, content, { encoding: "utf-8" });
  },
  pathJoin: (...paths) => {
    return path.join(...paths);
  },

  // 搜索相关方法
  searchInFile: (filePath, searchText) => {
    try {
      const content = fs.readFileSync(filePath, { encoding: "utf-8" });
      const lines = content.split('\n');
      const results = [];

      lines.forEach((line, index) => {
        if (line.includes(searchText)) {
          results.push({
            lineNumber: index + 1,
            content: line.trim()
          });
        }
      });

      return results;
    } catch (error) {
      console.error(`处理文件时发生错误 ${filePath}: ${error.message}`);
      return [];
    }
  },

  extractProjectName: (filePath) => {
    try {
      const config = getConfig();
      // 1. 获取配置的根目录
      let root = config.searchPath.replace(/\//g, '\\');
      // 2. 转义正则特殊字符
      root = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 3. 构造正则
      const reg = new RegExp(root + '\\\\(.*?)\\\\');
      // 4. 匹配
      const pathStr = filePath.replace(/\//g, '\\');
      const match = pathStr.match(reg) || [];
      return match[1] || "unknown";
    } catch (error) {
      console.error(`提取项目名时发生错误: ${error.message}`);
      return "unknown";
    }
  },

  formatResultsAsMarkdown: (results) => {
    if (!results || results.length === 0) {
      return "未找到匹配的结果。";
    }

    let markdown = "| 项目名 | 文件名 | 文件类型 | 行号 | 内容 |\n";
    markdown += "| ------ | ------ | -------- | ---- | ---- |\n";

    results.forEach(result => {
      const content = result.content.replace(/\|/g, '\\|');
      markdown += `| ${result.project} | ${result.filename} | ${result.fileType} | ${result.lineNumber} | ${content} |\n`;
    });

    return markdown;
  },

  saveMarkdownFile: (content, searchText) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `search_results_${searchText}_${timestamp}.md`;
    const filePath = path.join(utools.getPath('downloads'), fileName);

    try {
      fs.writeFileSync(filePath, content, { encoding: "utf-8" });
      return filePath;
    } catch (error) {
      console.error('保存文件时发生错误:', error);
      throw error;
    }
  },

  performSearch: (searchText, searchType, customExts, onProgress) => {
    return new Promise((resolve) => {
      const config = getConfig();
      const results = [];
      let matchedFiles = 0;
      let lastUpdateTime = Date.now();
      let savedPath = null;

      // 解析自定义后缀
      let extList = [];
      if (searchType === 'custom' && customExts) {
        extList = customExts.split(',').map(e => {
          e = e.trim().toLowerCase();
          // 确保后缀以点开头
          if (e && !e.startsWith('.')) {
            e = '.' + e;
          }
          return e;
        }).filter(e => e && e.length > 1);
      }

      // 异步统计文件总数
      let totalFiles = 0;
      function countFilesAsync(dir) {
        return new Promise((countResolve) => {
          onProgress(0, 0, 0, { type: 'scanning', message: '正在扫描文件...' });

          // 使用 setTimeout 让UI有机会更新
          setTimeout(() => {
            try {
              function traverse(currentDir) {
                const files = fs.readdirSync(currentDir);
                files.forEach(file => {
                  const filePath = path.join(currentDir, file);
                  const stat = fs.statSync(filePath);
                  if (stat.isDirectory()) {
                    traverse(filePath);
                  } else {
                    if (searchType === 'all') {
                      if (window.customApis.isTextFile(filePath)) totalFiles++;
                    } else if (searchType === 'custom') {
                      if (extList.includes(path.extname(file).toLowerCase())) totalFiles++;
                    }
                  }
                });
              }
              traverse(dir);
              onProgress(0, totalFiles, 0, { type: 'scanning', message: `扫描完成，共找到 ${totalFiles} 个文件，开始搜索...` });
              countResolve();
            } catch (error) {
              console.error('统计文件时发生错误:', error);
              countResolve();
            }
          }, 100); // 减少延迟到100ms，让UI能够立即响应
        });
      }

      // 先异步扫描文件，然后开始搜索
      countFilesAsync(config.searchPath).then(() => {
        let processedFiles = 0;
        function searchFiles(dir) {
          try {
            function traverse(currentDir) {
              const files = fs.readdirSync(currentDir);
              files.forEach(file => {
                const filePath = path.join(currentDir, file);
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                  traverse(filePath);
                } else {
                  let match = false;
                  let fileType = path.extname(file);
                  if (searchType === 'all') {
                    match = window.customApis.isTextFile(filePath);
                  } else if (searchType === 'custom') {
                    match = extList.includes(fileType.toLowerCase());
                  }
                  if (match) {
                    processedFiles++;
                    const fileResults = window.customApis.searchInFile(filePath, searchText);
                    if (fileResults.length > 0) {
                      matchedFiles++;
                      const projectName = window.customApis.extractProjectName(filePath);
                      fileResults.forEach(match => {
                        results.push({
                          project: projectName,
                          filename: file,
                          fileType: fileType,
                          lineNumber: match.lineNumber,
                          content: match.content
                        });
                      });
                    }
                    // 进度更新 - 减少更新频率到500ms
                    const currentTime = Date.now();
                    if (currentTime - lastUpdateTime >= 500) {
                      const percentage = Math.round((processedFiles / totalFiles) * 100);
                      onProgress(processedFiles, totalFiles, matchedFiles, {
                        type: 'searching',
                        message: `正在搜索... ${percentage}% (${processedFiles}/${totalFiles} 个文件) - 已找到 ${matchedFiles} 个匹配文件`
                      });
                      lastUpdateTime = currentTime;
                    }
                  }
                }
              });
            }
            traverse(dir);
          } catch (error) {
            console.error('搜索文件时发生错误:', error);
          }
        }

        try {
          searchFiles(config.searchPath);
          const markdown = window.customApis.formatResultsAsMarkdown(results);
          savedPath = window.customApis.saveMarkdownFile(markdown, searchText);

          onProgress(totalFiles, totalFiles, matchedFiles, {
            type: 'complete',
            message: `搜索完成！共搜索 ${totalFiles} 个文件，找到 ${matchedFiles} 个匹配文件，${results.length} 个匹配行。结果已保存到: ${savedPath}`
          });

          resolve({
            success: true,
            message: `搜索完成！共搜索 ${totalFiles} 个文件，找到 ${matchedFiles} 个匹配文件，${results.length} 个匹配行。结果已保存到: ${savedPath}`,
            results: results,
            stats: {
              totalFiles,
              matchedFiles,
              totalMatches: results.length
            },
            savedPath: savedPath
          });
        } catch (error) {
          onProgress(0, totalFiles, 0, {
            type: 'error',
            message: `搜索出错: ${error.message}`
          });

          resolve({
            success: false,
            message: `搜索出错: ${error.message}`,
            results: [],
            stats: {
              totalFiles,
              matchedFiles,
              totalMatches: 0
            },
            savedPath: null
          });
        }
      });
    });
  },

  // 配置相关方法
  getConfig: () => getConfig(),
  saveConfig: (config) => saveConfig(config),

  // 打开文件位置
  openFileLocation: (filePath) => {
    try {
      if (process.platform === 'win32') {
        execSync(`explorer /select,"${filePath}"`);
      } else if (process.platform === 'darwin') {
        execSync(`open -R "${filePath}"`);
      } else {
        execSync(`xdg-open "${path.dirname(filePath)}"`);
      }
    } catch (error) {
      console.error('打开文件位置失败:', error);
      throw error;
    }
  },

  selectDirectory: () => {
    // utools.showOpenDialog 返回数组，取第一个
    const paths = utools.showOpenDialog({
        properties: ['openDirectory']
    });
    return paths && paths[0] ? paths[0] : null;
  },

  isTextFile: (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    return !binaryExts.includes(ext);
  }
};

// 更新进度显示
function updateProgress(processed, total, matchedFiles, status) {
  const percentage = Math.round((processed / total) * 100);

  // 更新状态显示
  const searchStatus = document.getElementById('searchStatus');
  const searchStatusContent = document.getElementById('searchStatusContent');

  if (status) {
    searchStatus.className = 'search-status ' + status.type;
    searchStatusContent.textContent = status.message;
  }

  // 更新进度条
  const progressContainer = document.getElementById('progressContainer');
  const progressBarFill = document.getElementById('progressBarFill');
  const progressText = document.getElementById('progressText');
  const progressFiles = document.getElementById('progressFiles');
  const progressStats = document.getElementById('progressStats');

  progressContainer.classList.add('active');
  progressBarFill.style.width = `${percentage}%`;
  progressText.textContent = `${percentage}%`;
  progressFiles.textContent = `${processed}/${total} 文件`;
  progressStats.textContent = `已找到 ${matchedFiles} 个匹配文件`;
}

// 重置进度显示
function resetProgress() {
  const progressContainer = document.getElementById('progressContainer');
  const progressBarFill = document.getElementById('progressBarFill');
  const progressText = document.getElementById('progressText');
  const progressFiles = document.getElementById('progressFiles');
  const progressStats = document.getElementById('progressStats');
  const searchStatus = document.getElementById('searchStatus');
  const searchStatusContent = document.getElementById('searchStatusContent');

  progressContainer.classList.remove('active');
  progressBarFill.style.width = '0%';
  progressText.textContent = '0%';
  progressFiles.textContent = '0/0 文件';
  progressStats.textContent = '已找到 0 个匹配文件';
  searchStatus.className = 'search-status';
  searchStatusContent.textContent = '等待开始搜索...';
}

// 移除重复的事件绑定代码，统一在 index.js 中处理
