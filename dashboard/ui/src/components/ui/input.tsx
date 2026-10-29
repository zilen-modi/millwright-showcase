import type {
  InputHTMLAttributes, LabelHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils';

const field =
  'font-[inherit] bg-page text-fg border border-border-strong rounded-[10px] ' +
  'placeholder:text-muted transition-[border-color,box-shadow] ' +
  'focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)]';

export function Input({ className, type = 'text', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type={type} className={cn(field, 'px-3.5 py-2.5 text-sm', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(field, 'bg-surface px-3 py-2.5 text-[13px] resize-y min-h-[78px] w-full', className)}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  // A native <select> rather than a Radix listbox: it is keyboard- and screen-reader-correct
  // for free, and these are plain single-choice filters with no rich option content.
  return <select className={cn(field, 'px-2.5 py-[7px] text-[12.5px]', className)} {...props} />;
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-[13px] font-semibold text-fg-2', className)} {...props} />;
}
