import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";

const themes = {
  dark: {
    background: "#151b19",
    foreground: "#e5ece8",
    cursor: "#b8dc39",
    cursorAccent: "#151b19",
    selectionBackground: "#176f6388",
    black: "#151b19",
    red: "#ef675c",
    green: "#80b918",
    yellow: "#e6b64a",
    blue: "#58a6ff",
    magenta: "#ca7fda",
    cyan: "#54c7bd",
    white: "#e5ece8",
    brightBlack: "#68736f",
    brightRed: "#ff847a",
    brightGreen: "#b8dc39",
    brightYellow: "#ffd166",
    brightBlue: "#82b9ff",
    brightMagenta: "#e3a0ef",
    brightCyan: "#7be0d6",
    brightWhite: "#ffffff"
  },
  light: {
    background: "#fbfcfb",
    foreground: "#1b2824",
    cursor: "#08776f",
    cursorAccent: "#fbfcfb",
    selectionBackground: "#08776f44",
    black: "#1b2824",
    red: "#b42318",
    green: "#4c7f13",
    yellow: "#8c6500",
    blue: "#1769aa",
    magenta: "#8a3d8f",
    cyan: "#08776f",
    white: "#e7ebe8",
    brightBlack: "#68736f",
    brightRed: "#d92d20",
    brightGreen: "#5f9d18",
    brightYellow: "#a97800",
    brightBlue: "#1d7fc5",
    brightMagenta: "#a64cab",
    brightCyan: "#0a958a",
    brightWhite: "#ffffff"
  },
  "high-contrast": {
    background: "#000000",
    foreground: "#ffffff",
    cursor: "#ffff00",
    cursorAccent: "#000000",
    selectionBackground: "#00ffff88",
    black: "#000000",
    red: "#ff5555",
    green: "#55ff55",
    yellow: "#ffff55",
    blue: "#5599ff",
    magenta: "#ff55ff",
    cyan: "#55ffff",
    white: "#ffffff",
    brightBlack: "#aaaaaa",
    brightRed: "#ff7777",
    brightGreen: "#77ff77",
    brightYellow: "#ffff77",
    brightBlue: "#77aaff",
    brightMagenta: "#ff77ff",
    brightCyan: "#77ffff",
    brightWhite: "#ffffff"
  }
};

function terminalOptions(settings = {}) {
  const themeId = themes[settings.theme] ? settings.theme : "dark";
  return {
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: ["block", "bar", "underline"].includes(settings.cursor) ? settings.cursor : "block",
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
    fontSize: Math.max(10, Math.min(20, Number(settings.fontSize) || 12)),
    letterSpacing: 0,
    lineHeight: 1.08,
    scrollback: Math.max(1000, Math.min(50000, Number(settings.scrollback) || 10000)),
    smoothScrollDuration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 80,
    theme: themes[themeId]
  };
}

function createView({ host, settings = {}, onInput, onResize, onDropPaths }) {
  const terminal = new Terminal(terminalOptions(settings));
  const fit = new FitAddon();
  const search = new SearchAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.open(host);

  let webgl = null;
  const webglTimer = setTimeout(() => {
    const enableWebgl = () => {
      try {
        webgl = window.ExploreBetterWebglAddon?.create?.();
        if (!webgl) return;
        webgl.onContextLoss(() => {
          webgl?.dispose();
          webgl = null;
        });
        terminal.loadAddon(webgl);
      } catch {
        webgl?.dispose();
        webgl = null;
      }
    };
    if (window.ExploreBetterWebglAddon?.create) return enableWebgl();
    const script = document.createElement("script");
    script.src = "/generated/terminal-webgl.js";
    script.async = true;
    script.onload = enableWebgl;
    document.head.append(script);
  }, 1500);

  const inputDisposable = terminal.onData((data) => onInput?.(data));
  const resizeDisposable = terminal.onResize(({ cols, rows }) => onResize?.(cols, rows));
  const keyHandler = (event) => {
    if (!(event.ctrlKey && event.shiftKey)) return true;
    if (event.code === "KeyC") {
      const selected = terminal.getSelection();
      if (selected) navigator.clipboard.writeText(selected).catch(() => {});
      event.preventDefault();
      return false;
    }
    if (event.code === "KeyV") {
      navigator.clipboard.readText().then((text) => onInput?.(text)).catch(() => {});
      event.preventDefault();
      return false;
    }
    return true;
  };
  terminal.attachCustomKeyEventHandler(keyHandler);

  const dragOver = (event) => {
    if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
  };
  const drop = (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    onDropPaths?.([...event.dataTransfer.files]);
  };
  host.addEventListener("dragover", dragOver);
  host.addEventListener("drop", drop);

  let fitFrame = null;
  const fitNow = () => {
    if (fitFrame) cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
      fitFrame = null;
      try {
        fit.fit();
      } catch {
        // A hidden tab has no measurable terminal surface yet.
      }
    });
  };
  const observer = new ResizeObserver(fitNow);
  observer.observe(host);
  fitNow();

  return {
    terminal,
    write(data) {
      terminal.write(String(data || ""));
    },
    focus() {
      terminal.focus();
    },
    fit: fitNow,
    clear() {
      terminal.clear();
    },
    searchNext(query, options = {}) {
      return search.findNext(query, { caseSensitive: false, incremental: true, ...options });
    },
    selectAll() {
      terminal.selectAll();
    },
    setSettings(next = {}) {
      const options = terminalOptions(next);
      terminal.options.theme = options.theme;
      terminal.options.fontSize = options.fontSize;
      terminal.options.cursorStyle = options.cursorStyle;
      terminal.options.scrollback = options.scrollback;
      fitNow();
    },
    dimensions() {
      return { cols: Math.max(2, terminal.cols), rows: Math.max(1, terminal.rows) };
    },
    dispose() {
      clearTimeout(webglTimer);
      if (fitFrame) cancelAnimationFrame(fitFrame);
      observer.disconnect();
      host.removeEventListener("dragover", dragOver);
      host.removeEventListener("drop", drop);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      webgl?.dispose();
      terminal.dispose();
    }
  };
}

window.ExploreBetterTerminal = Object.freeze({ createView, themes: Object.keys(themes) });
