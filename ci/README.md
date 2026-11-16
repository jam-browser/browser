# GitHub Actions 자동 빌드 (아직 꺼져 있음)

`github-release.yml` 을 `.github/workflows/release.yml` 로 옮겨서 올리면,
버전 태그(`v0.1.1` 등)를 push 할 때마다 GitHub 이 설치 파일을 빌드해 릴리스로 올려요.

GitHub CLI 로 올리려면 토큰에 `workflow` 권한이 필요해요: `gh auth refresh -h github.com -s workflow`

켜기 전까지는 직접 빌드해서 올려요:

```bash
npm run dist
gh release create v버전 dist/JamBrowser-Setup-버전.exe dist/JamBrowser-Setup-버전.exe.blockmap dist/latest.yml
```
