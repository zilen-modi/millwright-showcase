import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('flex flex-wrap gap-[3px] border-b border-border', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'cursor-pointer border-0 border-b-2 border-transparent bg-transparent px-3 py-[7px]',
        '-mb-px text-xs font-semibold text-fg-2 hover:text-fg',
        'data-[state=active]:border-b-accent data-[state=active]:text-fg',
        'disabled:opacity-55 disabled:cursor-not-allowed disabled:text-muted',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('pt-3 focus:outline-none', className)} {...props} />;
}

/** Pill-style segmented control (the legacy `.seg`) — same Radix semantics, different skin. */
export function SegmentedList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('inline-flex gap-0.5 rounded-[10px] bg-surface-2 p-[3px]', className)}
      {...props}
    />
  );
}

export function SegmentedTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'cursor-pointer rounded-[7px] border-0 bg-transparent px-3.5 py-[7px] text-[13px] font-semibold',
        'text-fg-2 transition-[background-color,color] hover:text-fg',
        'data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-card',
        className,
      )}
      {...props}
    />
  );
}
