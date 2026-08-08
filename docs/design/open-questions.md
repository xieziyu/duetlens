# 尚未收口的风险与空缺

> 返回 [文档索引](../README.md)
>
> 只留**仍未解决**的。已经拍板的写进了对应分册,不在这里堆已完成项。

- **`release` environment 里的签名 secret 没被任何一次运行覆盖过**,而 `workflow_dispatch` 不留、`v*` tag 又不可动 —— 没有便宜的 dry-run,第一次验证就是一次真发布。故首发走预发布 tag(落 beta 渠道,不生成 `latest-mac.yml`,不推给任何人),验通了再发正式版;渠道不同,那台验证机不会自动升上去,重装一次。见 [release](release.md)。
- **app-server API 仍标 experimental**,可能无预告 breaking change。缓解手段是 `ConversationalAgent` 薄封装 + schema 导出做升级回归。
- **四个运行时 / 异常态仍只有设计**(追问 turn 的中断、反向审批卡、连接断、上下文压缩),见 [ui](ui.md#尚未落地的运行时--异常态)。
- **键位表不可配置**,帮助层是只读 cheatsheet。
- **两处对比度尚未收口**(只在交互态渲染,fixture 复现不出来,别当已完成):浅色下 human 琥珀配白字的 hover 态本就只剩 4.92,深浅两模式前景方向相反,一个静态 hover 修不了两边;`-soft` 底的动作按钮组未实测。
