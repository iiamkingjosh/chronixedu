'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useDropzone } from 'react-dropzone';
import { useAuth } from '@/app/providers';
import { apiFetch, apiUpload, apiFetchBlob } from '@/lib/api';

// ── Schema ────────────────────────────────────────────────────────────────────

const schema = z.object({
  template: z.enum(['classic', 'modern']),
  show_attendance: z.boolean(),
  footer_text: z.string().max(200, 'Must be 200 characters or fewer'),
  next_term_resumption: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a valid date').or(z.literal('')),
});

type FormValues = z.infer<typeof schema>;

interface ReportConfig {
  template?: 'classic' | 'modern';
  show_attendance?: boolean;
  footer_text?: string;
  next_term_resumption?: string | null;
}

const DEFAULT_VALUES: FormValues = {
  template: 'classic',
  show_attendance: true,
  footer_text: '',
  next_term_resumption: '',
};

const TEMPLATES: { value: 'classic' | 'modern'; label: string; description: string; thumbnail: string }[] = [
  { value: 'classic', label: 'Classic', description: 'Traditional bordered layout with green accents', thumbnail: '/report-card-templates/classic.svg' },
  { value: 'modern', label: 'Modern', description: 'Minimalist card-based layout with navy accents', thumbnail: '/report-card-templates/modern.svg' },
];

// ── Toast ─────────────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ReportCardSettingsPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [signatureUrl, setSignatureUrl] = useState<string | null>(null);
  const [signaturePreview, setSignaturePreview] = useState<string | null>(null);
  const [signatureUploading, setSignatureUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewUrlRef = useRef<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    watch,
    getValues,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: DEFAULT_VALUES,
  });

  const footerText = watch('footer_text');
  const selectedTemplate = watch('template');

  // Load existing settings
  useEffect(() => {
    if (!schoolId) return;
    apiFetch<{ success: boolean; data: { identity_config?: Record<string, string>; report_config?: ReportConfig } }>(
      `/api/schools/${schoolId}`
    )
      .then(({ data }) => {
        const rc = data.report_config ?? {};
        reset({
          template: rc.template ?? 'classic',
          show_attendance: rc.show_attendance !== false,
          footer_text: rc.footer_text ?? '',
          next_term_resumption: rc.next_term_resumption ?? '',
        });
        setSignatureUrl(data.identity_config?.signature_url ?? null);
      })
      .catch(() => show('Failed to load report card settings', 'error'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  // Clean up object URLs on unmount
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  // Signature upload
  const onDropSignature = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file || !schoolId) return;
    setSignaturePreview(URL.createObjectURL(file));
    setSignatureUploading(true);
    try {
      const fd = new FormData();
      fd.append('signature', file);
      const res = await apiUpload<{ success: boolean; data: { signature_url: string } }>(
        `/api/schools/${schoolId}/signature`,
        fd
      );
      setSignatureUrl(res.data.signature_url);
      show('Signature uploaded');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Signature upload failed', 'error');
      setSignaturePreview(null);
    } finally {
      setSignatureUploading(false);
    }
  }, [schoolId, show]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: onDropSignature,
    accept: { 'image/jpeg': [], 'image/png': [] },
    maxFiles: 1,
    maxSize: 2 * 1024 * 1024,
  });

  // Save settings
  async function onSubmit(values: FormValues) {
    if (!schoolId) return;
    setSaving(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/report-config`, {
        method: 'PATCH',
        body: JSON.stringify({
          template: values.template,
          show_attendance: values.show_attendance,
          footer_text: values.footer_text,
          next_term_resumption: values.next_term_resumption || null,
        }),
      });
      show('Report card settings saved');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  // Live preview
  async function generatePreview() {
    if (!schoolId) return;
    setPreviewLoading(true);
    try {
      const values = getValues();
      const blob = await apiFetchBlob(`/api/schools/${schoolId}/report-config/preview`, {
        method: 'POST',
        body: JSON.stringify({
          template: values.template,
          show_attendance: values.show_attendance,
          footer_text: values.footer_text,
          next_term_resumption: values.next_term_resumption || null,
        }),
      });
      const url = URL.createObjectURL(blob);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = url;
      setPreviewUrl(url);
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Preview generation failed', 'error');
    } finally {
      setPreviewLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-64">
        <div className="text-gray-500 text-sm">Loading…</div>
      </div>
    );
  }

  const displaySignature = signaturePreview ?? signatureUrl;

  return (
    <div className="max-w-3xl mx-auto p-8">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${
          toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.message}
        </div>
      )}

      <h1 className="text-xl font-semibold text-gray-900 mb-1">Report Card Settings</h1>
      <p className="text-sm text-gray-500 mb-8">Configure report card layout and generation settings</p>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">

        {/* Template selector */}
        <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Template</h2>
          <p className="text-sm text-gray-500">Choose the layout used when generating report cards.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {TEMPLATES.map(t => (
              <label
                key={t.value}
                className={`cursor-pointer rounded-xl border-2 p-3 transition-colors ${
                  selectedTemplate === t.value
                    ? 'border-slate-700 bg-slate-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <input
                  type="radio"
                  value={t.value}
                  className="sr-only"
                  {...register('template')}
                />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={t.thumbnail}
                  alt={`${t.label} template preview`}
                  className="w-full rounded-lg border border-gray-100 mb-3"
                />
                <p className="text-sm font-medium text-gray-900">{t.label}</p>
                <p className="text-xs text-gray-400">{t.description}</p>
              </label>
            ))}
          </div>
        </section>

        {/* Principal signature */}
        <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Principal&apos;s Signature</h2>
          <p className="text-sm text-gray-500">Uploaded as an image and printed above the principal&apos;s signature line.</p>

          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
              isDragActive
                ? 'border-slate-500 bg-slate-50'
                : 'border-gray-300 hover:border-gray-400'
            }`}
          >
            <input {...getInputProps()} />
            {displaySignature ? (
              <div className="flex flex-col items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={displaySignature} alt="Signature preview" className="h-16 object-contain" />
                <p className="text-xs text-gray-500">
                  {signatureUploading ? 'Uploading…' : 'Drop a new image to replace'}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="mx-auto w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
                  <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <p className="text-sm text-gray-600">
                  {isDragActive ? 'Drop image here' : 'Drag & drop a signature image, or click to browse'}
                </p>
                <p className="text-xs text-gray-400">PNG, JPG · max 2 MB</p>
              </div>
            )}
          </div>
        </section>

        {/* Next term resumption */}
        <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Next Term Resumption</h2>
          <p className="text-sm text-gray-500">Shown on the report card as the date school resumes for the next term.</p>
          <input
            type="date"
            {...register('next_term_resumption')}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
          {errors.next_term_resumption && (
            <p className="text-xs text-red-600">{errors.next_term_resumption.message}</p>
          )}
        </section>

        {/* Footer text */}
        <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Custom Footer Text</h2>
          <p className="text-sm text-gray-500">An optional note printed at the bottom of every report card.</p>
          <textarea
            {...register('footer_text')}
            maxLength={200}
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            placeholder="e.g. School resumes for the next term on the date shown above."
          />
          <div className="flex justify-between items-center">
            {errors.footer_text ? (
              <p className="text-xs text-red-600">{errors.footer_text.message}</p>
            ) : <span />}
            <p className="text-xs text-gray-400">{footerText.length}/200</p>
          </div>
        </section>

        {/* Attendance toggle */}
        <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Attendance Summary</h2>
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <p className="text-sm font-medium text-gray-900">Show attendance summary</p>
              <p className="text-xs text-gray-400">Displays days present, absent and attendance percentage on the report card.</p>
            </div>
            <Controller
              control={control}
              name="show_attendance"
              render={({ field: f }) => (
                <input
                  type="checkbox"
                  checked={f.value}
                  onChange={e => f.onChange(e.target.checked)}
                  className="h-5 w-5 rounded border-gray-300 accent-slate-700 cursor-pointer"
                />
              )}
            />
          </label>
        </section>

        {/* Live preview */}
        <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Live Preview</h2>
          <p className="text-sm text-gray-500">
            Generates a sample report card using dummy student data with the settings above and your school&apos;s real branding.
          </p>
          <button
            type="button"
            onClick={generatePreview}
            disabled={previewLoading}
            className="px-4 py-2 bg-white border border-gray-300 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            {previewLoading ? 'Generating…' : 'Generate Preview'}
          </button>

          {previewUrl && (
            <object
              data={previewUrl}
              type="application/pdf"
              className="w-full h-[700px] rounded-lg border border-gray-200"
            >
              <p className="text-sm text-gray-500 p-4">
                Unable to display PDF inline. <a href={previewUrl} target="_blank" rel="noreferrer" className="text-slate-700 underline">Open in a new tab</a>.
              </p>
            </object>
          )}
        </section>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
