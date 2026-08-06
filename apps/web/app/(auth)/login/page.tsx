'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/app/providers';
import { getDefaultDashboardPath } from '@/lib/auth';

if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_API_URL) {
  throw new Error('NEXT_PUBLIC_API_URL is required in production');
}
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const schema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type FormValues = z.infer<typeof schema>;

const features = [
  {
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FF761B" strokeWidth="2.2" strokeLinecap="round">
        <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
      </svg>
    ),
    label: 'Automated results & PDF report cards',
  },
  {
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FF761B" strokeWidth="2.2" strokeLinecap="round">
        <path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
      </svg>
    ),
    label: 'Paystack fee collection & reminders',
  },
  {
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FF761B" strokeWidth="2.2" strokeLinecap="round">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
      </svg>
    ),
    label: 'Real-time SMS & in-app parent alerts',
  },
];

export default function LoginPage() {
  const router = useRouter();
  const { user, loading, setAuth } = useAuth();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('reason');
    if (reason === 'idle') {
      setSessionNotice('You were logged out after 10 minutes of inactivity. Please sign in again.');
    } else if (reason === 'expired') {
      setSessionNotice('Your session expired. Please sign in again.');
    }
  }, []);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  useEffect(() => {
    if (!loading && user) {
      router.replace(getDefaultDashboardPath(user.role));
    }
  }, [loading, user, router]);

  async function onSubmit(values: FormValues) {
    setSubmitError(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (!res.ok) {
        const message =
          typeof json.error === 'string' ? json.error : json.error?.message ?? 'Login failed';
        throw new Error(message);
      }
      setAuth(json.data.user, json.data.access_token);
      router.replace(getDefaultDashboardPath(json.data.user.role));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Login failed');
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#f8fafc' }}>
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 12a9 9 0 11-6.219-8.56"/>
          </svg>
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">

      {/* ── Left panel (desktop only) ── */}
      <div
        className="hidden lg:flex lg:w-[46%] flex-col justify-between px-14 py-12 relative overflow-hidden select-none"
        style={{ background: 'linear-gradient(145deg, #001a33 0%, #003366 55%, #00427f 100%)' }}
      >
        {/* Background glows */}
        <div className="absolute -top-40 -right-40 w-[500px] h-[500px] rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(255,118,27,0.12) 0%, transparent 70%)' }} />
        <div className="absolute -bottom-32 -left-32 w-96 h-96 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(36,114,180,0.18) 0%, transparent 70%)' }} />

        {/* Subtle grid lines */}
        <div className="absolute inset-0 pointer-events-none" style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }} />

        {/* Top: Logo */}
        <div className="relative z-10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/Chronix_Logo.png" alt="Chronix Edu" className="h-10 w-auto" />
        </div>

        {/* Middle: Heading + features */}
        <div className="relative z-10">
          <div className="mb-10">
            <p className="text-[11px] font-semibold uppercase tracking-widest mb-4"
              style={{ color: 'rgba(255,118,27,0.9)' }}>
              School Management Platform
            </p>
            <h1 className="font-bold text-white leading-[1.15] tracking-tight mb-5"
              style={{ fontSize: 'clamp(2rem, 3vw, 2.6rem)', fontFamily: 'var(--font-poppins), Poppins, sans-serif' }}>
              Run your school<br />
              <span style={{ color: '#FF761B' }}>smarter, not harder.</span>
            </h1>
            <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '15px', lineHeight: '1.7', maxWidth: '320px' }}>
              Everything your school needs in one place — built for Nigerian private schools.
            </p>
          </div>

          {/* Feature list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {features.map((f) => (
              <div key={f.label} style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                <div style={{
                  width: '36px', height: '36px', borderRadius: '10px', flexShrink: 0,
                  background: 'rgba(255,118,27,0.12)', border: '1px solid rgba(255,118,27,0.2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {f.icon}
                </div>
                <span style={{ fontSize: '13.5px', color: 'rgba(255,255,255,0.7)', lineHeight: '1.5' }}>
                  {f.label}
                </span>
              </div>
            ))}
          </div>

          {/* Floating notification card */}
          <div style={{
            marginTop: '40px',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '16px',
            padding: '16px 18px',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            maxWidth: '320px',
          }}>
            <div style={{
              width: '36px', height: '36px', borderRadius: '10px',
              background: 'rgba(22,163,74,0.2)', border: '1px solid rgba(22,163,74,0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round">
                <path d="M20 6L9 17l-5-5"/>
              </svg>
            </div>
            <div>
              <p style={{ fontSize: '12.5px', fontWeight: 600, color: '#fff', marginBottom: '2px' }}>
                Results published
              </p>
              <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)' }}>
                JSS 2A — First Term Mathematics
              </p>
            </div>
          </div>
        </div>

        {/* Bottom: social proof */}
        <div className="relative z-10 flex items-center gap-3">
          <div style={{ display: 'flex', marginRight: '4px' }}>
            {['#FF761B', '#2472B4', '#16a34a', '#7c3aed'].map((c, i) => (
              <div key={i} style={{
                width: '26px', height: '26px', borderRadius: '50%',
                background: c, border: '2px solid rgba(0,51,102,0.8)',
                marginLeft: i > 0 ? '-8px' : '0',
              }} />
            ))}
          </div>
          <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)' }}>
            Trusted by schools across Nigeria
          </p>
        </div>
      </div>

      {/* ── Right panel ── */}
      <div className="flex-1 flex items-center justify-center px-6 py-12" style={{ background: '#f4f6f9' }}>
        <div className="w-full max-w-[420px]">

          {/* White card */}
          <div style={{
            background: '#fff',
            borderRadius: '20px',
            padding: '40px 36px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.07), 0 1px 4px rgba(0,0,0,0.04)',
          }}>
            {/* Mobile logo */}
            <div className="flex justify-center mb-8 lg:hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icons/Chronix_Logo.png" alt="Chronix Edu" className="h-9 w-auto" />
            </div>

            {/* Header */}
            <div className="mb-7">
              <h2 style={{
                fontSize: '24px', fontWeight: 700, color: '#003366',
                letterSpacing: '-0.02em', marginBottom: '6px',
                fontFamily: 'var(--font-poppins), Poppins, sans-serif',
              }}>
                Welcome back
              </h2>
              <p style={{ fontSize: '14px', color: '#8a97a8' }}>
                Sign in to your school dashboard
              </p>
            </div>

            {/* Alerts */}
            {sessionNotice && (
              <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                <svg className="mt-0.5 shrink-0" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.5" fill="currentColor"/>
                </svg>
                {sessionNotice}
              </div>
            )}

            {submitError && (
              <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                <svg className="mt-0.5 shrink-0" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
                {submitError}
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleSubmit(onSubmit)} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

              {/* Email */}
              <div>
                <label htmlFor="email" style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#1a2b3c', marginBottom: '7px' }}>
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  {...register('email')}
                  placeholder="you@yourschool.com"
                  className={`w-full rounded-xl border px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 outline-none transition-all focus:border-[#003366] focus:ring-2 focus:ring-[#003366]/10 ${errors.email ? 'border-red-400 bg-red-50/40' : 'border-[#e0e6ef] bg-white'}`}
                />
                {errors.email && (
                  <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                    {errors.email.message}
                  </p>
                )}
              </div>

              {/* Password */}
              <div>
                <div className="flex items-center justify-between mb-[7px]">
                  <label htmlFor="password" style={{ fontSize: '13px', fontWeight: 600, color: '#1a2b3c' }}>
                    Password
                  </label>
                  <Link href="/forgot-password" style={{ fontSize: '12.5px', fontWeight: 500, color: '#2472B4' }}
                    className="hover:underline">
                    Forgot password?
                  </Link>
                </div>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    {...register('password')}
                    placeholder="••••••••"
                    className={`w-full rounded-xl border px-4 py-3 pr-11 text-sm text-gray-900 placeholder:text-gray-400 outline-none transition-all focus:border-[#003366] focus:ring-2 focus:ring-[#003366]/10 ${errors.password ? 'border-red-400 bg-red-50/40' : 'border-[#e0e6ef] bg-white'}`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
                        <line x1="1" y1="1" x2="23" y2="23"/>
                      </svg>
                    ) : (
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                    )}
                  </button>
                </div>
                {errors.password && (
                  <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                    {errors.password.message}
                  </p>
                )}
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full rounded-xl font-bold text-white py-3.5 text-[15px] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                style={{
                  background: 'linear-gradient(135deg, #FF761B 0%, #ff9248 100%)',
                  boxShadow: '0 4px 16px rgba(255,118,27,0.35)',
                  letterSpacing: '-0.01em',
                }}
              >
                {isSubmitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M21 12a9 9 0 11-6.219-8.56"/>
                    </svg>
                    Signing in…
                  </span>
                ) : 'Sign in'}
              </button>
            </form>

            {/* No account */}
            <p className="text-center mt-6" style={{ fontSize: '13px', color: '#8a97a8' }}>
              No account?{' '}
              <a
                href="mailto:edu@chronixtechnology.com?subject=Account%20Request%20%E2%80%94%20Chronix%20Edu%20Portal"
                style={{ color: '#003366', fontWeight: 600 }}
                className="hover:underline"
              >
                Speak to our administrator
              </a>
            </p>
          </div>

          {/* Footer links */}
          <div className="mt-8 text-center space-y-1.5" style={{ fontSize: '11px', color: '#adb8c4' }}>
            <p style={{ fontWeight: 500, color: '#9aa5b1' }}>Chronix Technology Limited</p>
            <p className="flex justify-center flex-wrap gap-x-3 gap-y-1">
              <Link href="/legal/privacy-policy" className="hover:text-gray-600 transition-colors">Privacy Policy</Link>
              <Link href="/legal/cookie-policy" className="hover:text-gray-600 transition-colors">Cookie Policy</Link>
              <Link href="/legal/terms" className="hover:text-gray-600 transition-colors">Terms of Service</Link>
              <Link href="/legal/data-processing-agreement" className="hover:text-gray-600 transition-colors">DPA</Link>
              <Link href="/legal/acceptable-use" className="hover:text-gray-600 transition-colors">Acceptable Use</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
