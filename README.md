# dsh-plugin-archive-manager

[![npm version](https://img.shields.io/npm/v/dsh-plugin-archive-manager)](https://www.npmjs.com/package/dsh-plugin-archive-manager)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

为 dsh 的 Web UI 补上会话归档管理：设置页的一级分区「归档管理」。本插件前身为 dsh-plugin-atlas；0.3.0 起官方 Web UI 自带对话刻度尺，插件不再内置刻度尺与输入历史，专注归档一件事，并随版更名。

## 归档管理

已归档会话按工作区分组，支持搜索与批量取消归档，还原后侧边栏实时恢复、无需重启。标题与轮次数取自会话日志本体。

![归档管理](docs/images/screenshot-archive.png)

自动归档默认关闭，可配置「不活跃超过 N 天」与「每个工作区保留最近 M 条」，每日核查一次，执行前可试运行预览清单。旧版 atlas 的自动归档规则会在升级后自动沿用。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-archive-manager
```

也可以在 Web UI 的 设置 → 插件 里按包名安装（经 [dsh-plugin-install](https://github.com/qinyre/dsh-plugin-install)），或直接从 GitHub 装：

```sh
dsh plugin --profile web add github:qinyre/dsh-plugin-archive-manager
```

开发时 `add file:/path/to/dsh-plugin-archive-manager` 可装本地检出，包内 `prepare` 脚本会自动构建。卸载把 `add` 换成 `remove` 即可。从旧包名升级：先 `remove dsh-plugin-atlas` 再安装本包，归档规则无需重配。

## 安全与边界

写操作要求同源 POST，规则数值有范围校验，自动归档只调用 dsh 公开的 `archiveSession`。取消归档经由注册表预留的状态写入路径完成——若未来 dsh 的改动使其失效，插件会明确报错而不是损坏数据，届时更新 dsh 与本插件即可。插件不删除任何会话或文件。

## 在 DSH Desktop 中

[DSH Desktop](https://github.com/qinyre/dsh-Desktop) 内嵌同一 Web UI，插件装上即在桌面内生效。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

端到端 smoke 默认关闭，要求同级目录存在 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码检出且 Node ≥ 22.19：

```sh
DSH_ARCHIVE_MANAGER_PLUGIN_SMOKE=1 pnpm test
```

它会建临时 `DSH_HOME`、把本插件装入 `web` profile、启动 `dsh web`，并逐一探测各路由。

## 许可

[MIT](./LICENSE)
