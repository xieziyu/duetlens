import './ScreenPlaceholder.css';

interface Props {
  title: string;
  /** 一句话说明该屏怎么进来 / 为何现在是空的 */
  hint: string;
  parts: string[];
}

// 空态占位:标题 + 一句提示 + 下一步该做什么。
export function ScreenPlaceholder({ title, hint, parts }: Props) {
  return (
    <section className="placeholder">
      <h1 className="ph-title">{title}</h1>
      <p className="ph-hint mono">{hint}</p>
      <ul className="ph-parts">
        {parts.map((p) => (
          <li key={p} className="mono">
            {p}
          </li>
        ))}
      </ul>
    </section>
  );
}
