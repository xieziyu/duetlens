# 尚未收口的风险与空缺

> 返回 [文档索引](../README.md)
>
> 只留**仍未解决**的。已经拍板的写进了对应分册,不在这里堆已完成项。

- **发布链路尚未真跑过一次**:签名 / 公证 / CI / updater 的形态已定并落地(见 [release](release.md)),但证书与 secrets 还没配、仓库还没转 public,所以整条链一次都没端到端跑通过。第一次发版要按 release.md 的准备清单走一遍,并预期在公证那步撞到没预料的拒绝理由。
- **MCP 通道的生命周期未严格对齐 review 生命周期**:HTTP transport + 每会话独立 Server + bearer 令牌已就位,仍待做的是令牌隔离与 dispose 的严格对齐。
- **app-server API 仍标 experimental**,可能无预告 breaking change。缓解手段是 `ConversationalAgent` 薄封装 + schema 导出做升级回归。
- **运行时 / 异常态大部分未落地**(turn 中断、反向审批卡、追问 turn 失败、连接断、压缩),见 [ui](ui.md#尚未落地的运行时--异常态)。
- **键位表不可配置**,帮助层是只读 cheatsheet。
- **两处对比度尚未收口**(只在交互态渲染,fixture 复现不出来,别当已完成):浅色下 human 琥珀配白字的 hover 态本就只剩 4.92,深浅两模式前景方向相反,一个静态 hover 修不了两边;`-soft` 底的动作按钮组未实测。
- **onboarding 的明暗档没做「跟随系统」**(需 SettingsProvider 支持 system 解析)。
