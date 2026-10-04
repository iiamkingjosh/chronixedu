'use client';

import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { QRCodeSVG } from 'qrcode.react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

/**
 * Two-factor sign-in for platform admins (2FA commit 2 of 4, 3 Oct 2026).
 *
 * This page shows a credential: the authenticator secret, as a QR code and as text, and the recovery
 * codes. It sits under /super-admin, where Sentry session replay never runs (lib/sentryScrub.ts,
 * SECURITY.md Round 34), and every element that shows one is also marked data-sentry-block. The
 * secret and the codes are held in this page's memory only, never in storage or the address, and
 * are dropped once the admin is done with them.
 */

interface Status {
  /** This admin must switch it on before reaching anything else (migration 058). */
  required: boolean;
  enabled: boolean;
  enabled_at: string | null;
  locked_until: string | null;
  unused_recovery_codes: number;
}

const BASE = '/api/super-admin/two-factor';

const passwordSchema = z.object({ password: z.string().min(1, 'Enter your password') });
const codeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app') });
type PasswordForm = z.infer<typeof passwordSchema>;
type CodeForm = z.infer<typeof codeSchema>;

function groupKey(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const text = `Chronix Edu recovery codes. Each works once, in place of an authenticator code.\n\n${codes.join('\n')}\n`;

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(text);
      setCopy('copied');
    } catch {
      // The browser refused the clipboard (permission, or an insecure page); say so, and offer the file.
      setCopy('failed');
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chronix-edu-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="card px-5 py-5">
      <h2 className="text-base font-semibold text-gray-900">Your recovery codes</h2>
      <p className="mt-1 text-sm text-gray-600">
        They are shown once. If you lose your phone, each one gets you in once, in place of a code.
        Keep them somewhere other than your phone: your password manager, or printed.
      </p>
      <ul data-sentry-block className="mt-4 grid grid-cols-2 gap-2 font-mono text-sm text-gray-900">
        {codes.map((c) => <li key={c} className="rounded bg-gray-50 px-3 py-2">{c}</li>)}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={copyCodes} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-[#003366] hover:text-[#003366]">
          {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Could not copy: use Download' : 'Copy'}
        </button>
        <button type="button" onClick={download} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-[#003366] hover:text-[#003366]">
          Download .txt
        </button>
        <button type="button" onClick={onDone} className="rounded-md bg-[#003366] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#002244]">
          I have saved them
        </button>
      </div>
    </div>
  );
}

export default function SecurityPage() {
  const { user, setAuth } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [enrolment, setEnrolment] = useState<{ uri: string; secret: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const passwordForm = useForm<PasswordForm>({ resolver: zodResolver(passwordSchema) });
  const confirmForm = useForm<CodeForm>({ resolver: zodResolver(codeSchema) });
  const regenerateForm = useForm<CodeForm>({ resolver: zodResolver(codeSchema) });

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: Status }>(`${BASE}/status`);
      setStatus(res.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load two-factor status');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function start(values: PasswordForm) {
    setError('');
    try {
      const res = await apiFetch<{ data: { otpauth_uri: string; secret: string } }>(`${BASE}/enrolment`, { method: 'POST', body: JSON.stringify(values) });
      passwordForm.reset();
      setEnrolment({ uri: res.data.otpauth_uri, secret: res.data.secret });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not start setting up two-factor sign-in');
    }
  }

  async function confirm(values: CodeForm) {
    setError('');
    try {
      const res = await apiFetch<{ data: { recovery_codes: string[]; access_token: string } }>(`${BASE}/enrolment/confirm`, { method: 'POST', body: JSON.stringify(values) });
      // Switching it on ended every session this account had; this one continues on the new token.
      if (user) setAuth(user, res.data.access_token);
      setEnrolment(null);
      confirmForm.reset();
      setCodes(res.data.recovery_codes);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not switch two-factor sign-in on');
    }
  }

  async function regenerate(values: CodeForm) {
    setError('');
    try {
      const res = await apiFetch<{ data: { recovery_codes: string[] } }>(`${BASE}/recovery-codes`, { method: 'POST', body: JSON.stringify(values) });
      regenerateForm.reset();
      setCodes(res.data.recovery_codes);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not make new recovery codes');
    }
  }

  function doneWithCodes() {
    setCodes(null);
    void load();
  }

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-semibold text-gray-900 font-heading">Two-factor sign-in</h1>
      <p className="mt-1 mb-6 text-sm text-gray-500">
        A code from an authenticator app on your phone, asked for after your password.
      </p>

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>}

      {/* Every other platform page sends a required, unenrolled admin here (lib/refusalRedirect.ts). */}
      {!codes && status?.required && !status.enabled && (
        <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          Your account needs two-factor sign-in before you can use the rest of the platform. Set it up below.
        </div>
      )}

      {codes && <RecoveryCodes codes={codes} onDone={doneWithCodes} />}

      {!codes && !status && !error && <p className="text-sm text-gray-500">Loading…</p>}

      {!codes && status?.enabled && (
        <div className="space-y-6">
          <div className="card px-5 py-5">
            <p className="text-sm font-medium text-gray-900">On since {new Date(status.enabled_at!).toLocaleString('en-NG')}</p>
            <p className={`mt-1 text-sm ${status.unused_recovery_codes <= 3 ? 'text-amber-700' : 'text-gray-600'}`}>
              {status.unused_recovery_codes} recovery code{status.unused_recovery_codes === 1 ? '' : 's'} left.
              {status.unused_recovery_codes <= 3 && ' Make a new set below before you run out.'}
            </p>
            {status.locked_until && (
              <p className="mt-2 text-sm text-red-700">Locked after too many wrong codes, until {new Date(status.locked_until).toLocaleTimeString('en-NG')}.</p>
            )}
            <p className="mt-3 text-xs text-gray-500">
              There is no switch to turn this off. If you lose your phone, sign in with a recovery code.
              If those are lost too, the platform owner can reset it from the database.
            </p>
          </div>
          <form onSubmit={regenerateForm.handleSubmit(regenerate)} className="card px-5 py-5" noValidate>
            <h2 className="text-base font-semibold text-gray-900">New recovery codes</h2>
            <p className="mt-1 text-sm text-gray-600">Replaces all your current codes. Enter a code from your authenticator app.</p>
            <input {...regenerateForm.register('code')} inputMode="numeric" autoComplete="one-time-code" placeholder="123456"
              className="mt-3 w-40 rounded-md border border-gray-300 px-3 py-2 text-sm tracking-widest" />
            {regenerateForm.formState.errors.code && <p className="mt-1 text-xs text-red-600">{regenerateForm.formState.errors.code.message}</p>}
            <div className="mt-3">
              <button type="submit" disabled={regenerateForm.formState.isSubmitting} className="rounded-md bg-[#003366] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#002244] disabled:opacity-50">
                {regenerateForm.formState.isSubmitting ? 'Making…' : 'Make new codes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {!codes && status && !status.enabled && !enrolment && (
        <form onSubmit={passwordForm.handleSubmit(start)} className="card px-5 py-5" noValidate>
          <h2 className="text-base font-semibold text-gray-900">Set it up</h2>
          <p className="mt-1 text-sm text-gray-600">
            You will need an authenticator app, such as Google Authenticator, Microsoft Authenticator or
            1Password. First, confirm your password.
          </p>
          <input {...passwordForm.register('password')} type="password" autoComplete="current-password"
            className="mt-3 w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm" />
          {passwordForm.formState.errors.password && <p className="mt-1 text-xs text-red-600">{passwordForm.formState.errors.password.message}</p>}
          <div className="mt-3">
            <button type="submit" disabled={passwordForm.formState.isSubmitting} className="rounded-md bg-[#003366] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#002244] disabled:opacity-50">
              {passwordForm.formState.isSubmitting ? 'Checking…' : 'Continue'}
            </button>
          </div>
        </form>
      )}

      {!codes && enrolment && (
        <form onSubmit={confirmForm.handleSubmit(confirm)} className="card px-5 py-5" noValidate>
          <h2 className="text-base font-semibold text-gray-900">Scan this with your authenticator app</h2>
          <div data-sentry-block className="mt-4 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <div className="rounded-md border border-gray-200 bg-white p-3">
              <QRCodeSVG value={enrolment.uri} size={176} />
            </div>
            <div className="text-sm text-gray-600">
              <p>Cannot scan it? Enter this key in the app instead:</p>
              <p className="mt-2 font-mono text-sm text-gray-900 break-all">{groupKey(enrolment.secret)}</p>
            </div>
          </div>
          <p className="mt-5 text-sm text-gray-600">Then enter the 6-digit code the app shows.</p>
          <input {...confirmForm.register('code')} inputMode="numeric" autoComplete="one-time-code" placeholder="123456"
            className="mt-2 w-40 rounded-md border border-gray-300 px-3 py-2 text-sm tracking-widest" />
          {confirmForm.formState.errors.code && <p className="mt-1 text-xs text-red-600">{confirmForm.formState.errors.code.message}</p>}
          <p className="mt-3 text-xs text-gray-500">Switching it on signs out every other session on this account.</p>
          <div className="mt-3">
            <button type="submit" disabled={confirmForm.formState.isSubmitting} className="rounded-md bg-[#003366] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#002244] disabled:opacity-50">
              {confirmForm.formState.isSubmitting ? 'Checking…' : 'Switch it on'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
