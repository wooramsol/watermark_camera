import type { Metadata, Viewport } from "next";
import "./globals.css";

const title = "NoFakeCam 위조방지 카메라 — AI 조작 걱정 없는 진짜 사진 인증";
const description =
  "찍는 순간 눈에 보이지 않는 무늬를 사진에 새겨, 카톡·문자로 보내거나 잘라도 진짜 사진인지 확인하는 조작 검증 카메라. 중고거래 실물 인증, 현장·사고 사진, 인증샷에. 사진은 저장되지 않고 휴대폰 안에서만 처리됩니다.";

export const metadata: Metadata = {
  title,
  description,
  applicationName: "NoFakeCam",
  keywords: ["위조방지 카메라", "NoFakeCam", "사진 조작 확인", "조작 검증", "AI 사진 조작", "진짜 사진 인증", "인증샷", "실물 인증", "보이지 않는 워터마크"],
  appleWebApp: { title: "NoFakeCam", capable: true },
  openGraph: { type: "website", locale: "ko_KR", siteName: "NoFakeCam 위조방지 카메라", title, description },
};

export const viewport: Viewport = { themeColor: "#0f172a", viewportFit: "cover" };

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
