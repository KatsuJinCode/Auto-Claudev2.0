# Investigation: v2.7.1 Release Artifacts Issue

## Investigation Date

2025-12-25

## Summary

The v2.7.1 release has **incorrect files attached**. All artifacts have v2.7.0 in their filenames, indicating the wrong build artifacts were uploaded.

---

## Phase 1: Reproduce and Verify Issue

### Subtask 1-1: Current v2.7.1 Assets

**Command:** `gh release view v2.7.1 --json assets -q '.assets[].name'`

**Release Metadata:**
- Tag Name: v2.7.1
- Release Name: v2.7.1
- Published At: 2025-12-22T13:35:38Z
- Is Draft: false
- Is Prerelease: false

**Files Currently Attached to v2.7.1:**

| File Name | Size (bytes) | Expected Name |
|-----------|-------------|---------------|
| Auto-Claude-2.7.0-darwin-arm64.dmg | 124,187,073 | Auto-Claude-2.7.1-darwin-arm64.dmg |
| Auto-Claude-2.7.0-darwin-arm64.zip | 117,694,085 | Auto-Claude-2.7.1-darwin-arm64.zip |
| Auto-Claude-2.7.0-darwin-x64.dmg | 130,635,398 | Auto-Claude-2.7.1-darwin-x64.dmg |
| Auto-Claude-2.7.0-darwin-x64.zip | 124,176,354 | Auto-Claude-2.7.1-darwin-x64.zip |
| Auto-Claude-2.7.0-linux-amd64.deb | 104,558,694 | Auto-Claude-2.7.1-linux-amd64.deb |
| Auto-Claude-2.7.0-linux-x86_64.AppImage | 145,482,885 | Auto-Claude-2.7.1-linux-x86_64.AppImage |
| Auto-Claude-2.7.0-win32-x64.exe | 101,941,972 | Auto-Claude-2.7.1-win32-x64.exe |
| checksums.sha256 | 718 | checksums.sha256 (with v2.7.1 filenames) |

### Issue Confirmed

**Problem:** All 7 platform artifacts attached to v2.7.1 have "2.7.0" in their filename instead of "2.7.1".

**Impact:**
- Users downloading v2.7.1 are receiving v2.7.0 binaries
- File naming does not match the release version
- Checksums file likely references v2.7.0 filenames
- Auto-update mechanisms may be confused by version mismatch

**Evidence:**
```
Files attached to v2.7.1:
- Auto-Claude-2.7.0-darwin-arm64.dmg   (WRONG - should be 2.7.1)
- Auto-Claude-2.7.0-darwin-arm64.zip   (WRONG - should be 2.7.1)
- Auto-Claude-2.7.0-darwin-x64.dmg     (WRONG - should be 2.7.1)
- Auto-Claude-2.7.0-darwin-x64.zip     (WRONG - should be 2.7.1)
- Auto-Claude-2.7.0-linux-amd64.deb    (WRONG - should be 2.7.1)
- Auto-Claude-2.7.0-linux-x86_64.AppImage (WRONG - should be 2.7.1)
- Auto-Claude-2.7.0-win32-x64.exe      (WRONG - should be 2.7.1)
- checksums.sha256                      (likely references wrong filenames)
```

---

## Next Steps

1. **Subtask 1-2:** Compare with v2.7.0 release and verify expected naming pattern
2. **Subtask 1-3:** Check package.json version and git state
3. **Phase 2:** Investigate root cause (tag pointing to wrong commit, workflow issue, manual error)
4. **Phase 3:** Implement fix (re-upload correct files or publish v2.7.2)
5. **Phase 4:** Add validation to prevent future occurrences

---

## Status: Phase 1, Subtask 1-1 Complete

Verified that v2.7.1 release has wrong files attached - all artifacts have v2.7.0 version numbers.
