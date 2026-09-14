export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 40 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M14.5 3.5a12.5 12.5 0 1 0 0 25 12.5 12.5 0 0 0 0-25Zm0 5.25a7.25 7.25 0 1 1 0 14.5 7.25 7.25 0 0 1 0-14.5Z"
        fill="currentColor"
        fillRule="evenodd"
      />
      <path d="M26.5 5.25h13L33 16.5l-6.5-11.25Z" fill="var(--accent)" />
    </svg>
  );
}
