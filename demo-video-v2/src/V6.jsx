import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame
} from "remotion";

// Brand tokens shared with site/styles.css (--ink, --acid, --paper).
const ink = "#111715";
const lime = "#c7ff4a";
const paper = "#f4f7f5";
const muted = "#c8cfca";
const display = 'Bahnschrift, "Aptos Display", "Segoe UI", sans-serif';
const body = 'Aptos, "Segoe UI", sans-serif';
const mono = '"Cascadia Mono", Consolas, monospace';
const W = 1920;
const H = 1080;
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" };
const smooth = Easing.bezier(0.45, 0, 0.2, 1);

const rise = (frame, start, length = 14) => interpolate(frame, [start, start + length], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
const fall = (frame, start, length = 12) => interpolate(frame, [start, start + length], [1, 0], { ...clamp, easing: Easing.in(Easing.cubic) });

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

function ClipVideo({ clip }) {
  const frame = useCurrentFrame();
  const { s, x, y } = cameraAt(clip.cam, frame);
  // Keep the virtual camera inside the recorded frame so no edge ever shows.
  const halfW = W / (2 * s);
  const halfH = H / (2 * s);
  const cx = Math.min(W - halfW, Math.max(halfW, x));
  const cy = Math.min(H - halfH, Math.max(halfH, y));
  return (
    <OffthreadVideo
      src={staticFile("live.mp4")}
      startFrom={clip.sourceStart}
      playbackRate={clip.rate || 1}
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
  );
}

function CutFlash() {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 1, 5], [0.16, 0.08, 0], clamp);
  return <AbsoluteFill style={{ border: `3px solid ${lime}`, background: "rgba(199,255,74,.06)", opacity, pointerEvents: "none" }} />;
}

function Stage({ edit }) {
  return edit.clips.map((clip, index) => (
    <Sequence key={clip.id} from={clip.from} durationInFrames={clip.duration}>
      <ClipVideo clip={clip} />
      {index > 0 && clip.flash ? <CutFlash /> : null}
    </Sequence>
  ));
}

function Mark({ size = 54, label = 25 }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <Img src={staticFile("brand-mark.svg")} style={{ width: size, height: size, display: "block" }} />
      <div style={{ color: paper, fontFamily: display, fontSize: label, fontWeight: 750, letterSpacing: "-0.02em" }}>Explore Better</div>
    </div>
  );
}

function Words({ text, frame, start, stagger = 2.4, style }) {
  const words = text.split(" ");
  return (
    <div style={style}>
      {words.map((word, index) => {
        const p = rise(frame, start + index * stagger, 13);
        return (
          <span key={`${word}-${index}`} style={{ display: "inline-block", overflow: "hidden", verticalAlign: "top", paddingBottom: "0.08em", marginRight: "0.24em" }}>
            <span style={{ display: "inline-block", transform: `translateY(${(1 - p) * 105}%)`, opacity: p }}>{word}</span>
          </span>
        );
      })}
    </div>
  );
}

function Chip({ children, solid, opacity }) {
  return (
    <div style={{
      padding: "9px 12px 8px",
      borderRadius: 3,
      fontFamily: mono,
      fontSize: 16,
      fontWeight: 700,
      letterSpacing: "0.05em",
      color: solid ? ink : lime,
      background: solid ? lime : "transparent",
      border: solid ? `1px solid ${lime}` : "1px solid rgba(199,255,74,.55)",
      opacity,
      transform: `translateY(${(1 - opacity) * 10}px)`
    }}>{children}</div>
  );
}

const slots = {
  bottomRight: { right: 64, bottom: 72, width: 790 },
  bottomLeft: { left: 64, bottom: 72, width: 820 },
  topRight: { right: 64, top: 104, width: 790 },
  // Sized to sit over the Operations dialog's crash-recovery checkpoint panel while the copy
  // runs, keeping the eye on the live progress bar above it.
  transfer: { left: 72, top: 566, width: 860, minHeight: 262 }
};

function Caption({ caption, total }) {
  const frame = useCurrentFrame();
  const enter = rise(frame, 0, 16);
  const exit = fall(frame, total - 12, 12);
  const slot = slots[caption.position];
  let top = slot.top;
  if (caption.settleAt !== null && caption.settleAt !== undefined && slot.top !== undefined) {
    top = interpolate(frame, [caption.settleAt, caption.settleAt + 14], [slot.top, 796], { ...clamp, easing: smooth });
  }
  const fromBelow = slot.bottom !== undefined || caption.position === "transfer";
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
      opacity: Math.min(enter, exit),
      transform: `translateY(${(1 - enter) * (fromBelow ? 34 : -34)}px)`,
      overflow: "hidden"
    }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 8, background: lime, transformOrigin: "top", transform: `scaleY(${enter})` }} />
      <div style={{ color: lime, fontFamily: mono, fontWeight: 700, fontSize: 18, letterSpacing: "0.12em", textTransform: "uppercase", opacity: rise(frame, 3, 12) }}>{caption.eyebrow}</div>
      <Words
        text={caption.headline}
        frame={frame}
        start={5}
        style={{ marginTop: 12, fontFamily: display, fontWeight: 800, fontSize: 54, lineHeight: 1.0, letterSpacing: "-0.045em" }}
      />
      {caption.detail ? (
        <div style={{ marginTop: 12, width: "94%", color: muted, fontFamily: body, fontSize: 23, lineHeight: 1.3, opacity: rise(frame, 12, 12) }}>{caption.detail}</div>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 18 }}>
        {caption.proof.map((item, index) => <Chip key={item} solid={index === 0} opacity={rise(frame, 16 + index * 5, 12)}>{item}</Chip>)}
      </div>
    </div>
  );
}

function Captions({ edit }) {
  return edit.captions.map((caption) => (
    <Sequence key={`${caption.clip}-${caption.from}`} from={caption.from} durationInFrames={caption.duration}>
      <Caption caption={caption} total={caption.duration} />
    </Sequence>
  ));
}

function KeyCap({ label }) {
  const frame = useCurrentFrame();
  const pop = spring({ frame, fps: 30, config: { damping: 14, stiffness: 220, mass: 0.6 } });
  const out = fall(frame, 20, 8);
  const parts = label.split(" + ");
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 116, pointerEvents: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, opacity: Math.min(pop, out), transform: `translateY(${(1 - pop) * 18}px) scale(${0.9 + pop * 0.1})` }}>
        {parts.map((part, index) => (
          <React.Fragment key={`${part}-${index}`}>
            {index > 0 ? <span style={{ color: paper, fontFamily: mono, fontSize: 24, fontWeight: 700, textShadow: "0 2px 10px rgba(0,0,0,.6)" }}>+</span> : null}
            <span style={{ minWidth: 30, textAlign: "center", padding: "10px 16px 9px", color: ink, background: paper, border: `2px solid ${ink}`, borderBottomWidth: 5, borderRadius: 8, fontFamily: mono, fontSize: 25, fontWeight: 800, boxShadow: "0 10px 30px rgba(0,0,0,.35), 0 0 0 3px rgba(199,255,74,.85)" }}>{part}</span>
          </React.Fragment>
        ))}
      </div>
    </AbsoluteFill>
  );
}

function KeyCaps({ edit }) {
  return edit.keys.map((key, index) => {
    const next = edit.keys[index + 1];
    const duration = Math.max(8, Math.min(28, next ? next.from - key.from : 28));
    return (
      <Sequence key={`${key.label}-${key.from}`} from={key.from} durationInFrames={duration}>
        <KeyCap label={key.label} />
      </Sequence>
    );
  });
}

function AiPanel({ ai }) {
  const frame = useCurrentFrame();
  const enter = rise(frame, 4, 16);
  const exit = fall(frame, ai.duration - 12, 12);
  const lastRow = ai.rows.at(-1);
  const done = lastRow ? rise(frame, lastRow.at - ai.from + 12, 12) : 0;
  return (
    <div style={{
      position: "absolute",
      left: 890,
      top: 138,
      width: 548,
      color: paper,
      background: "rgba(9,13,11,.975)",
      border: "1px solid rgba(244,247,245,.22)",
      boxShadow: "0 30px 90px rgba(0,0,0,.45)",
      opacity: Math.min(enter, exit),
      transform: `translateX(${(1 - enter) * 60}px)`
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid rgba(244,247,245,.16)", fontFamily: mono, fontSize: 14, fontWeight: 700, letterSpacing: "0.08em" }}>
        <span style={{ color: lime }}>{ai.client.toUpperCase()} → EXPLORE BETTER MCP</span>
        <span style={{ color: ink, background: lime, padding: "4px 8px", borderRadius: 3 }}>READ-ONLY</span>
      </div>
      <div style={{ padding: "18px 20px 20px" }}>
        <div style={{ color: muted, fontFamily: mono, fontSize: 13, letterSpacing: "0.08em" }}>TASK</div>
        <div style={{ marginTop: 8, padding: "13px 15px", background: "#17201c", borderRadius: 4, fontFamily: body, fontSize: 22, lineHeight: 1.25 }}>{ai.task}</div>
        <div style={{ marginTop: 14 }}>
          {ai.rows.map((row) => {
            const p = rise(frame, row.at - ai.from, 10);
            return (
              <div key={row.tool} style={{ padding: "12px 0", borderTop: "1px solid rgba(244,247,245,.14)", opacity: p, transform: `translateY(${(1 - p) * 10}px)` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 5, background: lime, boxShadow: `0 0 ${10 * (1 - p) + 4}px ${lime}` }} />
                  <span style={{ color: lime, fontFamily: mono, fontSize: 18, fontWeight: 700 }}>{row.tool}</span>
                  <span style={{ marginLeft: "auto", color: muted, fontFamily: mono, fontSize: 13 }}>ok</span>
                </div>
                <div style={{ marginTop: 5, marginLeft: 19, color: paper, fontFamily: mono, fontSize: 15, opacity: 0.9 }}>{row.detail}</div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 10, padding: "13px 15px", color: ink, background: lime, borderRadius: 4, fontFamily: display, fontSize: 22, fontWeight: 800, opacity: done, transform: `translateY(${(1 - done) * 10}px)` }}>
          Revealed in your active pane. No pasted paths.
        </div>
        <div style={{ marginTop: 12, color: "rgba(244,247,245,.5)", fontFamily: mono, fontSize: 12, letterSpacing: "0.06em" }}>
          REAL RUN{ai.trimmedSeconds > 0 ? ` / ${ai.trimmedSeconds} S OF MODEL THINKING + WAITING TRIMMED` : ""}
        </div>
      </div>
    </div>
  );
}

function Hero({ total }) {
  const frame = useCurrentFrame();
  const panel = rise(frame, 0, 14) * fall(frame, total - 12, 12);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ background: "linear-gradient(90deg, rgba(17,23,21,.97) 0%, rgba(17,23,21,.94) 56%, rgba(17,23,21,.45) 78%, rgba(17,23,21,.12) 100%)", opacity: panel }} />
      <div style={{ position: "absolute", left: 84, top: 70, opacity: panel }}><Mark /></div>
      <div style={{ position: "absolute", left: 84, top: 300, width: 1160, opacity: panel }}>
        <div style={{ color: lime, fontFamily: mono, fontWeight: 700, fontSize: 20, letterSpacing: "0.12em", opacity: rise(frame, 2, 12) }}>REAL APP FOOTAGE / v0.2.7 / WINDOWS 11</div>
        <Words
          text="The Windows file manager built for humans and AI."
          frame={frame}
          start={4}
          stagger={2.2}
          style={{ marginTop: 24, color: paper, fontFamily: display, fontWeight: 800, fontSize: 104, lineHeight: 0.95, letterSpacing: "-0.055em" }}
        />
        <div style={{ marginTop: 30, width: 900, color: muted, fontFamily: display, fontWeight: 700, fontSize: 30, lineHeight: 1.2, opacity: rise(frame, 26, 14) }}>
          Fast for you. Safe with your files. Scoped for your AI.
        </div>
      </div>
    </AbsoluteFill>
  );
}

function ChapterRail({ edit }) {
  const frame = useCurrentFrame();
  const chapters = edit.chapters.filter((chapter) => chapter.id !== "open");
  const first = chapters[0].startFrame;
  const last = chapters.at(-1).endFrame;
  const visible = rise(frame, first, 10) * fall(frame, last - 6, 8);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 6, display: "flex", gap: 3, opacity: visible, background: "rgba(17,23,21,.7)" }}>
      {chapters.map((chapter) => {
        const fill = interpolate(frame, [chapter.startFrame, chapter.endFrame], [0, 1], clamp);
        return (
          <div key={chapter.id} style={{ flex: chapter.endFrame - chapter.startFrame, position: "relative", background: "rgba(244,247,245,.18)" }}>
            <div style={{ position: "absolute", inset: 0, background: lime, transformOrigin: "left", transform: `scaleX(${fill})` }} />
          </div>
        );
      })}
    </div>
  );
}

function EndCard({ total }) {
  const frame = useCurrentFrame();
  const bg = rise(frame, 0, 12);
  const recap = ["Filtered search", "Exact disk map", "Transactional copy", "Safe rename", "Keyboard menus", "Terminal", "Live AI context", "Scoped AI access"];
  const out = fall(frame, total - 8, 8);
  return (
    <AbsoluteFill style={{ background: `rgba(17,23,21,${0.55 + 0.4 * bg})`, color: paper, padding: "0 110px", justifyContent: "center", opacity: out }}>
      <div style={{ opacity: rise(frame, 4, 12), transform: `translateY(${(1 - rise(frame, 4, 12)) * 20}px)` }}><Mark size={64} label={30} /></div>
      <Words
        text="The Windows file manager built for humans and AI."
        frame={frame}
        start={8}
        stagger={1.8}
        style={{ marginTop: 44, width: 1000, fontFamily: display, fontWeight: 800, fontSize: 84, lineHeight: 0.96, letterSpacing: "-0.052em" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 22, marginTop: 38, opacity: rise(frame, 22, 12) }}>
        <div style={{ background: lime, color: ink, padding: "18px 26px", borderRadius: 5, fontFamily: display, fontWeight: 800, fontSize: 24 }}>Download for Windows</div>
        <div style={{ color: paper, fontFamily: mono, fontSize: 21 }}>terrorproforma.github.io/explore-better</div>
      </div>
      <div style={{ marginTop: 22, color: lime, fontFamily: mono, fontSize: 17, fontWeight: 700, letterSpacing: "0.1em", opacity: rise(frame, 28, 12) }}>FREE / OPEN SOURCE / WINDOWS 11 / LOCAL-FIRST</div>
      <div style={{ position: "absolute", left: 110, right: 110, bottom: 74, display: "flex", flexWrap: "wrap", gap: "10px 26px", color: muted, fontFamily: mono, fontSize: 15, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        {recap.map((item, index) => <span key={item} style={{ opacity: rise(frame, 30 + index * 2, 10) }}>{String(index + 1).padStart(2, "0")} {item}</span>)}
      </div>
    </AbsoluteFill>
  );
}

export function ExploreBetterV6({ edit }) {
  if (!edit) {
    return <AbsoluteFill style={{ background: ink, color: paper, fontFamily: mono, justifyContent: "center", alignItems: "center", fontSize: 28 }}>Run npm run render:v6 to build the v6 edit.</AbsoluteFill>;
  }
  const open = edit.chapters.find((chapter) => chapter.id === "open");
  const endLength = edit.durationInFrames - edit.endFrom;
  return (
    <AbsoluteFill style={{ background: ink, fontFamily: body, overflow: "hidden" }}>
      <Stage edit={edit} />
      <AbsoluteFill style={{ boxShadow: "inset 0 0 180px rgba(0,0,0,.18)", pointerEvents: "none" }} />
      <Sequence from={0} durationInFrames={open.endFrame + 10}><Hero total={open.endFrame + 10} /></Sequence>
      <Captions edit={edit} />
      <KeyCaps edit={edit} />
      <Sequence from={edit.ai.from} durationInFrames={edit.ai.duration}><AiPanel ai={edit.ai} /></Sequence>
      <ChapterRail edit={edit} />
      <Sequence from={edit.endFrom} durationInFrames={endLength}><EndCard total={endLength} /></Sequence>
    </AbsoluteFill>
  );
}
