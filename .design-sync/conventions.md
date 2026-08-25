## Duetlens 的用法约定

Duetlens 是一个 Electron 桌面应用的界面层:人与 codex agent 协同的对话式 code review。
界面语言是简体中文,正文用中文、代码标识符与路径保留英文。

### 主题:两个正交的轴,挂在 `:root` 上

配色不是一套而是两轴的**乘积**,都以属性形式写在 `documentElement` 上:

- `data-mode` = `dark` | `light` —— 明暗,给出外壳的默认档。**缺省是 `dark`**,Duetlens 是 dark-first。
- `data-theme` = `duetlens` | `github` | `parchment` —— 配色主题,成套换掉语法 token / diff / severity;
  `github` 与 `parchment` 还会整套覆写外壳配色(它们的选择器带两个属性,特异性高于单独的 `data-mode`)。

六种组合在 `styles.css` 的 import 闭包里都已定义。**建议显式写死这两个属性**:

```html
<html data-mode="dark" data-theme="duetlens">
```

`AppRail` 与 `ThemeControls` 通过 `useSettings()` 读写这两轴,必须包在 `SettingsProvider` 里
(它同样从 `window.Duetlens` 导出);其余 9 个组件是纯 props 驱动,不需要任何 provider。
不包 provider 时那两个组件会渲染失败,其他组件不受影响。

### 样式惯用法:语义类名 + `var(--token)`,没有 utility class

这套系统**不是** Tailwind、不是 CSS Modules、也不用 props 传样式。每个组件配一份同名 `.css`,
里面是手写的语义类名(`.toast` / `.cap-item` / `.lens-art` / `.kbd-overlay` / `.placeholder`),
颜色一律取自 CSS 变量。你自己写布局时**照这个写法来**:用真实 token,别硬编码色值。

常用 token(全部 73 个的权威定义在 `styles.css` 的 import 闭包里):

| 用途 | token |
| --- | --- |
| 层次底色(由远及近) | `--bg` → `--surface` → `--surface-2` / `--surface-3`;卡片与行一律用 `--card` |
| 边线 | `--border`(看得见的抬起)、`--border-soft`(弱分隔) |
| 文字四档 | `--text` / `--text-dim` / `--text-faint`(仍须过 4.5:1)/ `--text-deco`(**只给装饰**:分隔点、轨道、行号) |
| 双主体配色 | `--agent` / `--agent-2` / `--agent-soft` / `--agent-line`(天蓝 = 机器);`--human` / `--human-soft` / `--human-line`(琥珀 = 人) |
| 实心按钮 | `--accent-solid` + `--on-solid`;hover 用 `--accent-solid-hover`(往**深**走,别用 `filter:brightness` 提亮) |
| diff | `--add` / `--del` / `--add-bg` / `--del-bg` / `--add-gutter` / `--del-gutter` |
| 严重度 | `--sev-high` / `--sev-med` / `--sev-low` |
| 字体与圆角 | `--sans` / `--mono` / `--r`(8px) |

两个易错点:`--text-faint` 是最低的一档**正文**,`--text-deco` 低于正文阈值是有意的 —— 提示文案别用后者。
`--card` 在深色下与 `--surface` 同值、在浅色下更亮,所以组件一律写 `--card`,不要分模式写两套。

排版:正文 `var(--sans)`,结构标签 / 路径 / 分支名等用 `var(--mono)`,类名 `.mono` 就是这个作用。
两者都是**纯系统字体栈**(`system-ui` / `ui-monospace`),不带任何自定义字体 —— 不发字体文件,也别引。

### 真相在哪

- 配色与排版:`styles.css` 及其 `@import` 闭包,是 token 的唯一来源。
- 每个组件的 props 契约在 `<Name>.d.ts`,用法与变体在 `<Name>.prompt.md`。**动手前先读这两份**。

### 一个惯用例子

```jsx
<SettingsProvider>
  <div style={{ background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--sans)', display: 'flex' }}>
    <AppRail active="review" reviewAvailable onNavigate={goto} />
    <main style={{ flex: 1, minWidth: 0 }}>
      <ReviewTabs
        tabs={tabs} activeId={activeId} meta={meta} notice={null}
        onActivate={activate} onClose={close} onNew={newReview}
      />
      <ScreenPlaceholder
        title="提交 / 导出"
        hint="从审核屏进入"
        parts={['先在入口发起或打开一次 review,再进入提交/导出']}
      />
    </main>
  </div>
</SettingsProvider>
```
