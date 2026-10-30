/** 输入源原语；current/english 返回的引用由 release 归还 */
export interface LayoutDeps<S> {
  current(): S | null;
  english(): S | null;
  id(source: S): string;
  select(source: S): boolean;
  release(source: S): void;
  sleep(ms: number): Promise<void>;
}

/**
 * 系统输入源是全局的：并行 run（前台或后台）共用一份“临时切到英文”的声明，
 * 首个使用者切换，最后一个使用者结束、且已投递的按键被消费后才切回原输入源。
 */
export class EnglishLayoutLease<S> {
  private users = 0;
  private original: S | null = null;
  private switching: Promise<void> | undefined;

  constructor(
    private readonly deps: LayoutDeps<S>,
    /** 切换生效后再等多久才投递：输入法切换在目标 app 里异步生效 */
    private readonly settleMs = 80
  ) {}

  async acquire(): Promise<void> {
    this.users += 1;
    if (this.users === 1 && this.original === null) this.switching = this.switchToEnglish();
    await this.switching;
  }

  private async switchToEnglish(): Promise<void> {
    const current = this.deps.current();
    const english = this.deps.english();
    try {
      if (!current || !english) return;
      const target = this.deps.id(english);
      if (target === this.deps.id(current) || !this.deps.select(english)) return;
      this.original = current;
      for (let i = 0; i < 20; i++) {
        const now = this.deps.current();
        const applied = now !== null && this.deps.id(now) === target;
        if (now) this.deps.release(now);
        if (applied) break;
        await this.deps.sleep(25);
      }
      await this.deps.sleep(this.settleMs);
    } finally {
      if (english) this.deps.release(english);
      if (current && this.original !== current) this.deps.release(current);
    }
  }

  async release(): Promise<void> {
    if (this.users === 0) return;
    this.users -= 1;
    if (this.users > 0 || this.original === null) return;
    // 等目标 app 消费完已投递的按键；期间若有新使用者进来，就留给它结束时恢复
    await this.deps.sleep(150);
    if (this.users > 0 || this.original === null) return;
    const original = this.original;
    this.original = null;
    try {
      this.deps.select(original);
    } finally {
      this.deps.release(original);
    }
  }
}
