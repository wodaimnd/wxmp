# @local/wxmp

> 公众号文章工作台：在 DSH 里写稿、排版、生成封面、建草稿并发布到微信公众号。模型侧提供 wxmp 工具，界面侧提供三栏工作台（文章列表 / 预览 / 发布流水线）。

公众号文章工作台：在 DSH 里写稿、排版、生成封面、建草稿并发布到微信公众号。模型侧提供 wxmp 工具，界面侧提供三栏工作台（文章列表 / 预览 / 发布流水线）。

![version](https://img.shields.io/badge/version-1.8.0-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![DSH Web UI](https://img.shields.io/badge/DSH-Web%20UI-8b5cf6)

## 功能特性 / Features

- **Web 界面**：安装后在 DSH 左侧栏 / 设置中出现插件入口，界面风格与 DSH 宿主一致。
- **Host 能力**：Host 半边注册服务、HTTP 接口或 Agent 工具，与界面共享同一套实现。
- **DSH 插件**：通过 `dsh.bundle` 声明 Cordis bundle，随插件管理器安装/启用/禁用。
- **模块导出**：`.`、`./client`、`./icon`、`./locale/*.json`、`./package.json`。
- **关键词**：`deepseek`、`dsh`、`dsh-plugin`。

## 安装 / Installation

### 方式一：从 GitHub 克隆后作为本地 bundle 安装

```bash
git clone https://github.com/wodaimnd/wxmp.git
cd wxmp
```

然后在 DSH 中把该目录安装为本地 bundle（插件管理器「添加 → 本地目录」，或让 Agent 执行）：

```
plugin_manager action=install_bundle target=<绝对路径>/wxmp
```

### 方式二：DSH 插件管理器

打开 **设置 → 插件 → 添加**，选择本地目录后启用 `@local/wxmp`。

## 使用 / Usage

安装并启用后，刷新 DSH Web 页面，在左侧栏找到对应入口即可打开插件页面。

Host 半边随 bundle 行激活；配置项可在 `cordis.patch.yml` 或插件管理器的配置页面调整。

## 目录结构 / Layout

```text
wxmp/
├── package.json          # DSH 插件清单（dsh.bundle / dsh.client）
├── index.js              # Host 半边
├── client.js             # 浏览器半边
├── cordis.patch.yml      # bundle 行声明
├── LICENSE
└── README.md
```

## 开发 / Development

这是一份无构建步骤的纯 ESM 插件：修改源码后刷新生效，无需打包。

## 兼容性 / Compatibility

- 面向 DeepSeek Harness (DSH) Desktop / Web GUI。
- `dsh.client` 声明要求 DSH 的 Web 前端支持插件模块加载。

## English

公众号文章工作台：在 DSH 里写稿、排版、生成封面、建草稿并发布到微信公众号。模型侧提供 wxmp 工具，界面侧提供三栏工作台（文章列表 / 预览 / 发布流水线）。

Install it as a local bundle in DSH (`plugin_manager action=install_bundle target=<path>`), then enable it in **Settings → Plugins**.

## License

MIT. See [LICENSE](LICENSE).
