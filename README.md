# dsh-plugin-atlas

[![npm version](https://img.shields.io/npm/v/dsh-plugin-atlas)](https://www.npmjs.com/package/dsh-plugin-atlas)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

为 dsh 的 Web UI 补上三件事：对话区左缘的轮次刻度尺、输入框里的 `↑/↓` 历史翻找，以及设置页里的会话归档管理。

## 对话刻度尺

每轮对话对应刻度尺上的一个刻度，间距固定，超出可视高度后出现自带的细滚动条。整条历史的刻度由宿主端直接索引，长会话的切换与浏览不受加载拖累。

指针进入刻度尺时，最近的刻度伸长加深，邻近刻度随之递减伸缩；点击刻度跳转到对应消息，目标在尚未加载的历史里就先加载再滚动定位并短暂高亮；停留处显示该轮的输入与回复预览，`Alt+↑/↓` 在轮次间逐条移动。配色跟随宿主主题。

![对话刻度尺](docs/images/screenshot-rail.png)

## 输入历史

在输入框按 `↑`，最近发送的消息直接填入，连按向更早翻找，`↓` 返回，走回起点时恢复翻找前的草稿——和终端里翻历史命令一个手感。光标停在文本开头或末尾才触发翻找，光标在正文中时箭头照常移动，不打扰编辑。

## 归档管理

设置页的一级分区：已归档会话按工作区分组，支持搜索与批量取消归档，还原后侧边栏实时恢复、无需重启。标题与轮次数取自会话日志本体。

![归档管理](docs/images/screenshot-archive.png)

自动归档默认关闭，可配置「不活跃超过 N 天」与「每个工作区保留最近 M 条」，每日核查一次，执行前可试运行预览清单。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-atlas
```

也可以在 Web UI 的 设置 → 插件 里按包名安装（经 [dsh-plugin-install](https://github.com/qinyre/dsh-plugin-install)），或直接从 GitHub 装：

```sh
dsh plugin --profile web add github:qinyre/dsh-plugin-atlas
```

开发时 `add file:/path/to/dsh-plugin-atlas` 可装本地检出，包内 `prepare` 脚本会自动构建。卸载把 `add` 换成 `remove` 即可。

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
DSH_ATLAS_PLUGIN_SMOKE=1 pnpm test
```

它会建临时 `DSH_HOME`、把本插件装入 `web` profile、启动 `dsh web`，并逐一探测各路由。

## 许可

[MIT](./LICENSE)
