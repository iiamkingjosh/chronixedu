'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  startOnboarding,
  saveOnboardingStep,
  completeOnboarding,
  type CompleteOnboardingResponse,
} from '@/lib/superAdminApi';

// ── Shared UI helpers ────────────────────────────────────────────────────────

const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400';
const nextButtonClass = 'bg-[#003366] text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-[#002244] disabled:opacity-50';
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

interface GradeInput {
  label: string;
  min: number;
  max: number;
  remark: string;
}

interface ComponentInput {
  name: string;
  max_score: number;
  weight_percent: number;
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
  terms: TermInput[];
  grades: GradeInput[];
  components: ComponentInput[];
  adminFirstName: string;
  adminLastName: string;
  adminEmail: string;
  adminPhone: string;
  tempPassword: string | null;
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
  terms: [
    { name: 'First Term', start_date: '', end_date: '' },
    { name: 'Second Term', start_date: '', end_date: '' },
    { name: 'Third Term', start_date: '', end_date: '' },
  ],
  grades: [
    { label: 'A', min: 70, max: 100, remark: 'Excellent' },
    { label: 'B', min: 60, max: 69, remark: 'Very Good' },
    { label: 'C', min: 50, max: 59, remark: 'Good' },
    { label: 'D', min: 40, max: 49, remark: 'Pass' },
    { label: 'F', min: 0, max: 39, remark: 'Fail' },
  ],
  components: [
    { name: 'CA1', max_score: 10, weight_percent: 10 },
    { name: 'CA2', max_score: 10, weight_percent: 10 },
    { name: 'Mid-Term', max_score: 10, weight_percent: 10 },
    { name: 'Exam', max_score: 70, weight_percent: 70 },
  ],
  adminFirstName: '',
  adminLastName: '',
  adminEmail: '',
  adminPhone: '',
  tempPassword: null,
};

const STEP_LABELS = ['Info', 'Branding', 'Calendar', 'Grading', 'Assessment', 'Admin', 'Review'];

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
  school_name: z.string().min(1, 'School name is required'),
  school_email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
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
      const res = await startOnboarding(values);
      setSessionId(res.session_id);
      setSchoolId(res.school_id);
      setSchoolName(values.school_name);
      setSchoolEmail(values.school_email);
      setPhase('details');
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to start onboarding');
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
      setApiError(err instanceof Error ? err.message : 'Failed to save school details');
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
        {apiError && <ErrorBox message={apiError} />}
        <div className="flex justify-between pt-2">
          <button type="button" disabled className={backButtonClass}>Back</button>
          <button type="submit" disabled={!createForm.formState.isValid || createForm.formState.isSubmitting} className={nextButtonClass}>
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
        <button type="submit" disabled={!detailsForm.formState.isValid || detailsForm.formState.isSubmitting} className={nextButtonClass}>
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
  const { register, handleSubmit, watch, formState: { errors, isValid, isSubmitting } } = useForm<Step2Form>({
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
      setApiError(err instanceof Error ? err.message : 'Failed to save branding');
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
        <button type="submit" disabled={!isValid || isSubmitting} className={nextButtonClass}>{isSubmitting ? 'Saving…' : 'Next'}</button>
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

const step3Schema = z.object({
  session_name: z.string().min(1, 'Required'),
  terms: z.array(termSchema).length(3),
});
type Step3Form = z.infer<typeof step3Schema>;

function Step3Calendar({ wizard, onNext, onBack }: { wizard: WizardState; onNext: (patch: Partial<WizardState>) => void; onBack: () => void }) {
  const { register, handleSubmit, formState: { errors, isValid, isSubmitting } } = useForm<Step3Form>({
    resolver: zodResolver(step3Schema),
    mode: 'onChange',
    defaultValues: { session_name: wizard.sessionName, terms: wizard.terms },
  });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: Step3Form) {
    setApiError('');
    try {
      await saveOnboardingStep(wizard.sessionId, 3, values);
      onNext({ sessionName: values.session_name, terms: values.terms });
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to save academic calendar');
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Field label="Session Name" error={errors.session_name?.message}>
        <input {...register('session_name')} className={inputClass} placeholder="2025/2026" />
      </Field>
      <div className="space-y-3">
        {wizard.terms.map((_, i) => (
          <div key={i} className="grid grid-cols-1 sm:grid-cols-3 gap-3 border border-gray-200 rounded-lg p-3">
            <Field label="Term Name" error={errors.terms?.[i]?.name?.message}>
              <input {...register(`terms.${i}.name`)} className={inputClass} />
            </Field>
            <Field label="Start Date" error={errors.terms?.[i]?.start_date?.message}>
              <input {...register(`terms.${i}.start_date`)} type="date" className={inputClass} />
            </Field>
            <Field label="End Date" error={errors.terms?.[i]?.end_date?.message}>
              <input {...register(`terms.${i}.end_date`)} type="date" className={inputClass} />
            </Field>
          </div>
        ))}
      </div>
      {apiError && <ErrorBox message={apiError} />}
      <div className="flex justify-between pt-2">
        <button type="button" onClick={onBack} className={backButtonClass}>Back</button>
        <button type="submit" disabled={!isValid || isSubmitting} className={nextButtonClass}>{isSubmitting ? 'Saving…' : 'Next'}</button>
      </div>
    </form>
  );
}

// ── Step 4: Grading ──────────────────────────────────────────────────────────

const gradeRowSchema = z.object({
  label: z.string().min(1, 'Required'),
  min: z.coerce.number().min(0, 'Min 0').max(100, 'Max 100'),
  max: z.coerce.number().min(0, 'Min 0').max(100, 'Max 100'),
  remark: z.string().min(1, 'Required'),
});

const step4Schema = z.object({
  grades: z.array(gradeRowSchema).min(1),
});
type Step4FormInput = z.input<typeof step4Schema>;
type Step4FormOutput = z.output<typeof step4Schema>;

function validateGradeCoverage(grades: GradeInput[]): string | null {
  const sorted = [...grades].sort((a, b) => a.min - b.min);
  if (sorted.length === 0) return 'Add at least one grade band';
  if (sorted[0].min !== 0) return 'Grade bands must start at 0';
  if (sorted[sorted.length - 1].max !== 100) return 'Grade bands must end at 100';
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].min !== sorted[i - 1].max + 1) {
      return 'Grade bands must be contiguous, with no gaps or overlaps';
    }
  }
  return null;
}

function Step4Grading({ wizard, onNext, onBack }: { wizard: WizardState; onNext: (patch: Partial<WizardState>) => void; onBack: () => void }) {
  const { register, handleSubmit, control, formState: { errors, isSubmitting } } = useForm<Step4FormInput, unknown, Step4FormOutput>({
    resolver: zodResolver(step4Schema),
    defaultValues: { grades: wizard.grades },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'grades' });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: Step4FormOutput) {
    setApiError('');
    const coverageError = validateGradeCoverage(values.grades);
    if (coverageError) {
      setApiError(coverageError);
      return;
    }
    try {
      await saveOnboardingStep(wizard.sessionId, 4, values);
      onNext({ grades: values.grades });
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to save grading scale');
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="grid grid-cols-[1fr_1fr_1fr_2fr_auto] gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wide px-1">
        <span>Label</span><span>Min</span><span>Max</span><span>Remark</span><span />
      </div>
      <div className="space-y-2">
        {fields.map((field, i) => (
          <div key={field.id} className="grid grid-cols-[1fr_1fr_1fr_2fr_auto] gap-2 items-start">
            <div>
              <input {...register(`grades.${i}.label`)} className={inputClass} />
              {errors.grades?.[i]?.label && <p className="mt-1 text-xs text-red-600">{errors.grades[i]?.label?.message}</p>}
            </div>
            <div>
              <input {...register(`grades.${i}.min`)} type="number" min={0} max={100} className={inputClass} />
              {errors.grades?.[i]?.min && <p className="mt-1 text-xs text-red-600">{errors.grades[i]?.min?.message}</p>}
            </div>
            <div>
              <input {...register(`grades.${i}.max`)} type="number" min={0} max={100} className={inputClass} />
              {errors.grades?.[i]?.max && <p className="mt-1 text-xs text-red-600">{errors.grades[i]?.max?.message}</p>}
            </div>
            <div>
              <input {...register(`grades.${i}.remark`)} className={inputClass} />
              {errors.grades?.[i]?.remark && <p className="mt-1 text-xs text-red-600">{errors.grades[i]?.remark?.message}</p>}
            </div>
            <button type="button" onClick={() => remove(i)} className="text-gray-400 hover:text-red-600 px-2 py-2" aria-label="Remove grade">✕</button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => append({ label: '', min: 0, max: 0, remark: '' })}
        className="text-sm font-medium text-[#003366] hover:underline"
      >
        + Add Grade
      </button>
      {apiError && <ErrorBox message={apiError} />}
      <div className="flex justify-between pt-2">
        <button type="button" onClick={onBack} className={backButtonClass}>Back</button>
        <button type="submit" disabled={isSubmitting} className={nextButtonClass}>{isSubmitting ? 'Saving…' : 'Next'}</button>
      </div>
    </form>
  );
}

// ── Step 5: Assessment ───────────────────────────────────────────────────────

const componentRowSchema = z.object({
  name: z.string().min(1, 'Required'),
  max_score: z.coerce.number().min(0, 'Min 0'),
  weight_percent: z.coerce.number().min(0, 'Min 0').max(100, 'Max 100'),
});

const step5Schema = z.object({
  components: z.array(componentRowSchema).min(1),
});
type Step5FormInput = z.input<typeof step5Schema>;
type Step5FormOutput = z.output<typeof step5Schema>;

function Step5Assessment({ wizard, onNext, onBack }: { wizard: WizardState; onNext: (patch: Partial<WizardState>) => void; onBack: () => void }) {
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<Step5FormInput, unknown, Step5FormOutput>({
    resolver: zodResolver(step5Schema),
    defaultValues: { components: wizard.components },
  });
  const [apiError, setApiError] = useState('');
  const components = watch('components');
  const total = components.reduce((sum, c) => sum + (Number(c.weight_percent) || 0), 0);

  async function onSubmit(values: Step5FormOutput) {
    setApiError('');
    try {
      await saveOnboardingStep(wizard.sessionId, 5, values);
      onNext({ components: values.components });
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to save assessment structure');
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="grid grid-cols-3 gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wide px-1">
        <span>Name</span><span>Max Score</span><span>Weight %</span>
      </div>
      <div className="space-y-2">
        {wizard.components.map((_, i) => (
          <div key={i} className="grid grid-cols-3 gap-2">
            <div>
              <input {...register(`components.${i}.name`)} className={inputClass} />
              {errors.components?.[i]?.name && <p className="mt-1 text-xs text-red-600">{errors.components[i]?.name?.message}</p>}
            </div>
            <div>
              <input {...register(`components.${i}.max_score`)} type="number" min={0} className={inputClass} />
              {errors.components?.[i]?.max_score && <p className="mt-1 text-xs text-red-600">{errors.components[i]?.max_score?.message}</p>}
            </div>
            <div>
              <input {...register(`components.${i}.weight_percent`)} type="number" min={0} max={100} className={inputClass} />
              {errors.components?.[i]?.weight_percent && <p className="mt-1 text-xs text-red-600">{errors.components[i]?.weight_percent?.message}</p>}
            </div>
          </div>
        ))}
      </div>
      <p className={`text-sm font-medium ${total === 100 ? 'text-green-600' : 'text-red-600'}`}>Total: {total}%</p>
      {apiError && <ErrorBox message={apiError} />}
      <div className="flex justify-between pt-2">
        <button type="button" onClick={onBack} className={backButtonClass}>Back</button>
        <button type="submit" disabled={isSubmitting || total !== 100} className={nextButtonClass}>{isSubmitting ? 'Saving…' : 'Next'}</button>
      </div>
    </form>
  );
}

// ── Step 6: Admin ────────────────────────────────────────────────────────────

const step6Schema = z.object({
  first_name: z.string().min(1, 'Required'),
  last_name: z.string().min(1, 'Required'),
  email: z.string().min(1, 'Required').email('Enter a valid email address'),
  phone: z.string().optional(),
});
type Step6Form = z.infer<typeof step6Schema>;

function Step6Admin({ wizard, onNext, onBack }: { wizard: WizardState; onNext: (patch: Partial<WizardState>) => void; onBack: () => void }) {
  const { register, handleSubmit, formState: { errors, isValid, isSubmitting } } = useForm<Step6Form>({
    resolver: zodResolver(step6Schema),
    mode: 'onChange',
    defaultValues: {
      first_name: wizard.adminFirstName,
      last_name: wizard.adminLastName,
      email: wizard.adminEmail,
      phone: wizard.adminPhone,
    },
  });
  const [apiError, setApiError] = useState('');
  const [result, setResult] = useState<{ tempPassword: string; values: Step6Form } | null>(
    wizard.tempPassword
      ? {
          tempPassword: wizard.tempPassword,
          values: {
            first_name: wizard.adminFirstName,
            last_name: wizard.adminLastName,
            email: wizard.adminEmail,
            phone: wizard.adminPhone,
          },
        }
      : null
  );

  async function onSubmit(values: Step6Form) {
    setApiError('');
    try {
      const res = await saveOnboardingStep(wizard.sessionId, 6, {
        first_name: values.first_name,
        last_name: values.last_name,
        email: values.email,
        ...(values.phone ? { phone: values.phone } : {}),
      });
      setResult({ tempPassword: res.temp_password ?? '', values });
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to create principal account');
    }
  }

  function handleContinue() {
    if (!result) return;
    onNext({
      adminFirstName: result.values.first_name,
      adminLastName: result.values.last_name,
      adminEmail: result.values.email,
      adminPhone: result.values.phone ?? '',
      tempPassword: result.tempPassword,
    });
  }

  if (result) {
    return (
      <div className="space-y-4">
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 space-y-1">
          <p className="text-sm font-semibold text-green-800">Principal account created</p>
          <p className="text-sm text-green-700 font-mono">Temporary password: {result.tempPassword}</p>
          <p className="text-xs text-green-600">⚠ Copy this now — it will not be shown again.</p>
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
        <input {...register('email')} type="email" className={inputClass} />
      </Field>
      <Field label="Phone (optional)" error={errors.phone?.message}>
        <input {...register('phone')} className={inputClass} />
      </Field>
      {apiError && <ErrorBox message={apiError} />}
      <div className="flex justify-between pt-2">
        <button type="button" onClick={onBack} className={backButtonClass}>Back</button>
        <button type="submit" disabled={!isValid || isSubmitting} className={nextButtonClass}>{isSubmitting ? 'Creating…' : 'Next'}</button>
      </div>
    </form>
  );
}

// ── Step 7: Review ───────────────────────────────────────────────────────────

function Step7Review({ wizard, onBack, onComplete }: {
  wizard: WizardState;
  onBack: () => void;
  onComplete: (result: CompleteOnboardingResponse) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  async function handleComplete() {
    setSubmitting(true);
    setApiError('');
    try {
      const res = await completeOnboarding(wizard.sessionId);
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
          {wizard.terms.map((t, i) => <li key={i}>{t.name}: {t.start_date} – {t.end_date}</li>)}
        </ul>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Grading Scale</h3>
        <ul className="text-sm text-gray-600 space-y-0.5">
          {wizard.grades.map((g, i) => <li key={i}>{g.label}: {g.min}–{g.max} ({g.remark})</li>)}
        </ul>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Assessment Structure</h3>
        <ul className="text-sm text-gray-600 space-y-0.5">
          {wizard.components.map((c, i) => <li key={i}>{c.name}: {c.max_score} pts ({c.weight_percent}%)</li>)}
        </ul>
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

      {apiError && <ErrorBox message={apiError} />}

      <div className="flex justify-between pt-2">
        <button type="button" onClick={onBack} className={backButtonClass}>Back</button>
        <button type="button" onClick={handleComplete} disabled={submitting || !acceptedTerms} className={nextButtonClass}>
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
            {step === 4 && <Step4Grading wizard={wizard} onNext={goNext} onBack={goBack} />}
            {step === 5 && <Step5Assessment wizard={wizard} onNext={goNext} onBack={goBack} />}
            {step === 6 && <Step6Admin wizard={wizard} onNext={goNext} onBack={goBack} />}
            {step === 7 && <Step7Review wizard={wizard} onBack={goBack} onComplete={setCompleteResult} />}
          </div>
        </>
      )}
    </div>
  );
}
