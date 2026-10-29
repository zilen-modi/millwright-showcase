import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'relative inline-flex h-[20px] w-[34px] shrink-0 cursor-pointer items-center rounded-full',
        'border border-border-strong bg-surface-3 transition-colors',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block h-[14px] w-[14px] translate-x-[2px] rounded-full bg-surface shadow-card transition-transform data-[state=checked]:translate-x-[17px] data-[state=checked]:bg-on-accent" />
    </SwitchPrimitive.Root>
  );
}
