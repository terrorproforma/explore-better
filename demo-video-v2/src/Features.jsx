import React from "react";
import {
  AbsoluteFill,
  Easing,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame
} from "remotion";

// Per-feature website clips (npm run render:features). Every pixel of UI is the real app
// capture; the overlays are keycaps, the AI trace panel, and small mono proof labels.
const ink = "#111715";
const lime = "#c7ff4a";
const paper = "#f4f7f5";
const muted = "#c8cfca";
const body = 'Aptos, "Segoe UI", sans-serif';
const mono = '"Cascadia Mono", Consolas, monospace';
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" };
const smooth = Easing.bezier(0.45, 0, 0.2, 1);
const rise = (frame, start, length = 12) => interpolate(frame, [start, start + length], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
const fall = (frame, start, length = 10) => interpolate(frame, [start, start + length], [1, 0], { ...clamp, easing: Easing.in(Easing.cubic) });

function cameraAt(cam, frame) {
  if (cam.length === 1 || frame <= cam[0].f) return cam[0];
  for (let index = 1; index < cam.length; index += 1) {
    const a = cam[index - 1];
    const b = cam[index];
    if (frame <= b.f) {
      const t = interpolate(frame, [a.f, b.f], [0, 1], { ...clamp, easing: smooth });
      return { s: a.s + (b.s - a.s) * t, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return cam.at(-1);
}

// The camera works in capture CSS pixels (clip.space); the frame is clip.width x clip.height.
function Shot({ clip, sourceStart, cam, frameOffset = 0 }) {
  const frame = useCurrentFrame() + frameOffset;
  const { s, x, y } = cameraAt(cam, frame);
  const k = clip.width / clip.space.width;
  const zoom = s * k;
  const halfW = clip.width / (2 * zoom);
  const halfH = clip.height / (2 * zoom);
  const cx = Math.min(clip.space.width - halfW, Math.max(halfW, x));
  const cy = Math.min(clip.space.height - halfH, Math.max(halfH, y));
  return (
    <OffthreadVideo
      src={staticFile(clip.source)}
      startFrom={sourceStart}
      muted
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: clip.space.width,
        height: clip.space.height,
        transformOrigin: "0 0",
        transform: `translate(${clip.width / 2 - cx * zoom}px, ${clip.height / 2 - cy * zoom}px) scale(${zoom})`
      }}
    />
  );
}

function KeyCap({ label, placement }) {
  const frame = useCurrentFrame();
  const pop = spring({ frame, fps: 30, config: { damping: 14, stiffness: 220, mass: 0.6 } });
  const out = fall(frame, 22, 8);
  const parts = label.split(" + ");
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: placement === "left" ? "flex-start" : "center", padding: placement === "left" ? "0 0 34px 34px" : "0 0 34px", pointerEvents: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, opacity: Math.min(pop, out), transform: `translateY(${(1 - pop) * 12}px) scale(${0.92 + pop * 0.08})` }}>
        {parts.map((part, index) => (
          <React.Fragment key={`${part}-${index}`}>
            {index > 0 ? <span style={{ color: paper, fontFamily: mono, fontSize: 17, fontWeight: 700, textShadow: "0 2px 8px rgba(0,0,0,.7)" }}>+</span> : null}
            <span style={{ minWidth: 20, textAlign: "center", padding: "7px 11px 6px", color: ink, background: paper, border: `2px solid ${ink}`, borderBottomWidth: 4, borderRadius: 6, fontFamily: mono, fontSize: 17, fontWeight: 800, boxShadow: "0 8px 22px rgba(0,0,0,.3), 0 0 0 2px rgba(199,255,74,.9)" }}>{part}</span>
          </React.Fragment>
        ))}
      </div>
    </AbsoluteFill>
  );
}

function ProofLabel({ text, total }) {
  const frame = useCurrentFrame();
  const opacity = Math.min(rise(frame, 0, 10), fall(frame, total - 10, 10));
  return (
    <div style={{ position: "absolute", right: 18, bottom: 16, padding: "5px 8px 4px", borderRadius: 3, background: "rgba(17,23,21,.86)", color: lime, fontFamily: mono, fontSize: 12, fontWeight: 700, letterSpacing: "0.07em", opacity }}>{text}</div>
  );
}

function AiPanel({ ai, total }) {
  const frame = useCurrentFrame();
  const enter = rise(frame, 2, 14);
  const exit = fall(frame, total - 10, 10);
  const lastRow = ai.rows.at(-1);
  const done = lastRow ? rise(frame, lastRow.at + 10, 12) : 0;
  return (
    <div style={{
      position: "absolute",
      right: 26,
      top: 76,
      width: 470,
      color: paper,
      background: "rgba(9,13,11,.965)",
      border: "1px solid rgba(244,247,245,.2)",
      borderRadius: 6,
      boxShadow: "0 24px 70px rgba(0,0,0,.42)",
      opacity: Math.min(enter, exit),
      transform: `translateX(${(1 - enter) * 40}px)`,
      overflow: "hidden"
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid rgba(244,247,245,.14)", fontFamily: mono, fontSize: 12, fontWeight: 700, letterSpacing: "0.08em" }}>
        <span style={{ color: lime }}>{ai.client.toUpperCase()} → EXPLORE BETTER MCP</span>
        <span style={{ color: ink, background: lime, padding: "3px 7px", borderRadius: 3 }}>READ-ONLY</span>
      </div>
      <div style={{ padding: "14px 16px 16px" }}>
        <div style={{ color: muted, fontFamily: mono, fontSize: 11, letterSpacing: "0.08em" }}>PROMPT</div>
        <div style={{ marginTop: 6, padding: "10px 12px", background: "#17201c", borderRadius: 4, fontFamily: body, fontSize: 17, lineHeight: 1.3 }}>{ai.task}</div>
        <div style={{ marginTop: 10 }}>
          {ai.rows.map((row) => {
            const p = rise(frame, row.at, 9);
            const open = rise(frame, row.at - 4, 8);
            return (
              <div key={row.tool} style={{ maxHeight: open * 64, overflow: "hidden", padding: `${9 * open}px 0`, borderTop: open > 0 ? "1px solid rgba(244,247,245,.12)" : "none", opacity: p, transform: `translateY(${(1 - p) * 8}px)` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: lime, boxShadow: `0 0 ${8 * (1 - p) + 3}px ${lime}` }} />
                  <span style={{ color: lime, fontFamily: mono, fontSize: 15, fontWeight: 700 }}>{row.tool}</span>
                  <span style={{ marginLeft: "auto", color: muted, fontFamily: mono, fontSize: 11 }}>ok</span>
                </div>
                <div style={{ marginTop: 4, marginLeft: 17, color: paper, fontFamily: mono, fontSize: 13, opacity: 0.88 }}>{row.detail}</div>
              </div>
            );
          })}
        </div>
        {ai.rows[0] && frame < ai.rows[0].at ? (
          <div style={{ marginTop: 4, color: muted, fontFamily: mono, fontSize: 12, letterSpacing: "0.06em", opacity: 0.55 + 0.45 * Math.abs(Math.sin(frame / 7)) }}>{ai.client.toUpperCase()} IS WORKING…</div>
        ) : null}
        <div style={{ maxHeight: done * 60, overflow: "hidden", marginTop: 8 * done, padding: `${10 * done}px 12px`, color: ink, background: lime, borderRadius: 4, fontFamily: body, fontSize: 16, fontWeight: 800, opacity: done }}>
          Revealed in your active pane.
        </div>
      </div>
    </div>
  );
}

export function FeatureClip({ clip }) {
  if (!clip) {
    return <AbsoluteFill style={{ background: ink, color: paper, fontFamily: mono, justifyContent: "center", alignItems: "center", fontSize: 22 }}>Run npm run render:features.</AbsoluteFill>;
  }
  const first = clip.segments[0];
  const loop = clip.loopFrames;
  return (
    <AbsoluteFill style={{ background: ink, overflow: "hidden" }}>
      {clip.segments.map((segment, index) => (
        <Sequence key={index} from={segment.from} durationInFrames={segment.duration}>
          <Shot clip={clip} sourceStart={segment.sourceStart} cam={segment.cam} />
        </Sequence>
      ))}
      {loop > 0 ? (
        // Seamless loop: the last frames dissolve into the moment just before frame 0.
        <Sequence from={clip.durationInFrames - loop} durationInFrames={loop}>
          <LoopBridge clip={clip} first={first} loop={loop} />
        </Sequence>
      ) : null}
      {clip.ai ? <Sequence from={clip.ai.from} durationInFrames={clip.ai.duration}><AiPanel ai={clip.ai} total={clip.ai.duration} /></Sequence> : null}
      {clip.keys.map((key, index) => (
        <Sequence key={`${key.label}-${key.from}`} from={key.from} durationInFrames={Math.max(8, Math.min(30, (clip.keys[index + 1]?.from ?? key.from + 30) - key.from))}>
          <KeyCap label={key.label} placement={clip.keyPlacement} />
        </Sequence>
      ))}
      {clip.labels.map((label) => (
        <Sequence key={label.text} from={label.from} durationInFrames={label.duration}><ProofLabel text={label.text} total={label.duration} /></Sequence>
      ))}
    </AbsoluteFill>
  );
}

function LoopBridge({ clip, first, loop }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, loop], [0, 1], { ...clamp, easing: smooth });
  return (
    <AbsoluteFill style={{ opacity }}>
      <Shot clip={clip} sourceStart={first.sourceStart - loop} cam={[first.cam[0]]} />
    </AbsoluteFill>
  );
}
