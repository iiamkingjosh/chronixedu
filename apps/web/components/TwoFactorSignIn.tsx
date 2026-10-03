'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { AuthUser } from '@/app/providers';

/**
 * The second step of a platform admin's sign-in (2FA commit 3): the password was right, and the API
 * answered with a challenge instead of a token. The challenge lives in this component's memory only,
 * never in storage or the address, so a refresh starts again at the password, and the screen says so.
 */

const codeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app') });
const recoverySchema = z.object({ recovery_code: z.string().trim().min(16, 'Enter one of your recovery codes, like ABCD-EFGH-JKMN-PQRS') });

interface Props {
  apiBase: string;
  challenge: string;
  onSignedIn: (user: AuthUser, token: string) => void;
  /** Back to the password, with the reason to show. */
  onRestart: (message: string) => void;
}

interface Verified {
  user: AuthUser;
  access_token: string;
  recovery?: { recovery_codes_left: number; notice_email: string };
}

export default function TwoFactorSignIn({ apiBase, challenge, onSignedIn, onRestart }: Props) {
  const [mode, setMode] = useState<'code' | 'recovery'>('code');
  const [error, setError] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<Verified | null>(null);
  const codeForm = useForm<z.infer<typeof codeSchema>>({ resolver: zodResolver(codeSchema) });
  const recoveryForm = useForm<z.infer<typeof recoverySchema>>({ resolver: zodResolver(recoverySchema) });

  async function verify(body: Record<string, string>) {
    setError(null);
    const res = await fetch(`${apiBase}/api/auth/login/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge, ...body }),
    });
    const json = await res.json();
    if (!res.ok) {
      const message: string = typeof json.error?.message === 'string' ? json.error.message : 'That did not work. Try again.';
      if (json.error?.code === 'SIGN_IN_EXPIRED') onRestart(message);
      else setError(message);
      return;
    }
    const data = json.data as Verified;
    // After a recovery code, say how many are left before moving on: the person has usually lost their
    // phone, and the notice email may not have gone.
    if (data.recovery) setRecovered(data);
    else onSignedIn(data.user, data.access_token);
  }

  if (recovered?.recovery) {
    const { recovery_codes_left: left, notice_email: notice } = recovered.recovery;
    return (
      <div className="space-y-4">
        <div className={`rounded-xl border px-4 py-3 text-sm ${left <= 3 ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-gray-200 bg-gray-50 text-gray-700'}`}>
          <p className="font-semibold">Signed in with a recovery code.</p>
          <p className="mt-1">You have {left} recovery code{left === 1 ? '' : 's'} left. Make a new set at Administration → Two-factor Sign-in once you have your authenticator again.</p>
          <p className="mt-1">{notice === 'sent' ? 'We have emailed you about it.' : 'We could not email you about it, so keep a note of this.'}</p>
        </div>
        <button type="button" onClick={() => onSignedIn(recovered.user, recovered.access_token)}
          className="w-full rounded-xl bg-[#003366] py-3 text-[15px] font-bold text-white">
          Continue
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-[#003366]">Two-factor sign-in</h3>
        <p className="mt-1 text-sm text-gray-500">
          {mode === 'code' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your recovery codes. Each works once.'}
        </p>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

      {mode === 'code' ? (
        <form onSubmit={codeForm.handleSubmit((v) => verify({ code: v.code }))} noValidate className="space-y-4">
          <input {...codeForm.register('code')} inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="123456"
            className="w-full rounded-xl border border-[#e0e6ef] px-4 py-3 text-center text-lg tracking-[0.4em] outline-none focus:border-[#003366]" />
          {codeForm.formState.errors.code && <p className="text-xs text-red-600">{codeForm.formState.errors.code.message}</p>}
          <button type="submit" disabled={codeForm.formState.isSubmitting}
            className="w-full rounded-xl py-3 text-[15px] font-bold text-white disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg, #FF761B 0%, #ff9248 100%)' }}>
            {codeForm.formState.isSubmitting ? 'Checking…' : 'Verify'}
          </button>
        </form>
      ) : (
        <form onSubmit={recoveryForm.handleSubmit((v) => verify({ recovery_code: v.recovery_code }))} noValidate className="space-y-4">
          <input {...recoveryForm.register('recovery_code')} autoComplete="off" autoFocus placeholder="ABCD-EFGH-JKMN-PQRS"
            className="w-full rounded-xl border border-[#e0e6ef] px-4 py-3 text-center font-mono text-sm uppercase outline-none focus:border-[#003366]" />
          {recoveryForm.formState.errors.recovery_code && <p className="text-xs text-red-600">{recoveryForm.formState.errors.recovery_code.message}</p>}
          <button type="submit" disabled={recoveryForm.formState.isSubmitting}
            className="w-full rounded-xl py-3 text-[15px] font-bold text-white disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg, #FF761B 0%, #ff9248 100%)' }}>
            {recoveryForm.formState.isSubmitting ? 'Checking…' : 'Use recovery code'}
          </button>
        </form>
      )}

      <button type="button" onClick={() => { setError(null); setMode(mode === 'code' ? 'recovery' : 'code'); }}
        className="text-sm font-medium text-[#2472B4] hover:underline">
        {mode === 'code' ? 'Lost your phone? Use a recovery code' : 'Use a code from your authenticator app'}
      </button>

      <p className="text-xs text-gray-500">
        Keep this page open. If you refresh it or go back, you will need to enter your password again.
      </p>
    </div>
  );
}
