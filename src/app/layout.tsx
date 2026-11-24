import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "워터마크 카메라",
  description: "찍는 순간 눈에 보이지 않는 워터마크를 사진 픽셀에 새기고, 나중에 확인하세요.",
};

export const viewport: Viewport = { themeColor: "#0f172a" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" className="h-full antialiased">
      <head>
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body className="min-h-full bg-slate-50 text-slate-900">{children}</body>
    </html>
  );
}
