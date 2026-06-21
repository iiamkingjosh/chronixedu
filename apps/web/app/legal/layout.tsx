import Link from 'next/link';

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-[#003366] px-6 py-4">
        <Link href="/login" className="inline-flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/Chronix_Logo.png" alt="Chronix Edu" className="h-8 w-auto" />
        </Link>
      </header>
      <div className="max-w-3xl mx-auto px-6 py-10">
        <nav className="flex flex-wrap gap-4 text-sm text-[#2472B4] mb-8">
          <Link href="/legal/privacy-policy" className="hover:underline">Privacy Policy</Link>
          <Link href="/legal/cookie-policy" className="hover:underline">Cookie Policy</Link>
          <Link href="/legal/terms" className="hover:underline">Terms of Service</Link>
          <Link href="/legal/data-processing-agreement" className="hover:underline">Data Processing Agreement</Link>
          <Link href="/legal/acceptable-use" className="hover:underline">Acceptable Use Policy</Link>
        </nav>
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-sm text-gray-700 leading-relaxed space-y-4">
          {children}
        </div>
      </div>
    </div>
  );
}
