'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';
import { getDefaultDashboardPath } from '@/lib/auth';

const schema = z
  .object({
    current_password: z.string().min(1, 'Enter your current password'),
    new_password: z.string().min(8, 'Password must be at least 8 characters'),
    confirm_password: z.string().min(1, 'Re-enter your new password'),
  })
  .refine((d) => d.new_password === d.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });

type FormValues = z.infer<typeof schema>;

export default function ChangePasswordPage() {
  const router = useRouter();
  const { user, token, loading, setAuth } = useAuth();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const forced = !!user?.must_change_password;

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { current_password: '', new_password: '', confirm_password: '' },
  });

  async function onSubmit(values: FormValues) {
    setSubmitError(null);
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: values.current_password, new_password: values.new_password }),
      });
      if (user && token) setAuth({ ...user, must_change_password: false }, token);
      setDone(true);
      setTimeout(() => {
        router.replace(user ? getDefaultDashboardPath(user.role) : '/login');
      }, 1200);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to change password');
    }
  }

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#f8fafc' }}>
        <p className="text-sm text-gray-400">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-12" style={{ background: '#f4f6f9' }}>
      <div className="w-full max-w-[420px]">
        <div style={{
          background: '#fff',
          borderRadius: '20px',
          padding: '40px 36px',
          boxShadow: '0 4px 24px rgba(0,0,0,0.07), 0 1px 4px rgba(0,0,0,0.04)',
        }}>
          <div className="flex justify-center mb-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icons/Chronix_Logo.png" alt="Chronix Edu" className="h-9 w-auto" />
          </div>

          <div className="mb-7">
            <h2 style={{ fontSize: '22px', fontWeight: 700, color: '#003366', letterSpacing: '-0.02em', marginBottom: '6px' }}>
              {forced ? 'Set a new password' : 'Change your password'}
            </h2>
            <p style={{ fontSize: '13.5px', color: '#8a97a8' }}>
              {forced
                ? 'You signed in with a temporary password. Choose a new one to continue.'
                : 'Update the password for your account.'}
            </p>
          </div>

          {done ? (
            <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
              Password updated. Redirecting…
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              {submitError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{submitError}</div>
              )}

              <div>
                <label htmlFor="current_password" className="block text-sm font-medium text-gray-700 mb-1.5">
                  Current password
                </label>
                <input
                  id="current_password"
                  type="password"
                  autoComplete="current-password"
                  {...register('current_password')}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#2472B4]"
                />
                {errors.current_password && <p className="mt-1 text-xs text-red-600">{errors.current_password.message}</p>}
              </div>

              <div>
                <label htmlFor="new_password" className="block text-sm font-medium text-gray-700 mb-1.5">
                  New password
                </label>
                <input
                  id="new_password"
                  type="password"
                  autoComplete="new-password"
                  {...register('new_password')}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#2472B4]"
                />
                {errors.new_password && <p className="mt-1 text-xs text-red-600">{errors.new_password.message}</p>}
              </div>

              <div>
                <label htmlFor="confirm_password" className="block text-sm font-medium text-gray-700 mb-1.5">
                  Confirm new password
                </label>
                <input
                  id="confirm_password"
                  type="password"
                  autoComplete="new-password"
                  {...register('confirm_password')}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#2472B4]"
                />
                {errors.confirm_password && <p className="mt-1 text-xs text-red-600">{errors.confirm_password.message}</p>}
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full rounded-xl font-bold text-white py-3 text-sm transition-all disabled:opacity-60"
                style={{ background: 'linear-gradient(135deg, #FF761B 0%, #ff9248 100%)' }}
              >
                {isSubmitting ? 'Updating…' : 'Update password'}
              </button>

              {!forced && (
                <button
                  type="button"
                  onClick={() => router.back()}
                  className="w-full text-center text-sm font-medium text-gray-500 hover:text-gray-700"
                >
                  Cancel
                </button>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
