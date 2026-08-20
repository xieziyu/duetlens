# Duetlens

Electron 桌面应用:人与 codex agent 协同对话式的 code review。主进程后端 Node/TS,渲染层 React SPA。

设计目标与已拍板决策见 [docs/README.md](docs/README.md)。本文件只写**工程约定**。

## 文档约定

- 文档写**目标、决策与理由**,不复述代码、不记进度、不记 HEAD sha / 最后更新日期 —— 快照值漏改一次就开始骗人,时间线查 `git log`。
- 不维护需要人肉同步才为真的第二份真相源。冻结或删除,并在制品自己的目录里写清以谁为准。

## 版本控制

- `but`(GitButler)是版本控制入口,见 gitbutler skill。
- 每个 fix / feature 走新分支 + PR;只有 release 版本号提交可直接落 `main`。
- **功能 PR 收成单 commit**;评审后的修复走 `but amend` / `but squash` 保持这个形状。
- 不 push、不开 PR,除非用户明说。**例外:发版流程里的 release PR** —— 说了发版就是说了要那个 PR,本地闸门全绿就直接 push + 开 PR,别再问一次。

## 语言

- commit message 与 PR 标题:**英文**,`type(scope): description`。
- 代码注释与文档正文:简体中文;代码标识符 / 路径 / `category` 枚举保留英文。
- agent 产出的 finding `title` / `body` 同此规则 —— prose 半边在可配置的 `tone` 节,枚举半边在锁定的 `BUILTIN_PROTOCOL`,别把 category 列表挪回 `tone`。

## 文件命名

- `src/backend/**`、脚本、非组件模块:kebab-case。
- `src/renderer/**`:React 惯例 —— 组件 PascalCase(文件名镜像组件名,协同 CSS 同名)、hook camelCase、入口小写。刻意不做全仓统一。

## 单一来源(别开第二份)

| 东西 | 唯一来源 |
| --- | --- |
| 配色 tokens | `src/renderer/theme/tokens.css`(`mockup/tokens.css` 是冻结副本) |
| 提示词内置节与合并逻辑 | `src/shared/prompt.ts`(backend 只留 IO 与锁定段;preview fixture 复用同一份) |
| MCP 工具名 / 跨层读的参数名 | `src/shared/mcp-contract.ts`(backend 声明与解析、renderer 认事件、preview fixture 三处同源;线上 snake_case 与领域 camelCase 是两套拼法,renderer 读错不报错、只在界面上体现为空文案) |
| 领域事件名→载荷 | `ReviewSessionEvents`;ReviewManager 转发表与 renderer `useReviewStream` 三处编译期收敛,加事件要一起动 |
| 快捷键表 | `components/KbdHelp`(设置屏弹同一浮层,别抄摘录) |
| 强度显示名 / 代价文案 | `shared/domain.ts` 的 `INTENSITY_LABELS` / `INTENSITY_HINTS` |
| 改动面计量 | `source-discovery.ts` 的 `diffStat`(绕 `Source.getDiff` 现算,入口卡片与进屏后的改动面由同一次构造得出) |
| diff 基线 | review 的 `base_ref` 列;空 = 跟随该 source 的默认基线,取 target 一律经 `targetOf(review)` |
| 仓库 / issue / 作者外链 | `src/shared/links.ts`(package.json 不重复一份) |
| 客户端版本号 | `package.json` 的 `version` → 构建期 define 注入 `src/shared/version.ts`;发给 app-server / MCP 的 clientInfo 一律取 `APP_VERSION`,别再写字面量 |
| 版本改动说明 | `CHANGELOG.md` / `CHANGELOG.en.md`;GitHub release notes 由 `scripts/release-notes.mjs` 抽出对应小节,别在 release 页手写 |
| 对齐的 codex 版本 / 协议错误判据 | `src/shared/codex.ts`(`CODEX_TARGET_VERSION` / `CODEX_PROTOCOL_ERROR`);`protocol.ts` 表头只指过去,升级 codex 时改这一处 |

## 运行与自查

- **ABI 二选一**:app(`npm start`)先 `npm run rebuild:electron`;spike(tsx/Node)先 `npm run rebuild:node`。切换后对方失效,跑完 spike 记得切回。
- 实机:`npm start`。前提 `codex login`(烧 token);github-pr source 另需 `gh auth login`。
- 前端自查(不需 Electron):`npm run preview:ui` → 开 `/preview.html?screen=entry|review|submit|prompt|settings|history|onboarding`(dev server 已把 `/` 302 过去)。明暗在 rail 底部切,配色在设置屏。
- 出包:本地自查用 `npm run package`(ad-hoc 签名,命令行覆盖);正式包打 `v<version>` tag 交 CI,见 [release](docs/design/release.md)。electron-builder 在签名前翻 fuses,不重签的 app 一启动就被 SIGKILL,所以任何一条路都不能出未签名的包。
- 直接读写本地库走系统 `/usr/bin/sqlite3`,**别为此 rebuild**(会弄坏正开着的 app)。库在 `~/Library/Application Support/Duetlens{,-dev}/duetlens.db`。
- `mockup/` **已冻结**:改 UI 只改 `src/renderer/`,分歧一律以实现为准。看稿用 `python3 -m http.server -d mockup`(不能走 `preview:ui`)。

## 验证这件事本身

- 预览面板有一批环境限制会伪装成代码 bug(平滑滚动 no-op、剪贴板被禁、隐藏 tab 里几何量为 0 且 scroll 事件不派发、过渡冻在半路让 `getComputedStyle` 返回插值、`key` 注入的 `e.key` 是空串、控制台缓冲跨导航不清)。**先截图把面板置前,再操作,再断言**;隐藏态下"没复现"不构成证据。
- 切明暗必须点 rail 底部那颗钮,`setAttribute('data-mode',…)` 会被 `SettingsProvider` 的 effect 静默改回。
- CSS 改了"零效果"先查三件事:别人的无前缀规则同 specificity 按加载顺序压掉了你的、你改的那条规则在 tsx 里零引用、你验证的是同名的另一个控件。
- shell 是 zsh:词首 `=` / `~` / `{}` / `*` 会展开,分隔符一律加引号(`echo '---'`)。批量改源码用 `python3` 读写,别用 `perl -0pi`(会留 NUL,之后 grep 对该文件静默无输出)。
