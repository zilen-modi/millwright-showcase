import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// Variants map 1:1 onto the legacy panel.css button classes (`.primary`, `.run`,
// `.run.ship`, `.run.cancel`, `.run.approve`, `.run.archive`) so the board keeps reading
// the same way — intent by colour — with real focus states added.
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-semibold ' +
    'transition-[background-color,color,border-color,filter] disabled:opacity-45 ' +
    'disabled:cursor-not-allowed disabled:pointer-events-none cursor-pointer select-none',
  {
    variants: {
      variant: {
        primary:
          'text-on-accent border border-accent shadow-card bg-accent hover:bg-accent-2 hover:border-accent-2 active:translate-y-px',
        secondary:
          'border border-border bg-surface-2 text-fg-2 hover:bg-accent-soft hover:text-fg ' +
          'hover:border-[color-mix(in_srgb,var(--accent)_40%,var(--border))]',
        ghost: 'border border-transparent bg-transparent text-fg-2 hover:bg-surface-2 hover:text-fg',
        outline: 'border border-border bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg',
        approve:
          'border border-[color-mix(in_srgb,var(--good)_45%,var(--border))] ' +
          'bg-[color-mix(in_srgb,var(--good)_18%,var(--surface))] ' +
          'text-[color-mix(in_srgb,var(--good)_60%,var(--text))] ' +
          'hover:bg-[color-mix(in_srgb,var(--good)_28%,var(--surface))]',
        ship:
          'border border-border bg-surface-2 text-fg-2 ' +
          'hover:bg-[color-mix(in_srgb,var(--serious)_20%,var(--surface))] ' +
          'hover:border-[color-mix(in_srgb,var(--serious)_45%,var(--border))] hover:text-fg',
        danger:
          'border border-border bg-surface-2 text-critical hover:bg-[color-mix(in_srgb,var(--critical)_14%,var(--surface))] ' +
          'hover:border-[color-mix(in_srgb,var(--critical)_45%,var(--border))]',
        muted: 'border border-border bg-surface-2 text-muted hover:text-fg-2 hover:bg-surface-3',
      },
      size: {
        sm: 'text-xs px-2.5 py-[5px] rounded-lg',
        md: 'text-[13px] px-4 py-2 rounded-[9px]',
        lg: 'text-sm px-5 py-2.5 rounded-[10px]',
        icon: 'h-[34px] w-[34px] rounded-[9px] p-0',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'sm' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      {...(asChild ? {} : { type: type ?? 'button' })}
      {...props}
    />
  );
}
