import './ScreenPlaceholder.css';

interface Props {
  title: string;
  mockup: string;
  parts: string[];
}

// 骨架期占位:标出该屏对应的 mockup 与将拆出的组件,后续逐个替换为真实实现。
export function ScreenPlaceholder({ title, mockup, parts }: Props) {
  return (
    <section className="placeholder">
      <h1 className="ph-title">{title}</h1>
      <p className="ph-mockup mono">{mockup}</p>
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
