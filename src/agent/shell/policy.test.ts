import { SHELL_LIMITS } from '@shared/shellLimits';
import { describe, expect, it } from 'vitest';
import { classifyCommand } from './policy';

describe('classifyCommand', () => {
  const cases: Array<[string, 'server' | 'build' | 'default']> = [
    // server：不会自己退出的进程
    ['pnpm dev', 'server'],
    ['npm run dev', 'server'],
    ['yarn start', 'server'],
    ['bun run serve', 'server'],
    ['npx vite', 'server'],
    ['vite', 'server'],
    ['next dev -p 3001', 'server'],
    ['tsc --watch', 'server'],
    ['tsc -w -p .', 'server'],
    ['nodemon src/index.js', 'server'],
    ['tail -f /var/log/app.log', 'server'],
    ['tail -F app.log | grep ERROR', 'server'],
    ['python -m http.server 8000', 'server'],
    ['python3 manage.py runserver', 'server'],
    ['uvicorn app:app --reload', 'server'],
    ['flask run', 'server'],
    ['docker compose up', 'server'],
    ['cargo watch -x test', 'server'],
    ['cd web && PORT=3000 pnpm dev', 'server'],
    ['webpack serve', 'server'],
    ['jest --watch', 'server'],
    ['kubectl logs -f pod/web', 'server'],
    // build：可能要跑几分钟、但会自己结束
    ['pnpm build', 'build'],
    ['pnpm test', 'build'],
    ['npm run typecheck', 'build'],
    ['pnpm typecheck && pnpm lint && pnpm test', 'build'],
    ['yarn install', 'build'],
    ['pnpm install --frozen-lockfile', 'build'],
    ['cargo build --release', 'build'],
    ['cargo test', 'build'],
    ['go test ./...', 'build'],
    ['make -j8', 'build'],
    ['./gradlew assemble', 'build'],
    ['mvn package', 'build'],
    ['pytest -x tests/', 'build'],
    ['python -m pytest', 'build'],
    ['npx vitest run src/a.test.ts', 'build'],
    ['vite build', 'build'],
    ['npx tsc --noEmit', 'build'],
    ['docker build -t web .', 'build'],
    ['docker compose up -d', 'build'],
    ['pip install -r requirements.txt', 'build'],
    ['uv sync', 'build'],
    ['xcodebuild -scheme App build', 'build'],
    // default
    ['ls -la', 'default'],
    ['git status', 'default'],
    ['echo "pnpm dev"', 'default'],
    ['cat package.json', 'default'],
    ['node scripts/gen.js', 'default'],
    ['pnpm dev --help', 'default'],
    ['vite --version', 'default'],
    ['tail -n 50 app.log', 'default'],
    ['grep -r "tsc --watch" docs', 'default'],
  ];

  it.each(cases)('%s → %s', (command, expected) => {
    expect(classifyCommand(command).class).toBe(expected);
  });

  it('每类给出对应的让位时长：server 10s / build 180s / default 45s', () => {
    expect(classifyCommand('pnpm dev').yieldMs).toBe(SHELL_LIMITS.yieldServerMs);
    expect(classifyCommand('pnpm test').yieldMs).toBe(SHELL_LIMITS.yieldBuildMs);
    expect(classifyCommand('ls').yieldMs).toBe(SHELL_LIMITS.yieldDefaultMs);
    expect(SHELL_LIMITS.yieldServerMs).toBe(10_000);
    expect(SHELL_LIMITS.yieldBuildMs).toBe(180_000);
    expect(SHELL_LIMITS.yieldDefaultMs).toBe(45_000);
  });

  it('server 优先于 build：同一条链里出现 dev server 按 server 处理', () => {
    expect(classifyCommand('pnpm build && pnpm start').class).toBe('server');
  });

  it('heredoc 正文与引号内的文本不参与分类', () => {
    const heredoc = ["cat > run.sh <<'EOF'", 'pnpm dev', 'EOF'].join('\n');
    expect(classifyCommand(heredoc).class).toBe('default');
  });

  it('脏输入按 default 处理', () => {
    expect(classifyCommand('').class).toBe('default');
    expect(classifyCommand(undefined as unknown as string).class).toBe('default');
  });

  it('传入的 limits 决定让位时长', () => {
    const limits = { ...SHELL_LIMITS, yieldDefaultMs: 1_000 };
    expect(classifyCommand('ls', limits).yieldMs).toBe(1_000);
  });
});
