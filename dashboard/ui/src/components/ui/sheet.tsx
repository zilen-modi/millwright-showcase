import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Right-hand side drawer, built on Radix Dialog.
 *
 * The legacy panel hand-rolled this with a `hidden` div plus a manual Escape listener and
 * no focus management at all — the single most indefensible a11y gap in a tool that ships
 * accessibility tickets. Radix gives focus trapping, restore-on-close, `aria-modal`,
 * Escape, outside-click and scroll locking for free.
 */

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export function SheetContent({
  className,
  children,
  title,
  description,
  ...props
}: Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> & {
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-30 bg-[rgba(10,12,16,.5)] backdrop-blur-[2px] anim-fade-in" />
      <DialogPrimitive.Content
        className={cn(
          'fixed right-0 top-0 z-40 flex h-full w-[min(600px,95vw)] flex-col',
          'border-l border-border bg-page shadow-drawer anim-slide-in focus:outline-none',
          className,
        )}
        {...props}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <DialogPrimitive.Title asChild>
              <div>{title}</div>
            </DialogPrimitive.Title>
            <DialogPrimitive.Description asChild>
              <div className="text-xs text-muted">{description ?? 'Details panel'}</div>
            </DialogPrimitive.Description>
          </div>
          <DialogPrimitive.Close
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[9px] border border-border bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg"
            aria-label="Close panel"
          >
            <X size={16} aria-hidden />
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-16 pt-4">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
