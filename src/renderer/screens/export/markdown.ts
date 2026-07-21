/**
 * 轻量 Markdown → HTML 渲染,仅覆盖导出报告用到的子集
 * (h1-h4 / blockquote / 无序列表 / ```代码块(含 ```suggestion)/ **粗** `代码` ~~删除线~~)。
 * 输入是本地生成的报告文本;所有文本经 escapeHtml 转义后才拼接,用于 dangerouslySetInnerHTML。
 */
const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

const inline = (s: string) =>
  escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>');

export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };

  while (i < lines.length) {
    const ln = lines[i];
    if (ln.startsWith('```')) {
      const lang = ln.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾的 ```
      closeList();
      const isSugg = lang === 'suggestion';
      out.push(
        '<div class="pre-wrap' +
          (isSugg ? ' sugg' : '') +
          '">' +
          (isSugg ? '<div class="pre-lbl">suggestion · author 可一键采纳</div>' : '') +
          '<pre>' +
          escapeHtml(buf.join('\n')) +
          '</pre></div>',
      );
      continue;
    }
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const n = h[1].length;
      out.push(`<h${n}>` + inline(h[2]) + `</h${n}>`);
      i++;
      continue;
    }
    if (/^>\s?/.test(ln)) {
      closeList();
      out.push('<blockquote>' + inline(ln.replace(/^>\s?/, '')) + '</blockquote>');
      i++;
      continue;
    }
    if (/^-\s/.test(ln)) {
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push('<li>' + inline(ln.replace(/^-\s/, '')) + '</li>');
      i++;
      continue;
    }
    if (ln.trim() === '') {
      closeList();
      i++;
      continue;
    }
    closeList();
    out.push('<p>' + inline(ln) + '</p>');
    i++;
  }
  closeList();
  return out.join('\n');
}
