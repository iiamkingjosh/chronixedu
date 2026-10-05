'use client';

import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { QRCodeSVG } from 'qrcode.react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

/**
 * Two-factor sign-in for platform admins: setting it up (2FA commit 2, 3 Oct 2026), and moving to a
 * new phone and the requirement setting (commit 5, 4 Oct 2026).
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
  /** Only the root admin may make two-factor optional again. */
  may_make_optional: boolean;
}

const BASE = '/api/super-admin/two-factor';

const passwordSchema = z.object({ password: z.string().min(1, 'Enter your password') });
const sixDigits = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app');
const codeSchema = z.object({ code: sixDigits });
const moveSchema = z.object({ password: z.string().min(1, 'Enter your password'), code: sixDigits });
const offSchema = z.object({
  password: z.string().min(1, 'Enter your password'),
  code: z.string().trim(),
});
type PasswordForm = z.infer<typeof passwordSchema>;
type CodeForm = z.infer<typeof codeSchema>;
type MoveForm = z.infer<typeof moveSchema>;
type OffForm = z.infer<typeof offSchema>;

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

/**
 * Moving to a new phone while the old one works. The password and a code from the current phone
 * first; then the new phone's QR code, held in this component's memory only; then a code from the new
 * phone switches over. Walking away at any point changes nothing.
 */
function DeviceMove({ onMoved }: { onMoved: (token: string) => void }) {
  const [pending, setPending] = useState<{ uri: string; secret: string } | null>(null);
  const [error, setError] = useState('');
  const startForm = useForm<MoveForm>({ resolver: zodResolver(moveSchema) });
  const confirmForm = useForm<CodeForm>({ resolver: zodResolver(codeSchema) });

  async function start(values: MoveForm) {
    setError('');
    try {
      const res = await apiFetch<{ data: { otpauth_uri: string; secret: string } }>(`${BASE}/device-move`, { method: 'POST', body: JSON.stringify(values) });
      startForm.reset();
      setPending({ uri: res.data.otpauth_uri, secret: res.data.secret });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not start moving to a new phone');
    }
  }

  async function confirm(values: CodeForm) {
    setError('');
    try {
      const res = await apiFetch<{ data: { access_token: string } }>(`${BASE}/device-move/confirm`, { method: 'POST', body: JSON.stringify(values) });
      confirmForm.reset();
      setPending(null);
      onMoved(res.data.access_token);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not switch to the new phone');
    }
  }

  return (
    <div className="card px-5 py-5">
      <h2 className="text-base font-semibold text-gray-900">Moving to a new phone</h2>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      {!pending ? (
        <form onSubmit={startForm.handleSubmit(start)} noValidate>
          <p className="mt-1 text-sm text-gray-600">
            For when your current phone still works. Confirm your password and enter a code from your current phone.
            It keeps working until you finish. A lost phone is different: sign in with a recovery code.
          </p>
          <input {...startForm.register('password')} type="password" autoComplete="current-password" placeholder="Password"
            className="mt-3 w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm" />
          {startForm.formState.errors.password && <p className="mt-1 text-xs text-red-600">{startForm.formState.errors.password.message}</p>}
          <input {...startForm.register('code')} inputMode="numeric" autoComplete="one-time-code" placeholder="Code from current phone"
            className="mt-2 block w-56 rounded-md border border-gray-300 px-3 py-2 text-sm tracking-widest" />
          {startForm.formState.errors.code && <p className="mt-1 text-xs text-red-600">{startForm.formState.errors.code.message}</p>}
          <div className="mt-3">
            <button type="submit" disabled={startForm.formState.isSubmitting} className="rounded-md bg-[#003366] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#002244] disabled:opacity-50">
              {startForm.formState.isSubmitting ? 'Checking…' : 'Continue'}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={confirmForm.handleSubmit(confirm)} noValidate>
          <p className="mt-1 text-sm text-gray-600">Scan this with the authenticator app on your new phone. It waits 15 minutes.</p>
          <div data-sentry-block className="mt-4 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <div className="rounded-md border border-gray-200 bg-white p-3">
              <QRCodeSVG value={pending.uri} size={176} />
            </div>
            <div className="text-sm text-gray-600">
              <p>Cannot scan it? Enter this key in the app instead:</p>
              <p className="mt-2 font-mono text-sm text-gray-900 break-all">{groupKey(pending.secret)}</p>
            </div>
          </div>
          <p className="mt-5 text-sm text-gray-600">Then enter the 6-digit code the NEW phone shows.</p>
          <input {...confirmForm.register('code')} inputMode="numeric" autoComplete="one-time-code" placeholder="123456"
            className="mt-2 w-40 rounded-md border border-gray-300 px-3 py-2 text-sm tracking-widest" />
          {confirmForm.formState.errors.code && <p className="mt-1 text-xs text-red-600">{confirmForm.formState.errors.code.message}</p>}
          <p className="mt-3 text-xs text-gray-500">Switching signs out every other session on this account. Your recovery codes stay the same.</p>
          <div className="mt-3 flex gap-2">
            <button type="submit" disabled={confirmForm.formState.isSubmitting} className="rounded-md bg-[#003366] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#002244] disabled:opacity-50">
              {confirmForm.formState.isSubmitting ? 'Checking…' : 'Switch to the new phone'}
            </button>
            <button type="button" onClick={() => { setPending(null); setError(''); }} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * Whether two-factor is required for this account. The consequence is shown before the change is
 * sent (decided 4 Oct 2026): an admin without two-factor who makes it required is confined to this
 * page at once.
 */
function Requirement({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const target = !status.required;

  if (status.required && !status.may_make_optional) {
    return (
      <div className="card px-5 py-5">
        <h2 className="text-base font-semibold text-gray-900">Required for your account</h2>
        <p className="mt-1 text-sm text-gray-600">
          Two-factor sign-in is required for your account. If it is ever reset, you will set it up again before using anything else.
        </p>
      </div>
    );
  }

  const consequence = target
    ? (status.enabled
        ? 'Nothing changes while two-factor is on. If it is ever reset, you will have to set it up again before using anything else.'
        : 'You will be confined to this page until you set two-factor up. Every other page will send you back here.')
      + (status.may_make_optional ? '' : ' Only the root admin can make it optional again.')
    : 'If two-factor is ever reset, you could then use the platform with your password alone.';

  async function save() {
    setSaving(true);
    setError('');
    try {
      await apiFetch(`${BASE}/required`, { method: 'PUT', body: JSON.stringify({ required: target }) });
      setConfirming(false);
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not change the setting');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card px-5 py-5">
      <h2 className="text-base font-semibold text-gray-900">{status.required ? 'Required for your account' : 'Optional for your account'}</h2>
      <p className="mt-1 text-sm text-gray-600">
        {status.required
          ? 'Two-factor sign-in is required for your account.'
          : 'Two-factor sign-in is your choice on this account. Making it required means it must always be on.'}
      </p>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      {!confirming ? (
        <button type="button" onClick={() => setConfirming(true)} className="mt-3 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-[#003366] hover:text-[#003366]">
          {target ? 'Make it required' : 'Make it optional'}
        </button>
      ) : (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-900">{consequence} The change is recorded.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={save} disabled={saving} className="rounded-md bg-[#003366] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#002244] disabled:opacity-50">
              {saving ? 'Saving…' : target ? 'Yes, make it required' : 'Yes, make it optional'}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Turning two-factor off (4 Oct 2026). The consequence is on screen before the form, and nothing is
 * sent until the form is submitted with the password and a current code, or one recovery code. While
 * the account is marked required, it says why it cannot be turned off instead.
 */
function TurnOff({ status, onDone }: { status: Status; onDone: (token: string) => void }) {
  const [open, setOpen] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const form = useForm<OffForm>({ resolver: zodResolver(offSchema) });

  if (status.required) {
    return (
      <div className="card px-5 py-5">
        <h2 className="text-base font-semibold text-gray-900">Turning it off</h2>
        <p className="mt-1 text-sm text-gray-600">
          Two-factor sign-in is required for your account, so it cannot be turned off here.
          {status.may_make_optional ? ' Make it optional above first.' : ' Only the root admin can make it optional.'}
        </p>
      </div>
    );
  }

  async function submit(values: OffForm) {
    setError('');
    const code = values.code.trim();
    if (!useRecovery && !/^\d{6}$/.test(code)) {
      form.setError('code', { message: 'Enter the 6-digit code from your authenticator app' });
      return;
    }
    if (useRecovery && code.length < 16) {
      form.setError('code', { message: 'Enter one of your recovery codes' });
      return;
    }
    try {
      const body = useRecovery ? { password: values.password, recovery_code: code } : { password: values.password, code };
      const res = await apiFetch<{ data: { access_token: string } }>(`${BASE}/disable`, { method: 'POST', body: JSON.stringify(body) });
      form.reset();
      setOpen(false);
      onDone(res.data.access_token);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not turn two-factor sign-in off');
    }
  }

  return (
    <div className="card px-5 py-5">
      <h2 className="text-base font-semibold text-gray-900">Turning it off</h2>
      {!open ? (
        <>
          <p className="mt-1 text-sm text-gray-600">You can switch it back on at any time, with a new QR code and new recovery codes.</p>
          <button type="button" onClick={() => setOpen(true)} className="mt-3 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-red-600 hover:text-red-700">
            Turn two-factor sign-in off…
          </button>
        </>
      ) : (
        <form onSubmit={form.handleSubmit(submit)} noValidate>
          <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Signing in will then need only your password. Your recovery codes stop working, and every other
            session on this account is signed out. The change is recorded.
          </div>
          {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
          <input {...form.register('password')} type="password" autoComplete="current-password" placeholder="Password"
            className="mt-3 w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm" />
          {form.formState.errors.password && <p className="mt-1 text-xs text-red-600">{form.formState.errors.password.message}</p>}
          <input {...form.register('code')} inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code"
            placeholder={useRecovery ? 'Recovery code' : 'Code from your authenticator app'}
            className="mt-2 block w-64 rounded-md border border-gray-300 px-3 py-2 text-sm tracking-widest" />
          {form.formState.errors.code && <p className="mt-1 text-xs text-red-600">{form.formState.errors.code.message}</p>}
          <button type="button" onClick={() => { setUseRecovery(!useRecovery); form.clearErrors('code'); }}
            className="mt-2 text-xs font-medium text-[#2472B4] hover:underline">
            {useRecovery ? 'Use a code from your authenticator app instead' : 'Lost your phone? Use a recovery code instead'}
          </button>
          <div className="mt-3 flex gap-2">
            <button type="submit" disabled={form.formState.isSubmitting} className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50">
              {form.formState.isSubmitting ? 'Checking…' : 'Turn it off'}
            </button>
            <button type="button" onClick={() => { setOpen(false); setError(''); form.reset(); }} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function SecurityPage() {
  const { user, setAuth } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [enrolment, setEnrolment] = useState<{ uri: string; secret: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [moved, setMoved] = useState(false);
  const [turnedOff, setTurnedOff] = useState(false);

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

  function deviceMoved(token: string) {
    // Moving ended every session this account had; this one continues on the new token.
    if (user) setAuth(user, token);
    setMoved(true);
    void load();
  }

  function switchedOff(token: string) {
    // Turning it off ended every other session; this one continues on the new token.
    if (user) setAuth(user, token);
    setMoved(false);
    setTurnedOff(true);
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

      {turnedOff && !status?.enabled && (
        <div className="mb-4 rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          Two-factor sign-in is off. Signing in now needs only your password. Every other session was signed out.
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
              If you lose your phone, sign in with a recovery code. If those are lost too, the platform
              owner can reset it from the database. To switch it off, use the last section on this page.
            </p>
          </div>
          {moved && (
            <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
              Your new phone is set up. Every other session was signed out. Your recovery codes are unchanged.
            </div>
          )}
          <DeviceMove onMoved={deviceMoved} />
          <Requirement status={status} onChanged={() => void load()} />
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
          <TurnOff status={status} onDone={switchedOff} />
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

      {!codes && status && !status.enabled && !enrolment && (
        <div className="mt-6">
          <Requirement status={status} onChanged={() => void load()} />
        </div>
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
