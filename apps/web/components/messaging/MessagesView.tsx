'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface InboxThread {
  thread_id: string;
  last_message_id: string;
  subject: string | null;
  body: string;
  sent_at: string;
  is_read: boolean;
  sender_id: string;
  other_user_id: string;
  other_first_name: string;
  other_last_name: string;
  other_role: string;
  unread_count: number;
}

interface ThreadMessage {
  id: string;
  thread_id: string;
  subject: string | null;
  body: string;
  sent_at: string;
  is_read: boolean;
  sender_id: string;
  recipient_id: string;
  sender_first_name: string;
  sender_last_name: string;
  sender_role: string;
}

interface Contact {
  id: string;
  first_name: string;
  last_name: string;
  role: string;
  email: string;
}

type ToastFn = (message: string, type?: 'success' | 'error') => void;

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show: ToastFn = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function roleLabel(role: string): string {
  return role.replace('_', ' ');
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MessagesView() {
  return (
    <Suspense fallback={<div className="max-w-2xl mx-auto p-4"><p className="text-sm text-gray-500">Loading messages…</p></div>}>
      <MessagesViewInner />
    </Suspense>
  );
}

function MessagesViewInner() {
  const { schoolId, user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast, show } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [inbox, setInbox] = useState<InboxThread[]>([]);

  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

  const [composing, setComposing] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [newRecipient, setNewRecipient] = useState('');
  const [newSubject, setNewSubject] = useState('');
  const [newBody, setNewBody] = useState('');

  const loadInbox = useCallback(() => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    apiFetch<{ success: boolean; data: InboxThread[] }>(`/api/schools/${schoolId}/messages/inbox`)
      .then(({ data }) => setInbox(data))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load messages'))
      .finally(() => setLoading(false));
  }, [schoolId]);

  useEffect(() => { loadInbox(); }, [loadInbox]);

  const openThread = useCallback((threadId: string) => {
    if (!schoolId) return;
    setActiveThreadId(threadId);
    setThreadLoading(true);
    apiFetch<{ success: boolean; data: ThreadMessage[] }>(`/api/schools/${schoolId}/messages/thread/${threadId}`)
      .then(({ data }) => {
        setThreadMessages(data);
        setInbox(prev => prev.map(t => (t.thread_id === threadId ? { ...t, unread_count: 0 } : t)));
      })
      .catch((err: unknown) => show(err instanceof Error ? err.message : 'Failed to load conversation', 'error'))
      .finally(() => setThreadLoading(false));
  }, [schoolId, show]);

  // Auto-open a thread when arriving from a notification (?thread=...)
  useEffect(() => {
    const threadParam = searchParams?.get('thread');
    if (threadParam && schoolId) {
      openThread(threadParam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, schoolId]);

  function loadContacts() {
    if (!schoolId) return;
    setContactsLoading(true);
    apiFetch<{ success: boolean; data: Contact[] }>(`/api/schools/${schoolId}/messages/contacts`)
      .then(({ data }) => setContacts(data))
      .catch(() => setContacts([]))
      .finally(() => setContactsLoading(false));
  }

  function startCompose() {
    setComposing(true);
    setActiveThreadId(null);
    setNewRecipient('');
    setNewSubject('');
    setNewBody('');
    loadContacts();
  }

  async function handleSendNew(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId || !newRecipient || !newBody.trim()) return;
    setSending(true);
    try {
      const { data } = await apiFetch<{ success: boolean; data: { thread_id: string } }>(`/api/schools/${schoolId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ recipient_id: newRecipient, subject: newSubject.trim() || undefined, body: newBody.trim() }),
      });
      show('Message sent.');
      setComposing(false);
      loadInbox();
      openThread(data.thread_id);
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to send message', 'error');
    } finally {
      setSending(false);
    }
  }

  async function handleReply(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId || !activeThreadId || !reply.trim()) return;

    const thread = inbox.find(t => t.thread_id === activeThreadId);
    const last = threadMessages[threadMessages.length - 1];
    const recipientId = thread?.other_user_id ?? (last ? (last.sender_id === user?.user_id ? last.recipient_id : last.sender_id) : null);
    if (!recipientId) return;

    setSending(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ recipient_id: recipientId, body: reply.trim(), thread_id: activeThreadId }),
      });
      setReply('');
      openThread(activeThreadId);
      loadInbox();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to send reply', 'error');
    } finally {
      setSending(false);
    }
  }

  function backToInbox() {
    setActiveThreadId(null);
    setComposing(false);
    setThreadMessages([]);
    if (searchParams?.get('thread')) router.replace(window.location.pathname);
  }

  if (!schoolId || loading) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <p className="text-sm text-gray-500">Loading messages…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  // ── Thread view ────────────────────────────────────────────────────────────
  if (activeThreadId) {
    const thread = inbox.find(t => t.thread_id === activeThreadId);
    return (
      <div className="max-w-2xl mx-auto p-4">
        {toast && (
          <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}>
            {toast.message}
          </div>
        )}
        <button type="button" onClick={backToInbox} className="text-sm text-[#2472B4] font-medium mb-3 hover:underline">
          ← Back to inbox
        </button>
        <h1 className="text-lg font-semibold text-gray-900 mb-1">
          {thread ? `${thread.other_first_name} ${thread.other_last_name}` : 'Conversation'}
        </h1>
        {thread && <p className="text-xs text-gray-400 mb-4 capitalize">{roleLabel(thread.other_role)}</p>}

        {threadLoading ? (
          <p className="text-sm text-gray-500 py-6 text-center">Loading conversation…</p>
        ) : (
          <div className="space-y-3 mb-4">
            {threadMessages.map(m => {
              const mine = m.sender_id === user?.user_id;
              return (
                <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-xl px-4 py-2.5 ${mine ? 'bg-[#003366] text-white' : 'bg-white border border-gray-200 text-gray-900'}`}>
                    {m.subject && <p className="text-xs font-semibold mb-1 opacity-80">{m.subject}</p>}
                    <p className="text-sm whitespace-pre-wrap">{m.body}</p>
                    <p className={`text-[10px] mt-1.5 ${mine ? 'text-white/60' : 'text-gray-400'}`}>{formatDateTime(m.sent_at)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <form onSubmit={handleReply} className="bg-white border border-gray-200 rounded-xl p-3 flex gap-2">
          <textarea
            value={reply}
            onChange={e => setReply(e.target.value)}
            rows={2}
            placeholder="Type a reply…"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
          />
          <button
            type="submit"
            disabled={sending || !reply.trim()}
            className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 self-end"
          >
            Send
          </button>
        </form>
      </div>
    );
  }

  // ── Compose view ───────────────────────────────────────────────────────────
  if (composing) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        {toast && (
          <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}>
            {toast.message}
          </div>
        )}
        <button type="button" onClick={backToInbox} className="text-sm text-[#2472B4] font-medium mb-3 hover:underline">
          ← Back to inbox
        </button>
        <h1 className="text-lg font-semibold text-gray-900 mb-4">New message</h1>

        <form onSubmit={handleSendNew} className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">To</label>
            {contactsLoading ? (
              <p className="text-sm text-gray-400 py-2">Loading contacts…</p>
            ) : contacts.length === 0 ? (
              <p className="text-sm text-gray-400 py-2">No contacts available to message.</p>
            ) : (
              <select
                value={newRecipient}
                onChange={e => setNewRecipient(e.target.value)}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              >
                <option value="">Select a recipient…</option>
                {contacts.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.first_name} {c.last_name} ({roleLabel(c.role)})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Subject (optional)</label>
            <input
              type="text"
              value={newSubject}
              onChange={e => setNewSubject(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </div>

          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Message</label>
            <textarea
              value={newBody}
              onChange={e => setNewBody(e.target.value)}
              rows={5}
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </div>

          <button
            type="submit"
            disabled={sending || !newRecipient || !newBody.trim()}
            className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send message'}
          </button>
        </form>
      </div>
    );
  }

  // ── Inbox view ─────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto p-4">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}>
          {toast.message}
        </div>
      )}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-gray-900">Messages</h1>
        <button
          type="button"
          onClick={startCompose}
          className="px-3 py-1.5 bg-slate-800 text-white text-xs font-medium rounded-lg hover:bg-slate-700"
        >
          New message
        </button>
      </div>

      {inbox.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 text-center">
          <p className="text-sm text-gray-500">No messages yet.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm divide-y divide-gray-100">
          {inbox.map(t => (
            <button
              key={t.thread_id}
              type="button"
              onClick={() => openThread(t.thread_id)}
              className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {t.other_first_name} {t.other_last_name}
                    <span className="ml-2 text-[10px] font-normal uppercase tracking-wide text-gray-400">{roleLabel(t.other_role)}</span>
                  </p>
                  {t.subject && <p className="text-xs text-gray-600 mt-0.5 truncate">{t.subject}</p>}
                  <p className="text-xs text-gray-500 mt-0.5 truncate">{t.body}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[11px] text-gray-400">{formatDateTime(t.sent_at)}</p>
                  {t.unread_count > 0 && (
                    <span className="inline-block mt-1 min-w-[18px] px-1.5 py-0.5 rounded-full bg-[#FF761B] text-white text-[10px] font-semibold leading-none">
                      {t.unread_count}
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
