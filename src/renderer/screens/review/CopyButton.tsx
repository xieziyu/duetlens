import { useEffect, useState } from 'react';

/**
 * 复制 agent 回答原文(markdown 源码,非渲染后的富文本)—— 贴回编辑器 / PR 评论要的是源码。
 * 成功后短暂回显。
 *
 * 中断的残文尤其需要它:那半句**哪儿都没落库**,离了屏就再也拿不回来。
 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className={`msg-copy${copied ? ' on' : ''}`}
      title="复制这条回答"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          /* 剪贴板不可用时静默 */
        }
      }}
    >
      {copied ? '✓ 已复制' : '⧉ 复制'}
    </button>
  );
}
