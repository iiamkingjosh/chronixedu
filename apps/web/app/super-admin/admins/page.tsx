'use client';

import { useEffect, useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { suspendPlatformAdmin, reactivatePlatformAdmin, deletePlatformAdmin, resendPlatformAdminWelcome } from '@/lib/superAdminApi';

interface PlatformAdmin {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  created_at: string;
  last_login_at: string | null;
  is_active: boolean;
  /** The account automated changes are signed with (migration 053). Listed so its name is explicable; never managed. */
  is_system: boolean;
  /** Must switch two-factor on before reaching anything else (migration 058): every admin created since. */
  two_factor_required: boolean;
  two_factor_on: boolean;
}

function TwoFactorBadge({ admin }: { admin: PlatformAdmin }) {
  if (admin.is_system) return <span className="text-xs text-gray-400">—</span>;
  if (admin.two_factor_on) {
    // "Required" shows beside "On" too, so making it optional again is visible here (4 Oct 2026).
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-green-50 text-green-700 border border-green-200">
        {admin.two_factor_required ? 'On, required' : 'On'}
      </span>
    );
  }
  if (admin.two_factor_required) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200"
        title="Must set it up at first sign-in before reaching anything else.">Required, not set up</span>
    );
  }
  return <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-gray-50 text-gray-600 border border-gray-200">Off</span>;
}

// No password: the new admin sets their own with Forgot password, and the address is their only key,
// so it is typed twice (2 Oct 2026).
const createSchema = z.object({
  first_name: z.string().min(1, 'First name is required'),
  last_name: z.string().min(1, 'Last name is required'),
  email: z.string().trim().email('Enter a valid email'),
  email_confirmation: z.string().trim().min(1, 'Type the email address again'),
}).refine(d => d.email.toLowerCase() === d.email_confirmation.toLowerCase(), {
  path: ['email_confirmation'],
  message: 'The two email addresses do not match',
});
type CreateForm = z.infer<typeof createSchema>;

const reasonSchema = z.object({
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
});
type ReasonForm = z.infer<typeof reasonSchema>;

const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2472B4]';

function SuspendAdminModal({ admin, onClose, onDone }: { admin: PlatformAdmin; onClose: () => void; onDone: () => void }) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<ReasonForm>({ resolver: zodResolver(reasonSchema) });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: ReasonForm) {
    setApiError('');
    try {
      await suspendPlatformAdmin(admin.id, values.reason);
      onDone();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to suspend admin');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Suspend Platform Admin</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        <form onSubmit={handleSubmit(onSubmit)} className="px-6 py-5 space-y-4">
          <p className="text-sm text-gray-700">
            This immediately blocks <span className="font-medium">{admin.email}</span> from logging in. Enter a reason:
          </p>
          <textarea {...register('reason')} rows={3} className={inputClass} placeholder="Explain why this admin is being suspended..." />
          {errors.reason && <p className="text-xs text-red-600">{errors.reason.message}</p>}
          {apiError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
              <p className="text-sm text-red-700">{apiError}</p>
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50">
              {isSubmitting ? 'Suspending…' : 'Suspend'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ReactivateAdminModal({ admin, onClose, onDone }: { admin: PlatformAdmin; onClose: () => void; onDone: () => void }) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<ReasonForm>({ resolver: zodResolver(reasonSchema) });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: ReasonForm) {
    setApiError('');
    try {
      await reactivatePlatformAdmin(admin.id, values.reason);
      onDone();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to reactivate admin');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Reactivate Platform Admin</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        <form onSubmit={handleSubmit(onSubmit)} className="px-6 py-5 space-y-4">
          <p className="text-sm text-gray-700">
            This restores login access for <span className="font-medium">{admin.email}</span>. Enter a reason:
          </p>
          <textarea {...register('reason')} rows={3} className={inputClass} placeholder="Explain why this admin is being reactivated..." />
          {errors.reason && <p className="text-xs text-red-600">{errors.reason.message}</p>}
          {apiError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
              <p className="text-sm text-red-700">{apiError}</p>
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50">
              {isSubmitting ? 'Reactivating…' : 'Reactivate'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteAdminModal({ admin, onClose, onDone }: { admin: PlatformAdmin; onClose: () => void; onDone: () => void }) {
  const [confirmEmail, setConfirmEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState('');
  const matches = confirmEmail.trim().toLowerCase() === admin.email.toLowerCase();

  async function handleDelete() {
    setApiError('');
    setSubmitting(true);
    try {
      await deletePlatformAdmin(admin.id, confirmEmail.trim());
      onDone();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to delete admin');
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Delete Platform Admin</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            This permanently revokes access for <span className="font-medium">{admin.email}</span>. Their login credentials are deleted and cannot be recovered.
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Type <span className="font-mono text-red-600">{admin.email}</span> to confirm
            </label>
            <input
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
              className={inputClass}
              placeholder={admin.email}
              autoComplete="off"
            />
          </div>
          {apiError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
              <p className="text-sm text-red-700">{apiError}</p>
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
            <button
              type="button"
              disabled={!matches || submitting}
              onClick={handleDelete}
              className="px-5 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? 'Deleting…' : 'Delete Permanently'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

function CreateAdminModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { show } = useToast();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
  });

  async function onSubmit(values: CreateForm) {
    try {
      const res = await apiFetch<{ success: boolean; data: { welcome_email: 'sent' | 'not_sent' } }>('/api/super-admin/admins', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      show(res.data.welcome_email === 'sent'
        ? `Platform admin ${values.email} created and emailed.`
        : `Platform admin ${values.email} created. The email was NOT sent: tell them to use Forgot password.`,
        res.data.welcome_email === 'sent' ? 'success' : 'error');
      onCreated();
      onClose();
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to create admin', 'error');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Add Platform Admin</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        <form onSubmit={handleSubmit(onSubmit)} className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">First name</label>
              <input {...register('first_name')} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2472B4]" />
              {errors.first_name && <p className="mt-1 text-xs text-red-600">{errors.first_name.message}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Last name</label>
              <input {...register('last_name')} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2472B4]" />
              {errors.last_name && <p className="mt-1 text-xs text-red-600">{errors.last_name.message}</p>}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input {...register('email')} type="email" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2472B4]" />
            {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Type the email again</label>
            <input {...register('email_confirmation')} type="email" autoComplete="off" onPaste={(e) => e.preventDefault()} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2472B4]" />
            {errors.email_confirmation && <p className="mt-1 text-xs text-red-600">{errors.email_confirmation.message}</p>}
          </div>
          <p className="text-xs text-gray-500">They are emailed that their account is ready and how to set their own password with Forgot password. The email carries no password, so check the address.</p>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="px-4 py-2 rounded-lg bg-[#003366] text-white text-sm font-medium hover:bg-[#002244] disabled:opacity-60">
              {isSubmitting ? 'Creating…' : 'Create Admin'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Only the root Chronix Technology account can suspend/reactivate/delete other
// platform admins — mirrors the backend's requireRootAdmin check. Buttons are
// hidden for everyone else so the UI doesn't offer actions that would 403.
const ROOT_ADMIN_EMAIL = 'info@chronixtechnology.com';

export default function PlatformAdminsPage() {
  const { user } = useAuth();
  const isRootAdmin = user?.email?.toLowerCase() === ROOT_ADMIN_EMAIL;
  const [admins, setAdmins] = useState<PlatformAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [suspendTarget, setSuspendTarget] = useState<PlatformAdmin | null>(null);
  const [reactivateTarget, setReactivateTarget] = useState<PlatformAdmin | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PlatformAdmin | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const { show } = useToast();

  async function handleResendWelcome(admin: PlatformAdmin) {
    setResendingId(admin.id);
    try {
      const result = await resendPlatformAdminWelcome(admin.id);
      show(result.welcome_email === 'sent'
        ? `Welcome email sent to ${admin.email}`
        : `The welcome email to ${admin.email} was NOT sent: tell them to use Forgot password.`,
        result.welcome_email === 'sent' ? 'success' : 'error');
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to send email', 'error');
    } finally {
      setResendingId(null);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ success: boolean; data: PlatformAdmin[] }>('/api/super-admin/admins');
      setAdmins(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admins');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 font-heading">Platform Admins</h1>
          <p className="mt-1 text-sm text-gray-500">Accounts with full platform access</p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-[#003366] px-4 py-2 text-sm font-medium text-white hover:bg-[#002244]"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add Admin
        </button>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 mb-4">{error}</div>
      )}

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <th className="px-5 py-3">Name</th>
              <th className="px-5 py-3">Email</th>
              <th className="px-5 py-3">Created</th>
              <th className="px-5 py-3">Last Login</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Two-factor</th>
              <th className="px-5 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              Array.from({ length: 2 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} className="px-5 py-3"><div className="h-4 bg-gray-200 rounded animate-pulse w-24" /></td>
                  ))}
                </tr>
              ))
            ) : admins.length === 0 ? (
              <tr><td colSpan={7} className="px-5 py-8 text-center text-gray-400">No platform admins found.</td></tr>
            ) : (
              admins.map(admin => {
                const isSelf = admin.id === user?.user_id;
                return (
                  <tr key={admin.id} className="hover:bg-gray-50">
                    <td className="px-5 py-3 font-medium text-gray-900">
                      {admin.first_name} {admin.last_name}
                      {isSelf && (
                        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-[#003366]/10 text-[#003366]">You</span>
                      )}
                      {admin.is_system && (
                        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600" title="Signs automated changes, such as the trial gate's. Not a person; it cannot sign in.">System</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-gray-600">{admin.email}</td>
                    <td className="px-5 py-3 text-gray-500">{formatDate(admin.created_at)}</td>
                    <td className="px-5 py-3 text-gray-500">{formatDate(admin.last_login_at)}</td>
                    <td className="px-5 py-3">
                      {admin.is_system ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-gray-50 text-gray-600 border border-gray-200">Cannot sign in</span>
                      ) : admin.is_active ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-green-50 text-green-700 border border-green-200">Active</span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-red-50 text-red-700 border border-red-200">Suspended</span>
                      )}
                    </td>
                    <td className="px-5 py-3"><TwoFactorBadge admin={admin} /></td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      {isSelf || admin.is_system ? (
                        <span className="text-xs text-gray-400">—</span>
                      ) : (
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => handleResendWelcome(admin)}
                            disabled={resendingId === admin.id}
                            className="text-[#2472B4] hover:text-[#1a5a9a] font-medium text-sm disabled:opacity-50"
                          >
                            {resendingId === admin.id ? 'Sending…' : 'Resend welcome'}
                          </button>
                          {isRootAdmin && (
                            <>
                              {admin.is_active ? (
                                <button onClick={() => setSuspendTarget(admin)} className="text-red-600 hover:text-red-700 font-medium text-sm">Suspend</button>
                              ) : (
                                <button onClick={() => setReactivateTarget(admin)} className="text-green-600 hover:text-green-700 font-medium text-sm">Reactivate</button>
                              )}
                              <button onClick={() => setDeleteTarget(admin)} className="text-red-700 hover:text-red-800 font-medium text-sm">Delete</button>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <CreateAdminModal onClose={() => setShowCreate(false)} onCreated={load} />
      )}

      {suspendTarget && (
        <SuspendAdminModal
          admin={suspendTarget}
          onClose={() => setSuspendTarget(null)}
          onDone={() => {
            setSuspendTarget(null);
            show('Platform admin suspended', 'success');
            load();
          }}
        />
      )}

      {reactivateTarget && (
        <ReactivateAdminModal
          admin={reactivateTarget}
          onClose={() => setReactivateTarget(null)}
          onDone={() => {
            setReactivateTarget(null);
            show('Platform admin reactivated', 'success');
            load();
          }}
        />
      )}

      {deleteTarget && (
        <DeleteAdminModal
          admin={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDone={() => {
            setDeleteTarget(null);
            show('Platform admin deleted', 'success');
            load();
          }}
        />
      )}
    </div>
  );
}
