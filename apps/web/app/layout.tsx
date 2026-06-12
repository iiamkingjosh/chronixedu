import type { Metadata, Viewport } from 'next';
import { AuthProvider } from './providers';
import { SyncStatusProvider } from '@/lib/syncStatus';
import PwaRegister from '@/components/PwaRegister';
import './globals.css';

export const metadata: Metadata = {
  title: 'Chronix Edu',
  description: 'Multi-tenant school management SaaS',
  manifest: '/manifest.json',
  icons: { icon: '/icons/icon.svg', apple: '/icons/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#003366',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
