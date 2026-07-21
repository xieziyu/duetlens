// duet(text) + lens(天蓝) + _(琥珀闪烁);样式在 App.css .wordmark(全局加载)。
export function Wordmark() {
  return (
    <span className="wordmark mono">
      duet<i>lens</i>
      <span className="cur">_</span>
    </span>
  );
}
