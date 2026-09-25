import React from "react";
import { AbsoluteFill, Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import {
  AiPanel,
  ChapterRail,
  Chip,
  EndCard,
  H,
  Hero,
  W,
  Words,
  body,
  cameraAt,
  clamp,
  display,
  fall,
  ink,
  lime,
  mono,
  muted,
  paper,
  rise,
  slots,
  smooth
} from "./V6.jsx";

// The v7 cut reuses the v6 look. What changes is timing: every clip plays through a time map
// (src/v7-edit.mjs) that lands real on-screen moments on the score's beats and hits, and
// overlays enter on the grid instead of easing in around it.

const FPS = 30;
const out = Easing.out(Easing.cubic);

// Source seconds for a local frame, from the clip's [frame, seconds] knots.
function sourceSeconds(map, frame) {
  if (frame <= map[0][0]) return map[0][1];
  for (let index = 1; index < map.length; index += 1) {
    const [f1, s1] = map[index];
    if (frame <= f1) {
      const [f0, s0] = map[index - 1];
      return s0 + ((frame - f0) / Math.max(1e-6, f1 - f0)) * (s1 - s0);
    }
  }
  return map.at(-1)[1];
}

function RetimedClip({ clip }) {
  const frame = useCurrentFrame();
  const { s, x, y } = cameraAt(clip.cam, frame);
  const halfW = W / (2 * s);
  const halfH = H / (2 * s);
  const cx = Math.min(W - halfW, Math.max(halfW, x));
  const cy = Math.min(H - halfH, Math.max(halfH, y));
  // Nearest recorded frame: retiming never blends frames, so text stays crisp. The inner
  // Sequence shifts the video's clock so that this output frame shows exactly sourceFrame
  // (the same mechanism OffthreadVideo's own trimBefore uses).
  const sourceFrame = Math.round(sourceSeconds(clip.map, frame) * FPS);
  return (
    <Sequence from={frame - sourceFrame} layout="none">
      <OffthreadVideo
        src={staticFile("live.mp4")}
        muted
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: W,
          height: H,
          transformOrigin: "0 0",
          transform: `translate(${W / 2 - cx * s}px, ${H / 2 - cy * s}px) scale(${s})`
        }}
      />
    </Sequence>
  );
}

// Scale punch on transitions and reveals, and the restrained kick pulse. Each impulse jumps
// to 1 + amp on its frame and relaxes over about a third of a second.
function stageScale(edit, frame) {
  let scale = 1;
  const add = (at, amp) => {
    const t = frame - at;
    if (t >= 0 && t < 10) scale += amp * Math.exp(-t / 2.4);
  };
  for (const pulse of edit.pulses) add(pulse.frame, pulse.amp);
  for (const flash of edit.flashes) add(flash.frame, flash.kind === "drop" ? 0.045 : flash.kind === "stab" ? 0.03 : 0);
  return scale;
}

function Stage({ edit }) {
  const frame = useCurrentFrame();
  const scale = stageScale(edit, frame);
  return (
    <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: "50% 50%" }}>
      {edit.clips.map((clip) => (
        <Sequence key={clip.id} from={clip.from} durationInFrames={clip.duration}>
          <RetimedClip clip={clip} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}

function Flash({ kind }) {
  const frame = useCurrentFrame();
  // Drops after a stop: a 3-frame luminance lift. Stabs and cuts: the v6 lime edge flash.
  const luma = kind === "drop" ? interpolate(frame, [0, 1, 3], [0.3, 0.12, 0], clamp) : 0;
  const edge = interpolate(frame, [0, 1, 5], kind === "cut" ? [0.16, 0.08, 0] : [0.34, 0.16, 0], clamp);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {luma > 0 ? <AbsoluteFill style={{ background: paper, opacity: luma }} /> : null}
      <AbsoluteFill style={{ border: `3px solid ${lime}`, background: "rgba(199,255,74,.06)", opacity: edge }} />
    </AbsoluteFill>
  );
}

// A free-time stop freezes the picture; a slow dim makes the silence read as intentional.
function StopDim({ length }) {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ background: ink, opacity: interpolate(frame, [0, length], [0, 0.3], { ...clamp, easing: out }), pointerEvents: "none" }} />;
}

function SlamCaption({ caption, total }) {
  const frame = useCurrentFrame();
  // On the hit frame the panel is already mostly there; it settles over five frames.
  const enter = rise(frame, 0, 5);
  const exit = fall(frame, total - 8, 8);
  const slot = slots[caption.position];
  let top = slot.top;
  if (caption.settleAt !== null && caption.settleAt !== undefined && slot.top !== undefined) {
    top = interpolate(frame, [caption.settleAt, caption.settleAt + 10], [slot.top, 796], { ...clamp, easing: smooth });
  }
  const fromBelow = slot.bottom !== undefined || caption.position === "transfer";
  const chips = caption.chipFrames || caption.proof.map((_, index) => 16 + index * 5);
  return (
    <div style={{
      position: "absolute",
      left: slot.left,
      right: slot.right,
      top,
      bottom: slot.bottom,
      width: slot.width,
      minHeight: slot.minHeight,
      boxSizing: "border-box",
      color: paper,
      background: ink,
      boxShadow: "0 26px 80px rgba(0,0,0,.36)",
      padding: "24px 30px 27px 34px",
      opacity: Math.min(0.6 + 0.4 * enter, exit),
      transform: `translateY(${(1 - enter) * (fromBelow ? 16 : -16)}px) scale(${1.025 - 0.025 * enter})`,
      transformOrigin: fromBelow ? "50% 100%" : "50% 0%",
      overflow: "hidden"
    }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 8, background: lime, transformOrigin: "top", transform: `scaleY(${0.35 + 0.65 * enter})` }} />
      <div style={{ color: lime, fontFamily: mono, fontWeight: 700, fontSize: 18, letterSpacing: "0.12em", textTransform: "uppercase" }}>{caption.eyebrow}</div>
      <Words
        text={caption.headline}
        frame={frame}
        start={-1}
        stagger={1.5}
        length={8}
        style={{ marginTop: 12, fontFamily: display, fontWeight: 800, fontSize: 54, lineHeight: 1.0, letterSpacing: "-0.045em" }}
      />
      {caption.detail ? (
        <div style={{ marginTop: 12, width: "94%", color: muted, fontFamily: body, fontSize: 23, lineHeight: 1.3, opacity: rise(frame, 6, 10) }}>{caption.detail}</div>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 18 }}>
        {caption.proof.map((item, index) => <Chip key={item} solid={index === 0} opacity={rise(frame, (chips[index] ?? chips.at(-1)) - 1, 4)}>{item}</Chip>)}
      </div>
    </div>
  );
}

function Captions({ edit }) {
  return edit.captions.map((caption) => (
    <Sequence key={`${caption.clip}-${caption.from}`} from={caption.from} durationInFrames={caption.duration}>
      <SlamCaption caption={caption} total={caption.duration} />
    </Sequence>
  ));
}

function KeyCap({ label, total }) {
  const frame = useCurrentFrame();
  // Fully visible on the beat, a small overshoot that settles, then out before the next key.
  const settle = interpolate(frame, [0, 5], [1, 0], { ...clamp, easing: out });
  const ring = interpolate(frame, [0, 6], [1, 0], clamp);
  const leave = fall(frame, total - 5, 5);
  const parts = label.split(" + ");
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 116, pointerEvents: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, opacity: leave, transform: `scale(${1 + 0.12 * settle})` }}>
        {parts.map((part, index) => (
          <React.Fragment key={`${part}-${index}`}>
            {index > 0 ? <span style={{ color: paper, fontFamily: mono, fontSize: 24, fontWeight: 700, textShadow: "0 2px 10px rgba(0,0,0,.6)" }}>+</span> : null}
            <span style={{
              minWidth: 30,
              textAlign: "center",
              padding: "10px 16px 9px",
              color: ink,
              background: paper,
              border: `2px solid ${ink}`,
              borderBottomWidth: 5 - 2 * settle,
              borderRadius: 8,
              fontFamily: mono,
              fontSize: 25,
              fontWeight: 800,
              boxShadow: `0 10px 30px rgba(0,0,0,.35), 0 0 0 ${3 + 5 * ring}px rgba(199,255,74,${0.85 - 0.5 * ring})`
            }}>{part}</span>
          </React.Fragment>
        ))}
      </div>
    </AbsoluteFill>
  );
}

function KeyCaps({ edit }) {
  return edit.keys.map((key, index) => {
    const next = edit.keys[index + 1];
    const duration = Math.max(8, Math.min(edit.beatFrames * 2, next ? next.from - key.from : edit.beatFrames * 2));
    return (
      <Sequence key={`${key.label}-${key.from}`} from={key.from} durationInFrames={duration}>
        <KeyCap label={key.label} total={duration} />
      </Sequence>
    );
  });
}

export function ExploreBetterV7({ edit }) {
  if (!edit) {
    return <AbsoluteFill style={{ background: ink, color: paper, fontFamily: mono, justifyContent: "center", alignItems: "center", fontSize: 28 }}>Run npm run render:v7 to build the v7 edit.</AbsoluteFill>;
  }
  const endLength = edit.durationInFrames - edit.endFrom;
  const beats = edit.endCard.beats;
  return (
    <AbsoluteFill style={{ background: ink, fontFamily: body, overflow: "hidden" }}>
      <Stage edit={edit} />
      <AbsoluteFill style={{ boxShadow: "inset 0 0 180px rgba(0,0,0,.18)", pointerEvents: "none" }} />
      {edit.freezes.map((freeze) => (
        <Sequence key={`stop-${freeze.from}`} from={freeze.from} durationInFrames={freeze.to - freeze.from}><StopDim length={freeze.to - freeze.from} /></Sequence>
      ))}
      <Sequence from={0} durationInFrames={edit.hero.outAt}>
        <Hero total={edit.hero.outAt} timing={{ eyebrow: edit.hero.eyebrowAt, headline: edit.hero.headlineAt, tagline: edit.hero.taglineAt, fadeOut: 4, version: edit.appVersion || "0.2.8" }} />
      </Sequence>
      <Captions edit={edit} />
      <KeyCaps edit={edit} />
      <Sequence from={edit.ai.from} durationInFrames={edit.ai.duration}><AiPanel ai={edit.ai} /></Sequence>
      <ChapterRail edit={edit} />
      <Sequence from={edit.endFrom} durationInFrames={endLength}>
        <EndCard total={endLength} timing={{ background: 2, mark: 0, markLength: 5, headline: 1, cta: beats[0] ?? 14, footer: beats[1] ?? 28, recap: beats[2] ?? 42 }} />
      </Sequence>
      {edit.flashes.map((flash) => (
        <Sequence key={`flash-${flash.frame}`} from={flash.frame} durationInFrames={6}><Flash kind={flash.kind} /></Sequence>
      ))}
    </AbsoluteFill>
  );
}
