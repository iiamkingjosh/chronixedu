import type { Metadata, Viewport } from 'next';
import { Inter, Poppins } from 'next/font/google';
import { AuthProvider } from './providers';
import { SyncStatusProvider } from '@/lib/syncStatus';
import PwaRegister from '@/components/PwaRegister';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-poppins',
  display: 'swap',
});

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Chronix Edu',
  description: 'Multi-tenant school management SaaS',
  manifest: '/manifest.json',
  icons: { icon: '/icons/Chronix_Logo.png', apple: '/icons/Chronix_Logo.png' },
};

export const viewport: Viewport = {
  themeColor: '#003366',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${poppins.variable}`}>
      <body>
        <AuthProvider>
          <SyncStatusProvider>
            <PwaRegister />
            {children}
          </SyncStatusProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
