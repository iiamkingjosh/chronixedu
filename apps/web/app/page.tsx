import type { Metadata } from 'next';
import HomePage from './home-page';

export const metadata: Metadata = {
  title: 'Chronix Edu — School Management for Nigerian Schools',
  description:
    'Results, attendance, fees, and parent communication — one login. Built for Nigerian private schools. Try Chronix Edu free.',
  openGraph: {
    title: 'Chronix Edu — Run your school smarter, not harder.',
    description:
      'The all-in-one school management platform built for Nigerian schools. Attendance, results, fees, and parent messaging in one place.',
    url: 'https://edu.chronixtechnology.com',
    siteName: 'Chronix Edu',
    type: 'website',
  },
};

export default function Page() {
  return <HomePage />;
}
