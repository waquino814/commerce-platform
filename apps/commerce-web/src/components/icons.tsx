import type { SVGProps } from 'react';

/** Inline 20×20 stroke icons. Decorative unless given a label by the caller. */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      width="1em"
      height="1em"
      {...props}
    >
      {children}
    </svg>
  );
}

type P = SVGProps<SVGSVGElement>;
export const CheckIcon = (p: P) => (
  <Icon {...p}>
    <path d="m4.5 10.5 3.5 3.5 7.5-8" />
  </Icon>
);
export const XIcon = (p: P) => (
  <Icon {...p}>
    <path d="m5.5 5.5 9 9m0-9-9 9" />
  </Icon>
);
export const ClockIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="7" />
    <path d="M10 6.5V10l2.5 1.5" />
  </Icon>
);
export const AlertIcon = (p: P) => (
  <Icon {...p}>
    <path d="M10 3.5 2.8 16h14.4L10 3.5Z" />
    <path d="M10 8.5v3.2m0 2.3v.01" />
  </Icon>
);
export const PlusIcon = (p: P) => (
  <Icon {...p}>
    <path d="M10 4.5v11M4.5 10h11" />
  </Icon>
);
export const MinusIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4.5 10h11" />
  </Icon>
);
export const TrashIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 6h12M8 6V4.5h4V6m-6.5 0 .7 9.5h7.6l.7-9.5" />
  </Icon>
);
export const ArrowLeftIcon = (p: P) => (
  <Icon {...p}>
    <path d="M15.5 10h-11m4.5-4.5L4.5 10 9 14.5" />
  </Icon>
);
export const ArrowRightIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4.5 10h11M11 5.5l4.5 4.5-4.5 4.5" />
  </Icon>
);
export const RefreshIcon = (p: P) => (
  <Icon {...p}>
    <path d="M15.5 8A6 6 0 0 0 4.7 6.5M4.5 12a6 6 0 0 0 10.8 1.5" />
    <path d="M15.5 3.5V8H11M4.5 16.5V12H9" />
  </Icon>
);
export const BagIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4.5 7h11l-.8 9.5H5.3L4.5 7Z" />
    <path d="M7.5 7V6a2.5 2.5 0 0 1 5 0v1" />
  </Icon>
);
export const ReceiptIcon = (p: P) => (
  <Icon {...p}>
    <path d="M5.5 3h9v14l-2-1.2-2.5 1.2-2.5-1.2-2 1.2V3Z" />
    <path d="M8 7h4m-4 3h4" />
  </Icon>
);
export const CardIcon = (p: P) => (
  <Icon {...p}>
    <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
    <path d="M2.5 8h15M5.5 12.5h3" />
  </Icon>
);

export const CopyIcon = (p: P) => (
  <Icon {...p}>
    <rect x="7" y="7" width="9.5" height="9.5" rx="2" />
    <path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 4 5v6.5A1.5 1.5 0 0 0 5.5 13H7" />
  </Icon>
);
export const SearchIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="9" cy="9" r="5.5" />
    <path d="m13.2 13.2 3.3 3.3" />
  </Icon>
);
export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={`motion-safe:animate-spin ${className}`}
      width="1em"
      height="1em"
    >
      <circle
        cx="10"
        cy="10"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2.5"
      />
      <path
        d="M17 10a7 7 0 0 0-7-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
