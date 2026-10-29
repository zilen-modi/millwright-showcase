import { MessageCircle, Play } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { useResource } from '@/hooks/useResource';
import { useRuns } from '@/hooks/runs';
import { postJson } from '@/lib/api';
import { Markdown } from '@/lib/markdown';
import type { RunMode, TicketCard } from '@/lib/types';
import { ticketCommands } from '../commands';
import { ago } from '../rows';

interface Suggestion { action: RunMode; label: string | null; notes: string | null; why: string | null }
interface Message {
  id: string;
  question: { text: string; at: string };
  answer: { text: string; citations: string[]; suggestions: Suggestion[]; at: string | null } | null;
  pending: boolean;
  running: boolean;
  failed: string | null;
}

const ACTION_LABEL: Record<string, string> = { replan: 'Re-plan', continue: 'Continue', build: 'Approve and build', plan: 'Plan', review: 'Review' };

export function useChat(key: string) {
  const fetcher = useCallback(async (signal: AbortSignal) => {
    const r = await fetch(`/api/chat?key=${encodeURIComponent(key)}`, { signal });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json() as Promise<{ messages: Message[] }>;
  }, [key]);
  return useResource(fetcher, [key]);
}

export async function askTicket(key: string, text: string) {
  try {
    await postJson('/api/chat', { key, text });
    return true;
  } catch (e) {
    toast.error('Could not ask that', { description: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * Questions and answers about one ticket. Answers are read-only; a suggested action is a button
 * that runs only when clicked, through the same run path (and gates) as every other button.
 */
export function Chat({ card }: { card: TicketCard }) {
  const { data, error } = useChat(card.key);
  const { run } = useRuns();
  const end = useRef<HTMLDivElement>(null);
  const messages = data?.messages || [];
  const available = new Map(ticketCommands(card).map((c) => [c.name, c]));
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages.length, messages[messages.length - 1]?.answer]);

  if (error) return <p className="text-[13px] text-critical">Could not load the chat: {error}</p>;
  if (!data) return <p className="flex items-center gap-2 text-[13px] text-muted"><Spinner label="Loading" /> Loading…</p>;
  if (!messages.length) {
    return (
      <div className="px-2 py-8 text-center">
        <MessageCircle size={22} aria-hidden className="mx-auto text-muted" />
        <p className="m-0 mt-2 text-[14px] font-semibold text-fg">Ask anything about {card.key}</p>
        <p className="m-0 mt-1 text-[12.5px] text-muted">"Why did verify fail?" · "Which files does the plan touch?" · "What does the old ERP do here?"</p>
        <p className="m-0 mt-1 text-[12px] text-muted">Answers read the ticket, its code and the old ERP. They never change anything; a suggested next step waits for your click.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 pb-2">
      {messages.map((m) => (
        <div key={m.id} className="grid gap-2">
          <div className="ml-auto max-w-[85%] rounded-[12px] rounded-br-[4px] bg-accent-soft px-3 py-2 text-[13px] text-fg whitespace-pre-wrap">
            {m.question.text}
            <span className="mt-0.5 block text-right text-[10.5px] text-muted">{ago(m.question.at)}</span>
          </div>
          <div className="max-w-[95%] rounded-[12px] rounded-bl-[4px] border border-border bg-surface px-3 py-2">
            {m.answer ? (
              <>
                <div className="text-[13px]"><Markdown source={m.answer.text} /></div>
                {m.answer.citations.length ? (
                  <p className="m-0 mt-1.5 flex flex-wrap gap-1">
                    {m.answer.citations.map((c) => <code key={c} className="rounded-[5px] border border-border bg-surface-2 px-1.5 font-mono text-[11px] text-fg-2">{c}</code>)}
                  </p>
                ) : null}
                {m.answer.suggestions.length ? (
                  <div className="mt-2.5 grid gap-1.5 border-t border-border pt-2">
                    {m.answer.suggestions.map((s, i) => {
                      const cmd = available.get(s.action);
                      const why = !cmd ? `${ACTION_LABEL[s.action] || s.action} is not available on this ticket right now.` : cmd.disabledReason;
                      return (
                        <div key={i} className="flex flex-wrap items-start gap-2">
                          <Tooltip label={why || (s.notes ? `Sends these notes: ${s.notes}` : 'Runs it now')}>
                            <span>
                              <Button size="sm" variant={s.action === 'build' ? 'approve' : 'secondary'} disabled={!!why}
                                onClick={() => void run(card.key, s.action, s.notes ? { notes: s.notes } : undefined)}>
                                <Play size={11} aria-hidden />{s.label || ACTION_LABEL[s.action] || s.action}
                              </Button>
                            </span>
                          </Tooltip>
                          {s.why ? <span className="min-w-0 flex-1 text-[12px] text-muted">{s.why}</span> : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </>
            ) : m.failed ? (
              <p className="m-0 text-[12.5px] text-critical">No answer: {m.failed}</p>
            ) : (
              <p className="m-0 flex items-center gap-2 text-[12.5px] text-muted"><Spinner className="h-3 w-3 border" />{m.running ? 'Reading the ticket, its code and the old ERP…' : 'Waiting to start…'}</p>
            )}
          </div>
        </div>
      ))}
      <div ref={end} />
      {messages.some((m) => m.answer) ? <Badge className="mx-auto">Answers are read-only. Actions run only when you click them.</Badge> : null}
    </div>
  );
}
