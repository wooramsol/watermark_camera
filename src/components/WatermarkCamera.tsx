"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MIN_PIXELS, embed, verify, type VerifyResult } from "@/lib/watermark";

const MAX_PIXELS = 16_000_000; // iOS Safari refuses canvases much larger than ~16.7 MP
const FRESH_MS = 10 * 60 * 1000; // a photo straight from the camera has a just-now timestamp

const L = {
  ko: {
    title: "워터마크 카메라",
    lead: "이 앱으로 찍은 사진에는 눈에 보이지 않는 표시가 픽셀 속에 새겨집니다.\n나중에 어떤 사진이든 이 앱으로 찍은 것인지 확인할 수 있어요.",
    shoot: "촬영하기",
    check: "사진 확인하기",
    working: "워터마크 넣는 중…",
    checking: "확인하는 중…",
    saveIos: "앨범에 저장",
    saveIosHint: "공유 창에서 ‘이미지 저장’을 누르면 사진 앨범에 들어갑니다.",
    savedAndroid: "앨범에 저장했어요. (갤러리 › Download)",
    saveAgain: "다시 저장",
    again: "다시 촬영",
    home: "처음으로",
    notFresh: "카메라로 방금 찍은 사진만 워터마크를 넣을 수 있어요. [촬영하기]로 다시 찍어 주세요.",
    tooSmall: "사진이 너무 작아 워터마크를 넣을 수 없어요.",
    loadFail: "사진을 읽지 못했어요.",
    yes: "이 앱으로 찍은 사진입니다",
    no: "이 앱으로 찍은 사진이 아닙니다",
    noHint: "자르거나 크기를 줄인 사진, 메신저로 전송하며 줄어든 사진은 확인되지 않을 수 있어요.",
    at: "촬영 시각",
    state: "상태",
    original: "원본 그대로",
    copy: "압축·재저장된 사본",
  },
  en: {
    title: "Watermark Camera",
    lead: "Photos taken with this app carry an invisible mark inside their pixels.\nLater you can check whether any photo was taken with this app.",
    shoot: "Take photo",
    check: "Check a photo",
    working: "Adding watermark…",
    checking: "Checking…",
    saveIos: "Save to Photos",
    saveIosHint: "Tap “Save Image” in the share sheet to put it in your photo library.",
    savedAndroid: "Saved to your gallery (Gallery › Download).",
    saveAgain: "Save again",
    again: "Take another",
    home: "Back",
    notFresh: "Only a photo just taken with the camera can be watermarked. Use “Take photo” again.",
    tooSmall: "The photo is too small to carry a watermark.",
    loadFail: "Couldn't read the photo.",
    yes: "Taken with this app",
    no: "Not taken with this app",
    noHint: "Cropped or resized photos (including ones shrunk by messengers) may not be recognized.",
    at: "Taken at",
    state: "State",
    original: "Untouched original",
    copy: "Compressed / re-saved copy",
  },
};

type Locale = keyof typeof L;
const noop = () => () => {};
/** Browser language on the client, Korean on the server (so hydration matches the server HTML first). */
const browserLocale = (): Locale => (navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en");

type Shot = { url: string; file: File; saved: boolean };
type View = { kind: "home" } | { kind: "shot"; shot: Shot } | { kind: "check"; res: VerifyResult; url: string };

const isAndroid = () => /android/i.test(navigator.userAgent);
const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const ctx2d = (c: HTMLCanvasElement) =>
  c.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" }) as CanvasRenderingContext2D;

/** Android: a download lands in the Download folder, which the gallery app shows as an album. */
function download(shot: Shot) {
  const a = document.createElement("a");
  a.href = shot.url;
  a.download = shot.file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** iOS: the share sheet's “Save Image” writes straight into Photos. Resolves false if it couldn't open. */
async function shareToPhotos(shot: Shot) {
  if (!navigator.canShare?.({ files: [shot.file] })) return false;
  try {
    await navigator.share({ files: [shot.file] });
    return true;
  } catch {
    return false; // no user activation left after processing, or the user closed the sheet
  }
}

export default function WatermarkCamera() {
  const auto = useSyncExternalStore(noop, browserLocale, (): Locale => "ko");
  const [picked, setPicked] = useState<Locale | null>(null);
  const locale = picked ?? auto;
  const t = L[locale];
  const [view, setView] = useState<View>({ kind: "home" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const viewUrl = view.kind === "shot" ? view.shot.url : view.kind === "check" ? view.url : null;
  useEffect(
    () => () => {
      if (viewUrl) URL.revokeObjectURL(viewUrl);
    },
    [viewUrl],
  );

  const shoot = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    // Browsers that ignore `capture` may offer the gallery; only accept a photo taken just now.
    if (f.lastModified && Date.now() - f.lastModified > FRESH_MS) {
      setError(t.notFresh);
      return;
    }
    const when = new Date();
    setBusy(t.working);
    await nextFrame();
    try {
      const bmp = await createImageBitmap(f); // applies EXIF orientation
      const s = Math.min(1, Math.sqrt(MAX_PIXELS / (bmp.width * bmp.height)));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s);
      c.height = Math.round(bmp.height * s);
      if (c.width * c.height < MIN_PIXELS) throw new Error(t.tooSmall);
      const g = ctx2d(c);
      g.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      const img = g.getImageData(0, 0, c.width, c.height);
      embed(img, when);
      g.putImageData(img, 0, 0);
      // PNG keeps every pixel exactly, so the pixel layer survives in the album.
      const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error())), "image/png"));
      const file = new File([blob], `WMC_${stamp(when)}.png`, { type: "image/png" });
      const shot: Shot = { url: URL.createObjectURL(blob), file, saved: false };
      if (isAndroid()) {
        download(shot);
        shot.saved = true;
      } else {
        shot.saved = await shareToPhotos(shot); // usually needs a fresh tap on iOS → falls back to the button
      }
      setView({ kind: "shot", shot });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t.loadFail);
    } finally {
      setBusy(null);
    }
  };

  const runCheck = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    setBusy(t.checking);
    await nextFrame();
    try {
      // No colour conversion / premultiplication: the stored pixel values are needed bit-for-bit.
      const bmp = await createImageBitmap(f, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const g = ctx2d(c);
      g.drawImage(bmp, 0, 0);
      bmp.close();
      const res = verify(g.getImageData(0, 0, c.width, c.height));
      setView({ kind: "check", res, url: URL.createObjectURL(f) });
    } catch {
      setError(t.loadFail);
    } finally {
      setBusy(null);
    }
  };

  const save = async (shot: Shot) => {
    if (isAndroid()) download(shot);
    else if (!(await shareToPhotos(shot))) download(shot); // desktop / browsers without file sharing
  };

  const fmtTime = (d: Date) =>
    d.toLocaleString(locale === "ko" ? "ko-KR" : "en-US", { dateStyle: "medium", timeStyle: "medium" });

  const btn = "flex w-full items-center justify-center rounded-2xl px-4 font-bold transition active:scale-[0.98]";
  const primary = `${btn} bg-slate-900 py-4 text-base text-white`;
  const ghost = `${btn} border border-slate-300 bg-white py-3.5 text-sm text-slate-700`;

  const cameraInput = (
    <input
      ref={cameraRef}
      type="file"
      accept="image/*"
      capture="environment"
      className="hidden"
      onChange={(e) => {
        shoot(e.target.files?.[0]);
        e.target.value = "";
      }}
    />
  );
  const checkButton = (label: string, cls: string) => (
    <label className={`${cls} cursor-pointer`}>
      {label}
      <input
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          runCheck(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </label>
  );

  return (
    <section className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pt-8 pb-10">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-3xl font-black tracking-tight">{t.title}</h1>
        <div className="flex shrink-0 rounded-lg border border-slate-200 bg-white p-0.5 text-xs font-bold">
          {(["ko", "en"] as const).map((l) => (
            <button
              key={l}
              onClick={() => setPicked(l)}
              className={`rounded-md px-2.5 py-1 ${locale === l ? "bg-slate-900 text-white" : "text-slate-500"}`}
            >
              {l === "ko" ? "한" : "EN"}
            </button>
          ))}
        </div>
      </div>
      {cameraInput}

      {view.kind === "home" && (
        <>
          <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-slate-600">{t.lead}</p>
          <div className="mt-auto space-y-3 pt-10">
            <button onClick={() => cameraRef.current?.click()} disabled={!!busy} className={`${primary} gap-2 py-6 text-lg`}>
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                <path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              {t.shoot}
            </button>
            {!busy && checkButton(t.check, ghost)}
          </div>
        </>
      )}

      {view.kind === "shot" && (
        <div className="mt-5 flex flex-1 flex-col">
          {/* eslint-disable-next-line @next/next/no-img-element -- blob URL; plain <img> so long-press save works */}
          <img src={view.shot.url} alt="" className="w-full rounded-2xl border border-slate-200 [-webkit-touch-callout:default]" />
          {view.shot.saved ? (
            <p className="mt-3 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm font-bold text-emerald-800">
              ✓ {isAndroid() ? t.savedAndroid : t.saveIosHint}
            </p>
          ) : (
            <p className="mt-3 text-xs text-slate-500">{t.saveIosHint}</p>
          )}
          <div className="mt-auto space-y-3 pt-6">
            <button onClick={() => save(view.shot)} className={view.shot.saved ? ghost : primary}>
              {view.shot.saved ? t.saveAgain : t.saveIos}
            </button>
            <button onClick={() => cameraRef.current?.click()} className={view.shot.saved ? primary : ghost}>
              {t.again}
            </button>
            <button onClick={() => setView({ kind: "home" })} className="w-full py-2 text-sm text-slate-500">
              {t.home}
            </button>
          </div>
        </div>
      )}

      {view.kind === "check" && (
        <div className="mt-5 flex flex-1 flex-col">
          {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
          <img src={view.url} alt="" className="max-h-[45dvh] w-full rounded-2xl border border-slate-200 object-contain" />
          <Verdict res={view.res} t={t} fmt={fmtTime} />
          <div className="mt-auto space-y-3 pt-6">
            {checkButton(t.check, primary)}
            <button onClick={() => setView({ kind: "home" })} className="w-full py-2 text-sm text-slate-500">
              {t.home}
            </button>
          </div>
        </div>
      )}

      {busy && <p className="mt-6 animate-pulse text-center text-sm font-bold text-slate-600">{busy}</p>}
      {error && <p className="mt-4 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</p>}
    </section>
  );
}

function Verdict({ res, t, fmt }: { res: VerifyResult; t: (typeof L)["ko"]; fmt: (d: Date) => string }) {
  const hit = res.pixel ?? res.robust;
  // A JPEG copy can still leak enough low bits for a majority vote, but only the untouched file agrees ~100%.
  const original = !!res.pixel && res.pixel.agreement > 0.98;
  if (!hit)
    return (
      <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5">
        <p className="flex items-center gap-2 text-lg font-black">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-slate-400 text-sm text-white">✕</span>
          {t.no}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">{t.noHint}</p>
      </div>
    );
  return (
    <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
      <p className="flex items-center gap-2 text-lg font-black text-emerald-900">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-emerald-600 text-sm text-white">✓</span>
        {t.yes}
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-emerald-900">
        <dt className="text-emerald-700">{t.at}</dt>
        <dd className="font-bold">{fmt(hit.time)}</dd>
        <dt className="text-emerald-700">{t.state}</dt>
        <dd className="font-bold">{original ? t.original : t.copy}</dd>
      </dl>
    </div>
  );
}
