// Watches the ⌃ (Control) key for the ⌃Tab switcher. Run by main.js with: osascript -l JavaScript modwatch.js
// Electron never reports releasing ⌃ on its own, so this asks macOS for the key state and prints
// "ctrl:1" / "ctrl:0" whenever it changes. Needs no extra permissions.
ObjC.import('CoreGraphics');
const CONTROL = 0x40000;
let last = -1;
while (true) {
  const now = (Number($.CGEventSourceFlagsState(1)) & CONTROL) ? 1 : 0;
  if (now !== last) { console.log('ctrl:' + now); last = now; }
  delay(0.03);
}
