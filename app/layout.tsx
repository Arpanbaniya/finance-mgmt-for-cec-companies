import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
export const metadata: Metadata = { title: { default: "KaamLedger · Finance & workforce", template: "%s · KaamLedger" }, description: "Finance and workforce operations for Nepal. Phase 1 foundation." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className={`dark ${sans.variable} ${mono.variable}`}><body>{children}</body></html>;
}
