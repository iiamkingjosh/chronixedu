import NoReplay from '@/components/NoReplay';

// No session replay on the sign-in pages: a password is typed here, and a reset token arrives in
// the address (SECURITY.md Round 34).
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <NoReplay />
      {children}
    </div>
  );
}
