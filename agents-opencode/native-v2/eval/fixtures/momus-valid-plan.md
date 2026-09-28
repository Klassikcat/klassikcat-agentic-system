# eval-momus-valid — Work Plan

## TL;DR (For humans)
Add a `double` helper to the math module with one test. Quick.

## Scope
### Affected user and ideal state
- IS-1: callers can `require("./src/math.js").double` — closes GAP-1 (no double today)
### Must have
- `double(n)` returning `n * 2`
- one test in `test/math.test.js`
### Must NOT have
- any other math functions

## Verification strategy
`node test/math.test.js` exits 0.

## Todos
- [ ] 1. Add double(n) to `src/math.js` and export it.
  - References: `src/math.js` (existing `square` pattern, module.exports line)
  - Acceptance: `node -e "console.log(require('./src/math.js').double(3))"` prints 6
  - QA: happy — double(3)==6; failure — double("x") is NaN (no guard, per Must NOT have)
  - Recommended task executor category: quick
  - Commit: feat(math): add double
- [ ] 2. Add one test to `test/math.test.js`.
  - References: `test/math.test.js` (existing assert style)
  - Acceptance: `node test/math.test.js` prints "math tests passed"
  - QA: happy — suite passes; failure — temporarily breaking double makes it fail
  - Recommended task executor category: quick
  - Commit: test(math): cover double

## Final verification wave
- [ ] F1. plan compliance — read plan vs diff
- [ ] F2. code quality — review changed files
- [ ] F3. real QA — run the suite

## Commit strategy
Two commits as listed per todo.

## Success criteria
IS-1 proven by QA in todo 1; suite green.
