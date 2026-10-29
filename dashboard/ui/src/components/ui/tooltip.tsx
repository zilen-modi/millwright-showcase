import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export const TooltipProvider = TooltipPrimitive.Provider;

/** Hint text that is reachable by keyboard, unlike the `title=""` attributes it replaces. */
export function Tooltip({ label, children }: { label: ReactNode; children: ReactNode }) {
  if (!label) return <>{children}</>;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          collisionPadding={12}
          className="z-50 max-w-[300px] rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs leading-snug text-fg-2 shadow-pop"
        >
          {label}
          <TooltipPrimitive.Arrow className="fill-[var(--surface)]" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
