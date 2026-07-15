import React from "react";
import {
  AbsoluteFill,
  Composition,
  Easing,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig
} from "remotion";

const ink = "#111715";
const lime = "#c7ff4a";
const paper = "#f4f7f5";
const muted = "#c8cfca";
const display = 'Bahnschrift, "Aptos Display", "Segoe UI", sans-serif';
const body = 'Aptos, "Segoe UI", sans-serif';
const mono = 'Consolas, "Cascadia Mono", monospace';

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" };

function easeIn(frame, from, duration = 18) {
  return interpolate(frame, [from, from + duration], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
}

function easeOut(frame, from, duration = 18) {
  return interpolate(frame, [from, from + duration], [1, 0], { ...clamp, easing: Easing.in(Easing.cubic) });
}

function Mark({ inverse = false, compact = false }) {
  const size = compact ? 42 : 54;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <Img src={staticFile("brand-mark.svg")} style={{ width: size, height: size, display: "block" }} />
      <div style={{
        color: inverse ? paper : ink,
        fontFamily: display,
        fontSize: compact ? 20 : 25,
        fontWeight: 750,
        letterSpacing: "-0.02em"
      }}>Explore Better</div>
    </div>
  );
}

function Eyebrow({ children, color = lime }) {
  return <div style={{ color, fontFamily: mono, fontWeight: 700, fontSize: 20, letterSpacing: "0.12em", textTransform: "uppercase" }}>{children}</div>;
}

const tightEdits = [
  { from: 0, duration: 504, sourceStart: 0 },
  { from: 504, duration: 252, sourceStart: 558 },
  { from: 756, duration: 246, sourceStart: 849 },
  { from: 1002, duration: 219, sourceStart: 1206 },
  { from: 1221, duration: 149, sourceStart: 1425 }
];

const valueEdits = [
  { from: 0, duration: 480, sourceStart: 0 },
  { from: 480, duration: 270, sourceStart: 576 },
  { from: 750, duration: 345, sourceStart: 864 },
  { from: 1095, duration: 75, sourceStart: 1218 },
  { from: 1170, duration: 90, sourceStart: 1800 },
  { from: 1260, duration: 90, sourceStart: 1872 },
  { from: 1350, duration: 210, sourceStart: 1970 },
  { from: 1560, duration: 240, sourceStart: 2193 },
  { from: 1800, duration: 135, sourceStart: 2397 }
];

function EditedAppVideo({ style }) {
  return tightEdits.map((edit) => (
    <Sequence key={edit.from} from={edit.from} durationInFrames={edit.duration}>
      <OffthreadVideo src={staticFile("live.mp4")} startFrom={edit.sourceStart} muted style={style} />
    </Sequence>
  ));
}

function ValueAppVideo({ style }) {
  return valueEdits.map((edit) => (
    <Sequence key={edit.from} from={edit.from} durationInFrames={edit.duration}>
      <OffthreadVideo src={staticFile("live.mp4")} startFrom={edit.sourceStart} muted style={style} />
    </Sequence>
  ));
}

function EditFlash({ at }) {
  const frame = useCurrentFrame();
  const distance = Math.abs(frame - at);
  const opacity = interpolate(distance, [0, 1, 4], [0.2, 0.09, 0], clamp);
  return <div style={{ position: "absolute", inset: 0, opacity, border: `3px solid ${lime}`, background: "rgba(199,255,74,.08)", pointerEvents: "none" }} />;
}

function AppStage({ tight = false }) {
  const frame = useCurrentFrame();
  const inset = interpolate(frame, tight ? [120, 175] : [145, 210], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const finalDim = interpolate(frame, tight ? [1282, 1350] : [1545, 1625], [0, 0.82], clamp);
  const zoom = interpolate(
    frame,
    tight
      ? [0, 120, 180, 220, 340, 500, 535, 745, 780, 990, 1035, 1215, 1285, 1370]
      : [0, 145, 225, 320, 430, 560, 650, 820, 900, 1050, 1230, 1380, 1500, 1650],
    tight
      ? [1.15, 1.1, 1.0, 1.08, 1.02, 1.0, 1.05, 1.02, 1.09, 1.055, 1.0, 1.08, 1.1, 1.06]
      : [1.15, 1.1, 1.0, 1.08, 1.02, 1.0, 1.05, 1.02, 1.09, 1.06, 1.0, 1.08, 1.1, 1.06],
    { ...clamp, easing: Easing.inOut(Easing.cubic) }
  );
  const x = interpolate(
    frame,
    tight ? [0, 205, 340, 500, 745, 780, 990, 1035, 1215, 1370] : [0, 300, 430, 600, 820, 900, 1050, 1230, 1400, 1650],
    tight ? [0, -18, 0, -20, 0, -55, -42, 0, -25, 0] : [0, -18, 0, -20, 0, -55, -42, 0, -25, 0],
    clamp
  );
  const y = interpolate(
    frame,
    tight ? [0, 340, 500, 535, 745, 780, 990, 1035, 1215, 1370] : [0, 430, 560, 650, 820, 900, 1050, 1230, 1400, 1650],
    tight ? [0, 0, -15, -12, 0, -44, -48, 0, -10, 0] : [0, 0, -15, -12, 0, -44, -48, 0, -10, 0],
    clamp
  );
  const videoStyle = {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: "100%",
    height: "100%",
    objectFit: "cover",
    objectPosition: "center",
    transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${zoom})`,
    transformOrigin: "center",
    filter: "saturate(.92) contrast(1.03)"
  };
  return (
    <AbsoluteFill style={{ backgroundColor: ink }}>
      <div style={{
        position: "absolute",
        left: 80 * inset,
        top: 84 * inset,
        width: 1920 - 160 * inset,
        height: 1080 - 180 * inset,
        overflow: "hidden",
        background: paper,
        borderRadius: 5 * inset,
        border: `${inset}px solid rgba(244,247,245,.28)`,
        boxShadow: inset ? "0 40px 110px rgba(0,0,0,.34)" : "none"
      }}>
        {tight ? <EditedAppVideo style={videoStyle} /> : <OffthreadVideo src={staticFile("live.mp4")} muted style={videoStyle} />}
        <div style={{ position: "absolute", inset: 0, background: `rgba(17,23,21,${0.03 + finalDim})` }} />
        {tight && tightEdits.slice(1).map((edit) => <EditFlash key={edit.from} at={edit.from} />)}
      </div>
      <div style={{
        position: "absolute",
        left: 80,
        top: 48,
        right: 80,
        opacity: inset,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center"
      }}>
        <Mark inverse compact />
        <div style={{ color: lime, fontFamily: mono, fontWeight: 700, letterSpacing: "0.12em", fontSize: 15 }}>WINDOWS 11 / LOCAL-FIRST / HUMAN + AI</div>
      </div>
    </AbsoluteFill>
  );
}

function ValueStage() {
  const frame = useCurrentFrame();
  const zoom = interpolate(
    frame,
    [0, 120, 170, 285, 330, 375, 465, 480, 545, 710, 750, 825, 1050, 1095, 1320, 1380, 1510, 1560, 1630, 1770, 1935],
    [1, 1, 1.028, 1.012, 1, 1.026, 1.008, 1, 1.028, 1.008, 1, 1.03, 1.008, 1, 1, 1.018, 1.004, 1, 1.026, 1.004, 1],
    { ...clamp, easing: Easing.inOut(Easing.cubic) }
  );
  const finalDim = interpolate(frame, [1852, 1925], [0, 0.9], clamp);
  const videoStyle = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    objectPosition: "center",
    transform: `scale(${zoom})`,
    transformOrigin: "center",
    filter: "saturate(.94) contrast(1.025)"
  };
  return (
    <AbsoluteFill style={{ backgroundColor: ink, overflow: "hidden" }}>
      <ValueAppVideo style={videoStyle} />
      <div style={{ position: "absolute", inset: 0, background: `rgba(17,23,21,${0.015 + finalDim})` }} />
      {valueEdits.slice(1).map((edit) => <EditFlash key={edit.from} at={edit.from} />)}
    </AbsoluteFill>
  );
}

function Hero() {
  const frame = useCurrentFrame();
  const inA = easeIn(frame, 8, 24);
  const inB = easeIn(frame, 26, 24);
  const out = easeOut(frame, 132, 22);
  const opacity = inA * out;
  return (
    <AbsoluteFill style={{ color: paper, padding: "64px 86px", background: "linear-gradient(90deg, rgba(17,23,21,.96) 0%, rgba(17,23,21,.78) 48%, rgba(17,23,21,.15) 100%)" }}>
      <div style={{ opacity, transform: `translateY(${(1 - inA) * 20}px)` }}><Mark inverse /></div>
      <div style={{ marginTop: 98, width: 1290, opacity }}>
        <Eyebrow>Windows 11 / Local-first / Human + AI</Eyebrow>
        <h1 style={{ margin: "32px 0 28px", fontFamily: display, fontSize: 112, lineHeight: 0.94, letterSpacing: "-0.055em", fontWeight: 800 }}>
          The Windows file manager built for humans and AI.
        </h1>
        <div style={{ opacity: inB, fontFamily: display, fontSize: 32, lineHeight: 1.18, fontWeight: 750, width: 1050 }}>
          A serious Explorer replacement for people who have outgrown File Explorer.
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 38, opacity: inB }}>
          <div style={{ background: lime, color: ink, padding: "18px 25px", borderRadius: 5, fontFamily: display, fontWeight: 750, fontSize: 21 }}>Download for Windows</div>
          <div style={{ border: "1px solid rgba(244,247,245,.65)", padding: "17px 24px", borderRadius: 5, fontFamily: display, fontWeight: 750, fontSize: 21 }}>See the AI proof</div>
        </div>
      </div>
    </AbsoluteFill>
  );
}

function ValueHero() {
  const frame = useCurrentFrame();
  const enter = easeIn(frame, 5, 22);
  const detail = easeIn(frame, 25, 20);
  const exit = easeOut(frame, 92, 24);
  return (
    <AbsoluteFill style={{ color: paper, padding: "62px 78px", background: "linear-gradient(90deg, rgba(17,23,21,.96) 0%, rgba(17,23,21,.72) 55%, rgba(17,23,21,.08) 100%)" }}>
      <div style={{ opacity: enter * exit }}><Mark inverse /></div>
      <div style={{ marginTop: 138, width: 1220, opacity: enter * exit, transform: `translateY(${(1 - enter) * 20}px)` }}>
        <Eyebrow>One workspace / two operators</Eyebrow>
        <div style={{ marginTop: 24, fontFamily: display, fontWeight: 800, fontSize: 108, lineHeight: 0.92, letterSpacing: "-0.055em" }}>
          Your files.<br />Shared context.
        </div>
        <div style={{ marginTop: 30, width: 980, fontFamily: display, fontWeight: 750, fontSize: 34, lineHeight: 1.15, opacity: detail }}>
          The Windows file manager that keeps humans fast—and gives AI the same workspace without giving up control.
        </div>
      </div>
    </AbsoluteFill>
  );
}

function ValueCard({ eyebrow, title, detail, metric, align = "left", exitAt = 170 }) {
  const frame = useCurrentFrame();
  const enter = easeIn(frame, 0, 18);
  const detailIn = easeIn(frame, 18, 18);
  const exit = easeOut(frame, exitAt, 18);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: align === "right" ? "flex-end" : "flex-start", padding: "0 72px 66px", pointerEvents: "none" }}>
      <div style={{ width: 760, color: paper, background: "rgba(17,23,21,.965)", borderTop: `8px solid ${lime}`, padding: "25px 30px 28px", boxShadow: "0 24px 80px rgba(0,0,0,.35)", opacity: enter * exit, transform: `translateY(${(1 - enter) * 42}px)` }}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <div style={{ marginTop: 14, fontFamily: display, fontWeight: 800, fontSize: 53, lineHeight: 0.98, letterSpacing: "-0.048em" }}>{title}</div>
        <div style={{ marginTop: 18, color: muted, fontFamily: body, fontSize: 22, lineHeight: 1.28, opacity: detailIn }}>{detail}</div>
        {metric ? <div style={{ marginTop: 19, display: "inline-flex", color: ink, background: lime, padding: "9px 12px", borderRadius: 3, fontFamily: mono, fontSize: 15, fontWeight: 700, letterSpacing: "0.04em", opacity: detailIn }}>{metric}</div> : null}
      </div>
    </AbsoluteFill>
  );
}

function CodexHandoff() {
  const frame = useCurrentFrame();
  const intro = easeIn(frame, 0, 20) * easeOut(frame, 370, 24);
  const panel = easeIn(frame, 22, 18) * easeOut(frame, 370, 24);
  const context = easeIn(frame, 76, 14);
  const search = easeIn(frame, 165, 14);
  const reveal = easeIn(frame, 255, 14);
  const done = easeIn(frame, 315, 16);
  const row = (label, value, progress) => (
    <div style={{ display: "grid", gridTemplateColumns: "205px 1fr", gap: 18, alignItems: "center", padding: "17px 0", borderTop: "1px solid rgba(244,247,245,.17)", opacity: progress, transform: `translateY(${(1 - progress) * 12}px)` }}>
      <div style={{ color: lime, fontFamily: mono, fontSize: 16, fontWeight: 700 }}>{label}</div>
      <div style={{ color: paper, fontFamily: mono, fontSize: 16, lineHeight: 1.28 }}>{value}</div>
    </div>
  );
  return (
    <AbsoluteFill style={{ color: paper, pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: 70, top: 88, width: 760, padding: "24px 28px 28px", background: "rgba(17,23,21,.94)", borderLeft: `8px solid ${lime}`, opacity: intro }}>
        <Eyebrow>Codex + Explore Better / live handoff</Eyebrow>
        <div style={{ marginTop: 15, fontFamily: display, fontSize: 56, fontWeight: 800, lineHeight: 0.96, letterSpacing: "-0.05em" }}>
          Your AI sees the same folder you do.
        </div>
        <div style={{ marginTop: 17, color: muted, fontFamily: body, fontSize: 22 }}>No pasted paths. No terminal scraping. No guessing which pane you meant.</div>
      </div>

      <div style={{ position: "absolute", top: 62, right: 62, bottom: 62, width: 720, background: "rgba(9,13,11,.985)", border: "1px solid rgba(244,247,245,.28)", boxShadow: "0 30px 100px rgba(0,0,0,.5)", opacity: panel, transform: `translateX(${(1 - panel) * 80}px)` }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "18px 22px", color: lime, borderBottom: "1px solid rgba(244,247,245,.18)", fontFamily: mono, fontSize: 14, fontWeight: 700, letterSpacing: "0.07em" }}>
          <span>CODEX / EXPLORE-BETTER</span><span>READ-ONLY</span>
        </div>
        <div style={{ padding: "24px 26px" }}>
          <div style={{ color: muted, fontFamily: mono, fontSize: 13, letterSpacing: "0.05em" }}>PROMPT</div>
          <div style={{ marginTop: 9, padding: "16px 18px", color: paper, background: "#17201c", borderRadius: 4, fontFamily: body, fontSize: 23, lineHeight: 1.26 }}>
            Find the launch README and reveal it in my active pane.
          </div>
          <div style={{ marginTop: 22 }}>
            {row("get_context", "LIVE / LEFT PANE / PROJECT FILES", context)}
            {row("search_files", "README.md / 1 MATCH / 18 SCANNED", search)}
            {row("show_in_explore_better", "README.md / ACTIVE PANE", reveal)}
          </div>
          <div style={{ marginTop: 22, padding: "17px 18px", color: ink, background: lime, borderRadius: 4, fontFamily: display, fontSize: 22, fontWeight: 800, lineHeight: 1.18, opacity: done }}>
            Found—and revealed exactly where you are working.
          </div>
        </div>
        <div style={{ position: "absolute", right: 22, bottom: 18, color: "rgba(244,247,245,.48)", fontFamily: mono, fontSize: 12, letterSpacing: "0.05em" }}>REAL RUN / REPLAYED AT EDIT SPEED</div>
      </div>
    </AbsoluteFill>
  );
}

function ScopeStory() {
  const frame = useCurrentFrame();
  const enter = easeIn(frame, 0, 18);
  const exit = easeOut(frame, 180, 20);
  const detail = easeIn(frame, 25, 18);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", padding: "0 72px 66px", pointerEvents: "none" }}>
      <div style={{ width: 780, color: paper, background: "rgba(17,23,21,.97)", borderTop: `8px solid ${lime}`, padding: "26px 31px 29px", opacity: enter * exit, boxShadow: "0 24px 80px rgba(0,0,0,.4)" }}>
        <Eyebrow>Per-client authority / local by design</Eyebrow>
        <div style={{ marginTop: 14, fontFamily: display, fontSize: 55, fontWeight: 800, lineHeight: 0.97, letterSpacing: "-0.05em" }}>Give every AI exactly the access it needs.</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 11, marginTop: 22, opacity: detail }}>
          {["SCOPED ROOTS", "READ-FIRST", "REVOCABLE", "PREVIEW BEFORE WRITES"].map((item) => <div key={item} style={{ padding: "9px 11px", color: lime, border: "1px solid rgba(199,255,74,.55)", borderRadius: 3, fontFamily: mono, fontSize: 14, fontWeight: 700 }}>{item}</div>)}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function HumanAi({ exitAt = 150 }) {
  const frame = useCurrentFrame();
  const p = spring({ frame, fps: 30, config: { damping: 18, stiffness: 110, mass: 0.8 } });
  const exit = easeOut(frame, exitAt, 18);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", padding: "0 80px 72px" }}>
      <div style={{
        background: lime,
        color: ink,
        borderRadius: 5,
        display: "grid",
        gridTemplateColumns: "1.18fr 1fr",
        gap: 36,
        padding: "32px 38px 34px",
        transform: `translateY(${(1 - p) * 210}px)`,
        opacity: p * exit,
        boxShadow: "0 22px 80px rgba(0,0,0,.25)"
      }}>
        <div>
          <Eyebrow color={ink}>One workspace / two operators</Eyebrow>
          <div style={{ marginTop: 17, fontFamily: display, fontWeight: 800, fontSize: 48, lineHeight: 0.98, letterSpacing: "-0.045em" }}>
            You stay in control.<br />Your AI stops guessing.
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 22, alignItems: "end" }}>
          {["See", "Understand", "Act safely"].map((label, index) => (
            <div key={label} style={{ borderTop: `2px solid ${ink}`, paddingTop: 13, opacity: easeIn(frame, 22 + index * 8, 14) }}>
              <div style={{ fontFamily: mono, fontSize: 15, fontWeight: 700 }}>0{index + 1}</div>
              <div style={{ marginTop: 8, fontFamily: display, fontSize: 25, fontWeight: 800 }}>{label}</div>
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function FeatureTag({ eyebrow, title, align = "left", width = 660, exitAt = 115 }) {
  const frame = useCurrentFrame();
  const p = easeIn(frame, 0, 18) * easeOut(frame, exitAt, 18);
  return (
    <AbsoluteFill style={{ justifyContent: align === "bottom" ? "flex-end" : "flex-start", alignItems: align === "right" ? "flex-end" : "flex-start", padding: "145px 108px 104px", pointerEvents: "none" }}>
      <div style={{
        width,
        background: ink,
        color: paper,
        borderLeft: `8px solid ${lime}`,
        padding: "23px 28px 26px",
        opacity: p,
        transform: `translateX(${(1 - p) * (align === "right" ? 55 : -55)}px)`,
        boxShadow: "0 22px 60px rgba(0,0,0,.28)"
      }}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <div style={{ fontFamily: display, fontWeight: 800, fontSize: 51, lineHeight: 0.98, letterSpacing: "-0.045em", marginTop: 14 }}>{title}</div>
      </div>
    </AbsoluteFill>
  );
}

function TerminalStory({ exitAt = 338 }) {
  const frame = useCurrentFrame();
  const p = easeIn(frame, 0, 18) * easeOut(frame, exitAt, 18);
  const detail = easeIn(frame, 34, 22);
  return (
    <AbsoluteFill style={{ padding: "166px 108px", justifyContent: "flex-end", alignItems: "flex-end" }}>
      <div style={{ width: 710, background: lime, color: ink, padding: "30px 34px 32px", borderRadius: 5, opacity: p, transform: `translateY(${(1 - p) * 50}px)` }}>
        <Eyebrow color={ink}>Terminal / per file tab</Eyebrow>
        <div style={{ fontFamily: display, fontSize: 57, fontWeight: 800, letterSpacing: "-0.05em", lineHeight: 0.96, marginTop: 16 }}>
          The shell is already in the right folder.
        </div>
        <div style={{ fontFamily: body, fontSize: 23, lineHeight: 1.28, marginTop: 21, opacity: detail }}>
          Open it only when needed. Keep the process alive while switching tabs. Stop rebuilding paths by hand.
        </div>
      </div>
    </AbsoluteFill>
  );
}

function SafetyStory() {
  const frame = useCurrentFrame();
  const p = easeIn(frame, 0, 18) * easeOut(frame, 88, 18);
  const detail = easeIn(frame, 26, 20);
  return (
    <AbsoluteFill style={{ padding: "154px 108px", justifyContent: "flex-start", alignItems: "flex-start" }}>
      <div style={{ width: 760, background: ink, color: paper, padding: "27px 34px 30px", borderTop: `8px solid ${lime}`, opacity: p, transform: `translateY(${(1 - p) * -42}px)`, boxShadow: "0 22px 80px rgba(0,0,0,.34)" }}>
        <Eyebrow>Preview / journal / recovery</Eyebrow>
        <div style={{ fontFamily: display, fontSize: 57, fontWeight: 800, letterSpacing: "-0.05em", lineHeight: 0.96, marginTop: 16 }}>
          Fast should never mean reckless.
        </div>
        <div style={{ fontFamily: body, fontSize: 22, lineHeight: 1.28, color: muted, marginTop: 18, opacity: detail }}>
          Copy, move, overwrite, and sync operations are staged, journaled, and recoverable after interruption.
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 21, opacity: detail }}>
          {["01 / PLAN", "02 / STAGE", "03 / COMMIT"].map((item) => (
            <div key={item} style={{ color: lime, border: "1px solid rgba(199,255,74,.55)", borderRadius: 3, padding: "9px 12px", fontFamily: mono, fontSize: 14, fontWeight: 700 }}>{item}</div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function AiBridgeStory({ exitAt = 185 }) {
  const frame = useCurrentFrame();
  const p = easeIn(frame, 0, 20) * easeOut(frame, exitAt, 20);
  return (
    <AbsoluteFill style={{ padding: "164px 108px", justifyContent: "flex-start", alignItems: "flex-start" }}>
      <div style={{ width: 720, background: ink, color: paper, padding: "28px 34px 32px", borderTop: `8px solid ${lime}`, opacity: p, transform: `translateY(${(1 - p) * -45}px)`, boxShadow: "0 22px 80px rgba(0,0,0,.35)" }}>
        <Eyebrow>Local MCP / explicit boundaries</Eyebrow>
        <div style={{ fontFamily: display, fontSize: 57, fontWeight: 800, letterSpacing: "-0.05em", lineHeight: 0.96, marginTop: 17 }}>
          Give AI file tools, not a pile of terminal text.
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 24, flexWrap: "wrap" }}>
          {["READ-FIRST PROFILES", "SCOPED ROOTS", "PREVIEW BEFORE WRITES"].map((item) => (
            <div key={item} style={{ color: lime, border: "1px solid rgba(199,255,74,.58)", borderRadius: 3, padding: "10px 12px", fontFamily: mono, fontSize: 14, fontWeight: 700 }}>{item}</div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function ProofStrip({ exitAt = 86 }) {
  const frame = useCurrentFrame();
  const p = spring({ frame, fps: 30, config: { damping: 20, stiffness: 120 } });
  const out = easeOut(frame, exitAt, 16);
  const proofs = [
    ["54.7x", "lower median search latency*"],
    ["28 tools", "typed local MCP surface"],
    ["Preview + undo", "recoverable file changes"]
  ];
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", padding: "0 80px 72px" }}>
      <div style={{ background: lime, color: ink, display: "grid", gridTemplateColumns: "repeat(3,1fr)", borderRadius: 5, transform: `translateY(${(1 - p) * 180}px)`, opacity: p * out }}>
        {proofs.map(([value, label], index) => (
          <div key={value} style={{ padding: "26px 30px 29px", borderLeft: index ? "1px solid rgba(17,23,21,.32)" : "none" }}>
            <div style={{ fontFamily: display, fontSize: value.length > 10 ? 38 : 51, lineHeight: 1, fontWeight: 800, letterSpacing: "-0.04em" }}>{value}</div>
            <div style={{ marginTop: 10, fontFamily: mono, fontSize: 16, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
}

function Final() {
  const frame = useCurrentFrame();
  const p = easeIn(frame, 0, 18);
  return (
    <AbsoluteFill style={{ background: `rgba(17,23,21,${0.35 + 0.65 * p})`, color: paper, padding: "68px 86px", justifyContent: "center" }}>
      <div style={{ opacity: p, transform: `translateY(${(1 - p) * 25}px)` }}>
        <Mark inverse />
        <div style={{ marginTop: 54, fontFamily: display, fontSize: 78, lineHeight: 0.96, letterSpacing: "-0.052em", fontWeight: 800, width: 1430 }}>
          The Windows file manager built for humans and AI.
        </div>
        <div style={{ marginTop: 30, display: "flex", alignItems: "center", gap: 22 }}>
          <div style={{ background: lime, color: ink, padding: "17px 24px", borderRadius: 5, fontFamily: display, fontWeight: 800, fontSize: 22 }}>Download for Windows</div>
          <div style={{ color: muted, fontFamily: mono, fontSize: 19 }}>terrorproforma.github.io/explore-better</div>
        </div>
      </div>
    </AbsoluteFill>
  );
}

export function ExploreBetterV2() {
  return (
    <AbsoluteFill style={{ background: ink, fontFamily: body }}>
      <AppStage />
      <Sequence from={0} durationInFrames={165}><Hero /></Sequence>
      <Sequence from={155} durationInFrames={170}><HumanAi /></Sequence>
      <Sequence from={310} durationInFrames={100}><FeatureTag eyebrow="Command Center / keyboard-first" title="Stay inside the flow." exitAt={70} /></Sequence>
      <Sequence from={390} durationInFrames={100}><FeatureTag eyebrow="Size Analyzer / nested file map" title="See where every byte went." align="right" width={690} exitAt={70} /></Sequence>
      <Sequence from={585} durationInFrames={245}><SafetyStory /></Sequence>
      <Sequence from={850} durationInFrames={375}><TerminalStory /></Sequence>
      <Sequence from={1230} durationInFrames={265}><AiBridgeStory /></Sequence>
      <Sequence from={1435} durationInFrames={110}><ProofStrip /></Sequence>
      <Sequence from={1535} durationInFrames={115}><Final /></Sequence>
    </AbsoluteFill>
  );
}

export function ExploreBetterTight() {
  return (
    <AbsoluteFill style={{ background: ink, fontFamily: body }}>
      <AppStage tight />
      <Sequence from={0} durationInFrames={140}><Hero /></Sequence>
      <Sequence from={128} durationInFrames={105}><HumanAi exitAt={65} /></Sequence>
      <Sequence from={205} durationInFrames={85}><FeatureTag eyebrow="Command Center / keyboard-first" title="Stay inside the flow." exitAt={55} /></Sequence>
      <Sequence from={385} durationInFrames={90}><FeatureTag eyebrow="Size Analyzer / nested file map" title="See where every byte went." align="right" width={690} exitAt={60} /></Sequence>
      <Sequence from={500} durationInFrames={110}><SafetyStory /></Sequence>
      <Sequence from={768} durationInFrames={220}><TerminalStory exitAt={190} /></Sequence>
      <Sequence from={1075} durationInFrames={145}><AiBridgeStory exitAt={120} /></Sequence>
      <Sequence from={1218} durationInFrames={92}><ProofStrip exitAt={70} /></Sequence>
      <Sequence from={1290} durationInFrames={80}><Final /></Sequence>
    </AbsoluteFill>
  );
}

export function ExploreBetterValue() {
  return (
    <AbsoluteFill style={{ background: ink, fontFamily: body }}>
      <ValueStage />
      <Sequence from={0} durationInFrames={120}><ValueHero /></Sequence>
      <Sequence from={120} durationInFrames={210}><ValueCard eyebrow="Search + Command / zero hunting" title="Go from thought to file without breaking flow." detail="Filter instantly, then launch any action from one keyboard-first command surface." metric="54.7x LOWER MEDIAN SEARCH LATENCY*" exitAt={180} /></Sequence>
      <Sequence from={330} durationInFrames={150}><ValueCard eyebrow="Size Analyzer / clarity at a glance" title="Find what is eating the drive—visually." detail="Logical and allocated bytes stay nested under the folders that caused them." align="right" exitAt={120} /></Sequence>
      <Sequence from={510} durationInFrames={225}><ValueCard eyebrow="Transfer preview / nothing hidden" title="Know what will happen before a byte moves." detail="See conflicts, renames, and destinations before commit. Every operation is journaled and recoverable." metric="PREVIEW / STAGE / COMMIT / RECOVER" exitAt={195} /></Sequence>
      <Sequence from={780} durationInFrames={300}><ValueCard eyebrow="Per-tab terminal / no setup tax" title="A real shell, already in the right folder." detail="The session stays with its file tab. No cd. No rebuilt paths. No context switch." align="right" exitAt={270} /></Sequence>
      <Sequence from={1095} durationInFrames={405}><CodexHandoff /></Sequence>
      <Sequence from={1590} durationInFrames={210}><ScopeStory /></Sequence>
      <Sequence from={1788} durationInFrames={90}><ProofStrip exitAt={65} /></Sequence>
      <Sequence from={1860} durationInFrames={75}><Final /></Sequence>
    </AbsoluteFill>
  );
}

export function Root() {
  return (
    <>
      <Composition
        id="ExploreBetterV2"
        component={ExploreBetterV2}
        durationInFrames={1650}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="ExploreBetterTight"
        component={ExploreBetterTight}
        durationInFrames={1370}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="ExploreBetterValue"
        component={ExploreBetterValue}
        durationInFrames={1935}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
}
