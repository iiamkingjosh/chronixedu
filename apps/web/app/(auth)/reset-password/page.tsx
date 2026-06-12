'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const schema = z
  .object({
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirm_password: z.string().min(1, 'Please confirm your password'),
  })
  .refine((d) => d.password === d.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });

type FormValues = z.infer<typeof schema>;

function parseRecoveryToken(): string | null {
  if (typeof window === 'undefined') return null;

  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const hashParams = new URLSearchParams(hash);
  const hashToken = hashParams.get('access_token');
  const hashType = hashParams.get('type');
  if (hashToken && hashType === 'recovery') return hashToken;

  const queryToken = new URLSearchParams(window.location.search).get('access_token');
  const queryType = new URLSearchParams(window.location.search).get('type');
  if (queryToken && queryType === 'recovery') return queryToken;

  return null;
}

export default function ResetPasswordPage() {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirm_password: '' },
  });

  useEffect(() => {
    const token = parseRecoveryToken();
    if (!token) {
      setTokenError(
        'This reset link is invalid or has expired. Please request a new password reset link.'
      );
      return;
    }
    setAccessToken(token);
    // Remove tokens from the URL so they are not kept in browser history.
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function onSubmit(values: FormValues) {
    if (!accessToken) return;
    setSubmitError(null);

    try {
      const res = await fetch(`${API_BASE}/api/auth/confirm-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: values.password,
          confirm_password: values.confirm_password,
          access_token: accessToken,
        }),
      });
      const json = await res.json();

      if (!res.ok) {
        const message =
          json.error?.message ??
          (typeof json.error === 'string' ? json.error : 'Could not reset password');
        throw new Error(typeof message === 'string' ? message : 'Could not reset password');
      }

      setDone(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not reset password');
    }
  }

  return (
    <div className="w-full max-w-md">
      <div className="rounded-2xl bg-white shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-8 pt-8 pb-6 text-center border-b border-gray-100 bg-[#003366]">
          <h1 className="text-2xl font-semibold text-white tracking-tight">Reset password</h1>
          <p className="mt-1 text-sm text-blue-100">
            {done ? 'Password updated' : 'Choose a new password'}
          </p>
        </div>

        {tokenError ? (
          <div className="px-8 py-7 space-y-5">
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {tokenError}
            </div>
            <Link
              href="/forgot-password"
              className="block w-full text-center rounded-lg bg-[#FF761B] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#e56812] transition-colors"
            >
              Request a new link
            </Link>
            <Link
              href="/login"
              className="block text-center text-sm text-[#2472B4] hover:underline"
            >
              Back to sign in
            </Link>
          </div>
        ) : done ? (
          <div className="px-8 py-7 space-y-5">
            <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
              Your password has been updated. You can now sign in with your new password.
            </div>
            <Link
              href="/login"
              className="block w-full text-center rounded-lg bg-[#FF761B] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#e56812] transition-colors"
            >
              Sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="px-8 py-7 space-y-5">
            {submitError && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {submitError}
              </div>
            )}

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1.5">
                New password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                {...register('password')}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#2472B4] focus:border-transparent"
              />
              {errors.password && (
                <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="confirm_password"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Confirm password
              </label>
              <input
                id="confirm_password"
                type="password"
                autoComplete="new-password"
                {...register('confirm_password')}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#2472B4] focus:border-transparent"
              />
              {errors.confirm_password && (
                <p className="mt-1 text-xs text-red-600">{errors.confirm_password.message}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !accessToken}
              className="w-full rounded-lg bg-[#FF761B] hover:bg-[#e56812] disabled:opacity-60 text-white font-medium py-2.5 text-sm transition-colors"
            >
              {isSubmitting ? 'Saving…' : 'Update password'}
            </button>

            <Link
              href="/login"
              className="block text-center text-sm text-[#2472B4] hover:underline"
            >
              Back to sign in
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
