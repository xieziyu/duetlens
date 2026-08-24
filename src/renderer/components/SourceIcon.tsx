import type { Review } from '@shared/domain';

/** 源标识图标:与入口页 srcbadge 同一视觉词汇;review 顶栏与 tab 条共用一份。 */
export function SourceIcon({ source }: { source?: Review['source'] }): React.JSX.Element {
  if (source === 'github-pr') {
    return (
      <svg className="si" width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.81.06 1.23.83 1.23.83.72 1.23 1.89.87 2.35.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
      </svg>
    );
  }
  return (
    <svg className="si" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <circle cx="6.5" cy="18.5" r="2.5" />
      <circle cx="17.5" cy="12" r="2.5" />
      <path d="M6.5 8v8M9 5.5h4a2.5 2.5 0 0 1 2.5 2.5v1.5" />
    </svg>
  );
}
