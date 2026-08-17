import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppNav } from "@/components/nav/AppNav";
import { ThemeScript } from "@/components/ui/ThemeScript";
import { ToastProvider } from "@/components/ui/Toast";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Study Coach",
  description: "An adaptive AI tutor that builds a model of what you know.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <ThemeScript />
      </head>
      <body className="flex min-h-full flex-col bg-bg text-fg">
        <a
          href="#main-content"
          className="focus-ring sr-only rounded-md bg-surface px-4 py-2 text-sm font-medium text-fg focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
        >
          Skip to content
        </a>
        <ToastProvider>
          <AppNav />
          <main id="main-content" className="flex flex-1 flex-col">
            {children}
          </main>
        </ToastProvider>
      </body>
    </html>
  );
}
