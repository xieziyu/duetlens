import type { ReactNode } from 'react';

/**
 * 轻量 Markdown → React 节点:段落 / 无序列表 / 围栏代码块 / 行内 **粗** `代码`。
 * finding.body 与 review 总结共用;走 React 节点而非 dangerouslySetInnerHTML,
 * 文本天然转义,无需手工 escape。
 */
export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const ln = lines[i];

    const fence = ln.match(/^```(\w*)\s*$/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // 收尾围栏
      out.push(
        <pre key={key++} className="md-code" data-lang={fence[1] || undefined}>
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(ln)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      }
      out.push(
        <ul key={key++} className="md-ul">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (ln.trim() === '') {
      i++;
      continue;
    }

    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    out.push(<p key={key++}>{renderInline(buf.join(' '))}</p>);
  }

  return out;
}

function renderInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((seg, i) => {
    if (seg.startsWith('**') && seg.endsWith('**')) return <strong key={i}>{seg.slice(2, -2)}</strong>;
    if (seg.startsWith('`') && seg.endsWith('`')) return <code key={i}>{seg.slice(1, -1)}</code>;
    return seg;
  });
}
