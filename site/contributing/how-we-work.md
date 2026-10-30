# How we work

Kinote is built in small, planned steps. Each bigger change goes through three written stages, and all three live in
the repository so anyone can follow the reasoning.

1. **A design** in `docs/superpowers/specs/`. It says what the change is for, what's in and out of scope, and the
   rules it must keep. It's short enough to read in one go, and it's reviewed before any code is written.
2. **A plan** in `docs/superpowers/plans/`. It turns the design into numbered tasks, each with the files it touches,
   the interfaces it produces, the tests to write first and the commands that prove it works.
3. **A live check** in `docs/live-checks/`. After the work is merged, someone runs it against the real stack and writes
   down what they saw, including anything that didn't work.

`docs/kinote-standalone-design.md` is the main design. Its Progress table lists what has been built.

## Proposing a change

- **A bug fix or a small improvement:** open a pull request with a test that fails without your fix.
- **Something bigger:** open an issue first and describe the problem. If it's worth doing, the next step is a short
  design in `docs/superpowers/specs/`.

Before you open a pull request, run `pnpm typecheck` and `pnpm test`, plus `pnpm e2e:local` if you changed anything in
the web app. Read the [Conventions](./conventions) too.
