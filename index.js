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
            const searchText = searchInput.value.trim();

            if (!searchText) {
                alert('请输入要搜索的文本内容');
                return;
            }

            // 立即禁用搜索按钮
            searchButton.disabled = true;
            searchButton.style.cursor = 'not-allowed';

            // 显示搜索中动画
            showSearchingAnimation();

            try {
                // 执行搜索
                const result = await window.customApis.performSearch(searchText, (processed, total, matchedFiles, status) => {
                    console.log('更新进度:', processed, total, matchedFiles);
                    updateProgress(processed, total, matchedFiles, status);
                });

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
                <button class="btn btn-primary" id="btnOpen" ${!result.savedPath ? 'disabled' : ''}>打开文件</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(dialog);
    
    // 绑定按钮事件
    document.getElementById('btnLater').onclick = function() {
        document.body.removeChild(dialog);
    };
    
    document.getElementById('btnOpen').onclick = async function() {
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

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init); 