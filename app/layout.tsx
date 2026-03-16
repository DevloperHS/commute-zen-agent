import type {Metadata} from 'next';
import { Inter, Cormorant_Garamond } from 'next/font/google';
import './globals.css'; // Global styles
import { ErrorBoundary } from '../components/ErrorBoundary';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
});

const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-serif',
});

export const metadata: Metadata = {
  title: 'Commute Zen',
  description: 'Personalized audio summaries of news articles for your commute.',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={`${inter.variable} ${cormorant.variable}`} suppressHydrationWarning>
      <body className="font-sans antialiased bg-[#f5f5f0]" suppressHydrationWarning>
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
      </body>
    </html>
  );
}
