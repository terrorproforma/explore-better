import { WebglAddon } from "@xterm/addon-webgl";

window.ExploreBetterWebglAddon = Object.freeze({
  create() {
    return new WebglAddon();
  }
});
