'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useForm, type FieldValues, type Path, type UseFormSetError } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  startOnboarding,
  saveOnboardingStep,
  completeOnboarding,
  type CompleteOnboardingResponse,
} from '@/lib/superAdminApi';
import { ApiError } from '@/lib/api';

// ── Shared UI helpers ────────────────────────────────────────────────────────

const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400';
const nextButtonClass = 'bg-[#003366] text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-[#002244] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[#003366]';
const backButtonClass = 'border border-gray-300 rounded-md px-5 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed';

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/**
 * Shows a failed save the way a person can act on it: the readable summary in the error box,
 * and each server-side field error beside its input. `fieldMap` renames an API field to the
 * form field that holds it (the API's is_demo is the form's `kind`).
 */
function showSaveError<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
  setApiError: (message: string) => void,
  fallback: string,
  fieldMap: Record<string, Path<T>> = {},
  formFields: readonly Path<T>[] = [],
) {
  if (err instanceof ApiError) {
    for (const [field, message] of Object.entries(err.fields)) {
      const target = fieldMap[field] ?? (formFields as readonly string[]).find((f) => f === field);
      if (target) setError(target as Path<T>, { type: 'server', message });
    }
    setApiError(err.message);
    return;
  }
  setApiError(err instanceof Error ? err.message : fallback);
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
      <p className="text-sm text-red-700">{message}</p>
    </div>
  );
}

// ── Wizard state ─────────────────────────────────────────────────────────────

interface TermInput {
  name: string;
  start_date: string;
  end_date: string;
}

interface WizardState {
  sessionId: string;
  schoolId: string;
  schoolName: string;
  schoolEmail: string;
  address: string;
  phone: string;
  motto: string;
  primaryColour: string;
  admissionPrefix: string;
  sessionName: string;
  term: TermInput;
  adminFirstName: string;
  adminLastName: string;
  adminEmail: string;
  adminPhone: string;
  principalCreated: boolean;
}

const initialWizardState: WizardState = {
  sessionId: '',
  schoolId: '',
  schoolName: '',
  schoolEmail: '',
  address: '',
  phone: '',
  motto: '',
  primaryColour: '#003366',
  admissionPrefix: '',
  sessionName: '',
  term: { name: '', start_date: '', end_date: '' },
  adminFirstName: '',
  adminLastName: '',
  adminEmail: '',
  adminPhone: '',
  principalCreated: false,
};

// Five steps since 1 Oct 2026. Grading and assessment are the principal's to set, in Settings.
const STEP_LABELS = ['Info', 'Branding', 'Calendar', 'Admin', 'Review'];

function ProgressBar({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex items-center mb-8">
      {STEP_LABELS.map((label, i) => {
        const stepNum = i + 1;
        const completed = stepNum < currentStep;
        const current = stepNum === currentStep;
        return (
          <div key={label} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold ${
                  completed ? 'bg-[#003366] text-white' : current ? 'bg-[#FF761B] text-white' : 'bg-gray-200 text-gray-500'
                }`}
              >
                {completed ? '✓' : stepNum}
              </div>
              <span className="mt-1 text-xs text-gray-500 whitespace-nowrap">{label}</span>
            </div>
            {stepNum < STEP_LABELS.length && (
              <div className={`flex-1 h-0.5 mx-2 ${completed ? 'bg-[#003366]' : 'bg-gray-200'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: Info ─────────────────────────────────────────────────────────────

const step1CreateSchema = z.object({
  school_name: z.string().trim().min(1, 'School name is required'),
  school_email: z.string().trim().min(1, 'Email is required').email('Enter a valid email address'),
  // No default and no preselected radio: "customer" must be chosen, not inherited (doctrine 8).
  kind: z.enum(['customer', 'demo'], { error: 'Choose whether this is a customer or a demo/test school' }),
});
type Step1CreateForm = z.infer<typeof step1CreateSchema>;

const step1DetailsSchema = z.object({
  address: z.string().min(1, 'Address is required'),
  phone: z.string().min(1, 'Phone is required'),
});
type Step1DetailsForm = z.infer<typeof step1DetailsSchema>;

function Step1Info({ wizard, onNext }: { wizard: WizardState; onNext: (patch: Partial<WizardState>) => void }) {
  const [phase, setPhase] = useState<'create' | 'details'>(wizard.sessionId ? 'details' : 'create');
  const [sessionId, setSessionId] = useState(wizard.sessionId);
  const [schoolId, setSchoolId] = useState(wizard.schoolId);
  const [schoolName, setSchoolName] = useState(wizard.schoolName);
  const [schoolEmail, setSchoolEmail] = useState(wizard.schoolEmail);
  const [apiError, setApiError] = useState('');

  const createForm = useForm<Step1CreateForm>({
    resolver: zodResolver(step1CreateSchema),
    mode: 'onChange',
    defaultValues: { school_name: wizard.schoolName, school_email: wizard.schoolEmail },
  });

  const detailsForm = useForm<Step1DetailsForm>({
    resolver: zodResolver(step1DetailsSchema),
    mode: 'onChange',
    defaultValues: { address: wizard.address, phone: wizard.phone },
  });

  async function onCreateSubmit(values: Step1CreateForm) {
    setApiError('');
    try {
      const res = await startOnboarding({
        school_name: values.school_name,
        school_email: values.school_email,
        is_demo: values.kind === 'demo',
      });
      setSessionId(res.session_id);
      setSchoolId(res.school_id);
      setSchoolName(values.school_name);
      setSchoolEmail(values.school_email);
      setPhase('details');
    } catch (err: unknown) {
      showSaveError(err, createForm.setError, setApiError, 'Failed to start onboarding', { is_demo: 'kind' }, ['school_name', 'school_email']);
    }
  }

  async function onDetailsSubmit(values: Step1DetailsForm) {
    setApiError('');
    try {
      await saveOnboardingStep(sessionId, 1, { name: schoolName, address: values.address, phone: values.phone });
      onNext({
        sessionId,
        schoolId,
        schoolName,
        schoolEmail,
        address: values.address,
        phone: values.phone,
      });
    } catch (err: unknown) {
      showSaveError(err, detailsForm.setError, setApiError, 'Failed to save school details', {}, ['address', 'phone']);
    }
  }

  if (phase === 'create') {
    return (
      <form onSubmit={createForm.handleSubmit(onCreateSubmit)} className="space-y-4">
        <Field label="School Name" error={createForm.formState.errors.school_name?.message}>
          <input {...createForm.register('school_name')} className={inputClass} placeholder="Greenwood High School" />
        </Field>
        <Field label="School Email" error={createForm.formState.errors.school_email?.message}>
          <input {...createForm.register('school_email')} type="email" className={inputClass} placeholder="admin@greenwood.edu.ng" />
        </Field>
        <fieldset>
          <legend className="block text-sm font-medium text-gray-700 mb-1">This school is</legend>
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input type="radio" value="customer" {...createForm.register('kind')} className="mt-0.5" />
              <span><span className="font-medium">A customer</span> — a real school. It counts in platform totals and revenue.</span>
            </label>
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input type="radio" value="demo" {...createForm.register('kind')} className="mt-0.5" />
              <span><span className="font-medium">A demo or test school</span> — for sales demos, training or testing. Left out of totals and revenue.</span>
            </label>
          </div>
          {createForm.formState.errors.kind?.message && (
            <p className="mt-1 text-xs text-red-600">{createForm.formState.errors.kind.message}</p>
          )}
        </fieldset>
        {apiError && <ErrorBox message={apiError} />}
        <div className="flex justify-between pt-2">
          <button type="button" disabled className={backButtonClass}>Back</button>
          <button type="submit" disabled={createForm.formState.isSubmitting} className={nextButtonClass}>
            {createForm.formState.isSubmitting ? 'Creating…' : 'Next'}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={detailsForm.handleSubmit(onDetailsSubmit)} className="space-y-4">
      <div className="bg-gray-50 rounded-lg px-4 py-3 text-sm text-gray-600">
        <p className="font-medium text-gray-900">{schoolName}</p>
        <p>{schoolEmail}</p>
      </div>
      <Field label="Address" error={detailsForm.formState.errors.address?.message}>
        <input {...detailsForm.register('address')} className={inputClass} placeholder="12 School Road, Lagos" />
      </Field>
      <Field label="Phone" error={detailsForm.formState.errors.phone?.message}>
        <input {...detailsForm.register('phone')} className={inputClass} placeholder="+234 800 000 0000" />
      </Field>
      {apiError && <ErrorBox message={apiError} />}
      <div className="flex justify-between pt-2">
        <button type="button" disabled className={backButtonClass}>Back</button>
        <button type="submit" disabled={detailsForm.formState.isSubmitting} className={nextButtonClass}>
          {detailsForm.formState.isSubmitting ? 'Saving…' : 'Next'}
        </button>
      </div>
    </form>
  );
}

// ── Step 2: Branding ─────────────────────────────────────────────────────────

const step2Schema = z.object({
  motto: z.string().optional(),
  primary_colour: z.string().min(1, 'Required'),
  admission_prefix: z.string().min(1, 'Required').max(10, 'Max 10 characters'),
});
type Step2Form = z.infer<typeof step2Schema>;

function Step2Branding({ wizard, onNext, onBack }: { wizard: WizardState; onNext: (patch: Partial<WizardState>) => void; onBack: () => void }) {
  const { register, handleSubmit, watch, setError, formState: { errors, isSubmitting } } = useForm<Step2Form>({
    resolver: zodResolver(step2Schema),
    mode: 'onChange',
    defaultValues: { motto: wizard.motto, primary_colour: wizard.primaryColour, admission_prefix: wizard.admissionPrefix },
  });
  const [apiError, setApiError] = useState('');
  const primaryColour = watch('primary_colour');

  async function onSubmit(values: Step2Form) {
    setApiError('');
    try {
      await saveOnboardingStep(wizard.sessionId, 2, {
        motto: values.motto ?? '',
        primary_colour: values.primary_colour,
        admission_prefix: values.admission_prefix,
      });
      onNext({ motto: values.motto ?? '', primaryColour: values.primary_colour, admissionPrefix: values.admission_prefix });
    } catch (err: unknown) {
      showSaveError(err, setError, setApiError, 'Failed to save branding', {}, ['motto', 'primary_colour', 'admission_prefix']);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Field label="Motto (optional)" error={errors.motto?.message}>
        <input {...register('motto')} className={inputClass} placeholder="Knowledge, Character, Excellence" />
      </Field>
      <Field label="Primary Colour" error={errors.primary_colour?.message}>
        <div className="flex items-center gap-3">
          <input {...register('primary_colour')} type="color" className="h-10 w-16 border border-gray-300 rounded-lg cursor-pointer" />
          <div
            className="flex-1 h-10 rounded-lg border border-gray-200 flex items-center px-3 text-sm text-white font-medium"
            style={{ backgroundColor: primaryColour }}
          >
            {primaryColour}
          </div>
        </div>
      </Field>
      <Field label="Admission Prefix" error={errors.admission_prefix?.message}>
        <input {...register('admission_prefix')} className={inputClass} placeholder="CPO" />
      </Field>
      {apiError && <ErrorBox message={apiError} />}
      <div className="flex justify-between pt-2">
        <button type="button" onClick={onBack} className={backButtonClass}>Back</button>
        <button type="submit" disabled={isSubmitting} className={nextButtonClass}>{isSubmitting ? 'Saving…' : 'Next'}</button>
      </div>
    </form>
  );
}

// ── Step 3: Calendar ─────────────────────────────────────────────────────────

const termSchema = z.object({
  name: z.string().min(1, 'Required'),
  start_date: z.string().min(1, 'Required'),
  end_date: z.string().min(1, 'Required'),
}).refine((data) => new Date(data.end_date) > new Date(data.start_date), {
  message: 'End date must be after start date',
  path: ['end_date'],
});

/**
 * One term: the one the school is starting in, which becomes its current term. Three rows with
 * pre-filled names made the old "touched" check always true, so Next never enabled; a single
 * required term leaves no optional-row inference to get wrong. Later terms are added from
 * Settings → Academic Structure, where overlaps are checked.
 */
const step3Schema = z.object({
  session_name: z.string().trim().min(1, 'Required'),
  term: termSchema,
});
type Step3Form = z.infer<typeof step3Schema>;

function Step3Calendar({ wizard, onNext, onBack }: { wizard: WizardState; onNext: (patch: Partial<WizardState>) => void; onBack: () => void }) {
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<Step3Form>({
    resolver: zodResolver(step3Schema),
    mode: 'onChange',
    defaultValues: { session_name: wizard.sessionName, term: wizard.term },
  });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: Step3Form) {
    setApiError('');
    try {
      await saveOnboardingStep(wizard.sessionId, 3, { session_name: values.session_name, term: values.term });
      onNext({ sessionName: values.session_name, term: values.term });
    } catch (err: unknown) {
      showSaveError(err, setError, setApiError, 'Failed to save academic calendar', {}, ['session_name']);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Field label="Session Name" error={errors.session_name?.message}>
        <input {...register('session_name')} className={inputClass} placeholder="2025/2026" />
      </Field>
      <p className="text-xs text-gray-500">
        Enter the term the school is starting in — it becomes the current term. Later terms
        are added from Settings → Academic Structure, and dates stay editable if the calendar shifts.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border border-gray-200 rounded-lg p-3">
        <Field label="Term Name" error={errors.term?.name?.message}>
          <input {...register('term.name')} className={inputClass} placeholder="e.g. First Term" />
        </Field>
        <Field label="Start Date" error={errors.term?.start_date?.message}>
          <input {...register('term.start_date')} type="date" className={inputClass} />
        </Field>
        <Field label="End Date" error={errors.term?.end_date?.message}>
          <input {...register('term.end_date')} type="date" className={inputClass} />
        </Field>
      </div>
      {apiError && <ErrorBox message={apiError} />}
      <div className="flex justify-between pt-2">
        <button type="button" onClick={onBack} className={backButtonClass}>Back</button>
        <button type="submit" disabled={isSubmitting} className={nextButtonClass}>{isSubmitting ? 'Saving…' : 'Next'}</button>
      </div>
    </form>
  );
}

// ── Step 4: Admin ────────────────────────────────────────────────────────────

// The address is typed twice: a typo ties the principal account to a stranger's mailbox.
const step4Schema = z.object({
  first_name: z.string().min(1, 'Required'),
  last_name: z.string().min(1, 'Required'),
  email: z.string().trim().min(1, 'Required').email('Enter a valid email address'),
  email_confirmation: z.string().trim().min(1, 'Type the email address again'),
  phone: z.string().optional(),
}).refine(d => d.email.toLowerCase() === d.email_confirmation.toLowerCase(), {
  path: ['email_confirmation'],
  message: 'The two email addresses do not match',
});
type Step4Form = z.infer<typeof step4Schema>;

function Step4Admin({ wizard, onNext, onBack }: { wizard: WizardState; onNext: (patch: Partial<WizardState>) => void; onBack: () => void }) {
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<Step4Form>({
    resolver: zodResolver(step4Schema),
    mode: 'onChange',
    defaultValues: {
      first_name: wizard.adminFirstName,
      last_name: wizard.adminLastName,
      email: wizard.adminEmail,
      email_confirmation: '',
      phone: wizard.adminPhone,
    },
  });
  const [apiError, setApiError] = useState('');
  const [result, setResult] = useState<{ values: Step4Form } | null>(
    wizard.principalCreated
      ? {
          values: {
            first_name: wizard.adminFirstName,
            last_name: wizard.adminLastName,
            email: wizard.adminEmail,
            email_confirmation: wizard.adminEmail,
            phone: wizard.adminPhone,
          },
        }
      : null
  );

  async function onSubmit(values: Step4Form) {
    setApiError('');
    try {
      await saveOnboardingStep(wizard.sessionId, 4, {
        first_name: values.first_name,
        last_name: values.last_name,
        email: values.email,
        email_confirmation: values.email_confirmation,
        ...(values.phone ? { phone: values.phone } : {}),
      });
      setResult({ values });
    } catch (err: unknown) {
      showSaveError(err, setError, setApiError, 'Failed to create principal account', {}, ['first_name', 'last_name', 'email', 'email_confirmation', 'phone']);
    }
  }

  function handleContinue() {
    if (!result) return;
    onNext({
      adminFirstName: result.values.first_name,
      adminLastName: result.values.last_name,
      adminEmail: result.values.email,
      adminPhone: result.values.phone ?? '',
      principalCreated: true,
    });
  }

  if (result) {
    return (
      <div className="space-y-4">
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 space-y-1">
          <p className="text-sm font-semibold text-green-800">Principal account created for {result.values.email}</p>
          <p className="text-sm text-green-700">There is no password to pass on. When you complete onboarding, the principal is emailed a link to set their own. Nobody else, you included, ever sees it.</p>
        </div>
        <div className="flex justify-between pt-2">
          <button type="button" onClick={onBack} className={backButtonClass}>Back</button>
          <button type="button" onClick={handleContinue} className={nextButtonClass}>Next</button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="First Name" error={errors.first_name?.message}>
          <input {...register('first_name')} className={inputClass} />
        </Field>
        <Field label="Last Name" error={errors.last_name?.message}>
          <input {...register('last_name')} className={inputClass} />
        </Field>
      </div>
      <Field label="Email" error={errors.email?.message}>
        <input {...register('email')} type="email" autoComplete="off" className={inputClass} />
      </Field>
      <Field label="Type the email again" error={errors.email_confirmation?.message}>
        <input {...register('email_confirmation')} type="email" autoComplete="off" onPaste={(e) => e.preventDefault()} className={inputClass} />
      </Field>
      <Field label="Phone (optional)" error={errors.phone?.message}>
        <input {...register('phone')} className={inputClass} />
      </Field>
      {apiError && <ErrorBox message={apiError} />}
      <div className="flex justify-between pt-2">
        <button type="button" onClick={onBack} className={backButtonClass}>Back</button>
        <button type="submit" disabled={isSubmitting} className={nextButtonClass}>{isSubmitting ? 'Creating…' : 'Next'}</button>
      </div>
    </form>
  );
}

// ── Step 5: Review ───────────────────────────────────────────────────────────

function Step5Review({ wizard, onBack, onComplete }: {
  wizard: WizardState;
  onBack: () => void;
  onComplete: (result: CompleteOnboardingResponse) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [readBack, setReadBack] = useState(false);

  async function handleComplete() {
    if (!acceptedTerms || !readBack) return;
    setSubmitting(true);
    setApiError('');
    try {
      const res = await completeOnboarding(wizard.sessionId, { accepted_legal_terms: true, principal_email_read_back: true });
      onComplete(res);
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to complete onboarding');
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">School</h3>
        <dl className="text-sm space-y-1">
          <div className="flex justify-between"><dt className="text-gray-500">Name</dt><dd className="text-gray-900">{wizard.schoolName}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-500">Email</dt><dd className="text-gray-900">{wizard.schoolEmail}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-500">Address</dt><dd className="text-gray-900">{wizard.address}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-500">Phone</dt><dd className="text-gray-900">{wizard.phone}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-500">Plan</dt><dd className="text-gray-900">Trial (default — change from the Subscriptions page)</dd></div>
        </dl>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Branding</h3>
        <dl className="text-sm space-y-1">
          <div className="flex justify-between"><dt className="text-gray-500">Motto</dt><dd className="text-gray-900">{wizard.motto || '—'}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-500">Primary Colour</dt><dd className="text-gray-900">{wizard.primaryColour}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-500">Admission Prefix</dt><dd className="text-gray-900">{wizard.admissionPrefix}</dd></div>
        </dl>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Academic Session</h3>
        <p className="text-sm text-gray-900 mb-1">{wizard.sessionName}</p>
        <ul className="text-sm text-gray-600 space-y-0.5">
          <li>{wizard.term.name}: {wizard.term.start_date} – {wizard.term.end_date} (current term)</li>
        </ul>
      </div>
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <p className="font-medium">Grading and assessment are set by the principal</p>
        <p className="mt-1">This school starts with no grading scale, pass mark or assessment structure — none is filled in on its behalf. The principal sets them in Settings. Results cannot be published until the grading scale is set.</p>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Principal Account</h3>
        <p className="text-sm text-gray-900">{wizard.adminFirstName} {wizard.adminLastName} ({wizard.adminEmail})</p>
      </div>

      <label className="flex items-start gap-2.5 bg-gray-50 rounded-lg px-4 py-3 cursor-pointer">
        <input
          type="checkbox"
          checked={acceptedTerms}
          onChange={(e) => setAcceptedTerms(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-sm text-gray-700">
          I confirm this school has agreed to Chronix Edu&apos;s{' '}
          <Link href="/legal/terms" target="_blank" className="text-[#2472B4] hover:underline">Terms of Service</Link>,{' '}
          <Link href="/legal/privacy-policy" target="_blank" className="text-[#2472B4] hover:underline">Privacy Policy</Link>,{' '}
          <Link href="/legal/data-processing-agreement" target="_blank" className="text-[#2472B4] hover:underline">Data Processing Agreement</Link>, and{' '}
          <Link href="/legal/acceptable-use" target="_blank" className="text-[#2472B4] hover:underline">Acceptable Use Policy</Link>.
        </span>
      </label>

      <label className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 cursor-pointer">
        <input
          type="checkbox"
          checked={readBack}
          onChange={(e) => setReadBack(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-sm text-gray-700">
          I read this address back to the principal by phone, letter by letter, and they confirmed it is theirs:{' '}
          <strong className="font-mono break-all">{wizard.adminEmail}</strong>
          <span className="block text-xs text-gray-500 mt-1">
            Their set-password link goes to this address and nowhere else. This tick is recorded with your name and the time;
            it is your statement, and the system cannot check it.
          </span>
        </span>
      </label>

      {apiError && <ErrorBox message={apiError} />}
      {(!acceptedTerms || !readBack) && (
        <p className="text-xs text-gray-500">
          To complete onboarding, tick {[!acceptedTerms && 'the agreement confirmation', !readBack && 'that the principal confirmed their email address'].filter(Boolean).join(' and ')}.
        </p>
      )}

      <div className="flex justify-between pt-2">
        <button type="button" onClick={onBack} className={backButtonClass}>Back</button>
        <button type="button" onClick={handleComplete} disabled={submitting || !acceptedTerms || !readBack} className={nextButtonClass}>
          {submitting ? 'Completing…' : 'Complete Onboarding'}
        </button>
      </div>
    </div>
  );
}

// ── Completion screen ────────────────────────────────────────────────────────

function CompletionScreen({ result }: { result: CompleteOnboardingResponse }) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-8 text-center">
      <div className="text-green-600 text-4xl mb-3">✓</div>
      <h2 className="text-xl font-semibold text-gray-900 mb-2">School {result.school_name} is now live!</h2>
      <p className="text-sm text-gray-500 mb-6">{result.message}</p>
      <Link
        href={`/super-admin/schools/${result.school_id}`}
        className="inline-block bg-[#003366] text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-[#002244]"
      >
        View School
      </Link>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OnboardWizardPage() {
  const [step, setStep] = useState(1);
  const [wizard, setWizard] = useState<WizardState>(initialWizardState);
  const [completeResult, setCompleteResult] = useState<CompleteOnboardingResponse | null>(null);

  function goNext(patch: Partial<WizardState>) {
    setWizard((prev) => ({ ...prev, ...patch }));
    setStep((s) => Math.min(STEP_LABELS.length, s + 1));
  }

  function goBack() {
    setStep((s) => Math.max(1, s - 1));
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold text-gray-900 font-heading mb-6">Onboard New School</h1>

      {completeResult ? (
        <CompletionScreen result={completeResult} />
      ) : (
        <>
          <ProgressBar currentStep={step} />
          <div className="bg-white rounded-lg shadow-sm p-6">
            {step === 1 && <Step1Info wizard={wizard} onNext={goNext} />}
            {step === 2 && <Step2Branding wizard={wizard} onNext={goNext} onBack={goBack} />}
            {step === 3 && <Step3Calendar wizard={wizard} onNext={goNext} onBack={goBack} />}
            {step === 4 && <Step4Admin wizard={wizard} onNext={goNext} onBack={goBack} />}
            {step === 5 && <Step5Review wizard={wizard} onBack={goBack} onComplete={setCompleteResult} />}
          </div>
        </>
      )}
    </div>
  );
}
