import Link from 'next/link';

export const metadata = { title: 'Legal — Chronix Edu' };

export default function LegalIndexPage() {
  return (
    <>
      <h1 className="text-xl font-semibold text-gray-900 font-heading">Legal</h1>
      <p>The documents governing your school&apos;s use of Chronix Edu:</p>
      <ul className="list-disc pl-5 space-y-1">
        <li><Link href="/legal/terms" className="text-[#2472B4] hover:underline">Terms of Service</Link></li>
        <li><Link href="/legal/privacy-policy" className="text-[#2472B4] hover:underline">Privacy Policy</Link></li>
        <li><Link href="/legal/cookie-policy" className="text-[#2472B4] hover:underline">Cookie Policy</Link></li>
        <li><Link href="/legal/data-processing-agreement" className="text-[#2472B4] hover:underline">Data Processing Agreement</Link></li>
        <li><Link href="/legal/acceptable-use" className="text-[#2472B4] hover:underline">Acceptable Use Policy</Link></li>
      </ul>
    </>
  );
}
