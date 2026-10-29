import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[2px] text-[11px] font-semibold whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-surface-2 text-fg-2',
        phase:
          'capitalize border-[color-mix(in_srgb,var(--ph,var(--muted))_40%,var(--border))] ' +
          'bg-[color-mix(in_srgb,var(--ph,var(--muted))_12%,var(--surface))] ' +
          'text-[color-mix(in_srgb,var(--ph,var(--muted))_72%,var(--text))]',
        good: 'border-[color-mix(in_srgb,var(--good)_35%,var(--border))] bg-surface-2 text-good',
        warning:
          'border-[color-mix(in_srgb,var(--warning)_45%,var(--border))] ' +
          'bg-[color-mix(in_srgb,var(--warning)_16%,var(--surface))] ' +
          'text-[color-mix(in_srgb,var(--warning)_82%,var(--text))]',
        critical:
          'border-[color-mix(in_srgb,var(--critical)_45%,var(--border))] ' +
          'bg-[color-mix(in_srgb,var(--critical)_12%,var(--surface))] text-critical',
        accent: 'border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] bg-accent-soft text-accent',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
