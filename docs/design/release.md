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

## 签名的两条路不能混

发布版从钥匙串自动发现 Developer ID Application,开 hardened runtime + 公证。
本地 `npm run package` 在命令行覆盖成 ad-hoc(`identity: "-"`)、关公证、换一份 entitlements。

两份 entitlements 只差 `disable-library-validation` 一条:ad-hoc 签名下 app 与 Electron 预编译框架的
Team ID 对不上,不关掉库校验起不来;Developer ID 下所有二进制由同一 Team ID 重签,校验能过,
所以发布版不带这条。

**任何情况下都不能出未签名的包** —— electron-builder 在签名前翻 fuses,翻过之后原签名失效,
不重签的 app 一启动就被 SIGKILL。`forceCodeSigning: true` 让这种情况直接构建失败,而不是出一个
跑不起来的包。

## 一次性准备(换机器或换证书时重来)

1. **Developer ID Application 证书**:Xcode → Settings → Accounts → Manage Certificates → `+`。
   注意不是 "Apple Development" 也不是 "Mac App Distribution",那两个签出来的包在别人机器上照样起不来。
2. **导出 `.p12`** 给 CI:钥匙串里右键证书导出,设个密码。`base64 -i cert.p12 | pbcopy` 后存进
   仓库 secrets 的 `CSC_LINK`,密码存 `CSC_KEY_PASSWORD`。
3. **App Store Connect API key**:App Store Connect → Users and Access → Integrations →
   生成 **Developer** 角色的 key。`.p8` 只能下载一次。三个 secret:`APPLE_API_KEY_P8`(文件全文)、
   `APPLE_API_KEY_ID`、`APPLE_API_ISSUER`。
4. **`APPLE_TEAM_ID`**:developer.apple.com 的 Membership details 里那 10 位。

配完可以先 `workflow_dispatch` 手动跑一次 —— 非 tag 触发只出包不发布,正好验签名和公证这段通不通。

## 首次公开前必须先做

仓库转 public 之前扫一遍 git 历史里有没有 token / `.env` / 私密路径。转公开的那一刻全部历史都可见,
删了也已经被爬走。
