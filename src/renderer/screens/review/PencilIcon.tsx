/**
 * 批注入口的铅笔图标。不用 ✎(U+270E):那枚字形的墨迹只占 em 盒一小撮,
 * 落在行号格里会缩成一个点,字号再大也救不回来。
 */
export function PencilIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8.5 1.4 L10.6 3.5 L4.4 9.7 L1.7 10.3 L2.3 7.6 Z" />
      <path d="M7.1 2.8 L9.2 4.9" />
    </svg>
  );
}
