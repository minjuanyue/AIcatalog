# AI Catalog — Claude 问题记录器

一个 Chrome 浏览器扩展，自动记录你在 [claude.ai](https://claude.ai) 对话中提出的所有问题，并提供侧边栏快速回顾和一键定位。

---

## 功能特性

- **自动捕获**：无需手动操作，打开 claude.ai 后自动识别并记录每一条用户消息
- **侧边栏**：页面右侧滑出面板，展示当前对话的全部问题，点击任意一条即可滚动定位到原位置并高亮显示
- **弹窗总览**：点击工具栏图标，查看所有历史对话及各自记录的问题列表
- **导出 JSON**：一键将全部记录导出为 JSON 文件，方便备份或二次处理
- **清空数据**：支持一键清空所有存储记录（操作前有二次确认）
- **深色 / 浅色主题**：自动跟随系统配色偏好
- **隔离样式**：侧边栏使用 Shadow DOM，不与 claude.ai 页面样式产生冲突

---

## 截图

> *(可在此处添加截图)*

---

## 安装方法

此扩展尚未发布到 Chrome 应用商店，需手动加载。

1. 下载或克隆本仓库到本地：
   ```bash
   git clone https://github.com/your-username/aicatalog.git
   ```

2. 打开 Chrome，进入扩展管理页面：
   ```
   chrome://extensions/
   ```

3. 打开右上角的 **开发者模式**

4. 点击 **加载已解压的扩展程序**，选择本仓库的根目录（包含 `manifest.json` 的文件夹）

5. 扩展安装完成，打开 [claude.ai](https://claude.ai) 即可使用

---

## 使用方式

### 侧边栏（当前对话）

1. 打开任意 claude.ai 对话
2. 点击页面右下角的 **📋** 按钮打开侧边栏
3. 侧边栏列出当前对话中所有已记录的问题（附发送时间）
4. 点击任意问题条目 → 页面自动滚动到该消息并短暂高亮

### 弹窗（全部历史）

1. 点击 Chrome 工具栏中的扩展图标
2. 弹窗按最近更新时间列出所有对话
3. 展开任意对话可查看该对话下的全部问题
4. 点击 **导出 JSON** 下载完整记录文件
5. 点击 **清空所有** 删除全部本地记录

---

## 文件结构

```
aicatalog/
├── manifest.json      # MV3 扩展配置（权限：storage；host：claude.ai）
├── content.js         # 注入 claude.ai 的核心逻辑（Shadow DOM 侧边栏）
├── content.css        # 全局样式：切换按钮 + 高亮动画
├── popup.html         # 工具栏弹窗 HTML
├── popup.js           # 弹窗逻辑：渲染历史、导出、清空
├── popup.css          # 弹窗样式
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 技术说明

| 方面 | 实现 |
|------|------|
| Manifest 版本 | MV3 |
| 数据存储 | `chrome.storage.local`，单键 `aicatalog_data`，按对话 UUID 分组 |
| 样式隔离 | 侧边栏通过 `attachShadow` 挂载，面板样式注入至 shadow root |
| SPA 导航检测 | 拦截 `history.pushState / replaceState` + `popstate` 事件 + 500 ms URL 轮询（兼容 Next.js 内部路由绕过 patch 的情况） |
| 消息选择器 | 优先匹配 `[data-testid="user-message"]`，后续备用属性和类名兜底 |
| 防重复捕获 | DOM 节点打 `data-aic-id` / `data-aic-chat` 标记作为写入互斥锁 |
| 防对话串扰 | 切换对话时先将旧节点打上旧 chat ID；`chatVersion` 计数器使过期异步回调提前退出 |

---

## 已知限制

- 仅适用于 [claude.ai](https://claude.ai) 网页版，不支持 Claude API 或第三方客户端
- 消息选择器依赖 claude.ai 的 DOM 结构，若官方大幅改版可能需要更新
- 数据存储在本地浏览器，不跨设备同步

---

## 许可证

[MIT](LICENSE)
