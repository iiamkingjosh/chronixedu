'use client';

/**
 * The class notices board, for the staff who post to it.
 *
 * Shared by principals and teachers rather than split into /principal and /teacher
 * copies: the API already decides what each role may see and post to, and two pages
 * would mean two places for that logic to drift out of agreement with it.
 *
 * The class picker is built from `data.classes`, which the same request returns — so the
 * form can only ever offer classes the API will accept. Sourcing it from a roster
 * endpoint instead would let the form present a class the server refuses, and the
 * teacher would meet the assignment guard as a bug rather than as a rule.
 *
 * There is no "whole school" option, and the empty-state says where that lives instead.
 * A school-wide notice would appear here and notify nobody, while an announcement
 * notifies and emails — two buttons for one intent, only one of which makes "I've told
 * the school" true.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

interface StaffNotice {
  id: string;
  class_id: string;
  class_name: string;
  title: string;
  body: string;
  created_by: string;
  author_name: string;
  created_at: string;
}

interface PostableClass {
  id: string;
  name: string;
  level: string;
  stream: string | null;
}

interface NoticesPayload {
  notices: StaffNotice[];
  classes: PostableClass[];
}

const TITLE_MAX = 200;
const BODY_MAX = 5000;

function formatWhen(value: string): string {
  return new Date(value).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function className(cls: PostableClass): string {
  return cls.stream ? `${cls.name} ${cls.stream}` : cls.name;
}

export default function NoticesPage() {
  const { schoolId, user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<NoticesPayload | null>(null);

  const [classId, setClassId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const show = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const load = useCallback(() => {
    if (!schoolId) return;
    setLoading(true);
    setError(null);
    apiFetch<{ success: boolean; data: NoticesPayload }>(`/api/schools/${schoolId}/notices`)
      .then(({ data }) => {
        setData(data);
        // Preselect only when there is no ambiguity. A teacher with one class should not
        // have to choose; a principal with twelve must, or the first class in the list
        // silently becomes the default recipient.
        setClassId(prev => (prev ? prev : data.classes.length === 1 ? data.classes[0].id : ''));
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  async function post(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId || !classId || !title.trim() || !body.trim()) return;
    setPosting(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/notices`, {
        method: 'POST',
        body: JSON.stringify({ class_id: classId, title: title.trim(), body: body.trim() }),
      });
      setTitle('');
      setBody('');
      show('Notice posted');
      load();
    } catch (err) {
      show(err instanceof Error ? err.message : 'Could not post the notice', 'error');
    } finally {
      setPosting(false);
    }
  }

  async function remove(notice: StaffNotice) {
    if (!schoolId) return;
    // Deleting is the only destructive action here and it cannot be undone — the row is
    // gone and only the audit entry remains. Worth one confirmation naming the notice.
    if (!window.confirm(`Take down “${notice.title}” from ${notice.class_name}? This cannot be undone.`)) return;
    setDeletingId(notice.id);
    try {
      await apiFetch(`/api/schools/${schoolId}/notices/${notice.id}`, { method: 'DELETE' });
      show('Notice taken down');
      load();
    } catch (err) {
      show(err instanceof Error ? err.message : 'Could not take the notice down', 'error');
    } finally {
      setDeletingId(null);
    }
  }

  const canPost = (data?.classes.length ?? 0) > 0;

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 font-heading">Class Notices</h1>
        <p className="text-sm text-gray-500 mt-1">
          Posted to one class and shown on those students&rsquo; Notices page. To reach the whole
          school with a notification and an email, use{' '}
          <Link href="/principal/announcements" className="text-[#003366] underline">
            Announcements
          </Link>
          .
        </p>
      </div>

      {toast && (
        <div
          className={`mb-4 rounded-lg px-4 py-3 text-sm border ${
            toast.type === 'success'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {toast.message}
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {!loading && !canPost && (
        <div className="mb-6 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          You are not assigned to any class this term, so there is no class to post to. A
          principal or the registrar can assign you to one.
        </div>
      )}

      {canPost && (
        <form onSubmit={post} className="bg-white rounded-lg shadow-sm p-5 mb-8 space-y-4">
          <div>
            <label htmlFor="notice-class" className="block text-sm font-medium text-gray-700 mb-1">Class</label>
            <select
              id="notice-class"
              value={classId}
              onChange={e => setClassId(e.target.value)}
              required
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#003366]/30"
            >
              <option value="">Choose a class…</option>
              {data!.classes.map(cls => (
                <option key={cls.id} value={cls.id}>{className(cls)}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="notice-title" className="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <input
              id="notice-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={TITLE_MAX}
              required
              placeholder="Bring your maths textbook"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#003366]/30"
            />
          </div>

          <div>
            <label htmlFor="notice-body" className="block text-sm font-medium text-gray-700 mb-1">Notice</label>
            <textarea
              id="notice-body"
              value={body}
              onChange={e => setBody(e.target.value)}
              maxLength={BODY_MAX}
              required
              rows={4}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#003366]/30"
            />
            <p className="text-xs text-gray-400 mt-1">{body.length}/{BODY_MAX}</p>
          </div>

          {/* Stated before they post, not after: a notice cannot be edited, so the way to
              correct one is to take it down and post it again. */}
          <p className="text-xs text-gray-500">
            A posted notice cannot be edited. To correct one, take it down and post it again.
          </p>

          <button
            type="submit"
            disabled={posting || !classId || !title.trim() || !body.trim()}
            className="rounded-lg bg-[#003366] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {posting ? 'Posting…' : 'Post notice'}
          </button>
        </form>
      )}

      <h2 className="text-sm font-semibold text-gray-700 mb-3">Posted notices</h2>

      {loading ? (
        <p className="text-sm text-gray-500 py-10 text-center">Loading notices…</p>
      ) : (data?.notices.length ?? 0) === 0 ? (
        <div className="bg-white rounded-lg shadow-sm p-6 text-center">
          <p className="text-sm text-gray-500">No notices have been posted yet.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {data!.notices.map(notice => (
            <li key={notice.id} className="bg-white rounded-lg shadow-sm p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-block rounded-full bg-[#003366]/10 text-[#003366] text-xs px-2 py-0.5">
                      {notice.class_name}
                    </span>
                    <h3 className="font-medium text-gray-900 break-words">{notice.title}</h3>
                  </div>
                  <p className="text-sm text-gray-600 mt-2 whitespace-pre-wrap break-words">{notice.body}</p>
                  <p className="text-xs text-gray-400 mt-2">
                    {notice.author_name || 'Unknown'} · {formatWhen(notice.created_at)}
                    {notice.created_by === user?.user_id && ' · you'}
                  </p>
                </div>
                <button
                  onClick={() => remove(notice)}
                  disabled={deletingId === notice.id}
                  className="shrink-0 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  {deletingId === notice.id ? 'Removing…' : 'Take down'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
