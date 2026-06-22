export const metadata = { title: 'Acceptable Use Policy — Chronix Edu' };

export default function AcceptableUsePolicyPage() {
  return (
    <>
      <h1 className="text-xl font-semibold text-gray-900 font-heading">Acceptable Use Policy</h1>
      <p className="text-gray-500 text-xs">Last updated: 22 June 2026</p>

      <p>
        This Acceptable Use Policy (&quot;AUP&quot;) applies to all schools, staff, parents, and students
        using the Chronix Edu platform (the &quot;Service&quot;), and is incorporated by reference into our{' '}
        <a href="/legal/terms" className="text-[#2472B4] hover:underline">Terms of Service</a>. This AUP
        supplements, and should be read together with, Section 6 (Prohibited Activities) and Section 24
        (Restrictions on Use) of the Terms of Service; where any provision conflicts, the more restrictive
        provision applies.
      </p>
      <p>
        Only the subscribing school (&quot;School&quot;) is a contracting party to the Terms of Service.
        Staff, parents, and students who use the Service under a School&apos;s account are bound by this AUP
        as a condition of access, but are not thereby made a party to the Terms of Service itself — including
        its dispute resolution and arbitration provisions, which remain between Chronix Technology Limited and
        the School only. Violations by an individual user are addressed through suspension or removal of that
        user&apos;s access, at the request of the School or at Chronix Edu&apos;s own initiative where
        necessary to protect the security of the Service or other users.
      </p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">You agree not to:</h2>
      <ul className="list-disc pl-5 space-y-1">
        <li>Share your login credentials with anyone else, or use another person&apos;s account</li>
        <li>Attempt to access data belonging to another school, or another user, without authorisation</li>
        <li>Scrape, reverse engineer, decompile, or attempt to bypass the platform&apos;s security controls</li>
        <li>Upload content that is unlawful, defamatory, harassing, or that infringes a third party&apos;s rights</li>
        <li>Use the Service to store or process data unrelated to legitimate school administration</li>
        <li>Interfere with or disrupt the Service, including through excessive automated requests</li>
        <li>Use the Service to send unsolicited bulk communications (spam)</li>
        <li>Enter false, misleading, or fraudulent student or financial records into the platform</li>
      </ul>

      <h2 className="text-base font-semibold text-gray-900 mt-4">Account security</h2>
      <p>You are responsible for maintaining the confidentiality of your password and for any activity that occurs under your account. Notify us immediately at the contact below if you suspect unauthorised access.</p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">Enforcement</h2>
      <p>
        Violations of this policy may result in a warning, suspension, or termination of access, at Chronix
        Edu&apos;s discretion, depending on the severity and frequency of the violation. Where a violation
        results in suspension or termination of a School&apos;s account, no refund of fees already paid will
        be issued, consistent with Section 24 of our Terms of Service.
      </p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">Reporting violations</h2>
      <p>
        To report a suspected violation of this policy, contact{' '}
        <a href="mailto:info@chronixtechnology.com" className="text-[#2472B4] hover:underline">info@chronixtechnology.com</a>.
      </p>

      <p className="text-xs text-gray-400 italic mt-6">
        This policy was drafted to reflect our current practices and has not yet been reviewed by external
        legal counsel. It will be updated following that review.
      </p>
    </>
  );
}
