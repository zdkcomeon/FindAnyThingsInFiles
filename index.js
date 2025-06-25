// 初始化函数
function init() {
    bindEvents();
}

// 绑定事件
function bindEvents() {
    const searchButton = document.getElementById('searchButton');
    const searchInput = document.getElementById('searchInput');

    if (searchButton) {
        searchButton.onclick = async function () {
            console.log('搜索按钮被点击');

            // 防止重复点击 - 如果按钮已经被禁用，直接返回
            if (searchButton.disabled) {
                console.log('搜索正在进行中，忽略重复点击');
                return;
            }

            const searchText = searchInput.value.trim();

            if (!searchText) {
                alert('请输入要搜索的文本内容');
                return;
            }

            // 立即禁用搜索按钮和显示搜索动画
            searchButton.disabled = true;
            searchButton.style.cursor = 'not-allowed';
            showSearchingAnimation();

            const searchType = document.querySelector('input[name="searchType"]:checked').value;
            const customExts = getSelectedExtensions();

            try {
                // 执行搜索
                const result = await window.customApis.performSearch(
                    searchText,
                    searchType,
                    customExts,
                    (processed, total, matchedFiles, status) => {
                        updateProgress(processed, total, matchedFiles, status);
                    }
                );

                if (result.success) {
                    console.log('搜索成功:', result.message);
                    // 隐藏搜索中动画
                    hideSearchingAnimation();
                    // 显示完成弹窗
                    showCompletionDialog(result);
                } else {
                    console.error('搜索失败:', result.message);
                    // 隐藏搜索中动画
                    hideSearchingAnimation();
                    alert('搜索失败: ' + result.message);
                }
            } catch (error) {
                console.error('搜索出错:', error);
                // 隐藏搜索中动画
                hideSearchingAnimation();
                alert('搜索出错: ' + error.message);
            } finally {
                // 启用搜索按钮
                searchButton.disabled = false;
                searchButton.style.cursor = 'pointer';
            }
        };
    }

    if (searchInput) {
        searchInput.onkeypress = function (e) {
            if (e.key === 'Enter') {
                console.log('按下回车键');
                searchButton.click();
            }
        };
    }

    if (document.getElementById('updatePathBtn')) {
        document.getElementById('updatePathBtn').onclick = async function() {
            const newPath = window.customApis.selectDirectory();
            if (newPath) {
                // 更新配置
                const config = window.customApis.getConfig();
                config.searchPath = newPath;
                window.customApis.saveConfig(config);
                // 更新页面显示
                document.getElementById('searchPath').textContent = newPath;
            }
        };
    }
}

// 显示搜索中动画
function showSearchingAnimation() {
    // 如果已经存在搜索对话框，先移除
    const existingDialog = document.getElementById('searchingDialog');
    if (existingDialog) {
        document.body.removeChild(existingDialog);
    }

    const dialog = document.createElement('div');
    dialog.className = 'searching-dialog';
    dialog.id = 'searchingDialog';
    dialog.innerHTML = `
        <div class="dialog-content">
            <div class="searching-animation">
                <div class="spinner"></div>
                <span>正在搜索中...</span>
            </div>
            <div class="search-status-content" id="searchStatusContent">准备开始搜索...</div>
        </div>
    `;

    document.body.appendChild(dialog);
}

// 隐藏搜索中动画
function hideSearchingAnimation() {
    const dialog = document.getElementById('searchingDialog');
    if (dialog) {
        document.body.removeChild(dialog);
    }
}

// 显示完成弹窗
function showCompletionDialog(result) {
    const dialog = document.createElement('div');
    dialog.className = 'completion-dialog';
    dialog.innerHTML = `
        <div class="dialog-content">
            <h3>搜索完成</h3>
            <p>${result.message}</p>
            <div class="dialog-buttons">
                <button class="btn btn-secondary" id="btnLater">稍后查看</button>
                <button class="btn btn-info" id="btnOpenLocation" ${!result.savedPath ? 'disabled' : ''}>打开位置</button>
                <button class="btn btn-primary" id="btnOpen" ${!result.savedPath ? 'disabled' : ''}>打开文件</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(dialog);
    
    // 绑定按钮事件
    document.getElementById('btnLater').onclick = function() {
        document.body.removeChild(dialog);
    };

    // 打开文件位置按钮
    document.getElementById('btnOpenLocation').onclick = async function() {
        try {
            if (result.savedPath) {
                await window.customApis.openFileLocation(result.savedPath);
            } else {
                alert('无法打开文件：文件路径无效');
            }
        } catch (error) {
            console.error('打开文件位置失败:', error);
            alert('打开文件位置失败: ' + error.message);
        } finally {
            document.body.removeChild(dialog);
        }
    };

    // 直接打开文件按钮
    document.getElementById('btnOpen').onclick = async function() {
        try {
            if (result.savedPath) {
                await window.customApis.openFile(result.savedPath);
            } else {
                alert('无法打开文件：文件路径无效');
            }
        } catch (error) {
            console.error('打开文件失败:', error);
            alert('打开文件失败: ' + error.message);
        } finally {
            document.body.removeChild(dialog);
        }
    };
}

// 更新进度显示
function updateProgress(processed, total, matchedFiles, status) {
    const searchStatusContent = document.getElementById('searchStatusContent');
    if (searchStatusContent && status) {
        searchStatusContent.textContent = status.message;
    }
    
    // 更新进度条
    const progressContainer = document.getElementById('progressContainer');
    const progressBarFill = document.getElementById('progressBarFill');
    const progressText = document.getElementById('progressText');
    const progressFiles = document.getElementById('progressFiles');
    const progressStats = document.getElementById('progressStats');
    
    if (progressContainer && progressBarFill && progressText && progressFiles && progressStats) {
        const percentage = Math.round((processed / total) * 100);
        progressContainer.classList.add('active');
        progressBarFill.style.width = `${percentage}%`;
        progressText.textContent = `${percentage}%`;
        progressFiles.textContent = `${processed}/${total} 文件`;
        progressStats.textContent = `已找到 ${matchedFiles} 个匹配文件`;
    }
}

// 文件后缀管理
let selectedExtensions = new Set();

// 获取选中的文件后缀
function getSelectedExtensions() {
    const customInput = document.getElementById('customExtInput').value.trim();
    const allExts = new Set([...selectedExtensions]);

    // 添加自定义输入的后缀
    if (customInput) {
        const customExts = customInput.split(',').map(ext => ext.trim()).filter(ext => ext);
        customExts.forEach(ext => {
            if (!ext.startsWith('.')) {
                ext = '.' + ext;
            }
            allExts.add(ext);
        });
    }

    return Array.from(allExts).join(',');
}

// 更新选中后缀的显示
function updateSelectedExtensionsDisplay() {
    const container = document.getElementById('selectedExtTags');
    const customInput = document.getElementById('customExtInput').value.trim();

    // 收集所有后缀
    const allExts = new Set([...selectedExtensions]);
    if (customInput) {
        const customExts = customInput.split(',').map(ext => ext.trim()).filter(ext => ext);
        customExts.forEach(ext => {
            if (!ext.startsWith('.')) {
                ext = '.' + ext;
            }
            allExts.add(ext);
        });
    }

    if (allExts.size === 0) {
        container.innerHTML = '<span class="no-selection">未选择任何文件类型</span>';
        return;
    }

    container.innerHTML = '';
    allExts.forEach(ext => {
        const tag = document.createElement('span');
        tag.className = 'ext-tag';
        tag.innerHTML = `${ext} <span class="remove" data-ext="${ext}">×</span>`;
        container.appendChild(tag);
    });
}

// 切换后缀选择状态
function toggleExtension(ext) {
    if (selectedExtensions.has(ext)) {
        selectedExtensions.delete(ext);
    } else {
        selectedExtensions.add(ext);
    }

    // 更新按钮状态
    const btn = document.querySelector(`[data-ext="${ext}"]`);
    if (btn) {
        btn.classList.toggle('selected', selectedExtensions.has(ext));
    }

    updateSelectedExtensionsDisplay();
}

// 移除后缀
function removeExtension(ext) {
    selectedExtensions.delete(ext);

    // 更新按钮状态
    const btn = document.querySelector(`[data-ext="${ext}"]`);
    if (btn) {
        btn.classList.remove('selected');
    }

    // 如果是自定义输入的后缀，从输入框中移除
    const customInput = document.getElementById('customExtInput');
    const customExts = customInput.value.split(',').map(ext => ext.trim()).filter(ext => ext);
    const cleanExt = ext.startsWith('.') ? ext.substring(1) : ext;
    const updatedExts = customExts.filter(e => e !== ext && e !== cleanExt);
    customInput.value = updatedExts.join(',');

    updateSelectedExtensionsDisplay();
}

// 清空所有选择
function clearAllExtensions() {
    selectedExtensions.clear();
    document.getElementById('customExtInput').value = '';

    // 清除所有按钮的选中状态
    document.querySelectorAll('.ext-btn.selected').forEach(btn => {
        btn.classList.remove('selected');
    });

    updateSelectedExtensionsDisplay();
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
    // 1. 初始化事件绑定
    init();

    // 2. 自动加载上次保存的目录
    const config = window.customApis.getConfig();
    if (config && config.searchPath) {
        document.getElementById('searchPath').textContent = config.searchPath;
    }

    // 3. 绑定更新目录按钮
    const updateBtn = document.getElementById('updatePathBtn');
    if (updateBtn) {
        updateBtn.onclick = async function() {
            const newPath = window.customApis.selectDirectory();
            if (newPath) {
                // 更新配置
                const config = window.customApis.getConfig();
                config.searchPath = newPath;
                window.customApis.saveConfig(config);
                // 更新页面显示
                document.getElementById('searchPath').textContent = newPath;
            }
        };
    }

    // 搜索类型切换
    document.querySelectorAll('input[name="searchType"]').forEach(radio => {
        radio.onchange = function() {
            const customExtPanel = document.getElementById('customExtPanel');
            customExtPanel.style.display = this.value === 'custom' ? 'block' : 'none';
        };
    });

    // 常用后缀按钮事件
    document.querySelectorAll('.ext-btn').forEach(btn => {
        btn.onclick = function() {
            const ext = this.getAttribute('data-ext');
            toggleExtension(ext);
        };
    });

    // 自定义输入框事件
    const customExtInput = document.getElementById('customExtInput');
    if (customExtInput) {
        customExtInput.oninput = function() {
            updateSelectedExtensionsDisplay();
        };
    }

    // 清空按钮事件
    const clearExtBtn = document.getElementById('clearExtBtn');
    if (clearExtBtn) {
        clearExtBtn.onclick = function() {
            clearAllExtensions();
        };
    }

    // 选中标签的移除事件（事件委托）
    const selectedExtTags = document.getElementById('selectedExtTags');
    if (selectedExtTags) {
        selectedExtTags.onclick = function(e) {
            if (e.target.classList.contains('remove')) {
                const ext = e.target.getAttribute('data-ext');
                removeExtension(ext);
            }
        };
    }
});