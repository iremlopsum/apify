import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // A git worktree under `.worktrees/` is a full second checkout of this
    // repo, so the default globs discover BOTH copies of every test file and
    // each count doubles — an observed 708 tests across 62 files where the
    // suite actually has 354 across 31. Nothing fails, which is the problem:
    // a doubled green number reads like a win.
    //
    // Spread `configDefaults.exclude` rather than replacing it — setting
    // `exclude` overrides vitest's defaults outright, which would start
    // pulling in `node_modules` and the compiled `dist/`.
    exclude: [...configDefaults.exclude, '**/.worktrees/**'],
    typecheck: { tsconfig: './tsconfig.test.json', include: ['tests/**/*.test.ts', 'tests/**/*.test-d.ts'], only: true },
  }
})
