'use client';

import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

type Role = 'super_admin' | 'principal' | 'teacher' | 'parent' | 'student' | 'registrar' | 'bursar';

interface UserRow {
  id: string;
  school_id: string | null;
  email: string;
  role: Role;
  first_name: string;
  last_name: string;
  title: string | null;
  teacher_mode: 'class' | 'subject';
  phone: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

interface AssignmentDetail {
  id: string;
  class_name: string;
  class_level: string;
  class_stream: string | null;
  subject_name: string;
  subject_code: string;
}

const ROLES: Role[] = ['super_admin', 'principal', 'teacher', 'parent', 'student', 'registrar', 'bursar'];

const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  principal:   'Principal',
  teacher:     'Teacher',
  parent:      'Parent',
  student:     'Student',
  registrar:   'Registrar',
  bursar:      'Bursar',
};

const ROLE_BADGE_CLASSES: Record<Role, string> = {
  super_admin: 'bg-purple-50 text-purple-700 border-purple-200',
  principal:   'bg-blue-50 text-blue-700 border-blue-200',
  teacher:     'bg-emerald-50 text-emerald-700 border-emerald-200',
  parent:      'bg-amber-50 text-amber-700 border-amber-200',
  student:     'bg-slate-50 text-slate-700 border-slate-200',
  registrar:   'bg-cyan-50 text-cyan-700 border-cyan-200',
  bursar:      'bg-pink-50 text-pink-700 border-pink-200',
};

const LIMIT = 25;

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const d = new Date(value);
  return d.toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fullName(u: UserRow): string {
  return u.title ? `${u.title} ${u.first_name} ${u.last_name}` : `${u.first_name} ${u.last_name}`;
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const createSchema = z.object({
  email:        z.string().min(1, 'Email is required').email('Enter a valid email address'),
  first_name:   z.string().min(1, 'First name is required').max(255),
  last_name:    z.string().min(1, 'Last name is required').max(255),
  title:        z.string().max(20).optional().or(z.literal('')),
  phone:        z.string().max(50).optional().or(z.literal('')),
  role:         z.enum(['super_admin', 'principal', 'teacher', 'parent', 'student', 'registrar', 'bursar'], { error: 'Select a role' }),
  teacher_mode: z.enum(['class', 'subject']).optional(),
}).superRefine((data, ctx) => {
  if (data.role === 'teacher' && !data.teacher_mode) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Select a teaching mode for this teacher', path: ['teacher_mode'] });
  }
});

type CreateForm = z.infer<typeof createSchema>;

const editSchema = z.object({
  first_name: z.string().min(1, 'First name is required').max(255),
  last_name:  z.string().min(1, 'Last name is required').max(255),
  title:      z.string().max(20).optional().or(z.literal('')),
  phone:      z.string().max(50).optional().or(z.literal('')),
});

type EditForm = z.infer<typeof editSchema>;

// ── Toast ─────────────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

// ── Modal wrapper ─────────────────────────────────────────────────────────────

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className={`bg-white rounded-xl shadow-xl w-full ${wide ? 'max-w-2xl' : 'max-w-md'}`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5 max-h-[75vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400';

function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${ROLE_BADGE_CLASSES[role]}`}>
      {ROLE_LABELS[role]}
    </span>
  );
}

function StatusBadge({ isActive }: { isActive: boolean }) {
  return isActive ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-green-50 text-green-700 border-green-200">Active</span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-gray-100 text-gray-500 border-gray-200">Inactive</span>
  );
}

// ── Create User Modal ─────────────────────────────────────────────────────────

function CreateUserModal({ schoolId, onClose, onCreated }: {
  schoolId: string;
  onClose: () => void;
  onCreated: (user: UserRow, tempPassword: string) => void;
}) {
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: { title: '', phone: '' },
  });
  const [apiError, setApiError] = useState('');
  const role = watch('role');

  async function onSubmit(values: CreateForm) {
    setApiError('');
    try {
      const payload = {
        email: values.email,
        first_name: values.first_name,
        last_name: values.last_name,
        title: values.title || undefined,
        phone: values.phone || undefined,
        role: values.role,
        ...(values.role === 'teacher' ? { teacher_mode: values.teacher_mode } : {}),
      };
      const res = await apiFetch<{ success: boolean; data: { user: UserRow; temp_password: string } }>(
        `/api/schools/${schoolId}/users`,
        { method: 'POST', body: JSON.stringify(payload) }
      );
      onCreated(res.data.user, res.data.temp_password);
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to create user');
    }
  }

  return (
    <Modal title="Create User" onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="First Name" error={errors.first_name?.message}>
            <input {...register('first_name')} className={inputClass} placeholder="Adaeze" />
          </Field>
          <Field label="Last Name" error={errors.last_name?.message}>
            <input {...register('last_name')} className={inputClass} placeholder="Okafor" />
          </Field>
        </div>

        <Field label="Email" error={errors.email?.message}>
          <input {...register('email')} type="email" className={inputClass} placeholder="adaeze.okafor@school.edu.ng" />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Title (optional)" error={errors.title?.message}>
            <input {...register('title')} className={inputClass} placeholder="Mrs., Dr., Mr." />
          </Field>
          <Field label="Phone (optional)" error={errors.phone?.message}>
            <input {...register('phone')} className={inputClass} placeholder="+234 800 000 0000" />
          </Field>
        </div>

        <Field label="Role" error={errors.role?.message}>
          <select {...register('role')} className={inputClass} defaultValue="">
            <option value="" disabled>Select a role…</option>
            {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </Field>

        {role === 'teacher' && (
          <Field label="Teaching Mode" error={errors.teacher_mode?.message}>
            <div className="space-y-2">
              <label className="flex items-start gap-3 border border-gray-200 rounded-lg px-3 py-2.5 cursor-pointer hover:border-slate-400 has-[:checked]:border-slate-500 has-[:checked]:bg-slate-50">
                <input {...register('teacher_mode')} type="radio" value="class" className="mt-0.5 accent-slate-700" />
                <span>
                  <span className="block text-sm font-medium text-gray-900">Class teacher (primary school)</span>
                  <span className="block text-xs text-gray-500">Teaches a single class across most or all subjects</span>
                </span>
              </label>
              <label className="flex items-start gap-3 border border-gray-200 rounded-lg px-3 py-2.5 cursor-pointer hover:border-slate-400 has-[:checked]:border-slate-500 has-[:checked]:bg-slate-50">
                <input {...register('teacher_mode')} type="radio" value="subject" className="mt-0.5 accent-slate-700" />
                <span>
                  <span className="block text-sm font-medium text-gray-900">Subject teacher (secondary school)</span>
                  <span className="block text-xs text-gray-500">Teaches one or more subjects across multiple classes</span>
                </span>
              </label>
            </div>
            <p className="mt-2 text-xs text-amber-700">This setting cannot be changed after the account is created without admin intervention.</p>
          </Field>
        )}

        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors">
            {isSubmitting ? 'Creating…' : 'Create User'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Edit User Modal ───────────────────────────────────────────────────────────

function EditUserModal({ schoolId, user, onClose, onSaved }: {
  schoolId: string;
  user: UserRow;
  onClose: () => void;
  onSaved: (user: UserRow) => void;
}) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<EditForm>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      first_name: user.first_name,
      last_name: user.last_name,
      title: user.title ?? '',
      phone: user.phone ?? '',
    },
  });
  const [apiError, setApiError] = useState('');

  const [assignments, setAssignments] = useState<AssignmentDetail[] | null>(null);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);

  useEffect(() => {
    if (user.role !== 'teacher') return;
    setAssignmentsLoading(true);
    apiFetch<{ success: boolean; data: { teacher_mode: string; assignments: AssignmentDetail[] } }>(
      `/api/schools/${schoolId}/teachers/${user.id}/assignments`
    )
      .then(({ data }) => setAssignments(data.assignments))
      .catch(() => setAssignments([]))
      .finally(() => setAssignmentsLoading(false));
  }, [schoolId, user.id, user.role]);

  async function onSubmit(values: EditForm) {
    setApiError('');
    try {
      const res = await apiFetch<{ success: boolean; data: UserRow }>(
        `/api/schools/${schoolId}/users/${user.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            first_name: values.first_name,
            last_name: values.last_name,
            title: values.title || null,
            phone: values.phone || null,
          }),
        }
      );
      onSaved(res.data);
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to update user');
    }
  }

  return (
    <Modal title={`Edit ${fullName(user)}`} onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 flex flex-wrap gap-x-6 gap-y-1">
          <div>
            <span className="block text-xs text-blue-600 uppercase tracking-wide">Role</span>
            <span className="text-sm font-medium text-blue-900">{ROLE_LABELS[user.role]}</span>
          </div>
          {user.role === 'teacher' && (
            <div>
              <span className="block text-xs text-blue-600 uppercase tracking-wide">Teaching Mode</span>
              <span className="text-sm font-medium text-blue-900">
                {user.teacher_mode === 'class' ? 'Class teacher (primary school)' : 'Subject teacher (secondary school)'}
              </span>
            </div>
          )}
          <p className="w-full text-xs text-blue-700 mt-1">Role and teaching mode cannot be changed after account creation. Contact a super admin if this needs to change.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="First Name" error={errors.first_name?.message}>
            <input {...register('first_name')} className={inputClass} />
          </Field>
          <Field label="Last Name" error={errors.last_name?.message}>
            <input {...register('last_name')} className={inputClass} />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Title (optional)" error={errors.title?.message}>
            <input {...register('title')} className={inputClass} placeholder="Mrs., Dr., Mr." />
          </Field>
          <Field label="Phone (optional)" error={errors.phone?.message}>
            <input {...register('phone')} className={inputClass} />
          </Field>
        </div>

        <Field label="Email">
          <input value={user.email} disabled className={`${inputClass} bg-gray-50 text-gray-500`} />
        </Field>

        {user.role === 'teacher' && (
          <div>
            <span className="block text-sm font-medium text-gray-700 mb-1">Assignments (current term)</span>
            {assignmentsLoading && <p className="text-sm text-gray-400">Loading assignments…</p>}
            {!assignmentsLoading && assignments && assignments.length === 0 && (
              <p className="text-sm text-gray-400">No class or subject assignments for the current term.</p>
            )}
            {!assignmentsLoading && assignments && assignments.length > 0 && (
              <ul className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                {assignments.map(a => (
                  <li key={a.id} className="px-3 py-2 text-sm text-gray-700 flex items-center justify-between">
                    <span>{a.subject_name} ({a.subject_code})</span>
                    <span className="text-gray-400">{a.class_name}{a.class_stream ? ` — ${a.class_stream}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-xs text-gray-400">Manage class and subject assignments from the Roster section.</p>
          </div>
        )}

        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors">
            {isSubmitting ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Status confirm modal (deactivate / reactivate) ────────────────────────────

function StatusConfirmModal({ user, onClose, onConfirm }: {
  user: UserRow;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const deactivating = user.is_active;

  function handleConfirm() {
    setSubmitting(true);
    onConfirm();
  }

  return (
    <Modal title={deactivating ? 'Deactivate User' : 'Reactivate User'} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-700">
          {deactivating
            ? <>Are you sure you want to deactivate <span className="font-medium">{fullName(user)}</span>? They will immediately lose the ability to log in.</>
            : <>Are you sure you want to reactivate <span className="font-medium">{fullName(user)}</span>? They will regain the ability to log in.</>}
        </p>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className={`px-5 py-2 text-sm font-medium rounded-lg text-white transition-colors disabled:opacity-50 ${deactivating ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}
          >
            {deactivating ? 'Yes, Deactivate' : 'Yes, Reactivate'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Reset password link modal ─────────────────────────────────────────────────

function ResetLinkModal({ user, onClose }: { user: UserRow; onClose: () => void }) {
  return (
    <Modal title="Password Reset Email Sent" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-900">Email sent to {user.email}</p>
            <p className="mt-1 text-sm text-gray-600">
              <span className="font-medium">{fullName(user)}</span> will receive a password reset link shortly. The link expires after a short time.
            </p>
          </div>
        </div>
        <div className="flex justify-end pt-2">
          <button type="button" onClick={onClose} className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 transition-colors">Done</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function UsersPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();

  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [roleFilter, setRoleFilter] = useState<Role | ''>('');

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [statusTarget, setStatusTarget] = useState<UserRow | null>(null);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [resetLink, setResetLink] = useState<{ user: UserRow } | null>(null);
  const [credentials, setCredentials] = useState<{ user: UserRow; temp_password: string } | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  const load = useCallback(() => {
    if (!schoolId) return;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
    if (roleFilter) params.set('role', roleFilter);

    apiFetch<{ success: boolean; data: { users: UserRow[]; total: number } }>(
      `/api/schools/${schoolId}/users?${params.toString()}`
    )
      .then(({ data }) => {
        setUsers(data.users);
        setTotal(data.total);
      })
      .catch(() => show('Failed to load users', 'error'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, page, roleFilter]);

  useEffect(() => { load(); }, [load]);

  function handleRoleFilterChange(value: string) {
    setRoleFilter(value as Role | '');
    setPage(1);
  }

  function handleCreated(user: UserRow, tempPassword: string) {
    setCreateOpen(false);
    setCredentials({ user, temp_password: tempPassword });
    show('User created');
    setPage(1);
    load();
  }

  function handleSaved(user: UserRow) {
    setEditing(null);
    setUsers(prev => prev.map(u => (u.id === user.id ? user : u)));
    show('User updated');
  }

  async function handleStatusConfirm() {
    if (!statusTarget) return;
    const target = statusTarget;
    try {
      const res = await apiFetch<{ success: boolean; data: UserRow }>(
        `/api/schools/${schoolId}/users/${target.id}/status`,
        { method: 'PATCH', body: JSON.stringify({ is_active: !target.is_active }) }
      );
      setUsers(prev => prev.map(u => (u.id === res.data.id ? res.data : u)));
      show(res.data.is_active ? 'User reactivated' : 'User deactivated');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to update user status', 'error');
    } finally {
      setStatusTarget(null);
    }
  }

  async function handleResetPassword(user: UserRow) {
    setResetTarget(user);
    try {
      await apiFetch<{ success: boolean; data: { sent: boolean } }>(
        `/api/schools/${schoolId}/users/${user.id}/reset-password`,
        { method: 'POST' }
      );
      setResetLink({ user });
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to send reset email', 'error');
    } finally {
      setResetTarget(null);
    }
  }

  return (
    <div className="max-w-6xl mx-auto p-8">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${
          toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.message}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-1">
        <h1 className="text-xl font-semibold text-gray-900">User Management</h1>
        <button
          onClick={() => setCreateOpen(true)}
          className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 transition-colors flex items-center gap-1.5 self-start sm:self-auto"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Create User
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-6">Manage staff, students, and parent accounts for this school.</p>

      {credentials && (
        <div className="mb-6 bg-green-50 border border-green-200 rounded-xl px-5 py-4 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-green-800 mb-1">
              {fullName(credentials.user)} was created — share these credentials securely:
            </p>
            <p className="text-sm text-green-700 font-mono">
              {credentials.user.email} &nbsp;/&nbsp; {credentials.temp_password}
            </p>
            <p className="text-xs text-green-600 mt-1">This temporary password is shown only once. The user should change it on first login.</p>
          </div>
          <button onClick={() => setCredentials(null)} className="text-green-500 hover:text-green-700">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-500">Filter by role</label>
          <select
            value={roleFilter}
            onChange={e => handleRoleFilterChange(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          >
            <option value="">All roles</option>
            {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </div>
        <p className="text-sm text-gray-400">{total} user{total === 1 ? '' : 's'}</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <div className="grid grid-cols-[1.5fr_1fr_1.5fr_100px_180px_200px] gap-3 px-5 py-3 bg-gray-50 border-b border-gray-200 min-w-[840px]">
          {['Name', 'Role', 'Email', 'Status', 'Last Login', 'Actions'].map(h => (
            <span key={h} className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</span>
          ))}
        </div>

        {loading && <div className="px-5 py-10 text-center text-sm text-gray-400">Loading…</div>}

        {!loading && users.length === 0 && (
          <div className="px-5 py-10 text-center text-sm text-gray-400">No users found.</div>
        )}

        {!loading && users.length > 0 && (
          <div className="divide-y divide-gray-100">
            {users.map(u => (
              <div key={u.id} className="grid grid-cols-[1.5fr_1fr_1.5fr_100px_180px_200px] gap-3 px-5 py-3 items-center min-w-[840px]">
                <span className="text-sm font-medium text-gray-900">{fullName(u)}</span>
                <RoleBadge role={u.role} />
                <span className="text-sm text-gray-600 truncate">{u.email}</span>
                <StatusBadge isActive={u.is_active} />
                <span className="text-sm text-gray-500">{formatDateTime(u.last_login_at)}</span>
                <div className="flex items-center gap-3 text-sm">
                  <button onClick={() => setEditing(u)} className="text-slate-600 hover:text-slate-900 font-medium">Edit</button>
                  <button onClick={() => setStatusTarget(u)} className={`font-medium ${u.is_active ? 'text-red-600 hover:text-red-700' : 'text-green-600 hover:text-green-700'}`}>
                    {u.is_active ? 'Deactivate' : 'Reactivate'}
                  </button>
                  <button
                    onClick={() => handleResetPassword(u)}
                    disabled={resetTarget?.id === u.id}
                    className="text-gray-500 hover:text-gray-800 font-medium disabled:opacity-50"
                  >
                    {resetTarget?.id === u.id ? 'Generating…' : 'Reset Password'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-gray-400">Page {page} of {totalPages}</p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {createOpen && schoolId && (
        <CreateUserModal schoolId={schoolId} onClose={() => setCreateOpen(false)} onCreated={handleCreated} />
      )}

      {editing && schoolId && (
        <EditUserModal schoolId={schoolId} user={editing} onClose={() => setEditing(null)} onSaved={handleSaved} />
      )}

      {statusTarget && (
        <StatusConfirmModal user={statusTarget} onClose={() => setStatusTarget(null)} onConfirm={handleStatusConfirm} />
      )}

      {resetLink && (
        <ResetLinkModal user={resetLink.user} onClose={() => setResetLink(null)} />
      )}
    </div>
  );
}
