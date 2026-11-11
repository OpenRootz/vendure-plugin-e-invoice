import { ReactNode, SVGProps } from 'react';

// Icons from Lucide (https://lucide.dev, ISC license), inlined: the dashboard bundle does not re-export lucide-react,
// and importing it would make it a dependency of the plugin. Emoji are not an option: they depend on the system
// fonts (empty boxes on Linux without an emoji font) and ignore the theme colors.

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

function icon(children: ReactNode) {
  return function Icon({ className = 'h-3 w-3', ...props }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={`inline-block shrink-0 ${className}`}
        {...props}
      >
        {children}
      </svg>
    );
  };
}

export const LinkIcon = icon(
  <>
    <path d="M9 17H7A5 5 0 0 1 7 7h2" />
    <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
    <line x1="8" x2="16" y1="12" y2="12" />
  </>,
);

export const LockIcon = icon(
  <>
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </>,
);

export const LockOpenIcon = icon(
  <>
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 9.9-1" />
  </>,
);
