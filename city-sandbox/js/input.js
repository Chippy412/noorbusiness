/**
 * input.js — keyboard + mouse state.
 *
 *   input.isDown('KeyW')       held right now
 *   input.wasPressed('KeyF')   went down since the last endFrame()
 *   input.consumeMouse()       accumulated mouse movement since the last call
 *
 * Mouse movement is only recorded while the pointer is locked to the canvas.
 */
const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyR', 'KeyE', 'KeyH', 'Space', 'Tab',
  'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

export class Input {
  /** @param {HTMLElement} lockElement element that receives pointer lock */
  constructor(lockElement) {
    this.lockElement = lockElement;
    this.down = new Set();
    this.pressed = new Set();
    this.mouseX = 0;
    this.mouseY = 0;
    this.locked = false;
    /** @type {(locked:boolean) => void} */
    this.onLockChange = () => {};

    window.addEventListener('keydown', (e) => {
      if (GAME_KEYS.has(e.code)) e.preventDefault(); // stop the page scrolling on Space/arrows
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseX += e.movementX || 0;
      this.mouseY += e.movementY || 0;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.lockElement;
      if (!this.locked) this.down.clear();
      this.onLockChange(this.locked);
    });
  }

  /** Ask the browser to capture the mouse (must be called from a click). */
  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  requestLock() {
    const result = this.lockElement.requestPointerLock?.();
    // Newer browsers return a promise that rejects if the lock is refused.
    if (result && typeof result.catch === 'function') result.catch(() => {});
  }

  isDown(code) {
    return this.down.has(code);
  }

  wasPressed(code) {
    return this.pressed.has(code);
  }

  /** -1, 0 or +1 from a pair of opposing keys (several codes allowed per side). */
  axis(negativeCodes, positiveCodes) {
    const neg = negativeCodes.some((c) => this.down.has(c)) ? 1 : 0;
    const pos = positiveCodes.some((c) => this.down.has(c)) ? 1 : 0;
    return pos - neg;
  }

  consumeMouse() {
    const delta = { x: this.mouseX, y: this.mouseY };
    this.mouseX = 0;
    this.mouseY = 0;
    return delta;
  }

  /** Call once at the end of every frame. */
  endFrame() {
    this.pressed.clear();
  }
}
