import { describeLaunchError } from './round-error';

/**
 * 「这一轮没能开跑」的统一呈现:重跑面板与进度条失败卡共用一份 ——
 * 两处各写各的必然漂移,而这类错误的原文又长又是给机器看的,糊进段落谁也读不下去。
 */
export function LaunchError({
  message,
  fallbackTitle,
}: {
  message: string;
  /** 认不出特征时的兜底结论;缺省即「这一轮没能开跑」 */
  fallbackTitle?: string;
}): React.JSX.Element {
  const { title, advice, raw } = describeLaunchError(message, fallbackTitle);
  return (
    <div className="launch-err">
      <div className="le-head">
        <span className="ic">✕</span>
        <b>{title}</b>
      </div>
      {advice && <p className="le-advice">{advice}</p>}
      <details className="le-raw">
        <summary>失败原文</summary>
        <pre>{raw}</pre>
      </details>
    </div>
  );
}
