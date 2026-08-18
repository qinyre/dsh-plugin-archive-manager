# dsh-plugin-atlas

[![npm version](https://img.shields.io/npm/v/dsh-plugin-atlas)](https://www.npmjs.com/package/dsh-plugin-atlas)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

归档管理加对话刻度栏，一个插件两件事。

对话左侧多了一条细细的刻度尺：每条用户消息一个刻度，静止时所有刻度完全一致。鼠标靠近时，离指针最近的一条伸长变深，邻近几条按距离渐次变短——像水面被指尖划开，随指针上下连续流动（即 Focus+Context 鱼眼交互）。刻度间距恒定，不随消息数压缩：刻度少时居中，新刻度从中间向上下生长；一屏放不下时，刻度尺出现自己的迷你滚动条（滚轮或拖动滑块），不影响对话本身的滚动。点击跳转到对应消息，焦点处显示消息预览，`Alt+↑/↓` 在消息之间移动。颜色取自界面自身的主题变量，明暗两套外观都正常。

侧边栏底部有「已归档会话」入口，打开即可浏览被归档的会话：按工作区分组，搜索过滤，逐条或批量取消归档。取消归档走工作区注册表自身的写入路径，写完所有已连接的页面实时恢复侧边栏条目，不需要重启。归档列表的标题与轮次数取自会话日志本体。

自动归档是可选项，默认关闭：可以设定「不活跃超过 N 天自动归档」或「每个工作区只保留最近 M 条」，保存后每日核查一次，随时可试运行预览将归档哪些会话，再决定是否执行。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-atlas
```

或在 Web UI 的 设置 → 插件 里用 [dsh-plugin-install](https://github.com/qinyre/dsh-plugin-install) 直接安装。开发时安装本地源码检出：`dsh plugin --profile web add file:/path/to/dsh-plugin-atlas`。

卸载：

```sh
dsh plugin --profile web remove dsh-plugin-atlas
```

## 安全与边界

写操作（取消归档、保存规则、执行自动归档）要求同源 POST；规则数值有范围校验；自动归档只能调用 dsh 公开的 `archiveSession` 接口，不碰私有状态。取消归档依赖注册表内部的状态写入函数（核心契约里预留、但尚未公开 RPC 化的那条路径）——若未来 dsh 改动使其失效，插件会明确报错而不是损坏数据，此时更新 dsh 与本插件即可。插件不会删除任何会话或文件。

## 在 DSH Desktop 中

桌面客户端 [DSH Desktop](https://github.com/qinyre/dsh-Desktop) 里同样可用；DSH_HOME 由桌面壳层统一管理。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build
```

端到端 smoke 默认关闭，要求同级目录下存在 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码检出，且 Node ≥ 22.19：

```sh
DSH_ATLAS_PLUGIN_SMOKE=1 npm test
```

它会创建临时 `DSH_HOME`，将本插件安装进 `web` profile，启动 `dsh web`，并对状态、列表、预览、取消归档、规则与 CSRF 防护逐一探测。

## 许可

[MIT](./LICENSE)
