"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";
import { MIN_PIXELS, TILE_CELLS, embed, tileCells, verify, type Evidence, type VerifyResult } from "@/lib/watermark";

const MAX_PIXELS = 16_000_000; // iOS Safari refuses canvases much larger than ~16.7 MP
const FRESH_MS = 10 * 60 * 1000; // a photo straight from the camera has a just-now timestamp

const L = {
  ko: {
    title: "위조방지 카메라",
    tagline: "AI 조작 걱정 없는 진짜 사진 인증",
    lead: "AI로 만든 가짜 사진이 늘고 있어요.\n촬영한 사진은 눈에 보이지 않는 고유 무늬가 새겨져, 조작된 사진인지 바로 확인할 수 있습니다.",
    sampleBadge: "고유 무늬 (확대 표시)",
    sampleTry: "눌러서 견본 검증해보기 →",
    usesTitle: "이럴 때 쓰세요",
    uses: [
      ["중고거래", "실물 인증"],
      ["현장·사고", "증거 사진"],
      ["인증샷", "운동·출근·리뷰"],
    ],
    privacy: "사진은 저장되지 않고 휴대폰 안에서만 처리돼요.",
    shoot: "촬영하기",
    check: "검증하기",
    working: "워터마크 넣는 중…",
    checking: "확인하는 중…",
    saveIos: "앨범에 저장",
    saveIosHint: "공유 창에서 ‘이미지 저장’을 누르면 사진 앨범에 들어갑니다.",
    savedAndroid: "앨범에 저장했어요. (갤러리 › Download)",
    savedApp: "사진 앱에 저장했어요.",
    saveFail: "앨범에 저장하지 못했어요. 설정 › NoFakeCam에서 사진 추가 권한을 허용해 주세요.",
    camFail: "카메라를 열 수 없어요. 설정 › NoFakeCam에서 카메라 권한을 허용해 주세요.",
    close: "닫기",
    flip: "전환",
    saveAgain: "다시 저장",
    again: "다시 촬영",
    home: "처음으로",
    notFresh: "카메라로 방금 찍은 사진만 워터마크를 넣을 수 있어요. [촬영하기]로 다시 찍어 주세요.",
    tooSmall: "사진이 너무 작아 워터마크를 넣을 수 없어요.",
    loadFail: "사진을 읽지 못했어요.",
    yes: "이 앱으로 찍은 사진입니다",
    no: "이 앱으로 찍은 사진이 아닙니다",
    noHint: "아주 작게 줄었거나 일부만 남도록 많이 잘린 사진은 확인되지 않을 수 있어요.",
    at: "촬영 시각",
    timeUnknown: "읽을 수 없음 (사진이 많이 작아짐)",
    state: "상태",
    original: "원본 파일 그대로",
    copy: "전송·편집된 사본",
    coverage: "무늬 확인 영역",
    layer: "근거 표시",
    legendOk: "앱 무늬가 읽힌 곳",
    legendWeak: "무늬가 약하거나 없는 곳 — 아주 밝거나 어두운 곳, 또는 편집된 곳",
    expected: "앱 고유 무늬",
    read: "이 사진에서 읽은 무늬",
    similarity: "일치도",
    compareHint: "사진 전체에 반복된 무늬를 한 칸으로 겹쳐 모은 결과입니다.",
  },
  en: {
    title: "NoFakeCam",
    tagline: "Prove your photo is real — even in the age of AI fakes",
    lead: "AI-made fake photos are on the rise.\nPhotos you take carry a unique invisible pattern, so you can instantly check whether a photo has been tampered with.",
    sampleBadge: "Hidden pattern (magnified)",
    sampleTry: "Tap to verify the sample →",
    usesTitle: "Great for",
    uses: [
      ["Marketplace", "Real item proof"],
      ["Site & accident", "Evidence photos"],
      ["Proof shots", "Workout, work, reviews"],
    ],
    privacy: "Photos are never stored — everything is processed on your phone.",
    shoot: "Take photo",
    check: "Verify",
    working: "Adding watermark…",
    checking: "Checking…",
    saveIos: "Save to Photos",
    saveIosHint: "Tap “Save Image” in the share sheet to put it in your photo library.",
    savedAndroid: "Saved to your gallery (Gallery › Download).",
    savedApp: "Saved to Photos.",
    saveFail: "Couldn't save to Photos. Allow adding photos in Settings › NoFakeCam.",
    camFail: "Couldn't open the camera. Allow camera access in Settings › NoFakeCam.",
    close: "Close",
    flip: "Flip",
    saveAgain: "Save again",
    again: "Take another",
    home: "Back",
    notFresh: "Only a photo just taken with the camera can be watermarked. Use “Take photo” again.",
    tooSmall: "The photo is too small to carry a watermark.",
    loadFail: "Couldn't read the photo.",
    yes: "Taken with this app",
    no: "Not taken with this app",
    noHint: "Photos shrunk to a tiny size or cropped down to a small part may not be recognized.",
    at: "Taken at",
    timeUnknown: "Unreadable (photo shrunk a lot)",
    state: "State",
    original: "Untouched original file",
    copy: "Sent / edited copy",
    coverage: "Pattern found in",
    layer: "Show evidence",
    legendOk: "App pattern read here",
    legendWeak: "Weak or missing — very bright/dark areas, or edited areas",
    expected: "App pattern",
    read: "Read from this photo",
    similarity: "Match",
    compareHint: "Every repeat of the pattern across the photo, stacked into one tile.",
  },
};

type Locale = keyof typeof L;

const SAMPLE_URL = "/sample.jpg"; // CC0 photo (Rachel Michetti, via scikit-image) watermarked by this app
const SAMPLE_TIME = new Date("2026-11-27T05:00:00Z");

const USE_STYLE = ["border-sky-100 bg-sky-50", "border-amber-100 bg-amber-50", "border-emerald-100 bg-emerald-50"];
const noop = () => () => {};
/** Browser language on the client, Korean on the server (so hydration matches the server HTML first). */
const browserLocale = (): Locale => (navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en");

type Shot = { url: string; file: File; saved: boolean };
type View =
  | { kind: "home" }
  | { kind: "camera" }
  | { kind: "shot"; shot: Shot }
  | { kind: "check"; res: VerifyResult; url: string; w: number; h: number };

const isAndroid = () => /android/i.test(navigator.userAgent);
/** True inside the iOS/Android app (Capacitor), false on the web. Server render assumes web. */
const isNative = () => Capacitor.isNativePlatform();

const blobToDataUrl = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });

/** App: write the PNG bytes straight into the photo library (add-only permission, no share sheet). */
async function saveToLibrary(shot: Shot) {
  const { Media } = await import("@capacitor-community/media");
  await Media.savePhoto({ path: await blobToDataUrl(shot.file) });
}
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
  // Each screen starts at the top (the sample is tapped from further down the home screen).
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view.kind, viewUrl]);
  useEffect(
    () => () => {
      if (viewUrl) URL.revokeObjectURL(viewUrl);
    },
    [viewUrl],
  );

  /** Write the watermark into a photo and turn it into a lossless PNG. */
  const watermark = async (src: Blob, when: Date): Promise<Shot> => {
    const bmp = await createImageBitmap(src); // applies EXIF orientation
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
    const file = new File([blob], `NoFakeCam_${stamp(when)}.png`, { type: "image/png" });
    return { url: URL.createObjectURL(blob), file, saved: false };
  };

  /** Save where this platform can: app → photo library, Android web → download, iOS web → share sheet. */
  const deliver = async (shot: Shot) => {
    if (isNative()) {
      try {
        await saveToLibrary(shot);
        shot.saved = true;
      } catch {
        setError(t.saveFail);
      }
    } else if (isAndroid()) {
      download(shot);
      shot.saved = true;
    } else {
      shot.saved = await shareToPhotos(shot); // usually needs a fresh tap on iOS → falls back to the button
    }
  };

  const process = async (src: Blob, when: Date) => {
    setBusy(t.working);
    await nextFrame();
    try {
      const shot = await watermark(src, when);
      await deliver(shot);
      setView({ kind: "shot", shot });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t.loadFail);
      setView({ kind: "home" });
    } finally {
      setBusy(null);
    }
  };

  /** Web: a photo from the phone's camera app (file input with `capture`). */
  const shoot = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    // Browsers that ignore `capture` may offer the gallery; only accept a photo taken just now.
    if (f.lastModified && Date.now() - f.lastModified > FRESH_MS) {
      setError(t.notFresh);
      return;
    }
    await process(f, new Date());
  };

  /** App: our own full-screen camera (no "Use Photo" step); the web uses the phone's camera app. */
  const openCamera = () => {
    setError(null);
    if (isNative()) setView({ kind: "camera" });
    else cameraRef.current?.click();
  };

  /** Verify the bundled sample photo (watermarked with this app) so the check screen can be tried right away. */
  const checkSample = async () => {
    try {
      const blob = await (await fetch(SAMPLE_URL)).blob();
      await runCheck(new File([blob], "NoFakeCam_sample.jpg", { type: blob.type }));
    } catch {
      setError(t.loadFail);
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
      setView({ kind: "check", res, url: URL.createObjectURL(f), w: c.width, h: c.height });
    } catch {
      setError(t.loadFail);
    } finally {
      setBusy(null);
    }
  };

  const save = async (shot: Shot) => {
    if (isNative()) {
      try {
        await saveToLibrary(shot);
      } catch {
        setError(t.saveFail);
      }
    } else if (isAndroid()) download(shot);
    else if (!(await shareToPhotos(shot))) download(shot); // desktop / browsers without file sharing
  };

  const fmtTime = (d: Date) =>
    d.toLocaleString(locale === "ko" ? "ko-KR" : "en-US", { dateStyle: "medium", timeStyle: "short" });

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
    <label className={`${cls} cursor-pointer gap-1.5`}>
      <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </svg>
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
    <section className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pt-6 pb-4 break-keep">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-[26px] font-black tracking-tight min-[375px]:text-3xl">{t.title}</h1>
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

      {view.kind === "camera" && (
        <NativeCamera
          labels={{ shutter: t.shoot, close: t.close, flip: t.flip, working: t.working }}
          busy={!!busy}
          onClose={() => setView({ kind: "home" })}
          onFail={() => {
            setError(t.camFail);
            setView({ kind: "home" });
          }}
          onCapture={(blob, when) => process(blob, when)}
        />
      )}

      {view.kind === "home" && (
        <>
          <p className="mt-2 text-base font-bold text-slate-800">{t.tagline}</p>
          <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-slate-600">{t.lead}</p>
          <button
            onClick={checkSample}
            disabled={!!busy}
            className="mt-4 block w-full overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-sm transition active:scale-[0.99]"
          >
            <SamplePreview badge={t.sampleBadge} cta={t.sampleTry} />
          </button>
          <p className="mt-5 text-xs font-bold text-slate-500">{t.usesTitle}</p>
          <ul className="mt-2 grid grid-cols-3 gap-2">
            {t.uses.map(([h, d], i) => (
              <li key={h} className={`rounded-2xl border p-3 ${USE_STYLE[i]}`}>
                <p className="text-[13px] leading-tight font-bold text-slate-900">{h}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{d}</p>
              </li>
            ))}
          </ul>
          <p className="mt-2 flex items-center gap-1.5 text-xs font-bold text-emerald-700">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            {t.privacy}
          </p>
          {/* Pinned to the bottom so the shutter is on the first screen even on small phones. */}
          <div className="sticky bottom-0 -mx-5 mt-auto grid grid-cols-2 gap-2.5 bg-slate-50/95 px-5 pt-3 pb-4 backdrop-blur">
            <button onClick={openCamera} disabled={!!busy} className={`${primary} gap-1.5`}>
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                <path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              {t.shoot}
            </button>
            {checkButton(t.check, `${ghost} py-4 text-base ${busy ? "pointer-events-none opacity-40" : ""}`)}
          </div>
        </>
      )}

      {view.kind === "shot" && (
        <div className="mt-5 flex flex-1 flex-col">
          {/* eslint-disable-next-line @next/next/no-img-element -- blob URL; plain <img> so long-press save works */}
          <img src={view.shot.url} alt="" className="w-full rounded-2xl border border-slate-200 [-webkit-touch-callout:default]" />
          {view.shot.saved ? (
            <p className="mt-3 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm font-bold text-emerald-800">
              ✓ {isNative() ? t.savedApp : isAndroid() ? t.savedAndroid : t.saveIosHint}
            </p>
          ) : (
            <p className="mt-3 text-xs text-slate-500">{t.saveIosHint}</p>
          )}
          <div className="mt-auto space-y-3 pt-6">
            <button onClick={() => save(view.shot)} className={view.shot.saved ? ghost : primary}>
              {view.shot.saved ? t.saveAgain : t.saveIos}
            </button>
            <button onClick={openCamera} className={view.shot.saved ? primary : ghost}>
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
          <Verdict view={view} t={t} fmt={fmtTime} />
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

type Dict = (typeof L)["ko"];

function Verdict({
  view,
  t,
  fmt,
}: {
  view: Extract<View, { kind: "check" }>;
  t: Dict;
  fmt: (d: Date) => string;
}) {
  const { res } = view;
  const ev = res.evidence;
  const [layer, setLayer] = useState(true);
  return (
    <div>
      <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-100">
        {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
        <img src={view.url} alt="" className="block w-full" />
        {ev && res.found && layer && <Overlay ev={ev} w={view.w} h={view.h} />}
      </div>
      {ev && res.found && (
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="space-y-1 text-[11px] leading-snug text-slate-500">
            <p className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-emerald-500/70" />
              {t.legendOk}
            </p>
            <p className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-rose-500/40" />
              {t.legendWeak}
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-1.5 text-xs font-bold text-slate-600">
            <input type="checkbox" checked={layer} onChange={(e) => setLayer(e.target.checked)} className="accent-emerald-600" />
            {t.layer}
          </label>
        </div>
      )}

      {res.found ? (
        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
          <p className="flex items-center gap-2 text-lg font-black text-emerald-900">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-emerald-600 text-sm text-white">✓</span>
            {t.yes}
          </p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-emerald-900">
            <dt className="text-emerald-700">{t.at}</dt>
            <dd className="font-bold">{res.time ? fmt(res.time) : t.timeUnknown}</dd>
            <dt className="text-emerald-700">{t.state}</dt>
            <dd className="font-bold">{res.original ? t.original : t.copy}</dd>
            {ev && (
              <>
                <dt className="text-emerald-700">{t.coverage}</dt>
                <dd className="font-bold">{Math.round(ev.coverage * 100)}%</dd>
              </>
            )}
          </dl>
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5">
          <p className="flex items-center gap-2 text-lg font-black">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-slate-400 text-sm text-white">✕</span>
            {t.no}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">{t.noHint}</p>
        </div>
      )}

      {ev && (
        <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-2 gap-3 text-center text-xs font-bold text-slate-600">
            <figure>
              <PatternCanvas cells={ev.expected} />
              <figcaption className="mt-1.5">{t.expected}</figcaption>
            </figure>
            <figure>
              <PatternCanvas cells={ev.read} />
              <figcaption className="mt-1.5">{t.read}</figcaption>
            </figure>
          </div>
          <p className="mt-3 text-center text-sm">
            {t.similarity}{" "}
            <b className={res.found ? "text-emerald-700" : "text-slate-700"}>{Math.round(ev.similarity * 100)}%</b>
          </p>
          <p className="mt-1 text-center text-[11px] text-slate-400">{t.compareHint}</p>
        </div>
      )}
    </div>
  );
}

/** The app pattern drawn where it was read: green cells on tiles that matched, a rose wash where it was weak. */
function Overlay({ ev, w, h }: { ev: Evidence; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const k = Math.min(1, 1400 / Math.max(w, h));
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    const N = TILE_CELLS;
    const cw = (ev.tx / N) * k;
    const ch = (ev.ty / N) * k;
    for (let r = 0; r < ev.rows; r++)
      for (let col = 0; col < ev.cols; col++) {
        const z = ev.z[r * ev.cols + col];
        if (Number.isNaN(z)) continue;
        const X = (ev.gx0 + col * ev.tx) * k;
        const Y = (ev.gy0 + r * ev.ty) * k;
        if (z >= 3) {
          g.fillStyle = `rgba(16,185,129,${Math.min(0.32, 0.14 + z / 80)})`;
          for (let j = 0; j < N; j++)
            for (let i = 0; i < N; i++)
              if (ev.cells[j * N + i] > 0) g.fillRect(X + i * cw, Y + j * ch, cw + 0.3, ch + 0.3);
          g.strokeStyle = "rgba(16,185,129,0.45)";
          g.lineWidth = Math.max(1, c.width / 600);
          g.strokeRect(X, Y, ev.tx * k, ev.ty * k);
        } else {
          g.fillStyle = "rgba(244,63,94,0.16)";
          g.fillRect(X, Y, ev.tx * k, ev.ty * k);
        }
      }
  }, [ev, w, h]);
  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" />;
}

function PatternCanvas({ cells }: { cells: Float32Array }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const N = TILE_CELLS;
    c.width = N;
    c.height = N;
    const img = new ImageData(N, N);
    for (let k = 0; k < N * N; k++) {
      const v = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, cells[k])));
      img.data[k * 4] = img.data[k * 4 + 1] = img.data[k * 4 + 2] = v;
      img.data[k * 4 + 3] = 255;
    }
    c.getContext("2d")!.putImageData(img, 0, 0);
  }, [cells]);
  return <canvas ref={ref} className="mx-auto aspect-square w-full max-w-36 rounded-lg [image-rendering:pixelated]" />;
}

/**
 * Home-screen sample: the real watermarked sample photo, with the app pattern drawn on top and slowly swept in
 * and out. The real cells are 1/256 of the photo — far too fine to see — so they are drawn magnified.
 */
/** Reveal fraction over one 6 s cycle: wait, sweep in, hold, sweep out (eased). */
function revealAt(t: number) {
  const ease = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
  if (t < 0.12) return 0;
  if (t < 0.45) return ease((t - 0.12) / 0.33);
  if (t < 0.62) return 1;
  if (t < 0.95) return 1 - ease((t - 0.62) / 0.33);
  return 0;
}

function SamplePreview({ badge, cta }: { badge: string; cta: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  // Driven from JS, not CSS: iOS Safari doesn't always repaint a CSS-animated clip-path on a canvas.
  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const p = revealAt((now % 6000) / 6000);
      const clip = `inset(0 ${(1 - p) * 100}% 0 0)`;
      const c = ref.current;
      const line = lineRef.current;
      if (c) {
        c.style.clipPath = clip;
        c.style.setProperty("-webkit-clip-path", clip);
      }
      if (line) {
        line.style.left = `${p * 100}%`;
        line.style.opacity = p > 0.01 && p < 0.99 ? "1" : "0";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const N = TILE_CELLS;
    const cells = tileCells(SAMPLE_TIME);
    const cell = 6; // canvas px per cell
    const tilesX = 4;
    c.width = N * cell * tilesX;
    c.height = Math.round((c.width * 2) / 3);
    const g = c.getContext("2d")!;
    g.fillStyle = "rgba(16,185,129,0.62)";
    for (let y = 0; y * cell < c.height; y++)
      for (let x = 0; x * cell < c.width; x++)
        if (cells[(y % N) * N + (x % N)] > 0) g.fillRect(x * cell, y * cell, cell, cell);
  }, []);
  return (
    <span className="relative block aspect-[3/2] w-full bg-slate-100">
      {/* eslint-disable-next-line @next/next/no-img-element -- small static sample, no optimisation needed */}
      <img src={SAMPLE_URL} alt="" className="absolute inset-0 h-full w-full object-cover" />
      <canvas
        ref={ref}
        style={{ clipPath: "inset(0 100% 0 0)" }}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
      <span
        ref={lineRef}
        style={{ left: 0, opacity: 0 }}
        className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white/90 shadow-[0_0_8px_rgba(255,255,255,0.9)]"
      />
      <span className="absolute top-2.5 left-2.5 rounded-full bg-emerald-600/90 px-2.5 py-1 text-[11px] font-bold text-white">
        ✓ {badge}
      </span>
      <span className="absolute right-2.5 bottom-2.5 rounded-full bg-slate-900/85 px-3 py-1.5 text-xs font-bold text-white backdrop-blur">
        {cta}
      </span>
    </span>
  );
}

/**
 * App-only full-screen camera. The native preview sits behind a transparent web view, so the shutter and
 * other controls here are ordinary HTML on top of it.
 */
function NativeCamera({
  labels,
  busy,
  onClose,
  onFail,
  onCapture,
}: {
  labels: { shutter: string; close: string; flip: string; working: string };
  busy: boolean;
  onClose: () => void;
  onFail: () => void;
  onCapture: (blob: Blob, when: Date) => void;
}) {
  const [ready, setReady] = useState(false);
  const capturing = useRef(false);
  const failRef = useRef(onFail);
  useEffect(() => {
    failRef.current = onFail;
  }, [onFail]);

  useEffect(() => {
    let stopped = false;
    const root = document.documentElement;
    root.classList.add("camera-on");
    (async () => {
      try {
        const { CameraPreview } = await import("@capacitor-community/camera-preview");
        await CameraPreview.start({
          position: "rear",
          toBack: true,
          disableAudio: true,
          enableHighResolution: true,
          rotateWhenOrientationChanged: false,
          width: window.screen.width,
          height: window.screen.height,
        });
        if (stopped) await CameraPreview.stop();
        else setReady(true);
      } catch {
        if (!stopped) failRef.current();
      }
    })();
    return () => {
      stopped = true;
      root.classList.remove("camera-on");
      import("@capacitor-community/camera-preview").then(({ CameraPreview }) => CameraPreview.stop().catch(() => {}));
    };
  }, []);

  const shutter = async () => {
    if (capturing.current || !ready) return;
    capturing.current = true;
    const when = new Date();
    try {
      const { CameraPreview } = await import("@capacitor-community/camera-preview");
      const { value } = await CameraPreview.capture({ quality: 95 });
      const blob = await (await fetch(`data:image/jpeg;base64,${value}`)).blob();
      onCapture(blob, when);
    } catch {
      capturing.current = false;
      failRef.current();
    }
  };

  const flip = async () => {
    const { CameraPreview } = await import("@capacitor-community/camera-preview");
    await CameraPreview.flip().catch(() => {});
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      {busy && (
        <div className="absolute inset-0 grid place-items-center bg-black/70">
          <p className="animate-pulse text-sm font-bold text-white">{labels.working}</p>
        </div>
      )}
      <div className="relative flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-8 pt-10 pb-[max(env(safe-area-inset-bottom),24px)]">
        <button onClick={onClose} className="w-14 text-sm font-bold text-white">
          {labels.close}
        </button>
        <button
          onClick={shutter}
          disabled={!ready || busy}
          aria-label={labels.shutter}
          className="grid h-20 w-20 place-items-center rounded-full border-4 border-white bg-white/25 active:scale-95 disabled:opacity-50"
        >
          <span className="h-16 w-16 rounded-full bg-white" />
        </button>
        <button onClick={flip} className="w-14 text-sm font-bold text-white">
          {labels.flip}
        </button>
      </div>
    </div>
  );
}
