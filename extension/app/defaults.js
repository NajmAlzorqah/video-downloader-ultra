// Single canonical copy of the user-configurable defaults. Both popup.js and
// options.js read/write the same chrome.storage.local namespace, so the values
// must not drift between pages — define them here only.
const DEFAULTS = {
  subsOn: false,
  auto: false,
  langs: "en",
  langsTouched: false,
  subFormat: "srt",
  convertSrt: false,
  embed: false,
  playlist: false,
  chapters: "off", // "off" | "embed" | "split"
  outDir: "~/Videos",
};