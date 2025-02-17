type KeyCallback = () => void | Promise<void>;

interface KeyHandlerOptions {
  onEsc?: KeyCallback;
  onSpace?: KeyCallback;
  onCtrlC?: KeyCallback;
}

export class KeyHandler {
  private isActive = false;
  private keyCallbacks: KeyHandlerOptions;

  constructor(options: KeyHandlerOptions = {}) {
    this.keyCallbacks = options;

    // Default Ctrl+C handler if none provided
    if (!this.keyCallbacks.onCtrlC) {
      this.keyCallbacks.onCtrlC = () => {
        console.log("Terminated")
        process.exit(0);
      };
    }
  }

  start() {
    if (this.isActive) return;
    
    this.isActive = true;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    // Bind the handler to maintain correct 'this' context
    const handler = this.handleKeypress.bind(this);
    process.stdin.on('data', handler);

    // Store the handler for cleanup
    (this as any).currentHandler = handler;
  }

  stop() {
    if (!this.isActive) return;

    const handler = (this as any).currentHandler;
    if (handler) {
      process.stdin.removeListener('data', handler);
      delete (this as any).currentHandler;
    }

    process.stdin.setRawMode(false);
    process.stdin.pause();
    this.isActive = false;
  }

  private async handleKeypress(data: Buffer) {
    const key = data.toString();

    // Handle Ctrl+C (End of Text character)
    if (key === '\u0003' && this.keyCallbacks.onCtrlC) {
      await this.keyCallbacks.onCtrlC();
      return;
    }

    // Handle ESC
    if (key === '\u001b' && this.keyCallbacks.onEsc) {
      await this.keyCallbacks.onEsc();
      return;
    }

    // Handle Space
    if (key === ' ' && this.keyCallbacks.onSpace) {
      await this.keyCallbacks.onSpace();
      return;
    }
  }
}