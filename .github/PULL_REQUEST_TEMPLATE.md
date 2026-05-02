## Summary
<!-- 1-3 sentences. Why is this change here? What's the user-visible effect? -->

## Test plan

- [ ] `npm -w packages/core run build` clean
- [ ] `npm -w packages/core test` green
- [ ] `npm -w packages/ui run build` clean (if UI changed)
- [ ] `npm -w packages/ui test` green (if UI changed)
- [ ] `npm -w packages/github-app test` green (if bot changed)
- [ ] Manually verified in a browser (if UI changed)

## Screenshots
<!-- Required for any UI change. Before/after if it's a visual fix. -->

## Notes for reviewers
<!-- Any decision worth a second pair of eyes. Honest negative results, deferred items, follow-ups. -->

---

By submitting, you agree your contribution is licensed under the project's MIT license. If you co-authored with a model, please add the appropriate `Co-Authored-By:` trailer to commits — see existing commit history for the convention.
