# 发布链路

> 返回 [文档索引](../README.md)
>
> 决策与理由在这里;命令与配置以 `electron-builder.yml`、`.github/workflows/release.yml` 为准。

## 形态

打 `v<version>` tag → GitHub Actions 在 macOS runner 上出包、用 Developer ID 签名、送 Apple 公证、
传成 GitHub Releases **草稿**。人过一眼再点 publish,那一刻起旧版本才开始收到更新推送。

草稿这一环不是多余的:`electron-updater` 不读 draft release,所以「包已经出好了」与「用户开始升级」
之间留了一个可反悔的位置。出了问题删掉草稿即可,不用发一个撤回版本。

## 拍板过的几件事

**分发走公开仓库的 GitHub Releases。** 私有仓库的 release 资产要 token 才读得到,而 updater 跑在
每个用户机器上 —— 那等于把一个能读私有仓库的凭据发出去。公开仓库是唯一不用自建服务器又能自动更新的路。

**只出 arm64。** 受众是 macOS 上用 codex 的开发者,Intel Mac 已停产多年;双架构要为每个架构分别
编 better-sqlite3,收益不抵成本。真有需求再加 runner。

**dmg + zip 两个产物。** dmg 给人下载,zip 给 updater —— 少一个更新链就断了。

**公证凭据用 App Store Connect API key**,不用 Apple ID + 专用密码:可单独撤销、不牵连账号密码、
CI 里只是三个字符串加一个文件。

**版本号只写在 `package.json`。** 构建期 define 注入,发给 app-server / MCP 的 clientInfo 一律取
`APP_VERSION`(见 [CLAUDE.md](../../CLAUDE.md) 单一来源表)。CI 会校验 tag 与它一致后才发布,
免得出现「v0.2.0 的 release 里装着 0.1.0 的包」。

## release notes 从 CHANGELOG 抽,不在网页上手写

`scripts/release-notes.mjs <version>` 取两份 CHANGELOG 里对应那一节拼成草稿正文(中文在前),
CI 建草稿时用它。**抽不到就让这一步失败** —— 版本号已经过了 tag 校验,却没人写过这版改了什么,
那不是可以顺手补的疏漏。中英各要有一节,少一边同样失败:双语 README 只在发布这一处会被忘掉。

手写 notes 的代价不是麻烦,是它会与 CHANGELOG 分叉,而分叉之后没有任何一处能判定谁是对的。

## 签名的两条路不能混

发布版从钥匙串自动发现 Developer ID Application,开 hardened runtime + 公证。
本地 `npm run package` 在命令行覆盖成 ad-hoc(`identity: "-"`)、关公证、换一份 entitlements。

两份 entitlements 只差 `disable-library-validation` 一条:ad-hoc 签名下 app 与 Electron 预编译框架的
Team ID 对不上,不关掉库校验起不来;Developer ID 下所有二进制由同一 Team ID 重签,校验能过,
所以发布版不带这条。

**任何情况下都不能出未签名的包** —— electron-builder 在签名前翻 fuses,翻过之后原签名失效,
不重签的 app 一启动就被 SIGKILL。`forceCodeSigning: true` 让这种情况直接构建失败,而不是出一个
跑不起来的包。

## 每个脚本都显式写 `--publish`

`dist` 是 never,`release` 是 always。不写的话 electron-builder 会因为检测到 CI 环境自己进发布模式,
在 dry run 里白传一轮才因为「不是 tag」放弃;v27 起这个隐式行为会被移除,届时不写就等于 never。
两边都写清楚,行为不随版本漂。

## dmg 自身没有公证票据

`notarize` 公证并 staple 的是 `.app`,之后才把它装进 dmg 和 zip —— dmg 本身既没签名也没票据
(`spctl -a -t open` 会报 `no usable signature`)。实测带 quarantine 的 dmg 仍能正常挂载,盘里的 app
判定为 `Notarized Developer ID`,拷出来也能启动,所以这条分发路径可用。

但这低于 Apple「用磁盘映像分发就把映像也公证掉」的建议。要补的话得把 CI 拆成两阶段(先
`--publish never`,再 codesign + notarytool + stapler 处理 dmg,最后才上传),还要处理 staple 之后
dmg 的 sha512 与 `latest-mac.yml` 里那条对不上。**没做,不是忘了。**

## 一次性准备(换机器或换证书时重来)

1. **Developer ID Application 证书**:Xcode → Settings → Accounts → Manage Certificates → `+`。
   注意不是 "Apple Development" 也不是 "Mac App Distribution",那两个签出来的包在别人机器上照样起不来。
2. **导出 `.p12`** 给 CI:钥匙串里右键证书导出,设个密码。`base64 -i cert.p12 | pbcopy` 后存进
   仓库 secrets 的 `CSC_LINK`,密码存 `CSC_KEY_PASSWORD`。
3. **App Store Connect API key**:App Store Connect → Users and Access → Integrations →
   生成 **Developer** 角色的 key。`.p8` 只能下载一次。三个 secret:`APPLE_API_KEY_P8`(文件全文)、
   `APPLE_API_KEY_ID`、`APPLE_API_ISSUER`。
4. **`APPLE_TEAM_ID`**:developer.apple.com 的 Membership details 里那 10 位。

唯一的触发方式是推 `v*` tag。**刻意不留 `workflow_dispatch`** —— 那等于允许从任意分支带着签名证书
和 Apple 密钥跑一次。要临时验链路就临时加回来,验完删掉。

`v*` tag 不可删也不可移(仓库 ruleset,连 owner 都不能 bypass),CI 挂了就等于烧掉一个收不回来的
tag —— 推之前先在本地跑一遍 typecheck / lint 与 `npm run package`。

tag 推上去之后 job 不会立刻开始:它挂在 `release` environment 上,要在 Actions 页面点一次批准。
这一步是为了让「拿走密钥」必须经过一次人为确认,而不是任何跑在这个 job 里的代码都能静默做到。
