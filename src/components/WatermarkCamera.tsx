"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_KEY, MAX_TEXT_BYTES, MIN_PIXELS, embed, fitText, lsbPlane, verify, type VerifyResult } from "@/lib/watermark";

const MAX_PIXELS = 16_000_000; // iOS Safari refuses canvases much larger than ~16.7 MP
const STORE = "wmcam";

const L = {
  ko: {
    title: "워터마크 카메라",
    lead: "찍는 순간 눈에 보이지 않는 워터마크가 사진 픽셀 속에 새겨집니다.\n누가, 언제 찍은 사진인지 나중에 여기서 확인할 수 있어요.",
    tabShoot: "촬영",
    tabCheck: "워터마크 확인",
    text: "워터마크 문구",
    textPh: "예: © 홍길동",
    key: "비밀 키 (선택)",
    keyPh: "비워두면 누구나 확인 가능",
    keyHint: "키를 정하면 같은 키를 아는 사람만 워터마크를 읽을 수 있어요.",
    robust: "압축돼도 남는 보조 워터마크",
    robustHint: "카톡·메신저 등에서 JPG로 다시 저장돼도 읽을 수 있도록 8×8 블록 밝기에 한 번 더 새깁니다 (최대 ±2 단계).",
    start: "카메라 켜기",
    flip: "전환",
    shutter: "촬영",
    pick: "사진 파일에 워터마크 넣기",
    camError: "카메라를 열 수 없어요. 브라우저 권한을 확인하거나 아래 ‘사진 파일’로 넣어 보세요.",
    working: "워터마크 새기는 중…",
    done: "워터마크가 들어간 사진",
    save: "PNG로 저장",
    share: "공유 / 사진앱에 저장",
    again: "다시 찍기",
    pngNote: "반드시 PNG 원본으로 보관하세요. 픽셀 워터마크는 JPG로 바뀌면 사라지고, 보조 워터마크만 남습니다.",
    longPress: "휴대폰에서는 사진을 길게 눌러 저장할 수도 있어요.",
    checkPick: "확인할 사진 선택",
    checking: "확인하는 중…",
    pixel: "픽셀 워터마크",
    robustL: "보조 워터마크",
    pixelOk: "원본 그대로입니다 — 픽셀 하나도 바뀌지 않았어요.",
    pixelNo: "없음 — 워터마크가 없거나, JPG 재저장·편집으로 지워졌어요.",
    robustOk: "확인됨",
    robustNo: "없음 — 워터마크가 없거나, 크기 변경·자르기로 지워졌어요. 키가 다를 수도 있어요.",
    by: "문구",
    at: "촬영 시각",
    strength: "신호 일치도",
    plane: "숨은 패턴 보기",
    planeHint: "파란색 채널 최하위 비트만 흑백으로 확대한 화면입니다. 워터마크가 있으면 균일한 잡음처럼 보여요.",
    tooSmall: "사진이 너무 작아 워터마크를 넣을 수 없어요.",
    loadFail: "이미지를 읽지 못했어요.",
    resized: "사진이 커서 {w}×{h}로 줄여서 처리했어요.",
    bytes: "{n}/{max} 바이트",
  },
  en: {
    title: "Watermark Camera",
    lead: "Every photo gets an invisible watermark written into its pixels at the moment you shoot.\nCheck later here who took it and when.",
    tabShoot: "Shoot",
    tabCheck: "Check watermark",
    text: "Watermark text",
    textPh: "e.g. © Jane Doe",
    key: "Secret key (optional)",
    keyPh: "Leave empty so anyone can check it",
    keyHint: "With a key, only people who know it can read the watermark.",
    robust: "Backup watermark that survives compression",
    robustHint: "Also written into 8×8 block brightness (max ±2 levels) so it can still be read after a messenger re-saves the photo as JPG.",
    start: "Turn on camera",
    flip: "Flip",
    shutter: "Shoot",
    pick: "Watermark a photo file",
    camError: "Couldn't open the camera. Check the browser permission or use a photo file below.",
    working: "Writing watermark…",
    done: "Watermarked photo",
    save: "Save PNG",
    share: "Share / save to Photos",
    again: "Shoot again",
    pngNote: "Keep the PNG original. The pixel watermark is lost if the photo becomes a JPG; only the backup watermark remains.",
    longPress: "On a phone you can also long-press the photo to save it.",
    checkPick: "Choose a photo to check",
    checking: "Checking…",
    pixel: "Pixel watermark",
    robustL: "Backup watermark",
    pixelOk: "Untouched original — not a single pixel changed.",
    pixelNo: "Not found — no watermark, or it was erased by a JPG re-save or edit.",
    robustOk: "Found",
    robustNo: "Not found — no watermark, or erased by resizing/cropping. The key may also differ.",
    by: "Text",
    at: "Taken at",
    strength: "Signal agreement",
    plane: "Show hidden pattern",
    planeHint: "Lowest bit of the blue channel shown as black/white. A watermarked photo looks like even noise.",
    tooSmall: "The photo is too small to carry a watermark.",
    loadFail: "Couldn't read the image.",
    resized: "Large photo — processed at {w}×{h}.",
    bytes: "{n}/{max} bytes",
  },
};

type Locale = keyof typeof L;
const noop = () => () => {};
/** Browser language on the client, Korean on the server (so hydration matches the server HTML first). */
const browserLocale = (): Locale => (navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en");

type Shot = { url: string; blob: Blob; name: string; note?: string };
type Check = { res: VerifyResult; img: ImageData; name: string };

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function ctx2d(c: HTMLCanvasElement) {
  return c.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" }) as CanvasRenderingContext2D;
}

/** Draw a source onto a canvas no larger than MAX_PIXELS; returns the canvas and whether it was shrunk. */
function toCanvas(src: CanvasImageSource, w: number, h: number) {
  const s = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  ctx2d(c).drawImage(src, 0, 0, c.width, c.height);
  return { c, shrunk: s < 1 };
}

export default function WatermarkCamera() {
  const auto = useSyncExternalStore(noop, browserLocale, (): Locale => "ko");
  const [picked, setPicked] = useState<Locale | null>(null);
  const locale = picked ?? auto;
  const t = L[locale];
  const [tab, setTab] = useState<"shoot" | "check">("shoot");
  const [text, setText] = useState("");
  const [key, setKey] = useState("");
  const [robust, setRobust] = useState(true);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [plane, setPlane] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const planeRef = useRef<HTMLCanvasElement>(null);

  // Remember the user's text/key/robust choice on this device.
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(STORE) ?? "{}");
      /* eslint-disable react-hooks/set-state-in-effect -- one-time restore from localStorage */
      if (typeof s.text === "string") setText(s.text);
      if (typeof s.key === "string") setKey(s.key);
      if (typeof s.robust === "boolean") setRobust(s.robust);
      /* eslint-enable react-hooks/set-state-in-effect */
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify({ text, key, robust }));
    } catch {}
  }, [text, key, robust]);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    setLive(false);
  }, []);

  const start = useCallback(
    async (mode: "environment" | "user") => {
      setError(null);
      stop();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: mode }, width: { ideal: 3840 }, height: { ideal: 2160 } },
          audio: false,
        });
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
        setLive(true);
      } catch {
        setError(t.camError);
      }
    },
    [stop, t.camError],
  );

  useEffect(() => stop, [stop]);
  useEffect(
    () => () => {
      if (shot) URL.revokeObjectURL(shot.url);
    },
    [shot],
  );

  /** Watermark whatever is on the canvas and turn it into a PNG. */
  const finish = async (c: HTMLCanvasElement, shrunk: boolean, when: Date) => {
    if (c.width * c.height < MIN_PIXELS) throw new Error(t.tooSmall);
    const g = ctx2d(c);
    const img = g.getImageData(0, 0, c.width, c.height);
    embed(img, { text: fitText(text.trim()), time: when }, key || DEFAULT_KEY, robust);
    g.putImageData(img, 0, 0);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error())), "image/png"));
    setShot({
      url: URL.createObjectURL(blob),
      blob,
      name: `watermark-${stamp(when)}.png`,
      note: shrunk ? fill(t.resized, { w: c.width, h: c.height }) : undefined,
    });
  };

  const capture = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const when = new Date();
    const { c, shrunk } = toCanvas(v, v.videoWidth, v.videoHeight); // grab the frame before anything else
    stop();
    setBusy(t.working);
    await nextFrame();
    try {
      await finish(c, shrunk, when);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t.loadFail);
    } finally {
      setBusy(null);
    }
  };

  const fromFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    stop();
    setBusy(t.working);
    await nextFrame();
    try {
      const bmp = await createImageBitmap(f);
      const { c, shrunk } = toCanvas(bmp, bmp.width, bmp.height);
      bmp.close();
      await finish(c, shrunk, new Date(f.lastModified || Date.now()));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t.loadFail);
    } finally {
      setBusy(null);
    }
  };

  const runCheck = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    setCheck(null);
    setPlane(false);
    setBusy(t.checking);
    await nextFrame();
    try {
      // No colour conversion / premultiplication: we need the stored pixel values bit-for-bit.
      const bmp = await createImageBitmap(f, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const g = ctx2d(c);
      g.drawImage(bmp, 0, 0);
      bmp.close();
      const img = g.getImageData(0, 0, c.width, c.height);
      setCheck({ res: verify(img, key || DEFAULT_KEY), img, name: f.name });
    } catch {
      setError(t.loadFail);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    const c = planeRef.current;
    if (!plane || !c || !check) return;
    c.width = check.img.width;
    c.height = check.img.height;
    ctx2d(c).putImageData(lsbPlane(check.img), 0, 0);
  }, [plane, check]);

  const share = async () => {
    if (!shot) return;
    const file = new File([shot.blob], shot.name, { type: "image/png" });
    try {
      await navigator.share({ files: [file] });
    } catch {}
  };
  const canShare =
    typeof navigator !== "undefined" &&
    !!shot &&
    !!navigator.canShare?.({ files: [new File([shot.blob], shot.name, { type: "image/png" })] });

  const bytes = new TextEncoder().encode(text.trim()).length;
  const fmtTime = (d: Date) =>
    d.toLocaleString(locale === "ko" ? "ko-KR" : "en-US", { dateStyle: "medium", timeStyle: "medium" });

  const btn = "inline-flex items-center justify-center rounded-xl px-4 py-3 text-sm font-bold transition";
  const primary = `${btn} bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-40`;
  const ghost = `${btn} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`;
  const input =
    "mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-base outline-none focus:border-slate-900 sm:text-sm";

  return (
    <section className="mx-auto max-w-xl px-4 pt-8 pb-16 sm:px-6 sm:pt-16">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-3xl font-black tracking-tight sm:text-4xl">{t.title}</h1>
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
      <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-slate-600">{t.lead}</p>

      <div className="mt-6 grid grid-cols-2 rounded-xl bg-slate-200/70 p-1 text-sm font-bold">
        {(["shoot", "check"] as const).map((k) => (
          <button
            key={k}
            onClick={() => {
              if (k !== "shoot") stop();
              setTab(k);
            }}
            className={`rounded-lg py-2 ${tab === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
          >
            {k === "shoot" ? t.tabShoot : t.tabCheck}
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        {tab === "shoot" && (
          <label className="block">
            <span className="flex justify-between text-sm font-bold">
              {t.text}
              <span className={`font-normal ${bytes > MAX_TEXT_BYTES ? "text-red-600" : "text-slate-400"}`}>
                {fill(t.bytes, { n: bytes, max: MAX_TEXT_BYTES })}
              </span>
            </span>
            <input
              className={input}
              value={text}
              placeholder={t.textPh}
              onChange={(e) => setText(fitText(e.target.value))}
            />
          </label>
        )}
        <label className={`block ${tab === "shoot" ? "mt-4" : ""}`}>
          <span className="text-sm font-bold">{t.key}</span>
          <input
            className={input}
            value={key}
            placeholder={t.keyPh}
            autoComplete="off"
            onChange={(e) => {
              setKey(e.target.value);
              setCheck(null);
            }}
          />
          <span className="mt-1 block text-xs text-slate-500">{t.keyHint}</span>
        </label>
        {tab === "shoot" && (
          <label className="mt-4 flex gap-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-slate-900"
              checked={robust}
              onChange={(e) => setRobust(e.target.checked)}
            />
            <span>
              <span className="block text-sm font-bold">{t.robust}</span>
              <span className="mt-0.5 block text-xs text-slate-500">{t.robustHint}</span>
            </span>
          </label>
        )}

        {tab === "shoot" && !shot && (
          <div className="mt-5">
            <div className={`relative overflow-hidden rounded-xl bg-slate-900 ${live ? "" : "hidden"}`}>
              <video
                ref={videoRef}
                playsInline
                muted
                className={`block max-h-[60vh] w-full object-contain ${facing === "user" ? "-scale-x-100" : ""}`}
              />
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-6 bg-gradient-to-t from-black/60 p-4">
                <button
                  onClick={() => {
                    const m = facing === "user" ? "environment" : "user";
                    setFacing(m);
                    start(m);
                  }}
                  className="rounded-full bg-white/20 px-4 py-2 text-xs font-bold text-white backdrop-blur"
                >
                  {t.flip}
                </button>
                <button
                  onClick={capture}
                  aria-label={t.shutter}
                  className="grid h-16 w-16 place-items-center rounded-full border-4 border-white bg-white/30 active:scale-95"
                >
                  <span className="h-12 w-12 rounded-full bg-white" />
                </button>
                <span className="w-[52px]" />
              </div>
            </div>
            {!live && !busy && (
              <button onClick={() => start(facing)} className={`${primary} w-full`}>
                {t.start}
              </button>
            )}
            {!busy && (
              <label className={`${ghost} mt-2 w-full cursor-pointer`}>
                {t.pick}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    fromFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </div>
        )}

        {tab === "shoot" && shot && (
          <div className="mt-5">
            <p className="text-sm font-bold">{t.done}</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- blob URL, must stay a plain <img> for long-press save */}
            <img src={shot.url} alt={t.done} className="mt-2 w-full rounded-xl border border-slate-200 [-webkit-touch-callout:default]" />
            {shot.note && <p className="mt-2 text-xs text-slate-500">{shot.note}</p>}
            <div className="mt-3 grid gap-2">
              <a href={shot.url} download={shot.name} className={primary}>
                {t.save}
              </a>
              {canShare && (
                <button onClick={share} className={ghost}>
                  {t.share}
                </button>
              )}
              <button
                onClick={() => {
                  setShot(null);
                  start(facing);
                }}
                className={ghost}
              >
                {t.again}
              </button>
            </div>
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
              {t.pngNote} {t.longPress}
            </p>
          </div>
        )}

        {tab === "check" && (
          <div className="mt-5">
            {!busy && (
              <label className={`${primary} w-full cursor-pointer`}>
                {t.checkPick}
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
            )}
            {check && (
              <div className="mt-4 space-y-3">
                <p className="truncate text-xs text-slate-500">{check.name}</p>
                <ResultRow
                  label={t.pixel}
                  ok={!!check.res.pixel}
                  okText={t.pixelOk}
                  noText={t.pixelNo}
                  d={check.res.pixel}
                  t={t}
                  fmt={fmtTime}
                />
                <ResultRow
                  label={t.robustL}
                  ok={!!check.res.robust}
                  okText={t.robustOk}
                  noText={t.robustNo}
                  d={check.res.robust}
                  t={t}
                  fmt={fmtTime}
                />
                <button onClick={() => setPlane((p) => !p)} className={`${ghost} w-full`}>
                  {t.plane}
                </button>
                {plane && (
                  <div>
                    <canvas ref={planeRef} className="w-full rounded-xl border border-slate-200 [image-rendering:pixelated]" />
                    <p className="mt-1 text-xs text-slate-500">{t.planeHint}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {busy && <p className="mt-5 animate-pulse text-center text-sm font-bold text-slate-600">{busy}</p>}
        {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>
    </section>
  );
}

function ResultRow({
  label,
  ok,
  okText,
  noText,
  d,
  t,
  fmt,
}: {
  label: string;
  ok: boolean;
  okText: string;
  noText: string;
  d: VerifyResult["pixel"];
  t: (typeof L)["ko"];
  fmt: (d: Date) => string;
}) {
  return (
    <div className={`rounded-xl border p-4 ${ok ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}>
      <p className="flex items-center gap-2 text-sm font-bold">
        <span className={`grid h-5 w-5 place-items-center rounded-full text-xs text-white ${ok ? "bg-emerald-600" : "bg-slate-400"}`}>
          {ok ? "✓" : "–"}
        </span>
        {label}
      </p>
      <p className={`mt-1 text-xs ${ok ? "text-emerald-800" : "text-slate-500"}`}>{ok ? okText : noText}</p>
      {d && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-slate-500">{t.by}</dt>
          <dd className="break-all font-bold">{d.text || "—"}</dd>
          <dt className="text-slate-500">{t.at}</dt>
          <dd>{fmt(d.time)}</dd>
          <dt className="text-slate-500">{t.strength}</dt>
          <dd>{Math.round(d.agreement * 100)}%</dd>
        </dl>
      )}
    </div>
  );
}
