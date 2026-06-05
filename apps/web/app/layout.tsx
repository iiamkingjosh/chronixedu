import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Chronix Edu',
  description: 'Multi-tenant school management SaaS',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
