# mockup/ —— 已冻结的设计存档

**这些 HTML 稿不再维护。改 UI 请改 `src/renderer/`;稿与实现不一致时,以实现为准。**

`mockup/` 是设计语言尚未收敛时用来对齐视觉的静态稿。七屏全部落地后它已完成使命 —— 继续同步只会变成「先实现、再回头补稿」,补出来的稿也没人看。

## 规则

- **不要为了让稿跟上实现而改稿。** 需要看当前设计,去看 `src/renderer/` 或跑 `npm run preview:ui`。
- **`tokens.css` 不是配色单一来源。** 真正的来源是 `src/renderer/theme/tokens.css`,这里是一份历史副本(冻结时二者逐字节相同,此后只会渐行渐远)。改配色改前者。
- **源码里已不留任何指向这里的注释**(原先各屏头部的 `→ mockup/xxx.html` 已清理干净) —— 那种指针读起来像"当前设计在那边",正是要断掉的回头路。想知道某屏当初照着哪份稿做的,查 `git log`。

## 仍有价值的部分

- `review-runtime.html` —— 运行时 / 异常态(turn 中断、反向审批、turn 失败、连接断、上下文压缩)**尚未落地**,这份稿是该功能目前唯一的设计参照。
- 其余各稿可作设计意图的历史记录翻阅:为什么这么排、当初权衡掉了什么。

## 打开方式

用静态服务,**不能走 `npm run preview:ui`** —— vite 会把 mockup 当入口做 HTML transform,稿里代码示例中的 `Result<()>` 之类会被当成标签解析而报错。

```bash
python3 -m http.server -d mockup 8000
```

设计决策见 [docs/design/ui.md](../docs/design/ui.md);各稿画的是哪一屏,看文件名即知。
