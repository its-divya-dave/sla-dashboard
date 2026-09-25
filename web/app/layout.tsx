import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SLA Monitoring Dashboard",
  description: "Upload health-check logs and review availability against a 99.9% SLA.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
