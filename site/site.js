// Explore Better website behaviour. Every page works without this file; it adds the mobile
// menu, copy buttons, demo chapters, benchmark bars, and feature-clip playback. The
// legacy-*.html archives use the frozen script.js instead.
document.documentElement.classList.add("js");

const header = document.querySelector("[data-header]");
const nav = document.querySelector("[data-nav]");
const navToggle = document.querySelector("[data-nav-toggle]");
// Must match the site.css breakpoint that shows .nav-toggle (max-width: 960px).
const desktopNavigation = window.matchMedia("(min-width: 961px)");

function setNavigation(open) {
  nav?.classList.toggle("open", open);
  header?.classList.toggle("nav-visible", open);
  document.body.classList.toggle("nav-open", open);
  navToggle?.setAttribute("aria-expanded", String(open));
  const label = navToggle?.querySelector(".sr-only");
  if (label) label.textContent = open ? "Close navigation" : "Open navigation";
}

navToggle?.addEventListener("click", () => {
  setNavigation(navToggle.getAttribute("aria-expanded") !== "true");
});

nav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => setNavigation(false));
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || navToggle?.getAttribute("aria-expanded") !== "true") return;
  setNavigation(false);
  navToggle.focus();
});

desktopNavigation.addEventListener("change", (event) => {
  if (event.matches) setNavigation(false);
});

// Copy buttons: clipboard API first, then a hidden-textarea fallback that restores focus.
document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", async () => {
    const source = document.querySelector(button.dataset.copyTarget || "");
    const status = document.querySelector(button.dataset.copyStatusTarget || "");
    const value = source?.textContent?.trim() || "";
    if (!value) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch {
      const previousFocus = document.activeElement;
      const input = document.createElement("textarea");
      input.value = value;
      input.readOnly = true;
      input.style.position = "fixed";
      input.style.opacity = "0";
      try {
        document.body.append(input);
        input.select();
        copied = document.execCommand("copy") === true;
      } catch {
        copied = false;
      } finally {
        input.remove();
        previousFocus?.focus({ preventScroll: true });
      }
    }
    if (status) status.textContent = copied
      ? button.dataset.copySuccess || "Copied"
      : "Could not copy. Select and copy the text manually.";
  });
});

// Demo chapters come from the VideoObject's hasPart clips in the page's JSON-LD, so the
// visible list and the search-engine key moments cannot drift apart.
function videoClips() {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent || "{}");
      const nodes = Array.isArray(data["@graph"]) ? data["@graph"] : [data];
      // The demo is the VideoObject with chapters; feature clips are VideoObjects without.
      const video = nodes.find((node) => node?.["@type"] === "VideoObject" && Array.isArray(node.hasPart));
      if (Array.isArray(video?.hasPart)) {
        return video.hasPart
          .filter((clip) => clip?.["@type"] === "Clip" && Number.isFinite(Number(clip.startOffset)))
          .map((clip) => ({ name: String(clip.name || ""), start: Number(clip.startOffset) }))
          .sort((a, b) => a.start - b.start);
      }
    } catch {
      // Invalid structured data is reported by the SEO smoke test; the page still works.
    }
  }
  return [];
}

function clock(seconds) {
  const whole = Math.round(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

const demoVideo = document.querySelector("[data-demo-video]");
const chapterNav = document.querySelector("[data-chapters]");
const chapterList = document.querySelector("[data-chapter-list]");
const chapterButtons = [];

function setChapterState(active) {
  chapterButtons.forEach((button) => {
    if (button === active) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  });
}

function syncChapter() {
  if (!demoVideo || !chapterButtons.length) return;
  const current = demoVideo.currentTime;
  let active = chapterButtons[0];
  chapterButtons.forEach((button) => {
    if (Number(button.dataset.demoTime) <= current + 0.05) active = button;
  });
  setChapterState(active);
}

function seekDemo(seconds, play) {
  if (!demoVideo) return;
  const apply = () => {
    demoVideo.currentTime = seconds;
    syncChapter();
  };
  if (demoVideo.readyState >= 1) apply();
  else {
    demoVideo.addEventListener("loadedmetadata", apply, { once: true });
    if (demoVideo.preload === "none") demoVideo.preload = "metadata";
    demoVideo.load();
  }
  if (play) demoVideo.play().catch(() => {});
}

if (demoVideo && chapterNav && chapterList) {
  for (const clip of videoClips()) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.demoTime = String(clip.start);
    const time = document.createElement("span");
    time.className = "chapters__time";
    time.textContent = clock(clip.start);
    const name = document.createElement("span");
    name.textContent = clip.name;
    button.append(time, name);
    button.setAttribute("aria-label", `${clip.name}, starts at ${clock(clip.start)}`);
    button.addEventListener("click", () => {
      seekDemo(clip.start, true);
      setChapterState(button);
    });
    item.append(button);
    chapterList.append(item);
    chapterButtons.push(button);
  }
  if (chapterButtons.length) {
    chapterNav.hidden = false;
    setChapterState(chapterButtons[0]);
  }
  demoVideo.addEventListener("timeupdate", syncChapter);
  demoVideo.addEventListener("seeked", syncChapter);

  // Clip URLs in the structured data use #t=<seconds>; honour them on arrival.
  const deepLink = /^#t=(\d+(?:\.\d+)?)$/.exec(window.location.hash);
  if (deepLink) {
    document.getElementById("demo")?.scrollIntoView();
    seekDemo(Number(deepLink[1]), false);
  }
}

// Benchmark bars: widths are derived from the published numbers, which
// scripts/mcp-value-benchmark.mjs rewrites, so the bars never go stale.
document.querySelectorAll("[data-benchmark-row]").forEach((row) => {
  const cells = [...row.querySelectorAll("[data-benchmark]")];
  const values = cells.map((cell) => Number.parseFloat(cell.textContent || ""));
  const largest = Math.max(...values.filter(Number.isFinite));
  if (!Number.isFinite(largest) || largest <= 0) return;
  cells.forEach((cell, index) => {
    const bar = cell.parentElement?.querySelector(".bar");
    if (bar && Number.isFinite(values[index])) bar.style.setProperty("--share", String((values[index] / largest) * 100));
  });
});

// Feature clips: short silent loops (scripts/build-feature-media.mjs writes the markup). A clip
// plays while at least half of it is on screen, at most two at a time (the most visible win),
// and only loads when it comes near the viewport. Reduced motion or Save-Data means nothing
// plays by itself. Every clip gets a play/pause toggle in place of the no-JS native controls.
const clipStates = [...document.querySelectorAll("[data-clip] video[data-clip-video]")].map((video, order) => ({ video, order, ratio: 0, userPaused: false, userPlaying: false }));
if (clipStates.length && "IntersectionObserver" in window) {
  const maxPlaying = 2;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const autoplay = () => !reducedMotion.matches && navigator.connection?.saveData !== true;
  const byVideo = new Map(clipStates.map((state) => [state.video, state]));

  const schedule = () => {
    document.documentElement.classList.toggle("clips-manual", !autoplay());
    const wanted = document.hidden ? [] : clipStates
      .filter((state) => !state.userPaused && (state.userPlaying ? state.ratio > 0 : autoplay() && state.ratio >= 0.5))
      .sort((a, b) => b.userPlaying - a.userPlaying || b.ratio - a.ratio || a.order - b.order)
      .slice(0, maxPlaying);
    for (const state of clipStates) {
      if (!wanted.includes(state)) {
        if (!state.video.paused) state.video.pause();
      } else if (state.video.paused) {
        state.video.preload = "auto";
        state.video.play()?.catch(() => {});
      }
    }
  };

  const sync = (state) => {
    const playing = !state.video.paused;
    state.button.setAttribute("aria-pressed", String(playing));
    state.video.parentElement.classList.toggle("is-playing", playing);
  };

  for (const state of clipStates) {
    const { video } = state;
    video.controls = false;
    video.muted = true;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "clip__toggle";
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", `Play video: ${video.dataset.title || video.getAttribute("aria-label") || "feature clip"}`);
    const seconds = Math.round(Number(video.dataset.duration));
    button.innerHTML = `<span class="clip__icon" aria-hidden="true"></span>${seconds > 0 ? `<span class="clip__time" aria-hidden="true">${seconds} s</span>` : ""}`;
    button.addEventListener("click", () => {
      const start = video.paused;
      state.userPlaying = start;
      state.userPaused = !start;
      schedule();
    });
    video.addEventListener("click", () => button.click());
    video.addEventListener("play", () => sync(state));
    video.addEventListener("pause", () => sync(state));
    video.after(button);
    state.button = button;
  }

  // Warm clips a screen away so they start promptly, but only when they would autoplay.
  const nearObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const { video } = byVideo.get(entry.target);
      if (entry.isIntersecting && autoplay() && video.preload === "none") video.preload = "metadata";
    }
  }, { rootMargin: "100% 0px" });
  const visibleObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const state = byVideo.get(entry.target);
      state.ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
      if (!state.ratio) state.userPlaying = false;
    }
    schedule();
  }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
  clipStates.forEach(({ video }) => {
    nearObserver.observe(video);
    visibleObserver.observe(video);
  });
  document.addEventListener("visibilitychange", schedule);
  reducedMotion.addEventListener("change", schedule);
}

const year = document.querySelector("[data-year]");
if (year) year.textContent = String(new Date().getFullYear());
