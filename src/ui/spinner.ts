/**
 * 终端 Spinner 动画
 *
 * 手写实现，不依赖 Ink/React。
 * 在后台用 setInterval 刷新帧，通过回调通知调用者。
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private message: string;
  private readonly intervalMs: number;

  constructor(message: string, intervalMs = 80) {
    this.message = message;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.interval) return;
    // 隐藏光标
    process.stdout.write('\x1b[?25l');
    this.render();
    this.interval = setInterval(() => {
      this.clear();
      this.render();
    }, this.intervalMs);
  }

  stop(finalMessage?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.clear();
    // 显示光标
    process.stdout.write('\x1b[?25h');
    if (finalMessage) {
      process.stdout.write(finalMessage + '\n');
    }
  }

  setMessage(message: string): void {
    this.message = message;
    if (this.interval) {
      this.clear();
      this.render();
    }
  }

  private render(): void {
    const frame = FRAMES[this.frameIndex % FRAMES.length];
    process.stdout.write(`\r${frame} ${this.message}`);
    this.frameIndex++;
  }

  private clear(): void {
    // 清除当前行
    process.stdout.write('\r\x1b[K');
  }
}
