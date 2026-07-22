import type { Metadata } from "next";
import { IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import {
  productDescription,
  productName,
  productSlogan,
} from "@/lib/brand";
import "./globals.css";

const plex = IBM_Plex_Sans({
  variable: "--font-plex",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://vitriol.co.uk"),
  applicationName: productName,
  title: {
    default: productName,
    template: `%s · ${productName}`,
  },
  description: productDescription,
  keywords: ["learning automation", "local browser automation", "control plane"],
  manifest: "/manifest.webmanifest",
  openGraph: {
    type: "website",
    locale: "en_GB",
    url: "/",
    siteName: productName,
    title: productName,
    description: productSlogan,
  },
  twitter: {
    card: "summary",
    title: productName,
    description: productSlogan,
  },
  robots: {
    index: false,
    follow: false,
  },
  category: "technology",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${plex.variable} ${jetbrains.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <NuqsAdapter>{children}</NuqsAdapter>
      </body>
    </html>
  );
}
