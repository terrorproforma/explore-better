// Explore Better website behaviour. Every page works without this file; it adds the mobile
// menu, copy buttons, demo chapters, and benchmark bars. The legacy-*.html archives use the
// frozen script.js instead.
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
      const video = nodes.find((node) => node?.["@type"] === "VideoObject");
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

const year = document.querySelector("[data-year]");
if (year) year.textContent = String(new Date().getFullYear());
