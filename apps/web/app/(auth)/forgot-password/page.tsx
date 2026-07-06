'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_API_URL) {
  throw new Error('NEXT_PUBLIC_API_URL is required in production');
}
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const schema = z.object({
  email: z.string().email('Enter a valid email address'),
});

type FormValues = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  });

  async function onSubmit(values: FormValues) {
    setSubmitError(null);
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin;
      const redirectTo = `${appUrl}/reset-password`;
      const res = await fetch(`${API_BASE}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: values.email, redirect_to: redirectTo }),
      });
      const json = await res.json();

      if (!res.ok) {
        const message =
          json.error?.message ??
          (typeof json.error === 'string' ? json.error : 'Could not send reset email');
        throw new Error(typeof message === 'string' ? message : 'Could not send reset email');
      }

      setSent(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not send reset email');
    }
  }

  return (
    <div className="w-full max-w-md">
      <div className="rounded-2xl bg-white shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-8 pt-8 pb-6 text-center border-b border-gray-100 bg-[#003366]">
          <h1 className="text-2xl font-semibold text-white tracking-tight">Forgot password</h1>
          <p className="mt-1 text-sm text-blue-100">
            {sent ? 'Check your inbox' : 'We will email you a reset link'}
          </p>
        </div>

        {sent ? (
          <div className="px-8 py-7 space-y-5">
            <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
              If an account exists for that email, a password reset link has been sent. The link
              expires after a short time.
            </div>
            <p className="text-sm text-gray-500">
              Did not receive it? Check your spam folder or try again in a few minutes.
            </p>
            <Link
              href="/login"
              className="block w-full text-center rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="px-8 py-7 space-y-5">
            {submitError && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {submitError}
              </div>
            )}

            <p className="text-sm text-gray-600">
              Enter the email address linked to your Chronix Edu account.
            </p>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1.5">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                {...register('email')}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#2472B4] focus:border-transparent"
                placeholder="you@school.edu"
              />
              {errors.email && (
                <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full rounded-lg bg-[#FF761B] hover:bg-[#e56812] disabled:opacity-60 text-white font-medium py-2.5 text-sm transition-colors"
            >
              {isSubmitting ? 'Sending…' : 'Send reset link'}
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
