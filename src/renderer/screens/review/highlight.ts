/**
 * 语法高亮:highlight.js core + 精选常用语言(控包体),按文件扩展名选语言。
 * 逐行高亮(diff 行粒度),跨行结构(多行字符串/注释)不保留——diff 视图可接受。
 * hljs 的 token class 经 review-syntax.css 映射到主题的 --k/--fn/--s/... 变量。
 */
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'xml',
  xml: 'xml',
  vue: 'xml',
  svg: 'xml',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cxx: 'cpp',
};

/** 由文件路径猜 hljs 语言;未知返回 null(不高亮)。 */
export function langOf(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_LANG[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** 把一行代码高亮成 HTML(hljs 已转义)。lang 为 null 或出错时返回纯转义文本。 */
export function highlightLine(text: string, lang: string | null): string {
  if (lang == null) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
