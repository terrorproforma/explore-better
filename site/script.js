const header = document.querySelector("[data-header]");
const nav = document.querySelector("[data-nav]");
const navToggle = document.querySelector("[data-nav-toggle]");

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
  if (event.key === "Escape") setNavigation(false);
});

window.addEventListener(
  "scroll",
  () => header?.classList.toggle("scrolled", window.scrollY > 24),
  { passive: true }
);

const tourImage = document.querySelector("[data-tour-image]");
const tourLabel = document.querySelector("[data-tour-label]");
const tourCaption = document.querySelector("[data-tour-caption]");
const tourTabs = Array.from(document.querySelectorAll("[data-tour-tab]"));

function activateTourTab(tab) {
  tourTabs.forEach((candidate) => {
    const selected = candidate === tab;
    candidate.classList.toggle("active", selected);
    candidate.setAttribute("aria-selected", String(selected));
    candidate.tabIndex = selected ? 0 : -1;
  });
  if (tourImage) {
    tourImage.src = tab.dataset.src || tourImage.src;
    tourImage.alt = tab.dataset.alt || "Explore Better product screen";
    if (tab.dataset.width) tourImage.width = Number(tab.dataset.width);
    if (tab.dataset.height) tourImage.height = Number(tab.dataset.height);
  }
  if (tourLabel) tourLabel.textContent = tab.dataset.label || "Product view";
  if (tourCaption) tourCaption.textContent = tab.dataset.caption || "";
}

tourTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateTourTab(tab));
  tab.addEventListener("keydown", (event) => {
    let nextIndex = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tourTabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tourTabs.length) % tourTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tourTabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateTourTab(tourTabs[nextIndex]);
    tourTabs[nextIndex].focus();
  });
});

if (tourTabs.length) activateTourTab(tourTabs.find((tab) => tab.classList.contains("active")) || tourTabs[0]);

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", async () => {
    const source = document.querySelector(button.dataset.copyTarget || "");
    const status = document.querySelector(button.dataset.copyStatusTarget || "");
    const value = source?.textContent?.trim() || "";
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const input = document.createElement("textarea");
      input.value = value;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    if (status) status.textContent = button.dataset.copySuccess || "Copied";
  });
});

const demoVideo = document.querySelector("[data-demo-video]");
const demoChapters = Array.from(document.querySelectorAll("[data-demo-time]"));

function setDemoChapterState(active) {
  demoChapters.forEach((chapter) => {
    const selected = chapter === active;
    chapter.classList.toggle("active", selected);
    if (selected) chapter.setAttribute("aria-current", "true");
    else chapter.removeAttribute("aria-current");
  });
}

function syncDemoChapter() {
  if (!demoVideo || !demoChapters.length) return;
  const current = demoVideo.currentTime;
  let active = demoChapters[0];
  demoChapters.forEach((chapter) => {
    if (Number(chapter.dataset.demoTime || 0) <= current + 0.05) active = chapter;
  });
  setDemoChapterState(active);
}

demoChapters.forEach((chapter) => {
  chapter.addEventListener("click", () => {
    if (!demoVideo) return;
    demoVideo.currentTime = Number(chapter.dataset.demoTime || 0);
    demoVideo.play().catch(() => {});
    syncDemoChapter();
    setDemoChapterState(chapter);
  });
});

demoVideo?.addEventListener("timeupdate", syncDemoChapter);
demoVideo?.addEventListener("seeked", syncDemoChapter);

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const revealItems = document.querySelectorAll(".reveal");

if (reducedMotion || !("IntersectionObserver" in window)) {
  revealItems.forEach((item) => item.classList.add("visible"));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8%", threshold: 0.08 }
  );
  revealItems.forEach((item) => observer.observe(item));
}

const year = document.querySelector("[data-year]");
if (year) year.textContent = String(new Date().getFullYear());
