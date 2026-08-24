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

/**
 * 流式期把**末行**未闭合的行内标记先藏起来。半个 `` ` `` 或 `**` 会先以字面出现、
 * 下一帧再变成代码/粗体 —— 一行字要抖两次,读起来像在闪。
 *
 * 只动最后一行,且**围栏代码块内不动**:那里的反引号本来就是内容,数奇偶只会误伤。
 */
export function trimDanglingMarks(src: string): string {
  const lines = src.split('\n');
  // 围栏行数为奇数 = 正开着一个代码块,此时末行属于代码内容
  const fences = lines.filter((l) => /^\s*```/.test(l)).length;
  if (fences % 2 === 1) return src;
  const last = lines[lines.length - 1];
  if (last === undefined || /^\s*```/.test(last)) return src;
  let cut = last;
  const ticks = (cut.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) cut = cut.slice(0, cut.lastIndexOf('`'));
  const bolds = (cut.match(/\*\*/g) ?? []).length;
  if (bolds % 2 === 1) cut = cut.slice(0, cut.lastIndexOf('**'));
  if (cut === last) return src;
  lines[lines.length - 1] = cut;
  return lines.join('\n');
}

function renderInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((seg, i) => {
    if (seg.startsWith('**') && seg.endsWith('**')) return <strong key={i}>{seg.slice(2, -2)}</strong>;
    if (seg.startsWith('`') && seg.endsWith('`')) return <code key={i}>{seg.slice(1, -1)}</code>;
    return seg;
  });
}
