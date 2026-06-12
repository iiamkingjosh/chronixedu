'use client';

import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useDropzone } from 'react-dropzone';
import { useAuth } from '@/app/providers';
import { apiFetch, apiUpload } from '@/lib/api';

// ── Schema ────────────────────────────────────────────────────────────────────

const schema = z.object({
  name:           z.string().min(1, 'School name is required'),
  motto:          z.string().max(500).optional().or(z.literal('')),
  address:        z.string().optional().or(z.literal('')),
  primary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour'),
});

type FormValues = z.infer<typeof schema>;

// ── Toast helper ──────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };
  return { toast, show };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function IdentityPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();
  const [logoUrl, setLogoUrl]         = useState<string | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);

  const { register, handleSubmit, watch, reset, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', motto: '', address: '', primary_colour: '#1a5c1a' },
  });

  const primaryColour = watch('primary_colour');

  // Load current school data
  useEffect(() => {
    if (!schoolId) return;
    apiFetch<{ success: boolean; data: { name: string; identity_config: Record<string, string> } }>(
      `/api/schools/${schoolId}`
    )
      .then(({ data }) => {
        const ic = data.identity_config ?? {};
        reset({
          name:           data.name ?? '',
          motto:          ic.motto          ?? '',
          address:        ic.address        ?? '',
          primary_colour: ic.primary_colour ?? '#1a5c1a',
        });
        setLogoUrl(ic.logo_url ?? null);
      })
      .catch(() => show('Failed to load school settings', 'error'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  // Logo drag-and-drop
  const onDrop = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file || !schoolId) return;
    setLogoPreview(URL.createObjectURL(file));
    setLogoUploading(true);
    try {
      const fd = new FormData();
      fd.append('logo', file);
      const res = await apiUpload<{ success: boolean; data: { logo_url: string } }>(
        `/api/schools/${schoolId}/logo`,
        fd
      );
      setLogoUrl(res.data.logo_url);
      show('Logo uploaded');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Logo upload failed', 'error');
      setLogoPreview(null);
    } finally {
      setLogoUploading(false);
    }
  }, [schoolId, show]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/jpeg': [], 'image/png': [], 'image/webp': [] },
    maxFiles: 1,
    maxSize: 2 * 1024 * 1024,
  });

  // Form submit
  async function onSubmit(values: FormValues) {
    if (!schoolId) return;
    setSaving(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/identity`, {
        method: 'PATCH',
        body: JSON.stringify({
          name:           values.name,
          motto:          values.motto || undefined,
          primary_colour: values.primary_colour,
        }),
      });
      show('Settings saved');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-64">
        <div className="text-gray-500 text-sm">Loading…</div>
      </div>
    );
  }

  const displayLogo = logoPreview ?? logoUrl;

  return (
    <div className="max-w-2xl mx-auto p-8">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white transition-all ${
            toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
          }`}
        >
          {toast.message}
        </div>
      )}

      <h1 className="text-xl font-semibold text-gray-900 mb-1">School Identity</h1>
      <p className="text-sm text-gray-500 mb-8">Branding, name and contact information</p>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-8">

        {/* Basic info */}
        <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Basic Info</h2>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">School Name</label>
            <input
              {...register('name')}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              placeholder="e.g. Lagos Grammar School"
            />
            {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name.message}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Motto</label>
            <input
              {...register('motto')}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              placeholder="e.g. Excellence in Education"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
            <input
              {...register('address')}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              placeholder="e.g. 12 Victoria Island, Lagos"
            />
          </div>
        </section>

        {/* Logo */}
        <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">School Logo</h2>

          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
              isDragActive
                ? 'border-slate-500 bg-slate-50'
                : 'border-gray-300 hover:border-gray-400'
            }`}
          >
            <input {...getInputProps()} />
            {displayLogo ? (
              <div className="flex flex-col items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={displayLogo} alt="Logo preview" className="h-24 w-24 object-contain rounded" />
                <p className="text-xs text-gray-500">
                  {logoUploading ? 'Uploading…' : 'Drop a new image to replace'}
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
                  {isDragActive ? 'Drop image here' : 'Drag & drop your logo, or click to browse'}
                </p>
                <p className="text-xs text-gray-400">PNG, JPG, WEBP · max 2 MB</p>
              </div>
            )}
          </div>
        </section>

        {/* Colour */}
        <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Primary Colour</h2>

          <div className="flex items-center gap-4">
            <input
              type="color"
              {...register('primary_colour')}
              className="h-10 w-14 rounded-lg cursor-pointer border border-gray-300 p-0.5"
            />
            <span className="text-sm font-mono text-gray-600">{primaryColour}</span>
          </div>
          {errors.primary_colour && (
            <p className="text-xs text-red-600">{errors.primary_colour.message}</p>
          )}

          {/* Live nav bar preview */}
          <div className="mt-4 overflow-hidden rounded-xl border border-gray-200">
            <div
              className="px-4 py-3 flex items-center gap-3"
              style={{ backgroundColor: primaryColour }}
            >
              {displayLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={displayLogo} alt="" className="h-6 w-6 object-contain rounded" />
              ) : (
                <div className="h-6 w-6 rounded bg-white/20" />
              )}
              <span className="text-white text-sm font-semibold tracking-wide">Chronix Edu</span>
              <div className="ml-auto flex items-center gap-3">
                <div className="h-2 w-16 rounded-full bg-white/30" />
                <div className="h-2 w-12 rounded-full bg-white/30" />
                <div className="h-7 w-7 rounded-full bg-white/20" />
              </div>
            </div>
            <div className="px-4 py-2 bg-white border-t border-gray-100 flex gap-4">
              {['Dashboard', 'Students', 'Results', 'Settings'].map(tab => (
                <span key={tab} className="text-xs text-gray-500">{tab}</span>
              ))}
            </div>
          </div>
          <p className="text-xs text-gray-400">Live preview of how the portal navigation will appear</p>
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
