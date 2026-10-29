import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
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
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgba(10,12,16,.5)] backdrop-blur-[2px] anim-fade-in" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2',
          'rounded-panel border border-border bg-surface p-5 shadow-drawer anim-fade-in focus:outline-none',
          className,
        )}
        {...props}
      >
        <DialogPrimitive.Title className="m-0 text-[15px] font-bold tracking-[-.01em] text-fg">
          {title}
        </DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description asChild>
            <div className="mt-2 text-[13px] leading-relaxed text-fg-2">{description}</div>
          </DialogPrimitive.Description>
        ) : (
          <DialogPrimitive.Description className="sr-only">Confirmation dialog</DialogPrimitive.Description>
        )}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex flex-wrap justify-end gap-2">{children}</div>;
}
