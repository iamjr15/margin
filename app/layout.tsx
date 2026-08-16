import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Margin — evidence-first paper review",
  description: "Parse, review, revise, and export a research paper without losing its citations.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><a className="skip-link" href="#main-content">Skip to main content</a>{children}</body>
    </html>
  );
}
