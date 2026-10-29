import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog';

export interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}

/** Replaces `window.confirm` — same one-question shape, but focus-trapped, Escape-closable
 *  and labelled, which the native dialog is not once the page is a single-page app. */
export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {request ? (
        <DialogContent title={request.title} description={request.body}>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary" size="md">Cancel</Button>
            </DialogClose>
            <Button
              variant={request.destructive ? 'danger' : 'primary'}
              size="md"
              autoFocus
              onClick={() => { request.onConfirm(); onClose(); }}
            >
              {request.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
