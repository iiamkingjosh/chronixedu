export const metadata = { title: 'Data Processing Agreement — Chronix Edu' };

export default function DataProcessingAgreementPage() {
  return (
    <>
      <h1 className="text-xl font-semibold text-gray-900 font-heading">Data Processing Agreement</h1>
      <p className="text-gray-500 text-xs">Last updated: 22 June 2026</p>

      <p>
        This Data Processing Agreement (&quot;DPA&quot;) is entered into between the subscribing school
        (&quot;School&quot;, acting as Data Controller) and Chronix Technology Limited, a company registered
        in Nigeria at 3 Modupe Odunlami, Lekki, Lagos 101233, Nigeria (&quot;Chronix Edu&quot;, &quot;we&quot;,
        &quot;us&quot;, acting as Data Processor). It forms part of, and is incorporated by reference into,
        our Terms of Service, and governs how Chronix Edu processes personal data on the School&apos;s behalf
        in connection with the Chronix Edu platform (the &quot;Service&quot;).
      </p>
      <p>
        Where the School operates in Nigeria, this DPA is intended to satisfy the data processing
        agreement requirements of the Nigeria Data Protection Act 2023 and the Nigeria Data Protection
        Regulation (NDPR). Where the School has students, parents, or staff in the European Union or
        United Kingdom, this DPA is intended to satisfy the equivalent requirements of the GDPR and UK GDPR.
      </p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">1. Definitions</h2>
      <ul className="list-disc pl-5 space-y-1">
        <li><strong>Personal Data</strong> means any information relating to an identified or identifiable natural person processed by Chronix Edu on the School&apos;s behalf via the Service — including student, parent/guardian, and staff records.</li>
        <li><strong>Processing</strong> has the meaning given under applicable Data Protection Law, including collection, storage, use, disclosure, and deletion.</li>
        <li><strong>Data Protection Law</strong> means the NDPR, the Nigeria Data Protection Act 2023, and, where applicable, the GDPR and UK GDPR.</li>
        <li><strong>Sub-processor</strong> means any third party engaged by Chronix Edu to process Personal Data on the School&apos;s behalf.</li>
        <li><strong>Personal Data Breach</strong> means a breach of security leading to the accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to, Personal Data.</li>
      </ul>

      <h2 className="text-base font-semibold text-gray-900 mt-4">2. Roles of the parties</h2>
      <p>The School is the Data Controller and determines the purposes and means of processing Personal Data within the Service (e.g. which students to register, what data to record). Chronix Edu is the Data Processor and processes Personal Data only on the School&apos;s documented instructions, as set out in this DPA and the Terms of Service, except where otherwise required by applicable law.</p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">3. Scope and nature of processing</h2>
      <p>Chronix Edu processes Personal Data of students, parents/guardians, and staff submitted to the platform by the School, for the duration of the School&apos;s subscription, for the sole purpose of providing the school management Service — including student records, academic results, attendance, fee administration, and communications between staff, parents, and students.</p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">4. Processor obligations</h2>
      <ul className="list-disc pl-5 space-y-1">
        <li>Process Personal Data only on the School&apos;s instructions, except where required by law (in which case we will inform the School unless prohibited from doing so)</li>
        <li>Ensure personnel with access to Personal Data are bound by confidentiality obligations</li>
        <li>Implement the technical and organisational security measures described in Section 7</li>
        <li>Assist the School, at the School&apos;s request, in responding to data subject access, correction, or deletion requests, and in regulatory inquiries</li>
        <li>Notify the School of a Personal Data Breach without undue delay, and in any case within 72 hours of becoming aware of it, including the nature of the breach, categories and approximate number of data subjects affected, and the measures taken or proposed to address it</li>
        <li>Not engage a new Sub-processor without giving the School prior notice and a reasonable opportunity to object (Section 6)</li>
      </ul>

      <h2 className="text-base font-semibold text-gray-900 mt-4">5. School obligations</h2>
      <p>The School warrants that it has a lawful basis to collect and disclose the Personal Data it submits to the Service, that it has provided any required notices to data subjects (students, parents, and staff), and that its instructions to Chronix Edu comply with applicable Data Protection Law.</p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">6. Sub-processors</h2>
      <p>The School authorises Chronix Edu to engage the following Sub-processors, each bound by data protection obligations no less protective than this DPA:</p>
      <ul className="list-disc pl-5 space-y-1">
        <li>Supabase — database hosting and authentication (EU West, Ireland)</li>
        <li>Railway — application hosting</li>
        <li>Cloudflare — content delivery network and network security</li>
        <li>SendGrid — transactional email delivery</li>
        <li>Termii — SMS delivery for notifications</li>
        <li>Paystack and Opay — payment processing</li>
        <li>Sentry — error monitoring (technical/diagnostic data only)</li>
      </ul>
      <p>We remain liable for the acts and omissions of our Sub-processors to the same extent we would be liable if performing their services directly. We will notify Schools of any new Sub-processor by updating this page before granting that Sub-processor access to Personal Data.</p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">7. Security measures</h2>
      <p>Chronix Edu maintains the following technical and organisational measures:</p>
      <ul className="list-disc pl-5 space-y-1">
        <li>Encryption in transit via HTTPS/TLS</li>
        <li>Database row-level security enforcing strict per-school data isolation in a multi-tenant environment</li>
        <li>Role-based access control across staff, parent, and student accounts, enforced on every API route</li>
        <li>Rate limiting and account lockout after repeated failed login attempts</li>
        <li>Structured audit logging of administrative and platform-admin actions</li>
        <li>Security headers (CSP, HSTS, X-Frame-Options) on all responses</li>
        <li>Regular dependency vulnerability scanning (npm audit) in our CI pipeline</li>
      </ul>

      <h2 className="text-base font-semibold text-gray-900 mt-4">8. International transfers</h2>
      <p>Where Personal Data is transferred outside Nigeria (for example, to our database hosted in the EU), Chronix Edu relies on its Sub-processors&apos; standard contractual safeguards to protect that data in transit and at rest, and ensures such transfers are made only to jurisdictions or providers offering an adequate level of protection.</p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">9. Data subject rights</h2>
      <p>Chronix Edu will, taking into account the nature of the processing, provide reasonable assistance to the School in responding to requests from data subjects to exercise their rights (access, correction, deletion, portability) under applicable Data Protection Law. Where a data subject contacts Chronix Edu directly, we will refer the request to the relevant School without undue delay.</p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">10. Audits</h2>
      <p>On reasonable written request, no more than once per year, Chronix Edu will provide the School with information reasonably necessary to demonstrate compliance with this DPA, including summaries of relevant security certifications or audit findings where available.</p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">11. Return or deletion of data</h2>
      <p>On termination of the Service, the School has thirty (30) days to request a complete export of its data in a portable format (CSV or PDF). Chronix Edu will permanently delete the School&apos;s Personal Data from its systems and those of its Sub-processors within ninety (90) days of subscription termination, except where retention is required by applicable law.</p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">12. Liability</h2>
      <p>Each party&apos;s liability arising under or in connection with this DPA is subject to the limitations and exclusions of liability set out in our Terms of Service.</p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">13. Term</h2>
      <p>This DPA takes effect on the date the School begins using the Service and remains in force for as long as Chronix Edu processes Personal Data on the School&apos;s behalf, notwithstanding termination of the underlying subscription.</p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">14. Governing law</h2>
      <p>This DPA is governed by the laws of Nigeria, consistent with the governing law provisions of our Terms of Service.</p>

      <h2 className="text-base font-semibold text-gray-900 mt-4">15. Contact</h2>
      <p>Chronix Technology Limited</p>
      <p>7 Jerry Iriabe St, Lekki, Lagos 105102, Nigeria</p>
      <p>Phone: (+234) 810 185 4402</p>
      <p>
        Email:{' '}
        <a href="mailto:info@chronixtechnology.com" className="text-[#2472B4] hover:underline">info@chronixtechnology.com</a>
      </p>

      <p className="text-xs text-gray-400 italic mt-6">
        This DPA was drafted to reflect our current practices and has not yet been reviewed by external legal
        counsel. It will be updated following that review.
      </p>
    </>
  );
}
